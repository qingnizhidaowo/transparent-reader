'use strict';

/**
 * 透明网页阅读器 —— 主进程 (v1.2)
 *
 * v1.3 变更：
 *  1. 背景透明模式不再强制网页文字为浅色，保留站点原色（问题1）。
 *  2. 最小化到托盘后暂停"移入自动显示"，双击托盘图标才弹出（问题2）；
 *     鼠标移出触发的自动隐藏仍保持"移回自动显示"（核心功能不变）。
 *
 * v1.4 变更：
 *  背景透明模式升级为"完全透明"：应用自身 UI（工具栏/阅读栏）底色也全部
 *  去除，工具栏自动收起到顶部 6px 细条，悬停/聚焦才滑出；除文字与图片外
 *  一切透明，网页内容直接悬浮在壁纸上（对齐用户参考图效果）。
 *
 * v1.4.1 变更（网页白底彻底剥除）：
 *  1. 剥离样式改由主进程注入，且用 cssOrigin:'user'（用户级样式表）——CSS 级联
 *     中 user-important 压过网页任何 author-important（含 !important 白底、行内
 *     样式、SPA 动态插入的样式）。此前用 author 级注入，遇到考试/答题类网站
 *     用 !important 写死的白底会打平落败，导致网页仍是白色背景。
 *  2. iframe 子框架覆盖：监听 guest 的 frame-created / did-frame-navigate，
 *     经 WebFrameMain.executeJavaScript 向每个子框架幂等补注入 <style>。
 *  3. GUEST_CSS 增加 backdrop-filter 剥除（毛玻璃面板也透明）。
 *  4. 新增 capture-sample IPC：冒烟测试像素级验证 guest 区域真实透出。
 *
 * v1.4.2 变更：
 *  应用户要求移除 v1.4 的“工具栏自动收起到顶部、悬停滑出”交互：
 *  背景透明模式下工具栏保持常显（仅底色透明），输网址、点按钮无需先呼出；
 *  顶部 6px 拖拽细条随之移除（拖动窗口直接拉工具栏空白处，与普通模式一致）。
 *
 *  1. 「背景透明·仅文字」模式：真 transparent 窗口 + 向网页注入 CSS 剥离背景，
 *     文字保持 100% 不透明（问题1）。transparent 无法运行时切换，采用销毁重建窗口。
 *  2. 最小化到托盘：工具栏「—」立即隐藏到托盘（不暂停移入自动显示）；
 *     系统级最小化（Win+Down 等）也被接管为托盘隐藏，避免 skipTaskbar 下"窗口失踪"（问题2）。
 *  3. 默认移出直接隐藏：无淡出动画、无防误触等待；动画改为托盘可选项（问题3）。
 *
 * 说明：常规模式用 frame:false + setOpacity（分层窗口），Windows/macOS/Linux
 * 均稳定且保留原生边缘缩放；背景透明模式才切换 transparent 窗口（此模式下
 * Windows 原生缩放失效，由渲染层右下角拖拽手柄兜底）。
 */

const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, ipcMain, shell, nativeImage, WebFrameMain } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_DIR = __dirname;
const IS_SMOKE = !!process.env.SMOKE; // 无头冒烟测试模式

const HOME_URL = pathToFileURL(path.join(APP_DIR, 'renderer', 'home.html')).href;

// ---- 默认配置（摸鱼阅读场景）----
const DEFAULTS = {
  width: 560,
  height: 760,
  opacity: 0.4,          // 整窗透明度 40%
  alwaysOnTop: true,     // 置顶悬浮
  clickThrough: false,   // 鼠标穿透
  autoHide: true,        // 移出自动隐藏 / 移入自动显示
  pollMs: 100,           // 光标轮询间隔
  outGraceMs: 0,         // v1.2: 移出后 0 等待，直接隐藏（问题3）
  clickThroughGraceMs: 2500, // 穿透模式下放宽，避免底层操作引发闪烁
  fade: false,           // v1.2: 默认无淡入淡出动画（托盘可开启）
};
if (IS_SMOKE) DEFAULTS.autoHide = false; // 冒烟环境下关闭自动隐藏，保证流程确定性

let win = null;
let tray = null;
let quitting = false;
let recreating = false;      // 重建窗口中，抑制 window-all-closed 误退出
let pendingBounds = null;    // 重建时恢复的位置尺寸
let pendingRestoreUrl = '';  // 重建后恢复加载的页面
let lastPageUrl = '';        // 渲染层上报的最近页面（用于重建恢复）

const state = {
  opacity: DEFAULTS.opacity,
  alwaysOnTop: DEFAULTS.alwaysOnTop,
  clickThrough: DEFAULTS.clickThrough,
  autoHide: DEFAULTS.autoHide,
  fade: DEFAULTS.fade,
  bgTransparent: false
};

let autoShowEnabled = true; // 手动隐藏后暂停自动显示，直到再次手动显示
let typing = false;         // 渲染进程正在输入网址（此时不自动隐藏）
let guestWC = null;         // 当前 webview 的 guest webContents（注入/像素采样用）

/* ==================== 网页背景剥离（v1.4.1） ==================== */

// 注入到 guest 的剥离样式：去一切背景/阴影/毛玻璃，保留文字原色、图片与线条。
// 注意：必须以 cssOrigin:'user' 注入 —— user 级 !important 在 CSS 级联中压过
// 网页自身的 author 级 !important（考试/后台类网站常用它写死白底），
// author 级注入遇到这种规则只会打平并因顺序靠前而落败。
const GUEST_CSS = [
  '*, *::before, *::after { background-color: transparent !important; background-image: none !important; box-shadow: none !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',
  'html, body { background: transparent !important; }',
  '::-webkit-scrollbar { width: 6px; height: 6px; }',
  '::-webkit-scrollbar-track { background: transparent !important; }',
  '::-webkit-scrollbar-thumb { background: rgba(128,138,158,0.45) !important; border-radius: 3px; }'
].join('\n');

// 向单个子框架（iframe）幂等补注入 <style>：insertCSS 只保证主框架，
// iframe 里的白底靠这段脚本在各 frame 里各注一份（重复执行安全，同 id 覆盖）。
const FRAME_INJECT_JS =
  '(function(){try{' +
  'var css = ' + JSON.stringify(GUEST_CSS) + ';' +
  'var d = document, id = "__tr_bg_strip";' +
  'function apply(){var el = d.getElementById(id);' +
  'if(!el){el = d.createElement("style"); el.id = id;}' +
  '(d.head || d.documentElement).appendChild(el);' +
  'el.textContent = css;}' +
  'if(d.readyState === "loading"){d.addEventListener("DOMContentLoaded", apply, {once:true});}' +
  'else{apply();}' +
  '}catch(e){}})();';

function injectGuestCss(wc) {
  if (!wc || wc.isDestroyed() || !state.bgTransparent) return;
  try { wc.insertCSS(GUEST_CSS, { cssOrigin: 'user' }).catch(() => {}); }
  catch (e) { log('guest insertCSS failed:', e.message); }
}

function injectGuestFrame(frame) {
  if (!frame || !state.bgTransparent) return;
  try { if (frame.isDestroyed && frame.isDestroyed()) return; } catch (e) { return; }
  try { Promise.resolve(frame.executeJavaScript(FRAME_INJECT_JS, false)).catch(() => {}); }
  catch (e) { /* 文档尚未就绪：由 did-frame-navigate / 延迟重试兜底 */ }
}

let outSince = 0;           // 光标离开窗口的时刻（0 = 在窗口内）
let currentOpacity = DEFAULTS.opacity;
let fadeTimer = null;
let fadeDir = null;         // 'in' | 'out' | 'adjust'
let lastHostKeyAt = 0;      // 宿主页面最近一次键盘活动
let lastGuestKeyAt = 0;     // webview 内最近一次键盘活动
let lastResizeAt = 0;       // 最近一次窗口缩放
let lastMoveAt = 0;         // 最近一次窗口拖动

function log(...args) {
  if (IS_SMOKE || process.env.TR_VERBOSE) console.log('[TR]', ...args);
}

/* ==================== 窗口 ==================== */

function createWindow() {
  const b = (pendingBounds && pendingBounds.width) ? pendingBounds
    : { width: DEFAULTS.width, height: DEFAULTS.height };

  const w = new BrowserWindow({
    width: b.width,
    height: b.height,
    ...(Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: b.x, y: b.y } : {}),
    minWidth: 340,
    minHeight: 260,
    frame: false,
    resizable: true,
    alwaysOnTop: state.alwaysOnTop,
    skipTaskbar: true, // 不进任务栏，摸鱼更隐蔽（托盘 + 快捷键随时找回）
    show: false,
    transparent: state.bgTransparent,          // 问题1：真透明窗口（仅背景透明模式）
    hasShadow: !state.bgTransparent,           // 透明窗口关阴影，避免 Windows 阴影残影
    backgroundColor: state.bgTransparent ? '#00000000' : '#15171c',
    opacity: state.bgTransparent ? 1 : state.opacity, // 背景透明模式下整窗不透明，文字才清晰
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false
    },
    icon: path.join(APP_DIR, 'assets', 'icon.png')
  });
  win = w;

  try { w.setAlwaysOnTop(state.alwaysOnTop, 'screen-saver'); } catch (e) { /* Linux WM 可能不支持层级 */ }
  if (state.clickThrough) applyClickThrough(true);

  w.once('ready-to-show', () => {
    const target = state.bgTransparent ? 1 : state.opacity;
    currentOpacity = target;
    try { w.setOpacity(target); } catch (e) { /* 无合成器的 Linux 上可能是 no-op */ }
    w.showInactive(); // 首次显示不抢焦点
    log('window ready, transparent=' + state.bgTransparent + ' opacity=' + target);
  });

  w.loadFile(path.join(APP_DIR, 'renderer', 'index.html'), IS_SMOKE ? { search: 'smoke=1' } : {});

  // 正在拖动 / 缩放窗口时，暂停自动隐藏（拖边缘时光标会在窗口外）
  w.on('resize', () => { lastResizeAt = Date.now(); });
  w.on('move', () => { lastMoveAt = Date.now(); });

  // 宿主页面键盘活动（防止输入网址时窗口被藏起来）
  w.webContents.on('before-input-event', () => { lastHostKeyAt = Date.now(); });

  // webview 挂载：v1.4.1 主进程接手网页背景剥离（user 级注入压过网页 !important，
  // 含 iframe 子框架）；新标签链接在应用内自动跳转（v1.1 修复）
  w.webContents.on('did-attach-webview', (_e, guest) => {
    guestWC = guest;
    guest.on('dom-ready', () => injectGuestCss(guest));
    guest.on('did-navigate', () => injectGuestCss(guest));
    // iframe：创建时文档未必就绪 → 立即 + 延迟重试；导航后再补一次
    guest.on('frame-created', (_ev, details) => {
      const frame = details && details.frame;
      injectGuestFrame(frame);
      setTimeout(() => injectGuestFrame(frame), 350);
      setTimeout(() => injectGuestFrame(frame), 900);
    });
    guest.on('did-frame-navigate', (_ev, _url, _code, _txt, isMainFrame, frameProcessId, frameRoutingId) => {
      if (isMainFrame) return;
      try { injectGuestFrame(WebFrameMain.fromId(frameProcessId, frameRoutingId)); } catch (err) { /* ignore */ }
    });
    injectGuestCss(guest); // attach 时页面可能已就绪，先试一次
    try {
      guest.setWindowOpenHandler(({ url }) => {
        if (!url || url === 'about:blank') return { action: 'deny' };
        if (/^(https?|file):/i.test(url)) {
          // 窗口重建/销毁瞬间可能收到迟到的弹窗请求，guest 已失效则直接忽略
          if (!guest.isDestroyed()) {
            Promise.resolve(guest.loadURL(url)).catch((err) => log('in-app nav failed:', err && err.message));
          }
        } else if (/^(mailto|tel):/i.test(url)) {
          shell.openExternal(url).catch(() => {});
        }
        return { action: 'deny' };
      });
    } catch (err) { log('setWindowOpenHandler failed:', err.message); }
    guest.on('before-input-event', () => { lastGuestKeyAt = Date.now(); });
    log('webview attached');
  });

  // 问题2：系统级最小化（Win+Down / 任务栏等）一律接管为"隐藏到托盘"，
  // 否则 skipTaskbar 窗口最小化后既不在托盘也不在任务栏，等于失踪。
  // v1.3：最小化同时暂停"移入自动显示"，双击托盘图标才再次弹出。
  w.on('minimize', (e) => {
    e.preventDefault();
    hideToTray();
  });

  w.on('closed', () => { if (win === w) { win = null; guestWC = null; } });
}

/* ==================== 淡入淡出 & 显示/隐藏 ==================== */

function useFade() { return state.fade && !state.bgTransparent; } // 透明窗口上 setOpacity 不可靠，强制即时

function cancelFade() {
  if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
  fadeDir = null;
}

function fadeTo(target, dir, done) {
  if (!win || win.isDestroyed()) return;
  cancelFade();
  fadeDir = dir;
  const start = currentOpacity;
  const dist = target - start;
  if (Math.abs(dist) < 0.01) {
    currentOpacity = target;
    try { win.setOpacity(Math.max(0.01, target)); } catch (e) { /* ignore */ }
    fadeDir = null;
    if (done) done();
    return;
  }
  const t0 = Date.now();
  const dur = 200;
  fadeTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { cancelFade(); return; }
    const k = Math.min(1, (Date.now() - t0) / dur);
    currentOpacity = start + dist * k;
    try { win.setOpacity(Math.max(0.01, currentOpacity)); } catch (e) { /* ignore */ }
    if (k >= 1) {
      clearInterval(fadeTimer);
      fadeTimer = null;
      if (done) done();
    }
  }, 16);
}

function showTargetOpacity() { return state.bgTransparent ? 1 : state.opacity; }

function hideToTray() {
  // 问题2(v1.3)：最小化语义的隐藏——暂停"移入自动显示"，鼠标扫过原区域不再误弹；
  // 双击托盘图标 / Ctrl+Alt+H / 托盘菜单可再次显示（显示后自动恢复移入弹出）
  if (!win || win.isDestroyed()) return;
  autoShowEnabled = false;
  try { win.hide(); } catch (e) { /* ignore */ }
  log('hide to tray (auto-show suspended)');
}

function hideWindow(manual) {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (manual) autoShowEnabled = false; // 手动隐藏后，鼠标扫过原区域不再自动弹出
  if (useFade()) {
    log('hide (fade)', manual ? '(manual)' : '(auto)');
    fadeTo(0.02, 'out', () => {
      if (win && !win.isDestroyed()) {
        try { win.hide(); } catch (e) { /* ignore */ }
      }
    });
  } else {
    // 问题3：直接隐藏，无过渡
    log('hide (instant)', manual ? '(manual)' : '(auto)');
    try { win.hide(); } catch (e) { /* ignore */ }
  }
}

function showWindow(focus) {
  if (!win || win.isDestroyed()) return;
  autoShowEnabled = true;
  const target = showTargetOpacity();
  if (!win.isVisible()) {
    if (useFade()) {
      try { win.setOpacity(0.02); } catch (e) { /* ignore */ }
      currentOpacity = 0.02;
    } else {
      try { win.setOpacity(target); } catch (e) { /* ignore */ }
      currentOpacity = target;
    }
    if (focus) win.show(); else win.showInactive(); // 自动显示不抢焦点
  }
  if (useFade()) fadeTo(target, 'in');
  log('show, focus=' + !!focus);
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() || fadeDir === 'out') hideWindow(true);
  else showWindow(true);
}

/* ==================== 光标轮询：移出隐藏 / 移入显示 ==================== */

function startPoller() {
  setInterval(() => {
    if (!win || win.isDestroyed() || !state.autoHide) return;
    let cursor;
    try { cursor = screen.getCursorScreenPoint(); } catch (e) { return; }
    if (!cursor) return;

    const b = win.getBounds(); // 隐藏后 bounds 保留，可作为"移入显示"的热区
    const inside = cursor.x >= b.x && cursor.x <= b.x + b.width &&
                   cursor.y >= b.y && cursor.y <= b.y + b.height;
    const now = Date.now();

    if (inside) {
      outSince = 0;
      if (!win.isVisible()) {
        if (autoShowEnabled) showWindow(false);            // 移入自动显示
      } else if (fadeDir === 'out') {
        fadeTo(showTargetOpacity(), 'in');                 // 淡出途中移回 → 拉回来
      }
    } else {
      const grace = state.clickThrough ? DEFAULTS.clickThroughGraceMs : DEFAULTS.outGraceMs;
      if (outSince === 0) {
        outSince = now;
        if (grace > 0) return; // v1.2: 默认 grace=0，首次检测到在外即隐藏（问题3）
      }
      if (now - outSince < grace || !win.isVisible()) return;
      // 输入/拖动/缩放保护：正在打字或拖拽时不要藏窗口
      const busy = typing ||
        now - lastHostKeyAt < 1000 ||
        now - lastGuestKeyAt < 1500 ||
        now - lastResizeAt < 700 ||
        now - lastMoveAt < 700;
      if (busy) { outSince = 0; return; }
      hideWindow(false);                                   // 移出自动隐藏
    }
  }, DEFAULTS.pollMs);
}

/* ==================== 状态应用 ==================== */

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents) {
    try { win.webContents.send(channel, payload); } catch (e) { /* ignore */ }
  }
}

function broadcastState() { sendToRenderer('state-changed', { ...state }); }

function setOpacityTarget(v, from) {
  state.opacity = Math.min(1, Math.max(0.05, Number(v) || 0.4));
  if (win && !win.isDestroyed() && !state.bgTransparent) {
    // 背景透明模式下整窗透明度不适用（文字必须保持清晰），仅记录数值供切回时恢复
    if (win.isVisible() && useFade()) fadeTo(state.opacity, 'adjust');
    else {
      try { win.setOpacity(state.opacity); } catch (e) { /* ignore */ }
      currentOpacity = state.opacity;
    }
  } else {
    currentOpacity = showTargetOpacity();
  }
  if (from !== 'renderer') broadcastState();
  rebuildTrayMenu();
  log('opacity ->', state.opacity);
}

function applyAlwaysOnTop(on) {
  state.alwaysOnTop = !!on;
  if (win && !win.isDestroyed()) {
    try { win.setAlwaysOnTop(state.alwaysOnTop, 'screen-saver'); } catch (e) { /* ignore */ }
  }
  broadcastState();
  rebuildTrayMenu();
  log('alwaysOnTop ->', state.alwaysOnTop);
}

function applyClickThrough(on) {
  state.clickThrough = !!on;
  if (win && !win.isDestroyed()) {
    try { win.setIgnoreMouseEvents(state.clickThrough, { forward: true }); } catch (e) { /* ignore */ }
  }
  broadcastState();
  rebuildTrayMenu();
  log('clickThrough ->', state.clickThrough);
}

function applyAutoHide(on) {
  state.autoHide = !!on;
  broadcastState();
  rebuildTrayMenu();
  log('autoHide ->', state.autoHide);
}

function applyFade(on) {
  state.fade = !!on;
  broadcastState();
  rebuildTrayMenu();
  log('fade ->', state.fade);
}

/* ==================== 背景透明模式：重建窗口 ==================== */

function recreateWindow() {
  pendingBounds = (win && !win.isDestroyed()) ? win.getBounds() : null;
  pendingRestoreUrl = lastPageUrl;
  recreating = true;
  if (win && !win.isDestroyed()) {
    try { win.destroy(); } catch (e) { /* ignore */ }
    win = null;
  }
  createWindow();
  setTimeout(() => { recreating = false; }, 1000); // 'closed' 是异步派发的，晚一点再解除抑制
  log('window recreated, restore=' + pendingRestoreUrl);
}

function applyBgTransparent(on) {
  state.bgTransparent = !!on;
  log('bg-transparent ->', state.bgTransparent);
  rebuildTrayMenu();
  broadcastState();
  recreateWindow(); // transparent 只能在创建时指定
}

function resizeBy(dx, dy) {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    const width = Math.max(340, Math.round(b.width + (Number(dx) || 0)));
    const height = Math.max(260, Math.round(b.height + (Number(dy) || 0)));
    win.setBounds({ x: b.x, y: b.y, width, height });
    lastResizeAt = Date.now(); // 抑制拖拽手柄期间的自动隐藏
  } catch (e) { /* ignore */ }
}

/* ==================== 托盘 ==================== */

function buildTrayMenuTemplate() {
  const opacityItem = (p) => ({
    label: p + '%',
    type: 'radio',
    checked: Math.round(state.opacity * 100) === p,
    enabled: !state.bgTransparent, // 背景透明模式下整窗透明度不适用
    click: () => setOpacityTarget(p / 100, 'tray')
  });
  return [
    { label: '显示 / 隐藏（Ctrl+Alt+H）', click: () => toggleWindow() },
    { type: 'separator' },
    { label: '背景透明·仅文字（Ctrl+Alt+G）', type: 'checkbox', checked: state.bgTransparent, click: (mi) => applyBgTransparent(mi.checked) },
    { label: '鼠标穿透（Ctrl+Alt+T）', type: 'checkbox', checked: state.clickThrough, click: (mi) => applyClickThrough(mi.checked) },
    { label: '窗口置顶', type: 'checkbox', checked: state.alwaysOnTop, click: (mi) => applyAlwaysOnTop(mi.checked) },
    { label: '移出自动隐藏', type: 'checkbox', checked: state.autoHide, click: (mi) => applyAutoHide(mi.checked) },
    { label: '隐藏/显示过渡动画', type: 'checkbox', checked: state.fade, click: (mi) => applyFade(mi.checked) },
    { label: '透明度（整窗）', submenu: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(opacityItem) },
    { type: 'separator' },
    { label: '退出（Ctrl+Alt+Q）', click: () => quitApp() }
  ];
}

function rebuildTrayMenu() {
  if (!tray) return;
  try { tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate())); } catch (e) { /* ignore */ }
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(APP_DIR, 'assets', 'tray.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('透明网页阅读器（双击：显示窗口；右键：菜单）');
    rebuildTrayMenu();
    // v1.3：双击托盘图标弹出窗口；单击不再弹出（问题2）。
    // 注：double-click 事件在 Windows/macOS 可靠触发；Linux 上可用右键菜单或 Ctrl+Alt+H 呼出。
    tray.on('double-click', () => showWindow(true));
    log('tray ok');
  } catch (e) {
    log('tray failed:', e.message); // 无托盘环境（如无头测试）不致命
  }
}

/* ==================== 全局快捷键 ==================== */

function registerShortcuts() {
  const reg = (accel, fn) => {
    try { globalShortcut.register(accel, fn); }
    catch (e) { log('shortcut failed:', accel, e.message); }
  };
  const AC = 'Ctrl+Alt';
  reg(AC + '+H', () => toggleWindow());                                  // 显示/隐藏
  reg(AC + '+T', () => applyClickThrough(!state.clickThrough));          // 鼠标穿透
  reg(AC + '+G', () => applyBgTransparent(!state.bgTransparent));        // 背景透明·仅文字
  reg(AC + '+B', () => { showWindow(true); sendToRenderer('focus-url'); }); // 呼出并聚焦地址栏
  reg(AC + '+=', () => sendToRenderer('zoom-request', 'in'));            // 放大
  reg(AC + '+numadd', () => sendToRenderer('zoom-request', 'in'));
  reg(AC + '+-', () => sendToRenderer('zoom-request', 'out'));           // 缩小
  reg(AC + '+numsub', () => sendToRenderer('zoom-request', 'out'));
  reg(AC + '+0', () => sendToRenderer('zoom-request', 'reset'));         // 重置缩放
  reg(AC + '+Q', () => quitApp());                                       // 退出
  log('shortcuts registered');
}

function quitApp() {
  quitting = true;
  app.quit();
}

/* ==================== IPC ==================== */

function bindIpc() {
  ipcMain.handle('get-state', () => ({
    ...state,
    autoShowEnabled,
    visible: !!(win && !win.isDestroyed() && win.isVisible()),
    restoreUrl: pendingRestoreUrl || ''
  }));

  ipcMain.handle('get-paths', () => ({
    webviewPreload: pathToFileURL(path.join(APP_DIR, 'renderer', 'reader-preload.js')).href,
    homePage: HOME_URL
  }));

  ipcMain.handle('set-bg-transparent', (_e, on) => applyBgTransparent(!!on));

  // v1.4.1：像素级采样 —— 对 guest 截图后取指定坐标像素（BGRA），
  // 用于冒烟测试验证"网页区域真正透出壁纸"（计算样式透明 ≠ 实际渲染透明）
  ipcMain.handle('capture-sample', async (_e, p) => {
    const x = Math.max(0, Math.floor(Number(p && p.x) || 0));
    const y = Math.max(0, Math.floor(Number(p && p.y) || 0));
    const out = { ok: false, x, y };
    try {
      if (guestWC && !guestWC.isDestroyed()) {
        const img = await guestWC.capturePage();
        const size = img.getSize();
        out.gw = size.width; out.gh = size.height;
        const bmp = img.toBitmap(); // BGRA（toBitmap 未预乘；alpha 断言两者等价）
        if (size.width > 0 && bmp.length >= size.width * size.height * 4) {
          const cx = Math.min(x, size.width - 1);
          const cy = Math.min(y, size.height - 1);
          const i = (cy * size.width + cx) * 4;
          out.ok = true;
          out.b = bmp[i]; out.g = bmp[i + 1]; out.r = bmp[i + 2]; out.a = bmp[i + 3];
        } else {
          out.reason = 'empty-capture';
        }
      } else {
        out.reason = 'no-guest';
      }
    } catch (e) {
      out.reason = e && e.message;
    }
    return out;
  });
  ipcMain.on('set-opacity', (_e, v) => setOpacityTarget(v, 'renderer'));
  ipcMain.on('set-always-on-top', (_e, on) => applyAlwaysOnTop(!!on));
  ipcMain.on('set-click-through', (_e, on) => applyClickThrough(!!on));
  ipcMain.on('set-auto-hide', (_e, on) => applyAutoHide(!!on));
  ipcMain.on('typing-changed', (_e, on) => { typing = !!on; });
  ipcMain.on('minimize-to-tray', () => hideToTray());
  ipcMain.on('resize-by', (_e, dx, dy) => resizeBy(dx, dy));
  ipcMain.on('report-url', (_e, url) => {
    if (typeof url === 'string' && /^(https?|file):/i.test(url) && url !== HOME_URL) lastPageUrl = url;
  });
  ipcMain.on('open-external', (_e, url) => { if (/^https?:/i.test(url)) shell.openExternal(url); });
  ipcMain.on('toggle-devtools', () => { if (win && !win.isDestroyed()) win.webContents.toggleDevTools(); });
  ipcMain.on('quit-app', () => quitApp());

  ipcMain.on('smoke-report', (_e, msg) => {
    console.log('[SMOKE]', msg);
    if (msg === 'ALL-PASS') setTimeout(() => app.exit(0), 300);
  });
}

/* ==================== 生命周期 ==================== */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) showWindow(true); });

  app.whenReady().then(() => {
    if (process.platform === 'darwin') { try { app.dock.hide(); } catch (e) { /* ignore */ } }
    bindIpc();
    createWindow();
    createTray();
    registerShortcuts();
    startPoller();
    log('app started, platform=' + process.platform);
    if (IS_SMOKE) {
      setTimeout(() => { console.error('[SMOKE] TIMEOUT-EXIT'); app.exit(1); }, 30000);
    }
  });

  app.on('window-all-closed', () => {
    if (quitting || recreating) return; // 重建窗口的间隙不要退出
    app.quit();
  });
  app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ } });
}

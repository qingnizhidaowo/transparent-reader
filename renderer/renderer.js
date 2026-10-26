'use strict';

/**
 * 渲染层逻辑 (v1.2)：工具栏、webview 网页模式、阅读模式、
 * 背景透明（仅文字）模式、缩放手柄、最小化到托盘
 */
(function () {
  const $ = (sel) => document.querySelector(sel);

  // 伪装成常规 Chrome，避免部分站点对 Electron UA 做特殊处理
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const SMOKE = new URLSearchParams(location.search).has('smoke');

  // v1.4.1：网页背景剥离 CSS 改由主进程以用户级样式表注入（cssOrigin:'user'，
  // 压过网页任何 !important 白底），并覆盖 iframe 子框架 —— 详见 main.js GUEST_CSS

  /* ---------- DOM ---------- */
  const urlInput = $('#url');
  const opacityEl = $('#opacity');
  const opacityVal = $('#opacity-val');
  const btnBack = $('#btn-back');
  const btnForward = $('#btn-forward');
  const btnReload = $('#btn-reload');
  const btnMode = $('#btn-mode');
  const btnPin = $('#btn-pin');
  const btnGhost = $('#btn-ghost');
  const btnTextmode = $('#btn-textmode');
  const btnHide = $('#btn-hide');
  const btnClose = $('#btn-close');
  const view = $('#view');
  const readerPane = $('#reader');
  const readerTitle = $('#reader-title');
  const readerBody = $('#reader-body');
  const readerEmpty = $('#reader-empty');
  const btnFontMinus = $('#font-minus');
  const btnFontPlus = $('#font-plus');
  const btnReaderBack = $('#reader-back');
  const errorPane = $('#error-pane');
  const errorText = $('#error-text');
  const btnRetry = $('#btn-retry');
  const loadBar = $('#load-bar');
  const toastEl = $('#toast');
  const grip = $('#grip');

  /* ---------- 状态 ---------- */
  let state = {
    opacity: 0.4, alwaysOnTop: true, clickThrough: false, autoHide: true,
    fade: false, bgTransparent: false, restoreUrl: ''
  };
  let mode = 'web'; // 'web' | 'reader'
  let zoom = 1;
  let readerFont = 17;
  let lastUrl = '';
  let toastTimer = null;

  /* ---------- 工具 ---------- */

  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 1800);
  }

  function safe(fn) { try { fn(); } catch (e) { /* ignore */ } }

  function normalizeInput(raw) {
    raw = (raw || '').trim();
    if (!raw) return '';
    if (/^(https?|file):\/\//i.test(raw)) return raw;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(raw)) return 'https://' + raw;
    return 'https://www.bing.com/search?q=' + encodeURIComponent(raw);
  }

  function showLoading(on) {
    loadBar.classList.toggle('on', !!on);
    if (on) errorPane.classList.add('hidden');
  }

  function showError(msg) {
    errorText.textContent = msg || '页面加载失败';
    errorPane.classList.remove('hidden');
    showLoading(false);
  }

  function syncUrl(u) {
    if (/^file:/i.test(u)) {
      urlInput.value = '';
      urlInput.placeholder = '输入网址回车打开，如 zhihu.com；输入文字则自动搜索';
    } else {
      urlInput.value = u;
      lastUrl = u;
    }
    urlInput.title = u;
  }

  function applyStateUi() {
    document.body.classList.toggle('bg-transparent', !!state.bgTransparent);
    const pct = Math.round(state.opacity * 100);
    opacityEl.value = pct;
    opacityVal.textContent = pct + '%';
    btnPin.classList.toggle('active', !!state.alwaysOnTop);
    btnGhost.classList.toggle('active', !!state.clickThrough);
    btnTextmode.classList.toggle('active', !!state.bgTransparent);
  }

  /* ---------- 初始化 ---------- */

  async function init() {
    try { state = Object.assign(state, await window.tr.getState()); } catch (e) { /* 非 Electron 环境 */ }
    applyStateUi();

    let paths = { webviewPreload: 'reader-preload.js', homePage: 'home.html' };
    try { paths = await window.tr.getPaths(); } catch (e) { /* ignore */ }

    // 属性必须在首次加载前设置
    // allowpopups：放行 target=_blank / window.open 请求，交由主进程在应用内自动跳转（v1.1）
    view.setAttribute('preload', paths.webviewPreload);
    view.setAttribute('useragent', UA);
    view.setAttribute('allowpopups', '');

    // 窗口重建（切换背景透明模式）后，恢复上次的页面
    const restore = state.restoreUrl && state.restoreUrl !== paths.homePage ? state.restoreUrl : '';
    view.src = restore || paths.homePage;

    bindToolbar();
    bindWebview();
    bindIpc();
    bindKeys();
    bindGrip();
    if (SMOKE) setupSmoke();
  }

  /* ---------- 工具栏 ---------- */

  function bindToolbar() {
    btnBack.addEventListener('click', () => safe(() => view.goBack()));
    btnForward.addEventListener('click', () => safe(() => view.goForward()));
    btnReload.addEventListener('click', () => {
      if (mode === 'web') safe(() => view.reload());
      else toast('阅读模式是提取后的快照，返回网页模式后可刷新');
    });
    btnMode.addEventListener('click', () => toggleMode());
    btnPin.addEventListener('click', () => window.tr.setAlwaysOnTop(!state.alwaysOnTop));
    btnGhost.addEventListener('click', () => {
      const next = !state.clickThrough;
      window.tr.setClickThrough(next);
      toast(next ? '已开启鼠标穿透：点击穿到底层应用，Ctrl+Alt+T 关闭' : '已关闭鼠标穿透');
    });
    btnTextmode.addEventListener('click', () => {
      const next = !state.bgTransparent;
      toast(next ? '背景透明：除文字图片外全透明，工具栏保持常显' : '关闭背景透明：恢复整窗透明度', 2600);
      // 稍等 toast 渲染后再重建窗口
      setTimeout(() => { window.tr.setBgTransparent(next).catch(() => {}); }, 150);
    });
    btnHide.addEventListener('click', () => window.tr.minimizeToTray()); // 问题2：最小化到托盘
    btnClose.addEventListener('click', () => window.tr.quit());
    btnReaderBack.addEventListener('click', exitReader);
    btnFontMinus.addEventListener('click', () => adjustReaderFont(-1));
    btnFontPlus.addEventListener('click', () => adjustReaderFont(1));

    opacityEl.addEventListener('input', () => {
      const v = Number(opacityEl.value);
      opacityVal.textContent = v + '%';
      window.tr.setOpacity(v / 100); // 整窗透明度（背景透明模式下滑块已隐藏）
    });

    // 输入网址时暂停自动隐藏（主进程 typing 标记）
    let typingTimer = null;
    urlInput.addEventListener('focus', () => {
      clearTimeout(typingTimer);
      safe(() => window.tr.setTyping(true));
    });
    urlInput.addEventListener('blur', () => {
      typingTimer = setTimeout(() => safe(() => window.tr.setTyping(false)), 600);
    });
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const u = normalizeInput(urlInput.value);
        if (u) { urlInput.blur(); loadUrl(u); }
      } else if (e.key === 'Escape') {
        urlInput.blur();
      }
    });

    btnRetry.addEventListener('click', () => {
      errorPane.classList.add('hidden');
      if (lastUrl) safe(() => view.loadURL(lastUrl));
      else safe(() => view.reload());
    });
  }

  function loadUrl(u) {
    exitReader();
    errorPane.classList.add('hidden');
    lastUrl = u;
    view.loadURL(u);
  }

  /* ---------- webview ---------- */

  function bindWebview() {
    view.addEventListener('dom-ready', () => {
      safe(() => view.setZoomFactor(zoom));
      // 背景透明：网页底色剥离由主进程注入（v1.4.1 用户级样式表，压过 !important）
    });

    view.addEventListener('did-start-loading', () => showLoading(true));
    view.addEventListener('did-stop-loading', () => showLoading(false));

    view.addEventListener('did-navigate', (e) => {
      syncUrl(e.url);
      safe(() => window.tr.reportUrl(e.url)); // 上报给主进程，窗口重建后可恢复
    });

    view.addEventListener('did-navigate-in-page', (e) => {
      if (e.isMainFrame) {
        syncUrl(e.url);
        safe(() => window.tr.reportUrl(e.url));
      }
    });

    view.addEventListener('did-fail-load', (e) => {
      if (e.isMainFrame && e.errorCode !== -3) {
        showError('页面加载失败：' + (e.errorDescription || '错误码 ' + e.errorCode));
      }
    });

    view.addEventListener('page-title-updated', (e) => {
      document.title = '透明阅读 · ' + (e.title || '');
    });

    // 网页内全屏（视频）时铺满整个窗口
    view.addEventListener('enter-html-full-screen', () => view.classList.add('fs'));
    view.addEventListener('leave-html-full-screen', () => view.classList.remove('fs'));
  }

  /* ---------- 阅读模式 ---------- */

  async function toggleMode() {
    if (mode === 'web') {
      toast('正在提取正文…', 2500);
      let data = null;
      try {
        data = await view.executeJavaScript(
          '(window.__reader ? window.__reader.extract() : { ok: false, reason: "preload-missing" })', true);
      } catch (e) {
        data = { ok: false, reason: String(e && e.message || e) };
      }
      if (!data || !data.ok) {
        toast('未能提取正文（' + ((data && data.reason) || '未知原因') + '），继续用网页模式浏览');
        return;
      }
      renderReader(data);
      mode = 'reader';
      updateModeUi();
      toast('已进入阅读模式 · Ctrl+Alt + 加减号 调字号');
    } else {
      exitReader();
    }
  }

  function renderReader(data) {
    readerTitle.textContent = (data.title || '正文') + (data.site ? ' · ' + data.site : '');
    readerBody.innerHTML = data.html || '';
    readerBody.scrollTop = 0;

    // 长段落居多 → 判定为小说类，首行缩进
    const ps = readerBody.querySelectorAll('p');
    let longOnes = 0;
    ps.forEach((p) => { if ((p.textContent || '').trim().length > 60) longOnes++; });
    readerBody.classList.toggle('novel', ps.length > 0 && longOnes / ps.length > 0.6);

    readerBody.classList.toggle('hidden', !data.html);
    readerEmpty.classList.toggle('hidden', !!data.html);
    readerPane.classList.remove('hidden');
    view.classList.add('reader-hidden'); // 仅视觉隐藏，保留网页状态
    document.documentElement.style.setProperty('--reader-font', readerFont + 'px');
  }

  function exitReader() {
    if (mode !== 'reader') return;
    mode = 'web';
    readerPane.classList.add('hidden');
    view.classList.remove('reader-hidden');
    updateModeUi();
  }

  function updateModeUi() {
    btnMode.textContent = mode === 'web' ? '阅读' : '网页';
    btnMode.title = mode === 'web' ? '提取正文，切换到阅读模式' : '返回普通网页模式';
    btnMode.classList.toggle('active', mode === 'reader');
  }

  function adjustReaderFont(d) {
    readerFont = Math.min(28, Math.max(12, readerFont + d));
    document.documentElement.style.setProperty('--reader-font', readerFont + 'px');
    toast('字号 ' + readerFont + 'px');
  }

  /* ---------- 主进程事件 ---------- */

  function bindIpc() {
    window.tr.onState((s) => {
      state = Object.assign({}, state, s);
      applyStateUi();
    });

    window.tr.onZoom((dir) => {
      if (mode === 'reader') {
        if (dir === 'in') adjustReaderFont(1);
        else if (dir === 'out') adjustReaderFont(-1);
        else {
          readerFont = 17;
          document.documentElement.style.setProperty('--reader-font', '17px');
          toast('字号已重置');
        }
      } else {
        zoom = dir === 'in' ? Math.min(3, zoom + 0.1)
             : dir === 'out' ? Math.max(0.4, zoom - 0.1) : 1;
        safe(() => view.setZoomFactor(zoom));
        toast('网页缩放 ' + Math.round(zoom * 100) + '%');
      }
    });

    window.tr.onFocusUrl(() => {
      exitReader();
      setTimeout(() => { urlInput.focus(); urlInput.select(); }, 60);
    });
  }

  /* ---------- 本窗口快捷键 ---------- */

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        urlInput.focus();
        urlInput.select();
      } else if (e.key === 'F12') {
        safe(() => window.tr.toggleDevtools());
      }
    });
  }

  /* ---------- 缩放手柄（背景透明模式下兜底） ---------- */

  function bindGrip() {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    grip.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dx || dy) window.tr.resizeBy(dx, dy);
    });
    const up = (e) => {
      dragging = false;
      try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  /* ---------- 冒烟测试 ---------- */
  /* 三轮：
     第1轮（普通窗口）：加载引导页 → 正文提取 → 新标签链接应用内跳转 → 透明度 IPC → 切背景透明
     第2轮（重建后的透明窗口）：验证模式状态/页面恢复/即时隐藏配置 → 底色浓度 IPC → 最小化到托盘 */

  function setupSmoke() {
    const report = (m) => window.tr.smokeReport(m);
    report('renderer-loaded');

    if (state.bgTransparent) {
      // ---- 第2轮：背景透明窗口 ----
      report('round2-start fade=' + state.fade + ' autoHide=' + state.autoHide);
      if (state.fade !== false) return report('FAIL fade-default-on');

      // 等注入 CSS 生效：背景被剥透，且文字保留原色（smoke-target 内联色为 rgb(204,211,221)；
      // 若被强制改色会变成浅蓝白，据此断言"不强制浅色"）
      const waitGuestCss = async () => {
        for (let i = 0; i < 10; i++) {
          let r = null;
          try {
            r = await view.executeJavaScript(
              '(function(){ var c = getComputedStyle(document.body);' +
              ' return { bg: c.backgroundColor, color: c.color }; })()', true);
          } catch (e) { return null; }
          if (r && r.bg === 'rgba(0, 0, 0, 0)') return r;
          await new Promise((res) => setTimeout(res, 200));
        }
        return null;
      };

      view.addEventListener('dom-ready', async () => {
        let url = '';
        try { url = view.getURL(); } catch (e) { url = view.src || ''; }
        report(/smoke-target\.html/.test(url) ? 'bgtransparent-restored' : 'FAIL restore-url ' + url);

        // v1.4：应用自身 UI 全透明断言（除文字/图片外一切透明）
        const tbBg = getComputedStyle(document.getElementById('toolbar')).backgroundColor;
        if (tbBg !== 'rgba(0, 0, 0, 0)') return report('FAIL toolbar-not-transparent ' + tbBg);
        const obDisplay = getComputedStyle(document.getElementById('opacity-box')).display;
        if (obDisplay !== 'none') return report('FAIL opacity-box-visible ' + obDisplay);
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        if (bodyBg !== 'rgba(0, 0, 0, 0)') return report('FAIL host-body-not-transparent ' + bodyBg);
        report('chrome-fully-transparent-ok');

        // v1.4.2：工具栏常显断言（不再收起到顶部/悬停滑出，顶部细条已移除）
        if (document.getElementById('drag-strip')) return report('FAIL drag-strip-still-present');
        const tbTransform = getComputedStyle(document.getElementById('toolbar')).transform;
        if (tbTransform !== 'none') return report('FAIL toolbar-collapsed ' + tbTransform);
        const tbPos = getComputedStyle(document.getElementById('toolbar')).position;
        if (tbPos === 'absolute' || tbPos === 'fixed') return report('FAIL toolbar-overlay ' + tbPos);
        report('toolbar-always-visible-ok');

        const css = await waitGuestCss();
        if (!css) return report('FAIL guest-css-not-applied');
        if (css.color !== 'rgb(204, 211, 221)') return report('FAIL text-color-forced ' + css.color);
        report('guest-css-ok bg=transparent color=original');

        // v1.4.1 强化：!important 写死的白底（卡片）与 iframe 子框架白底也必须剥透
        const cardBg = await view.executeJavaScript(
          '(function(){var el=document.getElementById("card");' +
          'return el?getComputedStyle(el).backgroundColor:"no-card";})()', true);
        if (cardBg !== 'rgba(0, 0, 0, 0)') return report('FAIL card-important-bg ' + cardBg);
        report('card-important-stripped-ok');

        let iframeBg = 'no-iframe';
        for (let i = 0; i < 15; i++) {
          try {
            iframeBg = await view.executeJavaScript(
              '(function(){var f=document.getElementById("sub");' +
              'if(!f||!f.contentDocument||!f.contentDocument.body)return "no-iframe";' +
              'return getComputedStyle(f.contentDocument.body).backgroundColor;})()', true);
          } catch (e) { iframeBg = 'threw:' + (e && e.message); }
          if (iframeBg === 'rgba(0, 0, 0, 0)') break;
          await new Promise((res) => setTimeout(res, 200));
        }
        if (iframeBg !== 'rgba(0, 0, 0, 0)') return report('FAIL iframe-bg ' + iframeBg);
        report('iframe-bg-stripped-ok');

        // 像素级：guest 留白处应真正透出（计算样式透明 ≠ 实际渲染透明）
        await new Promise((res) => setTimeout(res, 400));
        let px = null;
        try { px = await window.tr.captureSample({ x: 30, y: 30 }); }
        catch (e) { px = { ok: false, reason: 'threw:' + (e && e.message) }; }
        report('capture-sample ' + JSON.stringify(px));
        if (px && px.ok) {
          if (px.a > 60) return report('FAIL pixel-not-transparent a=' + px.a + ' rgb=' + px.r + ',' + px.g + ',' + px.b);
          report('pixel-transparent-ok a=' + px.a);
        } else {
          report('capture-skip ' + (px && px.reason));
        }

        // v1.3：最小化到托盘 → 暂停移入自动显示（双击托盘才弹出）
        window.tr.minimizeToTray();
        setTimeout(async () => {
          let s3 = null;
          try { s3 = await window.tr.getState(); } catch (e) { return report('FAIL getstate-threw'); }
          report(s3.visible === false ? 'minimize-to-tray-ok' : 'FAIL minimize-visible=' + s3.visible);
          report(s3.autoShowEnabled === false ? 'autoshow-suspended-ok' : 'FAIL autoshow-not-suspended');
          report('ALL-PASS');
        }, 700);
      });
      setTimeout(() => report('FAIL round2-timeout'), 15000);
      return;
    }

    // ---- 第1轮：普通窗口 ----
    let stage = 0;
    view.addEventListener('dom-ready', async () => {
      if (stage !== 0) return; // 只在引导页跑提取测试
      stage = 1;
      report('webview-dom-ready');
      try {
        const r = await view.executeJavaScript(
          '(window.__reader ? (function(){ var d = window.__reader.extract();' +
          ' return { ok: d.ok, title: d.title, textLen: d.textLen, reason: d.reason }; })()' +
          ' : { ok: false, reason: "preload-missing" })', true);
        report('extract-result ' + JSON.stringify(r));
        if (!r || !r.ok) return report('FAIL extract-not-ok');
        // 验证 v1.1 修复项：target=_blank 新标签链接在应用内自动跳转
        report('click-newtab-link');
        view.executeJavaScript('document.getElementById("smoke-newtab").click()', true)
          .catch((e) => report('FAIL click-threw ' + (e && e.message)));
        setTimeout(() => { if (stage === 1) report('FAIL newtab-no-nav'); }, 5000);
      } catch (e) {
        report('FAIL extract-threw ' + (e && e.message));
      }
    });

    view.addEventListener('did-navigate', async (e) => {
      if (stage === 1 && /smoke-target\.html/.test(e.url || '')) {
        stage = 2;
        report('newtab-inapp-nav ' + e.url);
        window.tr.setOpacity(0.55);
        report('set-opacity-sent');
        // 验证 v1.2 修复项：切换到背景透明模式（主进程会重建窗口，本页面随之销毁）
        report('toggling-bg-transparent');
        try { await window.tr.setBgTransparent(true); } catch (e) { /* 页面销毁，预期 */ }
      }
    });

    setTimeout(() => report('FAIL renderer-timeout'), 15000);
  }

  init();
})();

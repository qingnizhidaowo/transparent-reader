'use strict';

/**
 * webview preload：向网页注入 window.__reader.extract()
 * 简化版 Readability —— 段落评分 + 链接密度惩罚 + 克隆清洗，
 * 返回可直接渲染的正文 HTML（已剥离脚本/事件/危险协议）。
 */
const { contextBridge } = require('electron');

function extractReadable() {
  const doc = document;
  if (!doc || !doc.body) return { ok: false, reason: 'no-body' };

  /* 1. 标题 */
  let title = '';
  const og = doc.querySelector('meta[property="og:title"]');
  if (og && og.content) title = og.content.trim();
  if (!title) { const h1 = doc.querySelector('h1'); if (h1) title = h1.innerText.trim(); }
  if (!title) title = (doc.title || '').trim();

  /* 2. 收集候选段落（长度 >= 20 字，过滤版权/广告短句） */
  const paras = Array.from(doc.querySelectorAll('p, pre, blockquote')).filter((p) => {
    const t = (p.innerText || '').trim();
    if (t.length < 20) return false;
    return !/^(版权|广告|免责声明|all rights reserved|copyright)/i.test(t);
  });
  if (!paras.length) return { ok: false, reason: 'no-paragraphs' };

  /* 3. 段落评分：向父级/祖父级累加（越近权重越高），链接密度惩罚 */
  const scores = new Map();
  for (const p of paras) {
    const len = p.innerText.trim().length;
    let node = p.parentElement;
    let depth = 0;
    while (node && node !== doc.body && depth < 3) {
      const bonus = depth === 0 ? len * 2 : len;
      scores.set(node, (scores.get(node) || 0) + bonus);
      node = node.parentElement;
      depth++;
    }
  }
  let best = null;
  let bestScore = 0;
  for (const [el, s] of scores) {
    const elTextLen = Math.max(1, (el.innerText || '').length);
    let linkTextLen = 0;
    el.querySelectorAll('a').forEach((a) => { linkTextLen += (a.innerText || '').length; });
    const linkDensity = linkTextLen / elTextLen; // 0~1，导航区接近 1
    const adj = s * (1 - Math.min(0.8, linkDensity));
    if (adj > bestScore) { bestScore = adj; best = el; }
  }
  if (!best) return { ok: false, reason: 'no-candidate' };

  /* 4. 克隆清洗 */
  const clone = best.cloneNode(true);
  clone.querySelectorAll(
    'script,style,noscript,iframe,frame,svg,canvas,form,button,input,select,textarea,' +
    'nav,header,footer,aside,video,audio,embed,object'
  ).forEach((n) => n.remove());
  clone.querySelectorAll(
    '[role="navigation"],[role="banner"],[role="complementary"],' +
    '.nav,#nav,.menu,#menu,.sidebar,.comment,#comment,.breadcrumb,.share,.related,.recommend,.copyright'
  ).forEach((n) => n.remove());
  // 几乎没有文字却带链接的元素（推荐位/导航残留）
  clone.querySelectorAll('div,section,span,ul').forEach((n) => {
    const t = (n.innerText || '').trim();
    if (t.length < 5 && n.querySelector('a')) n.remove();
  });

  let html = clone.innerHTML || '';
  const textLen = (clone.innerText || '').trim().length;

  /* 5. 安全处理：剥离内联事件与 javascript: 协议 */
  html = html.replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '');
  html = html.replace(/javascript:/gi, '#');
  if (html.length > 900000) html = html.slice(0, 900000);

  if (textLen < 80) return { ok: false, reason: 'too-short', title };

  /* 6. 首图（可选） */
  let cover = '';
  const ogImg = doc.querySelector('meta[property="og:image"]');
  if (ogImg && ogImg.content) cover = ogImg.content;

  return { ok: true, title, site: location.hostname, cover, html, textLen };
}

contextBridge.exposeInMainWorld('__reader', {
  extract: () => {
    try { return extractReadable(); }
    catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  }
});

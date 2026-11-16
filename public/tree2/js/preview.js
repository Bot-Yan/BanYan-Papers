// tree2/js/preview.js —— 客户端渲染：图片 / PDF / Word / Excel / PPT / 音频 / 文本。
//
// 和 XMUHub 的 web/assets/preview.js 同一套取舍：
//   * 四种文件类型四种渲染器，按需加载（首屏不带任何渲染库）；
//   * PDF 用 pdf.js，页面进入视野才画（1000 页的卷子也不会卡住）；
//   * Word 用 docx-preview（纯浏览器渲染 OOXML，不需要服务端转 PDF，卷子里的公式/表格原件保留）；
//   * 从文件内容里渲染出来的 HTML 一律过 sanitize()，再放进页面。

const V = new URL('../vendor', import.meta.url).href;
const MAX = 80 * 1024 * 1024; // 在线预览上限，和参考项目一致

const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' };
const AUDIO = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' };
const TEXT = new Set(['txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'py', 'c', 'h', 'cpp', 'java', 'go', 'rs', 'sql', 'sh', 'ps1', 'ini', 'cfg', 'conf', 'yaml', 'yml', 'toml', 'log', 'tex', 'srt', 'csv', 'tsv']);
const WORD = new Set(['docx', 'docm', 'dotx']);
const SHEET = new Set(['xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'csv', 'tsv']);

export const extOf = (name) => (/\.([^./\\]+)$/.exec(name || '')?.[1] || '').toLowerCase();

/** 类型归类，和 scripts/build-tree2-index.mjs 的 kindOf 保持一致。 */
export function kindOf(name) {
  const e = extOf(name);
  if (e === 'pdf') return 'pdf';
  if (WORD.has(e)) return 'docx';
  if (SHEET.has(e)) return 'sheet';
  if (e === 'pptx' || e === 'ppsx' || e === 'pptm') return 'slides';
  if (IMAGE[e]) return 'image';
  if (AUDIO[e]) return 'audio';
  if (TEXT.has(e)) return 'text';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(e)) return 'archive';
  if (e === 'doc' || e === 'dot' || e === 'wps') return 'legacy-doc';
  if (e === 'ppt' || e === 'pps') return 'legacy-ppt';
  return 'other';
}

export const canRender = (name) => ['pdf', 'docx', 'sheet', 'image', 'audio', 'text'].includes(kindOf(name));

// ---------------------------------------------------------------- 脚本按需加载

const loaded = new Map();
function script(src) {
  if (!loaded.has(src)) {
    loaded.set(
      src,
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => {
          loaded.delete(src);
          reject(new Error(`加载渲染组件失败：${src}`));
        };
        document.head.appendChild(s);
      }),
    );
  }
  return loaded.get(src);
}

/** 云存储的 CORS / 鉴权限制会让 pdf.js 的 worker 起不来，失败时退到主线程解析。 */
let workerBroken = false;

// ---------------------------------------------------------------- 净化

/**
 * 清洗「从文件内容里渲染出来的 HTML」（Word / Excel）。
 * 只留 http(s)/mailto/页内链接；去掉事件属性与脚本类标签。
 */
export function sanitize(root) {
  root.querySelectorAll('script, iframe, frame, object, embed, form, base, meta, link[rel="import"]').forEach((el) => el.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const { name } of [...el.attributes]) {
      if (/^on/i.test(name) || name.toLowerCase() === 'formaction') el.removeAttribute(name);
    }
    if (el.localName !== 'a') continue;
    for (const attr of ['href', 'xlink:href']) {
      if (!el.hasAttribute(attr)) continue;
      const v = el.getAttribute(attr).trim();
      if (v.startsWith('#')) continue;
      let ok = false;
      try {
        ok = ['http:', 'https:', 'mailto:'].includes(new URL(v, location.href).protocol);
      } catch {
        /* 非法 URL */
      }
      if (!ok) el.removeAttribute(attr);
      else if (!v.toLowerCase().startsWith('mailto:')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
  }
}

// ---------------------------------------------------------------- 入口

/**
 * 在 box 里渲染一个文件。
 * @param {HTMLElement} box
 * @param {Blob|string} src  Blob，或可直接访问的 URL（仅图片/音频用）
 * @param {string} name      文件名
 * @param {{ note?: (html:string)=>void }} opts
 */
export async function render(box, src, name, opts = {}) {
  const isCurrent = opts.isCurrent || (() => true);
  const showNote = opts.note || ((html) => { box.innerHTML = `<div class="pad">${html}</div>`; });
  const note = (html) => { if (isCurrent()) showNote(html); };
  const ext = extOf(name);
  const kind = kindOf(name);
  try {
    if (kind === 'pdf' || kind === 'image') {
      const blob = await toBlob(src);
      if (!isCurrent()) return;
      if (kind === 'pdf') return await pdf(box, blob, note);
      return media(box, blob, IMAGE[ext] || 'image/*', (u) => `<img class="t2-img" src="${u}" alt="">`);
    }
    if (kind === 'docx') return await word(box, await toBlob(src), note, isCurrent);
    if (kind === 'sheet') return await sheet(box, await toBlob(src), ext);
    if (kind === 'text') return await text(box, await toBlob(src), ext);
    if (kind === 'slides') return note('PPT 暂不支持在线渲染，请下载后用 PowerPoint / WPS 打开。');
    if (kind === 'legacy-doc') return note('这是旧版 .doc 格式。转成 .docx 后即可在线预览，或直接下载用 Word / WPS 打开。');
    note(`浏览器无法直接渲染 .${ext || '?'}，请下载后打开。`);
  } catch (e) {
    if (!isCurrent()) return;
    const blob = src instanceof Blob ? src : null;
    const dl = blob ? `<p><a href="${URL.createObjectURL(blob)}" download="${escapeHtml(name)}">保存到本地</a></p>` : '';
    note(`预览失败：${escapeHtml(e && e.message ? e.message : String(e))}${dl}`);
  }
}

async function toBlob(src) {
  if (src instanceof Blob) return src;
  const response = await fetch(src);
  if (!response.ok) throw new Error('文件读取失败（HTTP ' + response.status + '）');
  return response.blob();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
}

function media(box, blob, type, html) {
  const u = URL.createObjectURL(new Blob([blob], { type }));
  box.innerHTML = html(u);
}

// ---------------------------------------------------------------- 音频（Navidrome 风格播放器）

/** 秒 → mm:ss / h:mm:ss */
// ---------------------------------------------------------------- PDF（pdf.js）

/**
 * 上一份 PDF 的会话回收：pdf.js 文档（几十 MB 的 ArrayBuffer）、window 监听器、
 * 两个 Observer。不回收的话，连开几十份卷子内存会一直涨。
 * 渲染新 PDF 前自动清上一个；关闭预览抽屉时由 app.js 调 disposePdf() 主动清。
 */
let pdfCleanup = null;
let pdfSeq = 0;
export function disposePdf() {
  pdfSeq += 1; // 让还在渲染中的旧 pdf() 不再注册清理回调，防止它晚完成时覆盖掉新一份的清理
  if (pdfCleanup) {
    pdfCleanup();
    pdfCleanup = null;
  }
}

async function pdf(box, blob, note) {
  disposePdf(); // 换着看 PDF/其它文件时，上一个文档的内存和监听器都还在
  const seq = pdfSeq;
  // 渲染期间又开了别的文件（seq 已变）：本次渲染的产物已被丢弃，
  // 不能再写 DOM、更不能让已取得的文档（几十 MB 的 ArrayBuffer）无人回收。
  const stale = () => seq !== pdfSeq;
  await script(`${V}/pdfjs-3.11.174/pdf.min.js`);
  if (stale()) return;
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('pdf.js 没有正确加载');
  const workerSrc = new URL(`${V}/pdfjs-3.11.174/pdf.worker.min.js`, location.href).href;
  lib.GlobalWorkerOptions.workerSrc = workerSrc;

  const data = await blob.arrayBuffer();
  if (stale()) return;
  const base = {
    data,
    cMapUrl: new URL(`${V}/pdfjs-3.11.174/cmaps/`, location.href).href,
    cMapPacked: true,
    isEvalSupported: false,
  };
  let doc;
  if (workerBroken) {
    lib.GlobalWorkerOptions.workerSrc = '';
    doc = await lib.getDocument({ ...base, disableWorker: true }).promise;
  } else {
    try {
      doc = await lib.getDocument(base).promise;
    } catch (e) {
      if (stale()) return;
      // Worker 加载失败时改用主线程。
      workerBroken = true;
      lib.GlobalWorkerOptions.workerSrc = '';
      doc = await lib.getDocument({ ...base, disableWorker: true }).promise;
    }
  }
  if (stale()) { await doc.destroy().catch(() => {}); return; }

  let io = null, ro = null, rzTimer;
  let onResize;
  const cleanup = () => {
    clearTimeout(rzTimer);
    if (onResize) {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    }
    io?.disconnect();
    ro?.disconnect();
    void doc.destroy().catch(() => {});
  };
  pdfCleanup = cleanup;
  let first;
  try {
    if (doc.numPages) first = await doc.getPage(1);
  } catch (error) {
    if (stale()) return;
    disposePdf();
    throw error;
  }
  if (stale()) return;
  if (!first) {
    disposePdf();
    note('这个 PDF 没有页面。');
    return;
  }

  box.innerHTML = '';
  const view = document.createElement('div');
  view.className = 't2-pdf';
  const meta = document.createElement('p');
  meta.style.cssText = 'color:var(--v-sub);font-size:12px;margin:0 0 10px';
  meta.textContent = `共 ${doc.numPages} 页 · 滚动自动翻页`;
  view.appendChild(meta);
  box.appendChild(view);

  const v1 = first.getViewport({ scale: 1 });
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const holder = document.createElement('div');
    holder.className = 't2-pdfpage';
    holder.style.aspectRatio = `${v1.width} / ${v1.height}`;
    holder.style.width = 'min(100%, 900px)';
    holder.dataset.n = String(i);
    view.appendChild(holder);
    pages.push(holder);
  }

  const drawPage = async (holder) => {
    if (holder.dataset.done || stale()) return;
    holder.dataset.done = '1';
    const page = await doc.getPage(Number(holder.dataset.n));
    if (stale()) return; // 文档已被新预览销毁/接管，别再往脱离 DOM 的容器上画
    const b = page.getViewport({ scale: 1 });
    // 至少 2 倍、最多 3 倍：有些内嵌浏览器把 devicePixelRatio 报成 1，
    // 只按 1 倍画的话在 3 倍屏上会被放大到糊成一片。
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 2), 3);
    // 按"要显示成多宽"算，别再乘 0.98（那会让位图小于显示尺寸，必然发虚）
    const cssW = holder.clientWidth || view.clientWidth || 900;
    let scale = (cssW * dpr) / b.width;
    let w = Math.floor(b.width * scale);
    let h = Math.floor(b.height * scale);
    // 超大页面上限：避免一张图吃掉几百 MB 内存
    const MAX_PX = 12e6;
    if (w * h > MAX_PX) {
      const k = Math.sqrt(MAX_PX / (w * h));
      scale *= k;
      w = Math.floor(w * k);
      h = Math.floor(h * k);
    }
    const vp = page.getViewport({ scale });
    holder.querySelectorAll('canvas').forEach((c) => c.remove());
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    holder.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp, intent: 'display' }).promise;
  };

  // 先画第一页，其余进入视野再画
  drawPage(pages[0]).catch(() => {});
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          drawPage(e.target).catch(() => {});
        }
      },
      { root: box, rootMargin: '1200px 0px' },
    );
    pages.forEach((p) => io.observe(p));
  }

  // 转屏 / 窗口变化 / 抽屉宽度变了：按新宽度重画，否则还是旧分辨率被拉伸
  onResize = () => {
    if (stale()) return;
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => {
      for (const p of pages) p.dataset.done = '';
      if (io) pages.forEach((p) => io.observe(p));
      drawPage(pages[0]).catch(() => {});
    }, 250);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  // 容器本身变宽/变窄（抽屉布局变化、横竖屏切换）也要按新宽度重画，
  // 否则画布会被 CSS 拉伸 —— 那就是"糊"的来源。
  if ('ResizeObserver' in window) {
    let lastW = view.clientWidth;
    ro = new ResizeObserver(() => {
      const w = view.clientWidth;
      if (!w || Math.abs(w - lastW) < 8) return;
      lastW = w;
      onResize();
    });
    ro.observe(view);
  }

  if (!io) for (const p of pages.slice(1, 6)) await drawPage(p).catch(() => {});
}

// ---------------------------------------------------------------- Word（docx-preview）

let wordResizeObserver;
export function disposeWord() {
  wordResizeObserver?.disconnect();
  wordResizeObserver = null;
}

async function word(box, blob, note, isCurrent) {
  // 服务端 LibreOffice 转 PDF 的路线已整体弃用，公式一律走下面 wmf-view 的浏览器端渲染。
  await script(`${V}/jszip-3.10.2/jszip.min.js`);
  await script(`${V}/docx-preview-0.4.1/docx-preview.min.js`);
  const d = window.docx;
  if (!d || !d.renderAsync) throw new Error('docx-preview 没有正确加载');
  // MathType 公式是 w:object（OLE，预览图 WMF）：docx-preview 不认 w:object，
  // 也不画 WMF。wmf-view.js 重打包时把 w:object 改写成 w:pict、media/*.wmf 换成
  // PNG（内置的宽容 WMF 解释器）再渲染；没有公式的卷子零开销直通。
  try {
    const { repackDocxWithWmf } = await import('./wmf-view.js?v=20261112b');
    const repacked = await repackDocxWithWmf(blob);
    if (repacked) blob = repacked;
  } catch { /* 重打包失败用原件渲染，正文照常 */ }
  if (!isCurrent()) return;
  box.innerHTML = '<div class="t2-doc"></div>';
  const host = box.querySelector('.t2-doc');
  await d.renderAsync(blob, host, null, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    ignoreWidth: false,
    ignoreHeight: false,
    ignoreFonts: false,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    useBase64URL: true,
    experimental: true,
    ignoreLastRenderedPageBreak: true,
  });
  if (!isCurrent()) return;
  sanitize(host);
  fitWidth(host, host.querySelector('.docx-wrapper'));
  // 有些卷子正文是图片/文本框，docx-preview 渲染出来是空白页；给个提示比静默空白好
  const text = (host.textContent || '').trim();
  if (text.length < 20 && !host.querySelector('img')) {
    const p = document.createElement('p');
    p.style.cssText = 'margin:10px;color:var(--t2-muted, #685b47);font-size:12px';
    p.textContent = '这份 Word 里几乎没有可渲染的文字（可能是扫描图或文本框排版），建议下载后查看。';
    host.appendChild(p);
  }
  if (!host.querySelector('.docx-wrapper')) note('这份 Word 没有解析出内容，建议下载后查看。');
}

function fitWidth(host, inner) {
  if (!inner) return;
  disposeWord();
  // 按原始版心排版后再等比缩放，字距、换行和表格列宽保持一致。
  let previousWidth = 0;
  const fit = () => {
    const width = host.clientWidth;
    if (!width || width === previousWidth) return;
    previousWidth = width;
    inner.style.zoom = '1';
    inner.style.marginInline = '0';
    const bounds = inner.getBoundingClientRect();
    const contentRight = Array.from(inner.querySelectorAll('table, img, section.docx')).reduce(
      (right, element) => Math.max(right, element.getBoundingClientRect().right), bounds.right);
    const documentWidth = Math.ceil(Math.max(inner.scrollWidth, contentRight - bounds.left));
    const available = Math.floor(host.getBoundingClientRect().right - bounds.left);
    if (available > 1 && documentWidth > available) inner.style.zoom = String((available - 1) / documentWidth);
    else inner.style.marginInline = '';
  };
  fit();
  if ('ResizeObserver' in window) {
    wordResizeObserver = new ResizeObserver(fit);
    wordResizeObserver.observe(host);
  }
}

// ---------------------------------------------------------------- Excel / CSV（SheetJS）

async function sheet(box, blob, ext) {
  await script(`${V}/xlsx-0.20.3/xlsx.full.min.js`);
  const X = window.XLSX;
  if (!X) throw new Error('SheetJS 没有正确加载');
  const wb =
    ext === 'csv' || ext === 'tsv'
      ? X.read(await new TextDecoder('utf-8').decode(await blob.arrayBuffer()), { type: 'string', sheetRows: 2001, FS: ext === 'tsv' ? '\t' : undefined })
      : X.read(await blob.arrayBuffer(), { type: 'array', sheetRows: 2001 });
  box.innerHTML = `<div class="t2-sheet-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div><div class="t2-sheet"></div><p style="color:var(--v-sub);font-size:12px;margin:8px 0 0">每个工作表最多显示前 2000 行</p>`;
  const tabs = box.querySelector('.t2-sheet-tabs');
  const host = box.querySelector('.t2-sheet');
  const show = (i) => {
    // 先在惰性的 <template> 里净化，再进页面
    const t = document.createElement('template');
    t.innerHTML = X.utils.sheet_to_html(wb.Sheets[wb.SheetNames[i]], { header: '', footer: '' });
    sanitize(t.content);
    host.replaceChildren(t.content);
    tabs.querySelectorAll('button').forEach((b, j) => (b.style.background = i === j ? '#1e3a5f' : '#2f343b'));
  };
  wb.SheetNames.forEach((n, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 't2-btn';
    b.style.cssText = 'color:var(--v-fg);background:var(--v-btn);border:1px solid var(--v-btn-line)';
    b.textContent = n;
    b.onclick = () => show(i);
    tabs.appendChild(b);
  });
  if (wb.SheetNames.length < 2) tabs.hidden = true;
  show(0);
}

// ---------------------------------------------------------------- 文本

async function text(box, blob, ext) {
  const buf = await blob.arrayBuffer();
  let s;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    s = new TextDecoder('gb18030').decode(buf); // 国内老师的 txt 十有八九是 GBK
  }
  if (ext === 'csv' || ext === 'tsv') {
    // CSV 交给表格渲染器更友好；这里只是兜底
    return sheet(box, blob, ext);
  }
  box.innerHTML = '<pre class="t2-text"></pre>';
  box.querySelector('pre').textContent = s;
}

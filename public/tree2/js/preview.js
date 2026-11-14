// tree2/js/preview.js —— 客户端渲染：图片 / PDF / Word / Excel / PPT / 音频 / 文本。
//
// 和 XMUHub 的 web/assets/preview.js 同一套取舍：
//   * 四种文件类型四种渲染器，按需加载（首屏不带任何渲染库）；
//   * PDF 用 pdf.js，页面进入视野才画（1000 页的卷子也不会卡住）；
//   * Word 用 docx-preview（纯浏览器渲染 OOXML，不需要服务端转 PDF，卷子里的公式/表格原件保留）；
//   * 从文件内容里渲染出来的 HTML 一律过 sanitize()，再放进页面。

const V = 'vendor';
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
  const note = opts.note || ((html) => { box.innerHTML = `<div class="pad">${html}</div>`; });
  const ext = extOf(name);
  const kind = kindOf(name);
  try {
    if (kind === 'pdf') return await pdf(box, await toBlob(src), note);
    if (kind === 'image') return media(box, await toBlob(src), IMAGE[ext] || 'image/*', (u) => `<img class="t2-img" src="${u}" alt="">`);
    if (kind === 'audio') return audioPlayer(box, typeof src === 'string' ? src : URL.createObjectURL(await toBlob(src)), name);
    if (kind === 'docx') return await word(box, await toBlob(src), note);
    if (kind === 'sheet') return await sheet(box, await toBlob(src), ext);
    if (kind === 'text') return await text(box, await toBlob(src), ext);
    if (kind === 'slides') return note('PPT 暂不支持在线渲染，请下载后用 PowerPoint / WPS 打开。');
    if (kind === 'legacy-doc') return note('这是旧版 .doc 格式。转成 .docx 后即可在线预览，或直接下载用 Word / WPS 打开。');
    note(`浏览器无法直接渲染 .${ext || '?'}，请下载后打开。`);
  } catch (e) {
    const blob = src instanceof Blob ? src : null;
    const dl = blob ? `<p><a href="${URL.createObjectURL(blob)}" download="${name}">保存到本地</a></p>` : '';
    note(`预览失败：${escapeHtml(e && e.message ? e.message : String(e))}${dl}`);
  }
}

function toBlob(src) {
  return src instanceof Blob ? src : fetch(src).then((r) => r.blob());
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
function clock(sec) {
  if (!isFinite(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/**
 * 自绘播放器：封面 + 标题 + 进度（含缓冲）+ 播放键 + 音量。
 * 加载/缓冲时封面上盖一层转圈，避免"点了没反应"的错觉。
 * 封面是可选的：服务器 assets/pet.gif 存在就显示，不存在用 ♪ 占位。
 */
function audioPlayer(box, url, name) {
  box.innerHTML = `
    <div class="t2-player" data-loading="true">
      <div class="t2-pl-art">
        <span class="t2-pl-note" aria-hidden="true">♪</span>
        <img class="t2-pl-idle" alt="" hidden>
        <div class="t2-pl-loading" aria-hidden="true">
          <span class="t2-pl-spin"></span>
          <span>缓冲中…</span>
        </div>
      </div>
      <div class="t2-pl-panel">
        <div class="t2-pl-title"></div>
        <div class="t2-pl-sub"><span data-cur>00:00</span> / <span data-dur>--:--</span></div>
        <button class="t2-pl-seek" type="button" aria-label="拖动或点击调整进度">
          <span class="t2-pl-buf"></span><span class="t2-pl-fill"></span><span class="t2-pl-knob"></span>
        </button>
        <div class="t2-pl-ctl">
          <button class="t2-pl-play" type="button" aria-label="播放">▶</button>
          <span class="t2-pl-vol-ico" aria-hidden="true">🔊</span>
          <input class="t2-pl-vol" type="range" min="0" max="1" step="0.01" value="0.9" aria-label="音量">
          <button class="t2-pl-rate" type="button" aria-label="倍速">1x</button>
        </div>
      </div>
    </div>
    <audio class="t2-audio-el" preload="metadata"></audio>`;

  // 可选封面：往服务器 assets/ 放一个 pet.gif 就会自动显示（没有就保持 ♪ 占位，
  // 零流量——以前默认带的三个绝区零动图共 3.7 MB，已删）。
  const idleImg = box.querySelector('.t2-pl-idle');
  const petProbe = new Image();
  petProbe.onload = () => { idleImg.src = petProbe.src; idleImg.hidden = false; };
  petProbe.src = 'assets/pet.gif';

  const root = box.querySelector('.t2-player');
  const audio = box.querySelector('audio');
  const el = {
    play: box.querySelector('.t2-pl-play'),
    cur: box.querySelector('[data-cur]'),
    dur: box.querySelector('[data-dur]'),
    fill: box.querySelector('.t2-pl-fill'),
    buf: box.querySelector('.t2-pl-buf'),
    knob: box.querySelector('.t2-pl-knob'),
    seek: box.querySelector('.t2-pl-seek'),
    vol: box.querySelector('.t2-pl-vol'),
    rate: box.querySelector('.t2-pl-rate'),
  };
  box.querySelector('.t2-pl-title').textContent = name;

  // 倍速循环（听力练习刚需）：0.75 → 1 → 1.25 → 1.5 → 2 → 0.75，按资料记忆
  var RATES = [1, 1.25, 1.5, 2, 0.75];
  var rateIdx = 1;
  try {
    var saved = parseFloat(localStorage.getItem('t2.plrate') || '1');
    rateIdx = Math.max(0, RATES.indexOf(saved));
    if (rateIdx < 0) rateIdx = 1;
  } catch { rateIdx = 1; }
  var applyRate = function () {
    try { audio.playbackRate = RATES[rateIdx]; } catch { /* 部分内核不支持 */ }
    el.rate.textContent = RATES[rateIdx] + 'x';
    el.rate.title = '点按切换倍速';
  };
  applyRate();
  el.rate.onclick = function () {
    rateIdx = (rateIdx + 1) % RATES.length;
    try { localStorage.setItem('t2.plrate', String(RATES[rateIdx])); } catch {}
    applyRate();
  };
  audio.src = url;
  audio.volume = Number(el.vol.value);

  const loading = (on) => {
    root.dataset.loading = String(Boolean(on));
  };
  const pct = (v) => (isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
  const paintProgress = () => {
    const d = audio.duration || 0;
    const p = d ? audio.currentTime / d : 0;
    el.fill.style.width = `${pct(p) * 100}%`;
    el.knob.style.left = `${pct(p) * 100}%`;
    el.cur.textContent = clock(audio.currentTime);
    try {
      if (audio.buffered.length) el.buf.style.width = `${pct(audio.buffered.end(audio.buffered.length - 1) / (d || 1)) * 100}%`;
    } catch {
      /* buffered 偶尔取不到 */
    }
  };

  audio.addEventListener('loadstart', () => loading(true));
  audio.addEventListener('waiting', () => loading(true));
  audio.addEventListener('canplay', () => loading(false));
  audio.addEventListener('playing', () => loading(false));
  audio.addEventListener('loadedmetadata', () => {
    el.dur.textContent = clock(audio.duration);
    paintProgress();
  });
  audio.addEventListener('timeupdate', paintProgress);
  audio.addEventListener('progress', paintProgress);
  audio.addEventListener('play', () => {
    el.play.textContent = '❚❚';
    el.play.setAttribute('aria-label', '暂停');
    root.classList.add('is-playing');
  });
  audio.addEventListener('pause', () => {
    el.play.textContent = '▶';
    el.play.setAttribute('aria-label', '播放');
    root.classList.remove('is-playing');
  });
  audio.addEventListener('ended', () => {
    el.play.textContent = '▶';
    el.play.setAttribute('aria-label', '播放');
    root.classList.remove('is-playing');
    paintProgress();
  });
  audio.addEventListener('error', () => {
    loading(false);
    root.classList.add('is-error');
    const sub = box.querySelector('.t2-pl-sub');
    if (sub) sub.textContent = '音频加载失败，可以点右上角「下载」保存到本地听';
  });

  el.play.addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => loading(false));
    else audio.pause();
  });

  const seekTo = (clientX) => {
    const r = el.seek.getBoundingClientRect();
    if (!r.width || !isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * audio.duration;
    paintProgress();
  };
  let dragging = false;
  el.seek.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.seek.setPointerCapture?.(e.pointerId);
    seekTo(e.clientX);
  });
  el.seek.addEventListener('pointermove', (e) => {
    if (dragging) seekTo(e.clientX);
  });
  el.seek.addEventListener('pointerup', () => {
    dragging = false;
  });
  el.seek.addEventListener('pointercancel', () => {
    dragging = false;
  });

  el.vol.addEventListener('input', () => {
    audio.volume = Number(el.vol.value);
  });

  paintProgress();
}

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
  await script(`${V}/pdfjs-3.11.174/pdf.min.js`);
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('pdf.js 没有正确加载');
  const workerSrc = new URL(`${V}/pdfjs-3.11.174/pdf.worker.min.js`, location.href).href;
  lib.GlobalWorkerOptions.workerSrc = workerSrc;

  const data = await blob.arrayBuffer();
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
      // Worker 加载不了时（跨域/被 CSP 拦），主线程再试一次；大文件会慢一点，但能看
      workerBroken = true;
      lib.GlobalWorkerOptions.workerSrc = '';
      doc = await lib.getDocument({ ...base, disableWorker: true }).promise;
    }
  }

  box.innerHTML = '';
  const view = document.createElement('div');
  view.className = 't2-pdf';
  const meta = document.createElement('p');
  meta.style.cssText = 'color:#c9ced6;font-size:12px;margin:0 0 10px';
  meta.textContent = `共 ${doc.numPages} 页 · 滚动自动翻页`;
  view.appendChild(meta);
  box.appendChild(view);

  const first = await doc.getPage(1);
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

  let io = null;
  const drawPage = async (holder) => {
    if (holder.dataset.done) return;
    holder.dataset.done = '1';
    const page = await doc.getPage(Number(holder.dataset.n));
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
  } else {
    for (const p of pages.slice(0, 6)) await drawPage(p);
  }

  // 转屏 / 窗口变化 / 抽屉宽度变了：按新宽度重画，否则还是旧分辨率被拉伸
  let rzTimer;
  const onResize = () => {
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
  let ro = null;
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

  const cleanup = () => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    if (io) io.disconnect();
    if (ro) ro.disconnect();
    try { doc.destroy(); } catch { /* 已销毁/渲染中 */ }
  };
  // 渲染期间如果又开了别的 PDF / 关了抽屉（pdfSeq 已变），这次渲染的产物已被丢弃，别抢注清理回调
  if (seq === pdfSeq) pdfCleanup = cleanup;

  if (!pages.length) note('这个 PDF 没有页面。');
}

// ---------------------------------------------------------------- Word（docx-preview）

async function word(box, blob, note) {
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
  sanitize(host);
  fitWidth(host, host.querySelector('.docx-wrapper'));
  // 有些卷子正文是图片/文本框，docx-preview 渲染出来是空白页；给个提示比静默空白好
  const text = (host.textContent || '').trim();
  if (text.length < 20 && !host.querySelector('img')) {
    const p = document.createElement('p');
    p.style.cssText = 'margin:10px;color:#8a7f6e;font-size:12px';
    p.textContent = '这份 Word 里几乎没有可渲染的文字（可能是扫描图或文本框排版），建议下载后查看。';
    host.appendChild(p);
  }
  if (!host.querySelector('.docx-wrapper')) note('这份 Word 没有解析出内容，建议下载后查看。');
}

/** 固定宽度（A4）的页面在手机上会横向溢出：整体缩放到容器宽度。 */
function fitWidth(host, inner) {
  if (!inner) return;
  const fit = () => {
    inner.style.zoom = '';
    const need = inner.scrollWidth;
    const have = host.clientWidth;
    if (need > have && have > 0) inner.style.zoom = String(Math.max(0.3, have / need));
  };
  fit();
  const ro = 'ResizeObserver' in window ? new ResizeObserver(fit) : null;
  if (ro) ro.observe(host);
  else window.addEventListener('resize', fit);
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
  box.innerHTML = `<div class="t2-sheet-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div><div class="t2-sheet"></div><p style="color:#c9ced6;font-size:12px;margin:8px 0 0">每个工作表最多显示前 2000 行</p>`;
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
    b.style.cssText = 'color:#eee;background:#2f343b;border:1px solid #454b54';
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

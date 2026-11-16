// tree2/js/app.js —— 页面逻辑：届别 → 批次/目录 → 文件，搜索、筛选、路由、预览、上传。
//
// 几个刻意的设计：
//   * 目录树按需渲染：1328 个文件一次性铺开会卡，只渲染展开到的那一层；
//   * URL 是唯一状态源（?s=2026&p=<路径>&q=<搜索>&k=<扩展名>），刷新/分享/前进后退都成立；
//   * 在线状态来自 /api/tree2/storage：有真实字节的文件才能预览/下载，其余走网盘兜底。

// 版本号：改动这三个文件时同步递增，让浏览器一定拿到新的（见 index.html 里的 ?v=）。
import { listSeasons, loadSeason, storageState, fileUrl, fetchBytes, pref, apiBase, apiOriginLabel } from './api.js?v=20261115b';
import { kindOf, canRender, extOf, render, disposePdf, disposeWord } from './preview.js?v=20261116-word-layout';

const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------- 左栏 / p2 收起
// 左栏：参考 DevTools console 的抽屉，右下角按钮收起，再点屏幕左下角的按钮展开；记忆在 pref 里。
// p2：窄屏时搜索框下方的堆叠区（筛选+收藏+树），底部同款收起钮。
const shellEl = $('#shell');
const treeToggleBtn = $('#tree-toggle');
if (shellEl && treeToggleBtn) {
  const applyTree = () => shellEl.classList.toggle('tree-collapsed', pref.get('tree-collapsed', false) === true);
  applyTree();
  treeToggleBtn.onclick = () => {
    const next = !shellEl.classList.contains('tree-collapsed');
    shellEl.classList.toggle('tree-collapsed', next);
    pref.set('tree-collapsed', next);
  };
}
const p2ToggleBtn = $('#p2-toggle');
if (p2ToggleBtn) {
  // 这个钮只有一个语义：收起筛选/目录堆叠区，搜索框回到底部钉住的默认状态。
  // 点完按钮自己会随堆叠区一起消失；想再展开就点底部的搜索框（原有交互）。
  p2ToggleBtn.onclick = () => {
    document.body.classList.remove('search-undocked');
    pref.set('p2-collapsed', false);
    exitMobileSearch();
  };
}

const state = {
  seasons: [],
  season: null, // 当前届的元数据（seasons.json 里的一条）
  manifest: null, // 当前届的完整清单
  storage: { keys: new Set(), enabled: false, source: 'none' },
  query: { s: '2026', p: '', q: '', k: '', fav: '' },
  open: new Set(), // 展开中的目录路径
  sort: pref.get('sort', 'date') === 'tree' ? 'date' : pref.get('sort', 'date'), // date | name | size
  filters: { stage: pref.get('stage', ''), kind: pref.get('kind', '') },
};

// ---------------------------------------------------------------- 工具

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);

export function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const KIND_LABEL = { pdf: 'PDF', docx: 'Word', sheet: 'Excel', slides: 'PPT', image: '图片', audio: '音频', text: '文本', archive: '压缩包', 'legacy-doc': '旧版Word', 'legacy-ppt': '旧版PPT', other: '文件' };
/** 类型的中文名，用在文件行副标题和预览抽屉标题上。 */
const kindLabel = (k) => KIND_LABEL[k] || '文件';
/**
 * 类型徽章上的短标签。
 * extOf() 返回的是**不带点**的扩展名（'docx' / 'pdf' / 'mp3'），所以这里不能再 slice(1)——
 * 那样会把首字母吃掉，docx 变 ocx、pdf 变 df、mp3 变 p3。
 * 太长的扩展名（如 'webmanifest'）截到 4 个字符，保证徽章宽度稳定。
 */
const extBadge = (name) => {
  const e = extOf(name);
  return (e ? e.slice(0, 4) : '?').toUpperCase();
};

/**
 * 文件列表左侧的类型图标（SVG）：一张带折角的“纸”，下半压一条色带写扩展名，
 * 上半画一个跟随类型的小图形（音频=音符、图片=山、其余=正文行）。
 * 颜色沿用旧文字徽章的配色（.t2-file-ico[data-k] 那套），视觉上无缝替换。
 */
const ICON_COLORS = {
  pdf: { main: '#b5311d', tint: '#fdece9' },
  docx: { main: '#1f4fbf', tint: '#e8f0fe' },
  'legacy-doc': { main: '#1f4fbf', tint: '#e8f0fe' },
  sheet: { main: '#15803d', tint: '#e7f7ef' },
  slides: { main: '#d97706', tint: '#fef3e2' },
  'legacy-ppt': { main: '#d97706', tint: '#fef3e2' },
  image: { main: '#18794e', tint: '#e7f7ef' },
  audio: { main: '#a8620a', tint: '#fff4de' },
  text: { main: '#64748b', tint: '#eef2f6' },
  archive: { main: '#7c5cd6', tint: '#f0ebfc' },
  other: { main: '#8a7f6e', tint: '#f6efe2' },
};
/* 暗色下的配色：纸面用带类型色相的深色，主色提亮一档，避免亮色块在暗底上扎眼 */
const ICON_COLORS_DARK = {
  pdf: { main: '#d08a76', tint: '#33231f' },
  docx: { main: '#7f9fdc', tint: '#1f2637' },
  'legacy-doc': { main: '#7f9fdc', tint: '#1f2637' },
  sheet: { main: '#5cb98a', tint: '#1c2f26' },
  slides: { main: '#dca04d', tint: '#332a1a' },
  'legacy-ppt': { main: '#dca04d', tint: '#332a1a' },
  image: { main: '#5cb98a', tint: '#1c2f26' },
  audio: { main: '#d9a55e', tint: '#332a17' },
  text: { main: '#8fa1b5', tint: '#232930' },
  archive: { main: '#a48ee0', tint: '#25202f' },
  other: { main: '#a99e8d', tint: '#26231e' },
};
/* 页面主体的路径，折角在右上（28,4 → 34,10）。 */
const ICON_PAGE_D = 'M12 4h16l6 6v28a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z';
const iconGlyph = (k) => {
  if (k === 'audio')
    return `<circle cx="16.8" cy="18.8" r="2.3" style="fill:var(--fim)" opacity=".5"/><path d="M19.1 18.8V11l5-1.2v4.4" fill="none" style="stroke:var(--fim)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/>`;
  if (k === 'image')
    return `<rect x="13.5" y="11.5" width="15" height="10.5" rx="1.5" fill="none" style="stroke:var(--fim)" stroke-width="1.6" opacity=".5"/><circle cx="17.4" cy="14.8" r="1.3" style="fill:var(--fim)" opacity=".5"/><path d="M14.8 20.4l3.8-3.8 2.8 2.8 2-2 2.8 3" fill="none" style="stroke:var(--fim)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/>`;
  return `<path d="M14.5 15h13M14.5 19h8.5" fill="none" style="stroke:var(--fim)" stroke-width="2" stroke-linecap="round" opacity=".4"/>`;
};
const fileIconSvg = (name, k) => {
  const c = ICON_COLORS[k] || ICON_COLORS.other;
  const d = ICON_COLORS_DARK[k] || ICON_COLORS_DARK.other;
  // 亮暗两套配色都写进 CSS 变量，主题切换由 CSS 换变量完成（能跟着 theme-anim 一起过渡）
  return `<svg viewBox="0 0 44 44" aria-hidden="true" style="--fim:${c.main};--fit:${c.tint};--fimd:${d.main};--fitd:${d.tint}"><path d="${ICON_PAGE_D}" style="fill:var(--fit);stroke:var(--fim)" stroke-width="1.5"/><path d="M28 4l6 6h-4a2 2 0 0 1-2-2z" style="fill:var(--fim)" opacity=".28"/>${iconGlyph(k)}<rect x="8" y="26.5" width="26" height="8" rx="2" style="fill:var(--fim)"/><text x="21" y="30.5" text-anchor="middle" dominant-baseline="central" font-size="6" font-weight="800" letter-spacing=".5" fill="#fff">${esc(extBadge(name))}</text></svg>`;
};
export { kindOf };

function toast(msg, bad = false) {
  let el = $('#t2-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 't2-toast';
    el.className = 't2-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.dataset.bad = String(bad);
  el.dataset.on = 'true';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.dataset.on = 'false'), bad ? 4200 : 2200);
}

function seg(path) {
  // 路径在 URL 与清单里都用 "/" 分隔的相对路径（空 = 届根）
  return path ? path.split('/').filter(Boolean) : [];
}
const joinPath = (a, b) => (a ? `${a}/${b}` : b);
const parentOf = (p) => seg(p).slice(0, -1).join('/');

/** 阶段是虚拟层：路径写成 stage:A，批次本身仍是 A1福州一检…（旧链接不受影响）。 */
const STAGE = 'stage:';
const isStage = (p) => typeof p === 'string' && p.startsWith(STAGE);
const stageKey = (p) => p.slice(STAGE.length);
const stagePath = (s) => `${STAGE}${s}`;

/** 一个阶段的虚拟节点：子节点就是该阶段的批次。 */
function stageNode(s) {
  const meta = (state.manifest && state.manifest.stages && state.manifest.stages[s]) || { name: s };
  const batches = (state.manifest ? state.manifest.batches : []).filter((b) => b.stage === s);
  return {
    n: `${s} · ${meta.name || ''}`.trim(),
    t: 'd',
    stage: s,
    note: meta.note || '',
    c: batches.map((b) => b.tree),
  };
}

const batchByName = (name) => (state.manifest ? state.manifest.batches.find((b) => b.name === name) : null);

/** 按路径找到节点：支持 stage:A、批次名、批次/子目录… */
function nodeAt(path) {
  if (!state.manifest) return null;
  if (!path) return rootOf();
  if (isStage(path)) {
    const s = stageKey(path);
    const has = (state.manifest.stages && state.manifest.stages[s]) || state.manifest.batches.some((b) => b.stage === s);
    return has ? stageNode(s) : null;
  }
  const parts = seg(path);
  const batch = batchByName(parts[0]);
  if (!batch) return null;
  let node = batch.tree;
  for (const s of parts.slice(1)) {
    if (!node || node.t !== 'd') return null;
    node = (node.c || []).find((c) => c.t === 'd' && c.n === s);
  }
  return node || null;
}

/** 上一级：子目录 → 批次 → 阶段 → 首页。 */
function parentPath(p) {
  if (!p) return '';
  if (isStage(p)) return '';
  const parts = seg(p);
  if (parts.length > 1) return parts.slice(0, -1).join('/');
  const b = batchByName(parts[0]);
  return b ? stagePath(b.stage) : '';
}

/** 面包屑：每一层都带可点的路径。 */
function crumbTrail(p) {
  const out = [];
  if (!p) return out;
  if (isStage(p)) {
    const s = stageKey(p);
    out.push({ label: `${s} 阶段`, path: stagePath(s) });
    return out;
  }
  const parts = seg(p);
  const b = batchByName(parts[0]);
  if (b) out.push({ label: `${b.stage} 阶段`, path: stagePath(b.stage) });
  parts.forEach((name, i) => out.push({ label: name, path: parts.slice(0, i + 1).join('/') }));
  return out;
}

/** 子节点路径：阶段的子节点是批次（用批次名），其余按目录层级拼。 */
const childPath = (parent, child) => (isStage(parent) ? child.n : joinPath(parent, child.n));

/** 目录/文件是否符合当前搜索与类型筛选；返回 null 表示被过滤掉，否则返回命中计数。 */
function matchNode(node, q, kind, pathPy) {
  // here = 批次/上级目录 + 当前节点 的拼音首字母串（清单里的 p 字段）
  const here = pathPy + (node.p || '');
  if (node.t === 'f') {
    if (kind && node.e !== `.${kind}` && kindOf(node.n) !== kind) return null;
    // 命中规则：文件名包含，或「路径+文件」拼音首字母包含（fzyj ← A2福州一检 里的文件）
    if (q && !node.n.toLowerCase().includes(q) && !here.includes(q)) return null;
    return { node, files: 1, bytes: node.s || 0 };
  }
  const hits = [];
  let bytes = 0;
  for (const c of node.c) {
    const m = matchNode(c, q, kind, here);
    if (m) {
      hits.push(m);
      bytes += m.bytes;
    }
  }
  if (!hits.length) return null;
  return { node, hits, files: hits.reduce((n, h) => n + h.files, 0), bytes };
}

/** 把目录子树拍平成 [{file, path}]，用于"只看这一类"的搜索/筛选结果。 */
function flatten(node, base) {
  const out = [];
  const walk = (n, p) => {
    for (const c of n.c) {
      if (c.t === 'd') walk(c, joinPath(p, c.n));
      else out.push({ file: c, path: p });
    }
  };
  walk(node, base);
  return out;
}

const isOnline = (f) => Boolean(f && f.k && state.storage.keys.has(f.k));

// ---------------------------------------------------------------- 路由

/** 从 hash 里取路径；hash 里可能有裸 %（文件名带的），解码失败就当没给，别让整页崩掉。 */
function hashPath() {
  const raw = location.hash.replace(/^#\/?/, '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/**
 * @param {boolean} restore  true = 恢复路径（前进后退用）；false = 只认届别（首次加载用）
 *
 * 刷新一律回首页：不恢复 p/q/k。详情页、批次页的地址是给"前进后退"和分享用的，
 * 但刷新时很容易踩空——旧链接、改过名的文件、路径里的特殊字符、被截断的 hash，
 * 任何一个都会让页面落在一个找不到的路径上然后报错。刷新回首页永远不会错。
 * 前进后退则必须恢复，否则后退键会变成"回首页"，那是另一回事。
 */
function readUrl(restore = false) {
  const u = new URLSearchParams(location.search);
  state.query = {
    // 没有明确 ?s= 时先空着，boot 里等届别列表拿到后选「最新一届」或上次浏览的届
    s: u.get('s') || pref.get('season', ''),
    p: restore ? u.get('p') ?? hashPath() : '',
    q: restore ? u.get('q') || '' : '',
    k: restore ? u.get('k') || '' : '',
    fav: restore ? u.get('fav') || '' : '',
    f: restore ? u.get('f') || '' : '',
  };
}

function writeUrl(push = true) {
  const u = new URLSearchParams();
  const { s, p, q, k, fav } = state.query;
  u.set('s', s);
  if (p) u.set('p', p);
  if (q) u.set('q', q);
  if (k) u.set('k', k);
  if (fav) u.set('fav', fav);
  // 数据服务地址必须跟着 URL 走：只存在 localStorage 里的话，一旦记忆丢失
  // （隐私模式、换端口、清了站点数据）页面就会静默退回同源，所有请求一起失败。
  const api = apiBase();
  if (api) u.set('api', api);
  const url = `${location.pathname}?${u}${p ? `#/${encodeURI(p)}` : ''}`;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

function go(patch, push = true) {
  Object.assign(state.query, patch);
  // 跳去浏览内容时自动退出收藏视图（除非本次明确要的是收藏）
  if (patch.fav === undefined && patch.p !== undefined) state.query.fav = '';
  if (patch.p !== undefined) state.query.p = patch.p;
  pref.set('season', state.query.s);
  writeUrl(push);
  renderAll();
  // 手机上选定了目录就退出搜索态：搜索框落回页面底部，目录树收起，让位给文件列表
  if (state.query.p) exitMobileSearch();
}

// ---------------------------------------------------------------- 启动

const KIND_CHIPS = [
  ['', '全部'],
  ['pdf', 'PDF'],
  ['docx', 'Word'],
  ['sheet', 'Excel'],
  ['slides', 'PPT'],
  ['image', '图片'],
  ['audio', '音频'],
  ['text', '文本'],
];

// ---------------- 手机端搜索：待机钉在页面底部，点开升到简介下面并展开目录树 ----------------
// 桌面端照旧放顶栏。挪的是同一个 DOM 节点，#q 上的监听器不会丢。
const mqPhone = window.matchMedia('(max-width: 900px)');
const isSearching = () => document.body.classList.contains('t2-searching');
// 归位模式（p2 收起）：窄屏下搜索框回顶栏，不钉底、不搬来搬去；记忆在 pref 的 p2-collapsed 里
const isUndocked = () => document.body.classList.contains('search-undocked');

/** 把搜索框安置到指定宿主：head(桌面) / main(手机待机) / side(手机搜索中) */
function placeSearch(where) {
  const form = $('#search-form');
  const main = $('.t2-main');
  const side = document.querySelector('.t2-side');
  const head = document.querySelector('.t2-top');
  if (!form || !main || !side || !head) return null;
  form.classList.toggle('t2-search-hero', Boolean(mqPhone.matches) && !isUndocked());
  const host = !mqPhone.matches || isUndocked() ? head : where === 'side' ? side : main;
  if (form.parentElement !== host) {
    if (host === head) {
      // 顶栏：插到亮暗切换键之前——亮暗键永远贴最右上角。之前锚点写的 #p2-toggle
      // 在侧栏里，head 里永远找不到，appendChild 会把搜索框排到亮暗键右边。
      const anchor = head.querySelector('#theme-toggle');
      if (anchor) head.insertBefore(form, anchor);
      else host.appendChild(form);
    } else {
      host.insertBefore(form, host.firstChild);
    }
  }
  return form;
}

/** FLIP：位置突变后补一段 transform 过渡，看起来是"平滑移动"。 */
function flipMove(form, before, after) {
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  if (!dx && !dy) return;
  form.style.transition = 'none';
  form.style.transform = `translate(${dx}px, ${dy}px)`;
  requestAnimationFrame(() => {
    form.style.transition = 'transform .32s cubic-bezier(.2, .8, .2, 1)';
    form.style.transform = '';
    // 动画结束把内联 transition 摘掉：一直挂在 fixed 元素上会让它常驻合成层，
    // 滚动时留下过期图层碎片——就是搜索框上下的"虚影"。
    setTimeout(() => {
      form.style.transition = '';
      form.style.transform = '';
    }, 340);
  });
}

function enterMobileSearch() {
  if (!mqPhone.matches || isSearching()) return;
  if (isUndocked()) {
    // 归位模式：搜索框已经在顶栏，只需让筛选/目录堆叠区在下方出现
    document.body.classList.add('t2-searching');
    return;
  }
  const form = $('#search-form');
  if (!form) return;
  const q = $('#q');
  const before = form.getBoundingClientRect();
  document.body.classList.add('t2-searching');
  // 用过一次就不必再提示：不然每次回到底部都冒出来，很吵
  form.classList.add('t2-search-hint-off');
  pref.set('searchHintSeen', true);
  placeSearch('side');
  flipMove(form, before, form.getBoundingClientRect());
  // DOM 换父节点会让输入框丢焦点（手机键盘跟着收起），这里补回来
  if (q) {
    try {
      q.focus({ preventScroll: true });
    } catch {
      q.focus();
    }
  }
  const tree = $('#tree');
  if (tree && tree.scrollTop) tree.scrollTop = 0;
}

function exitMobileSearch() {
  if (!isSearching()) return;
  const form = $('#search-form');
  const before = form ? form.getBoundingClientRect() : null;
  document.body.classList.remove('t2-searching');
  placeSearch('bottom');
  if (form && before) flipMove(form, before, form.getBoundingClientRect());
  $('#q')?.blur();
}

mqPhone.addEventListener?.('change', () => {
  document.body.classList.remove('t2-searching');
  placeSearch('bottom');
});

function renderKindChips() {
  const box = $('#kind-chips');
  if (!box) return;
  box.innerHTML = KIND_CHIPS.map(([k, label]) => `<button class="t2-chip" type="button" data-k="${k}" aria-pressed="${state.query.k === k}">${label}</button>`).join('');
  box.onclick = (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    go({ k: b.dataset.k === state.query.k ? '' : b.dataset.k });
    renderKindChips();
  };
}

async function boot() {
  // 先把数据服务地址定下来（把 ?api= 记进 localStorage），再解析路由、再发第一个请求。
  // 顺序错了会拿同源地址去要数据，整页直接"连不上"。
  apiBase();
  readUrl(new URLSearchParams(location.search).has('f'));
  placeSearch('bottom');
  if (pref.get('searchHintSeen', false)) $('#search-form')?.classList.add('t2-search-hint-off');
  try {
    renderKindChips();
    state.seasons = await listSeasons();
    wire();
    // 地址里带了具体届（或上次浏览过）→ 直接进那一届的资料库；
    // 什么都没有 → 站点主页（像老 tree 的 index：品牌 + 届别卡片）
    if (state.query.s && state.seasons.some((s) => String(s.id) === state.query.s)) {
      await openSeason(state.query.s);
      renderSeasons();
      renderAll();
      if (!restoreViewer()) writeUrl(false);
      pref.set('season', state.query.s);
    } else {
      enterSiteHome();
    }
  } catch (e) {
    // 启动任何一步失败都要说出来，不能留下"左上角有树、右边一片空白"的半死状态
    console.error('[tree2] 启动失败', e);
    showFatal(`${e && e.message ? e.message : e}`);
  }
}

/** 站点主页：选一届进资料库（仿老 tree 的 index.html）。 */
function enterSiteHome() {
  state.query.s = '';
  state.manifest = null;
  document.body.classList.add('t2-site-home');
  $('#shell')?.classList.add('no-tree');
  $('#search-form')?.classList.add('t2-search-site-home');
  renderSeasons();
  renderSiteHome();
}

function leaveSiteHome() {
  document.body.classList.remove('t2-site-home');
  $('#shell')?.classList.remove('no-tree');
  $('#search-form')?.classList.remove('t2-search-site-home');
}

function renderSiteHome() {
  const main = $('#page');
  if (!main) return;
  const cards = state.seasons
    .map(
      (s) => `
      <a class="t2-year-card" href="/?s=${esc(s.id)}" data-s="${esc(s.id)}">
        <div class="t2-year-top"><span>备考资料</span><span aria-hidden="true">↗</span></div>
        <h3>${esc(String(s.id))}<small>届</small></h3>
        <p>${esc(s.subtitle || `${s.files || 0} 个文件 · ${fmtSize(s.bytes || 0)}`)}</p>
        <span class="t2-year-go">查看资料目录 →</span>
      </a>`,
    )
    .join('');
  const last = pref.get('season', '');
  const lastSeason = state.seasons.find((s) => String(s.id) === String(last));
  main.innerHTML = `
    <section class="t2-site-hero">
      <div class="t2-kicker">福建高考 · 备考资料库</div>
      <h1 class="t2-title">少一点找题，<br>多一点<em>安心备考。</em></h1>
      <p class="t2-deck">把省内各届备考资料整理在一起：原卷、答案、听力与解析，<br>按考试批次归档，选好届别一站直达。</p>
      ${lastSeason ? `<a class="t2-btn primary" style="display:inline-flex;align-items:center;height:40px;padding:0 18px;border-radius:999px;text-decoration:none" href="/?s=${esc(lastSeason.id)}">继续浏览 ${esc(lastSeason.id)} 届 →</a>` : ''}
    </section>
    <section class="t2-site-years">
      <h3 style="font-family:var(--serif);margin:0 0 12px">从你的届别开始</h3>
      <div class="t2-year-grid">${cards}</div>
      <p class="t2-deck" style="margin-top:16px;font-size:12.5px">进入后可以用顶部的届别切换随时互跳；文件页的「分享」按钮能拿到直达短链。</p>
    </section>`;
  main.querySelectorAll('[data-s]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      switchSeason(a.dataset.s);
    }),
  );
}

async function openSeason(id) {
  state.query.s = String(id);
  state.season = state.seasons.find((s) => String(s.id) === String(id)) || { id: String(id), title: `${id} 届` };
  try {
    state.manifest = await loadSeason(state.query.s);
  } catch (e) {
    state.manifest = null;
    // 往上抛，让 boot() 统一处理——否则后面 renderSeasons/renderAll 会在没有清单的状态下空跑
    throw new Error(`这一届的清单还没生成：${e.message}`);
  }
  state.storage = await storageState(state.query.s);
  // 只展开 URL 里指定的那层；不再默认展开第一个批次——
  // A1 一旦自动展开就会铺开三十多个文件，后面的批次全被挤到屏幕外。
  state.open = new Set(state.query.p ? [state.query.p] : []);
}

function showFatal(msg) {
  const body = $('#page');
  if (!body) return;
  const here = location.origin;
  const api = apiOriginLabel();
  // 报错要能照着修：多数情况是数据服务地址没指对，或者那台机器上的服务没起来。
  const hint = api === here
    ? `页面正在向自己的域名（${here}）要数据，但那里没有资料服务。`
    : `页面正在向 ${api} 要数据。`;
  body.innerHTML = `<section class="t2-hero">
    <div class="t2-kicker">出错了</div>
    <h2 class="t2-title">打不开资料清单</h2>
    <p class="t2-deck">${esc(msg)}</p>
    <p class="t2-deck">${esc(hint)}</p>
    <div class="t2-fatal-actions">
      <a class="t2-btn" href="${esc(`${here}${location.pathname}?api=${here}#/`)}">数据服务就在这台机器上 → 指回本机</a>
      <a class="t2-btn" href="${esc(`${here}${location.pathname}?api=reset#/`)}">清除地址记忆</a>
      <button class="t2-btn" type="button" onclick="location.reload()">重试</button>
    </div>
    <p class="t2-deck t2-fatal-tip">本地调试的话，先确认文件服务在跑：<code>node scripts/tree2-files-server.mjs --port 8787</code></p>
  </section>`;
}

/** 顶栏届别切换。 */
function renderSeasons() {
  const box = $('#seasons');
  if (!box) return;
  box.innerHTML = state.seasons
    .map((s) => `<button class="t2-season" type="button" data-s="${esc(s.id)}" aria-current="${String(s.id) === state.query.s}">${esc(s.title)}</button>`)
    .join('');
  box.onclick = (e) => {
    const b = e.target.closest('[data-s]');
    if (b) switchSeason(b.dataset.s);
  };
}

async function switchSeason(id) {
  if (String(id) === state.query.s) return;
  state.open = new Set();
  leaveSiteHome();
  try {
    await openSeason(id);
  } catch (e) {
    // 服务重启/网络抖动时给句话，别静默得像按钮坏了
    toast(`切换到 ${id} 届失败：${e.message || e}`, true);
    return;
  }
  state.query.p = '';
  writeUrl(false);
  renderAll();
}

// ---------------------------------------------------------------- 左侧目录树

function renderTree() {
  const host = $('#tree');
  if (!state.manifest) {
    host.innerHTML = '';
    return;
  }
  // 整棵树每点一次都会重建，记住滚动位置，否则点中一个靠下的批次会跳回顶部，
  // 看起来像"点了没反应"。
  const keepScroll = host.scrollTop;
  const q = state.query.q.trim().toLowerCase();
  const kind = state.query.k;
  host.innerHTML = '';
  const list = document.createElement('div');
  const needFilter = Boolean(q || kind);
  if (needFilter) {
    // 搜索时摊平到"批次"这一层，命中列表更直观（不再套阶段）
    for (const b of state.manifest.batches) {
      const m = matchNode(b.tree, q, kind);
      if (!m) continue;
      list.appendChild(renderNode(b.tree, b.tree.n, 1, m.files, true));
    }
  } else {
    // 默认按阶段分组：A / B / C … 每个阶段下挂它的批次
    const stages = [...new Set(state.manifest.batches.map((b) => b.stage))];
    for (const s of stages) {
      const sn = stageNode(s);
      list.appendChild(renderNode(sn, stagePath(s), 1, countFiles(sn), false));
    }
  }
  if (!list.children.length) list.innerHTML = `<div class="t2-empty">没有匹配的文件${q ? `：「${esc(state.query.q)}」` : ''}</div>`;
  host.appendChild(list);
  if (keepScroll) host.scrollTop = keepScroll;

  // 搜索时自动展开命中目录，否则展开状态里的项
  if (needFilter) {
    list.querySelectorAll('[data-dir]').forEach((n) => {
      if (n.closest('.t2-children[hidden]')) n.parentElement.hidden = false;
    });
  }
}

function countFiles(node) {
  return node.c.reduce((n, c) => n + (c.t === 'f' ? 1 : countFiles(c)), 0);
}

/**
 * 手机上第一次点击常被"收起键盘"吞掉（click 不触发），所以用 pointerup 兜底；
 * 桌面端仍走 click。移动超过 12px 视为滑动，不当作点击。
 *
 * pointerup 里 go() 会同步重建 DOM，随后浏览器合成的 click 会落在**新节点**上
 * （比如批次页换成了文件列表，就正好点开第一张卷子）。所以抬手后短暂设个护栏，
 * 在捕获阶段把这次合成的 click 吃掉，避免"点批次又连带点开文件"。
 */
let tapGuardUntil = 0;
document.addEventListener(
  'click',
  (e) => {
    if (Date.now() >= tapGuardUntil) return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

function bindTap(el, fn) {
  el.addEventListener('click', (e) => {
    if (!mqPhone.matches) fn(e);
  });
  if (!mqPhone.matches) return;
  let sx = 0;
  let sy = 0;
  let armed = false;
  el.addEventListener('pointerdown', (e) => {
    sx = e.clientX;
    sy = e.clientY;
    armed = true;
  });
  el.addEventListener('pointercancel', () => {
    armed = false;
  });
  el.addEventListener('pointerup', (e) => {
    if (!armed) return;
    armed = false;
    if (Math.abs(e.clientX - sx) > 12 || Math.abs(e.clientY - sy) > 12) return;
    // 点到里面的按钮/链接就交给它们自己处理，别顺带触发整行
    const ctrl = e.target.closest('button, a, input, select, textarea');
    if (ctrl && ctrl !== el) return;
    e.preventDefault();
    tapGuardUntil = Date.now() + 350;
    fn(e);
  });
}

function renderNode(node, path, depth, count, needFilter) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 't2-node';
  row.dataset.active = String(path === state.query.p);
  const open = state.open.has(path);

  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 't2-caret';
  caret.setAttribute('aria-label', open ? '折叠' : '展开');
  caret.setAttribute('aria-expanded', String(open));
  caret.textContent = '▶';

  const label = document.createElement('button');
  label.type = 'button';
  label.className = 't2-label';
  label.dir = true; // 让浏览器自己按中文字宽处理省略
  if (node.t === 'd') {
    label.innerHTML = `<span class="t2-name" title="${esc(path)}">${esc(node.n)}</span><span class="t2-count">${count}</span>`;
  } else {
    const k = kindOf(node.n);
    label.innerHTML = `<span class="t2-kind" data-k="${esc(k)}">${esc(extBadge(node.n))}</span><span class="t2-name" title="${esc(node.n)}">${esc(node.n)}</span><span class="t2-count">${fmtSize(node.s)}</span>`;
  }
  row.append(caret, label);
  wrap.appendChild(row);

  if (node.t === 'd') {
    row.dataset.dir = path;
    // 搜索时命中的目录会被强制展开，箭头要跟着实际状态走，否则指着一个已经展开的目录说"折叠"
    row.dataset.open = String(open || needFilter);
    // 搜索态也允许手动折叠：只改本地 DOM，不写 state.open（那是临时视图）
    caret.addEventListener('click', (e) => {
      e.stopPropagation();
      if (needFilter) {
        kids.hidden = !kids.hidden;
        row.dataset.open = String(!kids.hidden);
        if (!kids.hidden) build();
      } else {
        toggleDir(path);
      }
    });
    const kids = document.createElement('div');
    kids.className = 't2-children';
    kids.hidden = !(open || needFilter);
    // 懒渲染：展开时才铺子节点
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      const q = state.query.q.trim().toLowerCase();
      const kind = state.query.k;
      for (const c of node.c) {
        const m = needFilter ? matchNode(c, q, kind) : { files: c.t === 'd' ? countFiles(c) : 1 };
        if (!m) continue;
        kids.appendChild(c.t === 'd' ? renderNode(c, childPath(path, c), depth + 1, m.files, needFilter) : renderFileNode(c, path));
      }
    };
    if (!kids.hidden) build();
    bindTap(label, () => {
      // 搜索状态下点目录不写 state.open：那是临时视图，退出搜索要还原成快照。
      if (!needFilter) state.open.add(path); // 点目录 = 选中 + 自动展开一层
      // go() 会重建整棵树（新节点自带正确的展开状态和监听器），
      // 所以这里不能再手动改 kids/row —— 那两个节点马上就要被丢掉了。
      go({ p: path });
    });
    if (!needFilter && !kids.hidden) build();
    wrap.appendChild(kids);
  } else bindTap(label, () => go({ p: path }));

  return wrap;
}

function renderFileNode(f, parent) {
  const row = document.createElement('div');
  row.className = 't2-node';
  const path = joinPath(parent, f.n);
  row.dataset.active = String(path === state.query.p);
  const k = kindOf(f.n);
  row.innerHTML = `<button class="t2-caret" type="button" tabindex="-1"></button><button class="t2-label" type="button"><span class="t2-kind" data-k="${esc(k)}">${esc(extBadge(f.n))}</span><span class="t2-name" title="${esc(f.n)}">${esc(f.n)}</span>${isOnline(f) ? '<span class="t2-dot" title="已入库，可在线预览"></span>' : ''}</button>`;
  bindTap(row.querySelector('.t2-label'), () => openFile(parent, f));
  return row;
}

/**
 * 点左树里的文件：能预览就直接开预览，不能预览就给一句说明。
 * 同时把 URL 指到这个文件，刷新/分享能落回同一处。
 */
function openFile(parent, f) {
  const path = joinPath(parent, f.n);
  go({ p: path }, false);
  if (isOnline(f) && canRender(f.n)) {
    openViewer(f, parent);
  } else if (!isOnline(f)) {
    toast('这份还没入库，暂时只能看到名字');
  } else {
    toast('这种格式不支持在线预览，可以点下载');
  }
}

function toggleDir(path) {
  if (state.open.has(path)) state.open.delete(path);
  else state.open.add(path);
  renderTree();
}

// ---------------------------------------------------------------- 右侧

function renderMain() {
  const main = $('#page');
  if (!state.manifest) {
    // 没有清单时不要静默返回，否则右侧一片空白，看起来像"点了没反应"。
    // 这里能走到通常是 boot() 已经 showFatal 过了，别把提示覆盖掉。
    if (!main.innerHTML.trim()) showFatal('资料清单还没加载出来');
    return;
  }
  const path = state.query.p;
  // 搜索态：右侧整页切换成跨批次的全局结果（左树照旧显示命中的批次/文件）
  if (state.query.q) return renderSearchResults(main);
  if (state.query.fav) return renderFavorites(main);
  if (!path) return renderHome(main);
  if (isStage(path)) {
    const node = nodeAt(path);
    if (!node) return renderHome(main);
    return renderStage(main, path, node);
  }

  const node = nodeAt(path);
  if (node && node.t === 'f') {
    // 直接定位到某个文件（分享链接常见）
    const parent = parentOf(path);
    return renderFolder(main, parent, parent ? nodeAt(parent) : rootOf(), path);
  }
  if (!node) {
    const parent = parentPath(path);
    if (isStage(parent)) return renderStage(main, parent, nodeAt(parent));
    return renderFolder(main, parent, parent ? nodeAt(parent) : rootOf(), '');
  }
  return renderFolder(main, path, node, '');
}

function rootOf() {
  return { n: state.manifest.title, t: 'd', c: state.manifest.batches.map((b) => b.tree) };
}

/** 阶段汇总页：A / B / C … 列出该阶段下所有批次。 */
function renderStage(main, path, node) {
  const s = stageKey(path);
  const meta = (state.manifest.stages && state.manifest.stages[s]) || { name: s };
  const batches = state.manifest.batches.filter((b) => b.stage === s);
  const files = batches.reduce((n, b) => n + (b.files || 0), 0);
  const bytes = batches.reduce((n, b) => n + (b.bytes || 0), 0);
  const trail = crumbTrail(path);

  main.innerHTML = `
    <section class="t2-hero">
      <div class="t2-kicker">
        <a href="#" data-crumb="">${esc(state.manifest.title)}</a>${trail.map((c) => ` / <a href="#" data-crumb="${esc(c.path)}">${esc(c.label)}</a>`).join('')}
      </div>
      <h1 class="t2-title">${esc(s)} · ${esc(meta.name || '')} <em>${batches.length}</em></h1>
      <p class="t2-deck">${batches.length} 场考试 · ${files} 条资料 · ${fmtSize(bytes)}${meta.note ? ` · ${esc(meta.note)}` : ''}</p>
    </section>
    <div class="t2-bar">
      <button class="t2-btn" type="button" data-act="crumb" data-to="">↑ 上一级（${esc(state.manifest.title)}）</button>
      <span class="t2-grow"></span>
      <span class="t2-deck" style="font-size:12.5px">点批次进入文件列表</span>
    </div>
    <ul class="t2-batches"></ul>`;

  const ul = main.querySelector('.t2-batches');
  for (const b of batches) {
    const li = document.createElement('li');
    li.className = 't2-batch';
    const online = (b.tree.c || []).filter((c) => c.t === 'f' && isOnline(c)).length;
    li.innerHTML = `
      <div class="t2-batch-main">
        <div class="t2-batch-name">${esc(b.name)}</div>
        <div class="t2-batch-sub">${esc(b.type || '')}${b.date ? ` · ${esc(b.date)}` : ''} · ${b.files} 个文件 · ${fmtSize(b.bytes)}${online ? ` · 已入库 ${online}` : ''}</div>
      </div>
      <span class="t2-batch-go" aria-hidden="true">›</span>`;
    bindTap(li, () => go({ p: b.name }));
    ul.appendChild(li);
  }
  if (!batches.length) ul.innerHTML = `<li class="t2-empty">这个阶段还没有批次</li>`;

  main.querySelectorAll('[data-crumb]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      go({ p: a.dataset.crumb });
    }),
  );
  main.querySelector('[data-act="crumb"]').onclick = () => go({ p: '' });
}

/** 搜索结果页：跨批次列出所有命中文件（文件名或「路径+文件」拼音首字母命中）。 */
function renderSearchResults(main) {
  const q = state.query.q.trim().toLowerCase();
  const kind = state.query.k;
  const hits = [];
  const walk = (node, pathStr, pathPy) => {
    for (const c of node.c || []) {
      if (c.t === 'd') walk(c, pathStr ? pathStr + '/' + c.n : c.n, pathPy + (c.p || ''));
      else {
        const here = pathPy + (c.p || '');
        const m = matchNode(c, q, kind, here);
        if (m) hits.push({ file: c, path: pathStr });
      }
    }
  };
  for (const b of state.manifest.batches) walk(b.tree, b.name);
  hits.sort((a, b) => (a.path + a.file.n).localeCompare(b.path + b.file.n, 'zh-Hans-CN', { numeric: true }));
  const bytes = hits.reduce((n, h) => n + (h.file.s || 0), 0);
  const online = hits.filter((h) => isOnline(h.file)).length;

  main.innerHTML = `
    <section class="t2-hero">
      <div class="t2-kicker">搜索结果</div>
      <h1 class="t2-title">「${esc(state.query.q.trim())}」命中 <em>${hits.length}</em> 个文件</h1>
      <p class="t2-deck">合计 ${fmtSize(bytes)} · 已入库 ${online} · 支持文件名和拼音首字母（比如 fzyj = 福州一检、sxda = 数学答案）。清空搜索框回到目录。</p>
    </section>
    <div class="t2-bar">
      <span class="t2-deck" style="margin:0 clamp(14px, 3vw, 36px)">${hits.length ? '点击文件名在线预览，或用右侧按钮下载/分享' : ''}</span>
      <span class="t2-grow"></span>
    </div>
    <ul class="t2-list"></ul>`;

  const ul = main.querySelector('.t2-list');
  if (!hits.length) {
    ul.innerHTML = `<li class="t2-empty">没有匹配的文件。试试文件名片段或拼音首字母；听力文件输「yytl」也能出。</li>`;
    return;
  }
  for (const h of hits) ul.appendChild(fileRow(h.file, h.path, false, state.query.s));
}

/** 收藏夹视图：跨届列出收藏的文件（loadSeason 有缓存，重复打开很快）。 */
async function renderFavorites(main) {
  const want = state.query.fav; // 过期渲染守卫：await 期间用户点去别处就丢弃
  const hits = [];
  for (const s of state.seasons) {
    const m = await loadSeason(String(s.id)).catch(() => null);
    if (!m) continue;
    const walk = (node, pathStr) => {
      for (const c of node.c || []) {
        if (c.t === 'd') walk(c, pathStr ? pathStr + '/' + c.n : c.n);
        else if (favHas(c.k)) hits.push({ file: c, path: pathStr, season: String(s.id) });
      }
    };
    for (const b of m.batches || []) walk(b.tree, b.name);
  }
  hits.sort((a, b) => (a.path + a.file.n).localeCompare(b.path + b.file.n, 'zh-Hans-CN', { numeric: true }));
  if (state.query.fav !== want) return; // 已经不在收藏视图了
  main.innerHTML = `
    <section class="t2-hero">
      <div class="t2-kicker">我的收藏</div>
      <h1 class="t2-title">★ 收藏夹 <em>${hits.length}</em></h1>
      <p class="t2-deck">收藏保存在本浏览器（无需登录）。点击文件名旁的星标可取消收藏。</p>
    </section>
    <div class="t2-bar">
      <button class="t2-btn" type="button" data-act="fav-back">← 回资料库</button>
    </div>
    <ul class="t2-list"></ul>`;
  if (state.query.fav !== want) return; // 同上
  const ul = main.querySelector('.t2-list');
  if (!hits.length) {
    ul.innerHTML = '<li class="t2-empty">还没有收藏。点击资料库里文件名旁的星标即可收藏。</li>';
    return;
  }
  for (const h of hits) ul.appendChild(fileRow(h.file, h.path, false, h.season));
  main.querySelector('[data-act="fav-back"]').onclick = () => go({ fav: '', p: '' });
}

function renderHome(main) {
  const t = state.manifest.totals;
  const st = state.storage;
  const kinds = state.manifest.kinds || {};
  const stages = state.manifest.stages || {};
  const year = state.manifest.year || state.query.s;
  const title = state.manifest.title || `${year} 届`;
  const byStage = {};
  for (const b of state.manifest.batches) byStage[b.stage] = (byStage[b.stage] || 0) + 1;
  // 最近 7 天新增（跨批次收集，最新在前）
  const fresh = [];
  const walkFresh = (n, p2) => { for (const c of n.c || []) { if (c.t === 'd') walkFresh(c, p2 + '/' + c.n); else if (isNewFile(c)) fresh.push({ file: c, path: p2 + '/' + c.n }); } };
  for (const b of state.manifest.batches) walkFresh(b.tree, b.name);
  fresh.sort((a, b) => String(b.file.w || '').localeCompare(String(a.file.w || '')));
  main.innerHTML = `
    <section class="t2-hero">
      <div class="t2-kicker">资料库 · ${esc(title)}</div>
      <h1 class="t2-title">福建高考备考资料 <em>${esc(year)}</em></h1>
      <p class="t2-deck">按考试批次归档：原卷、答案、听力、解析。左侧目录树逐层展开；有真实文件入库的条目可以<strong>在线预览</strong>（PDF / Word / 图片免下载），没有的走网盘。</p>
      <div class="t2-stats">
        <div class="t2-stat"><b>${t.batches ?? state.manifest.batches.length}</b><span>场考试</span></div>
        <div class="t2-stat"><b>${t.files}</b><span>条资料</span></div>
        <div class="t2-stat"><b>${fmtSize(t.bytes)}</b><span>原始体积</span></div>
        <div class="t2-stat"><b>${st.keys.size}</b><span>个文件可预览</span></div>
        <div class="t2-stat"><b>${kinds.pdf || 0}</b><span>份 PDF</span></div>
        <div class="t2-stat"><b>${kinds.docx || 0}</b><span>份 Word</span></div>
      </div>
      ${
        t.duplicateFiles
          ? `<p class="t2-deck" style="margin-top:10px;font-size:12.5px">清单共 ${t.files} 条，其中 <strong>${t.duplicateFiles} 条与其它文件内容完全相同</strong>（同一份卷子存了两个文件名），存储里共用一份，所以可预览的是 ${st.keys.size} 个文件——两个数字对得上，不是漏传。</p>`
          : ''
      }
    </section>
    <section class="t2-fresh">
      <h3 style="font-family:var(--serif);margin:0 0 10px">最近 7 天新增 <span style="color:var(--sub);font-size:13px;font-family:var(--sans)">${fresh.length} 份</span></h3>
      <ul class="t2-list" id="fresh-list" style="margin:0"></ul>
      <p class="t2-deck" style="margin:8px clamp(14px, 3vw, 36px) 0;font-size:12.5px">点文件名直接预览；新的听力会同步出现在音乐库里。</p>
    </section>
    <section class="t2-start">
      <h3 style="font-family:var(--serif);margin:0 0 10px">怎么找</h3>
      <ol class="t2-steps">
        <li><span>在左栏按<strong>考试批次</strong>展开（A1 福州一检、G2 省质检…），或在顶栏直接搜文件名，比如「英语 听力」「厦门二检」。</span></li>
        <li><span>点目录右侧的文件名：<strong>绿色圆点</strong>表示已入库，可在线看 PDF / Word；没有圆点的点「下载」或用每届的网盘兜底。</span></li>
        <li><span>想把某份卷子/听力发给同学？点文件旁的<strong>「分享」</strong>拿到一条短链——同一份资料所有人用同一个链接，打开就是预览/下载页（听力直接是播放页）。</span></li>
      </ol>
      <h3 style="font-family:var(--serif);margin:26px 0 10px">按阶段</h3>
      <div class="t2-grid3">
        ${Object.entries(byStage)
          .map(([stage]) => {
            const meta = stages[stage] || { name: stage };
            return `<div class="t2-tile" data-stage="${esc(stage)}"><h4>${esc(stage)} · ${esc(meta.name)}</h4><p>${byStage[stage]} 批 · ${esc(meta.note || '')}</p></div>`;
          })
          .join('')}
      </div>
      ${
        st.enabled
          ? ''
          : `<p style="margin-top:22px;font-size:13px;color:var(--sub)">当前届没有配置文件存储，预览按钮会提示"未入库"。配置方法见 <code>docs/tree2.md</code>。</p>`
      }
    </section>`;
  // 最近新增列表行（fileRow 复用，点文件名可预览）
  const freshUl = main.querySelector('#fresh-list');
  if (freshUl) fresh.slice(0, 6).forEach((h) => freshUl.appendChild(fileRow(h.file, h.path, false, state.query.s)));
  main.querySelectorAll('[data-stage]').forEach((el) =>
    el.addEventListener('click', () => go({ p: stagePath(el.dataset.stage) })),
  );
}

function renderFolder(main, path, node, focusFile) {
  // node 找不到（旧链接、改名、路径被截断）时回首页，而不是在 flatten() 里
  // 对 null 取 .c 直接抛错。
  if (!node || !Array.isArray(node.c)) return renderHome(main);
  const q = state.query.q.trim().toLowerCase();
  let items = flatten(node, path);
  if (q) items = items.filter(({ file }) => file.n.toLowerCase().includes(q));
  if (state.query.k) items = items.filter(({ file }) => kindOf(file.n) === state.query.k);
  if (state.filters.kind) items = items.filter(({ file }) => kindOf(file.n) === state.filters.kind);
  if (state.sort === 'date' || state.sort === 'tree') items.sort((a, b) => String(b.file.w || '').localeCompare(String(a.file.w || '')));
  if (state.sort === 'name') items.sort((a, b) => a.file.n.localeCompare(b.file.n, 'zh-Hans-CN', { numeric: true }));
  if (state.sort === 'size') items.sort((a, b) => (b.file.s || 0) - (a.file.s || 0));

  const crumbs = seg(path);
  const trail = crumbTrail(path);
  const meta = batchByName(crumbs[0]) || {};
  const up = parentPath(path);
  const onlineCount = items.filter(({ file }) => isOnline(file)).length;

  main.innerHTML = `
    <section class="t2-hero">
      <div class="t2-kicker">
        <a href="#" data-crumb="">${esc(state.manifest.title)}</a>${trail.map((c) => ` / <a href="#" data-crumb="${esc(c.path)}">${esc(c.label)}</a>`).join('')}
      </div>
      <h1 class="t2-title">${esc(crumbs[crumbs.length - 1] || state.manifest.title)}</h1>
      <p class="t2-deck">${meta.type ? `${esc(meta.type)} · ${esc(meta.date || '')} · ` : ''}${items.length} 个文件 · ${fmtSize(items.reduce((n, i) => n + (i.file.s || 0), 0))} · 已入库 ${onlineCount}</p>
    </section>
    <div class="t2-bar">
      <button class="t2-btn" type="button" data-act="crumb" data-to="${esc(up)}">↑ 上一级</button>
      <button class="t2-btn" type="button" data-act="share-folder" title="生成整个文件夹的分享页链接">分享文件夹</button>
      <button class="t2-btn" type="button" data-act="zip-folder" title="整个文件夹打包成 zip 下载">打包下载</button>
      <span class="t2-grow"></span>
      <select class="t2-sort" data-sort aria-label="排序">
        <option value="date"${state.sort === 'date' || state.sort === 'tree' ? ' selected' : ''}>按修改日期</option>
        <option value="name"${state.sort === 'name' ? ' selected' : ''}>按文件名</option>
        <option value="size"${state.sort === 'size' ? ' selected' : ''}>按体积</option>
      </select>
    </div>
    <ul class="t2-list"></ul>`;

  const ul = main.querySelector('.t2-list');
  if (!items.length) ul.innerHTML = `<li class="t2-empty">这里没有${q ? `匹配「${esc(q)}」的` : ''}文件</li>`;
  for (const { file, path: pp } of items) ul.appendChild(fileRow(file, pp, focusFile === joinPath(pp, file.n)));

  main.querySelector('[data-act="share-folder"]').onclick = () => shareFolder(path);
  main.querySelector('[data-act="zip-folder"]').onclick = () => { location.href = apiBase() + '/api/tree2/zip/' + encodeURIComponent(state.query.s) + '/' + encodeURIComponent(path); };

  main.querySelector('[data-sort]').onchange = (e) => {
    state.sort = e.target.value;
    pref.set('sort', state.sort);
    renderMain();
  };
  main.querySelectorAll('[data-crumb]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      go({ p: a.dataset.crumb });
    }),
  );
  // 用按钮上算好的 data-to，别在这里重新用 parentOf —— 批次层要回到它的阶段页
  main.querySelector('[data-act="crumb"]').onclick = (e) => go({ p: e.currentTarget.dataset.to || '' });
}

function fileRow(file, parent, focus, season) {
  season = season || state.query.s;
  const li = document.createElement('li');
  li.className = `t2-file${isOnline(file) ? ' is-online' : ''}`;
  const k = kindOf(file.n);
  const online = isOnline(file);
  const favorite = favHas(file.k);
  li.innerHTML = `
    <div class="t2-file-ico" data-k="${esc(k)}" title="${esc(kindLabel(k))}">${fileIconSvg(file.n, k)}</div>
    <div class="t2-file-info">
      <div class="t2-file-heading">
        <span class="t2-file-name" title="${esc(file.n)}">${esc(file.n)}</span>
        <button class="t2-btn t2-file-fav" type="button" data-a="fav" aria-label="收藏" aria-pressed="${favorite}" title="${favorite ? '取消收藏' : '收藏到本浏览器'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
            <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>
          </svg>
        </button>
      </div>
      <div class="t2-file-sub">
        <span>${esc(kindLabel(k))}</span><span>${fmtSize(file.s)}</span>
        <span class="t2-file-path">${esc(parent || '/')}</span>
        ${online ? '<span class="t2-tag ok">已入库 · 可预览</span>' : '<span class="t2-tag wait">未入库</span>'}
        ${isNewFile(file) ? '<span class="t2-tag new">新</span>' : ''}
      </div>
    </div>
    <div class="t2-file-act">
      <button class="t2-btn" type="button" data-a="share"${online ? '' : ' disabled'} title="生成 /s/ 短链发给别人">分享</button>
      <button class="t2-btn" type="button" data-a="view"${online && canRender(file.n) ? '' : ' disabled'}>预览</button>
      <button class="t2-btn primary" type="button" data-a="down"${online ? '' : ' disabled'}>下载</button>
    </div>`;
  li.querySelector('[data-a="fav"]').onclick = (e) => {
    e.stopPropagation();
    const on = favToggle(file.k);
    e.currentTarget.setAttribute('aria-pressed', String(on));
    e.currentTarget.title = on ? '取消收藏' : '收藏到本浏览器';
  };
  li.querySelector('[data-a="share"]').onclick = (e) => {
    e.stopPropagation();
    doShare(file, season);
  };
  li.querySelector('[data-a="view"]').onclick = (e) => {
    e.stopPropagation();
    openViewer(file, parent);
  };
  li.querySelector('[data-a="down"]').onclick = (e) => {
    e.stopPropagation();
    location.href = fileUrl(season, file, { download: true });
  };
  bindTap(li, () => openViewer(file, parent));
  if (focus) {
    li.style.outline = '2px solid var(--amber)';
    setTimeout(() => li.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
  }
  return li;
}

// ---------------------------------------------------------------- 预览抽屉

let viewerTicket = 0;
let audioSession;

function syncMiniPlayer() {
  $('#mini-player').dataset.playing = String(audioSession?.playing === true);
}

function stopAudio() {
  if (!audioSession) return;
  clearTimeout(audioSession.startup);
  audioSession.frame.remove();
  audioSession = null;
  $('#mini-player').hidden = true;
}

function showVinylFrame(session, expanded) {
  const show = expanded && session.ready;
  if (show && session.frame.dataset.expanded !== 'true') {
    session.frame.dataset.enter = String(session.animateOnExpand);
    session.animateOnExpand = false;
    session.frame.contentWindow.postMessage({ tree2Player: 'opened' }, session.origin);
  }
  if (!show) delete session.frame.dataset.enter;
  session.frame.dataset.expanded = String(show);
  session.frame.inert = !show;
}

function mountVinylPlayer(file, parent, season) {
  const track = encodeURIComponent(file.k.split('/').at(-1));
  const standalone = new URL(`/api/tree2/vinyl/${encodeURIComponent(season)}/${track}`, apiBase() || location.origin);
  const frame = document.createElement('iframe');
  frame.className = 't2-vinyl-frame';
  frame.title = '黑胶播放器';
  frame.allow = 'autoplay';
  frame.referrerPolicy = 'origin';
  frame.src = `${standalone.href}?t2embed=1`;
  const session = { frame, file, parent, season, activeKey: file.k, origin: standalone.origin, ready: false, playing: false };
  session.startup = setTimeout(() => {
    if (audioSession !== session || session.ready) return;
    const loading = $('#v-body [data-vinyl-loading]');
    if (loading) loading.innerHTML = `黑胶播放器没有响应。<br><a class="t2-btn" href="${esc(standalone.href)}" target="_blank" rel="noopener">在新窗口打开</a>`;
  }, 8000);
  audioSession = session;
  showVinylFrame(session, false);
  $('#vinyl-host').append(frame);
}

async function openViewer(file, parent, restore = false, season = state.query.s, resumeAudio = false) {
  disposePdf(); // 上一个预览若是 PDF，先把它的内存/监听器释放掉
  disposeWord();
  const box = $('#viewer');
  if (!box) return;
  const body = $('#v-body');
  const ticket = ++viewerTicket;
  const isCurrent = () => box.dataset.open === 'true' && ticket === viewerTicket;
  const titleEl = $('#v-title');
  if (titleEl) titleEl.textContent = file.n;
  const k = kindOf(file.n);
  const sameAudio = audioSession && (resumeAudio || audioSession.activeKey === file.k);
  const online = sameAudio || isOnline(file);
  const hasAudio = online && k === 'audio';
  const url = fileUrl(season, file);
  const downloadUrl = fileUrl(season, file, { download: true });
  const subEl = $('#v-sub');
  if (subEl) subEl.textContent = `${kindLabel(k)} · ${fmtSize(file.s)} · ${parent || '/'}`;
  bind('#v-down', () => (location.href = downloadUrl));
  bind('#v-share', () => doShare(file));

  const animateOpen = !restore && box.dataset.open !== 'true';
  box.dataset.enter = String(animateOpen && !hasAudio);
  box.dataset.open = 'true';
  box.dataset.audio = String(hasAudio);
  document.body.style.overflow = 'hidden';
  if (!restore) {
    writeUrl(false);
    const u = new URL(location.href);
    u.searchParams.set('s', season);
    u.searchParams.set('f', joinPath(parent, file.n));
    history.pushState({ t2viewer: true }, '', u);
  }

  if (!online) {
    body.innerHTML = `<div class="pad">这个文件还没有真实的文件入库（只记了目录）。<br>请联系维护者上传，或使用网盘下载。</div>`;
    return;
  }

  if (hasAudio) {
    body.innerHTML = '<div class="pad" role="status" data-vinyl-loading>正在打开黑胶播放器…</div>';
    if (sameAudio) {
      Object.assign(audioSession, { file, parent, season });
    } else {
      stopAudio();
      mountVinylPlayer(file, parent, season);
      $('#mini-expand').title = file.n;
    }
    audioSession.animateOnExpand = animateOpen;
    showVinylFrame(audioSession, true);
    syncMiniPlayer();
    $('#v-close').focus({ preventScroll: true });
    return;
  }

  if (k === 'image') {
    body.innerHTML = '<div class="pad" role="status">正在加载图片…</div>';
    void render(body, url, file.n, { isCurrent });
    return;
  }

  $('#v-body').innerHTML = `<div class="pad"><div class="t2-progress"><i></i></div><p style="margin-top:12px">正在加载…</p></div>`;
  const bar = $('#v-body .t2-progress i');
  try {
    const blob = await fetchBytes([url], {
      onProgress: (got, total) => {
        if (bar && total) bar.style.width = `${Math.min(100, (got / total) * 100)}%`;
      },
    });
    if (!isCurrent()) return;
    if (blob.size > MAX_BYTES) {
      $('#v-body').innerHTML = `<div class="pad">文件 ${fmtSize(blob.size)} 超过在线预览上限，请下载后查看。</div>`;
      return;
    }
    await render($('#v-body'), blob, file.n, { isCurrent });
  } catch (e) {
    if (isCurrent()) body.innerHTML = `<div class="pad">加载失败：${esc(e.message)}<br><a class="t2-btn" href="${esc(downloadUrl)}">下载到本地</a></div>`;
  }
}
const MAX_BYTES = 80 * 1024 * 1024;

function closeViewer() {
  const box = $('#viewer');
  if (!box || box.dataset.open !== 'true') return; // 幂等：popstate 与手动关闭只走一次
  box.dataset.open = 'false';
  delete box.dataset.enter;
  if (audioSession?.ready) showVinylFrame(audioSession, false);
  else stopAudio();
  viewerTicket++;
  document.body.style.overflow = '';
  disposePdf(); // 抽屉关了，PDF 的文档和监听器一并释放
  disposeWord();
  $('#v-body').replaceChildren();
  $('#mini-player').hidden = !audioSession;
  if (box.dataset.audio === 'true' && audioSession) $('#mini-expand').focus({ preventScroll: true });
}
function closeViewerBack() {
  // UI 关闭走 history.back()：前进键可重开播放器；直接加载（无 push 记录）时原位关闭
  if (history.state && history.state.t2viewer) { history.back(); return; }
  closeViewer();
  const u = new URL(location.href);
  if (u.searchParams.has('f')) { u.searchParams.delete('f'); history.replaceState(null, '', u); }
}

function restoreViewer() {
  const { f, s } = state.query;
  if (!f || !state.manifest) return false;
  const parent = parentOf(f);
  const name = seg(f).at(-1);
  const node = parent ? nodeAt(parent) : rootOf();
  const file = node?.c?.find((child) => child.t === 'f' && child.n === name);
  if (!file || !isOnline(file)) return false;
  openViewer(file, parent, true, s);
  return true;
}

// ---------------------------------------------------------------- 分享链接
// 链接是确定性的：/s/<存储键> —— 同一个文件对所有人都是同一个地址，纯客户端拼出来即可。
// 音频链接会直接 302 到 Navidrome 黑胶页；其余是「预览 + 下载」落地页。

// ---- 收藏夹（localStorage，无需登录） ----
const FAV_LS = 'tree2.fav';
const favSet = new Set();
try {
  const saved = JSON.parse(localStorage.getItem(FAV_LS) || '[]');
  if (Array.isArray(saved)) for (const key of saved) if (typeof key === 'string') favSet.add(key);
} catch { /* 无可用收藏记录 */ }
const favHas = (k) => favSet.has(k);
function favToggle(k) {
  if (favSet.has(k)) favSet.delete(k);
  else favSet.add(k);
  try { localStorage.setItem(FAV_LS, JSON.stringify([...favSet])); } catch { /* 隐私模式 */ }
  return favSet.has(k);
}
// 「最近 7 天新增」判定（清单里的 w 字段 = 首次入库日期）
const isNewFile = (f) => {
  if (!f.w) return false;
  const d = Date.parse(f.w);
  return Number.isFinite(d) && Date.now() - d <= 7 * 86400000;
};

// 「已复制」按钮反馈。放在模块级：copyText 和 copyTextFallback 两条路径都要用
// （原先 done 定义在 copyText 内部，降级路径里调它是 ReferenceError）。
function copyDone(btn) {
  if (!btn) return;
  const old = btn.textContent;
  btn.textContent = '已复制';
  setTimeout(() => (btn.textContent = old), 1200);
}

function copyText(text, btn) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => copyDone(btn), () => copyTextFallback(text, btn));
  } else copyTextFallback(text, btn);
}

function copyTextFallback(text, btn) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  (document.querySelector('dialog[open]') || document.body).appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    copyDone(btn);
  } catch {
    toast('复制失败，长按链接手动复制', true);
  }
  ta.remove();
}

/** 分享弹层（通用）：文件和文件夹共用，链接都是确定性的。 */
function shareDialog({ name, url, note }) {
  let dlg = $('#share-dlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'share-dlg';
    dlg.className = 't2-share-dlg';
    dlg.setAttribute('aria-labelledby', 'share-title');
    dlg.innerHTML = `
      <div class="t2-share-card">
        <div class="t2-share-head">
          <h2 class="t2-share-title" id="share-title">分享链接</h2>
          <button class="t2-btn t2-ico-btn" type="button" data-a="close" aria-label="关闭分享">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
        <div class="t2-share-name"></div>
        <div class="t2-share-link">
          <a target="_blank" rel="noopener"></a>
          <button class="t2-btn primary" type="button" data-a="copy" autofocus>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
            <span>复制链接</span>
          </button>
        </div>
        <div class="t2-share-note"></div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-a="close"]')) dlg.close();
    });
    dlg.querySelector('[data-a="copy"]').addEventListener('click', (e) => {
      copyText(dlg.querySelector('.t2-share-link a').href, e.currentTarget.querySelector('span'));
    });
  }
  dlg.querySelector('.t2-share-name').textContent = name;
  const a = dlg.querySelector('.t2-share-link a');
  a.href = url;
  a.textContent = url;
  a.title = url;
  dlg.querySelector('.t2-share-note').textContent = note;
  if (!dlg.open) dlg.showModal();
}

/** 单文件分享：/s/<存储键>。 */
function doShare(file) {
  shareDialog({
    name: file.n,
    url: `${apiBase() || location.origin}/s/${file.k}`,
    note: kindOf(file.n) === 'audio' ? '打开链接即可在线播放。' : '打开链接即可预览或下载文件。',
  });
}

function shareFolder(folderPath) {
  const folderId = nodeAt(folderPath)?.folderId;
  const year = encodeURIComponent(state.query.s);
  const path = folderId ? `/d/id/${year}/${encodeURIComponent(folderId)}` : `/d/${year}/${encodeURIComponent(folderPath)}`;
  shareDialog({
    name: folderPath,
    url: `${apiBase() || location.origin}${path}`,
    note: '打开链接即可浏览这个文件夹和下载资料。',
  });
}

// ---------------------------------------------------------------- 事件

/**
 * 绑定点击/事件，元素不存在就跳过。
 * 页面结构改过、浏览器缓存了旧脚本、或者某个 id 拼错时，
 * 一句 `el.onclick = ...` 就会把整个启动流程打断，整页白掉；
 * 这里宁可少绑一个按钮，也要让其余部分正常工作。
 */
function bind(sel, handler, event = 'click') {
  const el = $(sel);
  if (!el) {
    console.warn(`[tree2] 没找到 ${sel}，跳过绑定`);
    return null;
  }
  if (event === 'click') el.onclick = handler;
  else el.addEventListener(event, handler);
  return el;
}

function wire() {
  const search = $('#q');
  if (search) {
    search.value = state.query.q;
  }
  let t;
  // 搜索是"临时视图"：进入时把展开状态存一份快照，清空时还原，
  // 免得搜索时被迫展开的目录在退出后仍然张着。
  let openBeforeSearch = null;
  if (search) search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const next = search.value.trim();
      const was = Boolean(state.query.q);
      const now = Boolean(next);
      if (!was && now) openBeforeSearch = new Set(state.open);
      if (was && !now && openBeforeSearch) {
        // 回到未搜索状态：恢复进入搜索前的展开集合
        state.open = openBeforeSearch;
        openBeforeSearch = null;
        state.query.q = '';
        writeUrl(false);
        renderTree();
        renderMain();
        return;
      }
      state.query.q = next;
      writeUrl(false);
      renderTree();
      renderMain();
    }, 160);
  });

  document.addEventListener('keydown', (e) => {
    if (!search || $('#share-dlg')?.open) return;
    if (e.key === '/' && document.activeElement !== search && !/input|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      search.focus();
      search.select();
    }
    if (e.key === 'Escape') {
      if ($('#viewer')?.dataset.open === 'true') closeViewerBack();
      else if (isSearching()) exitMobileSearch();
      else if (document.activeElement === search) search.blur();
    }
  });

  // 手机端点开搜索：收起统计/说明，搜索框平滑升到简介下面，同时展开目录树
  if (search) {
    search.addEventListener('focus', () => {
      if (mqPhone.matches) enterMobileSearch();
    });
  }

  bind('#search-form', (e) => e.preventDefault(), 'submit');
  // 搜索按钮：主动触发一次搜索，并收起手机键盘让结果露出来
  bind('#search-btn', () => {
    go({ q: $('#q').value.trim() });
    $('#q')?.blur();
  });

  // ☰ 在手机上已隐藏，保留绑定以便将来恢复入口
  bind('#menu', () => (isSearching() ? exitMobileSearch() : enterMobileSearch()));

  bind('#fav-entry', () => go({ fav: '1' }));

  // 品牌点击 = 回站点主页（选届），不是回上次的资料库
  bind('.t2-brand', (e) => {
    e.preventDefault();
    history.pushState({}, '', '/');
    enterSiteHome();
  });

  bind('#v-close', closeViewerBack);
  bind('#mini-expand', () => {
    if (!audioSession) return;
    const { file, parent, season } = audioSession;
    openViewer(file, parent, false, season, true);
  });
  bind('#mini-close', stopAudio);
  window.addEventListener('message', (e) => {
    const session = audioSession;
    if (!session || e.origin !== session.origin || e.source !== session.frame.contentWindow) return;
    const type = e.data?.tree2Player;
    if (type === 'state') {
      session.ready = true;
      clearTimeout(session.startup);
      session.playing = e.data.playing === true;
      if (e.data.key === null || /^[0-9a-f]{2}\/[0-9a-f]{64}\.(?:mp3|wav|m4a|ogg|flac|aac)$/.test(e.data.key)) {
        session.activeKey = e.data.key;
        $('#mini-expand').title = typeof e.data.title === 'string' ? e.data.title : session.file.n;
      }
      const viewer = $('#viewer');
      showVinylFrame(session, viewer.dataset.open === 'true' && viewer.dataset.audio === 'true');
      syncMiniPlayer();
    }
    if (type === 'minimize' && session.frame.dataset.expanded === 'true') closeViewerBack();
    if (type === 'favorite' && e.data.key && e.data.key === session.activeKey) {
      if (e.data.on === true) favSet.add(e.data.key);
      else favSet.delete(e.data.key);
      renderMain();
    }
  });

  window.addEventListener('popstate', async () => {
    if ($('#viewer')?.dataset.open === 'true') closeViewer(); // 返回键关闭播放器
    readUrl(true);
    // 后退到站点主页（地址没有 ?s=）
    if (!new URLSearchParams(location.search).get('s')) {
      enterSiteHome();
      return;
    }
    if (!state.manifest || String(state.season?.id) !== state.query.s) {
      try {
        await openSeason(state.query.s);
      } catch (e) {
        toast(`切换到 ${state.query.s} 届失败：${e.message || e}`, true);
        return;
      }
    }
    leaveSiteHome();
    renderAll();
    if (state.query.f && !restoreViewer()) writeUrl(false);
  });
}

function renderAll() {
  if (!state.manifest) return;
  const search = $('#q');
  // wire() 万一没跑到，search 可能是 null —— 别在这里再崩一次
  if (search && document.activeElement !== search) search.value = state.query.q;
  renderSeasons(); // 顶部届别按钮的高亮（aria-current）也要跟着当前届走
  renderTree();
  renderMain();
}

// ---------------------------------------------------------------- 启动

/** 页面自检：地址栏加 ?diag=1 打开，把"卡在哪一步"直接打在屏幕上，免开 F12。 */
async function diagnose() {
  const lines = [];
  const say = (k, v, bad) => lines.push(`${bad ? '✗' : '✓'} ${k}：${v}`);
  say('页面地址', location.href);
  say('数据服务', apiOriginLabel());
  let seasons = null;
  try {
    const r = await fetch(`${apiBase()}/api/tree2/seasons`, { cache: 'no-cache', credentials: 'omit' });
    say('GET /seasons', `HTTP ${r.status}`, !r.ok);
    if (r.ok) seasons = await r.json();
  } catch (e) {
    say('GET /seasons', `请求失败 ${e.message}`, true);
  }
  if (seasons) say('届别', `${seasons.seasons?.length || 0} 个：${(seasons.seasons || []).map((s) => s.id).join(', ')}`);
  // 检查最新一届的清单，别硬编码 2026——2027 届上线后硬编码就查了个空
  const latest = seasons && seasons.seasons && seasons.seasons.length
    ? String(seasons.seasons.map((s) => s.id).sort().pop())
    : '2026';
  try {
    const r = await fetch(`${apiBase()}/api/tree2/seasons/${encodeURIComponent(latest)}`, { cache: 'no-cache', credentials: 'omit' });
    say(`GET /seasons/${latest}`, `HTTP ${r.status}`, !r.ok);
    if (r.ok) {
      const m = await r.json();
      say('清单', `${m.batches?.length} 批 / ${m.totals?.files} 文件`);
    }
  } catch (e) {
    say(`GET /seasons/${latest}`, `请求失败 ${e.message}`, true);
  }
  say('state.manifest', state.manifest ? '已加载' : '空', !state.manifest);
  say('state.storage', `${state.storage?.keys?.size ?? 0} 个对象`);
  say('#tree 内容', `${$('#tree')?.innerHTML.length ?? -1} 字符`, !$('#tree')?.innerHTML.length);
  say('#page 内容', `${$('#page')?.innerHTML.length ?? -1} 字符`, !$('#page')?.innerHTML.length);
  const main = $('#page');
  if (main) {
    main.innerHTML = `<section class="t2-hero"><div class="t2-kicker">自检</div><h2 class="t2-title">tree2 诊断</h2>
      <pre style="white-space:pre-wrap;font:13px/1.8 ui-monospace,Consolas,monospace;background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px">${lines.map((l) => esc(l)).join('\n')}</pre>
      <p class="t2-deck">把这整段发给我就能定位问题。</p></section>`;
  }
}

if (new URLSearchParams(location.search).get('diag')) {
  // 自检模式：不启动正常流程，只跑诊断
  diagnose();
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

window.__tree2 = state; // 调试用：控制台里看当前状态

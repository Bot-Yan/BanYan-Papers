#!/usr/bin/env node
/**
 * tree2-files-server.mjs —— tree2 的「文件与清单」服务（零依赖，Node ≥ 18）。
 *
 * 为什么需要它：本站是纯静态站（Astro output: static），清单和界面可以直接托管，
 * 但「文件字节」有两件静态站做不了的事——① 跨域给 pdf.js / Flyfish 客户端读（CORS）；
 * ② 接收上传（静态站没有写权限）。这个服务把这两件事包成一组 /api/tree2/* 接口，
 * 页面用 `?api=http://127.0.0.1:8787` 切换过来，Flyfish 客户端则直接调这些接口。
 *
 * 启动
 *   TREE2_TOKEN=我的口令 node scripts/tree2-files-server.mjs
 *   node scripts/tree2-files-server.mjs --port 8787 --root . --allow-origin http://localhost:4321
 *
 * 接口（全部带 CORS，OPTIONS 预检直接放行）
 *   GET    /api/tree2/seasons                           届别索引（public/tree2/data/seasons.json）
 *   GET    /api/tree2/seasons/:year                     这一届的完整清单
 *   GET    /api/tree2/storage/:year                     这一届哪些存储键已有真实字节
 *   GET    /api/tree2/files/:year?k=<key>&n=<name>      读文件（支持 Range，图片/音频可拖动播放；
 *                                                       ?download=1 → Content-Disposition: attachment）
 *   GET    /api/tree2/files/:year?h=<sha256>            查内容是否已在库（秒传探测）
 *   PUT    /api/tree2/files/:year/part?k=<key>&i=0&n=3  上传第 i 片（每片 ≤ 8 MB，可乱序、可重传）
 *   POST   /api/tree2/files/:year/commit                合并分片 → 校验 sha256 → 落成 key；顺带写进清单
 *   GET    /api/tree2/health                            自检
 *   GET    /s/<存储键>                                  分享落地页（确定性链接：同一文件同一地址）；
 *                                                       音频已注册黑胶页 → 302 到 /music/share/<id>
 *   GET    /s/<旧id>                                    历史随机短链（只读兼容，不再新增）
 *
 * 鉴权
 *   设置了 TREE2_TOKEN 后，写操作必须带 `Authorization: Bearer <token>` 或 `X-Tree2-Token`；
 *   读操作默认公开（和站点一样），要私开的话加 --private。
 *
 * 存储布局（默认 <repo>/storage/tree2）
 *   objects/<前两位>/<sha256>.<ext>   最终文件（按内容寻址，天然去重）
 *   tmp/<key>/<i>.part                正在接收的分片
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn as cpSpawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MIME = {
  // 网页自己的资源：漏了这些，浏览器会因为 application/octet-stream 拒绝执行 module 脚本和样式
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  // 资料文件
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.csv': 'text/csv; charset=utf-8',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
};

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const o = {
    port: Number(process.env.PORT || 8787),
    host: process.env.TREE2_HOST || '127.0.0.1',
    root: ROOT,
    store: process.env.TREE2_STORE || path.join(ROOT, 'storage', 'tree2'),
    data: process.env.TREE2_DATA || path.join(ROOT, 'public', 'tree2', 'data'),
    allowOrigin: (process.env.TREE2_ALLOW_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean),
    token: process.env.TREE2_TOKEN || '',
    privateRead: false,
    maxPart: 8 * 1024 * 1024,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') o.port = Number(next());
    else if (a === '--host') o.host = next();
    else if (a === '--root') o.root = path.resolve(next());
    else if (a === '--store') o.store = path.resolve(next());
    else if (a === '--data') o.data = path.resolve(next());
    else if (a === '--allow-origin') o.allowOrigin = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--token') o.token = next();
    else if (a === '--private') o.privateRead = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法见文件头部注释：--port --host --root --store --data --allow-origin --token --private');
      process.exit(0);
    }
  }
  return o;
}

const cfg = parseArgs(process.argv.slice(2));
const OBJECTS = path.join(cfg.store, 'objects');
const TMP = path.join(cfg.store, 'tmp');

// ---------------------------------------------------------------- 工具

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}


// ---------------------------------------------------------------- Navidrome 音频直通
// 音频预览的字节来自 Navidrome（Subsonic 流接口），本服务有两条路：
//   ① 流式代理（推荐）：navidrome.json 配了 internal（Navidrome 的内网地址，如
//      http://127.0.0.1:4533）时，本服务自己去拉流再吐给浏览器——Subsonic 凭证
//      （t=md5(password+salt)）只在服务器内部出现，不进浏览器，泄露面归零。
//      Range 透传给 Navidrome，拖动进度不受影响；流量过一遍本服务，同机部署无所谓。
//   ② 302 兜底：没配 internal 时维持原状——302 把带凭证的流地址直接给浏览器，
//      任何访客都能拿到一把可长期使用的音乐库 API 凭证，建议尽快配上 internal。
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']);
const ND_CFG_FILE = path.join(HERE, '..', 'data', 'navidrome.json');
const ND_MAP_FILE = path.join(HERE, '..', 'data', 'audio-map.json');
const ND_SHARE_FILE = path.join(HERE, '..', 'data', 'share-map.json');
// 分享注册表：shares.json 由本服务写；share-nd-map.json 由 navidrome 同步脚本写（两边不写同一个文件）
const SHARES_DIR = process.env.TREE2_SHARES_DIR || path.join(HERE, '..', 'data');
const SHARES_FILE = path.join(SHARES_DIR, 'shares.json');
const SHARE_ND_FILE = path.join(SHARES_DIR, 'share-nd-map.json');
let ndCache = { cfgMtime: 0, mapMtime: 0, sharesMtime: 0, regMtime: 0, shareNdMtime: 0, cfg: null, map: null, shares: null, reg: null, shareNd: null };

async function readJsonCached(file, key, mtimeKey) {
  try {
    const st = await fsp.stat(file);
    if (st.mtimeMs !== ndCache[mtimeKey]) {
      const raw = await fsp.readFile(file, 'utf8');
      ndCache[key] = JSON.parse(raw);
      ndCache[mtimeKey] = st.mtimeMs;
    }
  } catch {
    /* 文件不存在就当作没配置 */
  }
  return ndCache[key];
}

/** sha256 → Navidrome stream URL（Subsonic token 鉴权）；没配置或没映射返回 null。 */
async function navidromeStreamUrl(sha) {
  const cfg = await readJsonCached(ND_CFG_FILE, 'cfg', 'cfgMtime');
  if (!cfg || !cfg.base || !cfg.user || !cfg.password) return null;
  const map = await readJsonCached(ND_MAP_FILE, 'map', 'mapMtime');
  const id = map && map[sha];
  if (!id) return null;
  return navidromeStreamUrlById(id, cfg);
}

/** 已知 Navidrome 歌曲 id 时直接构造流地址（分享音频走这条路）。 */
function navidromeStreamUrlById(id, cfgOverride) {
  const cfg = cfgOverride;
  if (!cfg || !cfg.user || !cfg.password || !id) return null;
  const salt = crypto.randomBytes(6).toString('hex');
  const token = crypto.createHash('md5').update(cfg.password + salt).digest('hex');
  const qs = new URLSearchParams({
    u: cfg.user, t: token, s: salt, v: '1.16.1', c: 'tree2', id,
  });
  return `${cfg.base || '/music'}/rest/stream.view?${qs.toString()}`;
}

/** 配了 internal（内网地址）时，返回服务端可直连的流地址；没配返回 null（走 302 兜底）。 */
async function navidromeProxyStreamUrl(sha) {
  const cfg = await readJsonCached(ND_CFG_FILE, 'cfg', 'cfgMtime');
  const internal = cfg && (cfg.internal || cfg.internalBase);
  if (!internal || !cfg.user || !cfg.password) return null;
  const map = await readJsonCached(ND_MAP_FILE, 'map', 'mapMtime');
  const id = map && map[sha];
  if (!id) return null;
  const salt = crypto.randomBytes(6).toString('hex');
  const token = crypto.createHash('md5').update(cfg.password + salt).digest('hex');
  const qs = new URLSearchParams({
    u: cfg.user, t: token, s: salt, v: '1.16.1', c: 'tree2', id,
  });
  return `${String(internal).replace(/\/+$/, '')}/rest/stream.view?${qs.toString()}`;
}

/**
 * 服务端代理 Navidrome 的音频流：Range/206 透传（拖动进度靠它），
 * 上游的分块 pipe 给浏览器，字节不在服务端落盘、不进内存。
 */
async function proxyAudioStream(req, res, upstreamUrl) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  // 连接超时只护住「等到响应头」这一段：头到了就撤掉定时器，音乐流本身可以慢慢放，
  // 不会被 30s 卡断；Navidrome 挂死时请求也能及时失败，不至于悬挂占住连接。
  const upstreamCtl = new AbortController();
  const upstreamTimer = setTimeout(() => upstreamCtl.abort(), 30000);
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, { headers, redirect: 'follow', signal: upstreamCtl.signal });
  } catch {
    clearTimeout(upstreamTimer);
    throw new HttpError(502, '音频上游（Navidrome）暂时无法连接，请稍后重试');
  }
  clearTimeout(upstreamTimer);
  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => {});
    throw new HttpError(502, `音频上游返回 HTTP ${upstream.status}（同步未完成或凭证不对）`);
  }
  const h = {
    'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) h['Content-Range'] = contentRange;
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) h['Content-Length'] = contentLength;
  res.writeHead(upstream.status, { ...cors(req), ...h });
  if (req.method === 'HEAD' || !upstream.body) return res.end();
  await pipeline(Readable.fromWeb(upstream.body), res).catch(() => {
    // 管道失败（多半是客户端断开/拖动进度重发 Range）：撤掉上游响应体，
    // 不然 undici 会把整首歌继续拉完，白白占着连接和流量
    upstream.body?.cancel().catch(() => {});
  });
}

// ------------------------------------------------------------- 旧版分享注册表（只读兼容）
// 历史上的随机短链 /s/<10位id> 登记在 shares.json。新链接一律用确定性的 /s/<存储键>，
// 不再有建/删接口；这份注册表只读，访问计数仍然生效。
let shareWriteChain = Promise.resolve();

async function loadShares() {
  const list = await readJsonCached(SHARES_FILE, 'reg', 'regMtime');
  return Array.isArray(list) ? list : [];
}

async function saveShares(list) {
  await fsp.mkdir(SHARES_DIR, { recursive: true });
  const tmp = `${SHARES_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2));
  await fsp.rename(tmp, SHARES_FILE);
  ndCache.regMtime = 0; // 下次 loadShares 重新读盘
}

/** 排队执行一次注册表读-改-写；fn 拿到当前列表，必须返回新列表。 */
function mutateShares(fn) {
  const run = shareWriteChain.then(async () => {
    const list = await loadShares();
    const next = await fn(list);
    if (!Array.isArray(next)) throw new Error('mutateShares 回调必须返回数组');
    await saveShares(next);
    return next;
  });
  shareWriteChain = run.catch(() => {});
  return run;
}

const router = [];
const route = (method, re, fn) => router.push({ method, re, fn });

function cors(req) {
  const origin = req.headers.origin || '';
  const allow = cfg.allowOrigin.includes('*') ? '*' : cfg.allowOrigin.includes(origin) ? origin : cfg.allowOrigin[0] || '';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tree2, X-Tree2-Token',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Content-Disposition, X-Tree2-Sha256',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(res, status, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  // 默认带上 CORS：Flyfish / 其它域名的页面要能直接 fetch 这些 JSON
  const head = { ...cors(res.req || { headers: {} }), ...extra };
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...head });
  res.end(buf);
}

function sameToken(given) {
  const want = Buffer.from(cfg.token);
  const got = Buffer.from(String(given || ''));
  return want.length === got.length && timingSafeEqual(want, got);
}

function requireWrite(req) {
  if (!cfg.token) return;
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!sameToken(bearer) && !sameToken(req.headers['x-tree2-token'])) throw new HttpError(401, '需要上传口令：Authorization: Bearer <token>');
}

function requireRead(req) {
  if (cfg.privateRead) requireWrite(req);
}

/** 可选操作者标记：backend 代理转发时经 X-Tree2-Actor 传入，写进 uplog 便于审计（本机直连时为空）。 */
function actorOf(req) {
  return String(req.headers['x-tree2-actor'] || '').replace(/[^\w.-]/g, '').slice(0, 80);
}

/** 存储键只允许 `<hex2>/<hex64>[.ext]`，防止把读写指到对象目录以外。 */
function safeKey(k) {
  if (!/^[0-9a-f]{2}\/[0-9a-f]{64}(\.[a-z0-9]{1,8})?$/.test(String(k || ''))) throw new HttpError(400, '存储键不合法');
  return String(k);
}

const objPath = (key) => path.join(OBJECTS, safeKey(key));

function safeYear(y) {
  if (!/^\d{4}$/.test(String(y || ''))) throw new HttpError(400, '届别不合法');
  return String(y);
}

/**
 * 两个集合，别混：
 *   manifestKeys —— 清单里登记过的存储键（可能有文件，也可能还没传）
 *   objectKeys   —— 磁盘上真实存在的对象（只有这些能预览/下载）
 * 清单扫描缓存 30 秒；对象目录每次读（readdir 很便宜），上传完立刻就能预览。
 */
const manifestCache = new Map();

async function manifestKeys(year) {
  const hit = manifestCache.get(year);
  if (hit && Date.now() - hit.at < 30000) return hit.keys;
  const keys = new Set();
  const m = await readManifestFile(year).catch(() => null);
  const walk = (node) => {
    for (const c of node.c || []) {
      if (c.t === 'd') walk(c);
      else if (c.k) keys.add(c.k);
    }
  };
  for (const b of (m && m.batches) || []) walk(b.tree);
  manifestCache.set(year, { keys, at: Date.now() });
  return keys;
}

async function objectKeys() {
  const keys = new Set();
  for (const d of await fsp.readdir(OBJECTS).catch(() => [])) {
    if (!/^[0-9a-f]{2}$/.test(d)) continue;
    for (const f of await fsp.readdir(path.join(OBJECTS, d)).catch(() => [])) {
      if (!f.endsWith('.tmp')) keys.add(`${d}/${f}`);
    }
  }
  return keys;
}

// 秒传探测是公开接口，每次全量 readdir 对象库太重：加个短 TTL 缓存。
// 提交入库 / 引用清理会主动失效，缓存期间对象只会「多算存在」不会漏报；
// 万一漏报，客户端也会降级成分片上传，不影响正确性。
let objKeysCache = { keys: null, at: 0 };
async function objectKeysCached() {
  if (objKeysCache.keys && Date.now() - objKeysCache.at < 10000) return objKeysCache.keys;
  const keys = await objectKeys();
  objKeysCache = { keys, at: Date.now() };
  return keys;
}
function invalidateObjectKeys() {
  objKeysCache = { keys: null, at: 0 };
}

async function readManifestFile(year) {
  return JSON.parse(await fsp.readFile(path.join(cfg.data, `${safeYear(year)}.json`), 'utf8'));
}

// ---- 清单树统计（唯一实现） ----
// countFiles/countDirs/sumBytes 之前在 remove / rename / batch / attach 里各抄了一份，
// 已经抄丢过东西（rename 忘了更新 totals）；统一走下面这几个 + recalcManifestStats。
const countTreeFiles = (n) => (n.c || []).reduce((x, c) => x + (c.t === 'd' ? countTreeFiles(c) : 1), 0);
const countTreeDirs = (n) => (n.c || []).reduce((x, c) => x + (c.t === 'd' ? countTreeDirs(c) + 1 : 0), 0);
const sumTreeBytes = (n) => (n.c || []).reduce((x, c) => x + (c.t === 'd' ? sumTreeBytes(c) : c.s || 0), 0);

/** 写盘前统一重算：每个批次的 files/dirs/bytes + 全届 totals。 */
function recalcManifestStats(m) {
  for (const b of m.batches || []) {
    b.files = countTreeFiles(b.tree);
    b.dirs = countTreeDirs(b.tree);
    b.bytes = sumTreeBytes(b.tree);
  }
  m.totals = m.totals || {};
  m.totals.files = (m.batches || []).reduce((n, b) => n + b.files, 0);
  m.totals.bytes = (m.batches || []).reduce((n, b) => n + b.bytes, 0);
}

// ---------------------------------------------------------------- 接口：清单

route('GET', /^\/api\/tree2\/seasons$/, async (req, res) => {
  requireRead(req);
  const raw = await fsp.readFile(path.join(cfg.data, 'seasons.json'), 'utf8').catch(() => '{"schema":"tree2/1","seasons":[]}');
  json(res, 200, JSON.parse(raw));
});

route('GET', /^\/api\/tree2\/seasons\/([^/]+)$/, async (req, res, [, year]) => {
  requireRead(req);
  const raw = await fsp.readFile(path.join(cfg.data, `${safeYear(year)}.json`), 'utf8').catch(() => null);
  if (!raw) throw new HttpError(404, '这一届的清单还没生成');
  // 清单只在增删文件时才变：给内容算 ETag，浏览器每次进站带着 If-None-Match 来验证，
  // 没变就 304 空响应——以前是每次全量重拉（gzip 后 ~87KB × 每次进站，9 天 243 MB）
  const etag = `"${createHash('sha1').update(raw).digest('hex').slice(0, 20)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...cors(req), ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }
  res.writeHead(200, { ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag });
  res.end(raw);
});

route('GET', /^\/api\/tree2\/storage\/([^/]+)$/, async (req, res, [, year]) => {
  requireRead(req);
  safeYear(year);
  // 只报这一届清单里、且字节真的在盘上的键——对象库是全届共用的内容寻址存储，
  // 直接 readdir 会把别的届的文件也算进来，主页的「可预览」数就串了
  const objects = await objectKeys();
  const known = await manifestKeys(year);
  const keys = [...known].filter((k) => objects.has(k));
  json(res, 200, { year, enabled: true, source: 'local', count: keys.length, keys });
});

// 黑胶页直达 id：库内点音频预览时前端先问这个接口；share-map 有映射就整页跳
// /music/share/<id>（与 /s/ 音频分享一致），没有就回退内嵌播放器
route('GET', /^\/api\/tree2\/nd-share$/, async (req, res, m, url) => {
  requireRead(req);
  let key = '';
  try { key = safeKey(url.searchParams.get('k') || ''); } catch { key = ''; }
  if (!key) return json(res, 200, { id: null });
  // share-map 的键是裸 sha256（无 xx/ 前缀、无扩展名），与 /s/ 落地页同款归一化
  const sha = path.basename(key, path.extname(key));
  const sm = (await readJsonCached(ND_SHARE_FILE, 'shares', 'sharesMtime')) || {};
  json(res, 200, { id: sm[sha] || null });
});

// ---------------------------------------------------------------- 接口：秒传探测 / 读文件

route('GET', /^\/api\/tree2\/files\/([^/]+)$/, async (req, res, [, year], url) => {
  requireRead(req);
  safeYear(year);
  const sha = String(url.searchParams.get('h') || '').toLowerCase();

  // ① 秒传探测：内容哈希 → 文件是否已在库
  if (/^[0-9a-f]{64}$/.test(sha)) {
    const known = await manifestKeys(year);
    const objects = await objectKeysCached();
    const hit = [...known].find((k) => k.includes(`/${sha}`)) || [...objects].find((k) => k.includes(`/${sha}`));
    return json(res, 200, { exists: Boolean(hit) && objects.has(hit), key: hit || null });
  }

  // ② 读文件
  const key = safeKey(url.searchParams.get('k'));
  const name = String(url.searchParams.get('n') || path.basename(key)).replace(/[\r\n"]/g, '');
  const download = url.searchParams.get('download') === '1';

  // 音频预览：优先服务端代理 Navidrome 流（凭证不出服务器）；
  // 没配 internal 才回退 302（带着 Subsonic 凭证，见文件头「Navidrome 音频直通」注释）。
  // 下载不受影响，走下面的本地字节流。
  const audioExt = path.extname(key).toLowerCase();
  if (AUDIO_EXT.has(audioExt) && !download) {
    const sha = path.basename(key, audioExt);
    const proxyUrl = await navidromeProxyStreamUrl(sha);
    if (proxyUrl) return proxyAudioStream(req, res, proxyUrl);
    // 音频预览一律交给 Navidrome；映射缺失才回 404（navidrome-sync 每小时补一次）
    const target = await navidromeStreamUrl(sha);
    if (!target) throw new HttpError(404, '该音频还没同步到 Navidrome，稍后再试（每小时同步一次）');
    res.writeHead(302, { ...cors(req), Location: target, 'Cache-Control': 'no-store' });
    return res.end();
  }
  return serveObjectBytes(req, res, key, name, { download });
});

/**
 * 对象字节输出：Range/206（音频拖动、PDF 分段读）、ETag、attachment/inline。
 * files 路由和分享流路由共用；inline 时加 CSP sandbox，用户上传的 SVG/HTML 就带不动脚本。
 */
async function serveObjectBytes(req, res, key, name, { download = false } = {}) {
  const file = objPath(key);
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new HttpError(404, '文件还没入库');
  // 下载计数放在确认文件真实存在之后：此前在路由层就 +1，探测不存在的文件也计了数
  if (download) bumpStat(key, 'dl');

  const ext = path.extname(key).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: `"${path.basename(key, ext)}"`,
    'X-Tree2-Sha256': path.basename(key, ext),
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  };
  // 用户上传的 HTML/SVG 可能带脚本：inline 时关掉一切能力。
  // 注意别把 CSP sandbox 加到 PDF 上——Chrome 的查看器在 sandbox 的 iframe 里不渲染，
  // 分享落地页的 PDF 预览会整块空白。
  if (!download && ['.svg', '.html', '.htm'].includes(ext)) {
    headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
  }

  // Range：音频拖动、PDF 分段读都靠它
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    } else {
      start = Math.max(0, st.size - Number(range[2]));
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { ...cors(req), 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, { ...cors(req), ...headers });
  if (req.method === 'HEAD') return res.end();
  await pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
}

// 音频 → Navidrome 歌曲页深链接（播放器里的「在 Navidrome 打开」用）
route('GET', /^\/api\/tree2\/navidrome$/, async (req, res, _m, url) => {
  requireRead(req);
  const sha = String(url.searchParams.get('h') || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, 'h 需要 64 位 sha256');
  const cfg = await readJsonCached(ND_CFG_FILE, 'cfg', 'cfgMtime');
  const map = await readJsonCached(ND_MAP_FILE, 'map', 'mapMtime');
  const id = map && map[sha];
  if (!id) return json(res, 404, { ok: false });
  const base = (cfg && cfg.base) || '/music';
  // Navidrome 没有「单曲详情页」，能直达播放的只有分享页
  const shares = await readJsonCached(ND_SHARE_FILE, 'shares', 'sharesMtime');
  const shareId = shares && shares[sha];
  const shareUrl = shareId ? `${base}/share/${shareId}` : `${base}/app/`;
  return json(res, 200, { id, shareId: shareId || null, url: shareUrl });
});

// ---------------------------------------------------------------- 分享链接
// 链接是确定性的：/s/<存储键> —— 同一个文件对所有人都是同一个地址，无需注册表、无需接口。
// 音频已注册黑胶页（audio-map + share-map 都有映射）→ 直接 302；其余给「预览 + 下载」落地页。
// /s/<旧10位id> 仅兼容历史链接，只读。

const escHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) =>
  n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : n >= 1024 ? `${(n / 1024).toFixed(0)} KB`
    : `${n} B`;

function kindLabelOf(ext) {
  if (ext === '.pdf') return 'PDF 文档';
  if (['.doc', '.docx'].includes(ext)) return 'Word 文档';
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return '表格';
  if (ext === '.pptx') return '幻灯片';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) return '图片';
  if (AUDIO_EXT.has(ext)) return '音频';
  if (['.mp4', '.webm'].includes(ext)) return '视频';
  if (['.zip'].includes(ext)) return '压缩包';
  if (['.txt', '.md'].includes(ext)) return '文本';
  return '文件';
}

const SHARE_PAGE_CSS = `
 body{margin:0;padding:48px 18px;font:15px/1.75 "Microsoft YaHei","PingFang SC",sans-serif;color:#1e3a5f;
      background:radial-gradient(900px 340px at 50% -10%,#fff6e0,rgba(255,246,224,0) 70%),#fffaf0;min-height:100vh;box-sizing:border-box}
 main{max-width:640px;margin:0 auto}
 .card{background:#fff;border:1px solid #e8dcc3;border-radius:14px;padding:26px 26px 22px;box-shadow:0 8px 26px rgba(30,58,95,.06)}
 .brand{display:flex;align-items:center;gap:8px;font-weight:700;text-decoration:none;color:#1e3a5f;margin:0 0 18px;font-size:15px}
 .brand img{width:22px;height:22px}
 .kind{font-size:12px;color:#b08a3e;letter-spacing:.12em;margin:0 0 6px}
 h1{font-size:20px;line-height:1.45;margin:0 0 10px;word-break:break-all}
 .meta{color:#8a7f6e;font-size:13px;margin:0 0 20px}
 .down{display:block;text-align:center;padding:12px 20px;background:#1e3a5f;color:#fff;border-radius:10px;
       text-decoration:none;font-weight:700;font-size:15px;margin:0 0 6px}
 .down:hover{background:#16314f}
 .hint{color:#8a7f6e;font-size:12.5px;margin:8px 0 0}
 .preview{margin:18px 0 0}
 .preview img{max-width:100%;border-radius:10px;border:1px solid #e8dcc3;display:block;margin:0 auto}
 .preview iframe{width:100%;height:70vh;border:1px solid #e8dcc3;border-radius:10px;background:#f6f2e8}
 .preview video{width:100%;border-radius:10px;border:1px solid #e8dcc3;display:block}
 .preview audio{width:100%;margin:4px 0 0}
 .t2-landing-doc{min-height:120px;font-size:13px;color:#8a7f6e}
 .t2-landing-doc .docx-wrapper{overflow-x:auto}
 .crumb{color:#8a7f6e;font-size:12.5px;margin:0 0 10px;word-break:break-all}
 .crumb a{color:#1e3a5f}
 .folder-list{list-style:none;margin:18px 0 0;padding:0}
 .folder-list li{display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0e8d8;padding:9px 2px}
 .folder-list li:last-child{border-bottom:0}
 .folder-list .ico{flex:none;width:20px;text-align:center}
 .folder-list .f-name{flex:1;min-width:0;word-break:break-all}
 .folder-list .f-name a{color:#1e3a5f;text-decoration:none}
 .folder-list .f-name a:hover{text-decoration:underline}
 .folder-list .f-size{flex:none;color:#8a7f6e;font-size:12px}
 .folder-list .f-act{flex:none;display:flex;gap:8px}
 .folder-list .f-act a{font-size:12.5px;color:#1e3a5f;text-decoration:none;border:1px solid #d9cdb5;border-radius:8px;padding:3px 9px}
 .folder-list .f-act a:hover{background:#fffaf0}
 .foot{text-align:center;color:#b0a893;font-size:12px;margin:18px 0 0}
 .foot a{color:#8a7f6e}
`;

const SHARE_404_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>分享不存在</title></head><body style="margin:0;padding:64px 20px;font:15px/1.8 'Microsoft YaHei','PingFang SC',sans-serif;color:#1e3a5f;background:#fffaf0;text-align:center"><main style="max-width:480px;margin:0 auto"><h1 style="font-size:20px">分享不存在或已取消</h1><p style="color:#8a7f6e">链接可能输错了，或者文件已不在库里。</p><p><a href="/" style="color:#1e3a5f">回资料库看看 →</a></p></main></body></html>`;

/** key → {name, season}：从各届清单反查显示名（落地页标题/下载文件名用），缓存 30 秒。 */
const keyMetaCache = new Map();
async function keyMetaMap() {
  const hit = keyMetaCache.get('all');
  if (hit && Date.now() - hit.at < 30000) return hit.map;
  const map = new Map();
  const files = await fsp.readdir(cfg.data).catch(() => []);
  for (const f of files.filter((x) => /^\d{4}\.json$/.test(x))) {
    const year = f.slice(0, 4);
    const m = await readManifestFile(year).catch(() => null);
    if (!m) continue;
    const walk = (n) => {
      for (const c of n.c || []) {
        if (c.t === 'd') walk(c);
        else if (c.k) map.set(c.k, { name: c.n, season: year });
      }
    };
    for (const b of m.batches || []) walk(b.tree);
  }
  keyMetaCache.set('all', { map, at: Date.now() });
  return map;
}

/** 落地页：品牌头 + 文件信息 + 下载按钮 + 按类型的内嵌预览，纯静态无需 JS。 */
function sendShareLanding(req, res, { key, name, ext, size, dateLabel, season, visitsLabel = '', audioPending = false }) {
  const filesUrl = `/api/tree2/files/${encodeURIComponent(season)}?k=${encodeURIComponent(key)}&n=${encodeURIComponent(name)}`;
  // 客户端渲染类预览共用的净化器 + 容器
  const T2_CLEAN = '<script>function t2Clean(root){root.querySelectorAll(\'script,iframe,object,embed,link,meta\').forEach(function(e){e.remove()});[].forEach.call(root.querySelectorAll(\'*\'),function(e){[].slice.call(e.attributes).forEach(function(a){if(/^on/i.test(a.name))e.removeAttribute(a.name)})})}</script>';
  let preview = '';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
    preview = `<div class="preview"><img src="${escHtml(filesUrl)}" alt=""></div>`;
  } else if (ext === '.pdf') {
    // pdf.js 渲染：浏览器原生 iframe 在 iPhone Safari 上对 PDF 支持很差（常常只出第一页）
    preview =
      `<div class="preview"><div id="t2-pdfview" class="t2-landing-doc">PDF 预览加载中…</div></div>` +
      `<script src="/vendor/pdfjs-3.11.174/pdf.min.js"></` + `script>` +
      `<script>
(function () {
  var host = document.getElementById('t2-pdfview');
  var url = ${JSON.stringify(filesUrl)};
  if (!window.pdfjsLib) { host.textContent = 'PDF 预览组件加载失败，请用「下载文件」查看。'; return; }
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-3.11.174/pdf.worker.min.js';
  fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
    return pdfjsLib.getDocument({ data: buf, cMapUrl: '/vendor/pdfjs-3.11.174/cmaps/', cMapPacked: true, isEvalSupported: false }).promise;
  }).then(function (doc) {
    host.innerHTML = '';
    var info = document.createElement('p');
    info.style.cssText = 'color:#8a7f6e;font-size:12px;margin:0 0 10px';
    info.textContent = '共 ' + doc.numPages + ' 页 · 滚动查看';
    host.appendChild(info);
    var i = 1;
    var drawNext = function () {
      if (i > doc.numPages || !document.body.contains(host)) return Promise.resolve();
      var n = i++;
      return doc.getPage(n).then(function (page) {
        var v1 = page.getViewport({ scale: 1 });
        var holder = document.createElement('div');
        holder.style.cssText = 'margin:0 auto 14px;width:min(100%,760px)';
        var canvas = document.createElement('canvas');
        canvas.style.cssText = 'width:100%;display:block;border:1px solid #e8dcc3;border-radius:8px;background:#fff';
        host.appendChild(holder);
        holder.appendChild(canvas);
        var cssW = Math.min(host.clientWidth || 640, 760);
        var dpr = Math.min(Math.max(window.devicePixelRatio || 1, 2), 3);
        var scale = (cssW * dpr) / v1.width;
        if (v1.width * scale * (v1.height * scale) > 12e6) scale *= Math.sqrt(12e6 / (v1.width * scale * (v1.height * scale)));
        var vp = page.getViewport({ scale: scale });
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        return page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () {
          setTimeout(drawNext, 30);
        });
      });
    };
    return drawNext();
  }).catch(function () { host.textContent = 'PDF 预览失败，请用「下载文件」查看。'; });
})();
</` + `script>`;
  } else if (['.mp4', '.webm'].includes(ext)) {
    preview = `<div class="preview"><video controls preload="metadata" src="${escHtml(filesUrl)}"></video></div>`;
  } else if (AUDIO_EXT.has(ext)) {
    // files 对音频本来就是 302 到 Navidrome 流，这里直接挂 files 地址就能播
    preview =
      `<div class="preview"><audio controls preload="metadata" src="${escHtml(filesUrl)}"></audio>` +
      (audioPending ? `<p class="hint">音频正在同步到音乐库，同步完成后这个链接会直接打开在线播放页（最多一小时）。</p>` : ``) +
      `</div>`;
  } else if (['.docx', '.docm', '.dotx'].includes(ext)) {
    // Word：与资料库同一套 docx-preview 渲染
    preview =
      `<div class="preview"><div id="t2-preview" class="t2-landing-doc">正在渲染 Word 预览…</div></div>` +
      `<script src="/vendor/jszip-3.10.2/jszip.min.js"></` + `script>` +
      `<script src="/vendor/docx-preview-0.4.1/docx-preview.min.js"></` + `script>` +
      T2_CLEAN +
      `<script>
(function () {
  var host = document.getElementById('t2-preview');
  fetch(${JSON.stringify(filesUrl)}).then(function (r) { return r.blob(); }).then(function (b) {
    return docx.renderAsync(b, host, null, {
      className: 'docx', inWrapper: true, breakPages: true, ignoreWidth: false, ignoreHeight: false,
      ignoreFonts: false, renderHeaders: true, renderFooters: true, renderFootnotes: true,
      useBase64URL: true, experimental: true, ignoreLastRenderedPageBreak: true,
    });
  }).then(function () {
    t2Clean(host);
    host.querySelectorAll('.docx-wrapper').forEach(function (w) {
      w.style.cssText = 'background:#fff;padding:28px 20px;margin:0 auto;box-shadow:0 2px 14px rgba(30,58,95,.14);border-radius:8px';
    });
    if ((host.textContent || '').trim().length < 20 && !host.querySelector('img')) {
      var p = document.createElement('p');
      p.style.cssText = 'margin:10px;color:#8a7f6e;font-size:12.5px';
      p.textContent = '这份 Word 里几乎没有可渲染的文字（可能是扫描图或文本框排版），建议下载后查看。';
      host.appendChild(p);
    }
  }).catch(function () { host.textContent = '预览渲染失败，请下载后查看。'; });
})();
</` + `script>`;
  } else if (['.xlsx', '.xlsm', '.xls', '.csv', '.tsv'].includes(ext)) {
    // 表格：与资料库同一套 SheetJS，每个工作表一段
    preview =
      `<div class="preview"><div id="t2-preview" class="t2-landing-doc">正在渲染表格预览…</div></div>` +
      `<script src="/vendor/xlsx-0.20.3/xlsx.full.min.js"></` + `script>` +
      T2_CLEAN +
      `<script>
(function () {
  var host = document.getElementById('t2-preview');
  fetch(${JSON.stringify(filesUrl)}).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
    var wb = XLSX.read(buf, { type: 'array', sheetRows: 2001 });
    host.innerHTML = '';
    wb.SheetNames.forEach(function (name) {
      var h = document.createElement('h4');
      h.textContent = name;
      h.style.cssText = 'margin:14px 0 6px;font-size:13px;color:#8a7f6e';
      var t = document.createElement('template');
      t.innerHTML = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
      t2Clean(t.content);
      host.appendChild(h);
      host.appendChild(t.content);
    });
    host.querySelectorAll('table').forEach(function (tb) {
      tb.style.cssText = 'border-collapse:collapse;width:100%;background:#fff;font-size:12px';
      [].forEach.call(tb.querySelectorAll('td,th'), function (td) {
        td.style.cssText = 'border:1px solid #d9cdb5;padding:4px 7px;white-space:nowrap';
      });
    });
  }).catch(function () { host.textContent = '预览渲染失败，请下载后查看。'; });
})();
</` + `script>`;
  } else if (['.txt', '.md'].includes(ext)) {
    preview =
      `<div class="preview"><div id="t2-preview" class="t2-landing-doc">正在载入文本…</div></div>` +
      `<script>
(function () {
  var host = document.getElementById('t2-preview');
  fetch(${JSON.stringify(filesUrl)}).then(function (r) { return r.text(); }).then(function (t) {
    var pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;background:#fff;border:1px solid #e8dcc3;border-radius:10px;padding:16px;font:12.5px/1.7 ui-monospace,Consolas,monospace;max-height:70vh;overflow:auto';
    pre.textContent = t.slice(0, 200000);
    host.replaceChildren(pre);
  }).catch(function () { host.textContent = '预览载入失败，请下载后查看。'; });
})();
</` + `script>`;
  }
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>${escHtml(name)} · 文件分享</title>
<style>${SHARE_PAGE_CSS}</style></head><body><main>
<div class="card">
<a class="brand" href="/"><img src="/assets/paw.svg" alt="">备考资料导航 <small>TREE2</small></a>
<p class="kind">${escHtml(kindLabelOf(ext))} · 文件分享</p>
<h1>${escHtml(name)}</h1>
<p class="meta">${fmtBytes(size)} · ${escHtml(dateLabel)}${visitsLabel}</p>
<a class="down" href="${escHtml(filesUrl)}&download=1" download>下载文件</a>
<p class="hint">手机上长按上面的按钮也可以选择用其他应用打开。</p>
${preview}
</div>
<p class="foot"><a href="/">福建高考备考资料导航 tree2</a></p>
</main></body>
<script>
// 倍速记忆：黑胶页（music-custom.js）把倍速存在 localStorage['t2Rate']，
// 落地页的音频沿用同一倍速。这里只应用不切换——落地页没有倍速按钮，
// 之前留下的按钮逻辑操作的是不存在的 [data-rate] 元素，已裁掉。
(function () {
  var target = parseFloat(localStorage.getItem('t2Rate')) || 1;
  document.querySelectorAll('audio').forEach(function (a) { try { a.playbackRate = target; } catch (e) {} });
})();
</script></html>`;
  res.writeHead(200, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/** 清单里最新的届别年份（分享落地页对不在清单里的键兜底用，别硬编码 2026）。 */
async function latestManifestYear() {
  const files = await fsp.readdir(cfg.data).catch(() => []);
  const years = files.filter((f) => /^\d{4}\.json$/.test(f)).map((f) => f.slice(0, 4)).sort();
  return years[years.length - 1] || '';
}

// 确定性分享链接：/s/<存储键>
route('GET', /^\/s\/([0-9a-f]{2}\/[0-9a-f]{64}(?:\.[a-z0-9]{1,8})?)$/, async (req, res, [, key]) => {
  const st = await fsp.stat(objPath(key)).catch(() => null);
  if (!st || !st.isFile()) {
    res.writeHead(404, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(SHARE_404_HTML);
  }
  bumpStat(key, 'pv'); // 分享页访问计数
  const ext = path.extname(key).toLowerCase();
  const sha = path.basename(key, ext);
  const meta = (await keyMetaMap()).get(key);
  const name = (meta && meta.name) || path.basename(key);
  const season = (meta && meta.season) || (await latestManifestYear()) || '2026';

  if (AUDIO_EXT.has(ext)) {
    const am = (await readJsonCached(ND_MAP_FILE, 'map', 'mapMtime')) || {};
    const sm = (await readJsonCached(ND_SHARE_FILE, 'shares', 'sharesMtime')) || {};
    if (am[sha] && sm[sha]) {
      const ndCfg = await readJsonCached(ND_CFG_FILE, 'cfg', 'cfgMtime');
      res.writeHead(302, { ...cors(req), Location: `${(ndCfg && ndCfg.base) || '/music'}/share/${encodeURIComponent(sm[sha])}`, 'Cache-Control': 'no-store' });
      return res.end();
    }
  }
  return sendShareLanding(req, res, {
    key,
    name,
    ext,
    size: st.size,
    season,
    dateLabel: st.mtime.toISOString().slice(0, 10),
    audioPending: AUDIO_EXT.has(ext),
  });
});

// 旧版随机短链（历史链接兼容，只读；新链接一律用 /s/<存储键>）
route('GET', /^\/s\/([A-Za-z0-9]{4,64})$/, async (req, res, [, id]) => {
  const entry = (await loadShares()).find((s) => s.id === id);
  if (!entry) {
    res.writeHead(404, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(SHARE_404_HTML);
  }
  mutateShares(async (list) => list.map((s) => (s.id === entry.id ? { ...s, visits: (s.visits || 0) + 1 } : s))).catch(() => {});
  // 音频：沿用注册表里登记过的黑胶页映射；没有则走落地页（files 对音频本来就是 302 到 Navidrome 流）
  const nd = (await readJsonCached(SHARE_ND_FILE, 'shareNd', 'shareNdMtime')) || {};
  const info = nd[entry.id];
  const isAudio = AUDIO_EXT.has(entry.ext);
  if (isAudio && info && info.ndShareId) {
    const ndCfg = await readJsonCached(ND_CFG_FILE, 'cfg', 'cfgMtime');
    res.writeHead(302, { ...cors(req), Location: `${(ndCfg && ndCfg.base) || '/music'}/share/${encodeURIComponent(info.ndShareId)}`, 'Cache-Control': 'no-store' });
    return res.end();
  }
  return sendShareLanding(req, res, {
    key: entry.key,
    name: entry.name,
    ext: entry.ext,
    size: entry.size,
    season: entry.season,
    dateLabel: String(entry.createdAt || '').slice(0, 10),
    visitsLabel: ` · 已被查看 ${Number(entry.visits) + 1} 次`,
  });
});

// 确定性文件夹分享：/d/<届>/<批次/子目录…> —— 同一个文件夹所有人同一个链接。
// 落地页列出子文件夹（可继续点进去）与全部文件（预览/下载）。
const countNodeFiles = countTreeFiles;
const sumNodeBytes = sumTreeBytes;

function sendFolderLanding(req, res, { year, segs, node, batch }) {
  const enc = (segs2) => segs2.map((s) => encodeURIComponent(s)).join('/');
  const childLink = (childSegs) => `/d/${encodeURIComponent(year)}/${enc(childSegs)}`;
  const zipUrl = `/api/tree2/zip/${encodeURIComponent(year)}/${enc(segs)}`;
  const dirs = (node.c || []).filter((c) => c.t === 'd');
  const files = (node.c || []).filter((c) => c.t === 'f');

  // 面包屑：每一段都能点回上一层
  const crumb = segs
    .map((s, i) => (i === segs.length - 1 ? escHtml(s) : `<a href="${escHtml(childLink(segs.slice(0, i + 1)))}">${escHtml(s)}</a>`))
    .join(' <span style="color:#c9bda6">/</span> ');

  const rows = [
    ...dirs.map((d) => {
      const segs2 = [...segs, d.n];
      const nFiles = countNodeFiles(d);
      return `<li><span class="ico">📁</span><span class="f-name"><a href="${escHtml(childLink(segs2))}">${escHtml(d.n)}</a></span>` +
        `<span class="f-size">${nFiles} 个文件</span><span class="f-act"><a href="${escHtml(childLink(segs2))}">打开</a></span></li>`;
    }),
    ...files.map((f) => {
      const filesUrl = `/api/tree2/files/${encodeURIComponent(year)}?k=${encodeURIComponent(f.k)}&n=${encodeURIComponent(f.n)}`;
      return `<li><span class="ico">📄</span><span class="f-name"><a href="${escHtml(filesUrl)}" target="_blank" rel="noopener">${escHtml(f.n)}</a></span>` +
        `<span class="f-size">${fmtBytes(f.s || 0)}</span><span class="f-act">` +
        `<a href="${escHtml(filesUrl)}" target="_blank" rel="noopener">预览</a>` +
        `<a href="${escHtml(filesUrl)}&download=1" download>下载</a></span></li>`;
    }),
  ].join('');

  const total = fmtBytes(sumNodeBytes(node));
  const batchMeta = segs.length === 1 && batch ? ` · ${escHtml(String(batch.type || ''))}${batch.date ? ' · ' + escHtml(String(batch.date)) : ''}` : '';
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>${escHtml(segs[segs.length - 1])} · 文件夹分享</title>
<style>${SHARE_PAGE_CSS}</style></head><body><main>
<div class="card">
<a class="brand" href="/"><img src="/assets/paw.svg" alt="">备考资料导航 <small>TREE2</small></a>
<p class="crumb"><a href="/">资料库</a> / ${crumb}</p>
<p class="kind">文件夹分享 · ${escHtml(year)} 届${batchMeta}</p>
<h1>${escHtml(segs[segs.length - 1])}</h1>
<p class="meta">${countNodeFiles(node)} 个文件${dirs.length ? ` · ${dirs.length} 个子文件夹` : ''} · 共 ${total}</p>
<a class="down" href="${escHtml(zipUrl)}">⬇ 打包下载全部（zip）</a>
<p class="hint">整包是未压缩 zip，与资料库逐一对应；单个文件也可以在下面的列表里分别预览/下载，点子文件夹可以继续往下看。</p>
<ul class="folder-list">${rows || '<li><span class="f-name" style="color:#8a7f6e">这是个空文件夹</span></li>'}</ul>
</div>
<p class="foot"><a href="/">福建高考备考资料导航 tree2</a></p>
</main></body></html>`;
  res.writeHead(200, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

route('GET', /^\/d\/([^/]+)\/(.+)$/, async (req, res, m) => {
  requireRead(req);
  const year = safeYear(decodeURIComponent(m[1]));
  let segs;
  try {
    segs = decodeURIComponent(m[2]).split('/').map((s) => s.trim()).filter(Boolean);
  } catch {
    throw new HttpError(400, '路径不合法');
  }
  if (!segs.length || segs.some((s) => !s || s === '.' || s === '..' || /[\\]/.test(s))) {
    res.writeHead(404, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(SHARE_404_HTML);
  }
  const found = await findManifestFolder(year, segs);
  if (!found) {
    res.writeHead(404, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(SHARE_404_HTML);
  }
  const { node, batch } = found;
  // 碰到的是文件 → 跳到对应文件分享页
  if (node.t === 'f') {
    res.writeHead(302, { ...cors(req), Location: `/s/${encodeURIComponent(node.k)}`, 'Cache-Control': 'no-store' });
    return res.end();
  }
  return sendFolderLanding(req, res, { year, segs, node, batch });
});

// ---------------- 文件夹打包下载（STORE zip，零依赖流式） ----------------
// STORE 模式不压缩：zip 长度完全可预计算，Content-Length 准确，进度条可用；
// mp3/pdf 本身已是压缩格式，STORE 也几乎不损失体积。
const ZIP_CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32File = (file) =>
  new Promise((resolve, reject) => {
    let c = -1;
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => {
      for (const b of chunk) c = (c >>> 8) ^ ZIP_CRC_TABLE[(c ^ b) & 255];
    });
    stream.on('end', () => resolve((c ^ -1) >>> 0));
    stream.on('error', reject);
  });
// 对象按内容寻址、不可变：同一存储键的 CRC 永远一样，缓存住省得每次打包下载都全量重读
const CRC_CACHE = new Map();
const crc32FileCached = (file, storageKey) => {
  const hit = CRC_CACHE.get(storageKey);
  if (hit !== undefined) return Promise.resolve(hit);
  return crc32File(file).then((crc) => {
    if (CRC_CACHE.size > 5000) {
      // 封顶时只淘汰最早插入的一半（Map 保持插入序），全清会惊群式重算所有 CRC
      for (const oldest of [...CRC_CACHE.keys()].slice(0, CRC_CACHE.size - 2500)) CRC_CACHE.delete(oldest);
    }
    CRC_CACHE.set(storageKey, crc);
    return crc;
  });
};
const zipDosTime = (d) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

// /d/ 与 zip 两条路由共用的「按路径找清单节点」
async function findManifestFolder(year, segs) {
  const manifest = await readManifestFile(year).catch(() => null);
  const batch = manifest && (manifest.batches || []).find((b) => b.name === segs[0]);
  if (!batch) return null;
  let node = batch.tree;
  for (const s of segs.slice(1)) {
    node = (node.c || []).find((c) => c.t === 'd' && c.n === s);
    if (!node) return null;
  }
  return { node, batch };
}

route('GET', /^\/api\/tree2\/zip\/([^/]+)\/(.+)$/, async (req, res, m) => {
  requireRead(req);
  const year = safeYear(decodeURIComponent(m[1]));
  let segs;
  try {
    segs = decodeURIComponent(m[2]).split('/').map((s) => s.trim()).filter(Boolean);
  } catch {
    throw new HttpError(400, '路径不合法');
  }
  const found = await findManifestFolder(year, segs);
  if (!found) throw new HttpError(404, '文件夹不存在或已移除');
  const { node, batch } = found;

  // 收集全部文件（递归），统计真实大小
  const entries = [];
  const walk = (n, rel) => {
    for (const c of n.c || []) {
      if (c.t === 'd') walk(c, rel + c.n + '/');
      else if (c.k) entries.push({ rel: rel + c.n, k: c.k });
    }
  };
  walk(node, '');
  if (!entries.length) throw new HttpError(404, '空文件夹没有可打包的内容');
  let totalUncompressed = 0;
  for (const e of entries) {
    const st = await fsp.stat(objPath(e.k)).catch(() => null);
    if (!st || !st.isFile()) throw new HttpError(404, '有文件还没入库，无法打包');
    e.size = st.size;
    e.abs = objPath(e.k);
    totalUncompressed += st.size;
  }
  if (totalUncompressed > 1024 * 1024 * 1024) throw new HttpError(413, '文件夹太大（打包上限 1 GB）');

  // STORE 格式长度完全确定：本地头 30+名，数据 size，中央头 46+名，EOCD 22
  let dataOffset = 0;
  let centralSize = 22;
  for (const e of entries) {
    e.nameBuf = Buffer.from(e.rel, 'utf8');
    e.localHeaderLen = 30 + e.nameBuf.length;
    e.centralLen = 46 + e.nameBuf.length;
    centralSize += e.centralLen;
    dataOffset += e.localHeaderLen + e.size;
  }
  const zipTotal = dataOffset + centralSize;
  const { time: dosT, date: dosD } = zipDosTime(new Date());
  const zipName = `${year}-${segs[segs.length - 1]}.zip`;

  res.writeHead(200, {
    ...cors(req),
    'Content-Type': 'application/zip',
    'Content-Length': String(zipTotal),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();

  const writeBuf = (b) => new Promise((ok) => { if (res.write(b)) ok(); else res.once('drain', ok); });
  const pipeFile = (file) => new Promise((ok, no) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => { if (!res.write(c)) { stream.pause(); res.once('drain', () => stream.resume()); } });
    stream.on('end', ok);
    stream.on('error', no);
  });

  let offset = 0;
  const central = [];
  for (const e of entries) {
    const crc = await crc32FileCached(e.abs, e.k);
    const h = Buffer.alloc(30);
    h.write('PK\x03\x04', 0, 'latin1');
    h.writeUInt16LE(20, 4);       // 版本
    h.writeUInt16LE(0x0800, 6);   // 标志：UTF-8 文件名
    h.writeUInt16LE(0, 8);        // STORE 不压缩
    h.writeUInt16LE(dosT, 10);
    h.writeUInt16LE(dosD, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(e.size, 18);
    h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(e.nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    await writeBuf(h);
    await writeBuf(e.nameBuf);
    await pipeFile(e.abs);
    central.push({ nameBuf: e.nameBuf, crc, size: e.size, offset, dosT, dosD });
    offset += e.localHeaderLen + e.size;
  }
  const cdStart = offset;
  for (const c of central) {
    const cd = Buffer.alloc(46);
    cd.write('PK\x01\x02', 0, 'latin1');
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(c.dosT, 12);
    cd.writeUInt16LE(c.dosD, 14);
    cd.writeUInt32LE(c.crc, 16);
    cd.writeUInt32LE(c.size, 20);
    cd.writeUInt32LE(c.size, 24);
    cd.writeUInt16LE(c.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(c.offset, 42);
    await writeBuf(cd);
    await writeBuf(c.nameBuf);
  }
  const eocd = Buffer.alloc(22);
  eocd.write('PK\x05\x06', 0, 'latin1');
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(dataOffset, 16);
  eocd.writeUInt16LE(0, 20);
  await writeBuf(eocd);
  res.end();
});

// ---------------- 下载/分享计数 ----------------
// 内存累计，每 60 秒落一次盘；重启丢失最多 1 分钟的计数
const STATS_FILE = path.join(SHARES_DIR, 'download-stats.json');
const statsMem = new Map();
let statsDirty = false;
fsp.readFile(STATS_FILE, 'utf8').then((raw) => {
  const j = JSON.parse(raw);
  for (const [k, v] of Object.entries(j)) statsMem.set(k, { dl: v.dl || 0, pv: v.pv || 0 });
}).catch(() => {});
setInterval(() => {
  if (!statsDirty) return;
  const o = {};
  for (const [k, v] of statsMem) o[k] = v;
  fsp.writeFile(`${STATS_FILE}.tmp`, JSON.stringify(o, null, 1)).then(() => fsp.rename(`${STATS_FILE}.tmp`, STATS_FILE)).then(() => { statsDirty = false; }).catch(() => {});
}, 60000);
function bumpStat(key, field) {
  const e = statsMem.get(key) || { dl: 0, pv: 0 };
  e[field] = (e[field] || 0) + 1;
  statsMem.set(key, e);
  statsDirty = true;
}

route('GET', /^\/api\/tree2\/stats$/, async (req, res) => {
  requireWrite(req); // 管理数据，跟写接口同一把口令
  const keyMeta = await keyMetaMap();
  const rows = [];
  for (const [k, v] of statsMem) {
    const meta = keyMeta.get(k);
    rows.push({ key: k, name: (meta && meta.name) || k, season: (meta && meta.season) || '', downloads: v.dl, visits: v.pv });
  }
  rows.sort((a, b) => b.downloads * 1e9 + b.visits - (a.downloads * 1e9 + a.visits));
  json(res, 200, { rows: rows.slice(0, 50) });
});

// ---------------- 删除/下架（管理，要口令） ----------------
// 从清单移除批次/子目录/单个文件；对象本体保留在 objects/（内容寻址，可能被别的键引用）
route('POST', /^\/api\/tree2\/remove$/, async (req, res) => {
  requireWrite(req);
  const body = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
  const year = safeYear(body.year);
  const folder = String(body.path || '').replace(/^\/+|\/+$/g, '');
  const name = body.name ? String(body.name).split(/[\\/]/).pop() : '';
  const segs = folder.split('/').filter(Boolean);
  if (!segs.length) throw new HttpError(400, 'path 不合法');

  const file = path.join(cfg.data, `${year}.json`);
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (!raw) throw new HttpError(404, '清单不存在');
  const manifest = JSON.parse(raw);
  const batch = (manifest.batches || []).find((b) => b.name === segs[0]);
  if (!batch) throw new HttpError(404, '批次不存在');

  let parentNode = null;
  let node = batch.tree;
  for (const s2 of segs.slice(1)) {
    parentNode = node;
    node = (node.c || []).find((c) => c.t === 'd' && c.n === s2);
    if (!node) throw new HttpError(404, '子目录不存在');
  }

  // 收集子树里所有带存储键的文件节点（过滤前），供清单写盘后的引用检查做垃圾回收
  const collectKeys = (n, out = []) => {
    for (const c of n.c || []) {
      if (c.t === 'd') collectKeys(c, out);
      else if (c.k) out.push(c.k);
    }
    return out;
  };
  let removedFiles = 0;
  let removedName = '';
  let removedKeys = [];
  if (name) {
    const victim = (node.c || []).find((c) => c.t === 'f' && c.n === name);
    removedKeys = victim && victim.k ? [victim.k] : [];
    const before = (node.c || []).length;
    node.c = (node.c || []).filter((c) => !(c.t === 'f' && c.n === name));
    removedFiles = before - (node.c || []).length;
    if (!removedFiles) throw new HttpError(404, '文件不存在');
    removedName = name;
  } else if (parentNode) {
    removedFiles = countTreeFiles(node);
    removedKeys = collectKeys(node);
    parentNode.c = (parentNode.c || []).filter((c) => c.n !== segs[segs.length - 1]);
    removedName = segs[segs.length - 1];
  } else {
    removedFiles = countTreeFiles(node);
    removedKeys = collectKeys(node);
    manifest.batches = manifest.batches.filter((b) => b.name !== segs[0]);
    removedName = segs[0];
  }

  // 重新统计
  recalcManifestStats(manifest);

  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2));
  await fsp.rename(tmp, file);
  manifestCache.delete(year);
  // —— 垃圾回收：被移除的存储键若已无引用，连对象本体一起删 ——
  // 引用面：所有届的清单（^\d{4}\.json$，刚写盘的当前届已不含本次移除的条目，
  // 其余届可能有同内容去重条目）+ audio-map / share-map / shares（键为裸 sha256）。
  // 用原文包含做保守判断：宁可少删，不可误删还在用的对象。
  // uplog 只是历史日志，不算引用；preview-cache 不归本服务管，不动。
  const deletedObjects = [];
  if (removedKeys.length) {
    const refChunks = [];
    for (const f of (await fsp.readdir(cfg.data)).filter((f) => /^\d{4}\.json$/.test(f))) {
      refChunks.push(await fsp.readFile(path.join(cfg.data, f), 'utf8').catch(() => ''));
    }
    for (const f of [ND_MAP_FILE, ND_SHARE_FILE, SHARES_FILE]) {
      refChunks.push(await fsp.readFile(f, 'utf8').catch(() => ''));
    }
    const refs = refChunks.join('\n');
    for (const k of removedKeys) {
      const sha = path.basename(k, path.extname(k));
      if (!sha || refs.includes(sha)) continue;
      try { await fsp.unlink(objPath(k)); deletedObjects.push(k); invalidateObjectKeys(); } catch { /* 本体可能本来就不在 */ }
    }
  }
  // 删除事件也要写进 uplog，和改名对称：清单是从本地目录全量重扫派生的，
  // 只改服务器清单不动本地文件的话，下一次发布会把删掉的东西原样加回来。
  // tree2-publish 开头读到这条就把本地对应文件移进下架回收区，重扫自然没有它。
  await appendUplog({
    type: 'remove',
    season: year,
    kind: name ? 'file' : segs.length > 1 ? 'dir' : 'batch',
    path: name ? `${segs.join('/')}/${name}` : segs.join('/'),
    files: removedFiles,
    deletedObjects,
    actor: actorOf(req),
    at: new Date().toISOString(),
  });
  json(res, 200, { ok: true, removedFiles, removedName, deletedObjects });
});

// ---------------- 重命名（管理，要口令） ----------------
// 三种目标，body 统一 { year, path, name?, newName }：
//   name 给了          → 重命名 path 目录下的文件
//   path 多级          → 重命名最后一级子目录
//   path 只有一级      → 重命名整个批次（b.name + tree.n 同步改）
// 只改清单里的名字；对象本体是内容寻址，k 不变、不用动。
route('POST', /^\/api\/tree2\/rename$/, async (req, res) => {
  requireWrite(req);
  const body = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
  const year = safeYear(body.year);
  const folder = String(body.path || '').replace(/^\/+|\/+$/g, '');
  const newName = String(body.newName || '').trim();
  const name = body.name ? String(body.name).split(/[\\/]/).pop() : '';
  const segs = folder.split('/').filter(Boolean);
  if (!segs.length) throw new HttpError(400, 'path 不合法');
  if (!newName || /[\\/]/.test(newName) || newName === '.' || newName === '..' || /[\x00-\x1f]/.test(newName)) {
    throw new HttpError(400, '新名字不合法（不能为空、不能带斜杠）');
  }
  if (newName.length > 120) throw new HttpError(400, '新名字太长（≤120 字）');

  const file = path.join(cfg.data, `${year}.json`);
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (!raw) throw new HttpError(404, '清单不存在');
  const manifest = JSON.parse(raw);
  const batch = (manifest.batches || []).find((b) => b.name === segs[0]);
  if (!batch) throw new HttpError(404, '批次不存在');

  let renamed = '';
  if (name) {
    // 文件重命名：扩展名不能变（存储键 = sha256+扩展名，改了就对不上对象）
    const oldExt = (/\.[a-z0-9]{1,8}$/i.exec(name) || [''])[0].toLowerCase();
    const newExt = (/\.[a-z0-9]{1,8}$/i.exec(newName) || [''])[0].toLowerCase();
    if (oldExt !== newExt) throw new HttpError(400, '扩展名不能改（会破坏存储键），只改名字部分');
    let node = batch.tree;
    for (const s2 of segs.slice(1)) {
      node = (node.c || []).find((c) => c.t === 'd' && c.n === s2);
      if (!node) throw new HttpError(404, '子目录不存在');
    }
    const target = (node.c || []).find((c) => c.t === 'f' && c.n === name);
    if (!target) throw new HttpError(404, '文件不存在');
    if ((node.c || []).some((c) => c.t === 'f' && c.n === newName && c !== target)) {
      throw new HttpError(409, '同级已有同名文件');
    }
    target.n = newName;
    renamed = 'file';
  } else if (segs.length > 1) {
    // 子目录重命名
    let parent = batch.tree;
    for (const s2 of segs.slice(1, -1)) {
      parent = (parent.c || []).find((c) => c.t === 'd' && c.n === s2);
      if (!parent) throw new HttpError(404, '子目录不存在');
    }
    const dirName = segs[segs.length - 1];
    const target = (parent.c || []).find((c) => c.t === 'd' && c.n === dirName);
    if (!target) throw new HttpError(404, '子目录不存在');
    if ((parent.c || []).some((c) => c.t === 'd' && c.n === newName && c !== target)) {
      throw new HttpError(409, '同级已有同名目录');
    }
    target.n = newName;
    renamed = 'dir';
  } else {
    // 批次重命名
    if ((manifest.batches || []).some((b) => b.name === newName && b !== batch)) {
      throw new HttpError(409, '已有同名批次');
    }
    const oldName = batch.name;
    batch.name = newName;
    if (batch.tree && batch.tree.n === oldName) batch.tree.n = newName;
    // 阶段/类型/日期都从名字推导：改名后必须重算，否则前端按 stage 分组会挂在旧阶段下
    batch.stage = t2StageOf(newName);
    batch.type = t2TypeOf(newName);
    // 日期从名字里提（如 2026.12 / 2025-8 / 2026年3月）；此前正则写成 d{4}（少了反斜杠），
    // 永远匹配不上，每次重命名都把 date 清空
    batch.date = (/(\d{4}[.\-年]\d{1,2})/.exec(newName) || [, ''])[1];
    renamed = 'batch';
  }

  // 重新统计（与 remove 同款；此前漏了 totals，首页合计会停在旧数字）
  recalcManifestStats(manifest);

  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2));
  await fsp.rename(tmp, file);
  manifestCache.delete(year);
  // 改名事件写进 uplog：tree2-publish 开头会把它应用到本地文件夹，
  // 否则下次发布会用本地旧名把云端新名覆盖回去
  await appendUplog({ type: 'rename', season: year, kind: renamed, path: folder, name: name || '', newName, actor: actorOf(req), at: new Date().toISOString() });
  json(res, 200, { ok: true, kind: renamed, newName });
});

// ---------------- 预建空批次（admin：先建批次再发顾客口令） ----------------
route('POST', /^\/api\/tree2\/batch$/, async (req, res) => {
  requireWrite(req);
  const body = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
  const year = safeYear(body.year);
  const name = String(body.name || '').trim().replace(/^\/+|\/+$/g, '');
  if (!name) throw new HttpError(400, '批次名不能为空');
  if (/[\\/]/.test(name)) throw new HttpError(400, '批次名不能带斜杠');
  if (name.length > 120) throw new HttpError(400, '批次名太长（≤120 字）');
  const file = path.join(cfg.data, year + '.json');
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (!raw) throw new HttpError(404, '这一届的清单还没生成');
  const m = JSON.parse(raw);
  m.batches = m.batches || [];
  if (m.batches.some((b) => b.name === name)) return json(res, 200, { ok: true, created: false });
  m.batches.push({
    name,
    stage: t2StageOf(name),
    type: t2TypeOf(name),
    date: (/(\d{4}[.\-年]\d{1,2})/.exec(name) || [, ''])[1],
    files: 0, dirs: 0, bytes: 0, subj: [],
    tree: { n: name, t: 'd', c: [] },
  });
  m.batches.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
  recalcManifestStats(m); // 统一走共享实现（batch / attach / remove / rename 同款）
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(m, null, 2));
  await fsp.rename(tmp, file);
  manifestCache.delete(year);
  json(res, 200, { ok: true, created: true, stage: t2StageOf(name) });
});

// ---------------- 顾客口令管理（admin） ----------------
route('GET', /^\/api\/tree2\/ctoken$/, async (req, res) => {
  requireWrite(req);
  const list = await loadCTokens();
  json(res, 200, {
    daily: dailyToken(todayCN()),
    tokens: list.map((r) => ({ id: r.id, token: r.token, batches: r.batches, maxUses: r.maxUses || null, uses: r.uses || 0, expiresAt: r.expiresAt || null, createdAt: r.createdAt })),
  });
});

route('POST', /^\/api\/tree2\/ctoken$/, async (req, res) => {
  requireWrite(req);
  const body = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
  const batches = Array.isArray(body.batches) ? body.batches.map((b) => String(b).slice(0, 120)).filter(Boolean) : [];
  if (!batches.length) throw new HttpError(400, '必须指定至少一个批次');
  if (new Set(batches).size !== batches.length) throw new HttpError(400, '批次重复');
  const maxUses = body.maxUses ? Math.min(10000, Math.max(1, Number(body.maxUses) | 0)) : null;
  const ttlHours = body.ttlHours ? Math.min(8760, Math.max(1, Number(body.ttlHours) | 0)) : null;
  const rec = {
    id: randomBytes(6).toString('hex'),
    token: randomBytes(16).toString('hex'),
    batches, maxUses, uses: 0,
    expiresAt: ttlHours ? Date.now() + ttlHours * 3600 * 1000 : null,
    createdAt: new Date().toISOString(),
  };
  const list = await loadCTokens();
  list.push(rec);
  await saveCTokens(list);
  json(res, 200, { token: rec.token, id: rec.id, expiresAt: rec.expiresAt });
});

route('DELETE', /^\/api\/tree2\/ctoken\/([0-9a-f]{12})$/, async (req, res, [, id]) => {
  requireWrite(req);
  const list = await loadCTokens();
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) throw new HttpError(404, '这个口令不存在');
  await saveCTokens(next);
  json(res, 200, { ok: true });
});

// 顾客口令校验（公开，只返回非敏感信息；token 是 128-bit 随机值，无法枚举）
route('GET', /^\/api\/tree2\/ctoken-check$/, async (req, res, m, url) => {
  const t = String(url.searchParams.get('token') || '');
  if (!t) return json(res, 404, { error: '口令无效' });
  const list = await loadCTokens();
  const rec = list.find((r) => r.token === t);
  if (rec) {
    if (rec.expiresAt && Date.now() > rec.expiresAt) return json(res, 403, { error: '该口令已过有效期' });
    if (rec.maxUses && (rec.uses || 0) >= rec.maxUses) return json(res, 403, { error: '该口令的可用次数已用完' });
    // once 口令绑定的批次可能分散在不同届：扫清单标注每批次的届别
    const batchYear = [];
    for (const y of (await fsp.readdir(cfg.data)).filter((f) => /^\d{4}\.json$/.test(f)).map((f) => f.slice(0, 4))) {
      const m2 = JSON.parse(await fsp.readFile(path.join(cfg.data, y + '.json'), 'utf8').catch(() => 'null'));
      for (const b of (m2.batches || [])) if (rec.batches.includes(b.name)) batchYear.push({ name: b.name, year: y });
    }
    return json(res, 200, { kind: 'once', batches: rec.batches, batchYear, remaining: rec.maxUses ? rec.maxUses - (rec.uses || 0) : null, expiresAt: rec.expiresAt });
  }
  if (t === dailyToken(todayCN())) return json(res, 200, { kind: 'daily', batches: null });
  return json(res, 404, { error: '口令无效' });
});

// ---------------------------------------------------------------- 接口：上传

route('PUT', /^\/api\/tree2\/files\/([^/]+)\/part$/, async (req, res, [, year], url) => {
  await classifyWrite(req); // admin 主口令 / daily / once 均可传分片
  safeYear(year);
  const key = safeKey(url.searchParams.get('k'));
  const i = Number(url.searchParams.get('i'));
  const n = Number(url.searchParams.get('n') || 1);
  if (!Number.isInteger(i) || i < 0 || i >= n || n < 1 || n > 4096) throw new HttpError(400, '分片序号不合法');

  const dir = path.join(TMP, key.replace('/', '_'));
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${i}.part`);
  const limit = cfg.maxPart + 1024;
  let got = 0;
  let overflow = false;
  const hash = createHash('sha256');
  const out = fs.createWriteStream(target);
  req.on('data', (c) => {
    got += c.length;
    if (got > limit) {
      overflow = true;
      req.destroy();
    } else hash.update(c);
  });
  try {
    await pipeline(req, out);
  } catch {
    await fsp.rm(target, { force: true });
    throw new HttpError(overflow ? 413 : 400, overflow ? '分片太大（上限 8 MB）' : '上传中断');
  }
  if (overflow) throw new HttpError(413, '分片太大（上限 8 MB）');
  json(res, 200, { index: i, size: got, sha256: hash.digest('hex') });
});

route('POST', /^\/api\/tree2\/files\/([^/]+)\/commit$/, async (req, res, [, year]) => {
  const auth = await classifyWrite(req); // admin 主口令 / daily / once
  safeYear(year);
  const body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
  const key = safeKey(body.key);
  const expect = String(body.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expect)) throw new HttpError(400, 'sha256 不合法');
  // parts 必须显式给出且是真正的整数（秒传为 0）：不做 Number 强转，
  // 否则 Number(null)===0、Number('')===0、Number([])===0 都会被当成秒传
  if (body.parts == null) throw new HttpError(400, '缺少 parts（分片数，秒传传 0）');
  if (!Number.isInteger(body.parts) || body.parts < 0 || body.parts > 4096) throw new HttpError(400, '分片数不合法');
  const parts = body.parts;
  if (auth.kind === 'once') {
    const firstSeg = String(body.folder || '').split('/').filter(Boolean)[0] || '';
    if (!auth.rec.batches.includes(firstSeg)) {
      throw new HttpError(403, '该口令只能上传到：' + auth.rec.batches.join('、'));
    }
  }

  // 存储键 = sha256 + 扩展名：键与声明的哈希必须一致，否则挂进清单的名实不符
  if (path.basename(key, path.extname(key)) !== expect) {
    throw new HttpError(400, '存储键与 sha256 不一致（key 应为 <前2位>/<sha256>.<ext>）');
  }

  // once 口令的秒传加一道归属校验：内容必须已在口令可用的批次里挂过清单。
  // 否则拿着公开清单里的存储键（sha 是公开的）就能把库里任何文件「引用」进自己的
  // 批次并任意改名——秒传只该省流量，不该变成跨批次引用任意内容的通道。
  // daily 口令本身就能把任意字节传进任意批次，秒传不扩大其权限，不加限制。
  if (parts === 0 && auth.kind === 'once') {
    const m = await readManifestFile(year).catch(() => null);
    const owned = new Set();
    const walk = (node) => { for (const c of node.c || []) { if (c.t === 'd') walk(c); else if (c.k) owned.add(c.k); } };
    for (const b of (m && m.batches) || []) if (auth.rec.batches.includes(b.name)) walk(b.tree);
    if (!owned.has(key)) throw new HttpError(409, '秒传受限：该内容不在你可用批次的清单里，请按分片上传');
  }

  const final = objPath(key);
  await fsp.mkdir(path.dirname(final), { recursive: true });

  let got = expect;
  if (parts === 0) {
    // 秒传：客户端探测到内容已在库，跳过分片直接挂清单。
    // 内容寻址的键即哈希，对象存在就等于内容匹配；不存在则让客户端走分片上传。
    const existing = await fsp.stat(final).catch(() => null);
    if (!existing || !existing.isFile()) {
      throw new HttpError(409, '秒传失败：该内容还不在库里，请按分片上传');
    }
  } else {
    const dir = path.join(TMP, key.replace('/', '_'));
    const pieces = [];
    for (let i = 0; i < parts; i++) {
      const p = path.join(dir, `${i}.part`);
      const st = await fsp.stat(p).catch(() => null);
      if (!st) throw new HttpError(409, `缺第 ${i} 片，请重传`);
      pieces.push(p);
    }

    // 边合并边算哈希：整个文件不进内存
    const tmpOut = `${final}.${process.pid}.tmp`;
    const out = fs.createWriteStream(tmpOut);
    const hash = createHash('sha256');
    for (const p of pieces) {
      await new Promise((resolve, reject) => {
        const r = fs.createReadStream(p);
        r.on('data', (c) => hash.update(c));
        r.on('error', reject);
        r.on('end', resolve);
        r.pipe(out, { end: false });
      });
    }
    await new Promise((r) => out.end(r));
    got = hash.digest('hex');
    if (got !== expect) {
      await fsp.rm(tmpOut, { force: true });
      throw new HttpError(422, '内容校验失败：合并后的 sha256 与上传前不一致');
    }
    await fsp.rename(tmpOut, final);
    await fsp.rm(dir, { recursive: true, force: true });
    invalidateObjectKeys(); // 新对象入盘，秒传探测缓存别再报「不存在」
  }

  // 把文件挂到清单里：folder 是批次目录（如 "A1福州一检（2025.8）…"），name 是文件名
  const attached = await attachToManifest(year, key, { ...body, sha256: got }, actorOf(req));
  // 写完清单再清缓存：之前放在 attach 之前，并发请求会把旧清单重新填进 30 秒缓存，
  // 首页「已入库」的绿点会跟着延迟半分钟
  manifestCache.delete(year);
  // once 顾客口令：入库成功才计一次
  if (auth.kind === 'once') {
    const list = await loadCTokens();
    const rec = list.find((r) => r.id === auth.rec.id);
    if (rec) { rec.uses = (rec.uses || 0) + 1; await saveCTokens(list); }
  }

  json(res, 200, { key, sha256: got, size: body.size || null, attached });
});

async function readBody(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new HttpError(413, '请求体太大');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// 批次元数据规则与 build-tree2-index.mjs 保持一致（新建批次时现场推导）
const T2_SUBJECTS = ['语文', '数学', '英语', '日语', '物理', '化学', '生物', '政治', '历史', '地理'];
const t2StageOf = (batchName) => {
  const first = batchName.slice(0, 1).toUpperCase();
  return 'ABCDEFGHZ'.includes(first) ? first : '省外';
};
const t2TypeOf = (batchName) => {
  const st = t2StageOf(batchName);
  if (st === 'Z') return '学科专练';
  if (st === 'H') return '考前模拟';
  for (const t of ['省质检', '一模', '二检', '三检', '一检', '开学考', '联考', '期中', '期末', '月考', '质检', '模拟', '测评']) {
    if (batchName.includes(t)) return t;
  }
  return '考试';
};

async function attachToManifest(year, key, body, actor = '') {
  const file = path.join(cfg.data, `${year}.json`);
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (!raw) return false;
  const m = JSON.parse(raw);
  const folder = String(body.folder || '').replace(/^\/+|\/+$/g, '');
  const name = String(body.name || '').split(/[\\/]/).pop();
  if (!name) return false;
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(name) || [, ''])[1].toLowerCase();
  const size = Number(body.size) || 0;

  const segs = folder ? folder.split('/') : [];
  let parent = null;
  let batch = null;
  if (!segs.length) {
    // folder 为空说明没指定批次：对象字节已入库，但清单无处可挂。
    // 如实返回 false —— 旧实现把文件挂到一个「合成父节点」（不落在任何 batch.tree 上），
    // 写盘后文件静默丢失却仍报 attached:true。
    return false;
  } else {
    // 批次不存在就现场建一个（元数据从名字推导，规则同 build-tree2-index）
    batch = (m.batches || []).find((b) => b.name === segs[0]);
    if (!batch) {
      const bn = segs[0];
      batch = {
        name: bn,
        stage: t2StageOf(bn),
        type: t2TypeOf(bn),
        date: (/(\d{4}[.\-年]\d{1,2})/.exec(bn) || [, ''])[1],
        files: 0,
        dirs: 0,
        bytes: 0,
        subj: [],
        tree: { n: bn, t: 'd', c: [] },
      };
      m.batches.push(batch);
      m.batches.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
      batch = m.batches.find((b) => b.name === bn); // 排序后重新拿到同一个对象
    }
    parent = batch.tree;
    // 中间子目录不存在就一路建（例如 批次/听力）
    for (const s of segs.slice(1)) {
      let sub = (parent.c || []).find((c) => c.t === 'd' && c.n === s);
      if (!sub) {
        sub = { n: s, t: 'd', c: [] };
        parent.c.push(sub);
        parent.c.sort((a, b) => (a.t === b.t ? a.n.localeCompare(b.n, 'zh-Hans-CN', { numeric: true }) : a.t === 'd' ? -1 : 1));
      }
      parent = sub;
    }
  }
  const sortC = (a, b) => (a.t === b.t ? a.n.localeCompare(b.n, 'zh-Hans-CN', { numeric: true }) : a.t === 'd' ? -1 : 1);
  const existing = (parent.c || []).find((c) => c.t === 'f' && c.n === name);
  if (existing) Object.assign(existing, { s: size || existing.s, h: body.sha256, k: key, e: `.${ext}` });
  else {
    // w（首次入库日期）与 build-tree2-index 同格式：首页「最近 7 天新增」和排序都靠它
    parent.c.push({ n: name, t: 'f', s: size, h: body.sha256, k: key, e: `.${ext}`, w: new Date().toISOString().slice(0, 10) });
    parent.c.sort(sortC);
  }
  if (batch) batch.subj = [...new Set([...(batch.subj || []), ...T2_SUBJECTS.filter((s) => name.includes(s))])];

  // 更新统计，页面刷新后数字对得上
  recalcManifestStats(m);
  m.totals.uniqueFiles = null;

  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(m, null, 2));
  await fsp.rename(tmp, file);

  // 记录「本机上传」来源（区别于 pan-sync 从本地盘发布的那批），
  // 本地的 tree2-publish 每次发布会把这些采纳回本地清单，避免被重建覆盖
  await logUpload(year, key, body, body.sha256, actor);
  return true;
}

const UPLOG_FILE = path.join(SHARES_DIR, 'uplog.json');

// 追加一条事件（直传/改名）到 uplog，tree2-publish 读取后应用到本地并清理
async function appendUplog(entry) {
  try {
    let list = [];
    try {
      list = JSON.parse(await fsp.readFile(UPLOG_FILE, 'utf8'));
      if (!Array.isArray(list)) list = [];
    } catch { /* 首条 */ }
    list.push(entry);
    if (list.length > 1000) list = list.slice(-1000);
    const tmp = `${UPLOG_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(list, null, 1));
    await fsp.rename(tmp, UPLOG_FILE);
  } catch {
    /* 事件日志失败不影响主流程 */
  }
}

async function logUpload(year, key, body, sha, actor = '') {
  // 与改名/删除共用同一条 uplog 追加通道（原先是 appendUplog 的复制版，条数上限还不一致）
  await appendUplog({
    season: year,
    key,
    name: body.name || '',
    folder: String(body.folder || ''),
    sha256: sha,
    actor,
    at: new Date().toISOString(),
  });
}

// ---------------- 顾客上传口令（admin 在 admin.html 生成，同学在 customer.html 使用） ----------------
// once：绑定批次集合，可限次数/时效，随机 32 hex 存 customer-tokens.json；
// daily：HMAC(主口令, 北京日期) 按日派生，无需存储，每天自动换值，可新建批次。
const CTOKENS_FILE = path.join(SHARES_DIR, 'customer-tokens.json');
const ctCache = { m: -1, list: [] };

async function loadCTokens() {
  try {
    const st = await fsp.stat(CTOKENS_FILE);
    if (st.mtimeMs !== ctCache.m) {
      ctCache.list = JSON.parse(await fsp.readFile(CTOKENS_FILE, 'utf8'));
      ctCache.m = st.mtimeMs;
    }
  } catch {
    ctCache.list = [];
    ctCache.m = -1;
  }
  return ctCache.list;
}

async function saveCTokens(list) {
  const tmp = CTOKENS_FILE + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(list, null, 1));
  await fsp.rename(tmp, CTOKENS_FILE);
  ctCache.m = -1; // 强制下次重读
}

function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 北京时间
}
function dailyToken(dateStr) {
  return createHmac('sha256', cfg.token).update('customer-daily-' + dateStr).digest('hex').slice(0, 32);
}

// 上传链路（part/commit）身份分类：admin 主口令 / daily / once；其余写接口不走这里
async function classifyWrite(req) {
  if (!cfg.token) return { kind: 'admin' }; // 本机开发未设口令
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const t = sameToken(bearer) ? bearer : String(req.headers['x-tree2-token'] || '');
  if (!t) throw new HttpError(401, '需要上传口令：Authorization: Bearer <token>');
  if (sameToken(t)) return { kind: 'admin' };
  if (t === dailyToken(todayCN())) return { kind: 'daily' };
  const list = await loadCTokens();
  const rec = list.find((r) => r.token === t);
  if (!rec) throw new HttpError(401, '口令不正确或已失效');
  if (rec.expiresAt && Date.now() > rec.expiresAt) throw new HttpError(403, '该口令已过有效期');
  if (rec.maxUses && (rec.uses || 0) >= rec.maxUses) throw new HttpError(403, '该口令的可用次数已用完');
  return { kind: 'once', rec };
}

route('GET', /^\/api\/tree2\/health$/, async (req, res) => {
  const files = await fsp.readdir(cfg.data).catch(() => []);
  json(res, 200, {
    ok: true,
    store: cfg.store,
    data: cfg.data,
    manifests: files.filter((f) => f.endsWith('.json')).length,
    objects: (await objectKeys()).size,
    auth: Boolean(cfg.token),
    allowOrigin: cfg.allowOrigin,
  });
});

// ---------------------------------------------------------------- 静态：前端（开 8787 直接访问，或让 Flyfish 同源）

/**
 * 根路径落地页。
 * 直接开 http://host:8787/ 的人多半是想「看看有什么」，给一个带链接的页面比 {"error":"没找到"} 有用得多。
 */
route('GET', /^\/$/, async (req, res) => {
  const files = await fsp.readdir(cfg.data).catch(() => []);
  const years = files.filter((f) => /^\d{4}\.json$/.test(f)).map((f) => f.slice(0, 4)).sort();
  const addr = req.headers.host || '127.0.0.1:8787';
  const api = `http://${addr}`;
  const row = (label, href, note) =>
    `<tr><td><a href="${href}">${label}</a></td><td><code>${href.replace(api, '')}</code></td><td>${note}</td></tr>`;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>tree2 文件服务</title>
<style>
 body{margin:0;padding:40px 20px;font:14px/1.7 "Microsoft YaHei","PingFang SC",sans-serif;color:#1e3a5f;
      background:radial-gradient(900px 340px at 50% -10%,#fff6e0,rgba(255,246,224,0) 70%),#fffaf0}
 main{max-width:760px;margin:0 auto}
 h1{font-size:24px;margin:0 0 4px}p.deck{color:#8a7f6e;margin:0 0 24px}
 table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e8dcc3;border-radius:10px;overflow:hidden}
 td{padding:9px 12px;border-bottom:1px solid #f0e8d8;vertical-align:top}
 tr:last-child td{border-bottom:0}
 code{font-size:12px;color:#6b6153;word-break:break-all}
 a{color:#1e3a5f}
 .big{display:inline-block;margin:0 0 24px;padding:11px 20px;background:#1e3a5f;color:#fff;border-radius:9px;text-decoration:none}
 h2{font-size:15px;margin:26px 0 8px}
</style></head><body><main>
<h1>tree2 文件服务</h1>
<p class="deck">静态页面 + 清单 + 文件字节。下面每个链接都能直接点。</p>
<a class="big" href="/tree2/index.html?api=${api}">打开 tree2 资料库 →</a>
<table>
${row('资料库页面', `/tree2/index.html?api=${api}`, '目录树、搜索、在线预览、上传')}
${row('渲染自检', `/tree2/selftest.html?api=${api}`, '把已入库的文件逐类型渲染一遍并计时')}
${row('健康检查', '/api/tree2/health', '存储路径、清单数、已入库对象数')}
${row('届别索引', '/api/tree2/seasons', years.join(' / ') || '还没有清单')}
${years.map((y) => row(`${y} 届清单`, `/api/tree2/seasons/${y}`, '目录树 + 每个文件的 sha256 / 存储键')).join('')}
</table>
<h2>给 Flyfish 或别的页面用</h2>
<p class="deck">跨域直接请求下面这些地址；如果要嵌在本站域名下，用 <code>server/tree2.mjs</code> 网关做同源转发。</p>
<table>
${row('取文件', `/api/tree2/files/${years[years.length - 1] || '2026'}?k=ab%2F&lt;sha256&gt;.pdf`, '支持 Range，加 &amp;download=1 走附件下载')}
${row('秒传探测', `/api/tree2/files/${years[years.length - 1] || '2026'}?h=&lt;sha256&gt;`, '返回 {exists,key}')}
${row('存储状态', `/api/tree2/storage/${years[years.length - 1] || '2026'}`, '只列真正在盘上的键')}
</table>
</main></body></html>`;
  res.writeHead(200, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
});

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const base = path.join(cfg.root, 'public');
  const file = path.join(base, rel);
  if (!file.startsWith(base + path.sep)) throw new HttpError(403, '禁止访问');
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new HttpError(404, '没找到');
  const ext = path.extname(file).toLowerCase();
  // pdf.js 的 cmaps/*.bcmap 没有扩展名，漏掉会让中文 PDF 变成方块
  const isCmap = file.includes(`${path.sep}cmaps${path.sep}`) && !ext;
  // 缓存策略：页面的 HTML/JS/CSS 必须每次验证，配 ETag 走 304 很快。
  // 之前给 js/css 设了 max-age=3600，结果改完代码刷新时 HTML 是新的、JS 是缓存里的旧的，
  // 版本错配直接崩（新版 HTML 删掉的按钮，旧版 JS 还在绑事件）。
  // vendor/ 下的第三方库文件名带版本号、内容不变，可以放心长缓存。
  const isVendor = file.includes(`${path.sep}vendor${path.sep}`);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...cors(req), ETag: etag, 'Cache-Control': isVendor ? 'public, max-age=31536000, immutable' : 'no-cache' });
    return res.end();
  }
  res.writeHead(200, {
    ...cors(req),
    'Content-Type': isCmap ? 'application/octet-stream' : MIME[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    ETag: etag,
    'Cache-Control': isVendor ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  await pipeline(fs.createReadStream(file), res).catch(() => {});
}

// ---------------------------------------------------------------- 主循环

async function tree2Handler(req, res) {
  // json() 需要读 Origin 才能回正确的 CORS 头
  res.req = req;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req));
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    for (const r of router) {
      // HEAD 按 GET 处理：<audio preload="metadata">、下载器的探测、CORS 预检都会先发 HEAD，
      // 只认 GET 的话它们一律拿 404，音频就播不了、下载器也不认。
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      return await r.fn(req, res, m, url);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
    throw new HttpError(404, '没有这个接口');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[tree2]', url.pathname, e);
    if (res.headersSent) return res.end();
    json(res, status, { error: e.message || '服务器错误' }, cors(req));
  }
}

const server = http.createServer(tree2Handler);

// ---------------- 分片临时目录 GC ----------------
// 上传中断 / commit 校验失败会留下 tmp/<key>/<i>.part，没有任何清理的话永久堆积。
// 分片超过 24 小时必然是被放弃的残骸（正常上传几分钟内就会 commit 走人）。
async function sweepTmpParts() {
  const dirs = await fsp.readdir(TMP).catch(() => []);
  const now = Date.now();
  for (const d of dirs) {
    if (!/^[0-9a-f]{2}_[0-9a-f]{64}/.test(d)) continue;
    const p = path.join(TMP, d);
    const s = await fsp.stat(p).catch(() => null);
    if (s && s.isDirectory() && now - s.mtimeMs > 24 * 3600 * 1000) {
      await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }
}
setInterval(sweepTmpParts, 6 * 3600 * 1000).unref(); // 每 6 小时扫一遍；进程存活由 server 监听兜底，定时器不必拽住事件循环

await fsp.mkdir(OBJECTS, { recursive: true });
await fsp.mkdir(TMP, { recursive: true });
sweepTmpParts(); // 启动时先扫一次，清掉停机期间留下的残骸
server.listen(cfg.port, cfg.host, () => {
  const addr = `${cfg.host}:${cfg.port}`;
  console.log(`tree2 文件服务已启动  http://${addr}`);
  console.log(`  静态站  http://${addr}/tree2/index.html?api=http://${addr}`);
  console.log(`  存储    ${cfg.store}`);
  console.log(`  清单    ${cfg.data}`);
  console.log(`  鉴权    ${cfg.token ? '写操作需要 Bearer token' : '未设口令（仅建议本机使用）'}${cfg.privateRead ? '，读也要口令' : ''}`);
  console.log(`  CORS    ${cfg.allowOrigin.join(', ')}`);
});

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
import { ArrangeError, planArrangement } from './tree2-arrange.mjs';
import { createWebdavHandler } from './tree2-webdav.mjs';
import { createShortLinkStore, shareLockPage } from './tree2-shortlinks.mjs';
import {
  createIngestPush,
  readUpdateCredentials,
  resolveUpdateEndpoint,
} from './tree2-ingest-push.mjs';
import { assignFolderIds, folderIndex, historicalFolderId, isFolderId, newFolder, rememberFolderChanges, removedFolder } from './tree2-folders.mjs';

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
  '.aac': 'audio/aac',
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
// 站点运行时配置（如备案号）只放服务器环境，不进仓库：/etc/treenext.env → systemd EnvironmentFile
cfg.icp = process.env.TREE2_ICP || '';
const OBJECTS = path.join(cfg.store, 'objects');
const TMP = path.join(cfg.store, 'tmp');
const MAX_PARTS = 4096;

// ---------------------------------------------------------------- 工具

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 清单引用跨届共享对象，口令额度也跨届共享。最终入库、清单修改及口令写入共用队列。
let libraryWrites = Promise.resolve();
function writeLibrary(fn) {
  const run = libraryWrites.then(fn);
  libraryWrites = run.catch(() => {});
  return run;
}

async function writeJsonAtomic(file, value, indent = 2) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(value, null, indent));
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- Navidrome 音频直通
// 配置 navidrome.json 的 internal 即启用服务端转发，否则直接读取本地对象。
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']);
const ND_CFG_FILE = path.join(HERE, '..', 'data', 'navidrome.json');
const ND_MAP_FILE = path.join(HERE, '..', 'data', 'audio-map.json');
const ND_SHARE_FILE = path.join(HERE, '..', 'data', 'share-map.json');
// 分享注册表：shares.json 由本服务写；share-nd-map.json 由 navidrome 同步脚本写（两边不写同一个文件）
const SHARES_DIR = process.env.TREE2_SHARES_DIR || path.join(HERE, '..', 'data');
const SHARES_FILE = path.join(SHARES_DIR, 'shares.json');
// 短链分享：/s/<短码>?pin=<四位码>，注册表独立于历史随机短链
const SHORTLINKS_FILE = path.join(SHARES_DIR, 'shortlinks.json');
const shortLinks = createShortLinkStore({ sharesFile: SHORTLINKS_FILE, log: (m) => console.log(m) });
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
    ndCache[key] = null;
    ndCache[mtimeKey] = 0;
  }
  return ndCache[key];
}

/** 配了内网地址且音频已同步时，返回服务端可直连的流地址。 */
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
  const disconnect = () => upstreamCtl.abort();
  res.once('close', disconnect);
  if (res.destroyed) disconnect();
  try {
    const upstream = await fetch(upstreamUrl, { method: req.method, headers, redirect: 'error', signal: upstreamCtl.signal });
    clearTimeout(upstreamTimer);
    if (!upstream.ok && upstream.status !== 416) {
      await upstream.body?.cancel();
      throw new HttpError(502, `音频上游返回 HTTP ${upstream.status}`);
    }
    const responseHeaders = { ...cors(req), 'Cache-Control': 'no-store' };
    for (const name of ['content-type', 'accept-ranges', 'content-range', 'content-length']) {
      const value = upstream.headers.get(name);
      if (value != null) responseHeaders[name] = value;
    }
    if (upstream.headers.has('content-encoding')) delete responseHeaders['content-length'];
    res.writeHead(upstream.status, responseHeaders);
    if (!upstream.body) return res.end();
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy();
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, '音频上游（Navidrome）暂时无法连接，请稍后重试');
  } finally {
    clearTimeout(upstreamTimer);
    res.off('close', disconnect);
    upstreamCtl.abort();
  }
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
  const allow = cfg.allowOrigin.includes('*') ? '*' : cfg.allowOrigin.includes(origin) ? origin : '';
  return {
    ...(allow ? { 'Access-Control-Allow-Origin': allow } : {}),
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
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
  json(res, 200, JSON.parse(raw), { 'Cache-Control': cfg.privateRead ? 'no-store' : 'no-cache' });
});

route('GET', /^\/api\/tree2\/seasons\/([^/]+)$/, async (req, res, [, year]) => {
  requireRead(req);
  const raw = await fsp.readFile(path.join(cfg.data, `${safeYear(year)}.json`), 'utf8').catch(() => null);
  if (!raw) throw new HttpError(404, '这一届的清单还没生成');
  // 清单只在增删文件时才变：给内容算 ETag，浏览器每次进站带着 If-None-Match 来验证，
  // 没变就 304 空响应——以前是每次全量重拉（gzip 后 ~87KB × 每次进站，9 天 243 MB）
  const etag = `"${createHash('sha1').update(raw).digest('hex').slice(0, 20)}"`;
  const cacheControl = cfg.privateRead ? 'no-store' : 'no-cache';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...cors(req), ETag: etag, 'Cache-Control': cacheControl });
    return res.end();
  }
  // 在线标记：有真实字节的文件节点带 o=1，前端拿节点就能判断能不能预览，
  // 不必再拉一遍 /storage/:year 的全量键列表（那一份 gzip 后也有 16~53KB）。
  // 对象集合只有随清单增删才变，所以标记与 ETag 一致，304 语义不受影响。
  const objects = await objectKeysCached();
  const manifest = JSON.parse(raw);
  const markOnline = (n) => {
    for (const c of n.c || []) {
      if (c.t === 'd') markOnline(c);
      else if (c.k && objects.has(c.k)) c.o = 1;
    }
  };
  for (const b of manifest.batches || []) markOnline(b.tree || {});
  res.writeHead(200, { ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl, ETag: etag });
  res.end(JSON.stringify(manifest));
});

// 轻量届别索引：批次名单 + 计数 + 在线数 + 最近新增，不含整棵目录树。
// 主页/左树首屏只拉这份（几 KB），点开哪个批次再拉哪个批次的子树；
// 搜索/收藏/文件深链才回退到上面的整份清单。
route('GET', /^\/api\/tree2\/seasons\/([^/]+)\/index$/, async (req, res, [, year]) => {
  requireRead(req);
  safeYear(year);
  const raw = await fsp.readFile(path.join(cfg.data, `${year}.json`), 'utf8').catch(() => null);
  if (!raw) throw new HttpError(404, '这一届的清单还没生成');
  const m = JSON.parse(raw);
  const objects = await objectKeysCached();
  const freshCutoff = Date.now() - 8 * 86400000;
  const recent = [];
  const batches = (m.batches || []).map((b) => {
    let online = 0;
    const walk = (n, folder) => {
      for (const c of n.c || []) {
        if (c.t === 'd') walk(c, `${folder}/${c.n}`);
        else {
          if (c.k && objects.has(c.k)) online++;
          if (c.k && c.w && Date.parse(c.w) >= freshCutoff) {
            recent.push({ n: c.n, k: c.k, s: c.s || 0, e: c.e || '', w: c.w, o: objects.has(c.k) ? 1 : 0, folder });
          }
        }
      }
    };
    walk(b.tree || {}, b.name);
    return {
      name: b.name, stage: b.stage, type: b.type, date: b.date,
      files: b.files, dirs: b.dirs, bytes: b.bytes, subj: b.subj || [],
      folderId: (b.tree || {}).folderId,
      tree: { n: b.name, t: 'd', folderId: (b.tree || {}).folderId, p: (b.tree || {}).p },
      online,
    };
  });
  recent.sort((a, b) => String(b.w).localeCompare(String(a.w)));
  recent.length = Math.min(recent.length, 60);
  const onlineTotal = batches.reduce((n, b) => n + b.online, 0);
  json(res, 200, {
    schema: m.schema, year: m.year, title: m.title,
    totals: { ...(m.totals || {}), online: onlineTotal },
    stages: m.stages, kinds: m.kinds, generatedAt: m.generatedAt,
    batches, recent,
  }, { 'Cache-Control': cfg.privateRead ? 'no-store' : 'no-cache' });
});

// 单个批次的子树：左树展开 / 目录页才拉（gzip 后中位 ~2KB，最大 ~11KB）。
// 子树自带 ETag：只改了一个批次时，其它批次的 304 不受影响。
// 第二段既可以是批次 folderId，也可以是批次名（早期数据没分配 folderId 也能用）。
route('GET', /^\/api\/tree2\/seasons\/([^/]+)\/batches\/([^/]+)$/, async (req, res, [, year, rawId]) => {
  requireRead(req);
  safeYear(year);
  let id = rawId;
  try { id = decodeURIComponent(rawId); } catch { /* 原样用 */ }
  const m = await readManifestFile(year).catch((error) => {
    if (error.code === 'ENOENT') throw new HttpError(404, '这一届的清单还没生成');
    throw error;
  });
  const batch = (m.batches || []).find((b) => (b.tree || {}).folderId === id)
    || (m.batches || []).find((b) => b.name === id);
  if (!batch) throw new HttpError(404, '批次不存在或已移除');
  const objects = await objectKeysCached();
  const tree = batch.tree || {};
  const markBatchOnline = (n) => {
    for (const c of n.c || []) {
      if (c.t === 'd') markBatchOnline(c);
      else if (c.k && objects.has(c.k)) c.o = 1;
    }
  };
  markBatchOnline(tree);
  const body = {
    name: batch.name, stage: batch.stage, type: batch.type, date: batch.date,
    files: batch.files, dirs: batch.dirs, bytes: batch.bytes, subj: batch.subj || [],
    folderId: (batch.tree || {}).folderId, tree,
  };
  const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 20)}"`;
  const cacheControl = cfg.privateRead ? 'no-store' : 'no-cache';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...cors(req), ETag: etag, 'Cache-Control': cacheControl });
    return res.end();
  }
  res.writeHead(200, { ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl, ETag: etag });
  res.end(JSON.stringify(body));
});

route('GET', /^\/api\/tree2\/storage\/([^/]+)$/, async (req, res, [, year]) => {
  requireRead(req);
  safeYear(year);
  // 只报这一届清单里、且字节真的在盘上的键——对象库是全届共用的内容寻址存储，
  // 直接 readdir 会把别的届的文件也算进来，主页的「可预览」数就串了
  const objects = await objectKeys();
  const known = await manifestKeys(year);
  const keys = [...known].filter((k) => objects.has(k));
  json(res, 200, { year, enabled: true, source: 'local', count: keys.length, keys }, { 'Cache-Control': cfg.privateRead ? 'no-store' : 'no-cache' });
});

// 黑胶页直达 id：库内点音频预览时前端先问这个接口；share-map 有映射就整页跳
// /music/share/<id>（与 /s/ 音频分享一致），没有就回退内嵌播放器
route('GET', /^\/api\/tree2\/nd-share$/, async (req, res, m, url) => {
  requireRead(req);
  let key = '';
  try { key = safeKey(url.searchParams.get('k') || ''); } catch { key = ''; }
  if (!key) return json(res, 200, { id: null });
  if (serveLocalPlayer && AUDIO_EXT.has(path.extname(key)) && (await keyMetaMap()).has(key)) {
    return json(res, 200, { id: localPlayerId(key) });
  }
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
    if (url.searchParams.has('ext')) {
      const ext = url.searchParams.get('ext');
      if (ext && !/^\.[a-z0-9]{1,8}$/.test(ext)) throw new HttpError(400, '扩展名不合法');
      const key = `${sha.slice(0, 2)}/${sha}${ext}`;
      const stat = await fsp.stat(objPath(key)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      return json(res, 200, { exists: Boolean(stat?.isFile()), key: stat?.isFile() ? key : null });
    }
    const known = await manifestKeys(year);
    const objects = await objectKeysCached();
    const hit = [...known].find((k) => k.includes(`/${sha}`)) || [...objects].find((k) => k.includes(`/${sha}`));
    return json(res, 200, { exists: Boolean(hit) && objects.has(hit), key: hit || null });
  }

  // ② 读文件
  const key = safeKey(url.searchParams.get('k'));
  const name = String(url.searchParams.get('n') || path.basename(key)).replace(/[\r\n"]/g, '');
  const download = url.searchParams.get('download') === '1';
  return servePreviewBytes(req, res, key, name, { download });
});

async function servePreviewBytes(req, res, key, name, { download = false } = {}) {
  // 音频预览优先走内网代理；下载和未同步的音频使用本地对象。
  const audioExt = path.extname(key).toLowerCase();
  if (AUDIO_EXT.has(audioExt) && !download) {
    const sha = path.basename(key, audioExt);
    const proxyUrl = await navidromeProxyStreamUrl(sha);
    if (proxyUrl) return proxyAudioStream(req, res, proxyUrl);
  }
  return serveObjectBytes(req, res, key, name, { download });
}

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

const themeAsset = relative => fs.readFileSync(path.join(ROOT, 'public', 'tree2', relative), 'utf8');
const SHARE_PAGE_THEME = `<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fffaf0">
<script>${themeAsset('js/theme.js')}</script><style>${themeAsset('css/theme.css')}</style>`;
const themeToggle = `<button class="t2-theme-switch" type="button" data-theme-toggle aria-label="切换至暗色"><svg class="t2-theme-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg><svg class="t2-theme-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg></button>`;

const SHARE_ICONS = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM9 21v-7h6v7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  file: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10zM13 3v7h7M8 14h8m-8 3h6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  open: '<path d="M3 19V6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v3M3 19h16a1 1 0 0 0 1-.7l2-6a1 1 0 0 0-1-1.3H7a1 1 0 0 0-1 .7z"/>',
  preview: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  archive: '<path d="M3 4h18v4H3zm2 4v12h14V8M10 12h4m-2 0v5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-5 4 4 4-5 5 6"/>',
  audio: '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
  video: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4z"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11m6-11v11"/>',
  up: '<path d="m6 10 6-6 6 6M12 4v16"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  warning: '<path d="M10.3 4.6 2.6 18a1.3 1.3 0 0 0 1.1 2h16.6a1.3 1.3 0 0 0 1.1-2L13.7 4.6a2 2 0 0 0-3.4 0ZM12 9v4m0 3h.01"/>',
};
const shareIcon = kind => `<svg class="share-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${SHARE_ICONS[kind]}</svg>`;
const shareBrandLink = `<a class="brand" href="/">${shareIcon('home')}备考资料导航</a>`;
const shareBrand = `<header class="t2-theme-header">${shareBrandLink}${themeToggle}</header>`;
function shareCloseLink(sourceFolder, season, className) {
  const href = sourceFolder || `/?s=${encodeURIComponent(season)}`;
  const label = sourceFolder ? '关闭预览并返回文件夹' : '关闭预览并返回资料库';
  return `<a class="${className}" href="${escHtml(href)}" aria-label="${label}" title="${label}">${shareIcon('close')}</a>`;
}

const SHARE_IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const SHARE_VIDEO = new Set(['.mp4', '.webm']);
const SHARE_WORD = new Set(['.docx', '.docm', '.dotx']);
const SHARE_TABLES = new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.ods', '.csv', '.tsv']);
const SHARE_TEXT = new Set(['.txt', '.md', '.markdown', '.json', '.xml', '.html', '.htm', '.css', '.js', '.log']);
function shareFileIcon(ext) {
  if (SHARE_IMAGES.has(ext)) return 'image';
  if (SHARE_VIDEO.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (SHARE_TABLES.has(ext)) return 'table';
  if (ext === '.zip') return 'archive';
  return 'file';
}
function canSharePreview(ext) {
  return ext === '.pdf' || SHARE_IMAGES.has(ext) || SHARE_VIDEO.has(ext) || AUDIO_EXT.has(ext) ||
    SHARE_WORD.has(ext) || SHARE_TABLES.has(ext) || SHARE_TEXT.has(ext);
}
const shareFooter = `<footer class="foot"><span>© 2026 备考资料导航</span>${cfg.icp ? ` <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">${escHtml(cfg.icp)}</a>` : ''}</footer>`;

const SHARE_PAGE_CSS = `
 body{margin:0;padding:48px 18px;font:15px/1.75 "Microsoft YaHei","PingFang SC",sans-serif;color:var(--t2-ink);
      background:radial-gradient(900px 340px at 50% -10%,var(--t2-glow),transparent 70%),var(--t2-paper);min-height:100vh;box-sizing:border-box}
 main{max-width:640px;margin:0 auto}
 main.word-share{max-width:760px}
 .card{background:var(--t2-card);border:1px solid var(--t2-line);border-radius:14px;padding:26px 26px 22px;box-shadow:var(--t2-shadow)}
 .brand{display:flex;align-items:center;gap:8px;font-weight:700;text-decoration:none;color:var(--t2-ink);margin:0;font-size:15px}
 .t2-theme-header{margin:0 0 18px}
 .share-icon{display:block;flex:none}
 .share-file-header{margin-bottom:12px}
 .share-close{box-sizing:border-box;flex:none;width:36px;height:36px;display:grid;place-items:center;border-radius:8px;
     border:1px solid var(--t2-line);color:var(--t2-ink)}
 .share-close:hover{background:var(--t2-soft)}
 .kind,.f-act a,.down{display:flex;align-items:center;gap:6px}
 .kind .share-icon,.f-act .share-icon,.crumb .share-icon{width:15px;height:15px}
 .crumb .share-icon{display:inline-block;vertical-align:middle;color:var(--t2-muted)}
 .empty-share{color:var(--t2-muted)}
 .empty-share .share-icon{margin-bottom:8px}
 .kind{font-size:12px;color:var(--t2-accent);letter-spacing:.12em;margin:0 0 6px}
 main > .card > h1{font-size:20px;line-height:1.45;margin:0 0 10px;word-break:break-all}
 .meta{color:var(--t2-muted);font-size:13px;margin:0 0 20px}
 .down{justify-content:center;text-align:center;padding:12px 20px;background:var(--t2-action);color:var(--t2-action-ink);border-radius:10px;
       text-decoration:none;font-weight:700;font-size:15px;margin:0 0 6px}
 .down:hover{background:var(--t2-action-hover)}
 .hint{color:var(--t2-muted);font-size:12.5px;margin:8px 0 0}
 .preview{margin:18px 0 0}
 .preview > img{max-width:100%;border-radius:10px;border:1px solid var(--t2-line);display:block;margin:0 auto}
 .preview iframe{width:100%;height:70vh;border:1px solid var(--t2-line);border-radius:10px;background:var(--t2-field)}
 .preview video{width:100%;border-radius:10px;border:1px solid var(--t2-line);display:block}
 .preview audio{width:100%;margin:4px 0 0}
 .t2-landing-doc{min-height:120px;font-size:13px;color:var(--t2-muted)}
 .crumb{color:var(--t2-muted);font-size:12.5px;margin:0 0 10px;word-break:break-all}
 .crumb a{color:var(--t2-ink)}
 .folder-list{list-style:none;margin:18px 0 0;padding:0}
 .folder-list li{display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--t2-line);padding:9px 2px}
 .folder-list li:last-child{border-bottom:0}
 .folder-list .ico{flex:none;display:flex;align-items:center;width:20px;color:var(--t2-muted)}
 .folder-list .f-name{flex:1;min-width:0;word-break:break-all}
 .folder-list .f-name a{color:var(--t2-ink);text-decoration:none}
 .folder-list .f-name a:hover{text-decoration:underline}
 .folder-list .f-size{flex:none;color:var(--t2-muted);font-size:12px}
 .folder-list .f-act{flex:none;display:flex;gap:8px}
 .folder-list .f-act a{font-size:12.5px;color:var(--t2-ink);text-decoration:none;white-space:nowrap;border:1px solid var(--t2-line);border-radius:8px;padding:3px 9px}
 .folder-list .f-act a:hover{background:var(--t2-soft)}
 .foot{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 14px;color:var(--t2-muted);font-size:12px;margin:18px 0 0}
 .foot a{color:inherit;text-underline-offset:3px}
 .word-share .card{padding-block:16px}
 .word-share .card > h1{margin-bottom:6px}
 .word-share .share-file-actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 12px}
 .word-share .share-file-actions .meta{margin:0}
 .word-share .share-file-actions .down{padding:6px 12px;margin:0;font-size:13px}
 .t2-landing-word{min-height:0;max-height:min(55svh,30rem);overflow:auto;scrollbar-gutter:stable;margin-top:12px;
     padding:6px;border:1px solid var(--t2-line);border-radius:8px;background:var(--t2-field)}
 .t2-landing-word .t2-doc{width:100%;min-width:0;overflow-x:auto;color:#222;color-scheme:light}
 .t2-landing-word .docx-wrapper{width:max-content;margin-inline:auto;padding:0;background:transparent}
 .t2-landing-word .docx-wrapper > section.docx{box-sizing:border-box;margin-bottom:12px}
 .t2-landing-word .docx-wrapper > section.docx:last-child{margin-bottom:0}
 .t2-landing-doc > :is(table,pre){color:var(--t2-ink)}
 @media(max-width:480px){
   body{padding:20px 10px}
   .card{padding:16px 12px}
   .folder-list li{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:4px 8px}
   .folder-list .f-act{grid-column:2 / -1}
 }
`;

const SHARE_404_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>分享不存在</title>
${SHARE_PAGE_THEME}<style>${SHARE_PAGE_CSS}</style></head><body><main>
<div class="card">${shareBrand}<div class="empty-share">${shareIcon('warning')}</div>
<h1>分享不存在或已取消</h1><p class="meta">链接可能输错了，或者文件已不在库里。</p>
<a class="down" href="/">${shareIcon('home')}返回资料库</a></div>${shareFooter}
</main></body></html>`;

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

function shareSourceFolder(shareUrl) {
  const base = 'http://tree2.local';
  const from = shareUrl.searchParams.get('from');
  if (!from?.startsWith('/d/')) return '';
  const folder = new URL(from, base);
  return folder.origin === base && /^\/d\/(?:id\/)?\d{4}\/.+/.test(folder.pathname) ? folder.pathname : '';
}

/** 文件分享页：按类型加载站内预览，并提供单独的下载入口。 */
function sendShareLanding(req, res, { key, name, ext, size, dateLabel, season, visitsLabel = '', audioPending = false }) {
  const filesUrl = `/api/tree2/files/${encodeURIComponent(season)}?k=${encodeURIComponent(key)}&n=${encodeURIComponent(name)}`;
  const sourceFolder = shareSourceFolder(new URL(req.url, 'http://tree2.local'));
  const isWord = SHARE_WORD.has(ext);
  // 客户端渲染类预览共用的净化器 + 容器
  const T2_CLEAN = '<script>function t2Clean(root){root.querySelectorAll(\'script,iframe,object,embed,link,meta\').forEach(function(e){e.remove()});[].forEach.call(root.querySelectorAll(\'*\'),function(e){[].slice.call(e.attributes).forEach(function(a){if(/^on/i.test(a.name))e.removeAttribute(a.name)})})}</script>';
  let preview = '';
  if (SHARE_IMAGES.has(ext)) {
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
    info.style.cssText = 'color:var(--t2-muted);font-size:12px;margin:0 0 10px';
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
        canvas.style.cssText = 'width:100%;display:block;border:1px solid var(--t2-line);border-radius:8px;background:#fff';
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
  } else if (SHARE_VIDEO.has(ext)) {
    preview = `<div class="preview"><video controls preload="metadata" src="${escHtml(filesUrl)}"></video></div>`;
  } else if (AUDIO_EXT.has(ext)) {
    // 音频由 files 路由流式输出。
    preview =
      `<div class="preview"><audio controls preload="metadata" src="${escHtml(filesUrl)}"></audio>` +
      (audioPending ? `<p class="hint">音频正在同步到音乐库，同步完成后这个链接会直接打开在线播放页（最多一小时）。</p>` : ``) +
      `</div>`;
  } else if (isWord) {
    preview = `<div id="t2-preview" class="preview t2-landing-doc t2-landing-word" role="region" aria-label="Word 文档预览" tabindex="0">正在渲染 Word 预览…</div>
<script type="module">
  const host = document.getElementById('t2-preview');
  import('/js/preview.js?v=20261116-word-layout')
    .then(({ render }) => render(host, ${JSON.stringify(filesUrl)}, ${JSON.stringify('preview' + ext)}))
    .catch(() => { host.textContent = 'Word 预览组件加载失败，请用「下载文件」查看。'; });
</script>`;
  } else if (SHARE_TABLES.has(ext)) {
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
      h.style.cssText = 'margin:14px 0 6px;font-size:13px;color:var(--t2-muted)';
      var t = document.createElement('template');
      t.innerHTML = XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' });
      t2Clean(t.content);
      host.appendChild(h);
      host.appendChild(t.content);
    });
    host.querySelectorAll('table').forEach(function (tb) {
      tb.style.cssText = 'border-collapse:collapse;width:100%;background:var(--t2-card);font-size:12px';
      [].forEach.call(tb.querySelectorAll('td,th'), function (td) {
        td.style.cssText = 'border:1px solid var(--t2-line);padding:4px 7px;white-space:nowrap';
      });
    });
  }).catch(function () { host.textContent = '预览渲染失败，请下载后查看。'; });
})();
</` + `script>`;
  } else if (SHARE_TEXT.has(ext)) {
    preview =
      `<div class="preview"><div id="t2-preview" class="t2-landing-doc">正在载入文本…</div></div>` +
      `<script>
(function () {
  var host = document.getElementById('t2-preview');
  fetch(${JSON.stringify(filesUrl)}).then(function (r) { return r.text(); }).then(function (t) {
    var pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;background:var(--t2-field);border:1px solid var(--t2-line);border-radius:10px;padding:16px;font:12.5px/1.7 ui-monospace,Consolas,monospace;max-height:70vh;overflow:auto';
    pre.textContent = t.slice(0, 200000);
    host.replaceChildren(pre);
  }).catch(function () { host.textContent = '预览载入失败，请下载后查看。'; });
})();
</` + `script>`;
  }
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Cache-Control" content="no-store">
<title>${escHtml(name)} · 文件分享</title>
 ${SHARE_PAGE_THEME}<style>${SHARE_PAGE_CSS}</style></head><body><main${isWord ? ' class="word-share"' : ''}>
<div class="card">
<header class="t2-theme-header share-file-header">${shareBrandLink}${shareCloseLink(sourceFolder, season, 'share-close')}</header>
<p class="kind">${shareIcon(shareFileIcon(ext))}${escHtml(kindLabelOf(ext))} · 文件分享</p>
<h1>${escHtml(name)}</h1>
<div class="share-file-actions">
<p class="meta">${fmtBytes(size)} · ${escHtml(dateLabel)}${visitsLabel}</p>
<a class="down" href="${escHtml(filesUrl)}&download=1" download>${shareIcon('download')}下载文件</a>
</div>
${isWord ? '' : '<p class="hint">手机上长按上面的按钮也可以选择用其他应用打开。</p>'}
${preview}
</div>
${shareFooter}
</main></body>
<script>
// 倍速记忆：黑胶页（music-custom.js）把倍速存在 localStorage['t2Rate']，
// 落地页的音频沿用同一倍速。这里只应用不切换——落地页没有倍速按钮，
// 之前留下的按钮逻辑操作的是不存在的 [data-rate] 元素，已裁掉。
(function () {
  var target = 1;
  try { target = parseFloat(localStorage.getItem('t2Rate')) || 1; } catch (e) {}
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

const musicShareUrl = (config, id, key) =>
  `${config?.base || '/music'}/share/${encodeURIComponent(id)}?t2file=${encodeURIComponent(key)}`;

// Navidrome 0.64.2 (10114574) 的分享页运行时，与 /music/share/ 使用同一份资源。
const VINYL_ASSETS = '/music/share/assets';
const vinylPath = (year, key) => `/api/tree2/vinyl/${year}/${path.basename(key)}`;
const vinylTrack = '([0-9a-f]{64}\\.(?:mp3|wav|m4a|ogg|flac|aac))';
const vinylKey = track => `${track.slice(0, 2)}/${track}`;
const scriptJson = value => JSON.stringify(JSON.stringify(value)).replaceAll('<', '\\u003c');

route('GET', /^\/api\/tree2\/vinyl\/playlist\.js$/, (req, res) =>
  serveStatic(req, res, '/tree2/music-playlist.js'));

route('GET', new RegExp(`^/api/tree2/vinyl/(\\d{4})/${vinylTrack}$`), async (req, res, [, year, track], url) => {
  requireRead(req);
  const key = vinylKey(track);
  const stat = await fsp.stat(objPath(key)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!stat?.isFile()) throw new HttpError(404, '音频文件不存在');
  const name = (await keyMetaMap()).get(key)?.name || track;
  const title = name.slice(0, name.length - path.extname(name).length);
  const sourceFolder = shareSourceFolder(url);
  const standalone = url.searchParams.get('t2embed') !== '1';
  const config = {
    version: '0.64.2 (10114574)',
    defaultLanguage: '',
    defaultTheme: 'Dark',
    defaultUIVolume: 100,
    enableCoverAnimation: true,
    uiCoverArtSize: 300,
    baseURL: `/api/tree2/vinyl/${year}`,
    shareURL: '',
    auth: { isAdmin: false },
  };
  const info = { id: track, description: title, downloadable: true, tracks: [{ id: track, title, duration: 0 }] };
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escHtml(title)} · 黑胶播放器</title>
${SHARE_PAGE_THEME}
<script>window.process={env:{}};window.__APP_CONFIG__=${scriptJson(config)};window.__SHARE_INFO__=${scriptJson(info)};</script>
<link rel="stylesheet" href="${VINYL_ASSETS}/index-uCXnEN-G.css">
<link rel="stylesheet" href="/music-custom.css?v=20261116-preview-close">
<script src="/api/tree2/vinyl/playlist.js?v=1"></script>
<script defer src="/music-custom.js?v=20261116-playlist-share-preview"></script>
<script type="module" src="${VINYL_ASSETS}/index-7wbOXZOY.js"></script>
</head><body${standalone ? ' data-file-preview' : ''}><div id="root"></div>
${standalone ? `<div class="t2-nd-top">${shareCloseLink(sourceFolder, year, 't2-nd-back t2-nd-close')}</div>` : ''}</body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "frame-ancestors 'self'",
    'X-Frame-Options': 'SAMEORIGIN',
  });
  res.end(req.method === 'HEAD' ? undefined : html);
});

route('GET', new RegExp(`^/api/tree2/vinyl/(\\d{4})/share/(s|d|img)/${vinylTrack}$`), async (req, res, [, , type, track]) => {
  requireRead(req);
  if (type === 'img') return serveStatic(req, res, '/tree2/assets/vinyl-cover.png');
  const key = vinylKey(track);
  const name = (await keyMetaMap()).get(key)?.name || track;
  return servePreviewBytes(req, res, key, name, { download: type === 'd' });
});

function redirectVinyl(req, res, year, key, sourceFolder) {
  const destination = vinylPath(year, key) + (sourceFolder ? `?from=${encodeURIComponent(sourceFolder)}` : '');
  res.writeHead(302, { ...cors(req), Location: destination, 'Cache-Control': 'no-store' });
  res.end();
}

// 短链分享：/s/<4 位短码>?pin=<4 位提取码>
// 没带 pin 或 pin 不对都回落地页（200），不泄露文件是否存在之外的更多信息；
// 连续输错按「短码 + 客户端」限流，避免四位数被枚举。
route('GET', /^\/s\/([0-9a-z]{4})$/, async (req, res, [, code], url) => {
  const pin = url.searchParams.get('pin') || '';
  const html = (status, body, extra = {}) => {
    res.writeHead(status, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    return res.end(body);
  };
  if (!pin) return html(200, shareLockPage({ code, title: '受保护的分享', message: '请输入分享者给你的四位提取码。' }));
  const check = await shortLinks.verify(code, pin, req);
  if (!check.ok) {
    if (check.reason === 'blocked') {
      return html(429, shareLockPage({ code, title: '尝试次数过多', message: '提取码输错次数太多，请稍后再试。' }), { 'Retry-After': String(Math.ceil((check.retryAfter || 0) / 1000)) });
    }
    if (check.reason === 'expired') return html(410, shareLockPage({ code, title: '分享已过期', message: '这个分享码已超过有效期。' }));
    if (check.reason === 'notfound') return html(404, shareLockPage({ code, title: '分享不存在', message: '分享码无效或已被撤销。' }));
    return html(200, shareLockPage({ code, title: '提取码不正确', message: check.remaining > 0 ? `还可以再试 ${check.remaining} 次。` : '再输错一次将临时锁定。' }));
  }
  const key = check.entry.key;
  const st = await fsp.stat(objPath(key)).catch(() => null);
  if (!st || !st.isFile()) return html(410, shareLockPage({ code, title: '文件已下架', message: '这个文件已不在资料库里。' }));
  bumpStat(key, 'pv');
  const ext = path.extname(key).toLowerCase();
  return sendShareLanding(req, res, {
    key,
    name: check.entry.name || path.basename(key),
    ext,
    size: st.size,
    season: check.entry.season || (await latestManifestYear()) || '2026',
    dateLabel: st.mtime.toISOString().slice(0, 10),
  });
});

// 确定性分享链接：/s/<存储键>
route('GET', /^\/s\/([0-9a-f]{2}\/[0-9a-f]{64}(?:\.[a-z0-9]{1,8})?)$/, async (req, res, [, key], url) => {
  const st = await fsp.stat(objPath(key)).catch(() => null);
  if (!st || !st.isFile()) {
    res.writeHead(404, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(SHARE_404_HTML);
  }
  bumpStat(key, 'pv'); // 分享页访问计数
  const ext = path.extname(key).toLowerCase();
  const meta = (await keyMetaMap()).get(key);
  const name = (meta && meta.name) || path.basename(key);
  const season = (meta && meta.season) || (await latestManifestYear()) || '2026';

  if (AUDIO_EXT.has(ext)) {
    const sourceFolder = shareSourceFolder(url);
    if (!cfg.privateRead && key === vinylKey(path.basename(key))) return redirectVinyl(req, res, season, key, sourceFolder);
    const sha = path.basename(key, ext);
    const am = (await readJsonCached(ND_MAP_FILE, 'map', 'mapMtime')) || {};
    const sm = (await readJsonCached(ND_SHARE_FILE, 'shares', 'sharesMtime')) || {};
    if (!sourceFolder && am[sha] && sm[sha]) {
      const ndCfg = await readJsonCached(ND_CFG_FILE, 'cfg', 'cfgMtime');
      res.writeHead(302, { ...cors(req), Location: musicShareUrl(ndCfg, sm[sha], key), 'Cache-Control': 'no-store' });
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
  if (!cfg.privateRead && AUDIO_EXT.has(path.extname(entry.key || '')) && entry.key === vinylKey(path.basename(entry.key))) {
    const year = /^\d{4}$/.test(entry.season) ? entry.season : (await latestManifestYear()) || '2026';
    return redirectVinyl(req, res, year, safeKey(entry.key));
  }
  // 音频：优先使用注册表里的黑胶页映射，否则走落地页。
  const nd = (await readJsonCached(SHARE_ND_FILE, 'shareNd', 'shareNdMtime')) || {};
  const info = nd[entry.id];
  const isAudio = AUDIO_EXT.has(entry.ext);
  if (isAudio && info && info.ndShareId) {
    const ndCfg = await readJsonCached(ND_CFG_FILE, 'cfg', 'cfgMtime');
    res.writeHead(302, { ...cors(req), Location: musicShareUrl(ndCfg, info.ndShareId, entry.key), 'Cache-Control': 'no-store' });
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

// 新分享使用稳定目录 ID。历史路径仍可打开原目录。
const countNodeFiles = countTreeFiles;
const sumNodeBytes = sumTreeBytes;
const encodedFolderPath = segs => segs.map(s => encodeURIComponent(s)).join('/');
const folderIdLink = (year, id) => `/d/id/${year}/${id}`;
const folderLink = (year, node, segs) => isFolderId(node?.folderId)
  ? folderIdLink(year, node.folderId)
  : `/d/${year}/${encodedFolderPath(segs)}`;

function sendFolderLanding(req, res, { year, segs, node, batch, ancestors = [] }) {
  const zipUrl = `/api/tree2/zip/${year}/${encodedFolderPath(segs)}`;
  const previewFrom = encodeURIComponent(folderLink(year, node, segs));
  const dirs = (node.c || []).filter((c) => c.t === 'd');
  const files = (node.c || []).filter((c) => c.t === 'f');

  // 面包屑：每一段都能点回上一层
  const crumb = segs
    .map((s, i) => (i === segs.length - 1 ? escHtml(s) : `<a href="${escHtml(folderLink(year, ancestors[i], segs.slice(0, i + 1)))}">${escHtml(s)}</a>`))
    .join(` ${shareIcon('chevron')} `);

  const rows = [
    ...dirs.map((d) => {
      const link = escHtml(folderLink(year, d, [...segs, d.n]));
      const nFiles = countNodeFiles(d);
      return `<li><span class="ico">${shareIcon('folder')}</span><span class="f-name"><a href="${link}">${escHtml(d.n)}</a></span>` +
        `<span class="f-size">${nFiles} 个文件</span><span class="f-act"><a href="${link}">${shareIcon('open')}打开</a></span></li>`;
    }),
    ...files.map((f) => {
      const key = typeof f.k === 'string' ? f.k : '';
      const filesUrl = `/api/tree2/files/${encodeURIComponent(year)}?k=${encodeURIComponent(key)}&n=${encodeURIComponent(f.n)}`;
      const ext = path.extname(key || f.n).toLowerCase();
      const previewUrl = `/s/${key.split('/').map(encodeURIComponent).join('/')}?from=${previewFrom}`;
      const safeName = escHtml(f.n);
      const preview = key && canSharePreview(ext);
      const label = preview ? `<a href="${previewUrl}">${safeName}</a>` : safeName;
      const action = preview ? `<a href="${previewUrl}">${shareIcon('preview')}预览</a>` : '';
      const download = key ? `<a href="${escHtml(filesUrl)}&download=1" download>${shareIcon('download')}下载</a>` : '';
      return `<li><span class="ico">${shareIcon(shareFileIcon(ext))}</span><span class="f-name">${label}</span>` +
        `<span class="f-size">${fmtBytes(f.s || 0)}</span><span class="f-act">${action}${download}</span></li>`;
    }),
  ].join('');

  const total = fmtBytes(sumNodeBytes(node));
  const batchMeta = segs.length === 1 && batch ? ` · ${escHtml(String(batch.type || ''))}${batch.date ? ' · ' + escHtml(String(batch.date)) : ''}` : '';
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>${escHtml(segs[segs.length - 1])} · 文件夹分享</title>
${SHARE_PAGE_THEME}<style>${SHARE_PAGE_CSS}</style></head><body><main>
<div class="card">
${shareBrand}
<p class="crumb"><a href="/">资料库</a> ${shareIcon('chevron')} ${crumb}</p>
<p class="kind">${shareIcon('folder')}文件夹分享 · ${escHtml(year)} 届${batchMeta}</p>
<h1>${escHtml(segs[segs.length - 1])}</h1>
<p class="meta">${countNodeFiles(node)} 个文件${dirs.length ? ` · ${dirs.length} 个子文件夹` : ''} · 共 ${total}</p>
<a class="down" href="${escHtml(zipUrl)}">${shareIcon('archive')}打包下载全部（zip）</a>
<p class="hint">整包是未压缩 zip，与资料库逐一对应；单个文件也可以在下面的列表里分别预览/下载，点子文件夹可以继续往下看。</p>
<ul class="folder-list">${rows || `<li><span class="ico">${shareIcon('folder')}</span><span class="f-name empty-share">这是个空文件夹</span></li>`}</ul>
</div>
${shareFooter}
</main></body></html>`;
  res.writeHead(200, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function sendMissingFolder(req, res, year, removed) {
  res.writeHead(removed ? 410 : 404, { ...cors(req), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  if (!removed) return res.end(SHARE_404_HTML);
  const parent = removed.parent;
  const next = parent
    ? `<a class="down" href="${escHtml(folderLink(year, parent.node, parent.segs))}">${shareIcon('up')}打开上级目录</a>`
    : `<a class="down" href="/">${shareIcon('home')}返回资料库</a>`;
  res.end(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>原目录已移除</title>
${SHARE_PAGE_THEME}<style>${SHARE_PAGE_CSS}</style></head><body><main><div class="card">${shareBrand}
<div class="empty-share">${shareIcon('warning')}</div><h1>原目录已移除</h1>${next}</div>${shareFooter}</main></body></html>`);
}

route('GET', /^\/d\/id\/(\d{4})\/([^/]+)$/, async (req, res, [, year, id]) => {
  requireRead(req);
  if (!isFolderId(id)) return sendMissingFolder(req, res, year);
  const manifest = await readManifestFile(year).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!manifest) return sendMissingFolder(req, res, year);
  const current = folderIndex(manifest);
  const found = current.get(id);
  if (!found) return sendMissingFolder(req, res, year, removedFolder(manifest, id, current));
  return sendFolderLanding(req, res, { year, ...found });
});

route('GET', /^\/d\/([^/]+)\/(.+)$/, async (req, res, m) => {
  requireRead(req);
  const year = safeYear(decodeURIComponent(m[1]));
  let segs;
  try {
    segs = decodeURIComponent(m[2]).split('/').map((s) => s.trim()).filter(Boolean);
  } catch {
    throw new HttpError(400, '路径不合法');
  }
  if (!segs.length || segs.some(s => s === '.' || s === '..' || s.includes('\\'))) {
    return sendMissingFolder(req, res, year);
  }
  const manifest = await readManifestFile(year).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!manifest) return sendMissingFolder(req, res, year);
  const historicalId = historicalFolderId(manifest, segs);
  if (historicalId) {
    res.writeHead(302, { ...cors(req), Location: folderIdLink(year, historicalId), 'Cache-Control': 'no-store' });
    return res.end();
  }
  const found = findManifestFolder(manifest, segs);
  return found ? sendFolderLanding(req, res, { year, segs, ...found }) : sendMissingFolder(req, res, year);
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
function findManifestFolder(manifest, segs) {
  const batch = manifest && (manifest.batches || []).find((b) => b.name === segs[0]);
  if (!batch) return null;
  let node = batch.tree;
  const ancestors = [];
  for (const s of segs.slice(1)) {
    ancestors.push(node);
    node = (node.c || []).find((c) => c.t === 'd' && c.n === s);
    if (!node) return null;
  }
  return { node, batch, ancestors };
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
  const found = findManifestFolder(await readManifestFile(year).catch(() => null), segs);
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
}, 60000).unref();
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

// ---------------- 对象回收（remove 与 WebDAV DELETE 共用） ----------------
// 引用面：所有届的清单（^\d{4}\.json$，调用方已先写盘，当前届不含被移除的条目，
// 其余届可能有同内容去重条目）+ audio-map / share-map / shares（键为裸 sha256）。
// 用原文包含做保守判断：宁可少删，不可误删还在用的对象。
// uplog 只是历史日志，不算引用；preview-cache 不归本服务管，不动。
async function collectGarbage(keys) {
  const deleted = [];
  const list = Array.isArray(keys) ? keys : [...(keys || [])];
  if (!list.length) return deleted;
  const refChunks = [];
  try {
    for (const f of (await fsp.readdir(cfg.data)).filter((f) => /^\d{4}\.json$/.test(f))) {
      refChunks.push(await fsp.readFile(path.join(cfg.data, f), 'utf8'));
    }
    for (const f of [ND_MAP_FILE, ND_SHARE_FILE, SHARES_FILE]) {
      refChunks.push(await fsp.readFile(f, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      }));
    }
    const refs = refChunks.join('\n');
    for (const k of list) {
      const sha = path.basename(k, path.extname(k));
      if (!sha || refs.includes(sha)) continue;
      try {
        await fsp.unlink(objPath(k));
        deleted.push(k);
        invalidateObjectKeys();
      } catch (error) {
        if (error.code !== 'ENOENT') console.error('[tree2] 对象回收失败', error);
      }
    }
  } catch (error) {
    console.error('[tree2] 引用检查失败，保留对象', error);
  }
  return deleted;
}

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

  return writeLibrary(async () => {
    const file = path.join(cfg.data, `${year}.json`);
    const raw = await fsp.readFile(file, 'utf8').catch(() => null);
    if (!raw) throw new HttpError(404, '清单不存在');
    const manifest = JSON.parse(raw);
    const batch = (manifest.batches || []).find((b) => b.name === segs[0]);
    if (!batch) throw new HttpError(404, '批次不存在');

    if (!name) assignFolderIds(manifest);
    const before = name ? null : folderIndex(manifest);
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
      parentNode.c = (parentNode.c || []).filter(c => c !== node);
      removedName = segs[segs.length - 1];
    } else {
      removedFiles = countTreeFiles(node);
      removedKeys = collectKeys(node);
      manifest.batches = manifest.batches.filter((b) => b.name !== segs[0]);
      removedName = segs[0];
    }

    if (before) rememberFolderChanges(manifest, before);
    // 重新统计
    recalcManifestStats(manifest);

    await writeJsonAtomic(file, manifest);
    manifestCache.delete(year);
    // —— 垃圾回收：被移除的存储键若已无引用，连对象本体一起删 ——
    const deletedObjects = removedKeys.length ? await collectGarbage(removedKeys) : [];
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

  return writeLibrary(async () => {
    const file = path.join(cfg.data, `${year}.json`);
    const raw = await fsp.readFile(file, 'utf8').catch(() => null);
    if (!raw) throw new HttpError(404, '清单不存在');
    const manifest = JSON.parse(raw);
    const batch = (manifest.batches || []).find((b) => b.name === segs[0]);
    if (!batch) throw new HttpError(404, '批次不存在');

    if (!name) assignFolderIds(manifest);
    const before = name ? null : folderIndex(manifest);
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

    if (before) rememberFolderChanges(manifest, before);
    // 重新统计（与 remove 同款；此前漏了 totals，首页合计会停在旧数字）
    recalcManifestStats(manifest);

    await writeJsonAtomic(file, manifest);
    manifestCache.delete(year);
    // 改名事件写进 uplog：tree2-publish 开头会把它应用到本地文件夹，
    // 否则下次发布会用本地旧名把云端新名覆盖回去
    await appendUplog({ type: 'rename', season: year, kind: renamed, path: folder, name: name || '', newName, actor: actorOf(req), at: new Date().toISOString() });
    json(res, 200, { ok: true, kind: renamed, newName });
  });
});

// ---------------- 短链分享（管理，要口令） ----------------
// 给存储键生成「短码 + 四位提取码」，Console 只显示短链
route('POST', /^\/api\/tree2\/shortlink$/, async (req, res) => {
  requireWrite(req);
  const body = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
  const year = safeYear(body.year);
  const key = safeKey(body.key);
  const st = await fsp.stat(objPath(key)).catch(() => null);
  if (!st || !st.isFile()) throw new HttpError(404, '这个文件不在对象库里');
  const meta = (await keyMetaMap()).get(key);
  const result = await shortLinks.create({
    key,
    name: body.name || (meta && meta.name) || path.basename(key),
    season: year,
    ext: path.extname(key),
    size: st.size,
  });
  const base = `${(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host || 'files.example.com'}`;
  json(res, 200, { ...result, url: `${base}/s/${result.code}` });
});

// 列出 / 吊销短链（运维）
route('GET', /^\/api\/tree2\/shortlink$/, async (req, res) => {
  requireWrite(req);
  json(res, 200, { items: (await shortLinks.list()).map(({ pin, ...rest }) => rest), total: (await shortLinks.load()).length });
});

route('DELETE', /^\/api\/tree2\/shortlink\/([0-9a-z]{4})$/, async (req, res, [, code]) => {
  requireWrite(req);
  const removed = await shortLinks.revoke(code);
  if (!removed) throw new HttpError(404, '分享码不存在');
  json(res, 200, { ok: true });
});

// ---------------- 批次内目录整理 ----------------
route('POST', /^\/api\/tree2\/arrange$/, async (req, res) => {
  requireWrite(req);
  let body;
  try { body = JSON.parse(await readBody(req, 16 * 1024)); }
  catch (error) { if (error instanceof SyntaxError) throw new HttpError(400, '目录操作请求格式不合法'); throw error; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '目录操作请求格式不合法');
  const year = safeYear(body.year);
  const { action, source, destination, name, kind, revision } = body;
  if (revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) {
    throw new HttpError(400, '请先预览目录操作');
  }
  const operation = { action, source, destination, name, kind };
  const run = async () => {
    const manifest = await readManifestFile(year).catch(error => {
      if (error.code === 'ENOENT') throw new HttpError(404, '清单不存在');
      throw error;
    });
    let plan;
    try {
      plan = planArrangement(manifest, operation);
      if (revision !== undefined) {
        if (revision !== plan.summary.revision) throw new HttpError(409, '清单已更新，请重新预览');
        assignFolderIds(manifest);
        const before = folderIndex(manifest);
        plan.apply();
        assignFolderIds(manifest);
        rememberFolderChanges(manifest, before);
        // 跨批次移动后批次统计整体重算，页面数字与实际内容对得上
        if (plan.summary.crossBatch) recalcManifestStats(manifest);
      }
    } catch (error) {
      if (error instanceof ArrangeError) throw new HttpError(error.status, error.message);
      throw error;
    }
    if (revision === undefined) return json(res, 200, plan.summary);
    recalcManifestStats(manifest);
    await writeJsonAtomic(path.join(cfg.data, `${year}.json`), manifest);
    manifestCache.delete(year);
    await appendUplog({ type: 'arrange', season: year, ...operation, actor: actorOf(req), at: new Date().toISOString() });
    json(res, 200, { ok: true, ...plan.summary });
  };
  return revision === undefined ? run() : writeLibrary(run);
});

// ---------------- 预建空批次（admin：先建批次再发顾客口令） ----------------
route('POST', /^\/api\/tree2\/batch$/, async (req, res) => {
  requireWrite(req);
  const body = JSON.parse((await readBody(req, 16 * 1024)) || '{}');
  const year = safeYear(body.year);
  const name = String(body.name || '').trim().replace(/^\/+|\/+$/g, '');
  if (!name) throw new HttpError(400, '批次名不能为空');
  if (name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) throw new HttpError(400, '批次名不合法');
  if (name.length > 120) throw new HttpError(400, '批次名太长（≤120 字）');
  return writeLibrary(async () => {
    const file = path.join(cfg.data, year + '.json');
    const raw = await fsp.readFile(file, 'utf8').catch(() => null);
    if (!raw) throw new HttpError(404, '这一届的清单还没生成');
    const m = JSON.parse(raw);
    m.batches = m.batches || [];
    if (m.batches.some((b) => b.name === name)) return json(res, 200, { ok: true, created: false });
    m.batches.push(newBatch(name));
    m.batches.sort(sortNames);
    recalcManifestStats(m); // 统一走共享实现（batch / attach / remove / rename 同款）
    await writeJsonAtomic(file, m);
    manifestCache.delete(year);
    json(res, 200, { ok: true, created: true, stage: t2StageOf(name) });
  });
});

// ---------------- 顾客口令管理（admin） ----------------



// 顾客口令校验（公开，只返回非敏感信息；token 是 128-bit 随机值，无法枚举）

// ---------------------------------------------------------------- 接口：上传


function uploadDirectory(year, key, auth, uploadId) {
  if (uploadId != null && (typeof uploadId !== 'string' || !/^[0-9a-f]{32}$/.test(uploadId))) {
    throw new HttpError(400, '上传会话不合法');
  }
  const scope = createHash('sha256').update(JSON.stringify([year, key, auth.kind, auth.rec?.id, uploadId ?? null])).digest('hex');
  return path.join(TMP, scope);
}

async function mergeParts(dir, parts, tempFile, expect) {
  let size = 0;
  const hash = createHash('sha256');
  await pipeline(async function* () {
    for (let i = 0; i < parts; i++) {
      const piece = path.join(dir, `${i}.part`);
      const stat = await fsp.stat(piece).catch(error => {
        if (error.code === 'ENOENT') throw new HttpError(409, `缺第 ${i} 片，请重传`);
        throw error;
      });
      if (!stat.isFile()) throw new HttpError(409, `缺第 ${i} 片，请重传`);
      for await (const chunk of fs.createReadStream(piece)) {
        size += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    }
  }, fs.createWriteStream(tempFile, { flags: 'wx' }));
  if (hash.digest('hex') !== expect) throw new HttpError(422, '内容校验失败：合并后的 sha256 与上传前不一致');
  return size;
}


function treeHasKey(node, key) {
  return (node.c || []).some(child => child.t === 'd' ? treeHasKey(child, key) : child.k === key);
}

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
const sortNames = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
const sortChildren = (a, b) => a.t === b.t ? a.n.localeCompare(b.n, 'zh-Hans-CN', { numeric: true }) : a.t === 'd' ? -1 : 1;
function newBatch(name) {
  return {
    name, stage: t2StageOf(name), type: t2TypeOf(name),
    date: (/(\d{4}[.\-年]\d{1,2})/.exec(name) || [, ''])[1],
    files: 0, dirs: 0, bytes: 0, subj: [],
    tree: newFolder(name),
  };
}

async function attachToManifest(year, m, key, body, actor, uploadKind) {
  const file = path.join(cfg.data, `${year}.json`);
  const { folder: segs, name, size } = body;
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(name) || [, ''])[1].toLowerCase();
  m.batches ||= [];
  let batch = m.batches.find(b => b.name === segs[0]);
  if (!batch) {
    batch = newBatch(segs[0]);
    m.batches.push(batch);
    m.batches.sort(sortNames);
  }
  let parent = batch.tree;
  for (const segment of segs.slice(1)) {
    let sub = (parent.c || []).find(c => c.t === 'd' && c.n === segment);
    if (!sub) {
      sub = newFolder(segment);
      (parent.c ||= []).push(sub);
      parent.c.sort(sortChildren);
    }
    parent = sub;
  }
  parent.c ||= [];
  const existing = (parent.c || []).find((c) => c.t === 'f' && c.n === name);
  const changed = existing?.k !== key;
  const attributes = { s: size, h: body.sha256, k: key, e: ext ? `.${ext}` : '' };
  if (existing) Object.assign(existing, attributes);
  else {
    // w（首次入库日期）与 build-tree2-index 同格式：首页「最近 7 天新增」和排序都靠它
    parent.c.push({ n: name, t: 'f', ...attributes, w: new Date().toISOString().slice(0, 10) });
    parent.c.sort(sortChildren);
  }
  if (batch) batch.subj = [...new Set([...(batch.subj || []), ...T2_SUBJECTS.filter((s) => name.includes(s))])];

  // 更新统计，页面刷新后数字对得上
  recalcManifestStats(m);
  m.totals.uniqueFiles = null;

  // 入库成功：排队一条推送事件（具体怎么发在 tree2-ingest-push.mjs 里）
  const notification = changed
    ? await ingestPush.enqueue({
        year,
        batchId: batch.tree.folderId,
        batch: batch.name,
        name,
        origin: uploadKind,
        key,
        folder: segs,
      })
    : undefined;
  try {
    await writeJsonAtomic(file, m);
  } catch (error) {
    ingestPush.cancel(notification);
    throw error;
  }
  manifestCache.delete(year);

  // 记录「本机上传」来源（区别于 pan-sync 从本地盘发布的那批），
  // 本地的 tree2-publish 每次发布会把这些采纳回本地清单，避免被重建覆盖
  await appendUplog({ season: year, key, name, folder: segs.join('/'), sha256: body.sha256, actor, at: new Date().toISOString() });
}

// 入库推送：队列、发送、重试全在 tree2-ingest-push.mjs。
// 这里只负责把「读配置 / 读 manifest」这两项能力注进去，然后起轮询。
const updateCredentials = cfg.token && !cfg.privateRead ? await readUpdateCredentials(SHARES_DIR) : {};
const ingestPush = createIngestPush({
  sharesDir: SHARES_DIR,
  endpoint: resolveUpdateEndpoint(cfg, updateCredentials),
  token: typeof updateCredentials.token === 'string' ? updateCredentials.token : '',
  writeLibrary,
  readManifest: readManifestFile,
  log: (m) => console.log(m),
});

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
    await writeJsonAtomic(UPLOG_FILE, list, 1);
  } catch (error) {
    console.error('[tree2] 写入上传日志失败', error);
  }
}


// 站点公开配置：静态页（index.html、Navidrome 页脚）从这里取备案号等环境值
route('GET', /^\/api\/tree2\/site$/, (req, res) => {
  // 备案号一辈子不变：让浏览器当天直接用本地缓存，不必每次回源拉这几十字节
  json(res, 200, { icp: cfg.icp }, { 'Cache-Control': 'public, max-age=86400' });
});

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
route('GET', /^\/$/, async (req, res, m, url) => {
  // 带参数的根路径（/?s=2026 这类书签/分享，和线上站点一样的地址形态）直接进资料库；
  // 落地页只保留给裸根路径，纯本地开发用。
  if (url.search) {
    res.writeHead(302, { ...cors(req), Location: `/tree2/index.html${url.search}` });
    return res.end();
  }
  const files = await fsp.readdir(cfg.data).catch(() => []);
  const years = files.filter((f) => /^\d{4}\.json$/.test(f)).map((f) => f.slice(0, 4)).sort();
  const addr = req.headers.host || '127.0.0.1:8787';
  const api = `http://${addr}`;
  const row = (label, href, note) =>
    `<tr><td><a href="${href}">${label}</a></td><td><code>${href.replace(api, '')}</code></td><td>${note}</td></tr>`;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>tree2 文件服务</title>
${SHARE_PAGE_THEME}
<style>
 :root{--paper:var(--t2-paper);--card:var(--t2-card);--ink:var(--t2-ink);--line:var(--t2-line);--sub:var(--t2-muted)}
 *{box-sizing:border-box}
 body{margin:0;padding:0 20px 48px;font:14px/1.7 "Microsoft YaHei","PingFang SC",sans-serif;color:var(--ink);
      background:radial-gradient(900px 340px at 50% -10%,#fff6e0,rgba(255,246,224,0) 70%),var(--paper);
      transition:background-color .3s ease,color .3s ease}
 html[data-theme="dark"] body{background:radial-gradient(900px 340px at 50% -10%,#232a36,rgba(35,42,54,0) 70%),var(--paper)}
 .t-top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;height:52px;
        margin:0 -20px 26px;padding:0 16px;background:rgba(255,250,240,.86);backdrop-filter:blur(10px);
        border-bottom:1px solid var(--t2-line);transition:background-color .3s ease,border-color .3s ease}
 html[data-theme="dark"] .t-top{background:rgba(23,25,29,.86)}
 .t-brand{font-weight:900;letter-spacing:.04em}
 .t-brand small{font-weight:500;font-size:11px;color:var(--sub);letter-spacing:.18em;margin-left:6px}
 .t-spacer{flex:1}
 .t-link{padding:7px 14px;background:var(--t2-action);color:var(--t2-action-ink);border-radius:9px;text-decoration:none;font-weight:600;font-size:13px}
 main{max-width:760px;margin:0 auto}
 h1{font-size:24px;margin:0 0 4px}p.deck{color:var(--sub);margin:0 0 24px}
 table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;transition:background-color .3s ease,border-color .3s ease}
 td{padding:9px 12px;border-bottom:1px solid var(--t2-line);vertical-align:top}
 tr:last-child td{border-bottom:0}
 code{font-size:12px;color:var(--sub);word-break:break-all}
 a{color:var(--ink)}
 .big{display:inline-block;margin:0 0 24px;padding:11px 20px;background:var(--t2-action);color:var(--t2-action-ink);border-radius:9px;text-decoration:none}
 h2{font-size:15px;margin:26px 0 8px}
 .theme-anim *,.theme-anim body{transition:background-color .32s ease,color .32s ease,border-color .32s ease !important}
</style></head>
<body>
<header class="t-top">
  <span class="t-brand">tree2 文件服务<small>DEV SERVER</small></span>
  <span class="t-spacer"></span>
  <a class="t-link" href="/tree2/index.html?api=${api}">打开资料库 →</a>
  ${themeToggle}
</header>
<main>
<h1>tree2 文件服务</h1>
<p class="deck">静态页面 + 清单 + 文件字节。下面每个链接都能直接点。</p>
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
</main>
</body></html>`;
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

// WebDAV 网关实例（口令与主服务同一个 TREE2_TOKEN：用户名任意、密码填 token 即可）
const webdav = createWebdavHandler({
  dataDir: cfg.data,
  objectsDir: OBJECTS,
  uplogFile: UPLOG_FILE,
  writeLibrary,    // WebDAV 的清单写操作进主服务串行队列，防并发互踩
  token: cfg.token,
  // WebDAV 专用口令（TREE2_WEBDAV_TOKEN）：与主口令并行有效。
  // 主口令留给 console/backend/bot，WebDAV 客户端用这一套，可单独轮换不影响其它服务。
  webdavToken: process.env.TREE2_WEBDAV_TOKEN || '',
  // 分级账号：customer 只能新建目录与上传，visitor 只读。
  customerToken: process.env.TREE2_CUSTOMER_TOKEN || '',
  visitorToken: process.env.TREE2_VISITOR_TOKEN || '',
  collectGarbage,   // 删除后回收无引用对象（全库引用检查）
  ingestPush,       // 与主服务共用推送队列：WebDAV 上传也要通知群里
  stageOf: t2StageOf,
  typeOf: t2TypeOf,
  log: (m) => console.log(m),
});

const playerDirectory = cfg.host === '127.0.0.1' && process.env.TREE2_LOCAL_PLAYER_DIR;
const { createLocalPlayer, localPlayerId } = playerDirectory ? await import('./preview-local-player.mjs') : {};
const serveLocalPlayer = await createLocalPlayer?.(playerDirectory, async key => (await keyMetaMap()).get(key));

async function tree2Handler(req, res) {
  // json() 需要读 Origin 才能回正确的 CORS 头
  res.req = req;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // WebDAV 网关：把哈希对象库翻译成中文名目录树（读写双向），见 tree2-webdav.mjs。
  // 必须排在通用 OPTIONS 拦截之前——WebDAV 客户端靠 OPTIONS 的 DAV 头探测能力，
  // 拿不到 DAV: 1,2 会判定文件夹无效、不再尝试。
  if (req.url === '/webdav' || req.url.startsWith('/webdav/')) {
    return webdav(req, res);
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors(req));
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (serveLocalPlayer && (req.method === 'GET' || req.method === 'HEAD')) {
      if (url.pathname.startsWith('/music/share/')) {
        requireRead(req);
        if (await serveLocalPlayer(req, res, url)) return;
      }
      if (/^\/(?:music-custom\.(?:js|css)|assets\/(?:facivon\.svg|pet\.gif))$/.test(url.pathname)) {
        return await serveStatic(req, res, `/tree2${url.pathname}`);
      }
    }
    for (const r of router) {
      // HEAD 按 GET 处理：<audio preload="metadata">、下载器的探测、CORS 预检都会先发 HEAD，
      // 只认 GET 的话它们一律拿 404，音频就播不了、下载器也不认。
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      return await r.fn(req, res, m, url);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const pathname = /^(?:\/vendor\/|\/js\/(?:theme|preview|wmf-view)\.js$)/.test(url.pathname) ? `/tree2${url.pathname}` : url.pathname;
      return await serveStatic(req, res, pathname);
    }
    throw new HttpError(404, '没有这个接口');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[tree2]', url.pathname, e);
    if (res.headersSent) return res.end();
    json(res, status, {
      error: e instanceof HttpError ? e.message : '服务器错误',
      ...(e instanceof HttpError && e.code ? { code: e.code } : {}),
    }, cors(req));
  }
}

const server = http.createServer(tree2Handler);

// ---------------- 分片临时目录 GC ----------------
// 清理一天未更新的上传会话。
async function sweepTmpParts() {
  const dirs = await fsp.readdir(TMP).catch(() => []);
  const now = Date.now();
  for (const d of dirs) {
    if (!/^(?:[0-9a-f]{64}|[0-9a-f]{2}_[0-9a-f]{64}(?:\.[a-z0-9]{1,8})?)$/.test(d)) continue;
    const p = path.join(TMP, d);
    const s = await fsp.stat(p).catch(() => null);
    if (s && now - s.mtimeMs > 24 * 3600 * 1000) {
      await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function sweepMergedFiles() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const prefix of await fsp.readdir(OBJECTS).catch(() => [])) {
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    const directory = path.join(OBJECTS, prefix);
    for (const name of await fsp.readdir(directory).catch(() => [])) {
      if (!/^[0-9a-f]{64}(?:\.[a-z0-9]{1,8})?\.(?:\d+|[0-9a-f-]{36})\.tmp$/.test(name)) continue;
      const file = path.join(directory, name);
      const stat = await fsp.lstat(file).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < cutoff) await fsp.unlink(file).catch(() => {});
    }
  }
}
const sweepUploads = () => Promise.all([sweepTmpParts(), sweepMergedFiles()]);
setInterval(sweepUploads, 6 * 3600 * 1000).unref();

await fsp.mkdir(OBJECTS, { recursive: true });
await fsp.mkdir(TMP, { recursive: true });
sweepUploads();
function onListenError(error) {
  console.error(`tree2 无法监听 ${cfg.host}:${cfg.port}（${error.code || error.message}）`);
  if (process.connected) {
    process.send({ type: 'listen-error', code: error.code }, () => process.disconnect());
  }
  process.exitCode = 1;
}
server.once('error', onListenError);
server.listen(cfg.port, cfg.host, () => {
  server.off('error', onListenError);
  // 计入目录配置齐了才起推送轮询；没配就是空转，不影响别的功能
  if (ingestPush.enabled()) ingestPush.start();
  const addr = `${cfg.host}:${server.address().port}`;
  console.log(`tree2 文件服务已启动  http://${addr}`);
  console.log(`  静态站  http://${addr}/tree2/index.html?api=http://${addr}`);
  console.log(`  存储    ${cfg.store}`);
  console.log(`  清单    ${cfg.data}`);
  console.log(`  鉴权    ${cfg.token ? '写操作需要 Bearer token' : '未设口令（仅建议本机使用）'}${cfg.privateRead ? '，读也要口令' : ''}`);
  console.log(`  CORS    ${cfg.allowOrigin.join(', ')}`);
  if (process.connected) {
    process.once('disconnect', () => server.close());
    process.send({ type: 'listening', port: server.address().port });
  }
});

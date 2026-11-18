/**
 * tree2 WebDAV 网关：把「哈希对象库 + 清单 JSON」实时翻译成中文名目录树。
 *
 * 存储层不变（仍是 objects/<sha前2>/<sha256>.<ext> + 年份清单 JSON），这里只做路径翻译：
 *   /webdav/                       → 届别列表（2027届 / 2026届 …）
 *   /webdav/2027/                  → 该届所有批次
 *   /webdav/2027/<批次>/            → 批次内目录与文件
 *   /webdav/2027/<批次>/<子目录>/…   → 递归
 *
 * 读：GET 文件 → 对象库流式返回（支持 Range）；PROPFIND → 目录与属性
 * 写：PUT 新文件 → 落对象库 + 写清单 + uplog（本地 pan-sync 会跟着取回）
 *     MKCOL 建目录 / DELETE 下架（移出清单，对象保留，与 console 下架同语义）
 *     MOVE 同批次内移动/改名
 *
 * 鉴权复用主服务的 TREE2_TOKEN（Basic 用户名任意、密码=token，或 Bearer）。
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const XML = 'application/xml; charset=utf-8';

export function createWebdavHandler({
  dataDir,        // 清单目录（.../public/tree2/data）
  objectsDir,     // 对象库（.../storage/tree2/objects）
  uplogFile,      // uplog.json
  token,          // 读写口令；空则不加鉴权（仅本机）
  collectGarbage, // 可选：删除后回收无引用对象（由主服务注入，做全库引用检查）
  yearLabel = (y) => `${y}届`,
  log = () => {},
}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeYear = (y) => {
    const s = String(y || '').trim();
    if (!/^\d{4}$/.test(s)) throw Object.assign(new Error('届别不合法'), { status: 400 });
    return s;
  };
  const badSeg = (s) => !s || s === '.' || s === '..' || /[\\/\x00-\x1f]/.test(s);

  /** 收集节点自身的 key 及其子树里的所有文件 key（删除前调用）。 */
  function collectKeys(node, out) {
    if (!node) return out;
    if (node.t === 'f') {
      if (node.k) out.add(node.k);
      return out;
    }
    for (const c of node.c || []) collectKeys(c, out);
    return out;
  }

  const manifestFile = (year) => path.join(dataDir, `${year}.json`);

  async function loadManifest(year) {
    const raw = await fsp.readFile(manifestFile(year), 'utf8').catch(() => null);
    if (!raw) throw Object.assign(new Error('这一届的清单还没生成'), { status: 404 });
    return JSON.parse(raw);
  }

  async function saveManifest(year, m) {
    const countFiles = (n) => (n.c || []).reduce((x, c) => x + (c.t === 'd' ? countFiles(c) : 1), 0);
    const countDirs = (n) => (n.c || []).reduce((x, c) => x + (c.t === 'd' ? countDirs(c) + 1 : 0), 0);
    const sumBytes = (n) => (n.c || []).reduce((x, c) => x + (c.t === 'd' ? sumBytes(c) : c.s || 0), 0);
    for (const b of m.batches || []) {
      b.files = countFiles(b.tree);
      b.dirs = countDirs(b.tree);
      b.bytes = sumBytes(b.tree);
    }
    m.totals = m.totals || {};
    m.totals.files = (m.batches || []).reduce((n, b) => n + b.files, 0);
    m.totals.bytes = (m.batches || []).reduce((n, b) => n + b.bytes, 0);
    m.totals.uniqueFiles = null;
    const tmp = `${manifestFile(year)}.${process.pid}.dav.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(m, null, 2));
    await fsp.rename(tmp, manifestFile(year));
  }

  async function appendUplog(entry) {
    try {
      let list = [];
      try {
        list = JSON.parse(await fsp.readFile(uplogFile, 'utf8'));
        if (!Array.isArray(list)) list = [];
      } catch { /* 首条 */ }
      list.push(entry);
      if (list.length > 1000) list = list.slice(-1000);
      const tmp = `${uplogFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(list, null, 1));
      await fsp.rename(tmp, uplogFile);
    } catch { /* 事件日志失败不影响主流程 */ }
  }

  async function listYears() {
    const files = await fsp.readdir(dataDir).catch(() => []);
    return files.filter((f) => /^\d{4}\.json$/.test(f)).map((f) => f.slice(0, 4)).sort().reverse();
  }

  async function resolve(segs) {
    if (!segs.length) return { kind: 'root' };
    const year = safeYear(segs[0]);
    if (segs.length === 1) return { kind: 'year', year };
    const m = await loadManifest(year);
    const batch = (m.batches || []).find((b) => b.name === segs[1]);
    if (!batch) return { kind: 'missing', year };
    let node = batch.tree;
    for (const s of segs.slice(2)) {
      if (!node || node.t !== 'd') return { kind: 'missing', year };
      node = (node.c || []).find((c) => c.n === s);
      if (!node) return { kind: 'missing', year };
    }
    return { kind: node.t === 'f' ? 'file' : 'dir', year, batch, node };
  }

  const keyPath = (key) => path.join(objectsDir, ...String(key).split('/'));

  const same = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  };

  function authorized(req) {
    if (!token) return true;
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return same(h.slice(7), token);
    if (h.startsWith('Basic ')) {
      try {
        const [user, pass] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
        return Boolean(user) && same(pass || '', token); // 用户名任意（Windows 要求非空），密码 = token
      } catch { return false; }
    }
    return false;
  }

  const ISO = (d) => new Date(d || Date.now()).toISOString();

  function propEntry({ href, isDir, size, mtime, displayName }) {
    return `<D:response><D:href>${esc(href)}</D:href><D:propstat><D:prop>` +
      `<D:displayname>${esc(displayName)}</D:displayname>` +
      (isDir
        ? '<D:resourcetype><D:collection/></D:resourcetype><D:getcontentlength>0</D:getcontentlength>'
        : `<D:resourcetype/><D:getcontentlength>${size || 0}</D:getcontentlength><D:getcontenttype>application/octet-stream</D:getcontenttype>`) +
      `<D:getlastmodified>${ISO(mtime)}</D:getlastmodified>` +
      `<D:creationdate>${ISO(mtime)}</D:creationdate>` +
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
  }

  async function handlePropfind(req, res, segs) {
    const target = await resolve(segs);
    if (target.kind === 'missing') { res.writeHead(404); return res.end(); }
    const depth = String(req.headers.depth || '1');
    const items = [];
    const pushNode = (href, name, node) => {
      if (node?.t === 'f') items.push(propEntry({ href, isDir: false, size: node.s, mtime: node.w, displayName: name }));
      else items.push(propEntry({ href: href.endsWith('/') ? href : `${href}/`, isDir: true, mtime: Date.now(), displayName: name }));
    };

    if (target.kind === 'root') {
      pushNode('/webdav', '资料库', { t: 'd' });
      if (depth !== '0') for (const y of await listYears()) pushNode(`/webdav/${y}`, yearLabel(y), { t: 'd' });
    } else if (target.kind === 'year') {
      const m = await loadManifest(target.year);
      pushNode(`/webdav/${target.year}`, yearLabel(target.year), { t: 'd' });
      if (depth !== '0') for (const b of m.batches || []) pushNode(`/webdav/${target.year}/${encodeURIComponent(b.name)}`, b.name, b.tree);
    } else {
      const { node } = target;
      const selfHref = `/webdav/${segs.map(encodeURIComponent).join('/')}`;
      pushNode(selfHref, node.n, node);
      if (depth !== '0' && node.t === 'd') {
        for (const c of node.c || []) pushNode(`${selfHref}/${encodeURIComponent(c.n)}`, c.n, c);
      }
    }

    const body = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${items.join('')}</D:multistatus>`;
    res.writeHead(207, { 'Content-Type': XML, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  async function handleGet(req, res, target) {
    const node = target.node;
    if (!node.k) { res.writeHead(404); return res.end('这个条目没有对应的文件内容'); }
    const file = keyPath(node.k);
    const st = await fsp.stat(file).catch(() => null);
    if (!st) { res.writeHead(404); return res.end('对象已不在库里'); }
    const base = {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date(node.w || st.mtime).toUTCString(),
      ETag: `"${node.h || st.size}"`,
    };
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : st.size - 1;
        if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        end = Math.min(end, st.size - 1);
        res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        return createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, { ...base, 'Content-Length': st.size });
    createReadStream(file).pipe(res);
  }

  async function handlePut(req, res, segs) {
    if (segs.length < 3) { res.writeHead(409); return res.end('必须写到批次目录里'); }
    const year = safeYear(segs[0]);
    const fileName = segs[segs.length - 1];
    if (badSeg(fileName)) { res.writeHead(400); return res.end('文件名不合法'); }

    const tmp = path.join(objectsDir, '..', `.dav-${process.pid}-${Date.now()}.tmp`);
    const hash = createHash('sha256');
    const chunks = [];
    try {
      for await (const chunk of req) { hash.update(chunk); chunks.push(chunk); }
      await fsp.writeFile(tmp, Buffer.concat(chunks));
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      res.writeHead(500); return res.end('接收失败');
    }
    const size = chunks.reduce((n, c) => n + c.length, 0);
    const sha256 = hash.digest('hex');
    const ext = (/\.[a-z0-9]{1,8}$/i.exec(fileName) || [''])[0].toLowerCase();
    const key = `${sha256.slice(0, 2)}/${sha256}${ext}`;
    const dst = keyPath(key);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    const existedObject = await fsp.stat(dst).catch(() => null);
    // 同哈希对象已存在 → 丢弃临时文件复用（不重复占空间）
    await fsp.rename(tmp, dst).catch(async () => { await fsp.rm(tmp, { force: true }).catch(() => {}); });

    const m = await loadManifest(year);
    const batch = (m.batches || []).find((b) => b.name === segs[1]);
    if (!batch) { res.writeHead(409); return res.end('批次不存在（先建批次再上传）'); }
    let node = batch.tree;
    for (const s of segs.slice(2, -1)) {
      let next = (node.c || []).find((c) => c.t === 'd' && c.n === s);
      if (!next) { next = { n: s, t: 'd', c: [] }; (node.c = node.c || []).push(next); }
      node = next;
    }
    const existing = (node.c || []).find((c) => c.n === fileName && c.t === 'f');
    const today = new Date().toISOString().slice(0, 10);
    if (existing) {
      Object.assign(existing, { s: size, h: sha256, k: key, e: ext, w: existing.w || today });
    } else {
      (node.c = node.c || []).push({ n: fileName, t: 'f', s: size, h: sha256, k: key, e: ext, w: today });
    }
    await saveManifest(year, m);
    await appendUplog({ season: year, key, name: fileName, folder: segs.slice(1, -1).join('/'), sha256, at: new Date().toISOString() });
    log(`[webdav] PUT ${segs.join('/')} (${size} B) → ${key}${existedObject ? '（复用已有对象）' : ''}`);
    res.writeHead(existing ? 204 : 201);
    res.end();
  }

  async function handleMkcol(req, res, segs) {
    if (segs.length < 3) { res.writeHead(405); return res.end('只能在批次内建目录'); }
    const year = safeYear(segs[0]);
    const m = await loadManifest(year);
    const batch = (m.batches || []).find((b) => b.name === segs[1]);
    if (!batch) { res.writeHead(409); return res.end('批次不存在'); }
    let node = batch.tree;
    for (const s of segs.slice(2, -1)) {
      const next = (node.c || []).find((c) => c.t === 'd' && c.n === s);
      if (!next) { res.writeHead(409); return res.end('上级目录不存在'); }
      node = next;
    }
    const name = segs[segs.length - 1];
    if ((node.c || []).some((c) => c.n === name)) { res.writeHead(405); return res.end('同名条目已存在'); }
    (node.c = node.c || []).push({ n: name, t: 'd', c: [] });
    await saveManifest(year, m);
    await appendUplog({ type: 'mkdir', season: year, path: segs.slice(1, -1).join('/'), name, at: new Date().toISOString() });
    log(`[webdav] MKCOL ${segs.join('/')}`);
    res.writeHead(201);
    res.end();
  }

  async function handleDelete(req, res, segs) {
    if (segs.length < 3) { res.writeHead(403); return res.end('不能删除届或批次，请用 console'); }
    const year = safeYear(segs[0]);
    const m = await loadManifest(year);
    const batch = (m.batches || []).find((b) => b.name === segs[1]);
    if (!batch) { res.writeHead(404); return res.end(); }
    let parent = batch.tree;
    for (const s of segs.slice(2, -1)) {
      parent = (parent.c || []).find((c) => c.t === 'd' && c.n === s);
      if (!parent) { res.writeHead(404); return res.end(); }
    }
    const name = segs[segs.length - 1];
    const idx = (parent.c || []).findIndex((c) => c.n === name);
    if (idx < 0) { res.writeHead(404); return res.end(); }
    // 摘除前记下 key：清单落盘后才能判断这个对象是否还被别处引用
    const candidates = new Set();
    collectKeys(parent.c[idx], candidates);
    parent.c.splice(idx, 1);
    await saveManifest(year, m);
    await appendUplog({ type: 'remove', season: year, path: segs.join('/'), name, at: new Date().toISOString() });
    // 无引用则回收对象本体（与 console 删除同语义）
    let deleted = [];
    if (collectGarbage && candidates.size) {
      try {
        deleted = await collectGarbage(candidates);
      } catch (e) {
        log(`[webdav] GC 失败：${e.message}`);
      }
    } else if (!collectGarbage) {
      log('[webdav] 未注入 collectGarbage，跳过对象回收');
    } else {
      log(`[webdav] 删除条目无 key（${name}），无需回收`);
    }
    log(`[webdav] DELETE ${segs.join('/')}${deleted.length ? `（回收 ${deleted.length} 个对象）` : ''}`);
    res.writeHead(204);
    res.end();
  }

  async function handleMove(req, res, segs) {
    const dest = String(req.headers.destination || '');
    if (!dest) { res.writeHead(400); return res.end('缺少 Destination 头'); }
    let destPath = '';
    try {
      destPath = decodeURIComponent(new URL(dest, 'http://x').pathname);
    } catch { res.writeHead(400); return res.end('Destination 不合法'); }
    const prefix = '/webdav/';
    if (!destPath.startsWith(prefix)) { res.writeHead(400); return res.end('只能移到 /webdav/ 下'); }
    const toSegs = destPath.slice(prefix.length).split('/').filter(Boolean);
    if (toSegs.length < 3) { res.writeHead(409); return res.end('目标必须在批次内'); }
    const year = safeYear(segs[0]);
    if (safeYear(toSegs[0]) !== year) { res.writeHead(409); return res.end('暂不支持跨届移动'); }
    const m = await loadManifest(year);

    const locate = (s) => {
      const b = (m.batches || []).find((x) => x.name === s[1]);
      if (!b) return null;
      let parent = b.tree;
      for (const seg of s.slice(2, -1)) {
        parent = (parent.c || []).find((c) => c.t === 'd' && c.n === seg);
        if (!parent) return null;
      }
      const name = s[s.length - 1];
      const idx = (parent.c || []).findIndex((c) => c.n === name);
      if (idx < 0) return null;
      return { parent, idx, node: parent.c[idx] };
    };
    const src = locate(segs);
    if (!src) { res.writeHead(404); return res.end('源条目不存在'); }
    const dstBatch = (m.batches || []).find((x) => x.name === toSegs[1]);
    if (!dstBatch) { res.writeHead(409); return res.end('目标批次不存在'); }
    let dstParent = dstBatch.tree;
    for (const seg of toSegs.slice(2, -1)) {
      dstParent = (dstParent.c || []).find((c) => c.t === 'd' && c.n === seg);
      if (!dstParent) { res.writeHead(409); return res.end('目标目录不存在'); }
    }
    const newName = toSegs[toSegs.length - 1];
    if ((dstParent.c || []).some((c) => c.n === newName)) { res.writeHead(405); return res.end('目标已存在同名条目'); }

    src.parent.c.splice(src.idx, 1);
    src.node.n = newName;
    (dstParent.c = dstParent.c || []).push(src.node);
    await saveManifest(year, m);
    await appendUplog({ type: 'move', season: year, source: segs.join('/'), destination: toSegs.join('/'), kind: src.node.t === 'f' ? 'file' : 'dir', at: new Date().toISOString() });
    log(`[webdav] MOVE ${segs.join('/')} → ${toSegs.join('/')}`);
    res.writeHead(201);
    res.end();
  }

  return async function webdavHandler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const segs = url.pathname.slice('/webdav'.length).split('/').filter(Boolean).map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
    // OPTIONS 必须在鉴权之前：Windows「添加网络位置」向导和 macOS Finder 靠匿名 OPTIONS
    // 探测服务器能力，收到 401 会直接判定「文件夹无效」并不再尝试。
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        DAV: '1,2',
        'MS-Author-Via': 'DAV',
        'MS-Author-Via-Lock': 'DAV',
        Allow: 'OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,MOVE,PROPFIND,PROPPATCH,LOCK,UNLOCK',
        'Content-Length': '0',
      });
      return res.end();
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="tree2"' });
      return res.end('需要口令：用户名任意，密码 = TREE2_TOKEN');
    }
    try {
      if (segs.some(badSeg)) { res.writeHead(400); return res.end('路径不合法'); }
      if (req.method === 'PROPFIND') return await handlePropfind(req, res, segs);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const target = await resolve(segs);
        if (target.kind !== 'file') { res.writeHead(405); return res.end('目录不能直接 GET，用 PROPFIND'); }
        return await handleGet(req, res, target);
      }
      if (req.method === 'PUT') return await handlePut(req, res, segs);
      if (req.method === 'MKCOL') return await handleMkcol(req, res, segs);
      if (req.method === 'DELETE') return await handleDelete(req, res, segs);
      if (req.method === 'MOVE') return await handleMove(req, res, segs);
      // Windows 资源管理器写入前会尝试 LOCK：给一个「假锁」（不真正互斥，
      // 但返回合法 token），否则它会降级成只读挂载或直接放弃。
      if (req.method === 'LOCK') {
        const token = `opaquelocktoken:${randomUUID()}`;
        const body = `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
          `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>` +
          `<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>` +
          `<D:locktoken><D:href>${token}</D:href></D:locktoken></D:activelock></D:lockdiscovery></D:prop>`;
        res.writeHead(200, { 'Content-Type': XML, 'Lock-Token': `<${token}>`, 'Content-Length': Buffer.byteLength(body) });
        return res.end(body);
      }
      if (req.method === 'UNLOCK') { res.writeHead(204); return res.end(); }
      if (req.method === 'PROPPATCH') {
        // 只回成功，不真正存自定义属性（资源管理器设「标记/标签」时会发）
        const body = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response>` +
          `<D:href>${esc(url.pathname)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
          '</D:response></D:multistatus>';
        res.writeHead(207, { 'Content-Type': XML, 'Content-Length': Buffer.byteLength(body) });
        return res.end(body);
      }
      res.writeHead(405, { Allow: 'OPTIONS,GET,HEAD,PUT,DELETE,MKCOL,MOVE,PROPFIND,PROPPATCH,LOCK,UNLOCK' });
      res.end('不支持的方法');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log(`[webdav] 500 ${req.method} ${url.pathname}: ${e.message}`);
      if (!res.headersSent) res.writeHead(status);
      res.end(e.message || '服务器错误');
    }
  };
}

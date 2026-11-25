import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { Script, createContext } from 'node:vm';

const script = fileURLToPath(new URL('../scripts/tree2-files-server.mjs', import.meta.url));
const preserveFolderIds = fileURLToPath(new URL('../scripts/tree2-preserve-folder-ids.mjs', import.meta.url));
const adminToken = 'local-test-admin-token';
// WebDAV 分级账号口令：customer 只能上传，visitor 只读
const customerToken = 'customer-secret-token-for-test-1234567890';
const visitorToken = 'visitor-secret-token-for-test-12345678901';
const batch = name => ({ name, tree: { n: name, t: 'd', c: [] } });
const fixture = input => {
  const bytes = Buffer.from(input);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256, key: `${sha256.slice(0, 2)}/${sha256}.txt`, uploadId: randomBytes(16).toString('hex') };
};

test('closing a pending PDF preview destroys its document and suppresses stale errors', async () => {
  const previewUrl = new URL('../public/tree2/js/preview.js', import.meta.url);
  const source = await readFile(previewUrl, 'utf8');
  const { promise: firstPage, reject: failPage } = Promise.withResolvers();
  const { promise: pageRequested, resolve: requestPage } = Promise.withResolvers();
  let destroyed = 0;
  const box = { innerHTML: 'New preview', appendChild() { assert.fail('Stale PDF wrote to the new preview'); } };
  const context = createContext({
    Blob, URL, setTimeout, clearTimeout,
    location: { href: 'https://fixture.example/' },
    document: { createElement: () => ({}), head: { appendChild: script => queueMicrotask(script.onload) } },
    window: {
      pdfjsLib: {
        GlobalWorkerOptions: {},
        getDocument: () => ({
          promise: Promise.resolve({
            numPages: 1,
            getPage() { requestPage(); return firstPage; },
            async destroy() { destroyed++; },
          }),
        }),
      },
      addEventListener() { assert.fail('Stale PDF registered a window listener'); },
    },
  });
  const scriptSource = source
    .replace(/^export /gm, '')
    .replaceAll('import.meta.url', JSON.stringify(previewUrl.href));
  const { render, disposePdf } = new Script(scriptSource + '\n;({ render, disposePdf });').runInContext(context);
  let current = true;
  const preview = render(box, new Blob(['fixture']), 'first.pdf', { isCurrent: () => current });
  await pageRequested;
  current = false;
  disposePdf();
  failPage(new Error('PDF was closed'));
  await preview;
  assert.equal(destroyed, 1);
  assert.equal(box.innerHTML, 'New preview');
});

test('folder shares bypass service worker caching so updates and removals are visible', async () => {
  const source = await readFile(new URL('../public/tree2/sw.js', import.meta.url), 'utf8');
  const origin = 'https://test.invalid';
  let fetchHandler;
  new Script(source).runInContext(createContext({
    URL, location: { origin },
    self: { addEventListener: (type, listener) => { if (type === 'fetch') fetchHandler = listener; } },
  }));
  for (const path of ['/d/2026/old', '/d/id/2026/2ac475ac-b878-4ccc-a9da-3d3547093569']) {
    fetchHandler({
      request: { method: 'GET', url: origin + path, headers: new Headers() },
      respondWith: () => assert.fail('Folder shares must go straight to the network'),
    });
  }
});

test('catalogue writes, webdav and short links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tree2-upload-test-'));
  const data = join(root, 'data'), store = join(root, 'store'), shares = join(root, 'shares');
  const serverDir = join(root, 'scripts');
  const fixtureScript = join(serverDir, 'tree2-files-server.mjs');
  const faultInjection = join(serverDir, 'write-failure.mjs');
  const blockedStream = fixture('fixture for failed merge stream');
  const tokensFile = join(shares, 'customer-tokens.json');
  const legacy = { id: 'f'.repeat(12), token: 'a'.repeat(32), batches: ['Unique', 'Shared'], uses: 2, maxUses: 3, expiresAt: Date.now() + 3600000 };
  const scopedLegacy = { id: 'e'.repeat(12), token: 'b'.repeat(32), batchYear: [{ name: 'Shared', year: '2027' }], uses: 0, maxUses: 1 };
  let child;
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  await Promise.all([mkdir(data), mkdir(shares), mkdir(serverDir)]);
  // 把整个 scripts/ 复制过去，而不是逐个点名：
  // 服务端拆出子模块后（如 tree2-ingest-push.mjs），逐个复制很容易漏，
  // 漏了就会 ERR_MODULE_NOT_FOUND，而这里恰恰是部署前的门禁测试。
  await copyFile(script, fixtureScript);
  const scriptsDir = fileURLToPath(new URL('../scripts', import.meta.url));
  for (const entry of await readdir(scriptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs') || entry.name === 'tree2-files-server.mjs') continue;
    await copyFile(join(scriptsDir, entry.name), join(serverDir, entry.name));
  }
  for (const [directory, file] of [['js', 'theme.js'], ['css', 'theme.css']]) {
    const fixtureDir = join(root, 'public', 'tree2', directory);
    await mkdir(fixtureDir, { recursive: true });
    await copyFile(new URL(`../public/tree2/${directory}/${file}`, import.meta.url), join(fixtureDir, file));
  }
  await writeFile(faultInjection, `
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { basename } from 'node:path';
const create = fs.createWriteStream;
const fetchUpstream = globalThis.fetch;
globalThis.fetch = (url, options) => String(url).startsWith('https://tree-updates.example.test/')
  ? Promise.resolve(new Response(null, { status: 503 }))
  : fetchUpstream(url, options);
fs.createWriteStream = (file, ...args) => basename(file).startsWith('${blockedStream.sha256}.txt.')
  ? new Writable({ write(chunk, encoding, callback) { callback(Object.assign(new Error('fixture disk write failed'), { code: 'EIO' })); } })
  : create(file, ...args);
`);
  await Promise.all([
    writeFile(join(data, '2026.json'), JSON.stringify({ batches: [batch('Unique'), batch('Shared')] })),
    writeFile(join(data, '2027.json'), JSON.stringify({ batches: [batch('Shared')] })),
    writeFile(join(data, '2029.json'), JSON.stringify({ batches: [{
      ...batch('原批次'),
      tree: { ...batch('原批次').tree, c: [batch('原目录').tree, batch('目标').tree] },
    }, batch('Guest 目标批次')] })),
    writeFile(tokensFile, JSON.stringify([legacy, scopedLegacy])),
  ]);
  let origin;
  async function start(updateEnv = {}) {
    child = spawn(process.execPath, ['--import', pathToFileURL(faultInjection).href, fixtureScript, '--port', '0', '--data', data, '--store', store, '--token', adminToken,
      '--allow-origin', 'https://allowed.example'], { env: { ...process.env, TREE2_SHARES_DIR: shares, TREE2_UPDATE_ORIGIN: '', TREE2_UPDATE_TOKEN: '', TREE2_CUSTOMER_TOKEN: customerToken, TREE2_VISITOR_TOKEN: visitorToken, ...updateEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    const lines = createInterface({ input: child.stdout });
    try {
      const ready = await Promise.race([
        once(lines, 'line').then(([line]) => line),
        once(child, 'exit').then(() => { throw new Error(stderr || 'Tree2 exited before listening'); }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tree2 startup timed out')), 5000).unref()),
      ]);
      origin = ready.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      assert.ok(origin, ready);
    } finally {
      lines.close();
      child.stdout.resume();
    }
  }
  await start({ TREE2_ICP: '闽ICP备00000000号-1' });
  const readManifest = async year => JSON.parse(await readFile(join(data, year + '.json'), 'utf8'));
  async function api(path, { token = adminToken, method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(origin + '/api/tree2/' + path, {
      method, headers: { 'X-Tree2-Token': token, ...headers },
      body: Buffer.isBuffer(body) ? body : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const create = (batches, maxUses) => api('ctoken', { method: 'POST', body: { batches, maxUses } });
  const part = (file, { year = '2026', token, index = 0 } = {}) => api(`files/${year}/part?k=${encodeURIComponent(file.key)}&i=${index}&n=1&uploadId=${file.uploadId}`, { method: 'PUT', token, body: file.bytes });
  const commit = (file, { year = '2026', token, name = 'x.txt', folder = 'Shared', parts = 1 } = {}) => api(`files/${year}/commit`, {
    method: 'POST', token, body: { name, folder, parts, key: file.key, sha256: file.sha256, uploadId: file.uploadId, size: 99999 },
  });


  const file = fixture('existing fixture');



  await t.test('audio forwards HEAD and Range, and unconfigured preview serves local bytes', async () => {
    const bytes = Buffer.from('audio fixture');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `${sha256.slice(0, 2)}/${sha256}.mp3`;
    const audioUrl = origin + '/api/tree2/files/2026?k=' + encodeURIComponent(key);
    const vinylRoute = `/api/tree2/vinyl/2029/${sha256}.mp3`;
    const vinylStream = origin + vinylRoute.replace('/2029/', '/2029/share/s/');
    await mkdir(join(store, 'objects', sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(store, 'objects', key), bytes);
    assert.deepEqual(Buffer.from(await (await fetch(audioUrl)).arrayBuffer()), bytes);
    assert.deepEqual(Buffer.from(await (await fetch(vinylStream)).arrayBuffer()), bytes);
    const share = await fetch(`${origin}/s/${key}`, { redirect: 'manual' });
    assert.equal(share.status, 302);
    assert.equal(share.headers.get('location'), vinylRoute);
    const document = await fetch(origin + vinylRoute);
    assert.equal(document.status, 200);
    assert.equal(document.headers.get('content-security-policy'), "frame-ancestors 'self'");
    assert.match(await document.text(), /\/music\/share\/assets\/index-7wbOXZOY\.js/);
    const calls = [];
    const upstream = createServer((req, res) => {
      calls.push([req.method, req.headers.range]);
      res.writeHead(req.headers.range ? 206 : 200, {
        'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes',
        'Content-Length': req.headers.range ? 2 : bytes.length,
        ...(req.headers.range ? { 'Content-Range': `bytes 1-2/${bytes.length}` } : {}),
      });
      res.end(req.method === 'HEAD' ? undefined : bytes.subarray(1, 3));
    }).listen(0, '127.0.0.1');
    try {
      await once(upstream, 'listening');
      await writeFile(join(data, 'navidrome.json'), JSON.stringify({ internal: 'http://127.0.0.1:' + upstream.address().port, user: 'fixture', password: 'fixture' }));
      await writeFile(join(data, 'audio-map.json'), JSON.stringify({ [sha256]: 'fixture' }));
      const head = await fetch(audioUrl, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(bytes.length));
      const range = await fetch(audioUrl, { headers: { Range: 'bytes=1-2' } });
      assert.equal(range.status, 206);
      assert.equal(range.headers.get('content-range'), `bytes 1-2/${bytes.length}`);
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(1, 3));
      const vinylRange = await fetch(vinylStream, { headers: { Range: 'bytes=1-2' } });
      assert.equal(vinylRange.status, 206);
      assert.deepEqual(Buffer.from(await vinylRange.arrayBuffer()), bytes.subarray(1, 3));
      assert.deepEqual(calls, [['HEAD', undefined], ['GET', 'bytes=1-2'], ['GET', 'bytes=1-2']]);
    } finally {
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
  });

  await t.test('directory preview blocks conflicts and rejects stale confirmations', async () => {
    const year = '2028';
    const entry = name => ({ t: 'f', n: name, k: file.key, s: file.bytes.length });
    const folder = (n, c) => ({ t: 'd', n, c });
    await writeFile(join(data, year + '.json'), JSON.stringify({ batches: [
      { name: '整理', tree: folder('整理', [
        entry('Keep.txt'),
        folder('外层', [folder('内层', [entry('A.txt')])]),
        folder('卷子', [entry('B.txt'), folder('科目', [entry('C.txt')])]),
        folder('冲突目录', [entry('KEEP.txt')]),
      ]) },
      batch('另一个批次'),
    ] }));
    const arrange = (body, token) => api('arrange', { method: 'POST', token, body: { year, ...body } });
    const previewAndApply = async (operation, counters = {}) => {
      const preview = await arrange(operation);
      assert.equal(preview.status, 200);
      for (const [key, value] of Object.entries(counters)) assert.deepEqual(preview.body[key], value);
      const result = await arrange({ ...operation, revision: preview.body.revision });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
    };
    const conflict = { action: 'dissolve', source: ['整理', '冲突目录'] };
    const before = await readManifest(year);
    const preview = await arrange(conflict);
    assert.deepEqual(preview.body.conflicts, ['KEEP.txt']);
    assert.equal((await arrange({ ...conflict, revision: preview.body.revision })).status, 409);
    assert.deepEqual(await readManifest(year), before);
    const move = { action: 'move', kind: 'd', source: ['整理', '外层'], destination: ['整理', '卷子'] };
    assert.equal((await arrange({ ...move, destination: ['整理', '外层', '内层'] })).status, 400);
    assert.equal((await arrange(move, 'guest')).status, 401);
    const stale = await arrange(move);
    await previewAndApply({ action: 'mkdir', source: ['整理'], name: '归档' });
    assert.equal((await arrange({ ...move, revision: stale.body.revision })).status, 409);
    await previewAndApply({ action: 'dissolve', source: ['整理', '外层'] }, { movedEntries: 1, movedFiles: 1, foldersRemoved: 1 });
    await previewAndApply({ ...move, source: ['整理', '内层'], destination: ['整理', '归档'] }, { movedFiles: 1 });
    await previewAndApply({ action: 'flatten', source: ['整理', '卷子'] }, { movedFiles: 1, foldersRemoved: 1 });
    const manifest = await readManifest(year);
    const root = manifest.batches[0].tree.c;
    assert.deepEqual(root.find(row => row.n === '卷子').c.map(row => row.n), ['B.txt', 'C.txt']);
    assert.equal(root.find(row => row.n === '归档').c[0].c[0].k, file.key);
    assert.equal(manifest.totals.files, 5);
    assert.equal(manifest.totals.bytes, 5 * file.bytes.length);
    const uplog = JSON.parse(await readFile(join(shares, 'uplog.json'), 'utf8'));
    assert.deepEqual(uplog.filter(row => row.type === 'arrange').map(row => row.action), ['mkdir', 'dissolve', 'move', 'flatten']);
  });

  await t.test('directory move can cross batches and keeps batch stats and folder identity', async () => {
    const year = '2031';
    const entry = name => ({ t: 'f', n: name, k: file.key, s: file.bytes.length });
    const folder = (n, c) => ({ t: 'd', n, c });
    await writeFile(join(data, year + '.json'), JSON.stringify({ batches: [
      { name: '源批次', tree: folder('源批次', [
        entry('根文件.txt'),
        folder('搬家目录', [entry('D.txt'), folder('深层', [entry('E.txt')])]),
        folder('留下', [entry('F.txt')]),
      ]) },
      { name: '目标批次', tree: folder('目标批次', [entry('G.txt')]) },
      batch('空批次'),
    ] }));
    const arrange = async operation => {
      const preview = await api('arrange', { method: 'POST', body: { year, ...operation } });
      assert.equal(preview.status, 200, `preview ${JSON.stringify(operation)} => ${preview.status} ${JSON.stringify(preview.body)}`);
      return preview.body;
    };
    // 文件夹跨批次移动：预览标注 crossBatch，搬走 2 个文件
    const folderMove = await arrange({ action: 'move', kind: 'd', source: ['源批次', '搬家目录'], destination: ['目标批次'] });
    assert.equal(folderMove.crossBatch, true);
    assert.equal(folderMove.movedEntries, 1);
    assert.equal(folderMove.movedFiles, 2);
    assert.equal(folderMove.conflictCount, 0);
    assert.equal((await api('arrange', { method: 'POST', body: { year, ...{ action: 'move', kind: 'd', source: ['源批次', '搬家目录'], destination: ['目标批次'] }, revision: folderMove.revision } })).status, 200);
    // 单个文件跨批次移动
    const fileMove = await arrange({ action: 'move', kind: 'f', source: ['源批次', '根文件.txt'], destination: ['目标批次', '收件夹'] });
    assert.equal(fileMove.crossBatch, true);
    assert.equal(fileMove.movedFiles, 1);
    const apply = await api('arrange', { method: 'POST', body: { year, ...{ action: 'move', kind: 'f', source: ['源批次', '根文件.txt'], destination: ['目标批次', '收件夹'] }, revision: fileMove.revision } });
    assert.equal(apply.status, 200);
    const manifest = await readManifest(year);
    const source = manifest.batches.find(b => b.name === '源批次');
    const target = manifest.batches.find(b => b.name === '目标批次');
    const inbox = target.tree.c.find(row => row.n === '收件夹');
    assert.deepEqual(inbox.c.map(row => row.n), ['根文件.txt']);
    assert.deepEqual(target.tree.c.find(row => row.n === '搬家目录').c.map(row => row.n), ['D.txt', '深层']);
    assert.equal(source.tree.c.some(row => row.n === '搬家目录'), false);
    // 批次统计随内容走（服务端 recalcManifestStats 兜底后的结果）
    assert.equal(source.files, 1);
    assert.equal(source.bytes, file.bytes.length);
    assert.equal(target.files, 4);
    assert.equal(target.bytes, 4 * file.bytes.length);
    assert.equal(manifest.totals.files, 5);
    assert.equal(manifest.totals.bytes, 5 * file.bytes.length);
    // 移走后原路径 404，/id/ 稳定链接 302 到新批次路径；旧批次内路径不复用
    const moved = target.tree.c.find(row => row.n === '搬家目录');
    assert.match(await (await fetch(origin + `/d/id/${year}/${moved.folderId}`, { redirect: 'manual' })).text(), /目标批次/);
    // 不存在的目标批次拒绝，不会无中生有
    const missing = await api('arrange', { method: 'POST', body: { year, action: 'move', kind: 'f', source: ['源批次', '留下', 'F.txt'], destination: ['不存在批次'] } });
    assert.equal(missing.status, 404);
  });

  await t.test('webdav gateway browses, uploads and recycles objects', async () => {
    const year = '2033';
    const dav = (method, pathname, { body, headers = {}, token = adminToken, auth } = {}) => fetch(origin + pathname, {
      method,
      headers: {
        ...(auth === null ? {} : {
          Authorization: 'Basic ' + Buffer.from(`${auth || 'anyuser'}:${token}`).toString('base64'),
        }),
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    await writeFile(join(data, year + '.json'), JSON.stringify({ batches: [
      { name: 'DAV 批次', tree: { n: 'DAV 批次', t: 'd', c: [] } },
    ] }));
    const batch = encodeURIComponent('DAV 批次');
    // 匿名 OPTIONS 必须放行并声明 DAV 能力（Windows 映射网络驱动器靠它探测）
    const options = await dav('OPTIONS', '/webdav/', { auth: null });
    assert.equal(options.status, 200);
    assert.equal(options.headers.get('dav'), '1,2');
    assert.match(options.headers.get('allow'), /PROPFIND/);
    // 无口令 / 错口令一律 401
    assert.equal((await dav('PROPFIND', '/webdav/', { auth: null })).status, 401);
    assert.equal((await dav('PROPFIND', '/webdav/', { token: 'wrong' })).status, 401);
    // PROPFIND 列出届别与批次
    const root = await dav('PROPFIND', '/webdav/', { headers: { Depth: '1' } });
    assert.equal(root.status, 207);
    const rootXml = await root.text();
    assert.match(rootXml, /资料库/);
    assert.match(rootXml, new RegExp(`${year}届`));
    // 目录列表
    const list = await dav('PROPFIND', `/webdav/${year}/`, { headers: { Depth: '1' } });
    assert.equal(list.status, 207);
    assert.match(await list.text(), /DAV 批次/);
    // MKCOL → PUT → GET
    assert.equal((await dav('MKCOL', `/webdav/${year}/${batch}/新目录`)).status, 201);
    assert.equal((await dav('MKCOL', `/webdav/${year}/${batch}/新目录`)).status, 405);
    const put = await dav('PUT', `/webdav/${year}/${batch}/新目录/a.txt`, { body: 'webdav payload' });
    assert.equal(put.status, 201);
    const got = await dav('GET', `/webdav/${year}/${batch}/新目录/a.txt`);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'webdav payload');
    // Range 请求
    const ranged = await dav('GET', `/webdav/${year}/${batch}/新目录/a.txt`, { headers: { Range: 'bytes=0-5' } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), 'webdav');
    // 同名覆盖返回 204
    assert.equal((await dav('PUT', `/webdav/${year}/${batch}/新目录/a.txt`, { body: 'webdav payload 2' })).status, 204);
    const manifest = await readManifest(year);
    const node = manifest.batches[0].tree.c.find(r => r.n === '新目录').c.find(r => r.n === 'a.txt');
    assert.equal(node.s, 'webdav payload 2'.length);
    // 对象确实落到对象库
    assert.equal((await stat(join(store, 'objects', node.k))).size, node.s);
    // DELETE 后对象被回收
    assert.equal((await dav('DELETE', `/webdav/${year}/${batch}/新目录/a.txt`)).status, 204);
    await assert.rejects(stat(join(store, 'objects', node.k)), { code: 'ENOENT' });
    assert.equal((await readManifest(year)).batches[0].tree.c.find(r => r.n === '新目录').c.length, 0);
    // 批次级操作：新建 → 改名 → 删除，都不再需要 Console
    const created = await dav('MKCOL', `/webdav/${year}/B9 新批次`);
    assert.equal(created.status, 201);
    assert.equal((await dav('MKCOL', `/webdav/${year}/B9 新批次`)).status, 405);
    const newBatchRec = (await readManifest(year)).batches.find(b => b.name === 'B9 新批次');
    assert.equal(newBatchRec.stage, 'B');
    const renamed = await dav('MOVE', `/webdav/${year}/${encodeURIComponent('B9 新批次')}`, {
      headers: { Destination: `${origin}/webdav/${year}/${encodeURIComponent('C9 改名批次')}` },
    });
    assert.equal(renamed.status, 201, `rename => ${renamed.status} ${await renamed.text()}`);
    const afterRename = (await readManifest(year)).batches.find(b => b.name === 'C9 改名批次');
    assert.equal(afterRename.stage, 'C');
    assert.equal(afterRename.tree.n, 'C9 改名批次');
    assert.equal((await dav('DELETE', `/webdav/${year}/${encodeURIComponent('C9 改名批次')}`)).status, 204);
    assert.equal((await readManifest(year)).batches.some(b => b.name === 'C9 改名批次'), false);
    // 写入口必须落在批次内
    assert.equal((await dav('PUT', `/webdav/${year}/loose.txt`, { body: 'x' })).status, 409);
  });

  await t.test('webdav roles: customer can only upload, visitor is read-only', async () => {
    const year = '2035';
    const batch = encodeURIComponent('角色批次');
    const cDir = encodeURIComponent('顾客目录');
    const vDir = encodeURIComponent('访客目录');
    const cNew = encodeURIComponent('顾客自建批次');
    await writeFile(join(data, year + '.json'), JSON.stringify({ batches: [
      { name: '角色批次', tree: { n: '角色批次', t: 'd', folderId: '11111111-2222-3333-4444-555555555555', c: [] } },
    ] }));
    const customerSecret = customerToken;
    const visitorSecret = visitorToken;
    const call = (method, pathname, secret, opts = {}) => fetch(origin + pathname, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`anyuser:${secret}`).toString('base64'),
        ...opts.headers,
      },
      body: opts.body,
      signal: AbortSignal.timeout(5000),
    });
    // 三种口令并存：管理员仍可全权操作
    assert.equal((await call('PROPFIND', `/webdav/${year}/`, adminToken, { headers: { Depth: '1' } })).status, 207);
    // 顾客：能看、能建目录、能上传
    assert.equal((await call('PROPFIND', `/webdav/${year}/`, customerSecret, { headers: { Depth: '1' } })).status, 207);
    assert.equal((await call('MKCOL', `/webdav/${year}/${batch}/${cDir}`, customerSecret)).status, 201);
    assert.equal((await call('PUT', `/webdav/${year}/${batch}/${cDir}/c.txt`, customerSecret, { body: 'from customer' })).status, 201);
    const got = await call('GET', `/webdav/${year}/${batch}/${cDir}/c.txt`, customerSecret);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'from customer');
    // 顾客：不能覆盖已有文件（只允许新建，或给 0 字节占位补内容）
    assert.equal((await call('PUT', `/webdav/${year}/${batch}/${cDir}/c.txt`, customerSecret, { body: 'overwritten' })).status, 403);
    assert.equal(await (await call('GET', `/webdav/${year}/${batch}/${cDir}/c.txt`, customerSecret)).text(), 'from customer');
    // 顾客：不能删除、不能改名、不能建批次
    assert.equal((await call('DELETE', `/webdav/${year}/${batch}/${cDir}/c.txt`, customerSecret)).status, 403);
    assert.equal((await call('MOVE', `/webdav/${year}/${batch}/${cDir}/c.txt`, customerSecret, {
      headers: { Destination: `${origin}/webdav/${year}/${batch}/${cDir}/d.txt` },
    })).status, 403);
    assert.equal((await call('MKCOL', `/webdav/${year}/${cNew}`, customerSecret)).status, 403);
    // 访客：只能看和下载
    assert.equal((await call('PROPFIND', `/webdav/${year}/`, visitorSecret, { headers: { Depth: '1' } })).status, 207);
    assert.equal((await call('GET', `/webdav/${year}/${batch}/${cDir}/c.txt`, visitorSecret)).status, 200);
    assert.equal((await call('PUT', `/webdav/${year}/${batch}/v.txt`, visitorSecret, { body: 'nope' })).status, 403);
    assert.equal((await call('MKCOL', `/webdav/${year}/${batch}/${vDir}`, visitorSecret)).status, 403);
    assert.equal((await call('DELETE', `/webdav/${year}/${batch}/${cDir}/c.txt`, visitorSecret)).status, 403);
    // 错误口令仍然 401
    assert.equal((await call('PROPFIND', `/webdav/${year}/`, 'wrong-secret', { headers: { Depth: '0' } })).status, 401);
    // 被拒绝的写操作确实没落库
    const manifest = await readManifest(year);
    const dir = manifest.batches[0].tree.c.find(r => r.n === '顾客目录');
    assert.deepEqual(dir.c.map(r => r.n), ['c.txt']);
    assert.equal(manifest.batches.some(b => b.name === '顾客自建批次'), false);
  });

  await t.test('webdav concurrent PUTs keep every entry (serialized manifest writes)', async () => {
    const put = (name, body) => fetch(origin + '/webdav/2026/Shared/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body,
      signal: AbortSignal.timeout(15000),
    });
    const [ra, rb] = await Promise.all([put('并发甲.txt', '甲的内容'), put('并发乙.txt', '乙的内容')]);
    assert.equal(ra.status, 201, `甲 => ${ra.status}`);
    assert.equal(rb.status, 201, `乙 => ${rb.status}`);
    const shared = (await readManifest('2026')).batches.find(b => b.name === 'Shared').tree.c.map(r => r.n);
    assert.ok(shared.includes('并发甲.txt') && shared.includes('并发乙.txt'), `两个 PUT 都要留在清单里：${shared.join('、')}`);
  });

  await t.test('webdav MOVE refuses to move a folder into its own subtree', async () => {
    const mk = async (pathname) => {
      const made = await fetch(origin + pathname, { method: 'MKCOL', headers: { Authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(10000) });
      assert.equal(made.status, 201, `MKCOL ${pathname} => ${made.status}`);
    };
    await mk('/webdav/2026/Shared/自环目录');
    await mk('/webdav/2026/Shared/自环目录/内部');
    const moved = await fetch(origin + '/webdav/2026/Shared/' + encodeURIComponent('自环目录'), {
      method: 'MOVE',
      headers: { Authorization: `Bearer ${adminToken}`, Destination: origin + '/webdav/2026/Shared/' + encodeURIComponent('自环目录') + '/' + encodeURIComponent('内部') + '/' + encodeURIComponent('挪走') },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(moved.status, 409);
    const shared = (await readManifest('2026')).batches.find(b => b.name === 'Shared').tree;
    const dir = shared.c.find(r => r.n === '自环目录');
    assert.ok(dir, '目录仍要在清单里');
    assert.ok(dir.c.some(r => r.n === '内部'), '子目录仍要在清单里');
  });

  await t.test('short link requires the pin and throttles guessing', async () => {
    const year = '2034';
    const entry = { t: 'f', n: 'short.pdf', k: file.key, s: file.bytes.length };
    await writeFile(join(data, year + '.json'), JSON.stringify({ batches: [
      { name: '短链批次', tree: { n: '短链批次', t: 'd', c: [entry] } },
    ] }));
    // 对象要真实存在，创建短链时会 stat
    await mkdir(join(store, 'objects', file.key.split('/')[0]), { recursive: true });
    await writeFile(join(store, 'objects', ...file.key.split('/')), file.bytes);
    const created = await api('shortlink', { method: 'POST', body: { year, key: file.key, name: 'short.pdf' } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const { code, pin, url } = created.body;
    assert.match(code, /^[0-9a-z]{4}$/);
    assert.match(pin, /^[0-9a-z]{4}$/);
    assert.match(url, /\/s\/[0-9a-z]{4}$/);
    // 同一文件再次创建复用短码，不会每次点都发新的
    const again = await api('shortlink', { method: 'POST', body: { year, key: file.key, name: 'short.pdf' } });
    assert.equal(again.body.code, code);
    assert.equal(again.body.reused, true);
    const open = pathname => fetch(origin + pathname, { signal: AbortSignal.timeout(5000) });
    // 不带 pin：给落地页，不泄露文件
    const locked = await open(`/s/${code}`);
    assert.equal(locked.status, 200);
    assert.match(await locked.text(), /提取码/);
    // 正确 pin：给出真实分享页
    const opened = await open(`/s/${code}?pin=${pin}`);
    assert.equal(opened.status, 200);
    assert.match(await opened.text(), /short\.pdf/);
    // 错误 pin 只给提示，不给文件
    const wrong = await open(`/s/${code}?pin=zzzz`);
    assert.equal(wrong.status, 200);
    assert.doesNotMatch(await wrong.text(), /short\.pdf/);
    // 连续输错触发限流
    let throttled = null;
    for (let i = 0; i < 6; i++) {
      const attempt = await open(`/s/${code}?pin=zzzz`);
      if (attempt.status === 429) { throttled = attempt; break; }
    }
    assert.ok(throttled, '连续输错应触发限流');
    assert.ok(Number(throttled.headers.get('retry-after')) > 0);
    // 不存在的短码：不带 pin 只给落地页（不泄露存在性），带 pin 才回 404
    assert.equal((await open('/s/zzzz')).status, 200);
    assert.equal((await open('/s/zzzz?pin=1234')).status, 404);
    // 吊销后失效（换一个客户端来源，避开上面的锁定）
    const list = await api('shortlink');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some(row => row.code === code));
    assert.equal((await api(`shortlink/${code}`, { method: 'DELETE' })).status, 200);
    const gone = await fetch(origin + `/s/${code}?pin=${pin}`, { signal: AbortSignal.timeout(5000) });
    assert.ok([404, 403, 429].includes(gone.status), `吊销后 => ${gone.status}`);
  });

  await t.test('site config endpoint serves ICP from environment', async () => {
    const response = await fetch(origin + '/api/tree2/site', { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).icp, '闽ICP备00000000号-1');
  });

  await t.test('whole batch can be merged into another batch', async () => {
    const year = '2032';
    const entry = name => ({ t: 'f', n: name, k: file.key, s: file.bytes.length });
    const folder = (n, c) => ({ t: 'd', n, c });
    await writeFile(join(data, year + '.json'), JSON.stringify({ batches: [
      { name: '待并入批次', tree: folder('待并入批次', [entry('甲.txt'), folder('答案', [entry('乙.txt')])]) },
      { name: '接收批次', tree: folder('接收批次', [folder('归档', [])]) },
    ] }));
    const arrange = async operation => {
      const preview = await api('arrange', { method: 'POST', body: { year, ...operation } });
      assert.equal(preview.status, 200, `preview ${JSON.stringify(operation)} => ${preview.status} ${JSON.stringify(preview.body)}`);
      const applied = await api('arrange', { method: 'POST', body: { year, ...operation, revision: preview.body.revision } });
      assert.equal(applied.status, 200);
      return preview.body;
    };
    // 目标目录已存在
    const first = await arrange({ action: 'move', kind: 'd', source: ['待并入批次'], destination: ['接收批次', '归档'] });
    assert.equal(first.crossBatch, true);
    assert.equal(first.movedEntries, 2);
    assert.equal(first.movedFiles, 2);
    assert.equal(first.foldersRemoved, 1);
    const manifest = await readManifest(year);
    assert.deepEqual(manifest.batches.map(b => b.name), ['接收批次']);
    assert.deepEqual(manifest.batches[0].tree.c.find(r => r.n === '归档').c.map(r => r.n), ['答案', '甲.txt']);
    assert.equal(manifest.totals.files, 2);
    assert.equal(manifest.totals.bytes, 2 * file.bytes.length);
    // 目标目录不存在时自动创建
    await writeFile(join(data, year + '.json'), JSON.stringify({ batches: [
      { name: '待并入批次', tree: folder('待并入批次', [entry('丙.txt')]) },
      { name: '接收批次', tree: folder('接收批次', []) },
    ] }));
    const second = await arrange({ action: 'move', kind: 'd', source: ['待并入批次'], destination: ['接收批次', '新归档'] });
    assert.equal(second.foldersCreated, 1);
    assert.deepEqual((await readManifest(year)).batches[0].tree.c.find(r => r.n === '新归档').c.map(r => r.n), ['丙.txt']);
    // 拒绝不安全的整批并入
    await writeFile(join(data, year + '.json'), JSON.stringify({ batches: [
      { name: '待并入批次', tree: folder('待并入批次', [entry('甲.txt')]) },
      { name: '接收批次', tree: folder('接收批次', [folder('归档', [entry('甲.txt')])]) },
      batch('空批次'),
    ] }));
    const conflict = await api('arrange', { method: 'POST', body: { year, action: 'move', kind: 'd', source: ['待并入批次'], destination: ['接收批次', '归档'] } });
    assert.equal(conflict.body.conflictCount, 1);
    assert.deepEqual(conflict.body.conflicts, ['甲.txt']);
    for (const destination of [['待并入批次', '归档'], ['接收批次'], ['不存在', '归档']]) {
      const rejected = await api('arrange', { method: 'POST', body: { year, action: 'move', kind: 'd', source: ['待并入批次'], destination } });
      assert.ok(rejected.status === 400 || rejected.status === 404, `${destination.join('/')} => ${rejected.status}`);
    }
    const empty = await api('arrange', { method: 'POST', body: { year, action: 'move', kind: 'd', source: ['空批次'], destination: ['接收批次', '归档'] } });
    assert.equal(empty.status, 400);
  });


});

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('catalogue writes, scoped guest tokens and resumable parts', async t => {
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
      '--allow-origin', 'https://allowed.example'], { env: { ...process.env, TREE2_SHARES_DIR: shares, TREE2_UPDATE_ORIGIN: '', TREE2_UPDATE_TOKEN: '', ...updateEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  await start();
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

  await t.test('legacy links retain identity, quota, expiry and unambiguous scope after restart', async () => {
    const migrated = JSON.parse(await readFile(tokensFile, 'utf8'));
    const id = (await readManifest('2026')).batches[0].tree.folderId;
    const scopedId = (await readManifest('2027')).batches[0].tree.folderId;
    assert.deepEqual(migrated, [
      { ...legacy, batchIds: [{ id, year: '2026' }] },
      { ...scopedLegacy, batchIds: [{ id: scopedId, year: '2027' }] },
    ]);
    await stop();
    await start();
    assert.deepEqual(JSON.parse(await readFile(tokensFile, 'utf8')), migrated);
    const check = await api('ctoken-check?token=' + legacy.token);
    assert.deepEqual(check.body.batchYear, [{ name: 'Unique', year: '2026' }]);
    const scopedCheck = await api('ctoken-check?token=' + scopedLegacy.token);
    assert.deepEqual(scopedCheck.body.batchYear, scopedLegacy.batchYear);
    assert.equal(check.body.remaining, 1);
    assert.equal(check.body.expiresAt, legacy.expiresAt);
    assert.equal((await create(['Shared'])).status, 400);
    const date = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const daily = createHmac('sha256', adminToken).update('customer-daily-' + date).digest('hex').slice(0, 32);
    assert.equal((await api('ctoken-check?token=' + daily)).body.kind, 'daily');
    assert.equal((await api('ctoken')).body.daily, daily);
  });

  const file = fixture('existing fixture');
  await t.test('valid part, malformed index, concurrent seconds and actual byte totals', async () => {
    assert.equal((await part(file, { index: '' })).status, 400);
    assert.equal((await part(file)).status, 200);
    assert.equal((await commit(file)).body.size, file.bytes.length);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => commit(file, { name: `${i}.txt`, parts: 0 })));
    assert.ok(results.every(result => result.status === 200 && result.body.attached));
    assert.equal((await readManifest('2026')).totals.files, 13);
    assert.equal(JSON.parse(await readFile(join(shares, 'uplog.json'), 'utf8')).length, 13);
    const empty = fixture('');
    assert.equal((await part(empty)).status, 200);
    assert.equal((await commit(empty)).body.size, 0);
    const manifest = await readManifest('2026');
    assert.equal(manifest.batches.find(b => b.name === 'Shared').tree.c.find(f => f.n === 'x.txt').s, 0);
    assert.equal(manifest.totals.bytes, 12 * file.bytes.length);
  });

  await t.test('guest scope, atomic quota, revocation and stable quick-upload recovery', async () => {
    const created = await create([{ year: '2026', name: 'Shared' }], 1);
    assert.equal(created.status, 200);
    const { token } = created.body;
    assert.equal((await commit(file, { year: '2027', token, parts: 0 })).status, 403);
    const results = await Promise.all(['guest-1.txt', 'guest-2.txt'].map(name => commit(file, { token, parts: 0, name })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 403]);
    const managerList = (await api('ctoken')).body.tokens;
    assert.equal(managerList.find(rec => rec.token === token).uses, 1);
    const lacking = await create([{ year: '2026', name: 'Unique' }], 1);
    const scoped = { token: lacking.body.token, folder: 'Unique' };
    const quick = await commit(file, { ...scoped, parts: 0 });
    assert.equal(quick.body.code, 'quick_upload_failed');
    assert.equal((await part(file, scoped)).status, 200);
    assert.equal((await api('ctoken/' + lacking.body.id, { method: 'DELETE' })).status, 200);
    assert.equal((await commit(file, scoped)).status, 401);
    assert.equal((await commit(file, { token: legacy.token, parts: 0, folder: '' })).status, 403);
    assert.equal((await api('ctoken-check?token=' + legacy.token)).body.remaining, 1);
    const legacyUpload = await commit(file, { token: legacy.token, folder: 'Unique', name: 'via-original-link.txt' });
    assert.equal(legacyUpload.status, 409);
    assert.equal((await part(file, { token: legacy.token })).status, 200);
    assert.equal((await commit(file, { token: legacy.token, folder: 'Unique', name: 'via-original-link.txt' })).status, 200);
    assert.equal((await api('ctoken-check?token=' + legacy.token)).status, 403);
  });

  await t.test('hash or filesystem failure cleans staging and leaves the server running', async () => {
    const damaged = fixture('actual data');
    const invalid = { ...fixture('other hash'), bytes: damaged.bytes };
    assert.equal((await part(invalid)).status, 200);
    assert.equal((await commit(invalid)).status, 422);
    assert.deepEqual(await readdir(join(store, 'objects', invalid.key.slice(0, 2))), []);
    assert.equal((await part(blockedStream)).status, 200);
    assert.equal((await commit(blockedStream)).status, 500);
    assert.deepEqual(await readdir(join(store, 'objects', blockedStream.key.slice(0, 2))), []);
    const blocked = fixture('blocked publication');
    assert.equal((await part(blocked)).status, 200);
    await writeFile(join(store, 'objects', blocked.key.slice(0, 2)), 'not a directory');
    assert.equal((await commit(blocked)).status, 500);
    const health = await api('health', { headers: { Origin: 'https://other.example' } });
    assert.equal(health.status, 200);
    assert.equal(health.headers.has('access-control-allow-origin'), false);
    assert.equal((await api('health', { headers: { Origin: 'https://allowed.example' } })).headers.get('access-control-allow-origin'), 'https://allowed.example');
  });

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

  await t.test('guest scope and folder links follow identity through rename, moves, path reuse and restart', async () => {
    const year = '2029';
    const post = (path, body) => api(path, { method: 'POST', body: { year, ...body } });
    const verify = token => api('ctoken-check?token=' + token);
    const legacyPath = (...segs) => `/d/${year}/${encodeURIComponent(segs.join('/'))}`;
    const stablePath = node => `/d/id/${year}/${node.folderId}`;
    const get = path => fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const assertRedirect = async (from, to) => {
      const response = await get(from);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), to);
    };
    const arrange = async action => {
      const { status, body } = await post('arrange', action);
      assert.equal(status, 200, `preview ${JSON.stringify(action)} => ${status} ${JSON.stringify(body)}`);
      assert.equal((await post('arrange', { ...action, revision: body.revision })).status, 200);
    };
    const rootFolder = (await readManifest(year)).batches[0].tree;
    const stableRoot = stablePath(rootFolder);
    const stableFolder = stablePath(rootFolder.c[0]);
    const stableParent = stablePath(rootFolder.c[1]);
    const oldFolder = legacyPath('原批次', '原目录');
    assert.equal((await get(oldFolder)).status, 200);
    const { status, body: credential } = await create([{ name: '原批次', year }], 2);
    assert.equal(status, 200);

    assert.equal((await post('rename', { path: '原批次', newName: '新批次' })).status, 200);
    assert.deepEqual((await verify(credential.token)).body.batchYear, [{ name: '新批次', year }]);
    await assertRedirect(legacyPath('原批次'), stableRoot);
    await assertRedirect(oldFolder, stableFolder);
    await arrange({ action: 'move', kind: 'd', source: ['新批次', '原目录'], destination: ['新批次', '目标'] });
    assert.equal((await post('rename', { path: '新批次/目标/原目录', newName: '新目录' })).status, 200);
    await arrange({ action: 'mkdir', source: ['新批次'], name: '原目录' });
    await assertRedirect(legacyPath('新批次', '原目录'), stableFolder);
    // 跨批次移动同样保住目录身份：稳定链接仍打开原目录，落地页显示新批次下的新路径
    await arrange({ action: 'move', kind: 'd', source: ['新批次', '目标', '新目录'], destination: ['Guest 目标批次', '归档'] });
    const movedNode = (await readManifest(year)).batches.find(b => b.name === 'Guest 目标批次').tree.c.find(row => row.n === '归档').c[0];
    assert.equal(movedNode.n, '新目录');
    const landed = await get(stableFolder);
    assert.equal(landed.status, 200);
    assert.match(await landed.text(), /Guest 目标批次/);

    const livePath = join(data, year + '.json');
    const scannedPath = join(root, 'scanned.json');
    const outputPath = join(root, 'ready.json');
    const replacementPath = join(root, 'replacement.json');
    const live = await readManifest(year);
    await writeFile(scannedPath, JSON.stringify(live, (key, value) =>
      ['folderId', 'folderAliases', 'removedFolders'].includes(key) ? undefined : value));
    const preserve = (output, ...extra) => spawnSync(
      process.execPath, [preserveFolderIds, livePath, scannedPath, output, ...extra], { encoding: 'utf8' },
    );
    const merged = preserve(outputPath);
    assert.equal(merged.status, 0, merged.stderr);
    assert.equal(preserve(outputPath).status, 1);
    const regenerated = preserve(replacementPath, '--new', '新批次');
    assert.equal(regenerated.status, 0, regenerated.stderr);
    const replacementManifest = JSON.parse(await readFile(replacementPath, 'utf8'));
    assert.notEqual(replacementManifest.batches[0].tree.folderId, rootFolder.folderId);
    assert.equal(replacementManifest.removedFolders[rootFolder.folderId], null);
    await stop();
    await copyFile(outputPath, livePath);
    await start();
    const page = await get(stableFolder);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<h1>新目录<\/h1>/);
    // 重扫合并后目录仍在新批次：面包屑指向 Guest 目标批次/归档 的稳定链接
    assert.match(html, /Guest 目标批次/);
    await assertRedirect(oldFolder, stableFolder);
    assert.equal((await verify(credential.token)).body.remaining, 2);

    const renamedUpload = fixture('guest upload after batch rename');
    assert.equal((await part(renamedUpload, { year, token: credential.token })).status, 200);
    assert.equal((await commit(renamedUpload, { year, token: credential.token, folder: '新批次' })).status, 200);
    assert.equal((await verify(credential.token)).body.remaining, 1);
    await arrange({ action: 'dissolve', source: ['Guest 目标批次', '归档', '新目录'] });
    const removed = await get(stableFolder);
    assert.equal(removed.status, 410);
    const removedHtml = await removed.text();
    assert.match(removedHtml, /原目录已移除/);
    // 解散后仍显示可打开的上级目录稳定链接（上级是移动后的 归档）
    assert.match(removedHtml, /\/d\/id\/2029\//);
    await assertRedirect(oldFolder, stableFolder);

    assert.equal((await post('remove', { path: '新批次' })).status, 200);
    assert.equal((await post('batch', { name: '新批次' })).status, 200);
    assert.equal((await verify(credential.token)).status, 403);
    assert.equal((await get(stableRoot)).status, 410);
    assert.equal((await commit(renamedUpload, { year, token: credential.token, folder: '新批次', parts: 0 })).status, 403);
    const replacement = (await readManifest(year)).batches[0].tree;
    assert.notEqual(replacement.folderId, rootFolder.folderId);
    assert.equal((await get(stablePath(replacement))).status, 200);
  });

  await t.test('only committed and changed catalogue entries stage an update', async () => {
    await stop();
    await start({ TREE2_UPDATE_ORIGIN: 'https://tree-updates.example.test', TREE2_UPDATE_TOKEN: 'u'.repeat(32) });
    const outbox = join(shares, 'update-outbox');
    const entries = () => readdir(outbox).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const file = fixture('outbox fixture');
    const name = '新试卷.txt';
    assert.equal((await part(file)).status, 200);
    assert.deepEqual(await entries(), []);
    assert.equal((await commit(file, { name })).body.attached, true);
    assert.equal((await commit(file, { name, parts: 0 })).body.attached, true);
    assert.equal((await commit(file, { name: '答案.txt', parts: 0 })).body.attached, true);
    const files = await entries();
    assert.equal(files.length, 2);
    const events = await Promise.all(files.map(async file => JSON.parse(await readFile(join(outbox, file), 'utf8')).event));
    const stableBatch = (await readManifest('2026')).batches.find(batch => batch.name === 'Shared');
    assert.ok(events.every(event => event.origin === 'staff' && event.batchId === stableBatch.tree.folderId));
    assert.deepEqual(events.map(event => event.name).sort(), [name, '答案.txt'].sort());
  });
});

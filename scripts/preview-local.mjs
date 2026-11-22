import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const preview = join(root, 'storage', 'local-preview');
const data = join(preview, 'manifests');
const store = join(preview, 'store');
const index = join(data, 'seasons.json');
const token = 'tree2-local-preview';

function writeOnce(file, value) {
  return writeFile(file, value, { flag: 'wx' }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
}

async function seedPreview() {
  if (await stat(index, { throwIfNoEntry: false })) return;

  const date = new Date().toISOString();
  const year = date.slice(0, 4);
  const batch = 'A1 本地示例批次';
  const name = '预览示例.txt';
  const bytes = Buffer.from('这是一份本地预览文件。可以打开它测试文字预览，也可以在管理员页试传其他文件。\n');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const key = `${hash.slice(0, 2)}/${hash}.txt`;
  const object = join(store, 'objects', key);

  await mkdir(data, { recursive: true });
  await mkdir(join(store, 'objects', hash.slice(0, 2)), { recursive: true });
  await writeOnce(object, bytes);
  await writeOnce(join(data, `${year}.json`), JSON.stringify({
    schema: 'tree2/1',
    season: year,
    year,
    title: `${year} 届 本地示例`,
    generatedAt: date,
    source: 'local-preview',
    kinds: { text: 1 },
    stages: { A: { name: '本地示例', note: '本地预览数据' } },
    totals: { files: 1, bytes: bytes.length, uniqueFiles: 1 },
    batches: [{
      name: batch, date: date.slice(0, 7), stage: 'A', type: '示例', subj: [], files: 1, dirs: 2, bytes: bytes.length,
      tree: {
        n: batch, t: 'd', c: [{
          n: '示例文件夹', t: 'd', c: [{
            n: '试卷', t: 'd', c: [{ n: name, t: 'f', s: bytes.length, k: key, h: hash, e: '.txt', w: date.slice(0, 10) }],
          }],
        }],
      },
    }],
  }));
  await writeOnce(index, JSON.stringify({
    schema: 'tree2/1',
    seasons: [{ id: year, title: `${year} 届`, subtitle: '本地示例', batches: 1, files: 1, bytes: bytes.length, updatedAt: date, manifest: `${year}.json` }],
  }));
}

function printLinks(port) {
  const local = `http://127.0.0.1:${port}`;
  console.log(`本地示例    ${local}/tree2/index.html?api=reset`);
  console.log(`WebDAV      ${local}/webdav/（用户任意，密码 ${token}）`);
}

async function existingPreview(port) {
  if (port === 0) return false;
  const local = `http://127.0.0.1:${port}`;
  try {
    const options = { signal: AbortSignal.timeout(1200), redirect: 'error' };
    const health = await fetch(`${local}/api/tree2/health`, options);
    if (!health.ok) return false;
    const current = await health.json();
    if (current.ok !== true || current.store !== store || current.data !== data || !current.auth) return false;
    const stats = await fetch(`${local}/api/tree2/stats`, {
      ...options, headers: { 'X-Tree2-Token': token },
    });
    await stats.body?.cancel();
    return stats.ok;
  } catch {
    return false;
  }
}

const value = process.env.PORT || '8787';
if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('PORT 必须是 0–65535 的整数');
const port = Number(value);

if (await existingPreview(port)) {
  console.log(`本地预览已在端口 ${port} 运行，继续使用现有实例。`);
  printLinks(port);
} else {
  await seedPreview();
  const player = join(preview, 'navidrome');
  const playerTemplate = await stat(join(player, 'share-template.html'), { throwIfNoEntry: false });
  const child = spawn(process.execPath, [
    join(root, 'scripts', 'tree2-files-server.mjs'),
    '--host', '127.0.0.1', '--port', String(port), '--data', data, '--store', store,
    '--token', token, '--allow-origin', '',
  ], {
    cwd: root,
    env: { ...process.env, TREE2_SHARES_DIR: join(preview, 'shares'), TREE2_LOCAL_PLAYER_DIR: playerTemplate ? player : '' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', message => {
    if (message.type === 'listening') printLinks(message.port);
    if (message.type === 'listen-error' && message.code === 'EADDRINUSE') {
      console.error('该端口已被其他服务占用。请关闭占用者，或设置 PORT 后重新运行 npm run dev。');
    }
  });
  const stop = () => child.kill();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 0));
  });
}

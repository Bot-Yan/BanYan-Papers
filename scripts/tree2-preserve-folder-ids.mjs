import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { carryForwardFolderIds } from './tree2-folders.mjs';

try {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { new: { type: 'string', multiple: true, default: [] } },
  });
  if (positionals.length !== 3) {
    throw new Error('用法: node scripts/tree2-preserve-folder-ids.mjs <线上清单> <重扫清单> <输出文件> [--new <重建的目录路径>]');
  }
  const [livePath, scannedPath, outputPath] = positionals;
  const [live, scanned] = await Promise.all([livePath, scannedPath].map(async file => JSON.parse(await readFile(file, 'utf8'))));
  if (!Array.isArray(live?.batches) || !Array.isArray(scanned?.batches) ||
      (live.season && scanned.season && String(live.season) !== String(scanned.season))) {
    throw new Error('请提供同一届的两份资料清单');
  }
  const result = carryForwardFolderIds(live, scanned, values.new);
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
} catch (error) {
  console.error('合并目录标识失败:', error.message);
  process.exitCode = 1;
}

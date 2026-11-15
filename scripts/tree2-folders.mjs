import { createHash, randomUUID } from 'node:crypto';

export const isFolderId = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export function newFolder(name) {
  return { n: name, t: 'd', folderId: randomUUID(), c: [] };
}

function* folders(manifest) {
  for (const batch of manifest.batches || []) {
    if (!batch.tree) continue;
    const stack = [{ node: batch.tree, batch, segs: [batch.name], ancestors: [] }];
    while (stack.length) {
      const entry = stack.pop();
      yield entry;
      for (const child of entry.node.c || []) {
        if (child.t !== 'd') continue;
        stack.push({
          node: child, batch, segs: [...entry.segs, child.n],
          ancestors: [...entry.ancestors, entry.node],
        });
      }
    }
  }
}

export function assignFolderIds(manifest) {
  let changed = false;
  for (const { node } of folders(manifest)) {
    if (isFolderId(node.folderId)) continue;
    node.folderId = randomUUID();
    changed = true;
  }
  return changed;
}

export function folderIndex(manifest) {
  const current = new Map();
  const seen = new Set();
  for (const entry of folders(manifest)) {
    const id = entry.node.folderId;
    if (!isFolderId(id)) continue;
    if (seen.has(id)) current.delete(id);
    else current.set(id, entry);
    seen.add(id);
  }
  return current;
}

const pathKey = segs => segs.join('/');
// The public manifest does not need to expose a list of historical path names.
const aliasKey = segs => createHash('sha256').update(pathKey(segs.map(s => s.trim()))).digest('hex');

export function rememberFolderChanges(manifest, before) {
  const current = folderIndex(manifest);
  for (const [id, original] of before) {
    const updated = current.get(id);
    const oldPath = pathKey(original.segs);
    if (updated && pathKey(updated.segs) === oldPath) continue;

    // Bind a historical URL to its original folder even if the path is reused.
    const aliases = manifest.folderAliases ||= {};
    aliases[aliasKey(original.segs)] ??= id;
    if (!updated) {
      const parent = original.ancestors.findLast(node => current.has(node.folderId));
      (manifest.removedFolders ||= {})[id] = parent?.folderId ?? null;
    }
  }
}

export function historicalFolderId(manifest, segs) {
  const id = manifest.folderAliases?.[aliasKey(segs)];
  return isFolderId(id) ? id : null;
}

export function removedFolder(manifest, id, current) {
  const removed = manifest.removedFolders || {};
  if (!Object.hasOwn(removed, id)) return null;
  const visited = new Set([id]);
  let parentId = removed[id];
  while (isFolderId(parentId) && !visited.has(parentId)) {
    const parent = current.get(parentId);
    if (parent) return { parent };
    visited.add(parentId);
    parentId = removed[parentId];
  }
  return { parent: null };
}

// Run after replaying online changes into the scanner's source tree.
export function carryForwardFolderIds(live, scanned, newPaths = []) {
  const before = folderIndex(live);
  const idsByPath = new Map();
  for (const [id, { segs }] of before) {
    const key = pathKey(segs);
    if (idsByPath.has(key)) throw new Error(`线上清单有同名目录：${key}`);
    idsByPath.set(key, id);
  }
  const replacements = new Set(newPaths);
  const scannedPaths = new Set();
  for (const { node, segs } of folders(scanned)) {
    const key = pathKey(segs);
    if (scannedPaths.has(key)) throw new Error(`重扫清单有同名目录：${key}`);
    scannedPaths.add(key);
    const isNew = segs.some((_, index) => replacements.has(pathKey(segs.slice(0, index + 1))));
    node.folderId = (!isNew && idsByPath.get(key)) || randomUUID();
  }
  for (const key of replacements) {
    if (!scannedPaths.has(key)) throw new Error(`重扫清单没有 --new 指定的目录：${key}`);
  }
  scanned.folderAliases = { ...live.folderAliases };
  scanned.removedFolders = { ...live.removedFolders };
  rememberFolderChanges(scanned, before);
  return scanned;
}

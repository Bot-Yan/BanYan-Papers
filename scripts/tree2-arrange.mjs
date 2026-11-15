import { createHash } from 'node:crypto';

export class ArrangeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 255 &&
  value.trim().length > 0 && !['.', '..'].includes(value) && !/[\\/\x00-\x1f]/.test(value);
const validPath = value => Array.isArray(value) && value.length >= 1 && value.length <= 80 && value.every(validName);
const fold = name => name.normalize('NFC').toLowerCase();
const children = folder => folder.c || [];
const samePath = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const orderEntries = (a, b) => a.t === b.t ? a.n.localeCompare(b.n, 'zh-Hans-CN', { numeric: true }) : a.t === 'd' ? -1 : 1;

function directory(manifest, path) {
  let folder = (manifest.batches || []).find(batch => batch.name === path[0])?.tree;
  for (const name of path.slice(1)) folder = folder && children(folder).find(row => row.t === 'd' && row.n === name);
  if (!folder) throw new ArrangeError(404, '该目录已不存在，请刷新后重试');
  return folder;
}

function descendants(items) {
  const files = [];
  let folders = 0;
  const stack = [...items].reverse();
  while (stack.length) {
    const row = stack.pop();
    if (row.t === 'd') {
      folders++;
      const entries = children(row);
      for (let i = entries.length - 1; i >= 0; i--) stack.push(entries[i]);
    } else files.push(row);
  }
  return { files, folders };
}

export function planArrangement(manifest, input) {
  const { action, source, destination, name, kind } = input;
  if (!['mkdir', 'move', 'dissolve', 'flatten'].includes(action) || !validPath(source)) throw new ArrangeError(400, '目录操作或路径不合法');
  const revision = createHash('sha256').update(JSON.stringify([manifest, action, source, destination, name, kind])).digest('hex');
  let incoming, retained, removed, foldersRemoved = 0, output, origin;

  if (action === 'mkdir') {
    if (!validName(name) || name.trim() !== name || name.length > 120) throw new ArrangeError(400, '新文件夹名称不合法');
    output = directory(manifest, source);
    incoming = [{ n: name, t: 'd', c: [] }];
    retained = children(output);
  } else {
    if (source.length < 2) throw new ArrangeError(400, '批次根目录不能移动、解散或压平');
    origin = directory(manifest, source.slice(0, -1));
    const type = action === 'move' ? kind : 'd';
    if (type !== 'd' && type !== 'f') throw new ArrangeError(400, '资料类型不合法');
    removed = children(origin).find(row => row.t === type && row.n === source.at(-1));
    if (!removed) throw new ArrangeError(404, '该条目已不存在，请刷新后重试');
    if (action === 'move') {
      if (!validPath(destination) || destination[0] !== source[0]) throw new ArrangeError(400, '只能移动到同一批次内');
      if (samePath(destination, source.slice(0, -1)) || (type === 'd' && samePath(destination.slice(0, source.length), source))) {
        throw new ArrangeError(400, '请选择其他目录，文件夹不能移入自身或其子目录');
      }
      output = directory(manifest, destination);
      incoming = [removed];
      retained = children(output);
    } else if (action === 'dissolve') {
      output = origin;
      incoming = children(removed);
      retained = children(origin).filter(row => row !== removed);
      foldersRemoved = 1;
    } else {
      output = removed;
      retained = children(output).filter(row => row.t === 'f');
      const nested = descendants(children(output).filter(row => row.t === 'd'));
      incoming = nested.files;
      foldersRemoved = nested.folders;
    }
  }

  const occupied = new Set(retained.map(row => fold(row.n)));
  const conflicts = new Set();
  for (const row of incoming) {
    const key = fold(row.n);
    if (occupied.has(key)) conflicts.add(row.n);
    occupied.add(key);
  }
  const summary = {
    revision,
    movedEntries: action === 'mkdir' ? 0 : incoming.length,
    movedFiles: action === 'mkdir' ? 0 : descendants(incoming).files.length,
    foldersRemoved,
    conflicts: [...conflicts].slice(0, 12),
    conflictCount: conflicts.size,
  };
  return {
    summary,
    apply() {
      if (summary.conflictCount) throw new ArrangeError(409, '目标目录有同名条目，未移动任何资料');
      if (action === 'move') origin.c = children(origin).filter(row => row !== removed);
      output.c = [...retained, ...incoming].sort(orderEntries);
    },
  };
}

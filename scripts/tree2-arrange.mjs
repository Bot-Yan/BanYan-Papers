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

// 移动目标：批次必须已存在；目标批次内缺失的末级子目录自动创建（与上传补目录行为一致）
function moveTarget(manifest, destination, moved, fold) {
  let batch = (manifest.batches || []).find(item => item.name === destination[0]);
  if (!batch) throw new ArrangeError(404, '目标批次不存在，请刷新后重试或先创建批次');
  let folder = batch.tree;
  let created = 0;
  for (const name of destination.slice(1)) {
    let child = children(folder).find(row => row.t === 'd' && row.n === name);
    if (!child) {
      if (name !== destination.at(-1)) throw new ArrangeError(404, '目标目录已不存在，请刷新后重试');
      child = { n: name, t: 'd', c: [] };
      folder.c = [...children(folder), child];
      created = 1;
    }
    folder = child;
  }
  const occupied = new Set(children(folder).map(row => fold(row.n)));
  const key = fold(moved.n);
  return {
    batch,
    output: folder,
    retained: children(folder),
    conflicts: occupied.has(key) ? [moved.n] : [],
    conflictCount: occupied.has(key) ? 1 : 0,
    foldersCreated: created,
  };
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
  let incoming, retained, removed, foldersRemoved = 0, output, origin, sourceBatch, target, targetBatch;

  if (action === 'mkdir') {
    if (!validName(name) || name.trim() !== name || name.length > 120) throw new ArrangeError(400, '新文件夹名称不合法');
    output = directory(manifest, source);
    incoming = [{ n: name, t: 'd', c: [] }];
    retained = children(output);
  } else if (action === 'move' && source.length === 1) {
    // 整批并入：source 只有批次名时，把该批次的全部顶层条目搬进目标目录，然后移除原批次
    sourceBatch = (manifest.batches || []).find(batch => batch.name === source[0]);
    if (!sourceBatch) throw new ArrangeError(404, '该批次已不存在，请刷新后重试');
    if (!validPath(destination)) throw new ArrangeError(400, '目标目录不合法');
    if (kind !== 'd') throw new ArrangeError(400, '批次只能整体并入其他批次');
    if (destination[0] === source[0]) throw new ArrangeError(400, '请选择其他批次；整批并入不能移回自身');
    if (destination.length === 1) throw new ArrangeError(400, '请选择目标批次内的具体目录，或先在该批次里建一个目录');
    target = moveTarget(manifest, destination, { n: sourceBatch.name }, fold);
    targetBatch = target.batch;
    output = target.output;
    incoming = children(sourceBatch.tree);
    retained = target.retained;
    if (!incoming.length) throw new ArrangeError(400, '这个批次是空的，没有可并入的内容');
    // 整批并入要逐个检查同名冲突（moveTarget 只认单个条目）
    const mergeConflicts = [];
    const seen = new Set(retained.map(row => fold(row.n)));
    for (const row of incoming) {
      const key = fold(row.n);
      if (seen.has(key)) mergeConflicts.push(row.n);
      seen.add(key);
    }
    const summary = {
      revision,
      movedEntries: incoming.length,
      movedFiles: descendants(incoming).files.length,
      foldersRemoved: 1,
      crossBatch: true,
      foldersCreated: target.foldersCreated,
      conflicts: mergeConflicts.slice(0, 12),
      conflictCount: mergeConflicts.length,
    };
    return {
      summary,
      apply() {
        if (summary.conflictCount) throw new ArrangeError(409, '目标目录有同名条目，未移动任何资料');
        manifest.batches = (manifest.batches || []).filter(batch => batch !== sourceBatch);
        output.c = [...retained, ...incoming].sort(orderEntries);
      },
    };
  } else {
    if (source.length < 2) throw new ArrangeError(400, '批次根目录不能解散或压平');
    origin = directory(manifest, source.slice(0, -1));
    const type = action === 'move' ? kind : 'd';
    if (type !== 'd' && type !== 'f') throw new ArrangeError(400, '资料类型不合法');
    removed = children(origin).find(row => row.t === type && row.n === source.at(-1));
    if (!removed) throw new ArrangeError(404, '该条目已不存在，请刷新后重试');
    if (action === 'move') {
      if (!validPath(destination)) throw new ArrangeError(400, '目标目录不合法');
      if (samePath(destination, source.slice(0, -1)) || (type === 'd' && samePath(destination.slice(0, source.length), source))) {
        throw new ArrangeError(400, '请选择其他目录，文件夹不能移入自身或其子目录');
      }
      // 批次内移动沿用原语义（目标目录必须已存在）；跨批次时目标批次必须已存在，
      // 批次内缺失的末级目录自动创建（与上传补目录一致），不存在的批次不会被造出来。
      sourceBatch = (manifest.batches || []).find(batch => batch.name === source[0]);
      target = destination[0] === source[0]
        ? { batch: sourceBatch, output: directory(manifest, destination), retained: children(directory(manifest, destination)), conflicts: [], conflictCount: 0, foldersCreated: 0 }
        : moveTarget(manifest, destination, removed, fold);
      targetBatch = target.batch;
      output = target.output;
      incoming = [removed];
      retained = target.retained;
      if (target.conflictCount) {
        return {
          summary: { revision, movedEntries: 1, movedFiles: descendants([removed]).files.length, foldersRemoved, crossBatch: target.batch !== sourceBatch, foldersCreated: 0, conflicts: target.conflicts.slice(0, 12), conflictCount: target.conflictCount },
          apply() { throw new ArrangeError(409, '目标目录有同名条目，未移动任何资料'); },
        };
      }
      return {
        summary: {
          revision,
          movedEntries: 1,
          movedFiles: descendants([removed]).files.length,
          foldersRemoved,
          crossBatch: target.batch !== sourceBatch,
          foldersCreated: target.foldersCreated,
          conflicts: [],
          conflictCount: 0,
        },
        apply() {
          if (action === 'move') origin.c = children(origin).filter(row => row !== removed);
          output.c = [...retained, ...incoming].sort(orderEntries);
        },
      };
    }
    if (action === 'dissolve') {
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
    crossBatch: false,
    conflicts: [...conflicts].slice(0, 12),
    conflictCount: conflicts.size,
  };
  return {
    summary,
    apply() {
      if (summary.conflictCount) throw new ArrangeError(409, '目标目录有同名条目，未移动任何资料');
      output.c = [...retained, ...incoming].sort(orderEntries);
    },
  };
}

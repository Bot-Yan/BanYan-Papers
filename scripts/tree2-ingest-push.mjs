/**
 * tree2 入库推送 —— 把「服务器上新入库的文件」推给外部服务（treenext 通知端）。
 *
 * 职责边界：
 *   本模块只负责「排队 + 发送 + 重试」，不认识 manifest 结构，也不直接写它的数据。
 *   入库时由 tree2-files-server 调用 enqueue() 生成事件文件；
 *   后台定时调用 flush() 把事件 POST 出去，成功（202）才删除事件。
 *
 * 事件文件落在 <sharesDir>/update-outbox/<毫秒时间戳>-<uuid>.json，
 * 落盘后再异步发送，所以服务重启不会丢事件。
 *
 * 配置来源（优先级从高到低）：
 *   1. 环境变量 TREE2_UPDATE_TOKEN / TREE2_UPDATE_ORIGIN
 *   2. <sharesDir>/update-push.json 里的 { token, origin }
 *
 * origin 必须是纯 HTTPS 源站（不能带路径、查询、账号密码），
 * 接口固定为 <origin>/api/treenext/updates。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const EVENT_FILE_PATTERN = /^\d{13}-[a-f0-9-]{36}\.json$/;
const MAX_BATCH = 150;
const SEND_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 5000;

/**
 * 读配置。只在两者都没通过环境变量给出时才读文件。
 * @param {string} sharesDir
 * @returns {Promise<{token?: string, origin?: string}>}
 */
export async function readUpdateCredentials(sharesDir) {
  if (process.env.TREE2_UPDATE_TOKEN || process.env.TREE2_UPDATE_ORIGIN) {
    return { token: process.env.TREE2_UPDATE_TOKEN, origin: process.env.TREE2_UPDATE_ORIGIN };
  }
  try {
    return JSON.parse(await fsp.readFile(path.join(sharesDir, 'update-push.json'), 'utf8')) ?? {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[tree2] 无法读取入库推送配置', error.code || error.name);
    return {};
  }
}

/**
 * 校验并拼出推送地址。任何一项不满足就返回 null（等价于「不推送」）。
 * @param {{ privateRead?: boolean, token?: string }} cfg
 * @param {{ token?: string, origin?: string }} credentials
 * @returns {URL|null}
 */
export function resolveUpdateEndpoint(cfg, credentials) {
  const token = typeof credentials.token === 'string' ? credentials.token : '';
  if (cfg.privateRead || !cfg.token || !TOKEN_PATTERN.test(token)) return null;
  const configured = credentials.origin;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error();
    }
    return new URL('/api/treenext/updates', url);
  } catch {
    console.error('[tree2] TREE2_UPDATE_ORIGIN 需要是 HTTPS 源站');
    return null;
  }
}

/** 把一段文本裁成安全的单行标签（去掉控制字符和双向文本控制符）。 */
export function updateLabel(value, limit, fallback) {
  return value.slice(0, limit).toWellFormed()
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').trim() || fallback;
}

/**
 * 创建一个推送器。
 *
 * @param {object} options
 * @param {string} options.sharesDir        数据根目录，事件放在它的 update-outbox/ 下
 * @param {URL|null} options.endpoint       resolveUpdateEndpoint() 的结果；为 null 时全部操作是空转
 * @param {string} options.token            推送用的 Bearer token
 * @param {(fn: Function) => Promise<any>} options.writeLibrary
 *        串行化包装（读 manifest 时要用，避免和入库写入打架）
 * @param {(year: string) => Promise<any>} options.readManifest
 *        读某年的 manifest，用于发送前回查文件是否真的入库了
 */
export function createIngestPush({ sharesDir, endpoint, token, writeLibrary, readManifest }) {
  const directory = path.join(sharesDir, 'update-outbox');
  let sending = false;

  /** 这个推送器会不会真的发东西。 */
  const enabled = () => Boolean(endpoint);

  /**
   * 入库成功后调用：把一条待推送事件落盘。
   * 失败只会打日志，不影响入库本身——推送是可选的附属功能。
   *
   * @returns {Promise<string|undefined>} 事件文件路径；没启用或失败时返回 undefined
   */
  async function enqueue({ year, batchId, batch, name, origin, key, folder }) {
    if (!enabled() || !/^20\d{2}$/.test(String(year))) return undefined;
    const at = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const file = path.join(directory, `${Date.now()}-${eventId}.json`);
    try {
      await fsp.mkdir(directory, { recursive: true });
      await writeJsonAtomic(file, {
        event: {
          eventId,
          at,
          year,
          batchId,
          batch: updateLabel(batch, 200, '资料批次'),
          name: updateLabel(name, 300, '未命名文件'),
          origin: origin === 'admin' ? 'staff' : 'guest',
        },
        key,
        folder,
        name,
      });
      return file;
    } catch (error) {
      console.error('[tree2] 无法保存入库推送事件', error.code || error.name);
      return undefined;
    }
  }

  /**
   * 把事件真正发出去。可在入库事务失败时调用 cancel(file) 撤回刚排队的事件。
   */
  function cancel(file) {
    if (file) fsp.rm(file, { force: true }).catch(() => {});
  }

  /**
   * 扫描队列并投递。单实例串行，避免并发重复发送。
   * 每条事件发送成功（202）才删除；任何失败都留着，下个 tick 重试。
   */
  async function flush() {
    if (sending || !enabled()) return;
    sending = true;
    try {
      const files = await fsp.readdir(directory).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const pending = await writeLibrary(async () => {
        const events = [];
        const manifests = new Map();
        for (const filename of files.filter((name) => EVENT_FILE_PATTERN.test(name)).sort().slice(0, MAX_BATCH)) {
          const file = path.join(directory, filename);
          let queued;
          try {
            queued = JSON.parse(await fsp.readFile(file, 'utf8'));
          } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
          }
          const { event, key, folder, name } = queued;
          if (!manifests.has(event.year)) {
            manifests.set(event.year, await readManifest(event.year).catch((error) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            }));
          }
          const manifest = manifests.get(event.year);
          const batch = manifest?.batches?.find((item) => item.tree.folderId === event.batchId);
          // 重启可能留下「事件已暂存但 manifest 尚未替换」的残局；
          // 发出去之前回查一次，确认文件真的在 manifest 里，避免误报。
          const parent = folder.slice(1).reduce(
            (node, segment) => node?.c?.find((child) => child.t === 'd' && child.n === segment),
            batch?.tree,
          );
          if (parent?.c?.some((child) => child.t === 'f' && child.n === name && child.k === key)) {
            events.push({ file, event: { ...event, batch: updateLabel(batch.name, 200, '资料批次') } });
          } else {
            await fsp.rm(file, { force: true });
          }
        }
        return events;
      });

      for (const { file, event } of pending) {
        const response = await fetch(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        });
        await response.body?.cancel();
        if (response.status !== 202) throw new Error(`HTTP ${response.status}`);
        await fsp.rm(file, { force: true });
      }
    } catch (error) {
      console.error('[tree2] 入库推送暂不可用，待重试', error.message);
    } finally {
      sending = false;
    }
  }

  /** 启动后台轮询（立即跑一次，之后固定间隔）。返回停止函数。 */
  function start() {
    const timer = setInterval(() => void flush(), POLL_INTERVAL_MS).unref();
    void flush();
    return () => clearInterval(timer);
  }

  return { enabled, enqueue, cancel, flush, start };
}

/** 原子写 JSON：先写临时文件再 rename，避免读到半截内容。 */
async function writeJsonAtomic(file, value, indent = 2) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, indent));
  await fsp.rename(temp, file);
}

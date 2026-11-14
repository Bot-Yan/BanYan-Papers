// tree2/js/api.js —— 数据层：清单、存储状态、上传、取文件字节。
//
// 地址约定（两套后端都支持，页面只认 API_BASE）：
//   /api/public/tree2/...                —— 生产：Astro 静态站 + 服务端反向代理（server/tree2.mjs）
//   http://127.0.0.1:8787/api/tree2/...  —— 本地：node scripts/tree2-files-server.mjs（Flyfish / 本地调试）
// 页面在 URL 里带 ?api=… 即可切换（固定到 localStorage），见 apiBase()。

const LS_API = 'tree2.api';
const LS_PREF = 'tree2.pref';

/**
 * 允许外部传一个绝对地址（Flyfish 客户端、本地文件服务）；默认同源。
 *
 * 只负责"读 + 记忆"，**不动 URL**：地址栏由 app.js 的 writeUrl() 统一维护，
 * 一处管一件事，才不会出现两边互相抹掉的情况。
 * ?api= 只在明确给了 http(s) 地址时才写进记忆，空值不该覆盖已有配置。
 * ?api=reset 清掉记忆，回到同源。
 */
export function apiBase() {
  const q = new URLSearchParams(location.search).get('api');
  if (q !== null) {
    const clean = q.trim().replace(/\/+$/, '');
    try {
      if (clean === '' || clean === 'reset') localStorage.removeItem(LS_API);
      else if (/^https?:\/\//i.test(clean)) localStorage.setItem(LS_API, clean);
    } catch {
      /* 隐私模式 */
    }
  }
  let base = '';
  try {
    base = localStorage.getItem(LS_API) || '';
  } catch {
    /* 隐私模式 */
  }
  return base.replace(/\/+$/, '');
}

/** 当前数据服务地址，给报错信息用（空字符串表示同源）。 */
export function apiOriginLabel() {
  return apiBase() || location.origin;
}

export const pref = {
  get(key, fallback = null) {
    try {
      const all = JSON.parse(localStorage.getItem(LS_PREF) || '{}');
      return key in all ? all[key] : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      const all = JSON.parse(localStorage.getItem(LS_PREF) || '{}');
      all[key] = value;
      localStorage.setItem(LS_PREF, JSON.stringify(all));
    } catch {
      /* 隐私模式 */
    }
  },
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, signal, timeout = 15000 } = {}) {
  const headers = {};
  if (method !== 'GET') {
    headers['X-Tree2'] = '1'; // 服务端据此要求同源写请求，挡掉跨站表单
    if (!(body instanceof Blob) && body !== undefined) headers['Content-Type'] = 'application/json';
  }
  // 地址指错时请求会一直挂着，页面就永远停在"正在读取"。给个上限，宁可报错也别装死。
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      body: body instanceof Blob ? body : body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      // 不写 cookie：站点是静态的，写操作靠 X-Tree2 + 同源校验，避免第三方站点借 cookie 上传
      credentials: 'omit',
      cache: 'no-cache',
    });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    if (e.name === 'AbortError' || ctl.signal.aborted) throw new ApiError(0, `资料服务 ${apiOriginLabel()} 没有响应（${Math.round(timeout / 1000)} 秒超时）`);
    throw new ApiError(0, `连接不上资料服务 ${apiOriginLabel()}，请检查网络或稍后再试`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) throw new ApiError(res.status, (data && (data.error || data.message)) || `服务返回 ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- 清单

const seasonCache = new Map();

export async function listSeasons() {
  const data = await request('/api/tree2/seasons');
  return data.seasons || [];
}

export async function loadSeason(id) {
  if (seasonCache.has(id)) return seasonCache.get(id);
  const p = request(`/api/tree2/seasons/${encodeURIComponent(id)}`);
  seasonCache.set(id, p);
  return p;
}

/** 清掉缓存（上传完成后目录树计数会变）。 */
export function invalidate(id) {
  seasonCache.delete(id);
}

/** 存储状态：这个赛季有哪些文件已经有真实字节（可在线预览/下载）。 */
export async function storageState(season) {
  const data = await request(`/api/tree2/storage/${encodeURIComponent(season)}`).catch(() => null);
  const keys = new Set((data && data.keys) || []);
  return {
    keys,
    enabled: Boolean(data && data.enabled),
    source: data && data.source, // "local" | "github" | "none"
    count: keys.size,
    note: data && data.note,
  };
}

/** 文件地址：有字节时走 files 接口，返回一个可直接放进 <img>/<audio> 的 URL。 */
export function fileUrl(season, file, { download = false } = {}) {
  const qs = `k=${encodeURIComponent(file.k)}&n=${encodeURIComponent(file.n)}${download ? '&download=1' : ''}`;
  return `${apiBase()}/api/tree2/files/${encodeURIComponent(season)}?${qs}`;
}

/**
 * 拉一个在线文件的字节；一次给多条线路（镜像 / 本地站），按顺序试，太慢的换下一条。
 * 规则抄自 XMUHub 的 fetchPart：*  8 秒内不响应 → 下一条；* 跑满 6 秒后平均速度 < 150 KB/s → 下一条。
 */
export async function fetchBytes(candidates, { signal, onProgress } = {}) {
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    const hasNext = i < candidates.length - 1;
    const ctl = new AbortController();
    const link = () => (signal ? signal.addEventListener('abort', () => ctl.abort(), { once: true }) : null);
    link();
    let timer;
    const deadman = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(), ms);
    };
    try {
      deadman(hasNext ? 8000 : 30000);
      const res = await fetch(url, { signal: ctl.signal, mode: 'cors', credentials: 'omit', cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const total = Number(res.headers.get('content-length')) || 0;
      const chunks = [];
      let got = 0;
      const t0 = performance.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (onProgress) onProgress(got, total);
        deadman(30000);
        const secs = (performance.now() - t0) / 1000;
        if (hasNext && secs > 6 && got / secs < 150 * 1024) {
          ctl.abort();
          throw new Error('这条线路太慢');
        }
      }
      clearTimeout(timer);
      return new Blob(chunks);
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('没有可用的文件线路');
}

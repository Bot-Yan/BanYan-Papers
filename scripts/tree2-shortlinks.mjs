/**
 * 短链分享：把长存储键链接换成「短码 + 四位提取码」，像网盘一样发出去。
 *
 *   原链接  /s/a5/a536514b…9d8.pdf
 *   新链接  /s/7xk2          + 提取码 8341
 *
 * 设计取舍：
 * - 四位提取码只有 10000 种组合，单靠它挡不住枚举。所以短链本身用不可预测的
 *   随机短码（32 位字母表，约 10^14 量级），提取码只是第二道确认；同时按
 *   「短码 + 客户端」记录失败次数并限流，超过阈值就锁一段时间。
 * - 短码和提取码都用 timingSafeEqual 比较，避免时序侧信道。
 * - 注册表按短码存放，原子写盘；过期的短链读取时懒清理。
 */
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

// 去掉了容易看错的 0/O/1/l/I，方便口头或手抄
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const CODE_LENGTH = 4;
const PIN_LENGTH = 4;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 短链默认 30 天有效
const MAX_ATTEMPTS = 5;                     // 同一短码 + 客户端，窗口内最多试错 5 次
const WINDOW_MS = 10 * 60 * 1000;           // 失败计数窗口 10 分钟
const LOCK_MS = 10 * 60 * 1000;             // 触发后锁定 10 分钟
const MAX_LINKS = 5000;                     // 注册表上限，超出按最旧淘汰

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function randomCode(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createShortLinkStore({ sharesFile, log = () => {} }) {
  const file = sharesFile;
  let cache = { mtime: 0, list: [] };
  // 限流状态只在内存里：进程重启后清零，宁可放过也不永久误锁
  const attempts = new Map();

  const clientKey = (req) => {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req.socket?.remoteAddress || 'unknown';
  };

  async function load() {
    let st = null;
    try { st = await fsp.stat(file); } catch { /* 还没有注册表 */ }
    if (st && st.mtimeMs === cache.mtime) return cache.list;
    let list = [];
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* 文件不存在或损坏，按空表处理 */ }
    cache = { mtime: st ? st.mtimeMs : 0, list };
    return list;
  }

  async function save(list) {
    let keep = list;
    if (keep.length > MAX_LINKS) keep = keep.slice(keep.length - MAX_LINKS);
    const tmp = `${file}.${process.pid}.short.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(keep, null, 1));
    await fsp.rename(tmp, file);
    const st = await fsp.stat(file).catch(() => null);
    cache = { mtime: st ? st.mtimeMs : 0, list: keep };
  }

  const isExpired = (entry, now = Date.now()) => Boolean(entry.expiresAt) && entry.expiresAt <= now;

  /** 给存储键建一条短链；同一个 key 复用未过期的短码，避免每次点都生成新的。 */
  async function create({ key, name, season, ext, size }) {
    if (typeof key !== 'string' || !/^[0-9a-f]{2}\/[0-9a-f]{64}(?:\.[a-z0-9]{1,8})?$/i.test(key)) {
      throw Object.assign(new Error('存储键不合法'), { status: 400 });
    }
    const list = await load();
    const now = Date.now();
    const live = list.filter((entry) => !isExpired(entry, now));
    const existing = live.find((entry) => entry.key === key);
    if (existing) {
      if (live.length !== list.length) await save(live);
      return { code: existing.code, pin: existing.pin, expiresAt: existing.expiresAt, reused: true };
    }
    // 短码空间很大，但仍要防撞：生成到不与现存短码重复为止
    const taken = new Set(live.map((entry) => entry.code));
    let code = '';
    do { code = randomCode(CODE_LENGTH); } while (taken.has(code));
    const pin = randomCode(PIN_LENGTH).slice(0, PIN_LENGTH);
    const entry = {
      code, pin, key,
      name: String(name || '').slice(0, 200),
      season: String(season || '').slice(0, 4),
      ext: String(ext || '').toLowerCase().slice(0, 10),
      size: Number.isFinite(size) ? size : 0,
      createdAt: now,
      expiresAt: now + TTL_MS,
      visits: 0,
    };
    await save([...live, entry]);
    log(`[shortlink] 新建 ${code} → ${key}`);
    return { code, pin, expiresAt: entry.expiresAt, reused: false };
  }

  function throttle(client, code) {
    const id = `${client}:${code}`;
    const now = Date.now();
    const state = attempts.get(id);
    if (!state) return { blocked: false, state: null, id };
    if (state.lockedUntil && state.lockedUntil > now) return { blocked: true, retryAfter: state.lockedUntil - now, state, id };
    if (state.lockedUntil && state.lockedUntil <= now) {
      attempts.delete(id);
      return { blocked: false, state: null, id };
    }
    if (now - state.since > WINDOW_MS) {
      attempts.delete(id);
      return { blocked: false, state: null, id };
    }
    return { blocked: false, state, id };
  }

  function recordFailure(id, state) {
    const now = Date.now();
    const next = state && now - state.since <= WINDOW_MS
      ? { since: state.since, count: state.count + 1, lockedUntil: 0 }
      : { since: now, count: 1, lockedUntil: 0 };
    if (next.count >= MAX_ATTEMPTS) next.lockedUntil = now + LOCK_MS;
    attempts.set(id, next);
  }

  /** 校验提取码；返回 { ok } 或 { ok:false, reason:'notfound'|'expired'|'blocked'|'pin', retryAfter } */
  async function verify(code, pin, req) {
    const client = clientKey(req);
    const gate = throttle(client, code);
    if (gate.blocked) return { ok: false, reason: 'blocked', retryAfter: gate.retryAfter };
    const list = await load();
    const entry = list.find((item) => item.code === code);
    if (!entry) {
      if (!gate.state) recordFailure(gate.id, null);
      return { ok: false, reason: 'notfound' };
    }
    if (isExpired(entry)) return { ok: false, reason: 'expired' };
    if (!sameSecret(pin, entry.pin)) {
      recordFailure(gate.id, gate.state);
      return { ok: false, reason: 'pin', remaining: MAX_ATTEMPTS - Math.min(MAX_ATTEMPTS, (gate.state?.count || 0) + 1) };
    }
    attempts.delete(gate.id);
    // 命中计数与访问量异步写回，失败不影响访问
    const now = Date.now();
    mutate((rows) => rows.map((row) => (row.code === code ? { ...row, visits: (row.visits || 0) + 1, lastVisitAt: now } : row)))
      .catch((error) => log(`[shortlink] 计数写回失败：${error.message}`));
    return { ok: true, entry };
  }

  async function mutate(fn) {
    const list = await load();
    await save(fn(list));
  }

  /** 运维用：列出全部短链（不含 pin 的完整展示交给调用方决定）。 */
  async function list() {
    const rows = await load();
    const now = Date.now();
    return rows.map((entry) => ({ ...entry, expired: isExpired(entry, now) }));
  }

  /** 吊销一条短链。 */
  async function revoke(code) {
    const list = await load();
    const next = list.filter((entry) => entry.code !== code);
    if (next.length === list.length) return false;
    await save(next);
    log(`[shortlink] 吊销 ${code}`);
    return true;
  }

  /** 清理过期条目，返回清掉的数量。 */
  async function sweep() {
    const list = await load();
    const now = Date.now();
    const next = list.filter((entry) => !isExpired(entry, now));
    if (next.length === list.length) return 0;
    await save(next);
    return list.length - next.length;
  }

  return { create, verify, list, revoke, sweep, load, isExpired };
}

/** 短链落地页：要求输入提取码。 */
export function shareLockPage({ code, title = '请输入提取码', message = '', status = 200 }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 body{margin:0;padding:48px 18px;font:15px/1.7 "Microsoft YaHei","PingFang SC",sans-serif;color:#1e3a5f;background:#fffaf0;min-height:100vh;box-sizing:border-box}
 main{max-width:420px;margin:6vh auto 0}
 .card{background:#fff;border:1px solid #d9cdb5;border-radius:14px;padding:26px 24px 22px;box-shadow:0 8px 26px rgba(30,58,95,.08)}
 h1{font-size:19px;margin:0 0 6px}
 .meta{color:#685b47;font-size:13px;margin:0 0 18px}
 .note{color:#a12e36;font-size:13px;margin:0 0 14px;min-height:1.4em}
 form{display:flex;flex-direction:column;gap:12px}
 label{font-size:13px;color:#294733}
 input{box-sizing:border-box;width:100%;padding:11px 13px;border:1px solid #d9cdb5;border-radius:9px;background:#fffdf6;font-size:18px;letter-spacing:.5em;text-align:center;font-family:inherit}
 button{padding:11px 16px;border:0;border-radius:9px;background:#1e3a5f;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
 .hint{color:#685b47;font-size:12.5px;margin:12px 0 0}
</style></head><body><main><div class="card">
<h1>${esc(title)}</h1>
<p class="meta">分享码 <strong>${esc(code)}</strong></p>
<p class="note" role="status">${esc(message)}</p>
<form method="get" action="/s/${esc(code)}">
  <label for="pin">提取码</label>
  <input id="pin" name="pin" inputmode="numeric" maxlength="4" autocomplete="one-time-code" required pattern="[0-9a-zA-Z]{4}" autofocus />
  <button type="submit">打开分享</button>
</form>
<p class="hint">四位提取码由分享者提供。连续输错会临时锁定。</p>
</div></main></body></html>`;
}

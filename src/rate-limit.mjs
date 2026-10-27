/**
 * 配额（限流）计算与预占。
 *
 * 背景：bridge.js 里「查额度 → 预占 → 失败回滚」这段逻辑原来手写了 9 份，语义已经开始漂：
 *   · 小时窗口有的按 3600000 过滤，有的直接用数组长度（数组上限 500 ⇒ 实际上从不触发）；
 *   · 回滚有的删尾巴、有的 `indexOf(now)` 逐条删、有的干脆不删；
 *   · 引用解析失败那条路径给 `sendTimes` 留了「预占了但没发」的名额，之后几十分钟都在白白限流。
 * 这里统一成四个纯函数，调用方只负责把数组传进来、把返回的数组存回去。
 *
 * 约定：`maxPerMinute` / `maxPerHour` <= 0 表示该维度不限。
 */

/** 预占上限（超过就丢最老的），与旧代码的 slice(-500) 保持一致。 */
export const QUOTA_CAP = 500;

export const QUOTA_WINDOW_MS = { minute: 60000, hour: 3600000 };

/**
 * 数窗口内的条数，同时给出窗口内最早的一条（算 retryAfter 用）。
 * @param {unknown} times 时间戳数组（脏值会被忽略）
 * @param {number} now
 */
export function countQuota(times, now = Date.now()) {
  const arr = Array.isArray(times) ? times : [];
  let minute = 0;
  let hour = 0;
  let oldestMinute = 0;
  let oldestHour = 0;
  for (const raw of arr) {
    const t = Number(raw);
    if (!Number.isFinite(t)) continue;
    const age = now - t;
    if (age >= QUOTA_WINDOW_MS.hour || age < 0) continue;
    hour += 1;
    if (!oldestHour || t < oldestHour) oldestHour = t;
    if (age < QUOTA_WINDOW_MS.minute) {
      minute += 1;
      if (!oldestMinute || t < oldestMinute) oldestMinute = t;
    }
  }
  return { minute, hour, oldestMinute, oldestHour };
}

/**
 * 判断还能不能占 `need` 条额度。
 * 返回的 `retryAfterMs` = 等到最早那条滑出窗口还要多久（最少 0）。
 */
export function checkQuota(times, { now = Date.now(), need = 1, maxPerMinute = 0, maxPerHour = 0 } = {}) {
  const want = Math.max(1, Math.round(Number(need) || 1));
  const { minute, hour, oldestMinute, oldestHour } = countQuota(times, now);
  const minuteBlocked = maxPerMinute > 0 && minute + want > maxPerMinute;
  const hourBlocked = maxPerHour > 0 && hour + want > maxPerHour;
  let retryAfterMs = 0;
  if (minuteBlocked && oldestMinute) retryAfterMs = Math.max(retryAfterMs, QUOTA_WINDOW_MS.minute - (now - oldestMinute));
  if (hourBlocked && oldestHour) retryAfterMs = Math.max(retryAfterMs, QUOTA_WINDOW_MS.hour - (now - oldestHour));
  return { ok: !minuteBlocked && !hourBlocked, minute, hour, minuteBlocked, hourBlocked, retryAfterMs: Math.max(0, retryAfterMs) };
}

/**
 * 预占 `need` 条额度（返回**新数组**，调用方要存回去）。
 * 预占地放在真正发送之前，是为了让并发的两次调用不会一起挤过限频。
 */
export function reserveQuota(times, need = 1, now = Date.now(), cap = QUOTA_CAP) {
  const arr = Array.isArray(times) ? times.slice() : [];
  const want = Math.max(1, Math.round(Number(need) || 1));
  for (let i = 0; i < want; i += 1) arr.push(now);
  const limit = Math.max(1, Number(cap) || QUOTA_CAP);
  return arr.length > limit ? arr.slice(-limit) : arr;
}

/** 回滚最近一次预占（删尾巴，原地修改并返回同一个数组）。 */
export function rollbackQuota(times, need = 1) {
  if (!Array.isArray(times)) return times;
  const want = Math.max(1, Math.round(Number(need) || 1));
  times.splice(Math.max(0, times.length - want), want);
  return times;
}
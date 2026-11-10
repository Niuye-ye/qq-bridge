// 统一的「错误 → 一句人话」工具（叶子层，无依赖）。
//
// 背景（2026-11-10）：控制台路由的 catch 原来写 `error?.message ?? String(error)`，
// 若抛出来的是普通对象（很多库/校验器会 throw {}、{code,message}、{status,...}），
// `String(obj)` 就是「[object Object]」——日志里没信息，MCP 侧再 `new Error(...)`
// 包一层，她在 QQ 里就只看到「Error: [object Object]」（tool-calls.jsonl 里有过实例）。
//
// 规则：能给出可读信息就给出，别把对象丢给 String()。
//   1) Error / 带 message 的对象 → message
//   2) 字符串原样、数字/布尔转字符串
//   3) 其它对象 → JSON（截断 400 字，避免把整包 body 灌进日志）
//   4) JSON 化失败（循环引用）或空对象 → 兜底文案，绝不返回「[object Object]」
export function errorText(value, fallback = '未知错误') {
  if (value == null) return fallback;
  if (typeof value === 'string') return value || fallback;
  if (typeof value.message === 'string' && value.message) return value.message;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value);
    if (json && json !== '{}' && json !== 'null') return json.length > 400 ? json.slice(0, 400) + '…' : json;
  } catch { /* 循环引用：走兜底 */ }
  const s = String(value);
  return s === '[object Object]' ? `${fallback}（对象无 message）` : s;
}

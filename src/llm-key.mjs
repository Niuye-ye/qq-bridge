// LLM API Key 的自助写入：把主人 / 控制台给出的 key 写进 DSH 的凭据文件。
//
// 为什么需要它（2026-11-07）：QQ 链路（dsh web / web profile）的 llm-pi-ai 配置里
// provider opencodego 读的是 OPENCODEGO_API_KEY，而 .credentials.yaml 里当年只存了
// OPENCODE_GO_API_KEY（多了个下划线）。key 一换，两条链路就报 MISSING_CREDENTIAL，
// 只能人工改文件。现在通过 HTTP 接口 / MCP 工具 / 控制台页面自助录入。
//
// 契约：
//   1. 只改凭据文件 refs 段里指定的键，其余字节（注释、顺序、records 段）原样保留；
//   2. 原子写（同目录 .tmp + rename），保留原文件权限；文件不存在时按最小合法结构新建；
//   3. 任何日志、响应都**不回显 key**，只给前缀与长度；
//   4. 不做网络副作用，验证 key 是否可用是调用方的事（verifyLlmKey 单独导出）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** web profile（QQ 链路）与 desktop profile 用的两个键名，一起写，换 key 时不会只顾一头。 */
export const LLM_KEY_NAMES = ['OPENCODEGO_API_KEY', 'OPENCODE_GO_API_KEY'];

/** 凭据文件默认位置：~/.dsh/.credentials.yaml（credentials-local 的默认 path）。 */
export function defaultCredentialsPath() {
  return path.join(os.homedir(), '.dsh', '.credentials.yaml');
}

/** key 里只允许这些字符；YAML 裸标量安全，也挡住换行/引号注入。 */
export function normalizeLlmKey(raw) {
  const key = String(raw ?? '').trim();
  if (!key) return { ok: false, error: 'key 不能为空' };
  if (key.length < 16 || key.length > 200) return { ok: false, error: 'key 长度应在 16~200 之间' };
  if (!/^[A-Za-z0-9_.\-]+$/.test(key)) return { ok: false, error: 'key 含非法字符（只允许字母数字 _ . -）' };
  return { ok: true, key };
}

/** 只用于日志/响应的安全摘要。 */
export function maskLlmKey(key) {
  const s = String(key ?? '');
  if (!s) return '(空)';
  return s.length <= 8 ? '***' : s.slice(0, 6) + '…' + s.slice(-3) + '(' + s.length + ')';
}

/**
 * 行级 upsert：只在顶层 refs 段里改目标键，别的一行都不动。
 * @param {string} text 原文件内容
 * @param {{name:string,value:string}[]} entries
 * @returns {{text:string, updated:string[], added:string[]}}
 */
export function upsertCredentialRefs(text, entries) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const eolOf = (line) => (line.endsWith('\r') ? '\r' : '');
  let refsStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^refs:\s*$/.test(lines[i].replace(/\r$/, ''))) { refsStart = i; break; }
  }
  if (refsStart < 0) {
    // 没有 refs 段：不猜结构，直接报错让上层决定（避免把别人的文件写坏）。
    throw new Error('凭据文件缺少顶层 refs: 段，拒绝修改');
  }
  let refsEnd = lines.length;
  for (let i = refsStart + 1; i < lines.length; i++) {
    const bare = lines[i].replace(/\r$/, '');
    if (bare === '' || /^\s/.test(bare) || /^#/.test(bare)) continue;
    refsEnd = i;
    break;
  }
  const updated = [];
  const added = [];
  const pending = [];
  for (const entry of entries) {
    const name = String(entry?.name ?? '').trim();
    const value = String(entry?.value ?? '').trim();
    if (!name || !value) continue;
    const escapedName = name.replace(/[.*+?^$()|[\]{}]/g, '\\$&');
    const nameRe = new RegExp('^(\\s+)' + escapedName + ':');
    let hit = -1;
    for (let i = refsStart + 1; i < refsEnd; i++) {
      if (nameRe.test(lines[i])) { hit = i; break; }
    }
    if (hit >= 0) {
      const indent = lines[hit].match(/^\s*/)?.[0] ?? '  ';
      lines[hit] = indent + name + ': ' + value + eolOf(lines[hit]);
      updated.push(name);
    } else {
      pending.push('  ' + name + ': ' + value);
      added.push(name);
    }
  }
  if (pending.length) {
    let insertAt = refsStart + 1;
    for (let i = refsEnd - 1; i > refsStart; i--) {
      const bare = lines[i].replace(/\r$/, '');
      if (bare.trim() !== '') { insertAt = i + 1; break; }
    }
    lines.splice(insertAt, 0, ...pending);
  }
  return { text: lines.join('\n'), updated, added };
}

/**
 * 读 -> upsert -> 原子写。文件不存在时新建最小结构。
 * @returns {{path:string, existed:boolean, keys:string[], updated:string[], added:string[]}}
 */
export function writeLlmKey(credentialsPath, key, names = LLM_KEY_NAMES) {
  const target = path.resolve(String(credentialsPath || defaultCredentialsPath()));
  if (path.basename(target).toLowerCase() !== '.credentials.yaml') {
    throw new Error('拒绝写入：目标文件名必须是 .credentials.yaml');
  }
  let text;
  let existed = true;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    existed = false;
    text = 'version: 1\nrefs:\nrecords: {}\n';
  }
  const entries = names.map((name) => ({ name, value: key }));
  const result = upsertCredentialRefs(text, entries);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.credentials.yaml.' + process.pid + '-' + Date.now() + '.tmp');
  let mode = null;
  try { mode = fs.statSync(target).mode & 0o777; } catch {}
  fs.writeFileSync(tmp, result.text, { encoding: 'utf8', mode: mode ?? 0o600 });
  if (mode != null) { try { fs.chmodSync(tmp, mode); } catch {} }
  fs.renameSync(tmp, target);
  return { path: target, existed, keys: names.slice(), updated: result.updated, added: result.added };
}

/**
 * 用 opencode 的 OpenAI 兼容端点探一下 key 是否可用。
 * 200=可用，401/403=key 无效，其它/网络错误=未知（verdict='unknown'）。
 */
export async function verifyLlmKey(key, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const baseURL = options.baseURL ?? 'https://opencode.ai/zen/go/v1';
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, verdict: 'unknown', error: 'no fetch' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(baseURL.replace(/\/$/, '') + '/models', {
      method: 'GET',
      headers: { authorization: 'Bearer ' + key },
      signal: ctrl.signal
    });
    const verdict = res.status === 200 ? 'valid' : (res.status === 401 || res.status === 403 ? 'invalid' : 'unknown');
    return { ok: res.status === 200, status: res.status, verdict };
  } catch (err) {
    return { ok: false, status: 0, verdict: 'unknown', error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

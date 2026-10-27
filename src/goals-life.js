// 想干的事（goals）+ 生活时间线（life）—— 小鲸鱼「主观能动性」的数据层。
//
// 从 src/bridge.js 里抽出来的第一块（2026-10-24）：纯文件读写 + 文本格式化，
// 不碰会话状态机，抽出来零风险，也给后面继续拆分立个样板。
//
//   goals.json  { goals: [{id, text, status:'open'|'done'|'dropped', want, createdAt, closedAt?}], updatedAt }
//   life.json   { timeline: [{t:'HH:MM', text, at:ISO}], updatedAt }
//
// 注入 prompt 的两段：【你自己想干的事】（open 按 want 降序取 5 条）、【今天早些时候】（当天最近 6 条）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');   // src/ 的上一级 = 仓库根

const GOALS_PATH = path.join(ROOT, 'state', 'goals.json');
const LIFE_PATH = path.join(ROOT, 'state', 'life.json');
const GOALS_MAX = 40;
const LIFE_KEEP = 60;

// 文件解析失败后置位：只读标记，写路径一律拒绝覆盖
const BROKEN = new Set();
let tmpSeq = 0;

function logBroken(p, err) {
  if (BROKEN.has(p)) return;
  BROKEN.add(p);
  console.error('[goals-life] ' + p + ' 解析失败，已切成只读、拒绝覆盖：' + (err?.message ?? err));
}

function readJsonFile(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    if (!txt.trim()) return fallback;          // 空文件（从没写过）不算损坏
    const o = JSON.parse(txt);
    if (!o || typeof o !== 'object') throw new Error('顶层不是对象');
    BROKEN.delete(p);                           // 修好了就恢复可写
    return o;
  } catch (e) {
    logBroken(p, e);
    return fallback;
  }
}

/** 唯一临时名 + rename 重试：Windows 上覆盖一个正被打开的目标会抛 EPERM/EBUSY */
function writeJsonFile(p, o) {
  if (BROKEN.has(p)) throw new Error(p + ' 之前解析失败，已切成只读：先备份修好它再写，避免整份覆盖');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp-' + process.pid + '-' + (++tmpSeq);
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + '\n', 'utf8');
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(tmp, p); return; } catch (e) {
      lastErr = e;
      if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) {
        try { fs.copyFileSync(tmp, p); fs.unlinkSync(tmp); return; } catch (_) { /* 继续重试 */ }
        const until = Date.now() + 20 * (i + 1);
        while (Date.now() < until) { /* 小睡，别引 async */ }
      } else break;
    }
  }
  try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch (_) {}
  throw lastErr || new Error('写入 ' + p + ' 失败');
}

export function readGoalsV2() {
  const o = readJsonFile(GOALS_PATH, { goals: [] });
  return Array.isArray(o.goals) ? o.goals : [];
}

export function writeGoalsV2(list) {
  writeJsonFile(GOALS_PATH, { goals: list.slice(-GOALS_MAX), updatedAt: new Date().toISOString() });
  return list;
}

export function addGoalV2(text, opts = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!t) return null;
  const list = readGoalsV2();
  const dup = list.find((g) => g.status === 'open' && g.text === t);
  if (dup) return dup;
  const wantRaw = Number(opts.want);
  const g = {
    id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    text: t,
    status: 'open',
    want: Number.isFinite(wantRaw) && wantRaw >= 0 && wantRaw <= 1 ? wantRaw : 0.5,
    createdAt: new Date().toISOString(),
  };
  list.push(g);
  writeGoalsV2(list);
  return g;
}

export function closeGoalV2(idOrText, status) {
  const needle = String(idOrText ?? '').trim();
  if (!needle) return 0;
  const list = readGoalsV2();
  const now = new Date().toISOString();
  let n = 0;
  for (const g of list) {
    if (g.status !== 'open') continue;
    if (g.id === needle || String(g.text).includes(needle)) {
      g.status = status;
      g.closedAt = now;
      n += 1;
    }
  }
  if (n) writeGoalsV2(list);
  return n;
}

export function formatGoalsLineV2() {
  const open = readGoalsV2()
    .filter((g) => g.status === 'open')
    .sort((a, b) => (Number(b.want) || 0) - (Number(a.want) || 0))
    .slice(0, 5);
  if (!open.length) return '';
  return `【你自己想干的事】\n${open.map((g) => `- ${g.text}`).join('\n')}\n（这些是你自己记下的，不是别人派的。干完用 qq_done_goal 划掉，不想干了用 qq_drop_goal；也可以随时 qq_add_goal 加新的。）\n\n`;
}

export function readLifeV2() {
  const o = readJsonFile(LIFE_PATH, { timeline: [] });
  return Array.isArray(o.timeline) ? o.timeline : [];
}

export function appendLifeV2(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const list = readLifeV2();
  const entry = { t: `${pad(d.getHours())}:${pad(d.getMinutes())}`, text: raw.slice(0, 120), at: d.toISOString() };
  list.push(entry);
  writeJsonFile(LIFE_PATH, { timeline: list.slice(-LIFE_KEEP), updatedAt: d.toISOString() });
  return entry;
}

/** ISO 时间戳 → 本地日期 YYYY-MM-DD（'' 表示解析不了） */
function localDay(iso) {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatLifeLineV2() {
  const today = localDay(new Date().toISOString());
  const items = readLifeV2().filter((x) => localDay(x.at) === today).slice(-6);
  if (!items.length) return '';
  return `【今天早些时候】\n${items.map((x) => `${x.t} ${x.text}`).join('\n')}\n\n`;
}

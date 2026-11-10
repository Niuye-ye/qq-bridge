// hub 快照：把「她现在的样子」聚成一份 JSON。
//
// 为什么单独一个模块：这台机器上已经有 5 个地方在拼她的状态（桥的 /api/socialV2/self、
// 手机 ctl 的 probe、桌宠的轮询、桥控制台、人格卡注入），口径各不相同。统一 App 只认这一份。
//
// 契约：
//   collectSnapshot({ root, ports, probePort, bridgeStatus, now }) -> Promise<snapshot>
//   - 只读：不写任何文件、不启停进程；
//   - 任何一个数据源坏了（文件缺失、JSON 坏、桥没应答）都只让对应字段变成 null / 空数组，
//     绝不整份抛错 —— 面板要在「半死」状态下也能显示原因；
//   - ports / probePort / bridgeStatus 全部注入，测试里可以完全离线跑。

import fs from 'node:fs';
import path from 'node:path';

export const MOOD_LABELS = {
  happy: '开心',
  calm: '平静',
  low: '低落',
  sad: '难过',
  excited: '兴奋',
  tired: '累',
};

export const HUB_PORTS = [
  { key: 'napcat', name: 'QQ 通道', port: 6099, note: 'WebUI' },
  { key: 'onebot', name: 'OneBot', port: 3000, note: 'HTTP 3000 / WS 3001' },
  { key: 'onebotWs', name: 'OneBot WS', port: 3001, note: '' },
  { key: 'dsh', name: 'dsh 引擎', port: 3080, note: '推理与工具' },
  { key: 'bridge', name: '桥', port: 3100, note: '控制台' },
  { key: 'cap', name: '能力层', port: 8791, note: '手机操控' },
];

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    if (!txt.trim()) return fallback;
    const o = JSON.parse(txt);
    return o && typeof o === 'object' ? o : fallback;
  } catch {
    return fallback;
  }
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function moodView(raw) {
  const o = raw && typeof raw === 'object' ? raw : null;
  if (!o) return null;
  const key = String(o.mood || '').trim();
  const affinity = num(o.affinity, NaN);
  return {
    key,
    label: MOOD_LABELS[key] || (key || '说不清'),
    affinity: Number.isFinite(affinity) ? affinity : null,
    percent: Number.isFinite(affinity) ? Math.round(affinity * 10) : null,
    note: String(o.note || ''),
    lastTalkAt: o.lastTalkAt || null,
    lastDiaryAt: o.lastDiaryAt || null,
  };
}

export function factsView(raw) {
  const list = Array.isArray(raw?.facts) ? raw.facts : [];
  let longN = 0;
  let normalN = 0;
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    if (String(f.tier || 'normal') === 'long') longN++;
    else normalN++;
  }
  return { total: list.length, long: longN, normal: normalN };
}

export function diaryView(dir, now = Date.now()) {
  const out = { days: 0, totalChars: 0, todayChars: 0, lastDate: null };
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.md$/i.test(n));
  } catch {
    return out;
  }
  out.days = names.length;
  const today = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const todayName = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate()) + '.md';
  let last = null;
  for (const n of names) {
    let chars = 0;
    try {
      chars = fs.readFileSync(path.join(dir, n), 'utf8').replace(/^\uFEFF/, '').trim().length;
    } catch {
      chars = 0;
    }
    out.totalChars += chars;
    if (n === todayName) out.todayChars = chars;
    if (!last || n > last) last = n;
  }
  out.lastDate = last ? last.replace(/\.md$/i, '') : null;
  return out;
}

export function goalsView(raw, limit = 6) {
  const list = Array.isArray(raw?.goals) ? raw.goals : [];
  return list
    .filter((g) => g && typeof g === 'object' && String(g.status || 'open') === 'open')
    .sort((a, b) => num(b.want) - num(a.want))
    .slice(0, limit)
    .map((g) => ({ id: g.id || null, text: String(g.text || ''), want: num(g.want) }));
}

export function lifeView(raw, limit = 4) {
  const list = Array.isArray(raw?.timeline) ? raw.timeline : [];
  return list.slice(-limit).map((e) => ({ t: String(e?.t || ''), text: String(e?.text || '') }));
}

export function activityView(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    doing: String(o.doing || ''),
    note: String(o.note || ''),
    plan: String(o.plan || ''),
    doingSince: o.doingSince || null,
    updatedAt: o.updatedAt || null,
  };
}

function pickBridge(b) {
  if (!b || typeof b !== 'object') return null;
  const snow = b.snowluma && typeof b.snowluma === 'object' ? b.snowluma : {};
  return {
    mode: b.mode || null,
    dshReady: b.dshReady === true,
    paused: b.socialV2Paused === true,
    ownerQQ: b.ownerQQ || null,
    snow: {
      connected: snow.connected === true,
      accountOnline: snow.accountOnline === true,
      lastPacketAgoMs: num(snow.lastPacketAgoMs, null),
    },
  };
}

/** 主入口。所有外部依赖都注入，便于离线测试。 */
export async function collectSnapshot({ root, ports = HUB_PORTS, probePort, bridgeStatus, now = Date.now() } = {}) {
  const stateDir = path.join(root, 'state');
  const diaryDir = path.join(root, 'diary');
  const services = [];
  for (const p of ports) {
    let up = false;
    try {
      up = !!(await probePort(p.port));
    } catch {
      up = false;
    }
    services.push({ key: p.key, name: p.name, port: p.port, note: p.note || '', up });
  }
  let bridge = null;
  try {
    bridge = pickBridge(await bridgeStatus());
  } catch {
    bridge = null;
  }
  const activity = activityView(readJson(path.join(stateDir, 'activity.json'), {}));
  const moodRaw = readJson(path.join(stateDir, 'mood.json'), null);
  const mood = moodRaw ? moodView(moodRaw) : null;
  const facts = factsView(readJson(path.join(stateDir, 'facts.json'), {}));
  const diary = diaryView(diaryDir, now);
  const goals = goalsView(readJson(path.join(stateDir, 'goals.json'), {}));
  const life = lifeView(readJson(path.join(stateDir, 'life.json'), {}));
  return {
    ok: true,
    at: new Date(now).toISOString(),
    host: { platform: process.platform, node: process.version, pid: process.pid },
    services,
    upCount: services.filter((s) => s.up).length,
    total: services.length,
    bridge,
    her: { activity, mood, facts, diary, goals, life },
  };
}

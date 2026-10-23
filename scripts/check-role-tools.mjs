#!/usr/bin/env node
// 校验人格卡 / 动作表里提到的工具，是不是真的存在（以 MCP server 实际注册的为准）。
//
// 为什么要有这个：人格卡是手写的，工具是代码里注册的，两边会漂移。
// 一旦卡里写了个不存在的工具名，模型照着卡去调 → 404 / 工具不存在，人设当场露馅。
// 这里把「真实的 tools/list」当唯一事实来源，卡和 actions.json 都要对得上。
//
// 用法：
//   node scripts/check-role-tools.mjs           # 检查，有问题 exit 1
//   node scripts/check-role-tools.mjs --quiet   # 只报问题
//   node scripts/check-role-tools.mjs --json    # 机器可读
//
// 注意：不要把它塞进 QQ 链路的热路径（要起一次子进程、约 1~2 秒）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ROLES_DIR = path.join(ROOT, 'roles');
const ACTIONS_PATH = path.join(ROLES_DIR, 'actions.json');

const argv = new Set(process.argv.slice(2));
const QUIET = argv.has('--quiet');
const AS_JSON = argv.has('--json');

// 卡里可能出现的工具名：qq_xxx、mcp__server__tool
const TOOL_RE = /\b(qq_[a-z0-9_]+|mcp__[a-z0-9-]+__[a-z0-9_]+)\b/g;
// 这些是「说法」不是工具，别误报
const IGNORE = new Set([]);

function listRoles() {
  if (!fs.existsSync(ROLES_DIR)) return [];
  return fs
    .readdirSync(ROLES_DIR)
    .filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => path.join(ROLES_DIR, f));
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function loadActions() {
  const raw = readText(ACTIONS_PATH);
  if (!raw.trim()) return { actions: {}, error: null };
  try {
    const parsed = JSON.parse(raw);
    const actions = parsed && typeof parsed.actions === 'object' ? parsed.actions : parsed;
    return { actions: actions && typeof actions === 'object' ? actions : {}, error: null };
  } catch (err) {
    return { actions: {}, error: `actions.json 不是合法 JSON：${err.message}` };
  }
}

function fetchTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let buf = '';
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {}
      fn(arg);
    };
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('{')) continue;
        let msg;
        try {
          msg = JSON.parse(s);
        } catch {
          continue;
        }
        if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
          finish(resolve, msg.result.tools);
          return;
        }
        if (msg.id === 2 && msg.error) finish(reject, new Error(msg.error.message ?? 'tools/list 失败'));
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', (err) => finish(reject, err));
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check-role-tools', version: '1' } },
    });
    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    }, 300);
    setTimeout(() => finish(reject, new Error('MCP server 8 秒内没有返回 tools/list')), 8000);
  });
}

async function main() {
  let tools;
  try {
    tools = await fetchTools();
  } catch (err) {
    console.error(`✗ 拿不到工具清单：${err.message}`);
    process.exit(2);
  }

  const byName = new Map(tools.map((t) => [t.name, t]));
  const problems = [];
  const roleReports = [];

  for (const file of listRoles()) {
    const name = path.basename(file);
    const text = readText(file);
    const mentioned = [...new Set([...text.matchAll(TOOL_RE)].map((m) => m[1]))].filter((n) => !IGNORE.has(n));
    const missing = mentioned.filter((n) => !byName.has(n));
    roleReports.push({ role: name, mentioned: mentioned.length, missing });
    for (const m of missing) problems.push(`${name} 里提到的 ${m} 不在工具列表里`);
  }

  const { actions, error: actionsError } = loadActions();
  if (actionsError) problems.push(actionsError);
  const actionReports = [];
  for (const [label, spec] of Object.entries(actions)) {
    const toolName = typeof spec === 'string' ? spec : spec?.tool;
    const required = (typeof spec === 'object' && Array.isArray(spec?.required) ? spec.required : []).map(String);
    if (!toolName) {
      problems.push(`actions.json 的「${label}」没写 tool`);
      continue;
    }
    const def = byName.get(toolName);
    if (!def) {
      problems.push(`actions.json 的「${label}」指向不存在的工具 ${toolName}`);
      actionReports.push({ label, tool: toolName, ok: false });
      continue;
    }
    const props = def.inputSchema?.properties ?? {};
    const missingParams = required.filter((p) => !(p in props));
    if (missingParams.length) problems.push(`actions.json 的「${label}」→ ${toolName} 缺参数 ${missingParams.join(', ')}（该工具有：${Object.keys(props).join(', ') || '无'}）`);
    actionReports.push({ label, tool: toolName, ok: missingParams.length === 0, missingParams });
  }

  const result = {
    ok: problems.length === 0,
    toolCount: tools.length,
    roles: roleReports,
    actions: actionReports,
    problems,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
  } else if (problems.length) {
    console.log(`✗ 人格卡/动作表与真实工具对不上（工具 ${tools.length} 个）`);
    for (const p of problems) console.log(`  - ${p}`);
  } else if (!QUIET) {
    const mentions = roleReports.map((r) => `${r.role}:${r.mentioned}`).join(' ');
    console.log(`✓ 对得上（工具 ${tools.length} 个；卡里提到的：${mentions || '无'}；动作表 ${actionReports.length} 条）`);
  }

  process.exit(problems.length ? 1 : 0);
}

main();

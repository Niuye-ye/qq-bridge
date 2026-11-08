// 安全 spawn / 日志：从 mcp-snowluma-safe.js 抽出，供入口与各工具族模块共用。
//
// 背景（2026-10-27）：原先入口文件里 4 处 spawn 都没有 'error' 监听，pickPython() 找不到
// 解释器时兜底返回裸 'python'，ENOENT 变成未处理事件 → 整个 MCP 进程退出、DSH 侧所有 QQ
// 工具同时消失（日志里一个字都没有）。现在所有子进程一律走 spawnSafe，只记日志、不退出。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MC_LOG = path.join(ROOT, 'state', 'mcp.log');

export function mcLog(line) {
  try {
    fs.appendFileSync(MC_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

// 注意：这里必须是 child_process 的 spawn —— 2026-10-27 的首轮审计修复把整个文件里的
// spawn 调用批量改名成 spawnSafe，连函数体自己也替换了，于是每次调用都是无限递归
// RangeError: Maximum call stack size exceeded（做视频 / 跑代码 / 生图 / 恢复链路全废）。
export function spawnSafe(cmd, args, opts) {
  const child = spawn(cmd, args, opts);
  child.on('error', (e) => mcLog(`[spawn] ${cmd} 启动失败：${e?.message ?? e}`));
  return child;
}

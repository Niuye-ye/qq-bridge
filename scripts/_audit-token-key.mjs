// 扫一遍 MCP 工具定义：哪些工具用了 token 却没有 key（令牌补不上 → 调用必 403）。
import fs from 'node:fs';

const src = fs.readFileSync('src/mcp-snowluma-safe.js', 'utf8');
const parts = src.split(/server\.tool\(/).slice(1);
const rows = [];
for (const part of parts) {
  const nameMatch = part.match(/^\s*\n\s*'([a-z_0-9]+)'/);
  if (!nameMatch) continue;
  const name = nameMatch[1];
  const head = part.slice(0, 2200);
  const hasKey = /(^|[\s{])key:/.test(head);
  const usesToken = /token/.test(head);
  if (usesToken && !hasKey) rows.push(name);
}
console.log('用了 token 但没有 key 的工具：', rows.length ? rows.join(', ') : '（无）');

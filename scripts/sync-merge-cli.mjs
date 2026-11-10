#!/usr/bin/env node
// sync-merge-cli.mjs —— 把「PC 侧目录」与「手机侧暂存目录」合并成一份，供 phone-sync.ps1 用
//
// 用法：
//   node scripts/sync-merge-cli.mjs --factsA pc/facts.json --factsB stage/facts.json \
//        --forgottenA pc/facts-forgotten.json --forgottenB stage/facts-forgotten.json \
//        --diaryA pc/diary --diaryB stage/diary --out merged/
//
// 合并语义全在 src/sync-merge.mjs（纯函数、有单测）；这里只做文件 IO，不做业务判断。
// 输出：merged/facts.json、merged/facts-forgotten.json（都是 { facts: [...] } 容器，可直接覆盖 state/ 里的同名文件）、
//       merged/diary/<日期>.md、merged/stats.json
// 目录/文件不存在按「那一侧没有」处理，不报错（第一次同步就是这情况）。

import fs from 'node:fs';
import path from 'node:path';
import { mergeFactsState, mergeForgottenState, mergeDiaryText } from '../src/sync-merge.mjs';

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function listDiary(dir) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(n)) continue;
    try { out.set(n, fs.readFileSync(path.join(dir, n), 'utf8')); } catch {}
  }
  return out;
}

const A = { factsFile: arg('factsA'), forgottenFile: arg('forgottenA'), diaryDir: arg('diaryA') };
const B = { factsFile: arg('factsB'), forgottenFile: arg('forgottenB'), diaryDir: arg('diaryB') };
const outDir = arg('out');
if (!outDir) { console.error('用法见文件头：缺 --out'); process.exit(2); }

const factsMerged = mergeFactsState(readJson(A.factsFile), readJson(B.factsFile));
const forgottenMerged = mergeForgottenState(readJson(A.forgottenFile), readJson(B.forgottenFile));

const diaryA = listDiary(A.diaryDir);
const diaryB = listDiary(B.diaryDir);
const dates = [...new Set([...diaryA.keys(), ...diaryB.keys()])].sort();
const diaryOut = new Map();
const diaryStats = { files: 0, linesMerged: 0, addedFromB: 0 };
for (const n of dates) {
  const ta = diaryA.get(n) ?? null;
  const tb = diaryB.get(n) ?? null;
  const text = ta == null ? (tb ?? '') : tb == null ? ta : mergeDiaryText(ta, tb);
  diaryOut.set(n, text);
  diaryStats.files += 1;
  diaryStats.linesMerged += text.split('\n').length;
  if (ta != null && tb != null) diaryStats.addedFromB += Math.max(0, text.split('\n').length - ta.split('\n').length);
}

fs.mkdirSync(path.join(outDir, 'diary'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'facts.json'), JSON.stringify(factsMerged.merged, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(outDir, 'facts-forgotten.json'), JSON.stringify(forgottenMerged.merged, null, 2) + '\n', 'utf8');
for (const [n, text] of diaryOut) fs.writeFileSync(path.join(outDir, 'diary', n), text, 'utf8');

const stats = {
  at: new Date().toISOString(),
  facts: factsMerged.stats,
  forgotten: forgottenMerged.stats,
  diary: diaryStats,
};
fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(stats, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(stats));

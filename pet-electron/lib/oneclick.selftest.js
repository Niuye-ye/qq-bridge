// 一次性自检：node pet-electron/lib/oneclick.selftest.js（不进 main 流程）
const m = require('./oneclick.js');
const text = ['xxx', '== 链路验证 ==', '  端口 3001 : OK', '  端口 3080 : 缺', '  桥进程 : OK', ''].join('\n');
const rows = m.parseCheckRows(text);
console.log(JSON.stringify(rows));
console.log(m.oneClickSummary(rows, 0));
const dup = ['  端口 3001 : OK', '  端口 3001 : OK', '  桥 : OK'].join('\n') + '\n' + '  端口 3001 : OK\n  桥 : 缺\n';
console.log(JSON.stringify(m.parseCheckRows(dup)));

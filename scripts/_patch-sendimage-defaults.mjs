import fs from 'node:fs';

const p = 'src/bridge.js';
let s = fs.readFileSync(p, 'utf8');
const re = /sendSticker: true,\r?\n(\s*)setStickerRemark: false,/g;
let count = 0;
s = s.replace(re, (m, indent) => {
  count += 1;
  return `sendSticker: true,\n${indent}setStickerRemark: false,\n${indent}sendImage: true,`;
});
fs.writeFileSync(p, s);
console.log('替换处数 =', count);
const L = s.split('\n');
for (const n of [777, 778, 779, 904, 905, 906]) console.log(n + ': ' + L[n - 1].trim());

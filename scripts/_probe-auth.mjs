import { discoverDshSessionCookie } from '../src/dsh-client.js';
const cookie = discoverDshSessionCookie('http://127.0.0.1:3080');
for (const [label, h] of [['无 cookie', {}], ['带铸造 cookie', { cookie }]]) {
  const r = await fetch('http://127.0.0.1:3080/', { headers: h, redirect: 'manual' });
  console.log(label, '->', r.status, (r.headers.get('content-type')||''));
}
// 用 log 里的 token 换 cookie
const fs = await import('node:fs');
const log = fs.readFileSync('F:/项目/手机上使用dsh/logs/w3080.out.log', 'utf8');
const m = [...log.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)];
const tok = m.length ? m[m.length-1][1] : '';
console.log('log token:', tok ? tok.slice(0,10)+'…' : '(none)');
if (tok) {
  const r = await fetch('http://127.0.0.1:3080/?token=' + tok, { redirect: 'manual' });
  console.log('token 换 cookie ->', r.status, [...r.headers.entries()].filter(([k])=>k==='set-cookie').map(([k,v])=>v.slice(0,60)));
}
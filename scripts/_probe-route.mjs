import { discoverDshSessionCookie } from '../src/dsh-client.js';
const cookie = discoverDshSessionCookie('http://127.0.0.1:3080');
for (const path of ['/api/remote.mux', '/api/nope-xyz', '/api/sessions.list']) {
  for (const method of ['GET','POST']) {
    const r = await fetch('http://127.0.0.1:3080' + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: method==='POST' ? '{}' : undefined });
    const t = await r.text();
    console.log(method, path, '->', r.status, JSON.stringify(t.slice(0, 90)));
  }
}
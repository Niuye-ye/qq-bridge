import WS from 'ws';
import { discoverDshSessionCookie } from '../src/dsh-client.js';
const cookie = discoverDshSessionCookie('http://127.0.0.1:3080');
console.log('cookie len:', cookie.length);
const ws = new WS('ws://127.0.0.1:3080/api/remote.mux', { headers: { cookie } });
const t = setTimeout(() => { console.log('25s 仍在开 → 鉴权通过，只是暂时没事件'); ws.close(); process.exit(0); }, 25000);
ws.on('open', () => {
  console.log('WS open ✓（cookie 被接受）');
  ws.send(JSON.stringify({ type: 'open', streamId: 'probe-1', endpoint: '$events', payload: { args: {} } }));
});
ws.on('message', (d) => console.log('msg:', String(d).slice(0, 200)));
ws.on('unexpected-response', (_r, res) => { console.log('HTTP', res.statusCode, res.statusMessage); clearTimeout(t); process.exit(0); });
ws.on('close', (code, r) => { console.log('close code=', code, JSON.stringify(String(r).slice(0,120))); clearTimeout(t); process.exit(0); });
ws.on('error', (e) => console.log('err:', e?.message));
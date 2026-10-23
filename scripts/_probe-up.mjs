import { discoverDshSessionCookie } from '../src/dsh-client.js';
import http from 'node:http';
const cookie = discoverDshSessionCookie('http://127.0.0.1:3080');
const req = http.request({ host: '127.0.0.1', port: 3080, path: '/api/remote.mux', headers: {
  host: '127.0.0.1:3080', Connection: 'Upgrade', Upgrade: 'websocket',
  'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
  cookie
}});
req.on('upgrade', (res, socket) => { console.log('UPGRADE OK', res.statusCode); socket.destroy(); process.exit(0); });
req.on('response', (res) => { console.log('RESPONSE', res.statusCode, res.statusMessage); res.on('data', d => console.log('body:', String(d).slice(0,200))); res.on('end', ()=>process.exit(0)); });
req.on('error', (e) => { console.log('ERR', e.message); process.exit(0); });
req.end();
setTimeout(()=>{ console.log('timeout'); process.exit(0); }, 10000);
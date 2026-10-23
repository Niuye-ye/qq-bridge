import { discoverDshSessionCookie } from '../src/dsh-client.js';
import http from 'node:http';
const port = Number(process.argv[2] || 3080);
const auth = '127.0.0.1:' + port;
const cookie = discoverDshSessionCookie('http://' + auth);
const req = http.request({ host: '127.0.0.1', port, path: '/api/remote.mux', headers: {
  host: auth, Connection: 'Upgrade', Upgrade: 'websocket',
  'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', cookie }});
req.on('upgrade', (res, socket) => { console.log(port, 'UPGRADE OK', res.statusCode); socket.destroy(); process.exit(0); });
req.on('response', (res) => { console.log(port, 'RESPONSE', res.statusCode); process.exit(0); });
req.on('error', (e) => { console.log(port, 'ERR', e.message); process.exit(0); });
req.end(); setTimeout(()=>{ console.log(port,'timeout'); process.exit(0); }, 8000);
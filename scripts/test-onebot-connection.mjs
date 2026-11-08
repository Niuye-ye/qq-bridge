// 一次性连接测试：用 @snowluma/sdk 连接 SnowLuma 的 OneBot WebSocket 网关，
// 验证地址、端口、accessToken 是否正确。成功即打印 ✅ 并退出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
// SnowLuma 的 WS token 与 HTTP token 是两个不同的值（config.json 里只存 HTTP 那个，
// 见 bridge.js applyHealedTokens 的注释）。直接拿 cfg 的 token 连 3001 会被拒成 1006，
// 所以这里按当前登录账号的 onebot_<uin>.json 现发现一次；发现不到才退回配置值。
let wsUrl = cfg.snowluma.wsUrl;
let accessToken = cfg.snowluma.accessToken;
try {
  const found = await discoverSnowLumaConnection({ cfg });
  if (found?.ok) {
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    if (followEndpoint && found.wsUrl) wsUrl = found.wsUrl;
    if (found.wsToken) accessToken = found.wsToken;
    else if (followEndpoint && found.token) accessToken = found.token;
    console.log(`已按当前账号校正：${wsUrl}（token ${accessToken ? accessToken.slice(0, 4) + '…' : '未配置'}）`);
  }
} catch (error) {
  console.log('端点发现失败，继续用配置值：' + (error?.message ?? error));
}

console.log(`测试连接 ${wsUrl}（token ${accessToken ? '已配置' : '未配置'}）…`);

const bot = new SnowLumaWebSocketClient({
  url: wsUrl,
  accessToken: accessToken || undefined,
  reconnect: false
});

const result = await Promise.race([
  new Promise((resolve) => {
    bot.on('open', () => {
      console.log('✅ WebSocket 已连接（网关接受连接，token 正确）');
      resolve(true);
    });
    bot.on('event', (event) => {
      if (event.post_type === 'meta_event') {
        console.log('✅ 收到 meta 事件:', event.meta_event_type, JSON.stringify(event).slice(0, 160));
      } else {
        console.log('📨 收到事件:', event.post_type, event.message_type ?? '', JSON.stringify(event).slice(0, 160));
      }
    });
    bot.on('close', (info) => {
      if (info?.code === 4001 || info?.code === 401) {
        console.error('❌ 网关拒绝连接：鉴权失败（token 不对或未填）', info);
      } else {
        console.error('❌ 连接被关闭:', info);
      }
      resolve(false);
    });
  }),
  bot.connect().catch((error) => {
    console.error('❌ 连接异常:', error?.message ?? error);
    return false;
  }),
  new Promise((resolve) => setTimeout(() => {
    console.error('❌ 超时（10s）：地址/端口不对或网关未启动？');
    resolve(false);
  }, 10_000))
]);

try { bot.close(); } catch {}
process.exit(result ? 0 : 1);

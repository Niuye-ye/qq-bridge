// 运维工具族：qq_kill_link（根除整条链路进程）/ qq_set_llm_key（主人自助换模型 key）。
//
// 职责：把两个「危险但必要」的运维动作暴露给 agent，具体动作全部在桥接侧执行
// （POST /api/socialV2/kill-link、/api/socialV2/llm-key），MCP 侧只做参数透传与错误包装。
//
// 明确不做：不自己杀进程（进程表在桥接那侧统一处理）、不自己写凭据文件、不回显完整 key。
//
// 状态归属：无。agentApi / cfg / serializeModelData 由入口注入。
//
// 接口约定：registerOpsTools(server, ctx) —— 注册期同步调用一次；ctx = { cfg, agentApi, serializeModelData }。
import { z } from 'zod';

// Termux 里的 node 是 android 构建（process.platform === 'android'），文案要说「手机」而不是「桌宠/模拟器」。
const ON_ANDROID = process.platform === 'android';
const RELAUNCH_HINT = ON_ANDROID
  ? '杀完让主人跑 bash ~/boot.sh 重新拉起（guard 最多两分钟也会自己补）'
  : '杀完让主人点桌宠「一键修复 · 启动」或跑 一键启动.ps1 重新拉起';

export function registerOpsTools(server, ctx) {
  const { cfg, agentApi, serializeModelData } = ctx;
// ── 根除链路进程 ──────────────────────────────────────────────────────────────
// 桌宠「一键修复 · 启动」的反面：把整条链路杀干净（守护/桌宠/8765/8790/3080/3000/3001/桥自己）。
if (cfg.socialV2?.tools?.killLink !== false) {
  server.tool(
    'qq_kill_link',
    `把整条 QQ 链路的进程全部杀干净：先杀守护（quick check 会补回来的那些），再杀桌宠、安卓 MCP(8765)、MuMu 管家(8790)、dsh web(3080)、SnowLuma(3000/3001)，最后杀桥自己(3100)。用在「链路卡死 / 反复重启 / 端口被占 / 改了代码要彻底重来」的时候 —— ${RELAUNCH_HINT}。**注意：调用后 2~3 秒内桥会断线（它自己也被杀），所以这条消息可能发不出去 —— 需要说话时先发消息再调这个工具。默认不杀 QQ 本体${ON_ANDROID ? '' : '和 MuMu 模拟器'}，要连它们一起停就显式传 includeQQ${ON_ANDROID ? '' : ' / includeMuMu'}。不确定会杀什么时先传 dryRun:true 看清单。`,
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      includeQQ: z.boolean().optional().describe('是否连 QQ 主进程一起关（默认 false）'),
      includeMuMu: z.boolean().optional().describe(ON_ANDROID ? '手机上没有 MuMu 模拟器，这个参数会被忽略' : '是否连 MuMu 模拟器一起关（默认 false）'),
      dryRun: z.boolean().optional().describe('true = 只列出会杀哪些进程，一个都不杀（建议先干跑一次）')
    },
    async ({ key, token, includeQQ, includeMuMu, dryRun }) => {
      try {
        const data = await agentApi('/api/socialV2/kill-link', {
          method: 'POST',
          body: JSON.stringify({ key, token, includeQQ: includeQQ === true, includeMuMu: includeMuMu === true, dryRun: dryRun === true }),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `根除链路失败：${error?.message ?? error}（如果报连接重置/超时，多半是已经杀到桥自己了，链路本来就在停）` }], isError: true };
      }
    }
  );
}

// ── 模型 API Key 自助写入 ─────────────────────────────────────────────────────
// 上游模型 key 失效时，主人可以把新 key 直接交给她，由她一次写好两个键名
// （web 的 OPENCODEGO_API_KEY 与桌面端的 OPENCODE_GO_API_KEY），
// 不用自己找文件、也不会只改一半（这正是 2026-11-07 那次 QQ 侧报 MISSING_CREDENTIAL 的根因）。
// 安全约束：绝不在回复里复述完整 key，回包只给掩码；日志同样只记掩码。
if (cfg.socialV2?.tools?.setLlmKey !== false) {
  server.tool(
    'qq_set_llm_key',
    '把主人给的新模型 API Key 写进本机凭据文件（同时更新两个键名），并顺手验证它能不能用。只在主人明确把新 key 贴给你、或明确说「换 key」时调用 —— 不要自己编 key、也不要在普通对话里自动调用。调用后回复里绝对不能复述完整 key，只说「已写入（前6位…后3位）+ 验证结果」。返回 verified=valid 表示可用；invalid 表示上游拒绝（让主人确认抄没抄错、是不是过期）；unknown 表示网络/端点问题（key 可能没问题，稍后重试即可）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      value: z.string().describe('主人给的新 API Key 原文（oc_sk_ 开头）。会写进本机凭据文件，不要拼空格或换行。'),
      verify: z.boolean().optional().describe('是否顺便联网验证 key 可用性（默认 true；离线或不想发请求时传 false）')
    },
    async ({ key, token, value, verify }) => {
      try {
        const data = await agentApi('/api/socialV2/llm-key', {
          method: 'POST',
          body: JSON.stringify({ key, token, value, verify: verify !== false }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: '写入模型 key 失败：' + String(error?.message ?? error) }], isError: true };
      }
    }
  );
}
}

// 合并版 MCP server（stdio）：把 web-search-safe 与 snowluma-host 两套工具塞进一个进程。
//
// 为什么合并（2026-10-26）：dsh 的 MCP 客户端是一个 server 一个 node 子进程，每个进程光 V8 +
// 模块加载就是 60MB 上下。web-search-safe（71MB）+ snowluma-host（66MB）加起来 137MB，
// 而 host 只有一个只读工具，合并后稳态约 85MB，省 50MB 左右。
//
// 为什么 serverName 仍叫 web-search-safe：模型看到的工具名是 mcp__<serverName>__<tool>，
// 人格卡 / preset 里硬编码了 mcp__web-search-safe__web_search 十来处，沿用这个名字就不用改
// 那些提示词。snowluma_status 变成 mcp__web-search-safe__snowluma_status —— 没有任何地方引用它。
//
// 为什么不含 mcp-snowluma-safe.js：那是她最核心、改得最勤的工具，跟搜索绑同一个进程只会
// 把崩溃面合并起来，收益不值。
//
// 两个源文件都保留单独运行的能力（看各自的 isEntryFile 判断）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools as registerWebSearchTools } from './mcp-web-search-safe.js';
import { registerTools as registerHostTools } from './mcp-host-server.js';

const server = new McpServer({ name: 'web-search-safe', version: '0.2.0-merged' });
registerWebSearchTools(server);
registerHostTools(server);

await server.connect(new StdioServerTransport());

// 受限文件工具（日记 / 心情 / 记忆）：qq_read_file / qq_write_file / qq_append_file / qq_list_files
//
// 职责：只认 diary/ state/ memory/ 三个根目录的窄读写接口。DSH 自带的 read/write/edit 在 QQ
// preset 里被 qq-tool-restrict 隐藏（仿真会话不得有本地文件能力），所以这里给一套限制在根目录内、
// 拒绝 .. 与绝对路径、带单次大小上限的替代品。
//
// 明确不做：不做任意路径访问、不碰 state/social-v2.json / console-token / agent-token 等敏感文件
// （FS_DENY_RE 拦），不实现目录递归、不做二进制写入。
//
// 状态归属：无内部可变状态（常量在模块内），ROOT 由入口注入。
//
// 接口约定：registerFileTools(server, ctx) —— 注册期同步调用一次；ctx = { ROOT }。
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export function registerFileTools(server, ctx) {
  const { ROOT } = ctx;
// ===== 日记与心情：受限文件工具 =====
// QQ 里的 agent 需要落盘的长记忆（日记、心情状态）。DSH 自带的 read/write/edit
// 在 QQ preset 里被 qq-tool-restrict 隐藏（仿真会话不得有本地文件能力），
// 所以这里给一套只认两个根目录的窄工具：
//   diary/ → <repo>/diary     （日记，按日期命名，每条带 tier）
//   state/ → <repo>/state     （mood.json 等状态）
// 路径必须落在根目录内（拒绝 .. 与绝对路径），单次读写有大小上限。
const DIARY_ROOT = path.join(ROOT, 'diary');
const STATE_ROOT = path.join(ROOT, 'state');
const MEMORY_ROOT = path.join(ROOT, 'memory');
const FS_ROOTS = { diary: DIARY_ROOT, state: STATE_ROOT, memory: MEMORY_ROOT };
const FS_ROOT_NAMES = Object.keys(FS_ROOTS);
const FS_ROOT_RE = new RegExp(`^(${FS_ROOT_NAMES.join('|')})/`);
const FS_HINT = `${FS_ROOT_NAMES.join('/')} 之一`;
const FS_MAX_READ_BYTES = 256 * 1024;
const FS_MAX_WRITE_BYTES = 512 * 1024;
// 2026-10-27 修：state/ 是整目录白名单，但里面躺着所有会话的 agentToken（social-v2.json）
// 和控制台令牌（console-token）。读走一个就能借别人的身份说话 —— 这两个文件一律不给读写。
const FS_DENY_RE = /^state\/(social-v2|console-token|agent-token|bridge-guard)/i;

// 允许三种写法：
//   1) diary/2026-10-22.md（推荐，短）
//   2) <数据目录>/diary/2026-10-22.md（模型照抄用户给的绝对路径也不会写飞）
//   3) 2026-10-22.md（没前缀就当日记，落 diary/）
function resolveFsPath(rawPath) {
  const raw = String(rawPath ?? '').trim().replace(/\\/g, '/');
  if (!raw) throw new Error(`path 不能为空：写 diary/2026-10-22.md、memory/2026-10-22.md 或 state/mood.json`);
  let rel0 = raw;
  if (/^[a-zA-Z]:\//.test(raw) || raw.startsWith('//') || raw.startsWith('/')) {
    const abs = path.resolve(raw);
    const relToRoot = path.relative(ROOT, abs);
    if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      throw new Error(`path 越界：只能读写 D:/qq-bridge/ 下的 ${FS_HINT}（收到 ${raw}）`);
    }
    rel0 = relToRoot.split(path.sep).join('/');
  }
  rel0 = rel0.replace(/^\.\//, '');
  const withRoot = FS_ROOT_RE.test(rel0) ? rel0 : `diary/${rel0}`;
  const segs = withRoot.split('/').filter((s) => s && s !== '.');
  if (segs.some((s) => s === '..')) throw new Error('path 不允许包含 ..');
  const rootName = segs[0];
  const root = FS_ROOTS[rootName];
  if (!root) throw new Error(`path 必须以 ${FS_HINT} 开头`);
  const abs = path.resolve(root, ...segs.slice(1));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path 越界：只能读写 ${FS_HINT} 里的文件`);
  const label = `${rootName}/${rel.split(path.sep).join('/')}`;
  if (FS_DENY_RE.test(label)) throw new Error(`${label} 里存着会话令牌/锁，不给读写`);
  return { abs, label };
}

server.tool(
  'qq_read_file',
  '读 diary/、memory/ 或 state/ 下的文本文件（如 state/mood.json、diary/2026-10-22.md）。绝对路径 D:/qq-bridge/... 也认。可选 tailLines 只读末尾 N 行（长日记省 token）。',
  { path: z.string(), tailLines: z.number().int().positive().max(2000).optional() },
  async ({ path: rawPath, tailLines }) => {
    try {
      const { abs, label } = resolveFsPath(rawPath);
      if (!fs.existsSync(abs)) return { content: [{ type: 'text', text: `${label} 还不存在` }] };
      const st = fs.statSync(abs);
      if (st.isDirectory()) return { content: [{ type: 'text', text: `${label} 是目录，用 qq_list_files 列内容` }], isError: true };
      if (st.size > FS_MAX_READ_BYTES) return { content: [{ type: 'text', text: `${label} 太大（${st.size} 字节，上限 ${FS_MAX_READ_BYTES}）；用 tailLines 读末尾` }], isError: true };
      let text = fs.readFileSync(abs, 'utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      if (Number.isFinite(tailLines) && tailLines > 0) {
        const lines = text.split('\n');
        text = lines.slice(Math.max(0, lines.length - tailLines)).join('\n');
      }
      return { content: [{ type: 'text', text: text || `（${label} 是空文件）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_write_file',
  '覆盖写 diary/、memory/ 或 state/ 下的文本文件（自动建父目录，绝对路径也认）。要往末尾加内容请用 qq_append_file。',
  { path: z.string(), content: z.string() },
  async ({ path: rawPath, content }) => {
    try {
      const { abs, label } = resolveFsPath(rawPath);
      const buf = Buffer.from(String(content ?? ''), 'utf8');
      if (buf.length > FS_MAX_WRITE_BYTES) return { content: [{ type: 'text', text: `内容太大（${buf.length} 字节，上限 ${FS_MAX_WRITE_BYTES}）` }], isError: true };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      return { content: [{ type: 'text', text: `已写入 ${label}（${buf.length} 字节）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_append_file',
  '追加到 diary/、memory/ 或 state/ 下的文件末尾（不存在则新建）。写日记建议用它，一条一个块。',
  { path: z.string(), content: z.string() },
  async ({ path: rawPath, content }) => {
    try {
      const { abs, label } = resolveFsPath(rawPath);
      const buf = Buffer.from(String(content ?? ''), 'utf8');
      if (buf.length > FS_MAX_WRITE_BYTES) return { content: [{ type: 'text', text: `内容太大（${buf.length} 字节，上限 ${FS_MAX_WRITE_BYTES}）` }], isError: true };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, buf);
      const size = fs.statSync(abs).size;
      return { content: [{ type: 'text', text: `已追加到 ${label}（本次 ${buf.length} 字节，现共 ${size} 字节）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `追加失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_files',
  '列出 diary/、memory/ 或 state/ 里的文件（名字、大小、修改时间）。按 tier 清理旧日记时先用它看有哪些文件。',
  { root: z.enum(['diary', 'memory', 'state']).optional() },
  async ({ root }) => {
    try {
      const name = FS_ROOTS[root] ? root : 'diary';
      const dir = FS_ROOTS[name];
      if (!fs.existsSync(dir)) return { content: [{ type: 'text', text: `${name}/ 目录不存在` }] };
      const rows = fs.readdirSync(dir).map((f) => {
        const abs = path.join(dir, f);
        const st = fs.statSync(abs);
        return { name: f, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), isDir: st.isDirectory() };
      }).sort((a, b) => a.name.localeCompare(b.name));
      const text = rows.length
        ? rows.map((r) => `${r.isDir ? '[dir] ' : ''}${name}/${r.name}\t${r.bytes}B\t${r.mtime}`).join('\n')
        : `（${name}/ 是空的）`;
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `列目录失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
}

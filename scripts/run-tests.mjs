// 统一测试入口 —— 把 55 个脚本按「能不能离线跑」分开，别再靠记忆逐个敲。
//
// 2026-10-27 审计结论之一：55 个 test-*.mjs 里 21 个没有入口，失败里大半是
// 「环境没准备好」被当成「代码坏了」——测不出真问题，反而训练大家忽略红灯。
//
// 用法：
//   node scripts/run-tests.mjs              # 只跑离线套件（CI 应当用这个）
//   node scripts/run-tests.mjs --all        # 连需要活体服务的也跑（本机诊断用）
//   node scripts/run-tests.mjs --filter=pet # 只跑文件名含 pet 的
//
// 需要活体服务的套件在 E2E_REQUIRE 里声明依赖；依赖没就绪就 SKIP（并写明缺什么），
// 不算失败。加新测试时：只要它连真 DSH / 真 SnowLuma / 真桥 / 浏览器，就在表里登记一下。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const filterArg = argv.find((a) => a.startsWith('--filter='));
const FILTER = filterArg ? filterArg.slice('--filter='.length) : '';

// 名字 → 依赖。依赖值在下面逐个探测，探测不通就 SKIP。
const E2E_REQUIRE = {
  'test-console-ui.mjs': 'playwright',
  'test-dsh-v2-wait.mjs': 'dsh',
  'test-preset-local-tools.mjs': 'dsh',
  'test-vision-media.mjs': 'dsh',
  'test-onebot-connection.mjs': 'snowluma',
  'test-dsh-auth.mjs': 'dsh',
  'test-dsh-inbox-projection.mjs': 'dsh',
  'test-dsh-session-retire.mjs': 'dsh',
  'test-console.mjs': 'dsh'
};

function portOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function probePlaywright() {
  for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core']) {
    if (!candidate) continue;
    try {
      await import(candidate);
      return true;
    } catch {
      // 试下一个候选
    }
  }
  return false;
}

// 活体套件默认**一律跳过**，不靠端口猜测：这些套件要么等真人回话、要么读本机当前配置，
// 端口开着也只说明「有些服务在跑」，不代表它要测的那个状态成立。想跑就显式开口子：
//   PowerShell: $env:QQ_BRIDGE_E2E=1; node scripts/run-tests.mjs
const E2E_ENABLED = process.env.QQ_BRIDGE_E2E === '1';
const PROBES = {
  playwright: async () => E2E_ENABLED && probePlaywright(),
  dsh: async () => E2E_ENABLED && (await portOpen(3080)) && fs.existsSync(path.join(ROOT, 'state', 'console-token')),
  snowluma: async () => E2E_ENABLED && portOpen(3001),
  // 自带夹具、离线可跑的套件也要显式登记，免得以后有人以为它们需要活体
  'mux-fixture': async () => true
};

const suites = fs.readdirSync(SCRIPTS)
  .filter((name) => /^test-.*\.mjs$/.test(name))
  .filter((name) => !FILTER || name.includes(FILTER))
  .sort();

function runSuite(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [path.join(SCRIPTS, name)], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300000
    }, (error, stdout, stderr) => {
      resolve({
        name,
        ok: !error,
        ms: Date.now() - started,
        output: (String(stdout || '') + String(stderr || '')).trim()
      });
    });
  });
}

/** 失败时挑出最有信息量的几行，别把几百行日志糊到控制台。 */
function failureHint(output) {
  const lines = output.split(/\r?\n/);
  const picked = lines.filter((line) => /✖|FAIL|Error|AssertionError|not ok/.test(line));
  return (picked.length ? picked : lines).slice(0, 4).join('\n      ');
}

const skipped = [];
const results = [];
for (const name of suites) {
  const need = E2E_REQUIRE[name];
  if (need && !ALL) {
    const ok = await PROBES[need]();
    if (!ok) {
      skipped.push({ name, need });
      continue;
    }
  }
  process.stdout.write('· ' + name + ' ... ');
  const result = await runSuite(name);
  results.push(result);
  console.log(result.ok ? 'PASS (' + result.ms + 'ms)' : 'FAIL (' + result.ms + 'ms)');
  if (!result.ok) {
    const hint = failureHint(result.output);
    if (hint) console.log('      ' + hint);
  }
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log('跑完 ' + results.length + ' 个套件：' + (results.length - failed.length) + ' 通过 / '
  + failed.length + ' 失败'
  + (skipped.length ? ' / ' + skipped.length + ' 跳过（要活体环境，--all 可强制跑）' : ''));
for (const item of skipped) console.log('  SKIP ' + item.name + ' —— 缺 ' + item.need);
if (failed.length) {
  console.log('');
  console.log('失败清单：');
  for (const item of failed) console.log('  ' + item.name);
}
process.exitCode = failed.length ? 1 : 0;

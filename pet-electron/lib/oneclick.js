'use strict';
// ────────────────────────────── 一键启动 · 启动 ──────────────────────────────
// 2026-10-27 从 pet-electron/main.js:1199-1305 整块搬出来（交接文档第 4 项第二块）。
// 这块是「右键菜单 → 一键修复 · 启动」背后的全部逻辑：拉 powershell 跑启动脚本、
// 只读本次新增的日志尾巴、把最后一张验证表解析成行、弹出中文结论。
//
// 三个别改的地方（都是实测踩出来的）：
//   1) spawn 必须「不 detached + stdio:'ignore'」：detached 或把 stdio 重定向到 fd，
//      powershell.exe 5.1 会在 100~300ms 内 code 0 静默退出，什么都不干（2026-10-24 实测）。
//   2) 日志要按 **字节偏移** 取增量：脚本是追加写，「上次那张表」不能拿来冒充这次的结果。
//   3) parseCheckRows 只看最后一个「链路验证」标记之后的表，并且同名项重复出现就清空重来
//      （offset 算错时能兜住）。验证表本身有 17~20 行，别用行数猜。
//
// 依赖全部由调用方注入（log / notify / dialog / getWindow），这里不 require electron。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/** 只读 from 之后新增的部分（上一轮的旧结果不能拿来冒充这次的） */
function readLogDelta(p, from) {
  try {
    const buf = fs.readFileSync(p);
    return buf.subarray(from > 0 ? from : 0).toString('utf8');
  } catch (_) { return ''; }
}

/** 验证表行形如：   QQ 主进程 : OK  PID 22792   /   dsh web 3080 : 缺
 *  只看最后一张表：日志里那行「== 链路验证 ==」之后才是本次结果；
 *  再加一道「同名项重复出现 = 又开了一张表」的兜底，免得 offset 算错时把上一次的算进来。 */
function parseCheckRows(text) {
  let s = String(text || '');
  const i = s.lastIndexOf('链路验证');
  if (i >= 0) s = s.slice(i);
  const rows = [];
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/^\s{2,}(\S[^:：]{0,30}?)\s*[:：]\s*(OK|缺|DOWN|FAIL|不可用)/);
    if (!m) continue;
    const name = m[1].trim();
    if (rows.some((r) => r.name === name)) rows.length = 0;
    rows.push({ name, ok: m[2] === 'OK' });
  }
  return rows;
}

function oneClickSummary(rows, code) {
  if (!rows.length) {
    return code === 0
      ? '跑完了，但没读到结果表，看 logs\\oneclick.log'
      : '脚本提前退出了（code ' + code + '），看 logs\\oneclick.log';
  }
  const bad = rows.filter((r) => !r.ok);
  if (!bad.length) return '修好了：' + rows.length + ' 项全绿 ✓';
  return (rows.length - bad.length) + ' 项 OK、' + bad.length + ' 项没好：' + bad.map((r) => r.name).join('、');
}

function createOneClick(opts) {
  const {
    scriptPath,
    timeoutMs = 180000,
    log = () => {},
    notify = () => {},
    dialog,
    getWindow = () => null,
    onFinished = () => {},
  } = opts || {};

  // 2026-10-27 修（审计 P2）：以前是「busyAt + 一个共享的 timer」——
  //   ① 超时只把 busyAt 清零、不杀 powershell，于是一次卡死会永久占着端口不放；
  //   ② timer 是共享变量，上一轮的 finish 会把下一轮的 timer 清掉，新一轮就没有超时保护了。
  // 现在每次运行一个 run 对象，超时就 kill 掉自己那棵子进程并按失败收尾。
  let run = null;   // { child, from, startedAt, timer, done }

  const busyMs = () => (run ? Date.now() - run.startedAt : 0);

  function logPath() {
    try { return scriptPath ? path.join(path.dirname(scriptPath), 'logs', 'oneclick.log') : ''; } catch (_) { return ''; }
  }

  function runOneClick() {
    if (!scriptPath || !fs.existsSync(scriptPath)) {
      log('一键启动脚本没配置（PET_ONECLICK）');
      const win = getWindow();
      if (win && !win.isDestroyed() && dialog) {
        dialog.showMessageBox(win, {
          type: 'info',
          title: '没配一键启动',
          message: '没有配置一键启动脚本',
          detail: '设置环境变量 PET_ONECLICK 指向你自己的启动脚本（例如 C:\\your\\一键启动.ps1），重启桌宠后这一项才会出现。',
        }).catch(() => {});
      }
      return;
    }
    // 已经有一次在跑就别起第二个：两个 powershell 抢同一批端口只会互相打架
    if (run && !run.done && busyMs() < timeoutMs) {
      const secs = Math.round(busyMs() / 1000);
      notify('上一次还在跑（' + secs + ' 秒了），等它跑完…', 5000);
      log('一键启动已在运行，忽略重复点击（已跑', secs, '秒）');
      return;
    }

    try {
      const opts2 = { windowsHide: true, stdio: 'ignore' };
      const lp = logPath();
      const from = fileSize(lp);          // 只看这次新增的那段
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, '-Quiet',
      ], opts2);

      const me = { child, from, startedAt: Date.now(), timer: null, done: false };
      run = me;
      notify('好，我去把链路修一遍…大概 25 秒', 30000);
      log('已拉起一键启动.ps1 -Quiet → PID', child.pid, '（日志起点', from, '字节）');

      const finish = (code, why) => {
        if (me.done) return;
        me.done = true;
        if (me.timer) { clearTimeout(me.timer); me.timer = null; }
        const usedMs = Date.now() - me.startedAt;
        if (run === me) run = null;
        const rows = parseCheckRows(readLogDelta(lp, me.from));
        const msg = why || oneClickSummary(rows, code);
        notify(msg, 30000);
        log('一键启动结束 code =', code, '| 耗时', Math.round(usedMs / 1000) + '秒 | 结果行数', rows.length, '|', msg);
        onFinished(code, rows);
      };

      child.on('error', (e) => { log('一键启动 spawn 失败', e.message); finish(null, '没拉起来：' + e.message); });
      child.on('exit', (code) => finish(code));
      child.unref();

      me.timer = setTimeout(() => {
        if (me.done) return;
        log('一键启动超时（' + Math.round(timeoutMs / 1000) + ' 秒未见退出），杀掉子进程');
        // 卡住的 powershell 必须杀：它可能正占着 3000/3080/3100，留着下一轮照样抢端口
        try { if (me.child && me.child.pid) process.kill(me.child.pid); } catch (e) { log('kill 失败', e.message); }
        finish(null, '跑了 ' + Math.round(timeoutMs / 60000) + ' 分钟还没结束，已经掐掉，去看 logs\\oneclick.log');
      }, timeoutMs);
      if (me.timer.unref) me.timer.unref();
    } catch (e) { log('一键启动失败', e.message); notify('没拉起来：' + e.message, 15000); }
  }

  return {
    runOneClick,
    logPath,
    readLogDelta,
    parseCheckRows,
    oneClickSummary,
    get busy() { return run ? run.startedAt : 0; },
  };
}

module.exports = { createOneClick, readLogDelta, parseCheckRows, oneClickSummary };

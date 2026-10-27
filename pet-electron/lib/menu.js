'use strict';
// ────────────────────────────── 右键菜单 ──────────────────────────────
// 2026-10-27 从 pet-electron/main.js:819-951 整块搬出来（交接文档第 4 项第三块）。
// 这一块是纯数据：拼一棵 electron Menu 模板树，点击时才回调外面的函数。
// 之所以值得单独放一个文件：它引用主进程三十多个符号（预设表、尺寸、开关、桥状态……），
// 塞在 1500 行 main.js 中间谁也看不清；搬出来之后「菜单里到底有哪些项」一眼可数。
//
// ⚠️ 这个文件最容易犯的错是「漏传一个符号」—— 不漏在启动，漏在用户右键那一刻才炸。
// 所以 main.js 启动时会调一次 selfCheck()（构建一遍模板、数一下项数写进日志），
// 以后任何漏传都会在 logs\pet-app.log 的「菜单模板」那一行暴露，不用等右键。
//
// 依赖一律由调用方注入（deps），这里不 require electron、不读文件、不碰全局。

// deps 里必须存在的符号。selfCheck 会逐个核对 —— 只数菜单项数是查不出漏传的
// （2026-10-27 实测：applySize 没注入，「更大/更小」点下去才 TypeError，而项数照样 104 项全绿）。
const REQUIRED_DEPS = [
  'getWin', 'getState', 'openChat', 'feelMenuItems', 'trimTo', 'showActivity', 'showActivityBox',
  'todayDiary', 'openPreview', 'FACTS_JSON', 'PLAY_FOCUS', 'PLAY_PRESETS', 'playFor', 'toggleTurbo',
  'clock', 'lastPlayLine', 'levelNow', 'LEVEL_PRESETS', 'setLevel', 'togglePause', 'readPetState',
  'toggleAnim', 'SKINS', 'writePetState', 'send', 'log', 'MOTIONS', 'FACES', 'hideForGood',
  'showLinkStatus', 'ONECLICK', 'oneClick', 'runOneClick', 'openPath', 'BRIDGE', 'bridge', 'APP_LOG',
  'onQuit', 'SIZE', 'SIZE_STEP', 'applySize',
];

function createMenu(deps) {
  let win = null;
  let st = {};

  function subItems(list) {
    return list.map(([word, name]) => ({ label: name, click: () => win?.webContents.send('pet:ui', { t: 'do', word }) }));
  }

  function buildTemplate() {
    win = deps.getWin();
    st = deps.getState() || {};
    const {
      feelMenuItems, trimTo, showActivity, showActivityBox, todayDiary, openPreview, FACTS_JSON,
      PLAY_FOCUS, PLAY_PRESETS, playFor, toggleTurbo, clock, lastPlayLine, levelNow, LEVEL_PRESETS,
      setLevel, togglePause, readPetState, toggleAnim, SKINS, writePetState, send, log,
      SIZE, SIZE_STEP, applySize, MOTIONS, FACES, hideForGood, showLinkStatus, // applySize 2026-10-27 补回（曾漏传 → 更大/更小必炸）
      ONECLICK, oneClick, runOneClick, openPath, BRIDGE, bridge, APP_LOG, onQuit,
    } = deps;
    return [
      { label: '跟她说句话…', click: () => openChatRef() },
      { type: 'separator' },
      {
        label: '她',
        submenu: [
          // 心情 / 好感度（state/mood.json 是她自己维护的；读不到就说明她还没记过）
          ...feelMenuItems(st),
          { type: 'separator' },
          { label: st.doing ? `她在干嘛：${trimTo(st.doing, 14)}` : '她在干嘛', click: showActivity },
          { label: '她现在的详细状态', click: showActivityBox },
          { label: '今天的日记', click: () => openPreview(todayDiary(), '今天的日记', 'diary') },
          { label: '长期记忆', click: () => openPreview(FACTS_JSON, '长期记忆', 'facts') },
          { type: 'separator' },
          // 让她去玩会儿 = 玩什么（手机 / MC / 都行）× 玩多久；醒多勤看下一条「活跃度」。
          {
            label: `让她去玩会儿${(st.turbo && st.turbo.on) ? `（现在在${(st.turbo.focusLabel || '玩')}）` : ''}`,
            submenu: PLAY_FOCUS.map((foc) => ({
              label: `去${foc.label}${(st.turbo && st.turbo.on && st.turbo.focus === foc.id) ? '（正在）' : ''}`,
              submenu: PLAY_PRESETS.map((p) => ({
                label: `${p.label}${(st.turbo && st.turbo.on) ? '（换成这个）' : ''}`,
                click: () => playFor(p.hours, p.label, foc.id, foc.label),
              })),
            })),
          },
          // 只在"正在玩"时出现，点它就是喊停。
          ...((st.turbo && st.turbo.on) ? [{
            label: `她正在${(st.turbo.focusLabel || '玩')}：剩 ${st.turbo.remainMinutes || 0} 分钟 · 每 ${st.turbo.everyMinutes || '?'} 分钟一轮 · 这段 ¥${Number(st.turbo.costTurboCny || 0).toFixed(2)}（${clock(st.turbo.until)} 收）· 点这里喊停`,
            click: () => toggleTurbo(),
          }] : []),
          // 玩完之后还留着一条结算：这段多久、花了多少钱。
          ...((!(st.turbo && st.turbo.on) && st.turbo && st.turbo.last) ? [{
            label: lastPlayLine(st.turbo.last),
            enabled: false,
          }] : []),
          {
            label: `活跃度：${levelNow().label}（每 ${levelNow().minutes || '?'} 分钟醒一轮）`,
            submenu: LEVEL_PRESETS.map((l) => ({
              label: l.label,
              type: 'radio',
              checked: levelNow().id === l.id,
              click: () => setLevel(l.id, l.label),
            })),
          },
          {
            label: (st.turbo && typeof st.turbo.costTodayCny === 'number')
              ? `她今天花了 ¥${st.turbo.costTodayCny.toFixed(2)}`
              : '她今天花了（统计不到）',
            enabled: false,
          },
          { label: st.paused ? '恢复她的自主时间' : '暂停她的自主时间', click: () => togglePause() },
          { label: readPetState().noAnim ? '恢复动画' : '暂停动画', click: () => toggleAnim() },
        ],
      },
      {
        label: '样子',
        submenu: [
          {
            label: '换个样子',
            submenu: SKINS.map((s) => ({
              label: s.label,
              type: 'checkbox',
              checked: (readPetState().skin || 'deepseek-maid') === s.id,
              click: () => {
                writePetState({ skin: s.id });
                send('pet:ui', { t: 'scheme', id: s.id });
                log('换样子 →', s.id);
              },
            })),
          },
          {
            label: `大小（当前 ${SIZE}px）`,
            submenu: [
              { label: `更大 +${SIZE_STEP}`, click: () => applySize(SIZE + SIZE_STEP) },
              { label: `更小 −${SIZE_STEP}`, click: () => applySize(SIZE - SIZE_STEP) },
              { type: 'separator' },
              { label: '小 280', type: 'checkbox', checked: SIZE === 280, click: () => applySize(280) },
              { label: '中 420（默认）', type: 'checkbox', checked: SIZE === 420, click: () => applySize(420) },
              { label: '大 560', type: 'checkbox', checked: SIZE === 560, click: () => applySize(560) },
              { label: '巨大 700', type: 'checkbox', checked: SIZE === 700, click: () => applySize(700) },
              { type: 'separator' },
              { label: '鼠标放她身上滚轮也能调', enabled: false },
            ],
          },
          { label: '做个动作', submenu: subItems(MOTIONS) },
          { label: '换个表情', submenu: subItems(FACES) },
          {
            label: '连播',
            submenu: [
              { label: '动作 × 8', click: () => win?.webContents.send('pet:ui', { t: 'seq', words: ['nod', 'wave', 'jump', 'spin', 'bow', 'dance', 'sit', 'happy'] }) },
              { label: '表情 × 6', click: () => win?.webContents.send('pet:ui', { t: 'seq', words: ['happy', 'wink', 'love', 'shy', 'surprised', 'smug'] }) },
            ],
          },
          { type: 'separator' },
          { label: '藏起来', click: () => hideForGood() },
        ],
      },
      {
        label: 'QQ 链路',
        submenu: [
          { label: '看链路状态', click: showLinkStatus },
          ...(ONECLICK ? [{ label: oneClick.busy ? '一键修复 · 启动（运行中…）' : '一键修复 · 启动', click: runOneClick }] : []),
          { label: '打开桥控制台', click: () => openPath(`${BRIDGE}/?token=${encodeURIComponent(bridge.token)}`) },
          { type: 'separator' },
          { label: '打开桌宠日志', click: () => openPath(APP_LOG) },
        ],
      },
      {
        label: '系统',
        submenu: [
          {
            label: '总在最前（打游戏时可关）',
            type: 'checkbox',
            checked: true,
            click: (mi) => {
              if (!win || win.isDestroyed()) return;
              win.setAlwaysOnTop(!!mi.checked);
              log('置顶 =', !!mi.checked);
            },
          },
          { label: '退出', click: () => onQuit() },
        ],
      },
    ];
  }

  function openChatRef() { return deps.openChat(); }

  function countItems(tpl) {
    let n = 0;
    for (const it of tpl || []) {
      n += 1;
      if (it && it.submenu) n += countItems(it.submenu);
    }
    return n;
  }

  /**
   * 启动时调一次：核对依赖 + 构建模板 + 返回项数。
   * 只数项数是查不出漏传的（闭包符号缺失要到点击那一刻才 TypeError），
   * 所以先把 REQUIRED_DEPS 逐个比对 values —— missing 非空就说明 main.js 的 deps 少了一项。
   */
  function selfCheck() {
    const missing = REQUIRED_DEPS.filter((k) => {
      try { return deps[k] === undefined; } catch { return true; }   // getter 撞 TDZ 也算缺失
    });
    const tpl = buildTemplate();
    return { top: tpl.length, total: countItems(tpl), missing };
  }

  function popupMenu() {
    win = deps.getWin() || win;
    if (!win) return;
    const tpl = buildTemplate();
    deps.Menu.buildFromTemplate(tpl).popup({ window: win });
  }

  return { popupMenu, buildTemplate, selfCheck, countItems };
}

module.exports = { createMenu, REQUIRED_DEPS };

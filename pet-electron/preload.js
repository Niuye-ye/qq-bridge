// 桌宠渲染进程与主进程之间的唯一通道。渲染进程不碰 fs、不碰 token、不发网络请求。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  /** body.js 的 host.emit 原样转给主进程（事件：mode/arrived/interrupted/touch/done） */
  emit: (kind, detail) => ipcRenderer.send('pet:event', kind, detail ?? null),

  /** 渲染进程自己算的命中结果（主进程另有光标轮询，这里是补充） */
  setHit: (inside) => ipcRenderer.send('pet:hit', !!inside),

  /** 抓起/放下：拖拽期间必须强制可点，否则甩出框会丢 pointerup */
  setDragging: (on) => ipcRenderer.send('pet:drag', !!on),

  /** 主进程每 3s 推一次桥状态 { mood, doing, lastLine, links, paused } */
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('pet:state', h);
    return () => ipcRenderer.removeListener('pet:state', h);
  },

  /** 主进程主动让 UI 做点什么：{t:'do', word} / {t:'seq', words} / {t:'chat'} / {t:'bubble', show} */
  onUi: (cb) => {
    const h = (_e, m) => cb(m);
    ipcRenderer.on('pet:ui', h);
    return () => ipcRenderer.removeListener('pet:ui', h);
  },

  /** 光标进出窗口附近时主进程推 true/false，按钮靠它显形 */
  onHover: (cb) => {
    const h = (_e, near) => cb(!!near);
    ipcRenderer.on('pet:hover', h);
    return () => ipcRenderer.removeListener('pet:hover', h);
  },

  /** 拖着立绘走 = 搬整个窗口（屏幕上任意位置都能放） */
  winDragStart: () => ipcRenderer.send('pet:win-drag-start'),
  winDragEnd: () => ipcRenderer.send('pet:win-drag-end'),

  /** 桌面聊天框发一句话 → 桥的 desk-message */
  send: (text) => ipcRenderer.invoke('pet:send', String(text ?? '')),

  /** 右键菜单/按钮触发的一次性动作 */
  action: (name, arg) => ipcRenderer.invoke('pet:action', name, arg ?? null),

  /** 启动时拿一次配置（尺寸、key、token 是否存在、位置） */
  config: () => ipcRenderer.invoke('pet:config'),

  /** 读一个文本文件（日记/长期记忆的预览窗用） */
  readText: (p) => ipcRenderer.invoke('pet:read-text', String(p ?? '')),

  /** 记住窗口位置 */
  savePos: (x, y) => ipcRenderer.invoke('pet:pos', { x, y }),

  /** 上报需要吃鼠标的 UI 矩形（窗口坐标），主进程并进穿透判定 */
  setUiRects: (rects) => ipcRenderer.send('pet:ui-rects', Array.isArray(rects) ? rects : []),

  /** 渲染进程的诊断日志，落到 logs\pet-app.log */
  log: (...a) => ipcRenderer.send('pet:log', a.map((x) => (typeof x === 'string' ? x : safe(x))).join(' ')),
});

function safe(x) {
  try { return JSON.stringify(x); } catch (_) { return String(x); }
}

// 桌宠渲染进程与主进程之间的唯一通道。渲染进程不碰 fs、不碰 token、不发网络请求。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  /** body.js 的 host.emit 原样转给主进程（事件：mode/arrived/interrupted/touch/done） */
  emit: (kind, detail) => ipcRenderer.send('pet:event', kind, detail ?? null),

  /** 鼠标是否落在角色身上：主进程据此决定窗口吃不吃鼠标 */
  setHit: (inside) => ipcRenderer.send('pet:hit', !!inside),

  /** 抓起/放下：拖拽期间必须强制可点，否则甩出框会丢 pointerup */
  setDragging: (on) => ipcRenderer.send('pet:drag', !!on),

  /** 主进程每 2.5s 推一次 { mood, activity, lastLine, status, pending } */
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('pet:state', h);
    return () => ipcRenderer.removeListener('pet:state', h);
  },

  /** 桌面聊天框发一句话 → 桥的 desk-message */
  send: (text) => ipcRenderer.invoke('pet:send', String(text ?? '')),

  /** 右键菜单/按钮触发的一次性动作：wake / reset / reload / hide / quit / move 等 */
  action: (name, arg) => ipcRenderer.invoke('pet:action', name, arg ?? null),

  /** 启动时拿一次配置（尺寸、key、token 是否存在、位置） */
  config: () => ipcRenderer.invoke('pet:config'),

  /** 记住窗口位置 */
  savePos: (x, y) => ipcRenderer.invoke('pet:pos', { x, y }),

  /** 渲染进程的诊断日志，落到 logs\pet.out.log */
  log: (...a) => ipcRenderer.send('pet:log', a.map(x => (typeof x === 'string' ? x : safe(x))).join(' ')),
});

function safe(x) {
  try { return JSON.stringify(x); } catch (_) { return String(x); }
}

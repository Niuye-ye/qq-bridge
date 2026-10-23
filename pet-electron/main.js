// 小鲸鱼桌宠 · Electron 主进程
// M1：透明正方形窗口 + app:// 协议 + 位置记忆 + 穿透骨架 + 托盘
// 轮询/菜单五组/聊天在 M2-M3 补，接口已经占好位。
const {
  app, BrowserWindow, ipcMain, protocol, Menu, Tray, nativeImage, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');

// ────────────────────────────── 常量 ──────────────────────────────
const PET_ROOT = 'D:\\qq-bridge\\assets\\pet';
const STATE_DIR = 'D:\\qq-bridge\\state';
const PET_JSON = path.join(STATE_DIR, 'pet.json');
const TRAY_PNG = path.join(PET_ROOT, 'pet-tray.png');
const FACE_PNG = path.join(PET_ROOT, 'whale', 'tex', 'face.png');
const APP_LOG = 'F:\\项目\\手机上使用dsh\\logs\\pet-app.log';

// VIEW = [-12, -8, 268, 272] → 280 x 280。窗口必须是正方形，理由见 桌宠改造-最终方案.md §2
const SIZE = 420;
const K = SIZE / 280;
const FLOOR_Y = 264 * K; // 地面在 rig y=256，VIEW 顶是 -8
const KEY = 'private:1946431105';
const CONFIG = { size: SIZE, k: K, floorY: FLOOR_Y, key: KEY };

// ────────────────────────────── 日志 ──────────────────────────────
// 只写文件，不碰 stdout：用 `start /b` 从隐藏 cmd 起来时 stdout 管道可能已被关掉，
// console.log 会抛 EPIPE 直接把主进程炸出一个错误弹窗（踩过）。
const STAMP = () => new Date().toISOString().slice(11, 23);
function writeLog(line) {
  try { fs.appendFileSync(APP_LOG, line + '\r\n'); } catch (_) {}
}
function log(...a) {
  writeLog(`[${STAMP()}] ${a.map((x) => (typeof x === 'string' ? x : safeStr(x))).join(' ')}`);
}
function safeStr(x) { try { return JSON.stringify(x); } catch (_) { return String(x); } }

process.on('uncaughtException', (e) => writeLog(`[${STAMP()}] !!! uncaught ${(e && e.stack) || e}`));
process.on('unhandledRejection', (e) => writeLog(`[${STAMP()}] !!! rejection ${(e && e.stack) || e}`));

// ────────────────────────────── 状态 ──────────────────────────────
let win = null, tray = null;
let ignoring = true; // 当前是否穿透
let dragging = false;
let quitRequested = false;

function readPetState() {
  try { return JSON.parse(fs.readFileSync(PET_JSON, 'utf8')); } catch (_) { return {}; }
}
function writePetState(patch) {
  try {
    const cur = readPetState();
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(PET_JSON, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8');
  } catch (e) { log('写 pet.json 失败', e.message); }
}

/** 位置落在某块屏幕的工作区内才用，否则丢到主屏右下角 */
function restoreBounds() {
  const st = readPetState();
  const x = Number(st.left), y = Number(st.top);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    const ok = screen.getAllDisplays().some((d) => {
      const w = d.workArea;
      return x > w.x - SIZE + 80 && x < w.x + w.width - 80 && y > w.y - SIZE + 80 && y < w.y + w.height - 80;
    });
    if (ok) return { x: Math.round(x), y: Math.round(y) };
    log('位置不在任何屏幕内，回落默认', x, y);
  }
  const w = screen.getPrimaryDisplay().workArea;
  return { x: w.x + w.width - SIZE - 24, y: w.y + w.height - SIZE - 24 };
}

// ────────────────────────────── 协议 ──────────────────────────────
// file:// 下 ES module 的 origin 是 null，import 会被 CORS 拒；必须走自定义标准协议。
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function registerAppProtocol() {
  protocol.handle('app', async (req) => {
    try {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const abs = path.resolve(PET_ROOT, rel);
      if (!abs.toLowerCase().startsWith(PET_ROOT.toLowerCase())) {
        log('协议越界', req.url);
        return new Response('forbidden', { status: 403 });
      }
      const buf = await fs.promises.readFile(abs);
      return new Response(buf, {
        headers: {
          'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache',
        },
      });
    } catch (e) {
      log('协议读失败', req.url, e.message);
      return new Response('not found: ' + e.message, { status: 404 });
    }
  });
}

// ────────────────────────────── 穿透 ──────────────────────────────
// forward 在本机实测没把 mousemove 送进渲染进程，所以穿透判定改由主进程轮询光标：
// 30ms 一次 GetCursorPos，比 IPC 往返稳，渲染进程卡住也不影响。
const CHAR_HALF = Math.min(112 * K, SIZE * 0.44);
const HIT_RECT = {
  x0: SIZE / 2 - CHAR_HALF,
  x1: SIZE / 2 + CHAR_HALF,
  y0: Math.max(0, FLOOR_Y * 0.24),
  y1: Math.min(SIZE, FLOOR_Y + 14),
};
const hitTest = (wx, wy) => wx >= HIT_RECT.x0 && wx <= HIT_RECT.x1 && wy >= HIT_RECT.y0 && wy <= HIT_RECT.y1;

function setIgnore(on) {
  if (!win || win.isDestroyed()) return;
  if (on === ignoring) return;
  ignoring = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  log('穿透 →', on);
}

let pollTimer = null;
let dbgTicks = 0;
function startHitPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    if (process.env.PET_DEBUG_CURSOR && dbgTicks < 900 && dbgTicks++ % 60 === 1) {
      const c0 = screen.getCursorScreenPoint();
      const b0 = win.getBounds();
      log('dbg cur=', c0.x, c0.y, 'bounds=', b0.x, b0.y, b0.width, b0.height,
        'vis=', win.isVisible(), 'inside=', hitTest(c0.x - b0.x, c0.y - b0.y), 'ignoring=', ignoring);
    }
    if (dragging) { setIgnore(false); return; }      // 拖拽/甩出期间整窗可点
    if (!win.isVisible()) { setIgnore(true); return; }
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    setIgnore(!hitTest(c.x - b.x, c.y - b.y));
  }, 30);
  log('穿透轮询已启动 hitRect=', JSON.stringify(HIT_RECT));
}

// ────────────────────────────── 窗口 ──────────────────────────────
function createWindow() {
  const b = restoreBounds();
  win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    x: b.x,
    y: b.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setIgnoreMouseEvents(true, { forward: true });
  ignoring = true;

  win.once('ready-to-show', () => {
    win.showInactive();
    log('窗口已显示（不抢焦点）');
    startHitPolling();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
  win.webContents.on('render-process-gone', (_e, d) => log('渲染进程没了', JSON.stringify(d)));
  win.webContents.on('console-message', (e) => {
    const msg = e?.message ?? arguments[2] ?? '';
    if (msg) log('[page]', String(msg).slice(0, 400));
  });

  win.on('move', () => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    writePetState({ left: x, top: y });
  });
  win.on('closed', () => { win = null; });

  win.loadURL('app://pet/electron.html');
}

// ────────────────────────────── 托盘 ──────────────────────────────
function trayImage() {
  const p = fs.existsSync(TRAY_PNG) ? TRAY_PNG : (fs.existsSync(FACE_PNG) ? FACE_PNG : null);
  if (!p) return nativeImage.createEmpty();
  try { return nativeImage.createFromPath(p); } catch (e) { log('托盘图标读失败', e.message); return nativeImage.createEmpty(); }
}

function buildTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('小鲸鱼');
  const menu = Menu.buildFromTemplate([
    { label: '显示小鲸鱼', click: () => { win?.show(); win?.setAlwaysOnTop(true, 'floating'); } },
    { type: 'separator' },
    { label: '藏起来（10 秒）', click: () => { win?.hide(); setTimeout(() => { if (!quitRequested) win?.showInactive(); }, 10000); } },
    { label: '挪到鼠标这边', click: moveToCursor },
    { label: '重载立绘', click: () => { win?.webContents.reload(); } },
    { type: 'separator' },
    { label: '打开日志', click: () => { try { require('electron').shell.openPath(APP_LOG); } catch (_) {} } },
    { label: '退出', click: () => { quitRequested = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => { win?.show(); win?.setAlwaysOnTop(true, 'floating'); });
}

function moveToCursor() {
  if (!win) return;
  const c = screen.getCursorScreenPoint();
  win.setPosition(Math.round(c.x - SIZE / 2), Math.round(c.y - SIZE / 2));
}

// ────────────────────────────── IPC ──────────────────────────────
ipcMain.on('pet:log', (_e, msg) => log('[hud]', String(msg).slice(0, 400)));
ipcMain.on('pet:event', (_e, kind, detail) => {
  // 穿透只由 pet:hit / pet:drag 决定，这里纯记录，避免两套状态互相打架
  if (kind === 'touch' && detail) log('touch', detail.kind ?? '', detail.x ?? '');
  else if (kind === 'mode') log('mode', detail?.mode ?? '');
});

ipcMain.on('pet:hit', (_e, inside) => {
  if (dragging) return; // 拖拽中一直可点
  setIgnore(!inside);
});

ipcMain.on('pet:drag', (_e, on) => {
  dragging = !!on;
  if (dragging) setIgnore(false); // 松手后由 pet:hit 决定，不在这里强行穿透
});

ipcMain.handle('pet:config', () => ({
  ...CONFIG,
  hasToken: fs.existsSync(path.join(STATE_DIR, 'console-token')),
  petState: readPetState(),
}));

ipcMain.handle('pet:pos', (_e, { x, y }) => {
  if (Number.isFinite(x) && Number.isFinite(y)) writePetState({ left: Math.round(x), top: Math.round(y) });
  return { ok: true };
});

ipcMain.handle('pet:action', async (_e, name) => {
  log('action', name);
  switch (name) {
    case 'reload': win?.webContents.reload(); return { ok: true };
    case 'hide': win?.hide(); setTimeout(() => { if (!quitRequested) win?.showInactive(); }, 10000); return { ok: true };
    case 'quit': quitRequested = true; app.quit(); return { ok: true };
    case 'move': moveToCursor(); return { ok: true };
    case 'log': return { ok: true, path: APP_LOG };
    default: return { ok: false, error: 'unknown action: ' + name };
  }
});

ipcMain.handle('pet:send', async () => ({ ok: false, error: 'M3 未接' }));

// ────────────────────────────── 生命周期 ──────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { win?.show(); win?.setAlwaysOnTop(true, 'floating'); });

  app.whenReady().then(() => {
    log('=== 桌宠启动', safeStr({ SIZE, K, FLOOR_Y }));
    registerAppProtocol();
    createWindow();
    buildTray();
    // 调试：把窗口挪到当前光标处，用来验证穿透命中框（PET_DEBUG_CURSOR=1）
    if (process.env.PET_DEBUG_CURSOR) {
      setTimeout(() => { moveToCursor(); log('debug: 窗口已挪到光标处'); }, 3000);
      setTimeout(() => { log('debug: 3s 后状态 ignoring=', ignoring); }, 6000);
    }
  });

  app.on('window-all-closed', () => { quitRequested = true; app.quit(); });
  app.on('before-quit', () => {
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition();
      writePetState({ left: x, top: y });
    }
  });
}

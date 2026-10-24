// 小鲸鱼桌宠 · Electron 主进程
// 窗口/协议/穿透见 M1；桥状态轮询、聊天、右键菜单见 M3。
const {
  app, BrowserWindow, ipcMain, protocol, Menu, Tray, nativeImage, screen, shell, dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, execFile } = require('child_process');

// ────────────────────────────── 常量 ──────────────────────────────
// 仓库根 = 本文件上一级（pet-electron/ 就在仓库根下）。
// 这样 clone / 搬到任何目录都能直接跑，不用改代码；个别位置可以用环境变量覆盖：
//   PET_STATE_DIR / PET_DIARY_DIR / PET_LOG —— 状态、日记、日志目录
//   PET_ONECLICK —— 你自己的「一键启动」脚本；不配就不显示这一项
const REPO_ROOT = path.resolve(__dirname, '..');
const PET_ROOT = path.join(REPO_ROOT, 'assets', 'pet');
const STATE_DIR = process.env.PET_STATE_DIR || path.join(REPO_ROOT, 'state');
const DIARY_DIR = process.env.PET_DIARY_DIR || path.join(REPO_ROOT, 'diary');
const PET_JSON = path.join(STATE_DIR, 'pet.json');
const ACTIVITY_JSON = path.join(STATE_DIR, 'activity.json');
const MOOD_JSON = path.join(STATE_DIR, 'mood.json');
const TOKEN_FILE = path.join(STATE_DIR, 'console-token');
const FACTS_JSON = path.join(STATE_DIR, 'facts.json');
// 用户主动退出时留的标记：pet-guard 看到它就收手，不会把桌宠又拉回来
const QUIT_MARK = path.join(STATE_DIR, 'pet-quit');
const BRIDGE_CFG = path.join(REPO_ROOT, 'config.json');
const TRAY_PNG = path.join(PET_ROOT, 'pet-tray.png');
const FACE_PNG = path.join(PET_ROOT, 'whale', 'tex', 'face.png');
const APP_LOG = process.env.PET_LOG || path.join(REPO_ROOT, 'logs', 'pet-app.log');
const ONECLICK = process.env.PET_ONECLICK || '';

// VIEW = [-12, -8, 268, 272] → 280 x 280。窗口必须是正方形，理由见 桌宠改造-最终方案.md §2
const VIEW = 280;                 // rig view 的边长（正方形）
const FLOOR_RATIO = 264 / 280;    // 地面在 rig y=256，VIEW 顶是 -8
const SIZE_MIN = 260;             // 再小按钮和气泡就挤成一团了
const SIZE_MAX = 760;
const SIZE_STEP = 40;
const SIZE_DEFAULT = 420;
let SIZE = SIZE_DEFAULT;          // 启动时会被 state/pet.json 的 size 覆盖
let K = SIZE / VIEW;
let FLOOR_Y = 264 * K;
const KEY = 'private:1946431105';
const BRIDGE = 'http://127.0.0.1:3100';
const CONFIG = { size: SIZE, k: K, floorY: FLOOR_Y, key: KEY };

// body.js 的 KIT_MOTIONS / KIT_EXPRESSIONS，原样喂给 api.do()
const MOTIONS = [
  ['stand', '站着'], ['jump', '跳一下'], ['hop', '蹦'], ['look', '看看'],
  ['turn', '转身'], ['nod', '点头'], ['shake', '摇头'], ['spin', '转圈'],
  ['sit', '坐下'], ['sleep', '睡觉'], ['dizzy', '晕'], ['walk', '走两步'],
  ['run', '跑'], ['wave', '招手'], ['bow', '鞠躬'], ['shiver', '抖'],
  ['flap', '扑腾'], ['dance', '跳舞'],
];
const FACES = [
  ['happy', '开心'], ['wink', '眨眼'], ['love', '喜欢'], ['surprised', '惊讶'],
  ['angry', '生气'], ['sad', '难过'], ['shy', '害羞'], ['sleepy', '困'],
  ['smug', '得意'], ['worried', '担心'], ['determined', '坚定'], ['flustered', '慌'],
  ['scared', '害怕'], ['excited', '兴奋'], ['cry', '哭'], ['confused', '困惑'],
];

// model.json 里有素材的 scheme（其余 ready:false，选了会加载失败白掉）
const SKINS = [
  { id: 'deepseek-maid', label: '原版蓝' },
  { id: 'sakura-maid', label: '樱粉' },
  { id: 'mint-maid', label: '薄荷' },
  { id: 'night-maid', label: '夜紫' },
];

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
function trimTo(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

process.on('uncaughtException', (e) => writeLog(`[${STAMP()}] !!! uncaught ${(e && e.stack) || e}`));
process.on('unhandledRejection', (e) => writeLog(`[${STAMP()}] !!! rejection ${(e && e.stack) || e}`));

// ────────────────────────────── 状态 ──────────────────────────────
let win = null, tray = null;
let ignoring = true; // 当前是否穿透
let dragging = false;
let chatOpen = false;   // 桌面聊天框开着时不要主动插嘴
let quitRequested = false;
let uiRects = [];    // 渲染进程上报的、需要吃鼠标的 UI 矩形
let consoleToken = '';
let bridgeState = null;

function readPetState() {
  try { return JSON.parse(fs.readFileSync(PET_JSON, 'utf8')); } catch (_) { return {}; }
}
function writePetState(patch) {
  try {
    const cur = readPetState();
    fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(path.dirname(APP_LOG), { recursive: true });
    fs.writeFileSync(PET_JSON, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8');
  } catch (e) { log('写 pet.json 失败', e.message); }
}

/** 位置落在某块屏幕的工作区内才用，否则丢到主屏右下角。判定按「角色本人」算，
 *  和拖拽时的夹取同一套边界（窗口可以出屏，她不能出屏）。 */
function restoreBounds() {
  const st = readPetState();
  const x = Number(st.left), y = Number(st.top);
  const w = screen.getPrimaryDisplay().workArea;
  if (Number.isFinite(x) && Number.isFinite(y)) {
    // 只要跟某块屏幕有交集就认，然后夹进工作区；差几像素不算「跑丢了」
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x + SIZE > a.x && x < a.x + a.width && y + SIZE > a.y && y < a.y + a.height;
    });
    if (visible) {
      const cx = Math.max(w.x - HIT_RECT.x0, Math.min(x, w.x + w.width - HIT_RECT.x1));
      const cy = Math.max(w.y - HIT_RECT.y0, Math.min(y, w.y + w.height - HIT_RECT.y1));
      return { x: Math.round(cx), y: Math.round(cy) };
    }
    log('位置完全在屏幕外，回落默认', x, y);
  }
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
/** 命中区按「角色本体」算；改尺寸后必须跟着重算 */
function makeHitRect() {
  const half = Math.min(112 * K, SIZE * 0.44);
  return {
    x0: SIZE / 2 - half,
    x1: SIZE / 2 + half,
    y0: Math.max(0, FLOOR_Y * 0.24),
    y1: Math.min(SIZE, FLOOR_Y + 14),
  };
}
let HIT_RECT = makeHitRect();

const clampSize = (n) => Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(n)));

/** 只改尺寸变量（不碰窗口）—— createWindow 之前先用它把 size 从 pet.json 读进来 */
function setSizeVars(n) {
  SIZE = clampSize(n);
  K = SIZE / VIEW;
  FLOOR_Y = FLOOR_RATIO * SIZE;
  HIT_RECT = makeHitRect();
  CONFIG.size = SIZE; CONFIG.k = K; CONFIG.floorY = FLOOR_Y;
}

/** 改大小：以「脚底中心」为锚点，她站的位置不跳；同时通知渲染进程重算 bounds */
function applySize(n, opts = {}) {
  const want = clampSize(n);
  if (want === SIZE) return false;
  const old = SIZE;
  const b = win && !win.isDestroyed() ? win.getBounds() : null;
  setSizeVars(want);
  if (b && opts.keepAnchor !== false) {
    const cx = b.x + old / 2;
    const cy = b.y + old * FLOOR_RATIO;
    let nx = Math.round(cx - SIZE / 2);
    let ny = Math.round(cy - SIZE * FLOOR_RATIO);
    // 放大最容易把窗口顶出屏幕：整窗夹进 workArea（先保脚底，再保头顶）
    const wa = screen.getDisplayMatching({ x: nx, y: ny, width: SIZE, height: SIZE }).workArea;
    ny = Math.max(wa.y, Math.min(ny, wa.y + wa.height - SIZE));
    nx = Math.max(wa.x, Math.min(nx, wa.x + wa.width - SIZE));
    win.setBounds({ x: nx, y: ny, width: SIZE, height: SIZE });
  }
  if (opts.persist !== false) writePetState({ size: SIZE });
  if (win && !win.isDestroyed()) win.webContents.send('pet:config', CONFIG);
  log('尺寸 →', SIZE, 'K=' + K.toFixed(3), 'floorY=' + Math.round(FLOOR_Y));
  return true;
}

const inRect = (r, x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
const hitTest = (wx, wy) => inRect(HIT_RECT, wx, wy) || uiRects.some((r) => inRect(r, wx, wy));

function setIgnore(on) {
  if (!win || win.isDestroyed()) return;
  if (on === ignoring) return;
  ignoring = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  log('穿透 →', on);
}

let pollTimer = null;
let dbgTicks = 0;
let hoverIn = null;   // 光标是否在窗口附近（决定三颗按钮显不显形）
let winDrag = null;   // 拖整窗时的抓取偏移 {dx,dy}

const HOVER_PAD = 26; // 「附近」= 窗口边缘再往外扩这么多像素

function startHitPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();

    // 抓着立绘拖 = 搬整个窗口，所以拖的时候窗口跟着光标跑
    if (winDrag) {
      const rawX = Math.round(c.x - winDrag.dx);
      const rawY = Math.round(c.y - winDrag.dy);
      // 按「角色矩形」夹住：窗口可以出去一点，但她本人不能出屏
      const wa = screen.getDisplayMatching({ x: rawX, y: rawY, width: SIZE, height: SIZE }).workArea;
      const minX = wa.x - HIT_RECT.x0;
      const maxX = wa.x + wa.width - HIT_RECT.x1;
      const minY = wa.y - HIT_RECT.y0;
      const maxY = wa.y + wa.height - HIT_RECT.y1;
      const wx = Math.min(Math.max(rawX, minX), Math.max(minX, maxX));
      const wy = Math.min(Math.max(rawY, minY), Math.max(minY, maxY));
      win.setPosition(wx, wy);
      setIgnore(false);
      return;
    }

    if (process.env.PET_DEBUG_CURSOR && dbgTicks < 900 && dbgTicks++ % 60 === 1) {
      log('dbg cur=', c.x, c.y, 'bounds=', b.x, b.y, b.width, b.height,
        'vis=', win.isVisible(), 'inside=', hitTest(c.x - b.x, c.y - b.y), 'ignoring=', ignoring);
    }
    if (!win.isVisible()) {
      if (hoverIn !== false) { hoverIn = false; send('pet:hover', false); }
      setIgnore(true);
      return;
    }

    const lx = c.x - b.x, ly = c.y - b.y;
    const near = lx > -HOVER_PAD && ly > -HOVER_PAD && lx < b.width + HOVER_PAD && ly < b.height + HOVER_PAD;
    if (near !== hoverIn) {
      const wasIn = hoverIn;
      hoverIn = near;
      send('pet:hover', near);
      // 只有「本来在窗口里、现在走了」才收聊天框；从托盘叫出来的那一刻不算
      if (!near && wasIn === true) send('pet:ui', { t: 'blur' });
      log('悬停 →', near);
    }

    if (dragging) { setIgnore(false); return; }      // body 内部拖拽/甩出期间整窗可点
    setIgnore(!hitTest(lx, ly));
  }, 30);
  log('穿透轮询已启动 hitRect=', safeStr(HIT_RECT));
}

function send(ch, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); } catch (_) {}
}

// ────────────────────────── 主动开口 ──────────────────────────
// 没人理她的时候，隔几分钟自己在气泡里说一句。内容优先用她真实的状态
// （正在干嘛 / 今天日记的正文 / 长期记忆），都不合适才退回按时段和心情的台词库。
let lastSpeakAt = 0;
let nextSpeakGap = 0;
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick1 = (arr) => arr[randInt(0, arr.length - 1)];

const SPEAK_TIME = {
  dawn: [['都这个点了，还不睡？', 'sleepy'], ['熬夜会变丑的，我说真的', 'worried'], ['我有点困了…', 'sleepy'], ['夜里安静得有点吓人', 'scared']],
  morn: [['早啊，今天想干嘛', 'happy'], ['你一早上都没理我', 'sad'], ['早上好，清醒了没', 'happy'], ['外面天气怎么样', 'confused']],
  noon: [['你吃饭了没', 'worried'], ['下午最容易犯困', 'sleepy'], ['在忙吗', 'confused'], ['脖子酸不酸，起来走两步', 'smug']],
  eve: [['晚上好呀', 'happy'], ['今天过得怎么样', 'happy'], ['闲下来了没', 'excited'], ['晚上该放松一下了', 'wink']],
};
const SPEAK_MOOD = {
  happy: [['今天心情不错', 'happy'], ['想跟你说句话', 'love'], ['嘿嘿', 'wink']],
  tired: [['有点累…', 'sleepy'], ['不想动', 'sleepy']],
  sad: [['有点闷', 'sad'], ['陪我说会儿话吧', 'sad']],
  calm: [['我就安静待着', 'stand']],
  angry: [['哼', 'angry']],
};

function todayDiaryLine() {
  try {
    const d = new Date();
    const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.md`;
    const txt = fs.readFileSync(path.join(DIARY_DIR, name), 'utf8');
    const lines = txt.split(/\r?\n/).map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#') && !s.startsWith('---') && !s.startsWith('>') && !/^\d{1,2}:\d{2}/.test(s));
    // 挑一句完整的、长短合适的正文
    const cand = lines.filter((s) => s.length >= 8 && s.length <= 46);
    if (!cand.length) return '';
    let s = cand[0];
    if (/[，,。！？!?]$/.test(s)) s = s.replace(/[，,。！？!?]+$/, '');
    return s;
  } catch (_) { return ''; }
}

function randomFactText() {
  try {
    const j = JSON.parse(fs.readFileSync(FACTS_JSON, 'utf8'));
    const arr = (j.facts || []).filter((f) => f && f.tier === 'long' && typeof f.text === 'string'
      && f.text.length >= 4 && f.text.length <= 36);
    return arr.length ? pick1(arr).text : '';
  } catch (_) { return ''; }
}

function pickProactive() {
  const st = bridgeState || {};
  const real = [];

  const doing = String(st.doing || '').trim();
  if (doing && doing.length <= 22 && !/^(刷|看|发呆)[，,]/.test(doing)) {
    real.push([`我在${doing}呢`, 'happy']);
    real.push([`刚还在${doing}，被打断了`, 'smug']);
  }
  const plan = String(st.plan || '').trim();
  if (plan && plan.length <= 22) real.push([`待会想去${plan}`, 'excited']);

  const dia = todayDiaryLine();
  if (dia) real.push([dia, 'shy'], [`今天记了句话：${dia}`, 'shy']);

  const fact = randomFactText();
  if (fact) real.push([`你还记得吗，${fact}`, 'love']);

  if (real.length && Math.random() < 0.55) return toSpeak(pick1(real));

  const h = new Date().getHours();
  const bucket = (h >= 23 || h < 6) ? 'dawn' : h < 11 ? 'morn' : h < 18 ? 'noon' : 'eve';
  const pool = [...SPEAK_TIME[bucket]];
  for (const line of (SPEAK_MOOD[String(st.mood || '').toLowerCase()] || [])) pool.push(line);
  for (const line of real) pool.push(line);
  if (!pool.length) return null;
  return toSpeak(pick1(pool));
}

function toSpeak(pair) {
  if (!pair) return null;
  const face = pair[1] || 'happy';
  // stand 不是表情，交给 do() 也只会站着，无害
  return { text: pair[0], face };
}

function startProactive() {
  const envGap = Number(process.env.PET_SPEAK_GAP) * 1000;   // 调试用：PET_SPEAK_GAP=10 → 10 秒后先说一句
  nextSpeakGap = Number.isFinite(envGap) && envGap > 0 ? envGap : randInt(120, 300) * 1000;
  setInterval(() => {
    try {
      if (quitRequested || !win || win.isDestroyed() || !win.isVisible()) return;
      if (winDrag || dragging) return;                    // 正在搬她，别插嘴
      if (chatOpen) return;                               // 正在跟她打字，别插嘴
      if (Date.now() - lastSpeakAt < nextSpeakGap) return;
      const p = pickProactive();
      if (!p) return;
      lastSpeakAt = Date.now();
      nextSpeakGap = randInt(150, 420) * 1000;
      send('pet:ui', { t: 'bubble', text: p.text, ms: 18000 });
      if (p.face) send('pet:ui', { t: 'do', word: p.face });
      log('主动开口:', p.text);
    } catch (e) { log('主动开口失败', e.message); }
  }, 15000);
  log('主动开口已启动，第一条', Math.round(nextSpeakGap / 1000), '秒内');
}

// ────────────────────────────── 窗口 ──────────────────────────────
function createWindow() {
  const st = readPetState();
  if (Number.isFinite(Number(st.size)) && Number(st.size) > 0) setSizeVars(Number(st.size));
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
    startProactive();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
  win.webContents.on('render-process-gone', (_e, d) => log('渲染进程没了', safeStr(d)));
  win.webContents.on('console-message', (e) => {
    const msg = e?.message ?? '';
    if (msg && !/Security Warning/.test(msg)) log('[page]', String(msg).slice(0, 400));
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
  tray.setToolTip('小鲸鱼（右键我，随时叫她出来）');
  const menu = Menu.buildFromTemplate([
    { label: '显示小鲸鱼', click: () => showPet() },
    { label: '跟她说句话', click: () => openChat() },
    { type: 'separator' },
    { label: '藏起来（要她出现就右键这里）', click: () => hideForGood() },
    { type: 'separator' },
    { label: '打开日志', click: () => openPath(APP_LOG) },
    { label: '退出', click: () => { quitRequested = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => showPet());
  tray.on('click', () => showPet());
}

function showPet() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(hideTimer);
  if (!win.isVisible()) win.show();
  hoverIn = null; // 强制下一轮重推悬停，按钮才会浮出来
}
function moveToCursor() {
  if (!win || win.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  win.setPosition(Math.round(c.x - SIZE / 2), Math.round(c.y - SIZE / 2));
}
let hideTimer = null;
function hideForGood() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(hideTimer);
  win.hide();
  log('藏进托盘（托盘右键 → 显示小鲸鱼）');
}
function openChat() { showPet(); win?.webContents.send('pet:ui', { t: 'chat' }); }
function openPath(p) { try { shell.openPath(p); } catch (e) { log('openPath 失败', p, e.message); } }

// 「看一件东西」走内置窗口，不交给系统文件关联（这台机器 .md/.json 默认被 Visual Studio 抢走了）
let previewWin = null;
function openPreview(file, title, kind) {
  const qs = 'file=' + encodeURIComponent(file) + (kind ? '&kind=' + encodeURIComponent(kind) : '');
  const url = 'app://pet/preview.html?' + qs;
  try {
    if (previewWin && !previewWin.isDestroyed()) {
      previewWin.loadURL(url);
      if (title) previewWin.setTitle(title);
      previewWin.show();
      previewWin.focus();
      return;
    }
    previewWin = new BrowserWindow({
      width: 780, height: 800, minWidth: 520, minHeight: 420,
      title: title || '小鲸鱼', backgroundColor: '#1b1f2a', autoHideMenuBar: true, show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    });
    previewWin.loadURL(url);
    previewWin.webContents.on('did-fail-load', (_e, code, desc, u) => log('预览加载失败', code, desc, u));
    previewWin.webContents.on('did-finish-load', () => log('预览已加载', file));
    previewWin.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) log('[预览]', msg); });
    const showIt = () => { if (previewWin && !previewWin.isDestroyed()) { previewWin.show(); previewWin.focus(); } };
    previewWin.once('ready-to-show', showIt);
    previewWin.webContents.once('did-finish-load', showIt);
    previewWin.on('closed', () => { previewWin = null; });
  } catch (e) { log('openPreview 失败', file, e.message); }
}

// 想用外部程序看的时候走记事本，别落到 IDE 上
function openText(p) {
  try {
    if (!p || !fs.existsSync(p)) { log('openText 文件不存在', String(p)); return; }
    spawn('notepad.exe', [p], { detached: true, stdio: 'ignore' }).unref();
    log('用记事本打开', p);
  } catch (e) { log('openText 失败', e.message); }
}

function todayDiary() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return path.join(DIARY_DIR, `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.md`);
}

// ────────────────────────────── 桥 ──────────────────────────────
function readToken() {
  try { consoleToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) {}
  if (!consoleToken) {
    try { consoleToken = String(JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8')).consoleToken || '').trim(); } catch (_) {}
  }
  log('token', consoleToken ? '已读到(' + consoleToken.slice(0, 6) + '…)' : '没读到');
}

async function getJson(p, opt) {
  const r = await fetch(BRIDGE + p, {
    ...(opt || {}),
    signal: AbortSignal.timeout(3500),
    headers: { 'x-console-token': consoleToken, ...((opt && opt.headers) || {}) },
  });
  return r.json();
}
async function postJson(p, body) {
  return getJson(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function probePort(port, timeout = 400) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(timeout, () => fin(false));
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
  });
}

const p2 = (n) => String(n).padStart(2, '0');
function clock(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function markQuit() {
  try { fs.writeFileSync(QUIT_MARK, String(Date.now())); } catch (_) {}
}
function clearQuit() {
  try { fs.unlinkSync(QUIT_MARK); } catch (_) {}
}

let pollRound = 0;
let pollBusy = false;
async function pollBridge() {
  const s = {
    at: Date.now(), paused: null, mood: '', affinity: null,
    doing: '', note: '', plan: '', activityAt: 0,
    lastLine: '', lastLineAt: 0,
    links: (bridgeState && bridgeState.links) || { sluma: null, web: null, bridge: null },
  };

  try {
    const a = JSON.parse(fs.readFileSync(ACTIVITY_JSON, 'utf8'));
    s.doing = String(a.doing || '');
    s.note = String(a.note || '');
    s.plan = String(a.plan || '');
    s.activityAt = Date.parse(a.updatedAt || a.since || '') || 0;
  } catch (_) {}
  try {
    const m = JSON.parse(fs.readFileSync(MOOD_JSON, 'utf8'));
    s.mood = String(m.mood || '');
    s.affinity = typeof m.affinity === 'number' ? m.affinity : null;
  } catch (_) {}

  try {
    const r = await getJson(`/api/socialV2/my-recent?key=${encodeURIComponent(KEY)}&limit=3`);
    if (r && r.ok) {
      if (typeof r.paused === 'boolean') s.paused = r.paused;
      const ms = Array.isArray(r.messages) ? r.messages : [];
      const last = ms[ms.length - 1];
      if (last) {
        s.lastLine = String(last.plain || last.text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        s.lastLineAt = Number(last.time) || 0;
      }
    }
  } catch (_) {}
  // 端口 9 秒探一次就够
  if (pollRound++ % 3 === 0) {
    const [sluma, web, br] = await Promise.all([probePort(3000), probePort(3080), probePort(3100)]);
    s.links = { sluma, web, bridge: br };
  }

  const prev = bridgeState;
  bridgeState = s;
  const changed = !prev || safeStr(prev) !== safeStr(s);
  if (changed && win && !win.isDestroyed()) win.webContents.send('pet:state', s);
}

let bridgeTimer = null;
function startBridgePolling() {
  if (bridgeTimer) return;
  readToken();
  pollBridge().catch((e) => log('首次轮询失败', e.message));
  // 防重入：桥卡住时上一次还没回来就别再发，免得请求越堆越多
  bridgeTimer = setInterval(() => {
    if (pollBusy) return;
    pollBusy = true;
    pollBridge()
      .catch((e) => log('轮询失败', e.message))
      .finally(() => { pollBusy = false; });
  }, 2000);
  log('桥轮询已启动（2s）');
}

// ────────────────────────────── 右键菜单（五组）──────────────────────────────
function subItems(list) {
  return list.map(([word, name]) => ({ label: name, click: () => win?.webContents.send('pet:ui', { t: 'do', word }) }));
}

function popupMenu() {
  if (!win) return;
  const st = bridgeState || {};
  const tpl = [
    { label: '跟她说句话…', click: () => openChat() },
    { type: 'separator' },
    {
      label: '她',
      submenu: [
        { label: st.doing ? `她在干嘛：${trimTo(st.doing, 12)}` : '她在干嘛', click: showActivity },
        { label: '今天的日记', click: () => openPreview(todayDiary(), '今天的日记', 'diary') },
        { label: '长期记忆', click: () => openPreview(FACTS_JSON, '长期记忆', 'facts') },
        { type: 'separator' },
        { label: '让她去玩会儿手机', click: () => wakeHer('interval') },
        { label: st.paused ? '恢复她的自主时间' : '暂停她的自主时间', click: () => togglePause() },
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
        { label: '藏起来（托盘里叫她出来）', click: () => hideForGood() },
      ],
    },
    {
      label: 'QQ 链路',
      submenu: [
        { label: '看链路状态', click: showLinkStatus },
        ...(ONECLICK ? [{ label: '一键修复 · 启动', click: runOneClick }] : []),
        { label: '打开桥控制台', click: () => openPath(`${BRIDGE}/?token=${encodeURIComponent(consoleToken)}`) },
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
        { label: '退出', click: () => { quitRequested = true; app.quit(); } },
      ],
    },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

function showActivity() {
  const st = bridgeState || {};
  let line;
  if (st.doing) {
    line = trimTo(st.doing, 22);
    // 气泡最多两行，doing + 计划拼起来控制在 34 字内，超了只留 doing
    const plan = trimTo(String(st.plan || '').replace(/^[，,。；;\s]+/, ''), 12);
    if (plan && plan !== line) {
      const cand = line + '，等会儿' + plan;
      if (cand.length <= 34) line = cand;
    }
  } else {
    line = '没记着在干嘛，大概在发呆';
  }
  const d = st.doing || '';
  const face = /睡|困|歇|躺/.test(d) ? 'sleepy'
    : /刷|玩|游戏|看|听/.test(d) ? 'happy'
      : /写|学|想|研/.test(d) ? 'determined' : 'smug';
  send('pet:ui', { t: 'do', word: face });
  send('pet:ui', { t: 'bubble', text: line, ms: 22000 });
  log('她在干嘛 →', line);
  return line;
}

function showActivityBox() {
  const st = bridgeState || {};
  const lines = [
    `在干嘛：${st.doing || '（没记）'}`,
    `心里想：${st.note || '—'}`,
    `接下来：${st.plan || '—'}`,
    '',
    `更新时间：${clock(st.activityAt) || '—'}`,
    `心情：${st.mood || '—'}　亲密：${st.affinity ?? '—'}`,
    `她最后说：${st.lastLine || '—'}`,
  ];
  dialog.showMessageBox({ type: 'info', title: '她', message: '她现在这样', detail: lines.join('\n'), buttons: ['知道了'] });
}

// ── MuMu 虚拟机状态 ───────────────────────────────────────────────────────────
// 不能用"MuMuNxMain.exe 在不在"判断：那个只是管理器窗口，实例没启动它照样在跑。
// 官方 CLI 的 `info -v 0` 才有 is_process_started / is_android_started。
function findMuMuCli() {
  if (process.env.PET_MUMU_CLI) return process.env.PET_MUMU_CLI;
  const cands = [
    'F:\\Program Files\\Netease\\MuMu\\nx_main\\MuMuManager.exe',
    'C:\\Program Files\\Netease\\MuMu\\nx_main\\MuMuManager.exe',
    'D:\\Program Files\\Netease\\MuMu\\nx_main\\MuMuManager.exe',
    'E:\\Program Files\\Netease\\MuMu\\nx_main\\MuMuManager.exe',
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return '';
}

function readMuMuInfo() {
  const cli = findMuMuCli();
  if (!cli) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(cli, ['info', '-v', '0'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const j = JSON.parse(String(stdout).trim());
          resolve({
            started: j.is_android_started === true,
            running: j.is_process_started === true,
            name: j.name || '',
          });
        } catch (_) { resolve(null); }
      });
    } catch (_) { resolve(null); }
  });
}

async function showLinkStatus() {
  const l = (bridgeState && bridgeState.links) || {};
  const mark = (v) => (v === true ? '✅' : v === false ? '❌' : '…');
  const [mumu, adb] = await Promise.all([readMuMuInfo(), probePort(16384)]);
  const muLine = mumu
    ? `MuMu 实例${mumu.name ? `「${mumu.name}」` : ''}  ${mumu.started ? '✅ 安卓已启动' : mumu.running ? '⚠️ 进程在，安卓没起来' : '❌ 没启动'}`
    : 'MuMu 实例  … 找不到 MuMuManager.exe（可设环境变量 PET_MUMU_CLI）';
  const adbLine = `adb 16384  ${mark(adb)}`;
  // 她能不能操控手机 = MuMu 安卓真的起来了 + adb 通
  const canControl = mumu ? (mumu.started === true && adb === true) : adb === true;
  const whyNot = !mumu
    ? '没装 MuMu / 路径不对'
    : !mumu.started
      ? 'MuMu 实例没启动'
      : adb !== true
        ? 'adb 没连上 127.0.0.1:16384'
        : '';
  const lines = [
    `SnowLuma 3000  ${mark(l.sluma)}`,
    `dsh web 3080    ${mark(l.web)}`,
    `qq-bridge 3100  ${mark(l.bridge)}`,
    muLine,
    adbLine,
    '',
    canControl ? '她能不能操控手机：✅ 能' : `她能不能操控手机：❌ 不能（${whyNot}）`,
  ];
  dialog.showMessageBox({
    type: canControl ? 'info' : 'warning',
    title: 'QQ 链路',
    message: canControl ? '现在的链路' : '链路有环节没起来',
    detail: lines.join('\n'),
    buttons: ['知道了'],
  });
}

async function wakeHer(reason) {
  try {
    const r = await postJson('/api/socialV2/wake', { key: KEY, reason });
    log('唤醒', reason, safeStr(r));
    if (r && r.ok) win?.webContents.send('pet:ui', { t: 'bubble', text: '（她自己去忙了…）' });
    return r;
  } catch (e) { log('唤醒失败', e.message); return { ok: false, error: e.message }; }
}

async function togglePause() {
  const next = !(bridgeState && bridgeState.paused);
  try {
    await postJson('/api/socialV2/activity', { paused: next });
    log('暂停切换 →', next);
    pollBridge().catch(() => {});
  } catch (e) { log('暂停切换失败', e.message); }
}

function runOneClick() {
  if (!ONECLICK || !fs.existsSync(ONECLICK)) {
    log('一键启动脚本没配置（PET_ONECLICK）');
    if (win && !win.isDestroyed()) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: '没配一键启动',
        message: '没有配置一键启动脚本',
        detail: '设置环境变量 PET_ONECLICK 指向你自己的启动脚本（例如 C:\\your\\一键启动.ps1），重启桌宠后这一项才会出现。',
      }).catch(() => {});
    }
    return;
  }
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ONECLICK, '-Quiet',
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log('已拉起一键启动.ps1 -Quiet');
  } catch (e) { log('一键启动失败', e.message); }
}

// ────────────────────────────── IPC ──────────────────────────────
ipcMain.on('pet:log', (_e, msg) => log('[hud]', String(msg).slice(0, 400)));
ipcMain.on('pet:event', (_e, kind, detail) => {
  // 穿透只由 pet:hit / pet:drag / 光标轮询决定，这里纯记录，避免两套状态互相打架
  if (kind === 'touch' && detail) log('touch', detail.kind ?? '', detail.x ?? '');
  else if (kind === 'chatOpen') { chatOpen = !!detail; return; }
  else if (kind === 'mode') log('mode', detail?.mode ?? '');
});

ipcMain.on('pet:hit', (_e, inside) => {
  if (dragging) return; // 拖拽中一直可点
  setIgnore(!inside);
});

ipcMain.on('pet:drag', (_e, on) => {
  dragging = !!on;
  if (dragging) setIgnore(false); // 松手后由命中判定决定，不在这里强行穿透
});

// 拖整窗：渲染进程按下立绘 → 这里记下「光标相对窗口左上角」的偏移，轮询里每 30ms 跟一次
ipcMain.on('pet:win-drag-start', () => {
  if (!win || win.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  winDrag = { dx: c.x - b.x, dy: c.y - b.y };
  setIgnore(false);
  log('拖窗开始 offset=', safeStr(winDrag));
});

ipcMain.on('pet:win-drag-end', () => {
  if (!win || win.isDestroyed() || !winDrag) { winDrag = null; return; }
  winDrag = null;
  // 别把窗口扔到屏幕外面去（拖太远、拔显示器、改分辨率都会出现这种情况）
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const visible =
    b.x < wa.x + wa.width - 40 && b.x + b.width > wa.x + 40 &&
    b.y < wa.y + wa.height - 60 && b.y + b.height > wa.y + 40;
  if (!visible) {
    win.setPosition(Math.round(wa.x + wa.width - SIZE - 24), Math.round(wa.y + wa.height - SIZE - 8));
    log('位置落在屏幕外，拉回右下角');
  }
  const nb = win.getBounds();
  writePetState({ left: nb.x, top: nb.y });
  hoverIn = null; // 强制下一轮重推 hover
  log('拖窗结束', nb.x, nb.y);
});

ipcMain.on('pet:ui-rects', (_e, rects) => {
  uiRects = (Array.isArray(rects) ? rects : [])
    .filter((r) => r && Number.isFinite(r.x0) && Number.isFinite(r.y0) && Number.isFinite(r.x1) && Number.isFinite(r.y1))
    .slice(0, 8);
});

ipcMain.handle('pet:read-text', (_e, p) => {
  try {
    const abs = path.resolve(String(p || ''));
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: '不是一个文件' };
    if (st.size > 2 * 1024 * 1024) return { ok: false, error: '文件太大 ' + (st.size / 1048576).toFixed(1) + 'MB' };
    return { ok: true, path: abs, name: path.basename(abs), bytes: st.size, text: fs.readFileSync(abs, 'utf8') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pet:config', () => ({
  ...CONFIG,
  hasToken: fs.existsSync(TOKEN_FILE),
  petState: readPetState(),
}));

// 渲染进程滚轮 / 菜单都能调大小；delta 是「几档」，size 是绝对值
ipcMain.on('pet:resize', (_e, arg) => {
  const o = arg || {};
  if (Number.isFinite(o.size) && o.size > 0) applySize(o.size);
  else if (Number.isFinite(o.delta) && o.delta !== 0) applySize(SIZE + o.delta * SIZE_STEP);
});

ipcMain.handle('pet:pos', (_e, { x, y }) => {
  if (Number.isFinite(x) && Number.isFinite(y)) writePetState({ left: Math.round(x), top: Math.round(y) });
  return { ok: true };
});

ipcMain.handle('pet:send', async (_e, text) => {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: '空的' };
  if (t.length > 500) return { ok: false, error: '太长了（最多 500 字）' };
  try {
    const r = await postJson('/api/socialV2/desk-message', { key: KEY, text: t });
    if (r && r.ok) {
      log('desk-message 已投递：', t.slice(0, 40));
      pollBridge().catch(() => {});
      return { ok: true, firstWake: !!r.firstWake };
    }
    log('desk-message 失败', safeStr(r));
    return { ok: false, error: (r && r.error) || '桥返回异常' };
  } catch (e) {
    log('desk-message 异常', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pet:action', async (_e, name, arg) => {
  switch (name) {
    case 'menu': popupMenu(); return { ok: true };
    case 'reload': win?.webContents.reload(); return { ok: true };
    case 'hide': hideForGood(); return { ok: true };
    case 'quit': quitRequested = true; app.quit(); return { ok: true };
    case 'move': moveToCursor(); return { ok: true };
    case 'wake': return await wakeHer(typeof arg === 'string' ? arg : 'interval');
    case 'state': return { ok: true, state: bridgeState };
    case 'speak': {
      const p = pickProactive();
      if (!p) return { ok: false, error: '没有可说的' };
      lastSpeakAt = Date.now();
      nextSpeakGap = randInt(150, 420) * 1000;
      send('pet:ui', { t: 'bubble', text: p.text, ms: 18000 });
      if (p.face) send('pet:ui', { t: 'do', word: p.face });
      log('手动开口:', p.text);
      return { ok: true, text: p.text, face: p.face };
    }
    case 'openText': openText(typeof arg === 'string' ? arg : ''); return { ok: true };
    case 'openPreview': {
      const f = arg && arg.file;
      if (typeof f !== 'string' || !f) return { ok: false, error: 'no file' };
      openPreview(f, arg.title, arg.kind);
      return { ok: true };
    }
    case 'scheme':
      if (typeof arg === 'string') {
        writePetState({ skin: arg });
        send('pet:ui', { t: 'scheme', id: arg });
        log('换样子 →', arg);
      }
      return { ok: true, skin: arg };
    case 'log': return { ok: true, path: APP_LOG };
    default: log('未知 action', name); return { ok: false, error: 'unknown action: ' + name };
  }
});

// ────────────────────────────── 生命周期 ──────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showPet());

  app.whenReady().then(() => {
    clearQuit();
    log('=== 桌宠启动', safeStr({ SIZE, K, FLOOR_Y }));
    registerAppProtocol();
    createWindow();
    buildTray();
    startBridgePolling();
    if (process.env.PET_DEBUG_CURSOR) {
      setTimeout(() => { moveToCursor(); log('debug: 窗口已挪到光标处'); }, 3000);
    }
    if (process.env.PET_TEST_ACT === 'activity') {
      setTimeout(() => { log('debug: 试一次「她在干嘛」'); showActivity(); }, 4000);
    }
    if (process.env.PET_TEST_PREVIEW) {
      // 调试用：验证内置预览窗（diary=日记 / facts=长期记忆）
      setTimeout(() => {
        if (process.env.PET_TEST_PREVIEW === 'facts') {
          log('debug: 打开长期记忆预览');
          openPreview(FACTS_JSON, '长期记忆', 'facts');
        } else {
          log('debug: 打开日记预览');
          openPreview(todayDiary(), '今天的日记', 'diary');
        }
      }, 5000);
    }
    if (process.env.PET_TEST_SCHEME) {
      // 调试用：验证运行时换配色这条路（菜单走的是同一个 pet:ui scheme）
      setTimeout(() => {
        log('测试换样子 →', process.env.PET_TEST_SCHEME);
        send('pet:ui', { t: 'scheme', id: process.env.PET_TEST_SCHEME });
      }, 6000);
    }
  });

  app.on('window-all-closed', () => { quitRequested = true; app.quit(); });
  app.on('before-quit', () => {
    markQuit();
    quitRequested = true;
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition();
      writePetState({ left: x, top: y });
    }
  });
}

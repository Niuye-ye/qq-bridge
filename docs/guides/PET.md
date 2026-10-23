# 桌面宠物（小鲸鱼）

把 QQ 里那个 agent 变成桌面上的活物：一个透明、无边框、置顶的小窗口，里面是拆件伪骨骼动画的立绘。
点她会动，能拖到屏幕任意角落，会自己说话，也能在桌面直接跟她聊天。

> 渲染器来自 [Coopanion](https://github.com/) 的 `web/`（`kit/rig.js` + `kit/body.js` + `whale/figure.js`），
> 原封不动照搬；窗口壳、穿透、聊天、菜单、气泡是这边写的。

```
pet-electron/            Electron 主进程（main.js / preload.js）
assets/pet/
  electron.html          窗口里的那页（渲染 + UI）
  preview.html           日记/长期记忆的预览窗
  kit/                   rig.js（拆件合成） + body.js（动作状态机）
  whale/                 figure.js + model.json + tex/ + feat/ + schemes/
  pet-tray.png           托盘图标
```

---

## 一、能干什么

| 交互 | 效果 |
| --- | --- |
| 左键拖 | 整个窗口跟着走（角色本人永远留一块在屏幕里） |
| 单击 | 摸一下，按心情换台词 |
| 双击 | 开聊天框 |
| 滚轮/悬停 | 鼠标靠近才冒出左上三颗钮：打 / 摸 / 玩 |
| 右键 | 五组菜单：跟她说句话、她、样子、QQ 链路、系统 |
| 托盘 | 显示/隐藏、说话、链路状态、一键修复、退出；左键单击叫回来 |

自己会做的事：站着呼吸、走路、坐下、睡着、四处看、伸懒腰、打哈欠；
隔几分钟冒一句话（优先说她正在干的事 / 日记里的句子 / 长期记忆），不说话的时候气泡是收起的。

**打游戏**：独占全屏时桌宠不会被看到；无边框窗口化会浮在上面，右键「系统 → 总在最前」关掉即可。

---

## 二、前置条件

- Windows 10/11
- Node.js ≥ 18
- 可选：本仓库的 bridge（3100）在跑 —— 不在跑桌宠也能活，只是没有台词、链路点全灰

---

## 三、安装

```bash
cd pet-electron
npm install
```

`package.json` 里 `electron: ^45.0.0`。**npm 装完 `node_modules/electron/dist/` 可能是空的**
（上游下载被墙/超时，但 install 仍然报成功），这时启动会找不到 `electron.exe`，补一刀：

```bash
# Windows PowerShell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_CUSTOM_DIR='v45.0.0'
node node_modules\electron\install.js
# 看到 exit=0 且 node_modules\electron\dist\electron.exe 存在就对了
```

---

## 四、启动

**先记住一件事：本机的 `ELECTRON_RUN_AS_NODE` 如果被设成 1，electron.exe 会当纯 node 跑**，
`require('electron').protocol` 是 undefined，一上来就
`TypeError: Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`。
启动脚本必须清空它。

`bin/run-pet-electron.bat`（放你的启动目录，路径按自己情况改）：

```bat
@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set ELECTRON_RUN_AS_NODE=
rem 清掉「用户主动退出」的标记，否则守护会以为你不想开
if exist "D:\path\to\repo\state\pet-quit" del /q "D:\path\to\repo\state\pet-quit"
cd /d "D:\path\to\repo\pet-electron"
start "" /b "D:\path\to\repo\pet-electron\node_modules\electron\dist\electron.exe" "D:\path\to\repo\pet-electron" >nul 2>&1
```

配一个 `run-pet-electron.vbs`（**必须纯 ASCII**，wscript 按 ANSI 读，中文注释会报「对象 'sh' 缺失」）：

```vbscript
Set sh = CreateObject("WScript.Shell")
sh.Run "D:\path\to\bin\run-pet-electron.bat", 0, False
```

双击 vbs 不闪黑框。做桌面快捷方式：`wscript.exe` + 参数 `"D:\path\to\bin\run-pet-electron.vbs"`。

开发时直接跑：

```bash
cd pet-electron
npx electron .
```

---

## 五、开机自启 + 崩溃守护

`pet-guard.ps1`（放在你的启动目录）每 20 秒看一眼 `electron.exe` 里命令行含 `pet-electron` 的进程，
不在就用 vbs 拉起来；20 分钟内最多拉 3 次，避免坏了之后打转。

- 用户右键「退出」时主进程会写 `state\pet-quit`，守护看到就收手，不会把桌宠又拉回来
- 正常启动（bat）会先删掉这个标记
- 日志：`logs\pet-guard.log`

开机自启（任务计划或启动文件夹）顺序建议：

1. 起桌宠（bat/vbs）
2. 起 `pet-guard.ps1 -Loop`
3. 其余链路

---

## 六、数据文件

全部在 `state/`（可被环境变量 `PET_STATE_DIR` 覆盖）：

| 文件 | 内容 | 谁写 |
| --- | --- | --- |
| `pet.json` | 窗口位置 `left/top` + 当前配色 `skin` | 桌宠自己 |
| `activity.json` | 她正在干嘛 `doing/note/plan/since/updatedAt` | bridge 的 `qq_set_activity` |
| `mood.json` | `affinity/mood/lastTalkAt` | bridge |
| `facts.json` | 长期记忆 | bridge 的 `qq_remember` |
| `console-token` | 控制台 token（读桥接口用） | bridge 启动时写 |
| `pet-quit` | 「用户主动退出」标记（瞬间文件） | 桌宠退出时 |

日记读 `diary/YYYY-MM-DD.md`（`PET_DIARY_DIR` 可覆盖）。

**这些目录不该进版本库**：

```gitignore
/diary/
/memory/
/roles/小鲸鱼.md      # 换成你自己的人格卡
/state/
/logs/
```

---

## 七、环境变量（都能覆盖，方便换机器部署）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `PET_STATE_DIR` | 状态目录 | `<仓库>/state` |
| `PET_DIARY_DIR` | 日记目录 | `<仓库>/diary` |
| `PET_LOG` | 日志文件 | `<仓库>/logs/pet-app.log` |
| `PET_ONECLICK` | 「一键修复·启动」要跑的脚本；不配就不显示这一项 | 空 |

调试开关（跑一次看看就走，别常开）：

| 变量 | 作用 |
| --- | --- |
| `PET_DEBUG_CURSOR=1` | 3 秒后把窗口挪到光标处（验证穿透） |
| `PET_TEST_SCHEME=mint-maid` | 6 秒后换一次配色 |
| `PET_TEST_ACT=activity` | 4 秒后试一次「她在干嘛」 |
| `PET_TEST_PREVIEW=1` / `=facts` | 5 秒后打开日记 / 长期记忆预览窗 |
| `PET_SPEAK_GAP=10` | 主动开口间隔最小改成 10 秒（默认 150~420） |

---

## 八、窗口尺寸：必须是正方形（改之前先看这段）

`model.json` 的 `view` 是 `[-12,-8,268,272]`，宽高都是 280 —— 渲染器按宽高比恒等把它们铺满 canvas。
`S = 窗口边长 / 280`，`floorY = 264 × S`。

**只要窗口不是正方形**，figure 的 SVG 会在中间留白，而 body 的 `S` 按高度算，
阴影、爱心、zzz、气泡锚点会整体错位。默认 `SIZE=420`（`K=1.5`、`FLOOR_Y=396`），
想改就按同比例改，别只改一边。

---

## 九、已知的坑（照抄会踩）

1. **EPIPE 弹窗**：从隐藏 cmd 用 `start /b` 起 electron，cmd 退出后 stdout 管道断，
   主进程任何 `console.log` 都抛 `Error: EPIPE: broken pipe, write`，
   弹「A JavaScript error occurred in the main process」。
   → `main.js` 的日志只写文件（`writeLog`），绝不 `console.log`；bat 里 `>nul 2>&1`。
2. **`ELECTRON_RUN_AS_NODE=1`**（见「四、启动」）。
3. **`setIgnoreMouseEvents(true, {forward: true})` 不转发**：这台机器上它不会把 mousemove 送进渲染进程。
   → 改成主进程 30ms 轮询 `screen.getCursorScreenPoint()` + `win.getBounds()` 判命中，再切 `setIgnoreMouseEvents`。
4. **两套穿透状态互相打架**：渲染进程和主进程都调 `setIgnoreMouseEvents`，
   日志会抖成 `穿透 → false/true/false`，点击全部落空。→ 只让主进程决定。
5. **文件协议**：ES module 在 `file://` 下 origin 是 `null`，相对 import 会被 CORS 拒。
   → 注册 `app://` 自定义协议（`standard/secure/supportFetchAPI/corsEnabled/stream`）再 `protocol.handle`。
6. **`WriteableBitmap` 参数**：`New-Object` 用 `-ArgumentList` 会吞掉 `$null`，
   找不到 6 参重载 —— 这是旧 WPF 版的老坑，Electron 版用不到，记着别回头。

---

## 十、常见问题

**一片空白 / 立绘不出来**
先看 `<仓库>/logs/pet-app.log`。`ready | words=37 | 420x420 S=1.500 floor=396` 这行在不在。
不在就是页面没加载成功，多半是 `app://` 协议或 `assets/pet` 路径问题。

**换配色后眼睛/白围裙花了**
`scripts/make-pet-schemes.py` 只动蓝色系（H 196~262 且 S≥0.13）的像素，
别用 HLS 全域变换，会把肤色和眼白一起拉走。

**她不理我 / 链路点全灰**
桥没在跑，或 `state/console-token` 缺失。先确认 3100 在听，再重启桌宠。

**聊天发了没回**
桌宠走的是 `/api/socialV2/desk-message`，只投递、不返回回复；她什么时候回取决于桥那边什么时候醒。
气泡会先挂「（她想一下…）」，收到回复的瞬间自动换成原文。

**托盘留了个死图标**
退出前没 `tray.destroy()`。electron 正常退出会自动清，被强杀时 Windows 偶尔留尸，鼠标划过就没了。

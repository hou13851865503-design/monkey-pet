// 主进程：透明无边框置顶窗口 + 2D 小猴
// P5 托盘 / 穿透 / 自启 / 设置持久化
// P7 缩放 / 位置记忆 / 拖拽（resizable:false 会让 setPosition 失效）
// P10 尺寸锁定 + 平滑等比缩放
// P11 事件反应 / 边缘吸附+贴边隐藏 / 撸它+双击情绪菜单 / 防打扰 / 番茄钟 / 今日待办气泡
const { app, BrowserWindow, ipcMain, Menu, Tray, screen, globalShortcut, powerMonitor, Notification, clipboard, net, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const wb = require('./wb');
const animWd = require('./anim');   // 只复用 walkDuration / walkEase，姿态仍由渲染层算

const WIN_W = 192;
const WIN_H = 223;
const POLL_MS = 80;          // 鼠标跟踪轮询
const DEADZONE = 28;         // 光标贴近中心不更新朝向
const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5;
// 拖拽时超过这个速度（像素/秒）持续 ~80ms => 触发眩晕
const DIZZY_SPEED = 1500;

const SNAP = 16;             // 距屏幕边缘多少 px 判定吸附
const PEEK = 44;             // 贴边后露出的像素
const PEEK_DELAY = 4000;     // 停靠后多久自动缩进
const BUBBLE_W = 248;        // 气泡窗宽度

// 自主散步：隔多久考虑一次、走一段最长/最短
const WANDER_MIN = 45000, WANDER_MAX = 150000;
const WANDER_STEP = 1200;    // 散步时相邻两帧的最小间隔（太小会推着窗口抖）

// ---------- 角色档案 ----------
// 步态、命中盒、脚底支点、动作表都在 character.json：换形象只改这个文件 + 素材，
// 主进程和渲染层都不用动。读不到就退化成"只会站着、不会散步"，绝不影响启动。
const characterPath = path.join(__dirname, 'character.json');
let characterProfile = null;
function loadCharacter() {
  try {
    characterProfile = JSON.parse(fs.readFileSync(characterPath, 'utf8'));
  } catch (e) {
    logCrash('character', e);
    characterProfile = { size: [WIN_W, WIN_H], gait: {}, clips: [] };
  }
  return characterProfile;
}
loadCharacter();

// 渲染层上报"现在在干什么"：idle | gesture | walk | drag | action | sleep | focus
let petActivity = 'idle';

// 这两个通道在模块加载时就注册：渲染层会在首帧之前同步取档案，
// 若等到 app ready 里的 registerIpc() 才注册，早执行的那次会取空。
ipcMain.on('character', (e) => { e.returnValue = characterProfile || loadCharacter(); });
ipcMain.on('pet-activity', (_e, kind) => { petActivity = String(kind || 'idle'); });

// ---------- 设置持久化 ----------
// 测试时可用 PET_SETTINGS_PATH 指到临时文件，避免把测试配置写进真实 settings.json
const settingsPath = process.env.PET_SETTINGS_PATH
  ? path.resolve(process.env.PET_SETTINGS_PATH)
  : path.join(app.getPath('userData'), 'settings.json');
// 测试时可用 PET_DAILY_PATH 指到临时文件，避免把样例任务写进真实数据
const dailyPath = process.env.PET_DAILY_PATH
  ? path.resolve(process.env.PET_DAILY_PATH)
  : path.join(app.getPath('userData'), 'daily.json');   // 每日任务（单独存，别把 settings 撑大）
const settings = {
  clickThrough: false,
  openAtLogin: true,
  zoom: 1,
  pos: null,
  antiDisturb: true,
  todos: [],            // 旧版纯文本待办，仅用于一次性迁移到 daily.json
  todosDate: '',
  dailyRemind: true,    // 每 10 分钟提醒"还有哪些没做完"
  remindFrom: 8,        // 提醒时段：开始（含）
  remindTo: 23,         // 提醒时段：结束（不含），凌晨不打扰
  mutedDate: '',        // 这一天点了"今天不再提醒"
  courses: [],          // { day:1-7, time:'HH:MM', name, room }
  reminders: [],        // { date:'YYYY-M-D', time:'HH:MM', name }
  remindBefore: 10,     // 提前多少分钟提醒
  // WorkBuddy API（OpenAI 兼容）。baseUrl 留空 = 未配置，所有 AI 功能会自动降级而不是报错。
  // 地址填到 /v1 为止即可，wb.js 会自己补 /chat/completions
  ai: { baseUrl: '', apiKey: '', model: 'DeepSeek-V4.1-Flash', timeoutMs: 25000, maxRetries: 2 },
  city: '南京',
  tts: false,           // 是否语音朗读
  autoMood: true,       // 空闲时自己换状态（环顾/换表情/小跳）
  wander: true,         // 空闲时自己在桌面上散步（走动 + 步态）
  morningReport: true,  // 每日早报
  reportTime: '08:30',
  lastReportDate: '',
};
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); } catch (_) {}
  migrateAi();
}
// 老版本的默认值是 gpt-4o-mini + api.openai.com，从没改过的人升级后应该自动切到 WorkBuddy。
// 只要用户填过 Key 就一律不动 —— 那是他自己配的，改掉就是行为回归。
function migrateAi() {
  const ai = settings.ai && typeof settings.ai === 'object' ? settings.ai : {};
  const oldDefaultUrl = ai.baseUrl === 'https://api.openai.com/v1' || ai.baseUrl === 'https://api.openai.com/v1/';
  if (!String(ai.apiKey || '').trim() && oldDefaultUrl) ai.baseUrl = '';
  if (!ai.model || ai.model === 'gpt-4o-mini') ai.model = wb.DEFAULTS.model;
  if (!Number.isFinite(Number(ai.timeoutMs)) || Number(ai.timeoutMs) <= 0) ai.timeoutMs = wb.DEFAULTS.timeoutMs;
  if (!Number.isFinite(Number(ai.maxRetries))) ai.maxRetries = wb.DEFAULTS.maxRetries;
  settings.ai = ai;
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(settings)); } catch (_) {}
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 本地日期键 YYYY-MM-DD（不要用 toISOString，那是 UTC，早上 8 点前会差一天）
function todayStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 崩溃 / 异常日志（排查闪退用）----------
// 写到 %APPDATA%\monkey-pet\crash.log，出现问题时把这个文件发我就能定位。
function logCrash(tag, e) {
  try {
    const line = '[' + new Date().toISOString() + '] ' + tag + ' :: ' +
      (e && (e.stack || e.message) ? (e.stack || e.message) : String(e)) + '\n';
    fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line);
  } catch (_) {}
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));

let win;
let tray;
let bubbleWin = null;
let todoWin = null;
let facingTimer = null;
let isDragging = false;
let isQuitting = false;

// ---------- 尺寸锁定 ----------
// 让窗口永远 resizable:true（Windows 上 resizable:false 会让 setPosition 静默失效），
// 但用 min==max 把尺寸钉死 => 拖拽只移动、绝不改变大小。
function lockSize(w, h) {
  if (!win) return;
  try { win.setMinimumSize(w, h); win.setMaximumSize(w, h); } catch (_) {}
}
function unlockSize() {
  if (!win) return;
  try { win.setMinimumSize(1, 1); win.setMaximumSize(10000, 10000); } catch (_) {}
}
// 由单一缩放系数算出宽高，且高度从宽度推导 => 严格等比，图片均匀缩放
function sizeForZoom(z) {
  const w = Math.round(WIN_W * z);
  const h = Math.round(w * WIN_H / WIN_W);
  return { w, h };
}
function workAreaFor(b) {
  try {
    return screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }).workArea;
  } catch (_) {
    return screen.getPrimaryDisplay().workArea;
  }
}

// ---------- 按像素命中：透明的部分不挡鼠标 ----------
// 窗口是一整块矩形，如果整块都接收鼠标，就会挡住后面的应用。
// 这里读取当前帧 PNG 的 alpha：光标落在透明像素上就开启"忽略鼠标"，
// 落在小猴身上才接收点击。配合 forward:true，忽略状态下仍能收到 mousemove 以便切回来。
const alphaCache = new Map();
function assetPathForKey(key) {
  if (!key) return null;
  if (key.startsWith('e_')) return path.join(__dirname, 'assets', 'emotion_' + key.slice(2) + '.png');
  const n = Number(String(key).slice(1));
  if (!Number.isFinite(n)) return null;
  return path.join(__dirname, 'assets', String(n + 1).padStart(2, '0') + '.png');
}
function alphaAt(key, nx, ny) {
  const p = assetPathForKey(key);
  if (!p) return 255;
  let m = alphaCache.get(p);
  if (m === undefined) {
    try {
      const img = nativeImage.createFromPath(p);
      if (img.isEmpty()) m = null;
      else { const s = img.getSize(); m = { w: s.width, h: s.height, buf: img.toBitmap() }; }
    } catch (_) { m = null; }
    alphaCache.set(p, m);
  }
  if (!m) return 255;
  const cx = clamp(Math.round(nx * (m.w - 1)), 0, m.w - 1);
  const cy = clamp(Math.round(ny * (m.h - 1)), 0, m.h - 1);
  // 3x3 膨胀：手指/耳朵这些细边也点得到，避免"点不中小猴"
  let a = 0;
  for (let dx = -2; dx <= 2; dx += 2) {
    for (let dy = -2; dy <= 2; dy += 2) {
      const x = clamp(cx + dx, 0, m.w - 1);
      const y = clamp(cy + dy, 0, m.h - 1);
      const v = m.buf[(y * m.w + x) * 4 + 3];
      if (v > a) a = v;
    }
  }
  return a;
}
let lastIgnore = false;
function setIgnore(on) {
  if (!win) return;
  on = !!on;
  if (on === lastIgnore) return;
  lastIgnore = on;
  try { win.setIgnoreMouseEvents(on, { forward: true }); } catch (_) {}
}

// 命中判定完全由主进程轮询驱动：不依赖渲染端能否收到 forwarded mousemove，
// 即使当前处于"忽略鼠标"状态也照样每 30ms 校正一次，不会卡死。
let currentFrameKey = 'd0';
function hitTick() {
  if (!win || win.isDestroyed() || isDragging || !win.isVisible()) return;
  if (peeking) return;
  if (settings.clickThrough) { setIgnore(true); return; }
  const b = win.getBounds();
  const p = screen.getCursorScreenPoint();
  const nx = (p.x - b.x) / b.width;
  const ny = (p.y - b.y) / b.height;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
  setIgnore(alphaAt(currentFrameKey, nx, ny) < 24);
}

// ---------- 光标下发 + 贴边探出检测 ----------
let lastCursorX = null, lastCursorY = null;
function sendCursor(force) {
  if (!win || win.isDestroyed() || isDragging) return;
  const b = win.getBounds();
  const p = screen.getCursorScreenPoint();

  // 光标没动就不再打扰渲染端（否则睡眠状态会被每 80ms 的光标事件反复吵醒）
  const moved = (p.x !== lastCursorX || p.y !== lastCursorY);
  lastCursorX = p.x; lastCursorY = p.y;

  // 贴边半隐藏：鼠标贴近露出的那一条 => 探出来
  if (dockEdge) {
    const wa = workAreaFor(b);
    if (peeking) {
      const s = sliverRect(dockEdge, b, wa);
      if (p.x >= s.x - 8 && p.x <= s.x + s.w + 8 && p.y >= s.y - 8 && p.y <= s.y + s.h + 8) unpeek();
      return; // 缩进去时不做朝向跟随
    } else if (p.x >= b.x - 8 && p.x <= b.x + b.width + 8 && p.y >= b.y - 8 && p.y <= b.y + b.height + 8) {
      schedulePeek(); // 鼠标还在身上，推迟自动缩进
    }
  }

  if (!moved && !force) return;
  if (!win.isVisible()) return;
  const dx = p.x - (b.x + b.width / 2);
  const dy = p.y - (b.y + b.height / 2);
  if (Math.hypot(dx, dy) < DEADZONE) win.webContents.send('cursor', 0, 0);
  else win.webContents.send('cursor', dx, dy);
}

// ---------- 拖拽移动 ----------
let dragPoll = null;
// 拖拽速度采样（用于眩晕）
let dragSamplePos = null, dragSampleT = 0, fastTicks = 0, dizzySent = false;
let dragVel = { vx: 0, vy: 0 };       // 最近一次采样的拖拽速度（px/s），松手时用来定落地强度
let grabOffset = { x: 0, y: 0 };
function startDrag() {
  if (!win) return;
  if (peeking) unpeek();                 // 缩进去时先探出来再拖
  clearTimeout(peekTimer);
  endWalk();                             // 正在散步就先停下来，别和拖拽抢窗口位置
  isDragging = true;
  setIgnore(false);                       // 开始拖拽先确保接收指针事件
  const b = win.getBounds();
  lockSize(b.width, b.height);
  const p = screen.getCursorScreenPoint();
  grabOffset = { x: p.x - b.x, y: p.y - b.y };
  if (dragPoll) clearInterval(dragPoll);
  dragSamplePos = { x: p.x, y: p.y };
  dragSampleT = Date.now();
  fastTicks = 0;
  dizzySent = false;
  dragPoll = setInterval(() => {
    if (!win || !isDragging) return;
    const cp = screen.getCursorScreenPoint();
    try { win.setPosition(Math.round(cp.x - grabOffset.x), Math.round(cp.y - grabOffset.y)); } catch (_) {}

    // ---- 甩得太快 => 眩晕 ----
    const now = Date.now();
    const dt = Math.max(1, now - dragSampleT);
    const sx = cp.x - dragSamplePos.x;
    const sy = cp.y - dragSamplePos.y;
    const dist = Math.hypot(sx, sy);
    const speed = dist * 1000 / dt;
    // 分轴速度下发给渲染层：横向决定"身体滞后"，纵向决定"被拎起来的拉伸感"
    dragVel = { vx: sx * 1000 / dt, vy: sy * 1000 / dt };
    try { win.webContents.send('drag-vel', Math.round(dragVel.vx), Math.round(dragVel.vy)); } catch (_) {}
    dragSamplePos = { x: cp.x, y: cp.y };
    dragSampleT = now;

    if (speed > DIZZY_SPEED) fastTicks++; else fastTicks = Math.max(0, fastTicks - 2);
    // 16ms 一档，连续 5 档（约 80ms）都超速才算"甩"
    if (fastTicks >= 5 && !dizzySent) {
      dizzySent = true;
      try { win.webContents.send('emotion', 'dizzy'); } catch (_) {}
    }
    if (speed < 500) dizzySent = false;   // 慢下来后可以再次甩晕
  }, 16);
}
function endDrag() {
  if (!win) return;
  isDragging = false;
  if (dragPoll) { clearInterval(dragPoll); dragPoll = null; }
  // 落地反馈：把松手瞬间的竖直速度交给渲染层，速度越大压得越狠。
  // 这个值必须在窗口吸附/重新定位之前发，否则会被 snapToEdge 的时间吃掉。
  try { win.webContents.send('land', Math.round(dragVel.vy)); } catch (_) {}
  dragVel = { vx: 0, vy: 0 };
  const b = win.getBounds();
  lockSize(b.width, b.height);
  snapToEdge();
  const nb = win.getBounds();
  if (Number.isFinite(nb.x) && Number.isFinite(nb.y)) { settings.pos = { x: nb.x, y: nb.y }; saveSettings(); }
  // 拖完窗口换了位置：按"当前真实光标"重算朝向，避免停在拖拽时的侧面
  sendCursor(true);
}

// ---------- 边缘吸附 + 贴边半隐藏 ----------
let dockEdge = null;      // 'left' | 'right' | 'top' | 'bottom' | null
let peeking = false;
let peekTimer = null;

function snapToEdge() {
  if (!win) return;
  const b = win.getBounds();
  const wa = workAreaFor(b);
  const d = {
    left: b.x - wa.x,
    right: (wa.x + wa.width) - (b.x + b.width),
    top: b.y - wa.y,
    bottom: (wa.y + wa.height) - (b.y + b.height),
  };
  let edge = null, min = SNAP + 1;
  ['left', 'right', 'top', 'bottom'].forEach((k) => {
    if (d[k] >= 0 && d[k] < min) { min = d[k]; edge = k; }
  });
  if (edge) {
    dockEdge = edge;
    peeking = false;
    const p = flushPos(edge, b, wa);
    try { win.setPosition(p.x, p.y); } catch (_) {}
    schedulePeek();
  } else {
    dockEdge = null;
    peeking = false;
    clearTimeout(peekTimer);
    // 至少保证窗口不会被拖丢到屏幕外
    try {
      win.setPosition(
        clamp(b.x, wa.x - b.width + 60, wa.x + wa.width - 60),
        clamp(b.y, wa.y - 40, wa.y + wa.height - 60)
      );
    } catch (_) {}
  }
}
function flushPos(edge, b, wa) {
  let x = b.x, y = b.y;
  if (edge === 'left') x = wa.x;
  else if (edge === 'right') x = wa.x + wa.width - b.width;
  else if (edge === 'top') y = wa.y;
  else if (edge === 'bottom') y = wa.y + wa.height - b.height;
  x = clamp(x, wa.x - b.width + PEEK, wa.x + wa.width - PEEK);
  y = clamp(y, wa.y - b.height + PEEK, wa.y + wa.height - PEEK);
  return { x: Math.round(x), y: Math.round(y) };
}
function peekPos(edge, b, wa) {
  let x = b.x, y = b.y;
  if (edge === 'left') x = wa.x - (b.width - PEEK);
  else if (edge === 'right') x = wa.x + wa.width - PEEK;
  else if (edge === 'top') y = wa.y - (b.height - PEEK);
  else if (edge === 'bottom') y = wa.y + wa.height - PEEK;
  return { x: Math.round(x), y: Math.round(y) };
}
function sliverRect(edge, b, wa) {
  if (edge === 'left') return { x: wa.x, y: b.y, w: PEEK, h: b.height };
  if (edge === 'right') return { x: wa.x + wa.width - PEEK, y: b.y, w: PEEK, h: b.height };
  if (edge === 'top') return { x: b.x, y: wa.y, w: b.width, h: PEEK };
  return { x: b.x, y: wa.y + wa.height - PEEK, w: b.width, h: PEEK };
}
function schedulePeek() {
  clearTimeout(peekTimer);
  if (!dockEdge || peeking) return;
  peekTimer = setTimeout(() => {
    if (!win || !dockEdge || peeking || isDragging) return;
    doPeek();
  }, PEEK_DELAY);
}
function doPeek() {
  if (!win || !dockEdge) return;
  const b = win.getBounds();
  const wa = workAreaFor(b);
  const p = peekPos(dockEdge, b, wa);
  lockSize(b.width, b.height);
  try { win.setPosition(p.x, p.y); } catch (_) {}
  peeking = true;
}
function unpeek() {
  if (!win || !peeking || !dockEdge) return;
  const b = win.getBounds();
  const wa = workAreaFor(b);
  const p = flushPos(dockEdge, b, wa);
  try { win.setPosition(p.x, p.y); } catch (_) {}
  peeking = false;
  schedulePeek();
}

// ---------- 自主散步 ----------
// 分工：主进程只决定"去哪儿"并推窗口位置；渲染层把收到的位移像素换算成步频。
// 两边靠"走了多少像素"对齐、不共享时钟，所以拖拽/缩放/掉帧都不会让脚步错位。
let wanderTimer = null;
let walkTimer = null;
let walkRun = null;         // { t0, dur, fromX, toX, y, lastX, accel }
const walkStats = { starts: 0, steps: 0 };   // 供自动化测试核对链路是否真的跑通

function wanderBlocked() {
  if (!win || win.isDestroyed() || !win.isVisible()) return true;
  if (isDragging || peeking) return true;
  if (settings.clickThrough) return true;      // 穿透模式下乱跑会让人点不到它
  if (hiddenByFullscreen) return true;
  if (focusActive()) return true;
  if (petActivity !== 'idle') return true;     // 正在演动作 / 在睡 / 被拖
  return false;
}

function scheduleWander() {
  clearTimeout(wanderTimer);
  const wait = WANDER_MIN + Math.random() * (WANDER_MAX - WANDER_MIN);
  wanderTimer = setTimeout(() => {
    scheduleWander();                          // 先排下一轮，本次出错也不会断掉循环
    try { if (settings.wander !== false) startWander(); } catch (e) { logCrash('wander', e); }
  }, wait);
}

function startWander() {
  if (walkRun || wanderBlocked()) return;
  const b = win.getBounds();
  const wa = workAreaFor(b);
  const maxX = Math.max(wa.x, wa.x + wa.width - b.width);
  const toX = Math.round(wa.x + Math.random() * (maxX - wa.x));
  if (Math.abs(toX - b.x) < b.width * 0.7) return;   // 太近就不走了，免得原地抽搐
  startWalkTo(toX);
}

// 走到指定横坐标（散步和"走两步"共用）。y 不变，只在水平线上移动。
function startWalkTo(toX) {
  if (walkRun || !win || win.isDestroyed()) return false;
  const b = win.getBounds();
  const wa = workAreaFor(b);
  const maxX = Math.max(wa.x, wa.x + wa.width - b.width);
  const target = clamp(Math.round(toX), Math.round(wa.x), Math.round(maxX));
  if (Math.abs(target - b.x) < 8) return false;
  const dir = target > b.x ? 1 : -1;
  const a = Number(characterProfile && characterProfile.gait && characterProfile.gait.accel);
  walkRun = {
    t0: Date.now(),
    dur: animWd.walkDuration(target - b.x, b.width, characterProfile),
    fromX: b.x, toX: target, y: b.y, lastX: b.x,
    accel: Number.isFinite(a) ? clamp(a, 0.05, 0.45) : 0.18,
  };
  walkStats.starts++;
  try { win.webContents.send('walk-start', { dir }); } catch (_) {}
  if (walkTimer) clearInterval(walkTimer);
  walkTimer = setInterval(walkTick, 16);
  return true;
}

function walkTick() {
  const w = walkRun;
  if (!w) { endWalk(); return; }
  if (!win || win.isDestroyed() || isDragging) { endWalk(); return; }
  const t = clamp((Date.now() - w.t0) / w.dur, 0, 1);
  const x = Math.round(w.fromX + (w.toX - w.fromX) * animWd.walkEase(t, w.accel));
  const dx = x - w.lastX;
  w.lastX = x;
  if (Math.abs(dx) >= 1) {
    try { win.setPosition(x, w.y); } catch (_) {}
    walkStats.steps++;
    try { win.webContents.send('walk-step', dx); } catch (_) {}
  }
  if (t >= 1) endWalk();
}

function endWalk() {
  if (walkTimer) { clearInterval(walkTimer); walkTimer = null; }
  if (!walkRun) return;
  walkRun = null;
  try { if (win && !win.isDestroyed()) win.webContents.send('walk-end'); } catch (_) {}
  try {
    const nb = win.getBounds();
    if (Number.isFinite(nb.x)) { settings.pos = { x: nb.x, y: nb.y }; saveSettings(); }
  } catch (_) {}
  sendCursor(true);                            // 停下后按当前光标重新定朝向
}


// ---------- 缩放（平滑 + 严格等比）----------
let zoomTween = null;
function animateZoomTo(targetZ) {
  if (!win) return;
  if (zoomTween) { clearInterval(zoomTween); zoomTween = null; }
  const startB = win.getBounds();
  const cx = startB.x + startB.width / 2, cy = startB.y + startB.height / 2;
  const startZ = startB.width / WIN_W;
  const t0 = Date.now(), dur = 140;
  unlockSize();
  zoomTween = setInterval(() => {
    if (!win) { clearInterval(zoomTween); zoomTween = null; return; }
    const t = Math.min(1, (Date.now() - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    const z = startZ + (targetZ - startZ) * e;
    const { w, h } = sizeForZoom(z);
    try { win.setBounds({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h }); } catch (_) {}
    if (t >= 1) {
      clearInterval(zoomTween); zoomTween = null;
      const nb = win.getBounds();
      lockSize(nb.width, nb.height);
      if (Number.isFinite(nb.x) && Number.isFinite(nb.y)) { settings.pos = { x: nb.x, y: nb.y }; saveSettings(); }
      if (dockEdge) snapToEdge();   // 缩放后重新贴合边缘
    }
  }, 16);
}

// ---------- 事件反应系统：闲置 -> 睡 / 键鼠动 -> 醒 ----------
let lastAsleep = false;
function startIdleWatch() {
  setInterval(() => {
    if (!win) return;
    let idle = 0;
    try { idle = powerMonitor.getSystemIdleTime(); } catch (_) {}
    const asleep = idle >= 45;
    if (asleep !== lastAsleep) {
      lastAsleep = asleep;
      try { win.webContents.send('idle-state', asleep); } catch (_) {}
    }
  }, 1000);
}

// ---------- 整点问候 ----------
let greetedKey = '';
function greetingFor() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return { text: '早上好～ 今天也要加油鸭！', emo: 'cheer' };
  if (h >= 11 && h < 14) return { text: '中午啦，记得吃饭、眯一会儿', emo: 'love' };
  if (h >= 14 && h < 18) return { text: '下午好，起来喝口水吧', emo: 'wink' };
  if (h >= 18 && h < 23) return { text: '晚上好，今天过得怎么样？', emo: 'cheer' };
  return { text: '这么晚还没睡，我陪着你～', emo: 'sleepy' };
}
function startGreetingWatch() {
  setInterval(() => {
    const d = new Date();
    if (d.getMinutes() !== 0) return;
    const key = d.toDateString() + d.getHours();
    if (greetedKey === key) return;
    greetedKey = key;
    if (!win || !win.isVisible() || focusEnd) return;
    const g = greetingFor();
    emitEmotion(g.emo);
    showBubble({ title: '小猴', text: g.text }, 5000);
  }, 20000);
}

// ---------- 防打扰：前台窗口全屏 -> 自动隐藏 ----------
let fgProc = null;
let hiddenByFullscreen = false;
let fullTimer = null;
function startAntiDisturb() {
  if (fgProc) return;   // 已在运行，避免重复启动
  const ps = path.join(__dirname, 'tools', 'foreground-watch.ps1');
  if (!fs.existsSync(ps)) return;
  try {
    fgProc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    fgProc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ERR') { stopAntiDisturb(); return; }  // PowerShell 无法编译 => 停用
        if (line === '1' || line === '0') onFullscreen(line === '1');
      }
    });
    fgProc.on('error', () => { fgProc = null; });
    fgProc.on('exit', () => { fgProc = null; });
  } catch (_) { fgProc = null; }
}
function stopAntiDisturb() {
  try { if (fgProc) fgProc.kill(); } catch (_) {}
  fgProc = null;
}
function onFullscreen(full) {
  if (!settings.antiDisturb) return;
  clearTimeout(fullTimer);
  fullTimer = setTimeout(() => {
    if (!win) return;
    if (full) {
      if (win.isVisible()) { win.hide(); hiddenByFullscreen = true; hideBubble(); }
    } else if (hiddenByFullscreen) {
      hiddenByFullscreen = false;
      win.show();
      win.setAlwaysOnTop(true, 'pop-up-menu');
    }
  }, 900);
}
function setAntiDisturb(on) {
  settings.antiDisturb = !!on;
  saveSettings();
  if (settings.antiDisturb) startAntiDisturb(); else stopAntiDisturb();
  if (!settings.antiDisturb && hiddenByFullscreen) {
    hiddenByFullscreen = false;
    if (win) { win.show(); win.setAlwaysOnTop(true, 'pop-up-menu'); }
  }
  refreshTray();
}

// ---------- 番茄钟 ----------
const FOCUS_MS = 25 * 60 * 1000;
let focusEnd = 0;
let focusTimer = null;
function focusActive() { return focusEnd > 0; }
function focusStart() {
  focusEnd = Date.now() + FOCUS_MS;
  if (focusTimer) clearInterval(focusTimer);
  focusTimer = setInterval(focusTick, 1000);
  if (win) win.webContents.send('focus-state', true);
  emitEmotion('thinking');
  showBubble({ title: '专注开始', text: '接下来 25 分钟，我陪你专心做事～' }, 4000);
  refreshTray();
}
function focusStop(quiet) {
  if (focusTimer) { clearInterval(focusTimer); focusTimer = null; }
  focusEnd = 0;
  if (win) win.webContents.send('focus-state', false);
  if (!quiet) {
    emitEmotion('cheer');
    showBubble({ title: '已停止专注', text: '休息一下也不错～' }, 3500);
  }
  refreshTray();
}
function focusTick() {
  if (!focusEnd) return;
  const left = focusEnd - Date.now();
  if (left <= 0) { focusStop(true); focusDone(); return; }
  const rem = left % 60000;
  if (rem < 1000) {   // 每到整分钟提示一次剩余时间
    const m = Math.floor(left / 60000);
    const s = Math.floor(rem / 1000);
    showBubble({ kind: 'countdown', title: '专注中', text: `${m}:${String(s).padStart(2, '0')}` }, 2200);
  }
}
function focusDone() {
  emitEmotion('cheer');
  showBubble({ title: '时间到！', text: '25 分钟专注完成，起来动一动、喝口水吧～' }, 7000);
  try {
    new Notification({ title: '小猴桌宠 · 专注完成', body: '25 分钟到啦，该休息一下了～' }).show();
  } catch (_) {}
}
function toggleFocus() { if (focusActive()) focusStop(false); else focusStart(); }

// ---------- 今日待办 / 每日任务 ----------
// 数据在 daily.json，语义见 daily.js：
//   任务只挂在"创建那天"，没做完逐日顺延，completedOn 记录完成日。
//   所以"今天要做什么"是 onDate() 算出来的，不存在"每天重置勾选"这回事。
const daily = require('./daily');
const DAILY_REMIND_MIN = 10;          // 提醒频率：每 10 分钟
let dailyStore = null;
function dstore() {
  if (!dailyStore) {
    dailyStore = daily.load(dailyPath, settings.todos);
    // 迁移完立刻落盘，并把旧清单清空（避免下次又迁移一遍）
    daily.save(dailyPath, dailyStore);
    if ((settings.todos || []).length) { settings.todos = []; settings.todosDate = todayStr(); saveSettings(); }
  }
  return dailyStore;
}
function dailySave() { daily.save(dailyPath, dailyStore); }
function dailyState() {
  const today = todayStr();
  const items = daily.onDate(dstore(), today);
  return {
    today,
    items: items.map((it) => ({
      ref: it.ref,
      day: it.key,
      title: it.task.title,
      type: it.task.type,
      minutes: it.task.minutes,
      start: it.task.start,
      deadline: it.task.deadline,
      done: it.done,
      carried: it.carried,
      overdue: it.overdue,
    })),
    stats: daily.stats(items),
    remind: {
      on: settings.dailyRemind !== false,
      from: settings.remindFrom,
      to: settings.remindTo,
      muted: settings.mutedDate === today,
      everyMin: DAILY_REMIND_MIN,
    },
  };
}
// 气泡里那一行怎么写：标题 + 今天截止/逾期/顺延（入参是 dailyState 展平后的 item）
function taskLine(it) {
  let s = it.title;
  if (it.deadline && it.deadline === todayStr()) s += '（今天截止）';
  else if (it.overdue > 0) s += `（已逾期 ${it.overdue} 天）`;
  else if (it.carried > 0) s += `（顺延 ${it.carried} 天）`;
  return s;
}
function todoData() {
  return dailyState().items.map((it) => ({ text: it.title, done: it.done }));
}
function openTodoEditor() {
  dstore();
  if (todoWin) { todoWin.show(); todoWin.focus(); return; }
  todoWin = new BrowserWindow({
    width: 380,
    height: 560,
    title: '今日待办',
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  todoWin.loadFile('todo.html');
  todoWin.on('closed', () => { todoWin = null; });
}
// 任务变了：通知待办窗口 + 刷新托盘
function dailyChanged() {
  dailySave();
  if (todoWin && !todoWin.isDestroyed()) {
    try { todoWin.webContents.send('daily-changed', dailyState()); } catch (_) {}
  }
  try { refreshTray(); } catch (_) {}
}

// ---------- 未完成任务提醒 ----------
// 触发：启动后 90 秒首检，之后每 60 秒巡一次，两次提醒之间至少隔 DAILY_REMIND_MIN(10) 分钟。
// 为什么不是 setInterval(10min)：电脑睡眠/唤醒会让定时器漂移，用"每分钟看一眼是否满 10 分钟"
// 更稳，也不会因为休眠后一次性攒出好几条提醒。
// 停止条件见 shouldRemind()。
const REMIND_GAP_MS = DAILY_REMIND_MIN * 60 * 1000;
let lastDailyRemindAt = 0;
let dailyRemindTimer = null;
let allDoneNotifiedDate = '';

function remindWindowOpen(now = new Date()) {
  const h = now.getHours() + now.getMinutes() / 60;
  const from = Number.isFinite(+settings.remindFrom) ? +settings.remindFrom : 8;
  const to = Number.isFinite(+settings.remindTo) ? +settings.remindTo : 23;
  return h >= from && h < to;
}
function remindBlockedReason() {
  const today = todayStr();
  if (settings.dailyRemind === false) return 'off';
  if (settings.mutedDate === today) return 'muted';
  if (!win || win.isDestroyed() || !win.isVisible()) return 'hidden';
  if (!remindWindowOpen()) return 'quiet-hours';
  return '';
}

function showTodayTasksBubble(ms = 8000) {
  const st = dailyState();
  const pending = st.items.filter((i) => !i.done);
  if (!pending.length) {
    showBubble({ kind: 'list', title: '今日任务都完成了', items: [
      { text: `共 ${st.stats.done} 项，全部勾掉了` },
    ] }, ms);
    return;
  }
  const MAX = 6;
  const items = pending.slice(0, MAX).map((i) => ({ text: taskLine(i) }));
  if (pending.length > MAX) items.push({ text: `…还有 ${pending.length - MAX} 项没列出` });
  showBubble({ kind: 'list', title: `今日待办 · ${pending.length} 项未完成`, items }, ms);
}

function notifyPending(pending, st) {
  const MAX = 6;
  // 一行只放标题 + 一个状态词：气泡很窄，再堆分钟数就会折行折得很难看
  const items = pending.slice(0, MAX).map((i) => ({ text: taskLine(i) }));
  if (pending.length > MAX) items.push({ text: `…还有 ${pending.length - MAX} 项` });
  const m = st.stats.minutes;
  const eta = m >= 60 ? `${(m / 60).toFixed(1)} 小时` : `${m} 分钟`;
  emitEmotion(pending.length >= 4 ? 'thinking' : 'sad');
  showBubble({
    kind: 'list',
    title: `还有 ${pending.length} 项没完成 · 约 ${eta}`,
    items,
  }, 15000);
}

function dailyTick() {
  const blocked = remindBlockedReason();
  if (blocked) return;
  const st = dailyState();
  const pending = st.items.filter((i) => !i.done);

  // 全部完成 => 当天只在第一次达成时道贺一句，然后自然静默
  if (!pending.length) {
    if (st.items.length && allDoneNotifiedDate !== st.today) {
      allDoneNotifiedDate = st.today;
      emitEmotion('cheer');
      showBubble({ title: '今日任务全部完成', text: `${st.stats.done} 项全清，剩下的时间归你～` }, 7000);
    }
    return;
  }
  if (Date.now() - lastDailyRemindAt < REMIND_GAP_MS) return;
  lastDailyRemindAt = Date.now();
  notifyPending(pending, st);
}

function startDailyWatch() {
  clearInterval(dailyRemindTimer);
  setTimeout(dailyTick, 90 * 1000);            // 开机别一上来就弹
  dailyRemindTimer = setInterval(dailyTick, 60 * 1000);
}
function setDailyRemind(on) {
  settings.dailyRemind = !!on;
  if (settings.dailyRemind) settings.mutedDate = '';
  lastDailyRemindAt = 0;
  saveSettings();
  refreshTray();
}
function muteToday() {
  settings.mutedDate = todayStr();
  saveSettings();
  refreshTray();
  showBubble({ title: '好的', text: '今天的任务提醒就先关掉了，明天继续' }, 3600);
  emitEmotion('wink');
}

// ---------- 剪贴板历史 ----------
let clipWin = null;
const CLIP_MAX = 50;
let clipHistory = [];
let lastClipText = '';
function startClipWatch() {
  setInterval(() => {
    try {
      const t = clipboard.readText();
      if (!t || !t.trim()) return;
      if (t === lastClipText) return;
      lastClipText = t;
      const i = clipHistory.indexOf(t);
      if (i >= 0) clipHistory.splice(i, 1);
      clipHistory.unshift(t);
      if (clipHistory.length > CLIP_MAX) clipHistory.length = CLIP_MAX;
      if (clipWin && !clipWin.isDestroyed()) {
        try { clipWin.webContents.send('clip-list', clipHistory); } catch (_) {}
      }
    } catch (_) {}
  }, 700);
}
function openClipboard() {
  if (clipWin && !clipWin.isDestroyed()) { clipWin.show(); clipWin.focus(); return; }
  clipWin = new BrowserWindow({
    width: 440,
    height: 520,
    title: '剪贴板历史',
    resizable: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  clipWin.loadFile('clip.html');
  clipWin.on('closed', () => { clipWin = null; });
}
function pickClip(index) {
  const t = clipHistory[Number(index)];
  if (typeof t !== 'string') return;
  try { clipboard.writeText(t); } catch (_) {}
  lastClipText = t;
  // 选中的挪到最前
  const i = clipHistory.indexOf(t);
  if (i > 0) { clipHistory.splice(i, 1); clipHistory.unshift(t); }
  try { if (clipWin) clipWin.close(); } catch (_) {}
  showBubble({ title: '已复制', text: '内容已放回剪贴板，按 Ctrl+V 粘贴即可' }, 3500);
}
function clearClip() {
  clipHistory = [];
  if (clipWin && !clipWin.isDestroyed()) { try { clipWin.webContents.send('clip-list', clipHistory); } catch (_) {} }
}

// ---------- 系统监控 ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sampleCpu() {
  const a = os.cpus();
  return new Promise((resolve) => {
    setTimeout(() => {
      const b = os.cpus();
      let idle = 0, total = 0;
      b.forEach((c, i) => {
        if (!a[i]) return;
        const t0 = a[i].times, t1 = c.times;
        idle += t1.idle - t0.idle;
        total += (t1.user + t1.nice + t1.sys + t1.idle + t1.irq) - (t0.user + t0.nice + t0.sys + t0.idle + t0.irq);
      });
      resolve(total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0);
    }, 500);
  });
}
function psNetBytes() {
  return new Promise((resolve) => {
    const cmd = "$r=(Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum; " +
      "$s=(Get-NetAdapterStatistics | Measure-Object -Property SentBytes -Sum).Sum; " +
      "Write-Output $r; Write-Output $s";
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const nums = String(stdout).split(/\r?\n/).map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n));
      if (nums.length < 2) return resolve(null);
      resolve({ recv: nums[0], sent: nums[1] });
    });
  });
}
function fmtBytes(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return Math.max(0, b).toFixed(0) + ' B';
}
async function showStats() {
  if (!win || !win.isVisible()) return;
  showBubble({ title: '系统状态', text: '正在采样…' }, 4000);
  const cpuP = sampleCpu();
  const n1 = await psNetBytes();
  const t1 = Date.now();
  await sleep(1000);
  const n2 = await psNetBytes();
  const t2 = Date.now();
  const cpu = await cpuP;
  const total = os.totalmem(), free = os.freemem(), used = total - free;
  let netLine = '网络  N/A';
  if (n1 && n2) {
    const dt = Math.max(1, (t2 - t1) / 1000);
    const down = Math.max(0, (n2.recv - n1.recv) / dt);
    const up = Math.max(0, (n2.sent - n1.sent) / dt);
    netLine = `网络  ↓${fmtBytes(down)}/s  ↑${fmtBytes(up)}/s`;
  }
  const text =
    `CPU  ${cpu.toFixed(0)}%（${os.cpus().length} 核）\n` +
    `内存  ${(used / 1073741824).toFixed(1)} / ${(total / 1073741824).toFixed(1)} GB（${(used / total * 100).toFixed(0)}%）\n` +
    netLine;
  showBubble({ kind: 'stats', title: '系统状态', text }, 9000);
}

// ---------- 课程表 / 日程 ----------
let scheduleWin = null;
let remindedKeys = new Set();
const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];
function weekdayCn(d) { return WEEK_CN[clamp(d, 1, 7) - 1]; }
function weekdayNow() { const d = new Date().getDay(); return d === 0 ? 7 : d; }
function todayCourses() {
  const wd = weekdayNow();
  return (settings.courses || [])
    .filter((c) => Number(c.day) === wd)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}
function openScheduleEditor() {
  if (scheduleWin && !scheduleWin.isDestroyed()) { scheduleWin.show(); scheduleWin.focus(); return; }
  scheduleWin = new BrowserWindow({
    width: 480,
    height: 640,
    title: '课程表 / 日程',
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  scheduleWin.loadFile('schedule.html');
  scheduleWin.on('closed', () => { scheduleWin = null; });
}
function saveSchedule(data) {
  data = data || {};
  settings.courses = (Array.isArray(data.courses) ? data.courses : [])
    .filter((c) => c && String(c.name || '').trim())
    .map((c) => ({
      day: clamp(parseInt(c.day, 10) || 1, 1, 7),
      time: /^\d{1,2}:\d{2}$/.test(c.time) ? c.time : '08:00',
      name: String(c.name).trim().slice(0, 40),
      room: String(c.room || '').trim().slice(0, 40),
    }));
  settings.reminders = (Array.isArray(data.reminders) ? data.reminders : [])
    .filter((r) => r && String(r.name || '').trim() && r.date)
    .map((r) => ({
      date: String(r.date),
      time: /^\d{1,2}:\d{2}$/.test(r.time) ? r.time : '08:00',
      name: String(r.name).trim().slice(0, 40),
    }));
  const rb = parseInt(data.remindBefore, 10);
  settings.remindBefore = clamp(isNaN(rb) ? 10 : rb, 0, 120);
  saveSettings();
  refreshTray();
  return scheduleData();
}
function scheduleData() {
  return {
    courses: settings.courses || [],
    reminders: settings.reminders || [],
    remindBefore: settings.remindBefore || 10,
  };
}
function remind(text, emo) {
  emitEmotion(emo || 'cheer');
  showBubble({ title: '日程提醒', text }, 9000);
}
function startScheduleWatch() {
  setInterval(() => {
    if (!win) return;
    const now = new Date();
    const adv = (settings.remindBefore || 0) * 60000;
    const today = todayStr();
    const y = now.getFullYear(), mo = now.getMonth(), da = now.getDate();

    (settings.courses || []).forEach((c, i) => {
      if (Number(c.day) !== weekdayNow()) return;
      const [h, m] = String(c.time || '00:00').split(':').map(Number);
      if (isNaN(h) || isNaN(m)) return;
      const start = new Date(y, mo, da, h, m, 0, 0).getTime();
      const diff = start - now.getTime() - adv;
      if (diff <= 0 && diff > -60000) {
        const key = `C|${today}|${i}`;
        if (!remindedKeys.has(key)) {
          remindedKeys.add(key);
          const mins = settings.remindBefore || 0;
          remind(`${mins} 分钟后有课：${c.name}${c.room ? ' @' + c.room : ''}`, 'surprised');
        }
      }
    });

    (settings.reminders || []).forEach((r, i) => {
      if (String(r.date) !== today) return;
      const [h, m] = String(r.time || '00:00').split(':').map(Number);
      if (isNaN(h) || isNaN(m)) return;
      const at = new Date(y, mo, da, h, m, 0, 0).getTime();
      const diff = at - now.getTime() - adv;
      if (diff <= 0 && diff > -60000) {
        const key = `R|${r.date}|${i}`;
        if (!remindedKeys.has(key)) {
          remindedKeys.add(key);
          const mins = settings.remindBefore || 0;
          remind(`${mins} 分钟后：${r.name}`, 'wink');
        }
      }
    });

    if (remindedKeys.size > 400) remindedKeys = new Set(Array.from(remindedKeys).slice(-120));
  }, 30000);
}
function showTodayCoursesBubble() {
  const list = todayCourses();
  const items = list.map((c) => ({ text: `${c.time}  ${c.name}${c.room ? ' @' + c.room : ''}` }));
  showBubble({
    kind: 'lines',
    title: `今天（周${weekdayCn(weekdayNow())}）的课`,
    items,
  }, 8000);
}

// ---------- AI：对话 / 名片识别 / 语音 / 早报 ----------
let aiWin = null, chatWin = null, cardWin = null, usageWin = null;

// 用 Electron net 发请求：走 Chromium 网络栈，自动使用系统代理（FlClash 等）
function httpJson(url, opts, timeout) {
  return new Promise((resolve, reject) => {
    opts = opts || {};
    let req;
    try {
      req = net.request({ url: url, method: opts.method || 'GET' });
    } catch (e) { return reject(e); }
    const headers = opts.headers || {};
    Object.keys(headers).forEach((k) => { try { req.setHeader(k, headers[k]); } catch (_) {} });

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { req.abort(); } catch (_) {}
      reject(new Error('请求超时'));
    }, timeout || 8000);

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const txt = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(txt)); } catch (e) { reject(new Error('返回不是 JSON')); }
      });
      res.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });

    if (opts.body) { try { req.write(opts.body); } catch (_) {} }
    req.end();
  });
}
// ---------- WorkBuddy API ----------
// wb.js 只认注入进来的 transport，这里把 Electron 的 net.request 包一层递进去：
// 好处是继续走 Chromium 网络栈（自动继承系统代理 / 证书），同时保留了非 2xx 的状态码，
// 让 wb.js 自己去分类（httpJson 是"非 2xx 就 reject"，会把错误码丢掉）。
function netTransport(url, req) {
  return new Promise((resolve, reject) => {
    let r;
    try {
      r = net.request({ url: url, method: (req && req.method) || 'GET' });
    } catch (e) { return reject(e); }
    const headers = (req && req.headers) || {};
    Object.keys(headers).forEach((k) => { try { r.setHeader(k, headers[k]); } catch (_) {} });

    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      const e = new Error('请求超时');
      e.code = 'ETIMEDOUT';
      try { r.abort(); } catch (_) {}
      finish(reject, e);
    }, (req && req.timeoutMs) || 25000);

    r.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(resolve, {
        status: res.statusCode,
        headers: res.headers || {},
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', (e) => finish(reject, e));
    });
    r.on('error', (e) => finish(reject, e));

    if (req && req.body) { try { r.write(req.body); } catch (_) {} }
    r.end();
  });
}

const wbClient = wb.createClient({
  transport: netTransport,
  getConfig: () => settings.ai || {},
});

// 所有 AI 功能共用的入口：失败只回 ok:false，绝不抛
// onFail 用来把错误写进日志，方便排查"为什么今天不说话了"
function wbChat(opts) {
  return wbClient.chat(opts).catch((e) => ({
    ok: false, code: 'internal', message: String((e && e.message) || e),
    hint: '内部错误', retryable: false,
  }));
}

// ---------- 一键自动接好 ----------
// 现实情况：DeepSeek-V4.1-Flash 只跑在 WorkBuddy 自己的后端里，没有对外的 Key 可用。
// 所以"手填地址+密钥"这条路对普通使用场景太重了 —— 干脆把本机能用的接口自动探一遍。
const isLoopback = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/i.test(String(u || ''));

// 本机常见的中转/本地模型端口（连不上会立刻 ECONNREFUSED，不会卡住）
const LOCAL_PROBES = [
  'http://127.0.0.1:8787/v1',   // 本机 Codex 中转
  'http://127.0.0.1:11434/v1',  // Ollama
  'http://127.0.0.1:1234/v1',   // LM Studio
  'http://127.0.0.1:8000/v1',   // vLLM / 各类自建
];

// 从本机已有工具里找令牌（只用于 loopback 地址，绝不外发）。
// 顺手把 Codex 正在用的模型名记下来 —— 那是他机器上已经验证过能用的型号，比瞎猜靠谱。
function localHints() {
  const tokens = [];
  const push = (v, from) => { if (v && tokens.every((x) => x.token !== v)) tokens.push({ token: v, from }); };
  push(process.env.PET_WB_TOKEN, 'env');
  let model = '';
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    const m = /experimental_bearer_token\s*=\s*"([^"]+)"/.exec(cfg);
    if (m) push(m[1], 'codex');
    const mm = /^\s*model\s*=\s*"([^"]+)"/m.exec(cfg);
    if (mm) model = mm[1];
  } catch (_) {}
  try {
    const a = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
    if (a && a.OPENAI_API_KEY) push(String(a.OPENAI_API_KEY), 'codex-auth');
  } catch (_) {}
  return { tokens, model };
}

// 挑模型：优先用户的 DeepSeek-V4.1-Flash，其次本机已验证可用的型号，其次任何 deepseek（实现在 wb.js，好单测）
const pickModel = wb.pickModel;

async function autowire() {
  const saved = settings.ai || {};
  const { tokens, model: codexModel } = localHints();
  const cands = [];
  // 1) 已经填过的地址优先，尊重用户的选择
  if (saved.baseUrl) cands.push({ baseUrl: saved.baseUrl, apiKey: saved.apiKey || '', from: 'saved' });
  // 2) 本机端口 × 本机令牌（只给 loopback 带令牌）
  for (const base of LOCAL_PROBES) {
    for (const t of tokens) cands.push({ baseUrl: base, apiKey: t.token, from: t.from });
    cands.push({ baseUrl: base, apiKey: '', from: 'none' });   // 本地模型通常不校验 Key
  }

  const tried = await wbClient.discover(cands);
  const hit = tried.find((t) => t.ok && t.models.length);
  if (!hit) return { ok: false, tried, reason: 'no-endpoint' };

  const model = pickModel(hit.models, [saved.model, wb.DEFAULTS.model, codexModel]);
  const keepModel = String(saved.model || '') === model;
  const src = cands.find((c) => c.baseUrl === hit.baseUrl && c.from === hit.from);
  settings.ai = {
    baseUrl: hit.baseUrl,
    apiKey: (src && src.apiKey) || '',
    model,
    timeoutMs: Number(saved.timeoutMs) || wb.DEFAULTS.timeoutMs,
    maxRetries: Number.isFinite(Number(saved.maxRetries)) ? Number(saved.maxRetries) : wb.DEFAULTS.maxRetries,
  };
  wbClient.reset();
  saveSettings();
  refreshTray();

  const ping = await wbClient.ping();
  return {
    ok: ping.ok === true,
    baseUrl: hit.baseUrl,
    model,
    models: hit.models,
    from: hit.from,
    // 模型被换掉了要明确告诉用户，别悄悄改
    modelChanged: !keepModel,
    wantModel: wb.DEFAULTS.model,
    hasWantModel: hit.models.includes(wb.DEFAULTS.model),
    ping,
    tried,
  };
}
async function llmChat(messages) {
  const r = await wbChat({ messages, temperature: 0.7, maxTokens: 512 });
  if (!r.ok) return { ok: false, error: r.hint || r.message, code: r.code, detail: r.message };
  return { ok: true, text: r.text, usage: r.usage, model: r.model };
}
function parseJsonLoose(s) {
  if (!s) return null;
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}
function mimeFromPath(p) {
  const e = String(p).toLowerCase();
  if (e.endsWith('.png')) return 'image/png';
  if (e.endsWith('.webp')) return 'image/webp';
  if (e.endsWith('.gif')) return 'image/gif';
  if (e.endsWith('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}
async function extractCardFromFile(filePath) {
  if (!filePath) return { ok: false, error: '没拿到图片路径（请直接把图片文件拖到小猴身上）' };
  let b64;
  try { b64 = fs.readFileSync(filePath).toString('base64'); } catch (e) { return { ok: false, error: '读取图片失败：' + (e.message || e) }; }
  const prompt = '请从这张名片图片中抽取信息，只返回一个 JSON 对象，不要任何解释。字段：name(姓名)、company(公司)、title(职位)、phone(电话)、email(邮箱)、address(地址)、website(网址)。没有的字段用空字符串。';
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: 'data:' + mimeFromPath(filePath) + ';base64,' + b64 } },
    ],
  }];
  // 视觉请求慢，单独给更长超时；失败不影响小猴，只是这一次识别不出
  const r = await wbChat({ messages, temperature: 0, maxTokens: 600, timeoutMs: 40000 });
  if (!r.ok) {
    return {
      ok: false,
      error: (r.code === 'auth' || r.code === 'no-config')
        ? r.hint
        : '识别失败：' + (r.hint || r.message) + '（如果一直失败，可能是这个模型不支持图片输入）',
      code: r.code,
    };
  }
  const obj = parseJsonLoose(r.text);
  return { ok: true, data: obj || {}, raw: String(r.text || '') };
}
function speakText(text) {
  if (!settings.tts) return;
  if (!win) return;
  try { win.webContents.send('speak', String(text || '')); } catch (_) {}
}
const WEATHER_ZH = [
  ['sunny', '晴'], ['clear', '晴'], ['partly cloudy', '多云'], ['cloudy', '多云'],
  ['overcast', '阴'], ['mist', '薄雾'], ['fog', '雾'], ['smoky haze', '烟霾'], ['haze', '霾'],
  ['patchy rain', '零星小雨'], ['light rain', '小雨'], ['moderate rain', '中雨'], ['heavy rain', '大雨'],
  ['thundery', '雷阵雨'], ['sleet', '雨夹雪'], ['blizzard', '暴雪'], ['snow', '雪'], ['freezing', '冻雨'],
];
function zhDesc(en) {
  const s = String(en || '').toLowerCase();
  for (let i = 0; i < WEATHER_ZH.length; i++) if (s.includes(WEATHER_ZH[i][0])) return WEATHER_ZH[i][1];
  return String(en || '').trim();
}
async function getWeather(city) {
  try {
    const j = await httpJson('https://wttr.in/' + encodeURIComponent(city) + '?format=j1&lang=zh', {}, 12000);
    const cur = j && j.current_condition && j.current_condition[0];
    const today = j && j.weather && j.weather[0];
    const rawDesc = (cur && cur.lang_zh && cur.lang_zh[0] && cur.lang_zh[0].value) ||
      (cur && cur.weatherDesc && cur.weatherDesc[0] && cur.weatherDesc[0].value) || '';
    const desc = zhDesc(rawDesc);
    const t = cur ? cur.temp_C : '';
    const mx = today ? today.maxtempC : '';
    const mn = today ? today.mintempC : '';
    return { ok: true, text: `${city} ${mn}~${mx}℃ ${desc}（当前 ${t}℃）` };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
async function getNews() {
  // 1) V2EX 热帖（中文、技术向，接口稳定）
  try {
    const j = await httpJson('https://www.v2ex.com/api/topics/hot.json', { headers: { 'User-Agent': 'Mozilla/5.0' } }, 9000);
    if (Array.isArray(j) && j[0] && j[0].title) return { ok: true, text: String(j[0].title) };
  } catch (_) {}
  // 2) Hacker News 头条
  try {
    const ids = await httpJson('https://hacker-news.firebaseio.com/v0/topstories.json', {}, 9000);
    if (Array.isArray(ids) && ids[0]) {
      const it = await httpJson('https://hacker-news.firebaseio.com/v0/item/' + ids[0] + '.json', {}, 9000);
      if (it && it.title) return { ok: true, text: String(it.title) };
    }
  } catch (_) {}
  // 3) 微博热搜备用源
  const urls = ['https://api.vvhan.com/api/hotlist/wbHot', 'https://api.vvhan.com/api/hotlist/baiduRD'];
  for (const u of urls) {
    try {
      const j = await httpJson(u, {}, 8000);
      let arr = j && j.data;
      if (arr && !Array.isArray(arr) && Array.isArray(arr.data)) arr = arr.data;
      if (Array.isArray(arr) && arr.length) {
        const it = arr[0];
        const t = it.title || it.name || it.word || it.hot_word;
        if (t) return { ok: true, text: String(t) };
      }
    } catch (_) {}
  }
  return { ok: false };
}
async function morningReport(force) {
  const today = todayStr();
  if (!force && settings.lastReportDate === today) return;
  if (!win || !win.isVisible()) return;
  settings.lastReportDate = today;
  saveSettings();
  showBubble({ title: '每日早报', text: '正在获取天气和新闻…' }, 4000);
  const city = settings.city || '南京';
  const [w, n] = await Promise.all([getWeather(city), getNews()]);
  const lines = [
    w.ok ? w.text : city + ' 天气获取失败（网络或代理）',
    n.ok ? '今日热帖：' + n.text : '今日热帖获取失败',
  ];
  showBubble({ kind: 'lines', title: '每日早报', items: lines.map((t) => ({ text: t })) }, 12000);
  speakText(lines.join('。'));
}
function startMorningWatch() {
  const check = () => {
    if (!settings.morningReport) return;
    const d = new Date();
    const now = d.getHours() * 60 + d.getMinutes();
    const parts = String(settings.reportTime || '08:30').split(':').map(Number);
    const h = isNaN(parts[0]) ? 8 : parts[0];
    const m = isNaN(parts[1]) ? 30 : parts[1];
    if (now >= h * 60 + m && settings.lastReportDate !== todayStr()) morningReport(false);
  };
  setTimeout(check, 4000);
  setInterval(check, 60000);
}
// ---------- PDF 论文解析 ----------
// 借鉴 paper2gal.com 的解析管线：PDF → 拆章节 → 逐章理解。
// 我们停在"理解"这一步，把结果直接结构化输出（研究问题/方法/结论/贡献），不做游戏化。
const paper = require('./paper');
let paperWin = null;

function openPaperTool() {
  if (paperWin && !paperWin.isDestroyed()) { paperWin.show(); paperWin.focus(); return; }
  paperWin = new BrowserWindow({
    width: 800,
    height: 840,
    minWidth: 640,
    minHeight: 520,
    title: 'PDF 论文解析',
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  paperWin.loadFile('paper.html');
  paperWin.on('closed', () => { paperWin = null; });
}

function paperProgress(p) {
  if (paperWin && !paperWin.isDestroyed()) {
    try { paperWin.webContents.send('paper-progress', p); } catch (_) {}
  }
}

// 有 API Key 就走模型；没有就只用启发式（paper.js 里已经保证两条路径输出同构）
function paperLlm() {
  const ai = settings.ai || {};
  if (!ai.apiKey || !ai.baseUrl) return null;
  return async (messages, maxTokens) => {
    // 结构化抽取要稳，温度压到 0.2；超时放宽到 90s（长论文的 prompt 很大）
    const r = await wbChat({ messages, temperature: 0.2, maxTokens: maxTokens || 2000, timeoutMs: 90000 });
    if (!r.ok) return { ok: false, error: r.hint || r.message, code: r.code };
    return { ok: true, text: r.text };
  };
}

async function paperAnalyzeFile(filePath) {
  try {
    const result = await paper.analyze(filePath, { llm: paperLlm(), onProgress: paperProgress });
    emitEmotion(result.engine === 'llm' ? 'cheer' : 'thinking');
    return { ok: true, data: result };
  } catch (e) {
    emitEmotion('sad');
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 拖进来的文件在渲染进程里可能拿不到真实路径：落一份临时文件再解析
async function paperAnalyzeBytes(name, bytes) {
  const safe = String(name || 'paper.pdf').replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
  const tmp = path.join(os.tmpdir(), `pet-paper-${Date.now()}-${safe}`);
  try {
    fs.writeFileSync(tmp, Buffer.from(bytes));
    return await paperAnalyzeFile(tmp);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

// ---------- 功能说明 / 快捷键 ----------
function openUsage() {
  if (usageWin && !usageWin.isDestroyed()) { usageWin.show(); usageWin.focus(); return; }
  usageWin = new BrowserWindow({
    width: 780, height: 800, title: '功能说明 / 快捷键', resizable: true, autoHideMenuBar: true, backgroundColor: '#f6f7fa',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  usageWin.loadFile('usage.html');
  usageWin.on('closed', () => { usageWin = null; });
}
function openAiSettings() {
  if (aiWin && !aiWin.isDestroyed()) { aiWin.show(); aiWin.focus(); return; }
  aiWin = new BrowserWindow({
    width: 420, height: 620, title: 'AI 设置', resizable: true, autoHideMenuBar: true, backgroundColor: '#f6f7fa',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  aiWin.loadFile('settings.html');
  aiWin.on('closed', () => { aiWin = null; });
}
function openChat() {
  if (chatWin && !chatWin.isDestroyed()) { chatWin.show(); chatWin.focus(); return; }
  chatWin = new BrowserWindow({
    width: 420, height: 560, title: '和小猴聊天', resizable: true, autoHideMenuBar: true, backgroundColor: '#f6f7fa',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  chatWin.loadFile('chat.html');
  chatWin.on('closed', () => { chatWin = null; });
}
function openCardWindow() {
  if (cardWin && !cardWin.isDestroyed()) { cardWin.show(); cardWin.focus(); return cardWin; }
  cardWin = new BrowserWindow({
    width: 440, height: 560, title: '名片识别', resizable: true, autoHideMenuBar: true, backgroundColor: '#f6f7fa',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  cardWin.loadFile('card.html');
  cardWin.on('closed', () => { cardWin = null; });
  return cardWin;
}
function sendCard(w, payload) {
  if (!w || w.isDestroyed()) return;
  const doSend = () => { try { w.webContents.send('card-data', payload); } catch (_) {} };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', doSend); else doSend();
}
async function runCardExtraction(filePath) {
  const w = openCardWindow();
  sendCard(w, { loading: true });
  const res = await extractCardFromFile(filePath);
  if (res.ok) {
    sendCard(w, { loading: false, data: res.data, raw: res.raw });
    emitEmotion('cheer');
    speakText('名片识别完成');
  } else {
    sendCard(w, { loading: false, error: res.error });
  }
}
async function pickCardImage() {
  try {
    const opts = {
      title: '选择名片图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (!r.canceled && r.filePaths && r.filePaths[0]) runCardExtraction(r.filePaths[0]);
  } catch (_) {}
}
function aiSettingsView() {
  return {
    ai: settings.ai || { baseUrl: '', apiKey: '', model: wb.DEFAULTS.model, timeoutMs: wb.DEFAULTS.timeoutMs, maxRetries: wb.DEFAULTS.maxRetries },
    status: wbClient.status(),
    city: settings.city || '南京',
    tts: !!settings.tts,
    morningReport: !!settings.morningReport,
    reportTime: settings.reportTime || '08:30',
  };
}
function saveAiSettings(cfg) {
  cfg = cfg || {};
  const ai = cfg.ai || {};
  settings.ai = {
    baseUrl: String(ai.baseUrl || '').trim(),
    // 自动接入后界面上不回显密钥，这时传的是 undefined —— 保留原来的，别把人家的 Key 洗掉
    apiKey: ai.apiKey === undefined ? String((settings.ai && settings.ai.apiKey) || '') : String(ai.apiKey || '').trim(),
    model: String(ai.model || wb.DEFAULTS.model).trim() || wb.DEFAULTS.model,
    timeoutMs: Math.max(5000, Math.min(Number(ai.timeoutMs) || wb.DEFAULTS.timeoutMs, 180000)),
    maxRetries: Math.max(0, Math.min(Number(ai.maxRetries) || 0, 4)),
  };
  settings.city = String(cfg.city || '南京').trim() || '南京';
  settings.tts = !!cfg.tts;
  settings.morningReport = !!cfg.morningReport;
  settings.reportTime = /^\d{1,2}:\d{2}$/.test(cfg.reportTime) ? cfg.reportTime : '08:30';
  // 用户刚改完配置，之前累计的失败次数和熔断状态必须清掉，
  // 否则"填对了 Key 还要干等 45 秒"会让人以为没生效
  wbClient.reset();
  saveSettings();
  refreshTray();
  return aiSettingsView();
}

// ---------- 气泡窗口 ----------
let bubbleTimer = null;
function ensureBubble() {
  if (bubbleWin) return bubbleWin;
  bubbleWin = new BrowserWindow({
    width: BUBBLE_W,
    height: 110,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  bubbleWin.setAlwaysOnTop(true, 'pop-up-menu');
  try { bubbleWin.setIgnoreMouseEvents(true); } catch (_) {}
  bubbleWin.loadFile('bubble.html');
  bubbleWin.on('closed', () => { bubbleWin = null; });
  return bubbleWin;
}
function hideBubble() {
  clearTimeout(bubbleTimer);
  try { if (bubbleWin) bubbleWin.hide(); } catch (_) {}
}
function bubbleHeight(p) {
  if (p && p.kind === 'list') return Math.min(250, 96 + (p.items ? p.items.length : 0) * 22);
  if (p && p.kind === 'lines') return Math.min(250, 84 + (p.items ? p.items.length : 0) * 22);
  if (p && p.kind === 'stats') return 140;
  return 108;
}
function showBubble(payload, ms = 4000) {
  if (!win || !win.isVisible()) return;
  const bw = ensureBubble();
  const h = bubbleHeight(payload);
  const pb = win.getBounds();
  const wa = workAreaFor(pb);
  let x = Math.round(pb.x + pb.width / 2 - BUBBLE_W / 2);
  let y = pb.y - h + 6;
  let below = false;
  if (y < wa.y + 4) { y = pb.y + pb.height - 6; below = true; }
  x = clamp(x, wa.x + 4, wa.x + wa.width - BUBBLE_W - 4);
  y = clamp(y, wa.y + 4, Math.max(wa.y + 4, wa.y + wa.height - h - 4));
  try { bw.setBounds({ x, y, width: BUBBLE_W, height: h }); } catch (_) {}
  const data = Object.assign({ below }, payload || {});
  const send = () => { try { bw.webContents.send('bubble', data); } catch (_) {} };
  if (bw.webContents.isLoading()) bw.webContents.once('did-finish-load', send); else send();
  try { bw.showInactive(); } catch (_) {}
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { try { if (bubbleWin) bubbleWin.hide(); } catch (_) {} }, ms);
}

// ---------- 情绪菜单（双击触发）----------
const EMOTIONS = [
  ['angry', '生气'], ['cheer', '开心'], ['love', '喜欢'],
  ['sad', '难过'], ['shy', '害羞'], ['sleepy', '困了'],
  ['surprised', '惊讶'], ['thinking', '思考'], ['wink', '眨眼'],
];
function emitEmotion(name) {
  if (win) { try { win.webContents.send('emotion', name); } catch (_) {} }
}

// 自绘表情面板（原生 Menu 在这台机器上收不到点击，改为 HTML 窗口，点击更可靠）
let emotionWin = null;
function closeEmotionPicker() {
  if (emotionWin && !emotionWin.isDestroyed()) {
    try { emotionWin.close(); } catch (_) {}
  }
  emotionWin = null;
}
function openEmotionPicker() {
  if (!win || win.isDestroyed()) return;
  if (emotionWin && !emotionWin.isDestroyed()) { closeEmotionPicker(); return; }

  const b = win.getBounds();
  const W = 214, H = 236;
  const wa = screen.getDisplayMatching(b).workArea;
  let x = b.x + b.width + 8;
  if (x + W > wa.x + wa.width) x = b.x - W - 8;
  x = clamp(x, wa.x + 4, wa.x + wa.width - W - 4);
  const y = clamp(b.y + Math.round(b.height / 2) - Math.round(H / 2), wa.y + 4, wa.y + wa.height - H - 4);

  emotionWin = new BrowserWindow({
    x, y, width: W, height: H,
    frame: false, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  emotionWin.setAlwaysOnTop(true, 'pop-up-menu');
  emotionWin.loadFile('emotion.html');

  // 刚创建时可能先触发一次 blur，400ms 后才允许"点外面关闭"
  let armed = false;
  setTimeout(() => { armed = true; }, 400);
  emotionWin.on('blur', () => { if (armed) closeEmotionPicker(); });
  emotionWin.on('closed', () => { emotionWin = null; });
}

// ---------- 行为开关 ----------
function toggleVisibility() {
  if (!win) return;
  if (win.isVisible()) { win.hide(); hideBubble(); }
  else { win.show(); win.setAlwaysOnTop(true, 'pop-up-menu'); }
  refreshTray();
}
function setClickThrough(on) {
  settings.clickThrough = !!on;
  saveSettings();
  if (win) {
    lastIgnore = !settings.clickThrough;   // 强制下一次 setIgnore 生效
    setIgnore(settings.clickThrough);
    win.webContents.send('clickthrough-state', settings.clickThrough);
    // 开启后小猴就点不动了，必须明确告诉用户怎么关，否则会以为"坏了"
    showBubble(settings.clickThrough
      ? { title: '已开启点击穿透', text: '鼠标会直接穿过小猴。\n再按 Ctrl+Shift+P，或用托盘菜单关闭' }
      : { title: '已关闭点击穿透', text: '小猴又能拖、能点啦' }, 4500);
  }
  refreshTray();
}
// 抽烟 / 喝酒（30 秒随机动作）
function doAction(type) {
  if (win) { try { win.webContents.send('do-action', type); } catch (_) {} }
}

// 空闲自主状态（环顾 / 换表情 / 小跳）
function setAutoMood(on) {
  settings.autoMood = !!on;
  saveSettings();
  if (win) { try { win.webContents.send('auto-mood', settings.autoMood); } catch (_) {} }
  refreshTray();
}
// 自己散步（走动是主进程推窗口，所以开关也放在主进程）
function setWander(on) {
  settings.wander = !!on;
  saveSettings();
  if (!settings.wander) endWalk();
  refreshTray();
}
// 手动指定一个动作（菜单里的"做个动作"）
function playGesture(id) {
  if (!id) return;
  if (win) { try { win.webContents.send('play-gesture', id); } catch (_) {} }
}
function gestureMenu() {
  const clips = (characterProfile && characterProfile.clips) || [];
  return clips
    .filter((c) => !(Array.isArray(c.tags) && c.tags.includes('reaction')))
    .map((c) => ({ label: c.label || c.id, click: () => playGesture(c.id) }));
}
function setOpenAtLogin(on) {  settings.openAtLogin = !!on;
  saveSettings();
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.openAtLogin,
      path: app.getPath('exe'),
      args: process.defaultApp ? [app.getAppPath(), '--no-sandbox'] : ['--no-sandbox'],
    });
  } catch (_) {}
  refreshTray();
}

// ---------- 菜单 ----------
function quitApp() {
  isQuitting = true;
  try { if (win) win.destroy(); } catch (_) {}
  app.quit();
}
function menuTemplate() {
  const t = [];
  t.push({ label: win && win.isVisible() ? '隐藏小猴' : '显示小猴', click: toggleVisibility });
  t.push({ type: 'separator' });
  t.push({ label: focusActive() ? '停止专注' : '开始专注 25 分钟', click: toggleFocus });
  t.push({ label: '今日待办…（编辑）', click: openTodoEditor });
  t.push({ label: '查看今日待办', click: () => showTodayTasksBubble(9000) });
  t.push({
    label: `未完成提醒（每 ${DAILY_REMIND_MIN} 分钟）`,
    type: 'checkbox',
    checked: settings.dailyRemind !== false,
    click: () => setDailyRemind(!(settings.dailyRemind !== false)),
  });
  t.push({ label: '现在提醒一次', click: () => { lastDailyRemindAt = 0; dailyTick(); } });
  t.push({
    label: settings.mutedDate === todayStr() ? '今天已不再提醒' : '今天不再提醒',
    enabled: settings.mutedDate !== todayStr(),
    click: muteToday,
  });
  t.push({ type: 'separator' });
  t.push({ label: '课程/日程…（编辑）', click: openScheduleEditor });
  t.push({ label: '查看今日课程', click: showTodayCoursesBubble });
  t.push({ type: 'separator' });
  t.push({ label: '剪贴板历史…', click: openClipboard });
  t.push({ label: '系统状态（CPU/内存/网速）', click: showStats });
  t.push({ type: 'separator' });
  t.push({ label: 'AI 对话…', click: openChat });
  t.push({ label: '识别名片图片…', click: pickCardImage });
  t.push({ label: '解析 PDF 论文…', click: openPaperTool });
  t.push({ label: '每日早报', click: () => morningReport(true) });
  t.push({ label: 'AI 设置…', click: openAiSettings });
  t.push({ type: 'separator' });
  t.push({ label: '点击穿透（鼠标可穿过小猴）', type: 'checkbox', checked: !!settings.clickThrough, click: () => setClickThrough(!settings.clickThrough) });
  t.push({ label: '防打扰（全屏时自动隐藏）', type: 'checkbox', checked: !!settings.antiDisturb, click: () => setAntiDisturb(!settings.antiDisturb) });
  t.push({ label: '开机自启', type: 'checkbox', checked: !!settings.openAtLogin, click: () => setOpenAtLogin(!settings.openAtLogin) });
  t.push({ label: '自动表情（空闲时自己换状态）', type: 'checkbox', checked: settings.autoMood !== false, click: () => setAutoMood(!(settings.autoMood !== false)) });
  t.push({ label: '自己散步（空闲时在桌面上走动）', type: 'checkbox', checked: settings.wander !== false, click: () => setWander(!(settings.wander !== false)) });
  t.push({ label: '走两步', click: () => startWander() });
  {
    const gm = gestureMenu();
    if (gm.length) t.push({ label: '做个动作', submenu: gm });
  }
  t.push({ type: 'separator' });
  t.push({ label: '抽支烟（随机：复活 / 忧郁，30 秒）', click: () => doAction('smoke') });
  t.push({ label: '喝一杯（随机：醉拳 / 大睡，30 秒）', click: () => doAction('drink') });
  t.push({ type: 'separator' });
  t.push({ label: '功能说明 / 快捷键', click: openUsage });
  t.push({ label: '退出', click: quitApp });
  return t;
}
function refreshTray() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}
function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icons', 'monkey.ico'));
    tray.setToolTip('小猴桌宠');
    tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
    tray.on('double-click', toggleVisibility);
  } catch (_) { tray = null; }
}
function petContextMenu() {
  Menu.buildFromTemplate(menuTemplate()).popup(win);
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.on('stop-walk', () => endWalk());
  ipcMain.on('drag-start', () => startDrag());
  ipcMain.on('drag-end', () => endDrag());
  ipcMain.on('zoom-by', (_e, factor) => {
    if (!win) return;
    const nz = clamp((settings.zoom || 1) * factor, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(nz - (settings.zoom || 1)) < 1e-3) return;
    settings.zoom = nz; saveSettings();
    animateZoomTo(nz);
    win.webContents.send('zoom-state', nz);
  });
  ipcMain.on('show-context-menu', () => petContextMenu());
  ipcMain.on('show-emotion-menu', () => openEmotionPicker());
  ipcMain.on('refresh-facing', () => sendCursor(true));
  ipcMain.on('pick-emotion', (_e, name) => { if (name) emitEmotion(String(name)); closeEmotionPicker(); });
  ipcMain.on('close-emotion', () => closeEmotionPicker());

  // 渲染端切帧时上报当前帧 key，供主进程做像素命中判定
  ipcMain.on('frame', (_e, key) => { if (key) currentFrameKey = String(key); });
  ipcMain.on('debug', (_e, m) => console.log('[renderer] ' + m));
  ipcMain.on('focus-toggle', () => toggleFocus());
  ipcMain.on('open-todo-editor', () => openTodoEditor());
  ipcMain.handle('get-todos', () => todoData());
  ipcMain.handle('save-todos', (_e, items) => {
    // 兼容旧的纯文本接口：把传来的清单当成"今天新建的任务"补进去（已存在的不重复）
    const today = todayStr();
    const cur = daily.onDate(dstore(), today).map((i) => i.task.title);
    (Array.isArray(items) ? items : []).forEach((t) => {
      const title = String((t && t.text) || '').trim();
      if (title && !cur.includes(title)) daily.addTask(dstore(), { title }, today);
    });
    dailyChanged();
    return todoData();
  });

  // ---------- 每日任务 ----------
  ipcMain.handle('daily-get', () => dailyState());
  ipcMain.handle('daily-add', (_e, input) => {
    daily.addTask(dstore(), input || {}, todayStr());
    dailyChanged();
    return dailyState();
  });
  ipcMain.handle('daily-update', (_e, ref, patch) => {
    daily.updateTask(dstore(), ref, patch || {});
    dailyChanged();
    return dailyState();
  });
  ipcMain.handle('daily-toggle', (_e, ref, done) => {
    daily.setDone(dstore(), ref, done, todayStr());
    dailyChanged();
    return dailyState();
  });
  ipcMain.handle('daily-remove', (_e, ref) => {
    daily.removeTask(dstore(), ref);
    dailyChanged();
    return dailyState();
  });
  ipcMain.handle('daily-remind-set', (_e, patch) => {
    const p = patch || {};
    if ('on' in p) setDailyRemind(!!p.on);
    if (Number.isFinite(+p.from)) settings.remindFrom = clamp(+p.from, 0, 24);
    if (Number.isFinite(+p.to)) settings.remindTo = clamp(+p.to, 0, 24);
    if ('on' in p || 'from' in p || 'to' in p) { saveSettings(); refreshTray(); }
    return dailyState();
  });
  ipcMain.handle('daily-mute-today', () => { muteToday(); return dailyState(); });
  ipcMain.handle('daily-remind-now', () => {
    lastDailyRemindAt = 0;
    const blocked = remindBlockedReason();
    if (blocked) { showTodayTasksBubble(9000); return { ok: true, blocked }; }
    dailyTick();
    return { ok: true, blocked: '' };
  });

  ipcMain.on('open-clipboard', () => openClipboard());
  ipcMain.on('pick-clip', (_e, i) => pickClip(i));
  ipcMain.on('clear-clip', () => clearClip());
  ipcMain.handle('get-clip', () => clipHistory);

  ipcMain.on('show-stats', () => showStats());

  ipcMain.on('open-schedule', () => openScheduleEditor());
  ipcMain.on('show-today-courses', () => showTodayCoursesBubble());
  ipcMain.handle('get-schedule', () => scheduleData());
  ipcMain.handle('save-schedule', (_e, data) => saveSchedule(data));

  ipcMain.handle('get-ai-settings', () => aiSettingsView());
  ipcMain.handle('save-ai-settings', (_e, cfg) => saveAiSettings(cfg));
  ipcMain.handle('llm-chat', (_e, messages) => llmChat(messages));
  // 连接自检：把真实错误码（auth / model-not-found / network …）回给设置页，
  // 而不是笼统一句"测试失败"
  ipcMain.handle('wb-test', async (_e, cfg) => {
    if (cfg && cfg.ai) {
      // 允许用"还没保存的"配置先测，省得来回存
      const keep = settings.ai;
      settings.ai = Object.assign({}, keep, {
        baseUrl: String(cfg.ai.baseUrl || '').trim(),
        // 界面不回显密钥时传的是 undefined，沿用已保存的
        apiKey: cfg.ai.apiKey === undefined ? String((keep && keep.apiKey) || '') : String(cfg.ai.apiKey || '').trim(),
        model: String(cfg.ai.model || wb.DEFAULTS.model).trim(),
      });
      wbClient.reset();
      try { return await wbClient.ping(); } finally { settings.ai = keep; wbClient.reset(); }
    }
    return wbClient.ping();
  });
  ipcMain.handle('wb-status', () => wbClient.status());
  // 一键自动接好：探本机可用接口 → 存配置 → 立刻 ping 一次
  ipcMain.handle('wb-autowire', async () => {
    try { return await autowire(); }
    catch (e) { return { ok: false, reason: 'error', message: String((e && e.message) || e), tried: [] }; }
  });
  ipcMain.on('open-ai-settings', () => openAiSettings());
  ipcMain.on('open-chat', () => openChat());
  ipcMain.on('open-paper', () => openPaperTool());
  ipcMain.handle('paper-pick', async () => {
    const r = await dialog.showOpenDialog(paperWin || null, {
      title: '选择 PDF 论文',
      filters: [{ name: 'PDF 论文', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0], name: path.basename(r.filePaths[0]) };
  });
  ipcMain.handle('paper-analyze', async (_e, payload) => {
    const p = payload || {};
    if (p.path) return paperAnalyzeFile(p.path);
    if (p.bytes) return paperAnalyzeBytes(p.name, p.bytes);
    return { ok: false, error: '没有拿到文件' };
  });
  ipcMain.handle('paper-save', async (_e, payload) => {
    const p = payload || {};
    const r = await dialog.showSaveDialog(paperWin || null, {
      title: '导出解析结果',
      defaultPath: p.name || 'paper-analysis.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r.filePath, String(p.text || ''), 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.on('extract-card', (_e, p) => runCardExtraction(p));
  ipcMain.on('speak', (_e, t) => speakText(t));
  ipcMain.on('morning-report', () => morningReport(true));
}

function shotMode() {
  const out = process.env.PET_SHOT;
  if (!out) return;
  // 放大到 2 倍再截，保证清晰度
  setTimeout(() => {
    try {
      const { w, h } = sizeForZoom(2);
      unlockSize();
      win.setBounds({ x: 200, y: 150, width: w, height: h });
      lockSize(w, h);
    } catch (_) {}
  }, 700);
  setTimeout(async () => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out, img.toPNG());
      const s = img.getSize();
      console.log('[shot] wrote ' + out + ' ' + s.width + 'x' + s.height);
    } catch (e) {
      console.log('[shot] err ' + (e && e.message));
    }
    if (process.env.PET_SHOT_EXIT) app.quit();
  }, 2600);
}

// 自动化拖拽测试：往页面注入鼠标事件，验证 渲染端手势 -> IPC -> 主进程移动 整条链路
async function testDrag() {
  await sleep(1800);
  if (!win) return;
  const b0 = win.getBounds();
  const p = screen.getCursorScreenPoint();
  // 把窗口挪到光标下面，保证"光标正好在小猴身体中心"
  win.setPosition(Math.round(p.x - b0.width / 2), Math.round(p.y - b0.height / 2));
  await sleep(300);
  const b = win.getBounds();
  const cx = Math.round(b.width / 2);
  const cy = Math.round(b.height / 2);
  console.log('[dragtest] cursor=' + JSON.stringify(p) + ' before=' + JSON.stringify(b) + ' ignore=' + lastIgnore + ' frame=' + currentFrameKey);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
  await sleep(160);
  for (let i = 1; i <= 6; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: cx + i * 14, y: cy + i * 9, button: 'left' });
    await sleep(70);
  }
  await sleep(320);
  console.log('[dragtest] during=' + JSON.stringify(win.getBounds()) + ' isDragging=' + isDragging);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: cx + 84, y: cy + 54, button: 'left', clickCount: 1 });
  await sleep(250);
  console.log('[dragtest] after=' + JSON.stringify(win.getBounds()) + ' isDragging=' + isDragging);
  if (process.env.PET_TEST_EXIT) app.exit(0);
}

// ---------- 主窗口 ----------
// 自动化走动测试：验证 主进程推窗口 -> walk-step 下发 -> 渲染层步频 这条链路真的通了
// 用法：PET_TEST_WALK=<日志路径> PET_SETTINGS_PATH=<临时设置> electron . --user-data-dir=<临时目录>
async function testWalk() {
  const out = process.env.PET_TEST_WALK;
  await sleep(2200);
  if (!win) { console.log('[walk] no window'); app.exit(1); return; }
  const lines = [];
  const b0 = win.getBounds();
  lines.push('before x=' + b0.x + ' y=' + b0.y + ' ' + b0.width + 'x' + b0.height);
  const target = b0.x - 260;                       // 往左走一段
  const ok = startWalkTo(target);
  lines.push('started=' + ok + ' target=' + target);
  const t0 = Date.now();
  let lastX = b0.x, lastY = b0.y, drift = 0;
  let sampled = 0;
  const probe = async (tag) => {
    try {
      const dbg = await win.webContents.executeJavaScript(
        'JSON.stringify({steps: Math.round(window.__petAnim.stepCount*100)/100,' +
        ' phase: Math.round((window.__petAnim.stepCount%1)*100)/100,' +
        ' dist: Math.round(window.__petAnim.walkDistance),' +
        ' walking: window.__petAnim.walking, state: window.__petAnim.state,' +
        ' frame: window.__petAnim.pose.frame,' +
        ' rot: Math.round(window.__petAnim.pose.rot*100)/100,' +
        ' dy: Math.round(window.__petAnim.pose.dy*10000)/10000})');
      lines.push(tag + ' renderer=' + dbg);
      if (process.env.PET_TEST_WALK_SHOTS) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.resolve(process.env.PET_TEST_WALK) + '.' + tag + '.png', img.toPNG());
        lines.push(tag + ' shot=' + img.getSize().width + 'x' + img.getSize().height);
      }
    } catch (e) { lines.push(tag + ' renderer_err=' + (e && e.message)); }
  };
  while (Date.now() - t0 < 4200) {
    await sleep(120);
    const nb = win.getBounds();
    if (nb.y !== lastY) { drift++; lastY = nb.y; }
    lines.push('t=' + (Date.now() - t0) + ' x=' + nb.x + ' dx=' + (nb.x - lastX));
    lastX = nb.x;
    // 走动过程中取样：走完相位会被清零，只有中途读才看得到脚步。
    // 间隔取 1/4 步周期，才能截到"抬脚最高"和"落脚最低"两个极端姿态。
    if (sampled < 6 && Date.now() - t0 > 300 + sampled * 130) {
      await probe('mid' + sampled);
      sampled++;
    }
  }
  const bf = win.getBounds();
  await probe('after');
  lines.push('stats starts=' + walkStats.starts + ' steps=' + walkStats.steps);
  lines.push('moved=' + (bf.x - b0.x) + ' walkRun=' + (walkRun ? 'active' : 'ended'));
  lines.push('y_unchanged=' + (bf.y === b0.y) + ' y_drift_events=' + drift + ' y0=' + b0.y + ' y1=' + bf.y);
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log('[walk] wrote ' + out);
  app.exit(0);
}

// 批量动作采样：PET_TEST_CLIPS=a,b,c 依次播放并各截 N 帧，用来肉眼比对
// "动作到底有没有在动 / 动得像不像它自己那个名字"。单测只能证明数值变了，
// 证明不了看的人能认出来。
async function testClips() {
  const ids = String(process.env.PET_TEST_CLIPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const out = process.env.PET_TEST_CLIPS_OUT || 'clips';
  const N = Math.max(2, Number(process.env.PET_TEST_CLIPS_N || 4));
  await sleep(2000);
  if (!win) { app.exit(1); return; }
  const durs = {};
  ((characterProfile && characterProfile.clips) || []).forEach((c) => { durs[c.id] = c.dur || 1200; });
  for (const id of ids) {
    const dur = durs[id] || 1200;
    const step = Math.max(90, Math.round(dur / (N + 1)));
    await win.webContents.executeJavaScript(
      'window.__petAnim.cancel(); window.__petAnim.play(' + JSON.stringify(id) + ', {force:true});');
    for (let i = 0; i < N; i++) {
      await sleep(step);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out + '_' + id + '_' + i + '.png', img.toPNG());
    }
    console.log('[clips] ' + id + ' dur=' + dur + ' step=' + step);
  }
  app.exit(0);
}

// 定格取帧：PET_TEST_STRIP=a,b,c + PET_TEST_STRIP_T=0,0.2,0.4...
// 按归一化时间直接定格，不跟时钟赛跑。用来做"每个动作到底长什么样"的对比图，
// 快频动作（抖一抖 0.9 秒抖 7 个来回）靠按时间截图是对不准相位的。
async function testStrip() {
  const ids = String(process.env.PET_TEST_STRIP || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ts = String(process.env.PET_TEST_STRIP_T || '0,0.2,0.4,0.6,0.8,1').split(',')
    .map((s) => Number(s.trim())).filter((v) => isFinite(v));
  const out = process.env.PET_TEST_STRIP_OUT || 'strip';
  await sleep(2000);
  if (!win) { app.exit(1); return; }
  for (const id of ids) {
    let ok = 0;
    for (let i = 0; i < ts.length; i++) {
      const r = await win.webContents.executeJavaScript(
        'window.__petStrip(' + JSON.stringify(id) + ', ' + ts[i] + ')');
      if (!r) break;
      await sleep(300);   // 等切帧的透明度过渡走完（.f 是 .24s 交叉淡入）
      const img = await win.webContents.capturePage();
      fs.writeFileSync(out + '_' + id + '_' + i + '.png', img.toPNG());
      ok++;
    }
    console.log('[strip] ' + id + ' ' + ok + '/' + ts.length);
  }
  app.exit(0);
}

// 自动化动作测试：PET_TEST_CLIP=<动作 id> 在真机上播一次并采样姿态，
// 用来确认"动作表 -> 引擎 -> DOM"这条链在渲染层真的成立（单测只覆盖到引擎）。
async function testClip() {
  const id = process.env.PET_TEST_CLIP;
  await sleep(2000);
  if (!win) { app.exit(1); return; }
  const lines = [];
  const started = await win.webContents.executeJavaScript(
    'window.__petAnim.play(' + JSON.stringify(id) + ', {force:true})');
  lines.push('play(' + id + ')=' + started);
  for (let i = 0; i < 16; i++) {
    await sleep(80);
    const s = await win.webContents.executeJavaScript(
      'JSON.stringify({clip: window.__petAnim.clipId, state: window.__petAnim.state,' +
      ' frame: window.__petAnim.pose.frame,' +
      ' dy: Math.round(window.__petAnim.pose.dy*10000)/10000,' +
      ' rot: Math.round(window.__petAnim.pose.rot*100)/100,' +
      ' sy: Math.round(window.__petAnim.pose.sy*10000)/10000,' +
      // 头层：引擎算出来的值 + DOM 上真正生效的 transform，两样都要看。
      // 只看引擎值证明不了"头真的转了"（可能 CSS 没接上），只看 DOM 又不知道是谁写的。
      ' headRot: Math.round((window.__petAnim.pose.headRot||0)*10)/10,' +
      ' headSy: Math.round((window.__petAnim.pose.headSy===undefined?1:window.__petAnim.pose.headSy)*1000)/1000,' +
      ' headOn: document.body.classList.contains("head-on"),' +
      ' headTf: (document.getElementById("head").style.transform||"none")})');
    lines.push('t=' + (i * 80) + ' ' + s);
  }
  console.log('[clip] ' + lines.join('\n[clip] '));
  app.exit(0);
}

// 自动化点击测试：PET_TEST_TAP=head|body，注入一次不移动的点击，
// 验证"命中盒 -> 分区反应"这条链（点头摸头、点身子被戳）。
async function testTap() {
  const zone = process.env.PET_TEST_TAP;
  await sleep(2000);
  if (!win) { app.exit(1); return; }
  const b = win.getBounds();
  const cx = Math.round(b.width / 2);
  const cy = Math.round(b.height * (zone === 'head' ? 0.26 : 0.80));
  const lines = ['zone=' + zone + ' click@' + cx + ',' + cy];
  win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
  await sleep(60);
  win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
  for (let i = 0; i < 8; i++) {
    await sleep(90);
    const s = await win.webContents.executeJavaScript(
      'JSON.stringify({clip: window.__petAnim.clipId, state: window.__petAnim.state,' +
      ' frame: window.__petAnim.pose.frame, sy: Math.round(window.__petAnim.pose.sy*10000)/10000})');
    lines.push('t=' + (i * 90) + ' ' + s);
  }
  console.log('[tap] ' + lines.join('\n[tap] '));
  app.exit(0);
}

function createWindow() {
  const z = clamp(settings.zoom || 1, ZOOM_MIN, ZOOM_MAX);
  const init = sizeForZoom(z);
  win = new BrowserWindow({
    width: init.w,
    height: init.h,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const startHidden = process.argv.includes('--hidden');
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.send('auto-mood', settings.autoMood !== false); } catch (_) {}
  });
  win.loadFile('index.html');
  win.setAlwaysOnTop(true, 'pop-up-menu');

  // 自动化测试时把渲染层的 console / 崩溃原因落盘。
  // 渲染层一旦抛错，画面只会静默不动，光看主进程日志根本查不出来。
  if (process.env.PET_TEST_WALK) {
    const clog = path.resolve(process.env.PET_TEST_WALK) + '.console.log';
    const put = (s) => { try { fs.appendFileSync(clog, s + '\n'); } catch (_) {} };
    put('--- load ' + new Date().toISOString());
    win.webContents.on('console-message', (_e, level, message) => put('[' + level + '] ' + message));
    win.webContents.on('render-process-gone', (_e, d) => put('[gone] ' + JSON.stringify(d)));
    win.webContents.on('preload-error', (_e, p, err) => put('[preload] ' + p + ' ' + (err && err.message)));
    win.webContents.on('did-fail-load', (_e, code, desc) => put('[fail] ' + code + ' ' + desc));
  }

  try {
    const wa = screen.getPrimaryDisplay().workArea;
    let x, y;
    if (settings.pos && Number.isFinite(settings.pos.x) && Number.isFinite(settings.pos.y)) {
      x = clamp(settings.pos.x, wa.x - 40, wa.x + wa.width - 80);
      y = clamp(settings.pos.y, wa.y - 20, wa.y + wa.height - 60);
    } else {
      x = wa.x + wa.width - init.w - 24;
      y = wa.y + wa.height - init.h - 24;
    }
    win.setPosition(Math.round(x), Math.round(y));
  } catch (_) {}

  { const [cw, ch] = win.getSize(); lockSize(cw, ch); }

  win.on('closed', () => {
    if (facingTimer) clearInterval(facingTimer);
  });

  // 关闭（Alt+F4 等）默认只"隐藏"，从托盘能叫回来；只有托盘"退出"才真正结束进程。
  // 避免误触关闭就整个程序消失。
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    try { win.hide(); } catch (_) {}
    hideBubble();
    refreshTray();
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    logCrash('render-process-gone', JSON.stringify(details));
    try { win.reload(); } catch (_) {}   // 页面进程挂掉时自动重载，而不是整只消失
  });

  // 测试朝向时不要用真实光标覆盖注入值
  if (!process.env.PET_TEST_GAZE) facingTimer = setInterval(sendCursor, POLL_MS);
  if (startHidden) win.hide();

  if (process.env.PET_DEBUG) {
    setTimeout(() => {
      try {
        console.log('[debug] visible=' + win.isVisible() + ' bounds=' + JSON.stringify(win.getBounds()) +
          ' displays=' + JSON.stringify(screen.getAllDisplays().map((d) => d.bounds)));
      } catch (e) { console.log('[debug] err ' + e.message); }
    }, 2500);
  }
}

// ---------- 单实例锁 ----------
// 自动化测试要能和"正在跑的那只桌宠"同时存在：否则锁会让测试进程立刻静默退出，
// 屏幕上什么都没有、日志也没有一行 —— 排查起来特别像"启动就崩"。
const TEST_ENV = [
  'PET_TEST_CLIPS', 'PET_TEST_CLIP', 'PET_TEST_WALK', 'PET_TEST_DRAG',
  'PET_TEST_TAP', 'PET_TEST_EMOTION', 'PET_TEST_RECT', 'PET_TEST_SHOTS', 'PET_TEST_ACTION',
  'PET_TEST_STRIP',
];
const testRun = TEST_ENV.some((k) => !!process.env[k]);
const gotTheLock = testRun ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // 让用户明确知道"不是闪退，是小猴已经在跑了"
    emitEmotion('wink');
    showBubble({ title: '小猴', text: '我在这儿～ 已经有一只啦，不用再开' }, 3200);
  });

  app.whenReady().then(() => {
    try { app.setAppUserModelId('com.monkeypet.app'); } catch (_) {}
    loadSettings();
    dstore();            // 预热每日任务（顺带完成旧待办的迁移）
    logCrash('boot', 'pid=' + process.pid + ' argv=' + process.argv.slice(1).join(' '));
    createWindow();
    shotMode();
    createTray();
    // 有托盘就从小任务栏里移除，避免误点任务栏"关闭窗口"把程序关掉
    if (tray) { try { win.setSkipTaskbar(true); } catch (_) {} }
    setInterval(hitTick, 30);   // 像素命中判定：20~33fps 校正一次
    if (process.env.PET_TEST_DRAG) testDrag();
    if (process.env.PET_TEST_WALK) testWalk();
    if (process.env.PET_TEST_CLIP) testClip();
    if (process.env.PET_TEST_CLIPS) testClips();
    if (process.env.PET_TEST_STRIP) testStrip();
    if (process.env.PET_TEST_TAP) testTap();
    if (process.env.PET_TEST_EMOTION) {
      setTimeout(() => emitEmotion('angry'), 2200);
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.PET_TEST_EMOTION, img.toPNG());
          console.log('[emo] captured ' + process.env.PET_TEST_EMOTION);
        } catch (e) { console.log('[emo] err ' + e.message); }
        app.exit(0);
      }, 3000);
    }
    if (process.env.PET_TEST_ACTION) {
      const T0 = 1600;
      setTimeout(() => { try { win.webContents.send('do-action', process.env.PET_TEST_ACTION); } catch (_) {} }, T0);
      setTimeout(() => { try { win.webContents.send('cursor', 320, 0); } catch (_) {} }, T0 + 400);
      // PET_TEST_SHOTS="900,2600,4200" => 动作开始后这些毫秒各截一张，后缀 _900 等
      const shots = (process.env.PET_TEST_SHOTS || '').split(',').map(Number).filter((n) => n > 0);
      const OUT = process.env.PET_TEST_ACTION_OUT;
      if (shots.length) {
        shots.forEach((ms) => {
          setTimeout(async () => {
            try {
              const img = await win.webContents.capturePage();
              fs.writeFileSync(OUT.replace(/\.png$/i, '') + '_' + ms + '.png', img.toPNG());
              const dbg = await win.webContents.executeJavaScript(
                '(() => { const i = document.querySelector("#smoke i"); const cs = getComputedStyle(i);' +
                ' const c = document.querySelector("#cig"); const cc = getComputedStyle(c);' +
                ' const rs = getComputedStyle(document.documentElement);' +
                ' return { cls: document.body.className, op: cs.opacity, tr: cs.transform,' +
                ' w: cs.width, bg: cs.backgroundImage.slice(0, 40), anim: cs.animationName,' +
                ' cig: { tf: cc.transform, h: cc.height, w: cc.width, left: cc.left, top: cc.top },' +
                ' tip: [rs.getPropertyValue("--cig-tip-x").trim(), rs.getPropertyValue("--cig-tip-y").trim()],' +
                ' frame: (document.querySelector("img.f.active") || {}).src }; })()'
              );
              console.log('[action] shot ' + ms + ' ' + JSON.stringify(dbg));
            } catch (e) { console.log('[action] err ' + e.message); }
          }, T0 + ms);
        });
        setTimeout(() => app.exit(0), T0 + Math.max.apply(null, shots) + 900);
      } else {
        setTimeout(async () => {
          try {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(OUT, img.toPNG());
            console.log('[action] captured ' + process.env.PET_TEST_ACTION);
          } catch (e) { console.log('[action] err ' + e.message); }
          app.exit(0);
        }, 2700);
      }
    }
    if (process.env.PET_TEST_GAZE) {
      setTimeout(async () => {
        const grab = async (n) => {
          try {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(process.env.PET_TEST_GAZE + '_' + n + '.png', img.toPNG());
          } catch (_) {}
        };
        win.webContents.send('cursor', 60, 0); await sleep(520); await grab('near');
        win.webContents.send('cursor', 300, 300); await sleep(520); await grab('diag');
        win.webContents.send('cursor', 380, 0); await sleep(520); await grab('right');
        win.webContents.send('cursor', -380, 0); await sleep(520); await grab('left');
        console.log('[gaze] captured');
        app.exit(0);
      }, 5200);
    }
    if (process.env.PET_TEST_DIZZY) {
      setTimeout(() => { try { win.webContents.send('emotion', 'dizzy'); } catch (_) {} }, 1600);
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.PET_TEST_DIZZY, img.toPNG());
          console.log('[dizzy] captured');
        } catch (e) { console.log('[dizzy] err ' + e.message); }
        app.exit(0);
      }, 2100);
    }
    // 几何核对：把关键盒子的实际尺寸/位置打出来，别再靠截图猜
    if (process.env.PET_TEST_RECT) {
      setTimeout(async () => {
        try {
          const r = await win.webContents.executeJavaScript(`(() => {
            const pick = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
              return { x:+b.x.toFixed(1), y:+b.y.toFixed(1), w:+b.width.toFixed(1), h:+b.height.toFixed(1) }; };
            const eyes = [...document.querySelectorAll('.eye')].map(pick);
            const act = document.querySelector('img.f.active');
            return { win: { w: innerWidth, h: innerHeight }, dpr: devicePixelRatio,
              stage: pick(document.getElementById('stage')),
              breath: pick(document.getElementById('breath')),
              eyesBox: pick(document.getElementById('eyes')),
              act: pick(act), actNatural: act ? [act.naturalWidth, act.naturalHeight] : null,
              eyes };
          })()`);
          console.log('[rect] ' + JSON.stringify(r));
        } catch (e) { console.log('[rect] err ' + e.message); }
        app.exit(0);
      }, 2000);
    }
    if (process.env.PET_TEST_MENU) {
      setTimeout(() => openEmotionPicker(), 1800);
      setTimeout(async () => {
        try {
          if (emotionWin && !emotionWin.isDestroyed()) {
            const img = await emotionWin.webContents.capturePage();
            fs.writeFileSync(process.env.PET_TEST_MENU, img.toPNG());
            console.log('[menu] captured');
          } else { console.log('[menu] no window'); }
        } catch (e) { console.log('[menu] err ' + e.message); }
        app.exit(0);
      }, 3000);
    }
    if (process.env.PET_TEST_TODO) {
      // 灌几条样例任务（必须先设 PET_DAILY_PATH 指到临时文件）
      setTimeout(() => {
        try {
          const today = todayStr();
          const y = daily.shiftDay(today, -1), y3 = daily.shiftDay(today, -3);
          daily.addTask(dstore(), { title: '写完文档解析智能体的评测方案', type: 'required', minutes: 90, deadline: today }, y);
          daily.addTask(dstore(), { title: '把名片抽取的 baseline 跑一遍', type: 'required', minutes: 45 }, y3);
          daily.addTask(dstore(), { title: '整理本周组会要讲的三页 PPT', type: 'required', minutes: 60, deadline: daily.shiftDay(today, -1) }, today);
          const d = daily.addTask(dstore(), { title: '看两篇 RAG 综述', type: 'optional', minutes: 30 }, today);
          const done = daily.addTask(dstore(), { title: '回复导师邮件', type: 'required', minutes: 10 }, today);
          daily.setDone(dstore(), done.ref, true, today);
          dailySave();
        } catch (e) { console.log('[todo] seed err ' + e.message); }
      }, 900);
      setTimeout(() => openTodoEditor(), 1300);
      setTimeout(async () => {
        try {
          const img = await todoWin.webContents.capturePage();
          fs.writeFileSync(process.env.PET_TEST_TODO, img.toPNG());
          console.log('[todo] captured');
          if (process.env.PET_TEST_TODO_ACT) {
            // 走一遍真实交互：填输入框 -> 点添加 -> 勾掉第一条
            await todoWin.webContents.executeJavaScript(
              '(function(){' +
              ' document.getElementById("inp").value = "刚加的一条测试任务";' +
              ' document.getElementById("mins").value = "25";' +
              ' document.getElementById("addBtn").click();' +
              ' return true; })()'
            );
            await sleep(900);
            const n1 = await todoWin.webContents.executeJavaScript('document.querySelectorAll("li.item").length');
            await todoWin.webContents.executeJavaScript('document.querySelector("li.item .cb").click()');
            await sleep(900);
            const info = await todoWin.webContents.executeJavaScript(
              '(function(){ return { items: document.querySelectorAll("li.item").length,' +
              ' done: document.querySelectorAll("li.item.done").length,' +
              ' stat: document.getElementById("statLeft").textContent }; })()'
            );
            console.log('[todo] after act ' + n1 + ' -> ' + JSON.stringify(info));
            const img2 = await todoWin.webContents.capturePage();
            fs.writeFileSync(process.env.PET_TEST_TODO.replace(/\.png$/i, '') + '_act.png', img2.toPNG());
          }
        } catch (e) { console.log('[todo] err ' + e.message); }
        app.exit(0);
      }, 3200);
    }
    if (process.env.PET_TEST_REMIND) {
      // 验证 10 分钟提醒的气泡内容
      setTimeout(async () => {
        try {
          daily.addTask(dstore(), { title: '写完评测方案', type: 'required', minutes: 90, deadline: todayStr() }, todayStr());
          daily.addTask(dstore(), { title: '跑 baseline', type: 'required', minutes: 45 }, daily.shiftDay(todayStr(), -2));
          dailySave();
          lastDailyRemindAt = 0;
          settings.remindFrom = 0; settings.remindTo = 24;   // 测试时不受"安静时段"限制
          settings.mutedDate = ''; settings.dailyRemind = true;
          dailyTick();
          await sleep(1200);
          if (bubbleWin && !bubbleWin.isDestroyed()) {
            const img = await bubbleWin.webContents.capturePage();
            fs.writeFileSync(process.env.PET_TEST_REMIND, img.toPNG());
            console.log('[remind] captured');
          } else { console.log('[remind] no bubble'); }
        } catch (e) { console.log('[remind] err ' + e.message); }
        app.exit(0);
      }, 2600);
    }
    if (process.env.PET_TEST_PAPER_UI) {
      // 只截"进度中"这一屏：短论文解析太快，抓不住中间态，直接喂一个假进度
      const out = process.env.PET_TEST_PAPER_UI;
      setTimeout(() => openPaperTool(), 900);
      setTimeout(async () => {
        try {
          await paperWin.webContents.executeJavaScript(
            "setProgressFile('37_2306.08302_Unifying Large Language Models and Knowledge Graphs - A Roadmap.pdf');" +
            "showProgress('抽取文本…', '第 12 / 28 页', 42, 'extract');"
          );
        } catch (e) { console.log('[paper-ui] ' + e.message); }
      }, 1600);
      setTimeout(async () => {
        try {
          console.log('[paper-ui] win ' + (paperWin ? JSON.stringify({ vis: paperWin.isVisible(), b: paperWin.getBounds(), destroyed: paperWin.isDestroyed() }) : 'null'));
          if (paperWin && !paperWin.isDestroyed()) { paperWin.show(); paperWin.focus(); }
          await new Promise((r) => setTimeout(r, 350));
          const img = await paperWin.webContents.capturePage();
          const buf = img.toPNG();
          if (buf.length) fs.writeFileSync(out, buf);
          console.log('[paper-ui] shot ' + buf.length);
        } catch (e) { console.log('[paper-ui] err ' + e.message); }
        app.exit(0);
      }, 3400);
    }
    if (process.env.PET_TEST_CHAT) {
      // 真在聊天窗口里发一句话，截到回复就立刻截图 —— 用真实配置，不打桩
      const out = process.env.PET_TEST_CHAT;
      setTimeout(() => openChat(), 800);
      setTimeout(async () => {
        const alive = () => chatWin && !chatWin.isDestroyed();
        try {
          await chatWin.webContents.executeJavaScript(
            "document.getElementById('inp').value='你好，用一句话介绍你自己'; send(); 'sent'"
          );
        } catch (e) { console.log('[chat] send err ' + e.message); }
        // 轮询等回复（第二个 .bot 且不是省略号），一出来就截图，别等窗口被环境回收
        const deadline = Date.now() + 20000;
        let log = '';
        while (Date.now() < deadline && alive()) {
          log = await chatWin.webContents.executeJavaScript(
            "Array.from(document.querySelectorAll('.msg')).map(function(d){return d.className+': '+d.textContent;}).join('\\n')"
          ).catch(() => '');
          if (/\bbot: (?!…)/.test(log)) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        console.log('[chat] log\n' + log);
        if (!alive()) { console.log('[chat] window gone'); return app.exit(1); }
        try {
          chatWin.show(); chatWin.moveTop();
          await new Promise((r) => setTimeout(r, 300));
          const buf = (await chatWin.webContents.capturePage()).toPNG();
          if (buf.length) fs.writeFileSync(out, buf);
          console.log('[chat] shot ' + buf.length);
        } catch (e) { console.log('[chat] shot err ' + e.message); }
        app.exit(0);
      }, 2000);
    }
    if (process.env.PET_TEST_AUTOWIRE) {
      // 真跑一次自动接入（会真的探本机端口），结果写文件；密钥不回显
      const out = process.env.PET_TEST_AUTOWIRE;
      setTimeout(async () => {
        let res;
        try {
          res = await autowire();
        } catch (e) {
          res = { ok: false, reason: 'error', message: String((e && e.message) || e) };
        }
        const safe = JSON.parse(JSON.stringify(res || {}));
        safe.keySaved = !!(settings.ai && settings.ai.apiKey);
        delete safe.tried;
        safe.tried = ((res && res.tried) || []).map((t) => ({ baseUrl: t.baseUrl, ok: t.ok, code: t.code, n: (t.models || []).length }));
        try { fs.writeFileSync(out, JSON.stringify(safe, null, 1)); } catch (_) {}
        app.exit(0);
      }, 1200);
    }
    if (process.env.PET_TEST_WB_UI) {
      // 只截「AI 设置」这一屏，用来确认接入改了之后界面没塌
      const out = process.env.PET_TEST_WB_UI;
      setTimeout(() => openAiSettings(), 900);
      setTimeout(async () => {
        try {
          aiWin.show(); aiWin.moveTop();
          await new Promise((r) => setTimeout(r, 500));
          const buf = (await aiWin.webContents.capturePage()).toPNG();
          if (buf.length) fs.writeFileSync(out, buf);
          console.log('[wb-ui] shot ' + buf.length);
        } catch (e) { console.log('[wb-ui] err ' + e.message); }
        app.exit(0);
      }, 2600);
    }
    if (process.env.PET_TEST_WB) {
      // 端到端：真的走一遍 Electron net.request + wb.js，验证"成功 / 鉴权失败 / 未配置"三条路
      // 都只回结构化结果、绝不抛，桌宠进程活着
      const out = process.env.PET_TEST_WB;
      setTimeout(async () => {
        const res = {};
        const base = process.env.PET_TEST_WB_URL || '';
        const t = (cfg) => { settings.ai = Object.assign({ model: wb.DEFAULTS.model, timeoutMs: 4000, maxRetries: 1 }, cfg); wbClient.reset(); };
        try {
          t({ baseUrl: base, apiKey: process.env.PET_TEST_WB_KEY || '' });
          res.ok = await llmChat([{ role: 'user', content: '你好' }]);

          t({ baseUrl: base, apiKey: 'wrong-key-xxx', maxRetries: 0 });
          res.auth = await llmChat([{ role: 'user', content: '你好' }]);

          t({ baseUrl: '', apiKey: '' });
          res.none = await llmChat([{ role: 'user', content: '你好' }]);

          t({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', maxRetries: 0, timeoutMs: 800 });
          res.down = await llmChat([{ role: 'user', content: '你好' }]);

          res.status = wbClient.status();
          res.alive = true;   // 走到这里说明前三次失败都没把进程弄挂
        } catch (e) {
          res.fatal = String((e && e.message) || e);
        }
        try { fs.writeFileSync(out, JSON.stringify(res, null, 1)); } catch (_) {}
        app.exit(0);
      }, 1500);
    }
    if (process.env.PET_TEST_PAPER) {
      const pdf = process.env.PET_TEST_PAPER;
      const out = process.env.PET_TEST_PAPER_OUT || path.join(process.cwd(), '_paper.png');
      const alive = () => paperWin && !paperWin.isDestroyed();
      const sleep = (n) => new Promise((r) => setTimeout(r, n));
      // 窗口被遮挡时 capturePage 会返回上一帧甚至是空图，先显式抬到最前再截
      const shot = async (file) => {
        if (!alive()) return -1;
        paperWin.show(); paperWin.moveTop();
        await sleep(380);
        const buf = (await paperWin.webContents.capturePage()).toPNG();
        if (buf.length) fs.writeFileSync(file, buf);
        return buf.length;
      };
      setTimeout(() => openPaperTool(), 900);
      setTimeout(async () => {
        try {
          await paperWin.webContents.executeJavaScript(
            'run({ path: ' + JSON.stringify(pdf) + ' }, ' + JSON.stringify(path.basename(pdf)) + ')'
          );
        } catch (e) { console.log('[paper] run err ' + e.message); }
        // 轮询等渲染完成，别用固定时序赌解析速度
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline && alive()) {
          const n = await paperWin.webContents.executeJavaScript("document.querySelectorAll('.sec').length").catch(() => 0);
          if (n > 0) break;
          await sleep(250);
        }
        if (!alive()) { console.log('[paper] window gone'); return app.exit(1); }
        console.log('[paper] result shot ' + (await shot(out)));
        try {
          const info = await paperWin.webContents.executeJavaScript(
            '(function(){ return { secs: document.querySelectorAll(".sec").length,' +
            ' title: (document.querySelector(".meta .t")||{}).textContent || "",' +
            ' badge: (document.getElementById("engineBadge")||{}).textContent || "" }; })()'
          );
          console.log('[paper] ' + JSON.stringify(info));
        } catch (e) { console.log('[paper] err ' + e.message); }
        // 顺手把 JSON 视图也验一遍（截图 + 文本双校验）
        try {
          const v = await paperWin.webContents.executeJavaScript(
            "(function(){ var b=document.getElementById('jsonBtn'); b.click();" +
            " var j=document.querySelector('#result .json');" +
            " return { label: b.textContent, hasJson: !!j, head: j ? j.textContent.slice(0,90) : '' }; })()"
          );
          console.log('[paper] json ' + JSON.stringify(v));
          console.log('[paper] json shot ' + (await shot(out.replace(/\.png$/i, '_json.png'))));
        } catch (e) { console.log('[paper] json err ' + e.message); }
        app.exit(0);
      }, 1700);
    }
    if (settings.clickThrough) {
      setTimeout(() => showBubble({
        title: '注意',
        text: '当前是「点击穿透」模式，小猴不能被点击。\n按 Ctrl+Shift+P 或托盘菜单可关闭',
      }, 9000), 4000);
    }
    registerIpc();
    setClickThrough(settings.clickThrough);
    // 走动/动作自动化测试要保持清醒：本机无人操作时系统会判定空闲，宠物会自己睡着，
    // 睡着会打断散步，测试结果就不可复现了（和 PET_TEST_GAZE 关掉朝向轮询同一个道理）。
    if (!process.env.PET_TEST_WALK && !process.env.PET_TEST_CLIP) startIdleWatch();
    startGreetingWatch();
    startClipWatch();
    startScheduleWatch();
    startMorningWatch();
    startDailyWatch();
    scheduleWander();
    if (settings.antiDisturb) startAntiDisturb();
    try {
      app.setLoginItemSettings({
        openAtLogin: settings.openAtLogin,
        path: app.getPath('exe'),
        // 本机 Electron 的 GPU 沙箱会崩溃，自启也要带 --no-sandbox，否则开机后起不来
        args: process.defaultApp ? [app.getAppPath(), '--no-sandbox'] : ['--no-sandbox'],
      });
    } catch (_) {}
    try {
      globalShortcut.register('CommandOrControl+Shift+P', () => setClickThrough(!settings.clickThrough));
      globalShortcut.register('CommandOrControl+Shift+H', () => toggleVisibility());
      globalShortcut.register('CommandOrControl+Shift+T', () => toggleFocus());
      globalShortcut.register('CommandOrControl+Shift+O', () => openTodoEditor());
      globalShortcut.register('CommandOrControl+Shift+V', () => openClipboard());
      globalShortcut.register('CommandOrControl+Shift+M', () => showStats());
      globalShortcut.register('CommandOrControl+Shift+K', () => openScheduleEditor());
      globalShortcut.register('CommandOrControl+Shift+A', () => openChat());
      globalShortcut.register('CommandOrControl+Shift+U', () => openAiSettings());
      globalShortcut.register('CommandOrControl+Shift+R', () => morningReport(true));
      globalShortcut.register('CommandOrControl+Shift+D', () => openPaperTool());
    } catch (_) {}

    // 启动问候
    setTimeout(() => {
      if (!win || !win.isVisible()) return;
      const g = greetingFor();
      emitEmotion(g.emo);
      showBubble({ title: '小猴', text: g.text }, 5000);
    }, 1600);
  });

  app.on('child-process-gone', (_e, details) => logCrash('child-process-gone', JSON.stringify(details)));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    try { globalShortcut.unregisterAll(); } catch (_) {}
    try { if (facingTimer) clearInterval(facingTimer); } catch (_) {}
    try { if (focusTimer) clearInterval(focusTimer); } catch (_) {}
    try { if (dragPoll) clearInterval(dragPoll); } catch (_) {}
    try { if (wanderTimer) clearTimeout(wanderTimer); } catch (_) {}
    try { if (walkTimer) clearInterval(walkTimer); } catch (_) {}
    try { if (zoomTween) clearInterval(zoomTween); } catch (_) {}
    stopAntiDisturb();
  });
}

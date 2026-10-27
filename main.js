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

const WIN_W = 192;
const WIN_H = 223;
const POLL_MS = 80;          // 鼠标跟踪轮询
const DEADZONE = 28;         // 光标贴近中心不更新朝向
const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5;

const SNAP = 16;             // 距屏幕边缘多少 px 判定吸附
const PEEK = 44;             // 贴边后露出的像素
const PEEK_DELAY = 4000;     // 停靠后多久自动缩进
const BUBBLE_W = 248;        // 气泡窗宽度

// ---------- 设置持久化 ----------
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const settings = {
  clickThrough: false,
  openAtLogin: true,
  zoom: 1,
  pos: null,
  antiDisturb: true,
  todos: [],
  todosDate: '',
  courses: [],          // { day:1-7, time:'HH:MM', name, room }
  reminders: [],        // { date:'YYYY-M-D', time:'HH:MM', name }
  remindBefore: 10,     // 提前多少分钟提醒
  ai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  city: '南京',
  tts: false,           // 是否语音朗读
  morningReport: true,  // 每日早报
  reportTime: '08:30',
  lastReportDate: '',
};
function loadSettings() {
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); } catch (_) {}
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(settings)); } catch (_) {}
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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
function sendCursor() {
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

  if (!moved) return;
  if (!win.isVisible()) return;
  const dx = p.x - (b.x + b.width / 2);
  const dy = p.y - (b.y + b.height / 2);
  if (Math.hypot(dx, dy) < DEADZONE) win.webContents.send('cursor', 0, 0);
  else win.webContents.send('cursor', dx, dy);
}

// ---------- 拖拽移动 ----------
let dragPoll = null;
let grabOffset = { x: 0, y: 0 };
function startDrag() {
  if (!win) return;
  if (peeking) unpeek();                 // 缩进去时先探出来再拖
  clearTimeout(peekTimer);
  isDragging = true;
  setIgnore(false);                       // 开始拖拽先确保接收指针事件
  const b = win.getBounds();
  lockSize(b.width, b.height);
  const p = screen.getCursorScreenPoint();
  grabOffset = { x: p.x - b.x, y: p.y - b.y };
  if (dragPoll) clearInterval(dragPoll);
  dragPoll = setInterval(() => {
    if (!win || !isDragging) return;
    const cp = screen.getCursorScreenPoint();
    try { win.setPosition(Math.round(cp.x - grabOffset.x), Math.round(cp.y - grabOffset.y)); } catch (_) {}
  }, 16);
}
function endDrag() {
  if (!win) return;
  isDragging = false;
  if (dragPoll) { clearInterval(dragPoll); dragPoll = null; }
  const b = win.getBounds();
  lockSize(b.width, b.height);
  snapToEdge();
  const nb = win.getBounds();
  if (Number.isFinite(nb.x) && Number.isFinite(nb.y)) { settings.pos = { x: nb.x, y: nb.y }; saveSettings(); }
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

// ---------- 今日待办 ----------
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function ensureTodosFresh() {
  if (settings.todosDate !== todayStr()) {
    settings.todos = (settings.todos || []).map((t) => ({ text: t.text, done: false }));
    settings.todosDate = todayStr();
    saveSettings();
  }
}
function todoData() { ensureTodosFresh(); return settings.todos || []; }
function saveTodos(items) {
  settings.todos = (Array.isArray(items) ? items : [])
    .filter((t) => t && String(t.text || '').trim())
    .map((t) => ({ text: String(t.text).trim().slice(0, 120), done: !!t.done }));
  settings.todosDate = todayStr();
  saveSettings();
  refreshTray();
}
function openTodoEditor() {
  ensureTodosFresh();
  if (todoWin) { todoWin.show(); todoWin.focus(); return; }
  todoWin = new BrowserWindow({
    width: 340,
    height: 460,
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
function aiBase() {
  return String((settings.ai && settings.ai.baseUrl) || 'https://api.openai.com/v1').replace(/\/+$/, '');
}
async function llmChat(messages) {
  const ai = settings.ai || {};
  if (!ai.apiKey) return { ok: false, error: '未配置 API 密钥，请先打开「AI 设置」填写' };
  try {
    const data = await httpJson(aiBase() + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ai.apiKey },
      body: JSON.stringify({ model: ai.model || 'gpt-4o-mini', messages, temperature: 0.7, max_tokens: 512 }),
    }, 25000);
    const text = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    return { ok: true, text: String(text || '（空回复）') };
  } catch (e) {
    return { ok: false, error: '请求失败：' + String(e.message || e) };
  }
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
  const ai = settings.ai || {};
  if (!ai.apiKey) return { ok: false, error: '未配置 API 密钥，请先打开「AI 设置」填写' };
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
  try {
    const data = await httpJson(aiBase() + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ai.apiKey },
      body: JSON.stringify({ model: ai.model || 'gpt-4o-mini', messages, temperature: 0, max_tokens: 600 }),
    }, 40000);
    const text = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    const obj = parseJsonLoose(text);
    return { ok: true, data: obj || {}, raw: String(text || '') };
  } catch (e) {
    return { ok: false, error: '识别失败：' + String(e.message || e) };
  }
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
    ai: settings.ai || { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
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
    baseUrl: String(ai.baseUrl || 'https://api.openai.com/v1').trim(),
    apiKey: String(ai.apiKey || '').trim(),
    model: String(ai.model || 'gpt-4o-mini').trim(),
  };
  settings.city = String(cfg.city || '南京').trim() || '南京';
  settings.tts = !!cfg.tts;
  settings.morningReport = !!cfg.morningReport;
  settings.reportTime = /^\d{1,2}:\d{2}$/.test(cfg.reportTime) ? cfg.reportTime : '08:30';
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
function emotionMenu() {
  if (!win) return;
  Menu.buildFromTemplate(EMOTIONS.map(([n, label]) => ({ label, click: () => emitEmotion(n) }))).popup(win);
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
function setOpenAtLogin(on) {
  settings.openAtLogin = !!on;
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
  t.push({ label: '查看今日待办', click: () => showBubble({ kind: 'list', title: '今日待办', items: todoData() }, 7000) });
  t.push({ type: 'separator' });
  t.push({ label: '课程/日程…（编辑）', click: openScheduleEditor });
  t.push({ label: '查看今日课程', click: showTodayCoursesBubble });
  t.push({ type: 'separator' });
  t.push({ label: '剪贴板历史…', click: openClipboard });
  t.push({ label: '系统状态（CPU/内存/网速）', click: showStats });
  t.push({ type: 'separator' });
  t.push({ label: 'AI 对话…', click: openChat });
  t.push({ label: '识别名片图片…', click: pickCardImage });
  t.push({ label: '每日早报', click: () => morningReport(true) });
  t.push({ label: 'AI 设置…', click: openAiSettings });
  t.push({ type: 'separator' });
  t.push({ label: '点击穿透（鼠标可穿过小猴）', type: 'checkbox', checked: !!settings.clickThrough, click: () => setClickThrough(!settings.clickThrough) });
  t.push({ label: '防打扰（全屏时自动隐藏）', type: 'checkbox', checked: !!settings.antiDisturb, click: () => setAntiDisturb(!settings.antiDisturb) });
  t.push({ label: '开机自启', type: 'checkbox', checked: !!settings.openAtLogin, click: () => setOpenAtLogin(!settings.openAtLogin) });
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
  ipcMain.on('show-emotion-menu', () => emotionMenu());

  // 渲染端切帧时上报当前帧 key，供主进程做像素命中判定
  ipcMain.on('frame', (_e, key) => { if (key) currentFrameKey = String(key); });
  ipcMain.on('debug', (_e, m) => console.log('[renderer] ' + m));
  ipcMain.on('focus-toggle', () => toggleFocus());
  ipcMain.on('open-todo-editor', () => openTodoEditor());
  ipcMain.handle('get-todos', () => todoData());
  ipcMain.handle('save-todos', (_e, items) => { saveTodos(items); return settings.todos; });

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
  ipcMain.on('open-ai-settings', () => openAiSettings());
  ipcMain.on('open-chat', () => openChat());
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
  win.loadFile('index.html');
  win.setAlwaysOnTop(true, 'pop-up-menu');

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

  facingTimer = setInterval(sendCursor, POLL_MS);
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
const gotTheLock = app.requestSingleInstanceLock();
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
    ensureTodosFresh();
    logCrash('boot', 'pid=' + process.pid + ' argv=' + process.argv.slice(1).join(' '));
    createWindow();
    shotMode();
    createTray();
    // 有托盘就从小任务栏里移除，避免误点任务栏"关闭窗口"把程序关掉
    if (tray) { try { win.setSkipTaskbar(true); } catch (_) {} }
    setInterval(hitTick, 30);   // 像素命中判定：20~33fps 校正一次
    if (process.env.PET_TEST_DRAG) testDrag();
    if (settings.clickThrough) {
      setTimeout(() => showBubble({
        title: '注意',
        text: '当前是「点击穿透」模式，小猴不能被点击。\n按 Ctrl+Shift+P 或托盘菜单可关闭',
      }, 9000), 4000);
    }
    registerIpc();
    setClickThrough(settings.clickThrough);
    startIdleWatch();
    startGreetingWatch();
    startClipWatch();
    startScheduleWatch();
    startMorningWatch();
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
    try { if (zoomTween) clearInterval(zoomTween); } catch (_) {}
    stopAntiDisturb();
  });
}

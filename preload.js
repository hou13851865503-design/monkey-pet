// 预加载脚本：用 contextBridge 安全地暴露少量 API 给渲染进程
// 注意：小猴窗口 / 气泡窗口 / 待办窗口 共用这一个 preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // ---------- 拖拽 ----------
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),

  // ---------- 角色档案（尺寸 / 命中盒 / 鞋底支点 / 步态 / 动作表）----------
  // 同步取一次即可：窗口加载时就要用它建引擎，异步会在首帧出现空白姿态。
  getCharacter: () => ipcRenderer.sendSync('character'),

  // ---------- 自主走动：主进程决定去哪，渲染层把位移换算成步频 ----------
  onWalkStart: (cb) => ipcRenderer.on('walk-start', (_e, d) => cb(d)),
  onWalkStep: (cb) => ipcRenderer.on('walk-step', (_e, dx) => cb(dx)),
  onWalkEnd: (cb) => ipcRenderer.on('walk-end', () => cb()),
  // 目前正在干什么（主进程据此决定要不要让它自己散步）
  setActivity: (kind) => ipcRenderer.send('pet-activity', kind),
  // 让主进程立刻停止推窗口（走动被点击/情绪打断时必须先停，否则会边演动作边平移）
  stopWalk: () => ipcRenderer.send('stop-walk'),

  // ---------- 拖拽速度 / 落地速度 ----------
  onDragVel: (cb) => ipcRenderer.on('drag-vel', (_e, vx, vy) => cb(vx, vy)),
  onLand: (cb) => ipcRenderer.on('land', (_e, vy) => cb(vy)),

  // ---------- 甩出去之后 ----------
  // throw     = 松手瞬间（初速）
  // throw-vel = 飞行中每帧的速度（身体倾斜 / 拉伸都靠它）
  // bump      = 撞墙（axis 'x'|'y'，power 0..1）
  // throw-end = 结束（reason: stop | grab | hide，最后一个参数是撞墙次数）
  onThrow: (cb) => ipcRenderer.on('throw', (_e, vx, vy) => cb(vx, vy)),
  onThrowVel: (cb) => ipcRenderer.on('throw-vel', (_e, vx, vy) => cb(vx, vy)),
  onBump: (cb) => ipcRenderer.on('bump', (_e, axis, power) => cb(axis, power)),
  onThrowEnd: (cb) => ipcRenderer.on('throw-end', (_e, reason, speed, bounces) => cb(reason, speed, bounces)),

  // ---------- 菜单里手动指定动作 ----------
  onGesture: (cb) => ipcRenderer.on('play-gesture', (_e, id) => cb(id)),

  // ---------- 光标偏移（主进程轮询真实鼠标位置下发）----------
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, dx, dy) => cb(dx, dy)),

  // ---------- 当前帧 key（供主进程做像素级命中判定）----------
  setFrame: (key) => ipcRenderer.send('frame', key),
  debug: (m) => ipcRenderer.send('debug', m),

  // ---------- 点击穿透状态 ----------
  onClickThrough: (cb) => ipcRenderer.on('clickthrough-state', (_e, on) => cb(on)),

  // ---------- 缩放 ----------
  zoomBy: (factor) => ipcRenderer.send('zoom-by', factor),
  onZoom: (cb) => ipcRenderer.on('zoom-state', (_e, z) => cb(z)),

  // ---------- 右键菜单 ----------
  showContextMenu: () => ipcRenderer.send('show-context-menu'),

  // ---------- 事件反应系统：系统闲置 -> 睡 / 醒 ----------
  onIdle: (cb) => ipcRenderer.on('idle-state', (_e, asleep) => cb(asleep)),

  // ---------- 朝向：让主进程按当前光标立刻重算 ----------
  refreshFacing: () => ipcRenderer.send('refresh-facing'),

  // ---------- 抽烟 / 喝酒 ----------
  onAction: (cb) => ipcRenderer.on('do-action', (_e, type) => cb(type)),

  // ---------- 空闲自主状态开关 ----------
  onAutoMood: (cb) => ipcRenderer.on('auto-mood', (_e, on) => cb(on)),

  // ---------- 主进程指定情绪（问候、专注完成、情绪菜单）----------
  onEmotion: (cb) => ipcRenderer.on('emotion', (_e, name) => cb(name)),

  // ---------- 番茄钟专注状态 ----------
  onFocus: (cb) => ipcRenderer.on('focus-state', (_e, on) => cb(on)),
  // 按住小猴（长按）切换专注
  focusToggle: () => ipcRenderer.send('focus-toggle'),

  // ---------- 双击 -> 表情面板 ----------
  showEmotionMenu: () => ipcRenderer.send('show-emotion-menu'),
  // 表情面板里点了某个情绪 / 关闭面板
  pickEmotion: (name) => ipcRenderer.send('pick-emotion', name),
  closeEmotion: () => ipcRenderer.send('close-emotion'),

  // ---------- 气泡窗口接收内容 ----------
  onBubble: (cb) => ipcRenderer.on('bubble', (_e, payload) => cb(payload)),

  // ---------- 今日待办 / 每日任务 ----------
  getTodos: () => ipcRenderer.invoke('get-todos'),
  saveTodos: (items) => ipcRenderer.invoke('save-todos', items),
  openTodoEditor: () => ipcRenderer.send('open-todo-editor'),

  dailyGet: () => ipcRenderer.invoke('daily-get'),
  dailyAdd: (input) => ipcRenderer.invoke('daily-add', input),
  dailyUpdate: (ref, patch) => ipcRenderer.invoke('daily-update', ref, patch),
  dailyToggle: (ref, done) => ipcRenderer.invoke('daily-toggle', ref, done),
  dailyRemove: (ref) => ipcRenderer.invoke('daily-remove', ref),
  dailySetRemind: (patch) => ipcRenderer.invoke('daily-remind-set', patch),
  dailyMuteToday: () => ipcRenderer.invoke('daily-mute-today'),
  dailyRemindNow: () => ipcRenderer.invoke('daily-remind-now'),
  onDailyChanged: (cb) => ipcRenderer.on('daily-changed', (_e, state) => cb(state)),

  // ---------- 剪贴板历史 ----------
  getClipHistory: () => ipcRenderer.invoke('get-clip'),
  pickClip: (index) => ipcRenderer.send('pick-clip', index),
  clearClip: () => ipcRenderer.send('clear-clip'),
  openClipboard: () => ipcRenderer.send('open-clipboard'),
  onClipList: (cb) => ipcRenderer.on('clip-list', (_e, list) => cb(list)),

  // ---------- 系统监控 ----------
  showStats: () => ipcRenderer.send('show-stats'),

  // ---------- 课程表 / 日程 ----------
  getSchedule: () => ipcRenderer.invoke('get-schedule'),
  saveSchedule: (data) => ipcRenderer.invoke('save-schedule', data),
  openScheduleEditor: () => ipcRenderer.send('open-schedule'),
  showTodayCourses: () => ipcRenderer.send('show-today-courses'),

  // ---------- AI ----------
  getAiSettings: () => ipcRenderer.invoke('get-ai-settings'),
  saveAiSettings: (cfg) => ipcRenderer.invoke('save-ai-settings', cfg),
  openAiSettings: () => ipcRenderer.send('open-ai-settings'),
  openChat: () => ipcRenderer.send('open-chat'),
  chat: (messages) => ipcRenderer.invoke('llm-chat', messages),
  // WorkBuddy API 自检 / 状态（设置页用）
  wbTest: (cfg) => ipcRenderer.invoke('wb-test', cfg),
  wbStatus: () => ipcRenderer.invoke('wb-status'),
  wbAutowire: () => ipcRenderer.invoke('wb-autowire'),
  extractCard: (filePath) => ipcRenderer.send('extract-card', filePath),
  morningReport: () => ipcRenderer.send('morning-report'),

  // ---------- PDF 论文解析 ----------
  openPaperTool: () => ipcRenderer.send('open-paper'),
  paperPick: () => ipcRenderer.invoke('paper-pick'),
  paperAnalyze: (payload) => ipcRenderer.invoke('paper-analyze', payload),
  paperSave: (payload) => ipcRenderer.invoke('paper-save', payload),
  onPaperProgress: (cb) => ipcRenderer.on('paper-progress', (_e, p) => cb(p)),
  speak: (text) => ipcRenderer.send('speak', text),
  onSpeak: (cb) => ipcRenderer.on('speak', (_e, t) => cb(t)),
  onCardData: (cb) => ipcRenderer.on('card-data', (_e, p) => cb(p)),
});

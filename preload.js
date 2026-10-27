// 预加载脚本：用 contextBridge 安全地暴露少量 API 给渲染进程
// 注意：小猴窗口 / 气泡窗口 / 待办窗口 共用这一个 preload
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  // ---------- 拖拽 ----------
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),

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

  // ---------- 今日待办 ----------
  getTodos: () => ipcRenderer.invoke('get-todos'),
  saveTodos: (items) => ipcRenderer.invoke('save-todos', items),
  openTodoEditor: () => ipcRenderer.send('open-todo-editor'),

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
  extractCard: (filePath) => ipcRenderer.send('extract-card', filePath),
  morningReport: () => ipcRenderer.send('morning-report'),
  speak: (text) => ipcRenderer.send('speak', text),
  onSpeak: (cb) => ipcRenderer.on('speak', (_e, t) => cb(t)),
  onCardData: (cb) => ipcRenderer.on('card-data', (_e, p) => cb(p)),
});

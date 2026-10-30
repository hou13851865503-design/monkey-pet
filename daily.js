// 每日任务模型（主进程专用，纯函数 + 一个持久化壳）
//
// 移植自 D:/Desktop/software-main/rixu-daily-planner/model.js 的核心思想：
//   · 任务只挂在"创建那一天"的 key 下，不复制到后续日期
//   · 没做完就一直顺延，直到某天完成；completedOn 记录"哪天完成的"
//   · 所以"今天要做什么"不是查今天那个 key，而是**算**出来的（onDate）
// 被裁掉的部分（该项目的四象限 / 预计总工时 / 晚间小结）与本桌宠的窗口尺寸不匹配，
// 但数据结构留了扩展位，将来要加不用改存储格式。

'use strict';

const fs = require('fs');
const path = require('path');

const STORE_VERSION = 1;
const MAX_TITLE = 120;
const KEEP_DAYS = 60;
const TYPES = ['required', 'optional'];

// ---------- 日期 ----------
function localDay(date) {
  const d = date instanceof Date ? date : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function validDay(key) {
  return typeof key === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(key) &&
    !Number.isNaN(new Date(key + 'T12:00:00').getTime()) &&
    localDay(new Date(key + 'T12:00:00')) === key;
}
function dayDiff(from, to) {
  const a = new Date(from + 'T12:00:00').getTime();
  const b = new Date(to + 'T12:00:00').getTime();
  return Math.round((b - a) / 86400000);
}
function shiftDay(key, n) {
  const d = new Date(key + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return localDay(d);
}

// ---------- 存储 ----------
function emptyStore() {
  return { version: STORE_VERSION, days: {} };
}
function normalizeTask(raw, dayKey) {
  const title = String((raw && raw.title) || '').trim().slice(0, MAX_TITLE);
  if (!title) return null;
  const minutes = Number.isFinite(+raw.minutes) ? Math.min(1440, Math.max(1, Math.round(+raw.minutes))) : 30;
  const deadline = validDay(raw.deadline) ? raw.deadline : '';
  const done = !!raw.done;
  return {
    id: typeof raw.id === 'string' && /^[\w-]{1,100}$/.test(raw.id) ? raw.id : newId(),
    title,
    type: TYPES.includes(raw.type) ? raw.type : 'required',
    minutes,
    start: /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.start || '') ? raw.start : '',
    deadline,
    done,
    completedOn: done ? (validDay(raw.completedOn) ? raw.completedOn : dayKey) : null,
  };
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 读盘；文件坏了就退回空库，不让桌宠因为任务文件而启动失败
function load(file, legacyTodos) {
  let store = emptyStore();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) {
      for (const [key, day] of Object.entries(raw.days)) {
        if (!validDay(key) || !day || !Array.isArray(day.tasks)) continue;
        const tasks = day.tasks.map((t) => normalizeTask(t, key)).filter(Boolean);
        if (tasks.length) store.days[key] = { tasks };
      }
    }
  } catch (_) { /* 首次运行或文件损坏 */ }

  // 一次性迁移：老的「今日待办」是纯文本清单，灌到今天这一格里
  if (!Object.keys(store.days).length && Array.isArray(legacyTodos) && legacyTodos.length) {
    const today = localDay();
    const tasks = legacyTodos
      .map((t) => normalizeTask({ title: t && t.text, done: t && t.done }, today))
      .filter(Boolean);
    if (tasks.length) store.days[today] = { tasks };
  }
  return store;
}

function save(file, store) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- 查询 ----------
// 这一条任务在 date 这天是否算"我的活"
function aliveOn(key, task, date) {
  if (task.done) return task.completedOn === date || task.completedOn >= date;
  return key <= date;   // 没完成就一直顺延
}

// date 这天的清单。carried = 从哪天顺延过来的天数
function onDate(store, date) {
  const out = [];
  for (const [key, day] of Object.entries(store.days || {})) {
    for (const task of day.tasks || []) {
      if (!aliveOn(key, task, date)) continue;
      const done = task.done && task.completedOn <= date;
      out.push({
        ref: key + '/' + task.id,
        key,
        task,
        done,
        carried: !done && key < date ? dayDiff(key, date) : 0,
        overdue: !done && task.deadline ? dayDiff(task.deadline, date) : 0, // >0 已逾期几天
      });
    }
  }
  // 未完成在前；同状态按原定日期先后
  out.sort((a, b) => (a.done - b.done) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

function stats(items) {
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  const pending = total - done;
  const minutes = items.filter((i) => !i.done).reduce((s, i) => s + (i.task.minutes || 0), 0);
  return { total, done, pending, minutes, percent: total ? Math.round((done / total) * 100) : 0 };
}

function find(store, ref) {
  if (typeof ref !== 'string') return null;
  const i = ref.indexOf('/');
  if (i < 0) return null;
  const key = ref.slice(0, i), id = ref.slice(i + 1);
  const day = store.days[key];
  if (!day) return null;
  const task = day.tasks.find((t) => t.id === id);
  return task ? { key, task, ref } : null;
}

// ---------- 修改 ----------
function addTask(store, input, date) {
  const task = normalizeTask(input, date);
  if (!task) return null;
  if (!store.days[date]) store.days[date] = { tasks: [] };
  store.days[date].tasks.push(task);
  return { key: date, task, ref: date + '/' + task.id };
}

function updateTask(store, ref, patch) {
  const hit = find(store, ref);
  if (!hit) return null;
  const t = hit.task;
  if (patch && typeof patch.title === 'string' && patch.title.trim()) t.title = patch.title.trim().slice(0, MAX_TITLE);
  if (patch && TYPES.includes(patch.type)) t.type = patch.type;
  if (patch && Number.isFinite(+patch.minutes)) t.minutes = Math.min(1440, Math.max(1, Math.round(+patch.minutes)));
  if (patch && typeof patch.start === 'string') t.start = /^([01]\d|2[0-3]):[0-5]\d$/.test(patch.start) ? patch.start : '';
  if (patch && 'deadline' in patch) t.deadline = validDay(patch.deadline) ? patch.deadline : '';
  return hit;
}

function setDone(store, ref, done, date) {
  const hit = find(store, ref);
  if (!hit) return null;
  hit.task.done = !!done;
  hit.task.completedOn = done ? date : null;
  return hit;
}

function removeTask(store, ref) {
  const hit = find(store, ref);
  if (!hit) return false;
  const day = store.days[hit.key];
  day.tasks = day.tasks.filter((t) => t.id !== hit.task.id);
  if (!day.tasks.length) delete store.days[hit.key];
  return true;
}

// 只保留最近 KEEP_DAYS 天的格子，避免任务文件无限增长
function prune(store, today) {
  const floor = shiftDay(today, -KEEP_DAYS);
  let changed = false;
  for (const key of Object.keys(store.days)) {
    if (key < floor) { delete store.days[key]; changed = true; }
  }
  return changed;
}

module.exports = {
  localDay, validDay, dayDiff, shiftDay,
  load, save, emptyStore, normalizeTask,
  onDate, stats, find,
  addTask, updateTask, setDone, removeTask, prune,
  STORE_VERSION, MAX_TITLE, KEEP_DAYS, TYPES,
};

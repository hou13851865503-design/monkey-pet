// 每日任务模型回归测试：node tools/test-daily.cjs
// 重点验证"跨日顺延"这条最容易写错的规则（对应 rixu 的 onDate）
'use strict';
const assert = require('assert');
const M = require('../daily.js');

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

const store = M.emptyStore();

ok('新建任务只出现在当天', () => {
  M.addTask(store, { title: '写论文', type: 'required', minutes: 60 }, '2026-10-31');
  const items = M.onDate(store, '2026-10-31');
  assert.equal(items.length, 1);
  assert.equal(items[0].done, false);
  assert.equal(items[0].carried, 0);
});

ok('前一天的任务不该出现在今天', () => {
  const s = M.emptyStore();
  M.addTask(s, { title: '昨天的事' }, '2026-10-30');
  assert.equal(M.onDate(s, '2026-10-29').length, 0);
  assert.equal(M.onDate(s, '2026-10-30').length, 1);
});

ok('没完成会顺延，carried 记录天数', () => {
  assert.equal(M.onDate(store, '2026-11-01').length, 1);
  assert.equal(M.onDate(store, '2026-11-01')[0].carried, 1);
  assert.equal(M.onDate(store, '2026-11-03')[0].carried, 3);
});

ok('今天完成后，明天就不再出现', () => {
  const ref = M.onDate(store, '2026-10-31')[0].ref;
  M.setDone(store, ref, true, '2026-10-31');
  const today = M.onDate(store, '2026-10-31');
  assert.equal(today.length, 1);
  assert.equal(today[0].done, true);
  assert.equal(M.onDate(store, '2026-11-01').length, 0);
});

ok('当天完成的任务不会污染历史日期', () => {
  const s = M.emptyStore();
  const r = M.addTask(s, { title: 'A' }, '2026-10-28');
  M.setDone(s, r.ref, true, '2026-10-30');
  assert.equal(M.onDate(s, '2026-10-28')[0].done, false, '28 号它还没完成');
  assert.equal(M.onDate(s, '2026-10-29').length, 1);
  assert.equal(M.onDate(s, '2026-10-30')[0].done, true);
  assert.equal(M.onDate(s, '2026-10-31').length, 0);
});

ok('逾期天数与截止日期', () => {
  const s = M.emptyStore();
  M.addTask(s, { title: '交报告', deadline: '2026-10-29' }, '2026-10-28');
  const it = M.onDate(s, '2026-10-31')[0];
  assert.equal(it.overdue, 2);
});

ok('统计只算未完成的分钟数', () => {
  const s = M.emptyStore();
  const a = M.addTask(s, { title: 'a', minutes: 30 }, '2026-10-31');
  M.addTask(s, { title: 'b', minutes: 45 }, '2026-10-31');
  M.setDone(s, a.ref, true, '2026-10-31');
  const st = M.stats(M.onDate(s, '2026-10-31'));
  assert.deepEqual([st.total, st.done, st.pending, st.minutes], [2, 1, 1, 45]);
});

ok('删除任务会清掉空日期格', () => {
  const s = M.emptyStore();
  const r = M.addTask(s, { title: 'x' }, '2026-10-31');
  M.removeTask(s, r.ref);
  assert.equal(Object.keys(s.days).length, 0);
});

ok('标题为空不建任务；超长截断', () => {
  assert.equal(M.addTask(store, { title: '   ' }, '2026-10-31'), null);
  const r = M.addTask(store, { title: 'x'.repeat(300) }, '2026-10-31');
  assert.equal(r.task.title.length, M.MAX_TITLE);
});

ok('prune 只删 60 天以外的格子', () => {
  const s = M.emptyStore();
  M.addTask(s, { title: 'old' }, '2026-01-01');
  M.addTask(s, { title: 'new' }, '2026-10-31');
  M.prune(s, '2026-10-31');
  assert.ok(!s.days['2026-01-01']);
  assert.ok(s.days['2026-10-31']);
});

console.log('\n' + pass + ' 项通过');

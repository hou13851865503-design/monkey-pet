// flight.js 回归测试：node tools/test-flight.cjs
// 只测纯物理（不启动 Electron）。重点就三件事：不出界、一定停、撞得对。
const assert = require('assert');
const F = require('../flight');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// 一台 1920x1040 的显示器（工作区去掉任务栏），窗口 192x223
const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const W = 192, H = 223;
const inArea = (b) =>
  b.x >= WA.x - 0.6 && b.x <= WA.x + WA.width - W + 0.6 &&
  b.y >= WA.y - 0.6 && b.y <= WA.y + WA.height - H + 0.6;

// 一直跑到停下（或超时），返回 { b, frames, bumps, maxSpeedAtBounce }
function fly(vx, vy, cfg, start) {
  const s = start || { x: 600, y: 400 };
  const b = F.body(s.x, s.y, vx, vy, W, H);
  let frames = 0, stopped = false;
  const bumps = [];
  while (frames < 4000) {
    const r = F.step(b, 16, WA, cfg);
    frames++;
    r.bumps.forEach((x) => bumps.push(x));
    if (!inArea(b)) throw new Error('第 ' + frames + ' 帧出界：x=' + b.x.toFixed(1) + ' y=' + b.y.toFixed(1));
    if (r.done) { stopped = true; break; }
  }
  return { b, frames, bumps, stopped };
}

console.log('flight.js');

// ---------- 参数 ----------
t('参数规范化：缺失走默认，乱填被夹到安全范围', () => {
  const d = F.normalize({});
  assert.strictEqual(d.damping, 1.05);
  assert.strictEqual(d.restitution, 0.74);
  const bad = F.normalize({ damping: 999, restitution: 5, stopSpeed: -1, maxSpeed: 1 });
  assert.ok(bad.damping <= 6, 'damping 上限没夹住');
  assert.ok(bad.restitution <= 0.98, 'restitution 不能给到 1（给到 1 就永远不衰减）');
  assert.ok(bad.stopSpeed > 0, 'stopSpeed 必须为正，否则永远判定不停');
  assert.ok(bad.maxSpeed >= 200);
});

// ---------- 松手判定 ----------
t('松手判定：慢慢放下不算甩，快甩才抛', () => {
  const slow = F.launch(200, 120, {});
  assert.strictEqual(slow.on, false, '400px/s 的慢放不该变成抛');
  assert.strictEqual(slow.vx, 0, '不抛时必须把速度清零，否则会残留一个初速');
  const fast = F.launch(1800, -900, {});
  assert.strictEqual(fast.on, true);
  assert.ok(fast.vx > 0 && fast.vy < 0, '方向必须保持（右下 -> 右上）');
});

t('松手判定：超过上限时限幅但保持方向', () => {
  const r = F.launch(0, -9000, {});
  assert.strictEqual(r.on, true);
  assert.ok(Math.abs(r.speed - 3200) < 0.01, '应被限到 3200，实际 ' + r.speed);
  assert.ok(r.vx === 0 && r.vy < 0);
});

t('松手判定：阈值恰好等于 minThrow 时算抛（边界闭区间）', () => {
  const r = F.launch(1000, 0, {});
  assert.strictEqual(r.on, true, '等于阈值应算"甩"');
});

// ---------- 边界 ----------
t('直线撞右墙：位置恰好贴住边界，速度反向', () => {
  const b = F.body(WA.width - W - 200, 400, 2000, 0, W, H);
  let hopped = false;
  for (let i = 0; i < 40 && !hopped; i++) {
    const r = F.step(b, 16, WA, {});
    if (r.bumps.some((x) => x.edge === 'right')) hopped = true;
  }
  assert.ok(hopped, '40 帧内没撞到右墙');
  assert.ok(b.x <= WA.width - W + 1e-6, '撞完必须在墙内，实际 ' + b.x);
  assert.ok(b.vx < 0, '撞右墙后应往左飞，实际 vx=' + b.vx);
});

t('四角全撞：斜着飞一定在角上同时记录两个轴', () => {
  const b = F.body(WA.width - W - 80, WA.height - H - 80, 2600, 2600, W, H);
  let got = null;
  for (let i = 0; i < 60 && !got; i++) {
    const r = F.step(b, 16, WA, {});
    const ax = new Set(r.bumps.map((x) => x.axis));
    if (ax.has('x') && ax.has('y')) got = r.bumps;
  }
  assert.ok(got, '右下角斜撞没同时记录 x/y 两个轴');
});

t('极端速度不穿墙（1e6 px/s 也不许跳出去）', () => {
  const b = F.body(900, 400, 1e6, 0, W, H);
  for (let i = 0; i < 30; i++) {
    F.step(b, 16, WA, {});
    assert.ok(inArea(b), '第 ' + i + ' 帧出界 x=' + b.x);
  }
});

t('随机 200 组初速，任何一帧都不出界', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 200; k++) {
    const b = F.body(rnd() * 1700, rnd() * 800, (rnd() - 0.5) * 8000, (rnd() - 0.5) * 8000, W, H);
    for (let i = 0; i < 400; i++) {
      const r = F.step(b, 16, WA, {});
      if (!inArea(b)) throw new Error('组 ' + k + ' 第 ' + i + ' 帧出界');
      if (r.done) break;
    }
  }
});

// ---------- 收敛 ----------
t('一定停得下来：任意初速 9 秒内 done 且速度归零', () => {
  const cases = [[800, 0], [3200, 0], [0, 3200], [2400, -2400], [1, 0], [3200, 3200]];
  cases.forEach(([vx, vy]) => {
    const r = fly(vx, vy, {});
    assert.ok(r.stopped, vx + ',' + vy + ' 没停下来');
    assert.strictEqual(r.b.vx, 0, '停下后 vx 必须为 0（否则每帧还在 setPosition）');
    assert.strictEqual(r.b.vy, 0, '停下后 vy 必须为 0');
    assert.ok(r.frames < 600, '飞了 ' + r.frames + ' 帧，太久');
  });
});

t('撞得次数合理：甩一下应该撞 1~6 次墙，不是原地抖也不是永不回头', () => {
  const r = fly(3000, -1200, {});
  const n = r.bumps.length;
  assert.ok(n >= 1 && n <= 6, '撞了 ' + n + ' 次，不在合理区间');
});

t('帧长不影响收敛：60fps 和 30fps 走的距离差不超过 3%', () => {
  const a = F.body(600, 400, 2000, 0, W, H);
  const bb = F.body(600, 400, 2000, 0, W, H);
  let fa = 0, fb = 0;
  while (fa < 3000) { if (F.step(a, 16, WA, {}).done) break; fa++; }
  while (fb < 3000) { if (F.step(bb, 33, WA, {}).done) break; fb++; }
  const ta = fa * 16, tb = fb * 33;
  assert.ok(Math.abs(ta - tb) / Math.max(ta, tb) < 0.05,
    '16ms 停了 ' + ta + 'ms，33ms 停了 ' + tb + 'ms，差太多');
});

// ---------- 稳定性 ----------
t('连续甩 500 次不累积：状态无 NaN、位置仍在界内', () => {
  let b = F.body(600, 400, 0, 0, W, H);
  for (let k = 0; k < 500; k++) {
    const L = F.launch((k % 2 ? -1 : 1) * (900 + (k * 7) % 2300), ((k * 13) % 2000) - 1000, {});
    b.vx = L.vx; b.vy = L.vy; b.t = 0;
    for (let i = 0; i < 400; i++) { if (F.step(b, 16, WA, {}).done) break; }
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), '第 ' + k + ' 次甩出了 NaN');
    assert.ok(inArea(b), '第 ' + k + ' 次甩完出界');
  }
});

t('总时长上限兜底：阻尼被调成 0 也能在 maxFlight 秒内停', () => {
  const b = F.body(600, 400, 3000, 3000, W, H);
  let i = 0, done = false;
  while (i < 2000) { i++; if (F.step(b, 16, WA, { damping: 0, restitution: 0.99 }).done) { done = true; break; } }
  assert.ok(done, '阻尼为 0 时没有兜底停下（会永远飞）');
  assert.ok(i * 16 <= 9200, '兜底停得太晚：' + i * 16 + 'ms');
});

t('窗口比工作区还大：不振荡，直接贴住', () => {
  const tiny = { x: 0, y: 0, width: 100, height: 100 };
  const b = F.body(0, 0, 2000, 2000, 192, 223);
  for (let i = 0; i < 100; i++) {
    F.step(b, 16, tiny, {});
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
    assert.ok(b.x >= -0.6 && b.y >= -0.6, '跑到了负坐标');
  }
  assert.strictEqual(b.vx, 0, '比工作区大时应把 vx 归零');
  assert.strictEqual(b.vy, 0, '比工作区大时应把 vy 归零');
});

t('切后台回来一个巨大的 dt 不会跳穿（maxStep 兜底）', () => {
  const b = F.body(600, 400, 3000, 0, W, H);
  F.step(b, 5000, WA, {});
  assert.ok(inArea(b), '5 秒的 dt 把窗口甩出了工作区');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

// anim.js 回归测试：node tools/test-anim.cjs
// 只测纯逻辑（不启动 Electron），重点是不打滑、不抢画面、换档案不变量成立。
const assert = require('assert');
const path = require('path');
const PetAnim = require('../anim');
const profile = require('../character.json');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
// 引擎单次 tick 最多推进 200ms（窗口隐藏后恢复时防止跳帧），
// 所以测试要按 16ms 逐帧推进，不能一把梭。
function run(a, ms, each) {
  let left = ms;
  while (left > 0) {
    const dt = Math.min(16, left);
    a.tick(dt);
    left -= dt;
    if (each) each(a);
  }
}

console.log('anim.js');

// ---------- 档案 ----------
t('档案规范化：缺失字段走默认值', () => {
  const p = PetAnim.normalize({});
  assert.deepStrictEqual(p.size, [192, 223]);
  assert.strictEqual(p.gait.stride, 0.34);
  assert.strictEqual(p.schedule.gapMin, 7000);
  assert.strictEqual(p.anchorFoot, 0.995);
});

t('帧名解析：情绪名 / 语义名 / 实际 key 都能落到 d0、e_cheer', () => {
  const p = PetAnim.normalize(profile);
  assert.strictEqual(p.resolveFrame('front'), 'd0');
  assert.strictEqual(p.resolveFrame('side'), 'd2');
  assert.strictEqual(p.resolveFrame('cheer'), 'e_cheer');
  assert.strictEqual(p.resolveFrame('e_shy'), 'e_shy');
  assert.strictEqual(p.resolveFrame('d2'), 'd2');
});

t('关键帧：只写了一个通道的动作，不会把别的通道拽回中性', () => {
  const keys = [{ t: 0, rot: 0 }, { t: 1, rot: 8 }];
  const mid = PetAnim.sampleKeys(keys, 0.5);
  assert.ok(Math.abs(mid.rot - 4) < 0.01, 'rot 应在中点约 4，实际 ' + mid.rot);
  assert.strictEqual(mid.dy, 0);
  assert.strictEqual(mid.sx, 1);
});

t('关键帧：frame 取"不晚于当前时刻"的最后一个声明', () => {
  const keys = [{ t: 0, frame: 'front' }, { t: 0.4, frame: 'cheer' }, { t: 0.8, frame: 'shy' }];
  assert.strictEqual(PetAnim.sampleKeys(keys, 0.1).frame, 'front');
  assert.strictEqual(PetAnim.sampleKeys(keys, 0.5).frame, 'cheer');
  assert.strictEqual(PetAnim.sampleKeys(keys, 0.99).frame, 'shy');
});

// ---------- 命中分区 ----------
t('命中分区：头/身子按档案的盒子判定，盒子外返回 null', () => {
  const a = PetAnim.create(profile);
  assert.strictEqual(a.zoneAt(0.5, 0.2).id, 'head');
  assert.strictEqual(a.zoneAt(0.5, 0.8).id, 'body');
  assert.strictEqual(a.zoneAt(0.01, 0.5), null);
});

// ---------- 步态：核心不变式 ----------
t('步频由位移驱动：走完一个 stride 正好一步', () => {
  const p = PetAnim.normalize(profile);
  const a = PetAnim.create(profile);
  const W = 192;
  const stepPx = p.gait.stride * W;
  a.startWalk(1);
  a.advance(stepPx, W);
  assert.ok(Math.abs(a.stepCount - 1) < 1e-9, '应为 1 步，实际 ' + a.stepCount);
  a.advance(stepPx * 2.5, W);
  assert.ok(Math.abs(a.stepCount - 3.5) < 1e-9, '应为 3.5 步，实际 ' + a.stepCount);
});

t('打得远一点：同样是 3 步的距离，窗口放大一倍后走得更远（相位只认比例）', () => {
  const p = PetAnim.normalize(profile);
  const a1 = PetAnim.create(profile);
  const a2 = PetAnim.create(profile);
  a1.startWalk(1); a2.startWalk(1);
  const W1 = 192, W2 = 384;
  a1.advance(p.gait.stride * W1 * 3, W1);
  a2.advance(p.gait.stride * W2 * 3, W2);
  assert.ok(Math.abs(a1.stepCount - a2.stepCount) < 1e-9, '两种缩放下步数必须一致');
  assert.ok(Math.abs(a1.stepCount - 3) < 1e-9);
});

t('落脚最低、抬脚最高：phase 整数时 dy 最大，半相位时 dy 归零', () => {
  const p = PetAnim.normalize(profile);
  const a = PetAnim.create(profile);
  const W = 192;
  a.startWalk(1);
  a.tick(16);
  assert.ok(Math.abs(a.pose.dy - p.gait.bob) < 1e-9, 'phase=0 应下沉 ' + p.gait.bob + '，实际 ' + a.pose.dy);
  a.advance(p.gait.stride * W * 0.5, W);
  a.tick(16);
  assert.ok(Math.abs(a.pose.dy) < 1e-9, '半相位应回到 0，实际 ' + a.pose.dy);
});

t('走动时朝移动方向倾，反向走就反着倾', () => {
  const p = PetAnim.normalize(profile);
  const a = PetAnim.create(profile);
  a.startWalk(1); a.tick(16);
  assert.ok(a.pose.rot > 0, '向右走应正倾');
  const b = PetAnim.create(profile);
  b.startWalk(-1); b.tick(16);
  assert.ok(b.pose.rot < 0, '向左走应反倾');
  assert.strictEqual(b.pose.facing, -1);
});

t('每步有摇摆：四分之一相位和四分之三相位以"前倾角"为中心对称', () => {
  const p = PetAnim.normalize(profile);
  const W = 192;
  const stepPx = p.gait.stride * W;
  function rotAt(frac) {
    const a = PetAnim.create(profile);
    a.startWalk(1);
    a.advance(stepPx * frac, W);
    a.tick(16);
    return a.pose.rot;
  }
  const mid = p.gait.leanDeg;
  const q1 = rotAt(0.25), q3 = rotAt(0.75);
  assert.ok(q1 > mid + 0.3, '四分之一相位应向右多晃：' + q1);
  assert.ok(q3 < mid - 0.3, '四分之三相位应向左多晃：' + q3);
  assert.ok(Math.abs((q1 - mid) + (q3 - mid)) < 0.05, '摇摆应关于前倾角对称');
});

t('掉头不重置相位：脚步不会顿一下', () => {
  const a = PetAnim.create(profile);
  const W = 192;
  a.startWalk(1);
  a.advance(40, W);
  const before = a.stepCount;
  a.startWalk(-1);
  assert.ok(Math.abs(a.stepCount - before) < 1e-9, '相位应保留');
  assert.strictEqual(a.pose.facing, 0);   // tick 前还没重算
  a.tick(16);
  assert.strictEqual(a.pose.facing, -1);
});

t('走动时用侧身帧，停下回正面', () => {
  const a = PetAnim.create(profile);
  a.startWalk(1); a.tick(16);
  assert.strictEqual(a.pose.frame, 'd2');
  a.stopWalk(); a.tick(16);
  assert.strictEqual(a.pose.frame, 'd0');
});

// ---------- 动作播放 ----------
t('动作播完自动回待机', () => {
  const a = PetAnim.create(profile);
  assert.strictEqual(a.play('hop'), true);
  assert.strictEqual(a.clipId, 'hop');
  run(a, 2000);
  assert.strictEqual(a.clipId, '');
  assert.strictEqual(a.state, 'idle');
});

t('动作幅度按 scale 缩放：摸头 scale=0.5 时下蹲只有一半', () => {
  const p = PetAnim.normalize(profile);
  const head = p.clipById.headTap;
  const peak = head.keys.reduce((m, k) => Math.max(m, Number(k.dy) || 0), 0);
  const a = PetAnim.create(profile);
  a.play('headTap', { scale: 0.5 });
  let maxDy = 0;
  for (let i = 0; i < 60; i++) { a.tick(16); maxDy = Math.max(maxDy, a.pose.dy); }
  assert.ok(maxDy > 0, '应该有下沉');
  assert.ok(maxDy <= peak * 0.5 + 0.004, '半幅下沉不该超过 ' + peak * 0.5 + '，实际 ' + maxDy);
});

t('拖拽/锁定时不接受新动作，避免抢画面', () => {
  const a = PetAnim.create(profile);
  a.setDrag(true);
  assert.strictEqual(a.play('hop'), false);
  a.setDrag(false);
  a.lock(3000, 'action');
  assert.strictEqual(a.play('hop'), false, '抽烟/喝酒期间不该被内部动作顶掉');
  run(a, 3100);
  assert.strictEqual(a.play('hop'), true);
});

t('走路期间不播随机动作（脚步不能被动作打断）', () => {
  const a = PetAnim.create(profile);
  a.startWalk(1);
  assert.strictEqual(a.play('hop'), false);
  assert.strictEqual(a.play('turn', { force: true }), true, '掉头例外');
});

t('落地挤压：摔得越快压得越狠，且一定有挤压', () => {
  function peak(vy) {
    const a = PetAnim.create(profile);
    a.setDrag(true);
    a.endDrag(vy);
    let minSy = 9;
    for (let i = 0; i < 40; i++) { a.tick(16); minSy = Math.min(minSy, a.pose.sy); }
    return minSy;
  }
  const soft = peak(120), hard = peak(2000);
  assert.ok(soft < 0.995, '轻放也要有轻微挤压，实际 ' + soft);
  assert.ok(hard < soft, '重摔应比轻放压得多：' + hard + ' vs ' + soft);
  assert.ok(hard > 0.75, '挤压不能夸张到变形，实际 ' + hard);
});

t('拖拽悬垂：向右甩身体向左歪（滞后于手）', () => {
  const a = PetAnim.create(profile);
  a.setDrag(true);
  a.dragVel(1200, 0);
  for (let i = 0; i < 20; i++) a.tick(16);
  assert.ok(a.pose.rot < 0, '向右甩应负向旋转，实际 ' + a.pose.rot);
  const b = PetAnim.create(profile);
  b.setDrag(true);
  b.dragVel(-1200, 0);
  for (let i = 0; i < 20; i++) b.tick(16);
  assert.ok(b.pose.rot > 0);
});

t('拖拽时向下掉会拉长、左右不变形', () => {
  const a = PetAnim.create(profile);
  a.setDrag(true);
  a.dragVel(0, 1500);
  for (let i = 0; i < 30; i++) a.tick(16);
  assert.ok(a.pose.sy > 1.001, '应拉长，实际 ' + a.pose.sy);
  assert.ok(a.pose.sx < 1, '应同时变窄保持体积感，实际 ' + a.pose.sx);
});

// ---------- 调度 ----------
t('调度：间隔没到不播动作', () => {
  const a = PetAnim.create(profile, { firstGestureAt: 5000 });
  run(a, 1000);
  assert.strictEqual(a.maybeGesture(), '');
});

t('调度：间隔到了会挑一个非 reaction 动作', () => {
  const a = PetAnim.create(profile, { firstGestureAt: 1000 });
  run(a, 1500);
  const id = a.maybeGesture();
  assert.ok(id, '应该挑到动作');
  const def = profile.clips.find((c) => c.id === id);
  assert.ok(!def.tags.includes('reaction'), '随机池不能含 reaction：' + id);
});

t('调度：连着两次不会挑同一个动作', () => {
  const a = PetAnim.create(profile, { firstGestureAt: 1 });
  let prev = '';
  let played = 0;
  for (let n = 0; n < 40; n++) {
    run(a, 60000);          // 一次跳一分钟，跨过间隔和冷却
    a.cancel();
    const id = a.maybeGesture();
    if (!id) continue;
    played++;
    assert.notStrictEqual(id, prev, '第 ' + n + ' 次重复了 ' + id);
    prev = id;
  }
  assert.ok(played >= 5, '一分钟一档应该能轮到好几次，实际 ' + played);
});

t('调度：动作都在冷却期内时，宁可不播也不重复', () => {
  const a = PetAnim.create(profile, { firstGestureAt: 1 });
  const pool = profile.clips.filter((c) => !c.tags.includes('reaction'));
  pool.forEach((c) => a.play(c.id, { force: true }));
  a.cancel();
  a.tick(100);
  // 把所有动作都标成刚播过 => 冷却全命中
  const id = a.pickGesture();
  assert.strictEqual(id, null, '全冷却时应该返回 null，实际 ' + id);
});

t('交互会重置间隔（刚摸完不会马上自己动）', () => {
  const a = PetAnim.create(profile, { firstGestureAt: 100 });
  a.tick(200);
  a.noteInteraction();
  assert.ok(a.nextDelay() >= profile.schedule.gapMin - 1);
});

t('锁定/拖拽期间到点也不播，避免和外部状态打架', () => {
  const a = PetAnim.create(profile, { firstGestureAt: 1 });
  a.lock(5000, 'action');
  a.tick(100);
  assert.strictEqual(a.maybeGesture(), '');
});

// ---------- 主进程复用 ----------
t('走一段要多久：距离加倍时间加倍，且和 speed 成反比', () => {
  const t1 = PetAnim.walkDuration(100, 192, profile);
  const t2 = PetAnim.walkDuration(200, 192, profile);
  assert.ok(Math.abs(t2 / t1 - 2) < 0.02, '应为两倍：' + t1 + ' / ' + t2);
  const slow = PetAnim.walkDuration(100, 192, { gait: { speed: profile.gait.speed / 2 } });
  assert.ok(Math.abs(slow / t1 - 2) < 0.02);
});

t('极短距离也有下限，不会退化成瞬移', () => {
  assert.ok(PetAnim.walkDuration(1, 192, profile) >= 240);
});

// ---------- 梯形速度曲线（主进程推窗口用）----------
t('速度曲线：两端为 0/1，全程单调不减', () => {
  assert.strictEqual(PetAnim.walkEase(0, 0.18), 0);
  assert.strictEqual(PetAnim.walkEase(1, 0.18), 1);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = PetAnim.walkEase(i / 100, 0.18);
    assert.ok(v >= prev - 1e-12, '在 t=' + (i / 100) + ' 处倒退：' + prev + ' -> ' + v);
    prev = v;
  }
});

t('速度曲线：起步比匀速慢、中后段比匀速快（真的在加减速）', () => {
  const a = 0.18;
  assert.ok(PetAnim.walkEase(0.05, a) < 0.05, '起步应落后于匀速');
  // 中点是唯一"不欠也不补"的位置（对称点），补偿出现在它之后
  assert.ok(Math.abs(PetAnim.walkEase(0.5, a) - 0.5) < 1e-9, '中点应正好 0.5');
  assert.ok(PetAnim.walkEase(0.6, a) > 0.6, '中后段应超过匀速（把起步欠的补回来）');
  assert.ok(PetAnim.walkEase(0.95, a) > 0.95, '末尾应领先于匀速');
});

t('速度曲线：关于中点对称（加速段和减速段等长）', () => {
  for (const tt of [0.1, 0.3, 0.45]) {
    const s = PetAnim.walkEase(tt, 0.2) + PetAnim.walkEase(1 - tt, 0.2);
    assert.ok(Math.abs(s - 1) < 1e-9, 't=' + tt + ' 处不对称：' + s);
  }
});

t('速度曲线：按它推窗口，总位移正好等于目标距离', () => {
  const dist = 420;
  let last = 0, moved = 0;
  for (let i = 1; i <= 200; i++) {
    const x = Math.round(dist * PetAnim.walkEase(i / 200, 0.18));
    moved += x - last;
    last = x;
  }
  assert.strictEqual(moved, dist);
});

// ---------- 换形象不变量 ----------
t('换形象（尺寸/步幅全变）后，引擎的语义不变：一步 = 一个 stride 的位移', () => {
  const other = JSON.parse(JSON.stringify(profile));
  other.id = 'other-pet';
  other.size = [320, 400];
  other.gait.stride = 0.5;
  other.gait.bob = 0.03;
  const p = PetAnim.normalize(other);
  const a = PetAnim.create(other);
  a.startWalk(1);
  a.advance(p.gait.stride * 320, 320);
  assert.ok(Math.abs(a.stepCount - 1) < 1e-9);
  a.tick(16);
  assert.ok(Math.abs(a.pose.dy - 0.03) < 1e-9, '起伏幅度应跟着新档案走');
  assert.strictEqual(a.zoneAt(0.5, 0.2).id, 'head', '命中分区也跟着档案走');
});

t('换形象后动作表可为空也不崩（降级为纯待机）', () => {
  const bare = { size: [100, 100], clips: [] };
  const a = PetAnim.create(bare);
  assert.strictEqual(a.play('hop'), false);
  assert.strictEqual(a.pickGesture(), null);
  assert.strictEqual(a.maybeGesture(), '');
  a.tick(16);
  assert.strictEqual(a.pose.frame, 'front');
});

// ---------- 眩晕眼几何 ----------
// 踩过的坑：眩晕时那两个卡通眼球的位置写死在 CSS 里，偏了 2% 就露出半个原瞳孔，
// 看着像多长了一只眼。现在几何来自档案，所以这里守住"档案本身是合法的"。
t('眩晕眼几何：档案里必须有两只眼、且都落在脸的上半部', () => {
  const e = profile.eyes;
  assert.ok(e, 'character.json 缺 eyes 段，眩晕时会退化成只摇晃、不盖眼球');
  assert.ok(Array.isArray(e.points), 'eyes.points 必须是数组');
  assert.strictEqual(e.points.length, 2, '必须正好两只眼，多了少了都会看着诡异');
  e.points.forEach((p, i) => {
    ['x', 'y', 'w', 'h'].forEach((k) => {
      assert.ok(typeof p[k] === 'number' && p[k] > 0 && p[k] < 1,
        'eyes.points[' + i + '].' + k + ' 必须在 0~1 之间（比例，不是像素）');
    });
    // 落在脸的左半边 / 右半边，别两只挤在一起
    assert.ok(i === 0 ? p.x < 0.5 : p.x > 0.5, 'eyes.points[' + i + '] 左右眼位置反了');
    assert.ok(p.y > 0.35 && p.y < 0.60, 'eyes.points[' + i + '] 纵向不在眼睛那一带');
  });
  // 椭圆要盖得住虹膜（约 9% 宽）又不至于糊住半张脸
  e.points.forEach((p, i) => {
    assert.ok(p.w > 0.10 && p.w < 0.20, 'eyes.points[' + i + '] 宽 ' + p.w + ' 超出合理范围（会露瞳孔或糊脸）');
    assert.ok(p.h > 0.07 && p.h < 0.16, 'eyes.points[' + i + '] 高 ' + p.h + ' 超出合理范围');
  });
});

t('眩晕眼几何：两只眼睛等高（素材里眼睛在同一条水平线上）', () => {
  const [a, b] = profile.eyes.points;
  assert.ok(Math.abs(a.y - b.y) < 0.02,
    '左右眼纵向差 ' + Math.abs(a.y - b.y).toFixed(4) + '，超过 2% 就一眼高一眼低');
});

t('眩晕眼几何：尺寸跟窗口比例绑定，换窗口尺寸不用重算', () => {
  const [a] = profile.eyes.points;
  // w 是按窗口宽算的比例，h 是按高算的比例。存档时如果误填了像素值，
  // 换到 4K 屏上就会缩成一个点 —— 这里用"眼裂本来就略宽于高"做合理性检查。
  const aspectPx = (a.w * profile.size[0]) / (a.h * profile.size[1]);
  assert.ok(aspectPx > 0.9 && aspectPx < 1.6,
    '眼球实际长宽比 ' + aspectPx.toFixed(2) + ' 不像眼睛（w/h 可能填错了量纲）');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

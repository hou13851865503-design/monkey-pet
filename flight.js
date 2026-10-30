// flight.js —— 抛飞物理（纯逻辑，不碰 Electron，可在 Node 里直接跑测试）
//
// 一句话：把"松手那一刻手的运动"变成"桌面上的一次飞行"，然后让它自己撞墙、减速、
// 停下来。主进程只管每帧 setPosition(x, y)，这里只管数字。
//
// **单位约定**：位置 px、速度 px/s、时间统一用 **毫秒**。
// 毫秒是为了和这个项目里其它模块（anim.tick / walkTick）保持一致 —— 一开始这里写的
// 是秒，结果调用方按毫秒传 16，被 maxStep 一夹变成 50ms，整条曲线全错却一句报错都没有
// （两只不同帧率跑出来一模一样的速度序列）。教训：跨模块的时间参数，单位必须跟
// 已有的那套走。
//
// 三条硬约束，缺一条就会在真机上炸：
//
// 1. **永远不出工作区**。边界清晰不是靠"撞了再修"，而是靠"位移分步 + 逐轴钳制"。
//    高速时不分子步会直接穿墙：3200px/s × 16ms = 51px，一步就能从墙内跳到墙外，
//    下一次判断时窗口已经半个身子在外头，"反弹"就变成了"从外面弹回来"。
//    所以按"单步位移 ≤ 6px"切分数值积分。
//
// 2. **一定停得下来**。空气阻力用指数衰减（v *= exp(-k·dt)），而指数衰减永远
//    到不了 0 —— 必须再叠一条"低于 stopSpeed 就地停"+ 一条总时长上限。
//    少了任何一条，一只被反复甩的宠会在几分钟后攒出"看着静止、其实永远在抖"的状态
//    （而且每帧都在 setPosition，白烧 CPU）。
//
// 3. **撞墙不只是翻符号**。法向按 restitution 衰减，切向也掉一点（wallFriction），
//    否则贴着墙飞的时候会一直擦着边滑出去，像没有摩擦的冰球。
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.PetFlight = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

  // 默认参数（character.json 的 throw 段可以逐项覆盖）。
  // 这几个值是按"甩一下大概飞 2~3 秒、撞两三次墙"反推的，不是随手写的：
  //   damping 1.05 => 速度半衰期 0.66s；
  //   restitution 0.74 => 每次撞墙剩 55% 动能，撞两下就明显慢下来；
  //   stopSpeed 110 => 约 0.6 个窗口宽/秒，低于它就"肉眼看着停了"，再抖没意义。
  const DEFAULTS = {
    damping: 1.05,        // 空气阻力（每秒）
    restitution: 0.74,    // 撞墙后保留多少法向速度
    wallFriction: 0.94,   // 撞墙时切向速度的损失（贴墙滑会减速）
    stopSpeed: 110,       // 低于这个速度（px/s）就地停下
    maxSpeed: 3200,       // 抛出速度上限，防止"暴力一甩"让窗口瞬移
    minThrow: 1000,        // 低于这个速度（px/s）不算甩，走原来的"放下 + 吸附"逻辑
    bumpRef: 2200,        // 撞墙力度归一化：这个速度撞上 = 力度 1
    maxFlight: 9000,      // 单次飞行的时长上限（毫秒），兜底用
    maxStep: 50,          // 单帧最多模拟多少毫秒：切后台/休眠回来不会一步跳穿
    substepPx: 6,         // 单步位移上限（px），决定穿不穿墙
  };

  function normalize(cfg) {
    const c = cfg || {};
    const o = {};
    Object.keys(DEFAULTS).forEach((k) => { o[k] = num(c[k], DEFAULTS[k]); });
    // 位置参数用更宽的边界兜住：写错了只是手感差，不能变成"永远飞"或"原地瞬移"
    o.damping = clamp(o.damping, 0.15, 6);
    o.restitution = clamp(o.restitution, 0, 0.98);
    o.wallFriction = clamp(o.wallFriction, 0.2, 1);
    o.stopSpeed = clamp(o.stopSpeed, 10, 1200);
    o.maxSpeed = clamp(o.maxSpeed, 200, 20000);
    o.minThrow = clamp(o.minThrow, 0, o.maxSpeed);
    o.maxFlight = clamp(o.maxFlight, 200, 60000);
    o.maxStep = clamp(o.maxStep, 4, 200);
    o.substepPx = clamp(o.substepPx, 1, 60);
    return o;
  }

  // 松手瞬间：把"手的运动"换算成"要抛出去的速度"。
  // 单独抽出来是因为阈值和限幅是这条交互里最容易被调坏的地方，
  // 放在纯函数里就能被单测钉住（见 tools/test-flight.cjs）。
  function launch(vx, vy, cfg) {
    const c = normalize(cfg);
    const x = num(vx, 0), y = num(vy, 0);
    const sp = Math.hypot(x, y);
    if (!(sp >= c.minThrow) || sp <= 0) return { on: false, vx: 0, vy: 0, speed: sp };
    const k = sp > c.maxSpeed ? c.maxSpeed / sp : 1;
    return { on: true, vx: x * k, vy: y * k, speed: sp * k };
  }

  // 新建一个飞行体。x/y 是**窗口左上角**（和 setPosition 一致，不是中心）。
  function body(x, y, vx, vy, w, h) {
    return {
      x: num(x, 0), y: num(y, 0),
      vx: num(vx, 0), vy: num(vy, 0),
      w: Math.max(1, num(w, 1)), h: Math.max(1, num(h, 1)),
      t: 0,
    };
  }

  function bump(axis, edge, speed, c) {
    return { axis, edge, power: clamp(speed / c.bumpRef, 0, 1) };
  }

  // 推进一帧。b 会被就地修改；返回这一帧发生了什么（撞了哪几面墙、停没停）。
  // dtMs = 距离上一帧过了多少毫秒；wa = 工作区 { x, y, width, height }。
  function step(b, dtMs, wa, cfg) {
    const c = normalize(cfg);
    const res = { bumps: [], done: false, speed: 0, x: b.x, y: b.y, vx: b.vx, vy: b.vy };
    let ms = num(dtMs, 0);
    if (!b || !(ms > 0) || !wa) return res;
    ms = clamp(ms, 0, c.maxStep);
    const dt = ms / 1000;
    b.t += ms;

    const minX = wa.x, minY = wa.y;
    const maxX = wa.x + wa.width - b.w;
    const maxY = wa.y + wa.height - b.h;

    // 窗口比工作区还大（缩放拉满 / 极小屏幕）：贴住左上角，别来回弹。
    // 注意必须**整轴跳过**钳制，不能只把速度归零 —— maxX < minX 时那句
    // `if (x > maxX)` 会把窗口直接推到负坐标去，看着像"被吸出屏幕外"。
    const stuckX = maxX <= minX, stuckY = maxY <= minY;
    if (stuckX) { b.vx = 0; b.x = minX; }
    if (stuckY) { b.vy = 0; b.y = minY; }

    // 分步：单步位移不超过 substepPx，这样任何速度都不会穿墙
    const n = clamp(Math.ceil(Math.hypot(b.vx, b.vy) * dt / c.substepPx), 1, 24);
    const sh = dt / n;
    for (let i = 0; i < n; i++) {
      b.x += b.vx * sh;
      b.y += b.vy * sh;

      if (!stuckX) {
        if (b.x < minX) {
          b.x = minX;
          res.bumps.push(bump('x', 'left', Math.abs(b.vx), c));
          b.vx = -b.vx * c.restitution;
          b.vy *= c.wallFriction;
        } else if (b.x > maxX) {
          b.x = maxX;
          res.bumps.push(bump('x', 'right', Math.abs(b.vx), c));
          b.vx = -b.vx * c.restitution;
          b.vy *= c.wallFriction;
        }
      }
      if (!stuckY) {
        if (b.y < minY) {
          b.y = minY;
          res.bumps.push(bump('y', 'top', Math.abs(b.vy), c));
          b.vy = -b.vy * c.restitution;
          b.vx *= c.wallFriction;
        } else if (b.y > maxY) {
          b.y = maxY;
          res.bumps.push(bump('y', 'bottom', Math.abs(b.vy), c));
          b.vy = -b.vy * c.restitution;
          b.vx *= c.wallFriction;
        }
      }

      // 阻尼按子步算，整帧多长都不影响衰减曲线
      const k = Math.exp(-c.damping * sh);
      b.vx *= k;
      b.vy *= k;
    }

    const sp = Math.hypot(b.vx, b.vy);
    res.speed = sp;
    res.x = b.x; res.y = b.y; res.vx = b.vx; res.vy = b.vy;
    if (sp < c.stopSpeed || b.t >= c.maxFlight) {
      b.vx = 0; b.vy = 0;
      res.vx = 0; res.vy = 0; res.speed = 0;
      res.done = true;
    }
    return res;
  }

  return { normalize, launch, body, step, DEFAULTS };
});

// anim.js —— 姿态引擎（纯逻辑，不碰 DOM，可单独在 Node 里跑测试）
//
// 设计要点（参考 dsh-pet 的动画链行为模型，但用程序化姿态替代逐帧视频）：
//
// 1. 状态机只做一件事：决定"这一帧该给什么姿态"。
//    外部（主进程 / 渲染层）只调用语义化接口：startWalk / play / setDrag / endDrag，
//    不直接改 transform。这样换形象、换窗口尺寸都不用动这里。
//
// 2. 步频由**位移**推进，不是由时间推进。
//    phase += 走过的像素 / 一步的像素，于是脚落地的节拍永远和地面移动量对齐 —— 这是
//    "看起来不打滑"的唯一原因。用定时器推相位，速度快慢一变就会滑。
//
// 3. 所有幅度都从档案里读，单位是窗口比例（dy 用高、dx 用宽）。
//    换角色只改 character.json，代码里没有任何 192/223 这种硬编码。
//
// 4. 动作 = 关键帧表 + 播放器，动作之间由调度器控制间隔。
//    间隔期内只允许待机/转头（quiet 标签），避免"一直在动"的烦躁感。
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.PetAnim = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);

  // 中性姿态：所有关键帧的偏差都相对它缩放
  //
  // 前五个通道作用于整只动物，后三个（head*）只作用于**头**。
  // 为什么要单独给头留通道：素材是单张位图，没有骨骼关节，整只一起平移/旋转时
  // "点头""摇头""歪头"看起来都是"整只猴子晃了一下"，人眼分不出来。把头从脖子处
  // 单切一层之后，头自己转 = 摇头、头自己沉 = 点头、头一半靠过去 = 歪头，才成立。
  const NEUTRAL = {
    dx: 0, dy: 0, rot: 0, sx: 1, sy: 1,
    headRot: 0, headDx: 0, headDy: 0, headSx: 1, headSy: 1,
  };

  // ---------- 档案规范化 ----------
  function normalize(raw) {
    const p = JSON.parse(JSON.stringify(raw || {}));
    p.size = Array.isArray(p.size) && p.size.length === 2 ? p.size.map(Number) : [192, 223];
    p.frames = p.frames || {};
    p.anchors = p.anchors || {};
    if (!Array.isArray(p.zones)) p.zones = [];
    if (!Array.isArray(p.clips)) p.clips = [];

    const g = p.gait || {};
    p.gait = {
      speed: num(g.speed, 0.62),        // 每秒走几个窗口宽
      stride: num(g.stride, 0.34),      // 一步覆盖几个窗口宽
      bob: num(g.bob, 0.024),
      sway: num(g.sway, 0.013),
      leanDeg: num(g.leanDeg, 3.2),
      rockDeg: num(g.rockDeg, 1.1),     // 每步身体前后摇摆的幅度（静态帧靠它避免"滑行感"）
      squash: num(g.squash, 0.06),
      accel: clamp(num(g.accel, 0.18), 0.02, 0.45),
    };
    const s = p.schedule || {};
    p.schedule = {
      gapMin: num(s.gapMin, 7000),
      gapMax: num(s.gapMax, 18000),
      cooldown: num(s.cooldown, 40000),
    };

    // 抛飞姿态：被甩出去之后身体怎么"受风"。
    // 只有观感参数 —— 物理（阻尼/反弹/阈值）在 flight.js，读的是同一个段里的 physics。
    // 分开是因为物理要能被单测钉住，而手感必须能随手改 0.01 就去试。
    const f = (p.throw && p.throw.pose) || {};
    p.throw = {
      leanPerPx: num(f.leanPerPx, 0.010),   // 横向速度 -> 身体后仰角度（deg per px/s）
      leanMax: num(f.leanMax, 16),          // 后仰角度上限
      leanEase: num(f.leanEase, 0.22),      // 倾角跟随的平滑系数（0~1，越大越跟手）
      stretchPerPx: num(f.stretchPerPx, 0.000032),  // 速度 -> 沿运动方向的拉伸量
      stretchMax: num(f.stretchMax, 0.075),
      bumpSquash: num(f.bumpSquash, 0.22),  // 撞墙压扁的强度
      bumpDecay: num(f.bumpDecay, 0.80),    // 撞墙压扁每帧衰减（0.8 => 约 150ms 回弹）
      headLag: num(f.headLag, 0.00004),     // 头的滞后量（vx * 这个值）
      headLagMax: num(f.headLagMax, 0.03),
      calmSpeed: num(f.calmSpeed, 700),     // 低于这个速度就不再摆惊讶脸
      airDy: num(f.airDy, -0.012),          // 腾空时整只往上抬一点
    };
    p.throw.leanPerPx = clamp(p.throw.leanPerPx, 0, 0.05);
    p.throw.leanMax = clamp(p.throw.leanMax, 0, 45);
    p.throw.leanEase = clamp(p.throw.leanEase, 0.02, 1);
    p.throw.stretchMax = clamp(p.throw.stretchMax, 0, 0.3);
    p.throw.bumpSquash = clamp(p.throw.bumpSquash, 0, 0.5);
    p.throw.bumpDecay = clamp(p.throw.bumpDecay, 0.3, 0.99);
    p.throw.headLagMax = clamp(p.throw.headLagMax, 0, 0.1);
    p.anchorFoot = clamp(num(p.anchors.foot, 0.995), 0.5, 1.2);

    // 底部安全余量：素材的脚底常常正好压在图片最后一行（本形象底部留白 0px），
    // 所以任何"往下沉"的位移都会被窗口裁掉 —— 用户看到的就是"走路时脚不见了"。
    // 渲染层会把整只动物上抬这么多，于是它只会在静止线以上活动，脚永远在窗口内。
    p.footRoom = clamp(num(p.anchors.footRoom, 0.018), 0, 0.08);

    // 脖子切线的位置（纵向比例）和头的旋转支点（横纵比例）。
    // 源码给的是"头顶那层从哪一行开始不再跟着身子"——量法见 tools/measure-neck.py：
    // 找轮廓宽度最小的那一行，就是下巴和肩膀之间的脖子。
    p.headGeom = {
      cut: clamp(num(p.anchors.headCut, 0.645), 0.15, 0.95),
      // pivot = 位移/缩放支点（脖子下方）；spin = 旋转支点（头心）
      // 分开的原因见 index.html：#headSpin 绕头心转，轮廓才不会被平移出去
      pivot: pair(p.anchors.headPivot, 0.5, 0.66),
      spin: pair(p.anchors.headSpin, 0.5, 0.36),
    };

    // 帧名解析：先查 emotions（cheer/shy…），再查顶层（front/side/turnA…）
    const emo = p.frames.emotions || {};
    p.resolveFrame = function (name) {
      if (!name) return '';
      if (emo[name]) return emo[name];
      if (typeof p.frames[name] === 'string') return p.frames[name];
      if (emo[name.replace(/^e_/, '')]) return emo[name.replace(/^e_/, '')];
      return name;   // 已经是 d0 / e_cheer 这种实际 key
    };

    // 关键帧按 t 排序，方便二分/顺序推进
    p.clips.forEach((c) => {
      c.dur = Math.max(60, num(c.dur, 1200));
      c.weight = Math.max(1, num(c.weight, 1));
      c.tags = Array.isArray(c.tags) ? c.tags : [];
      c.keys = (Array.isArray(c.keys) ? c.keys : []).slice()
        .sort((a, b) => num(a.t, 0) - num(b.t, 0));
      if (!c.keys.length) c.keys = [{ t: 0 }, { t: 1 }];
    });
    p.clipById = {};
    p.clips.forEach((c) => { p.clipById[c.id] = c; });
    return p;
  }
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function pair(v, dx, dy) {
    return Array.isArray(v) && v.length === 2
      ? [clamp(num(v[0], dx), 0, 1), clamp(num(v[1], dy), 0, 1)]
      : [dx, dy];
  }

  // ---------- 关键帧采样 ----------
  // 只插值关键帧里出现过的通道：没写的通道保持中性，于是"只改一个通道"的动作
  // 不会把别的通道拽回中性值。
  // 通道顺序有讲究：整只的在前面，头的在后面。渲染层会分别贴到 #gait 和 #head
  // 两个不同的层上，所以它们互不覆盖 —— 可以同时"身体下沉 + 头往下点"。
  const CHANNELS = ['dx', 'dy', 'rot', 'sx', 'sy', 'headRot', 'headDx', 'headDy', 'headSx', 'headSy'];
  const BODY_CHANNELS = ['dx', 'dy', 'rot', 'sx', 'sy'];
  const HEAD_CHANNELS = ['headRot', 'headDx', 'headDy', 'headSx', 'headSy'];
  function sampleKeys(keys, t) {
    const out = { frame: '' };
    CHANNELS.forEach((k) => { out[k] = NEUTRAL[k]; });

    // 用一个分段线性查表：对每个通道独立找前后两个"写了该通道"的关键帧，
    // 这样不同通道可以有不同的关键帧密度（比如 frame 只在几处切）。
    let prev = null;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const kt = num(k.t, 0);
      if (kt <= t) prev = k; else break;
    }
    const nextIdx = keys.findIndex((k) => num(k.t, 0) > t);
    const next = nextIdx === -1 ? null : keys[nextIdx];
    const cur = prev || keys[0];

    const t0 = cur ? num(cur.t, 0) : 0;
    const t1 = next ? num(next.t, 1) : 1;
    const span = Math.max(1e-6, t1 - t0);
    const raw = clamp((t - t0) / span, 0, 1);
    const e = smooth(raw);

    CHANNELS.forEach((ch) => {
      const a = cur && cur[ch] !== undefined ? num(cur[ch], NEUTRAL[ch]) : NEUTRAL[ch];
      const b = next && next[ch] !== undefined ? num(next[ch], NEUTRAL[ch]) : a;
      out[ch] = lerp(a, b, e);
    });

    // frame 是离散量：取"不晚于当前时刻"的最后一个声明
    for (let i = 0; i < keys.length; i++) {
      if (num(keys[i].t, 0) <= t && keys[i].frame) out.frame = keys[i].frame;
    }
    return out;
  }

  // ---------- 引擎 ----------
  function create(rawProfile, opts) {
    const P = normalize(rawProfile);
    const o = opts || {};
    const reactHz = num(o.reactHz, 1000);   // 内部时钟单位换算用，测试可调

    const st = {
      now: 0,
      state: 'idle',        // idle | walk | drag | land | gesture
      clip: null,           // { def, t0, scale }
      lockedUntil: 0,       // 这段时间内不接受新动作（抽烟/喝酒/睡觉等外部状态）
      external: '',         // 外部占用的语义状态：'action' | 'sleep' | 'focus' | ''
      walk: { on: false, dir: 1, phase: 0, dist: 0 },
      drag: { on: false, vx: 0, vy: 0, rot: 0, sy: 1, ax: 0, ay: 0 },
      fly: { on: false, vx: 0, vy: 0, rot: 0, bumpX: 0, bumpY: 0, air: 0 },
      lastGesture: '',
      lastAt: {},           // id -> 上次播放时间
      nextGestureAt: num(o.firstGestureAt, P.schedule.gapMin),
      pose: { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1, facing: 0, frame: '', state: 'idle' },
    };

    // 内部统一用这个判断，别直接读 st.busy（st 上没有这个字段）
    // fly 也算"忙"：飞在半空中被自主动作抢画面会非常跳（还可能在撞墙那一帧切表情）
    const isBusy = () => st.now < st.lockedUntil || st.state === 'drag' || st.state === 'fly';

    const api = {
      profile: P,
      get now() { return st.now; },
      get state() { return st.state; },
      get pose() { return st.pose; },
      get walking() { return st.walk.on; },

      // 外部状态（抽烟/喝酒/睡觉/专注）从外面锁住引擎，避免内部动作把画面顶掉
      lock(ms, kind) {
        st.lockedUntil = Math.max(st.lockedUntil, st.now + Math.max(0, ms));
        if (kind !== undefined) st.external = kind;
      },
      unlock() { st.lockedUntil = 0; st.external = ''; },
      get busy() { return isBusy(); },

      // ---- 碰撞/命中：换形象后命中跟着档案走 ----
      zoneAt(nx, ny) {
        for (const z of P.zones) {
          const b = z.box || [];
          if (b.length !== 4) continue;
          if (nx >= b[0] && nx <= b[2] && ny >= b[1] && ny <= b[3]) return z;
        }
        return null;
      },

      // ---- 动作 ----
      play(id, o2) {
        const def = P.clipById[id];
        if (!def) return false;
        if (isBusy()) return false;
        if ((o2 && o2.force) !== true && st.walk.on) return false;
        st.clip = {
          def,
          t0: st.now,
          scale: clamp(num(o2 && o2.scale, 1), 0.2, 2),
        };
        st.state = 'gesture';
        st.lastAt[id] = st.now;
        if (!def.tags.includes('reaction')) st.lastGesture = id;
        return true;
      },
      get clipId() { return st.clip ? st.clip.def.id : ''; },

      // 结束某个动作立刻回到待机（拖拽等打断用）
      cancel() { st.clip = null; if (st.state === 'gesture' || st.state === 'land') st.state = 'idle'; },

      // ---- 走动 ----
      startWalk(dir) {
        if (st.drag.on || isBusy()) return false;
        const d = dir < 0 ? -1 : 1;
        if (st.walk.on && st.walk.dir !== d) {
          st.walk.dir = d;                 // 掉头：相位不重置，脚步不会顿一下
          api.play('turn', { force: true });
          return true;
        }
        if (st.walk.on) return true;
        st.walk.on = true;
        st.walk.dir = d;
        st.walk.dist = 0;
        st.walk.phase = 0;
        st.clip = null;
        st.state = 'walk';
        return true;
      },
      // 主进程每帧告诉我们"这一帧走了多少像素"，相位按位移推进 => 脚步不打滑
      advance(dxPx, wPx) {
        if (!st.walk.on) return;
        const stepPx = Math.max(8, P.gait.stride * Math.max(1, wPx));
        const d = Math.abs(num(dxPx, 0));
        st.walk.dist += d;
        st.walk.phase += d / stepPx;
        if (st.walk.phase > 1e6) st.walk.phase %= 1;
      },
      stopWalk() {
        if (!st.walk.on) return;
        st.walk.on = false;
        st.walk.phase = 0;
        st.state = 'idle';
      },
      get stepCount() { return st.walk.phase; },
      // 本次走动累计走了多远（stopWalk 不清零，方便外部核对"走了几步"）
      get walkDistance() { return st.walk.dist; },

      // ---- 拖拽：悬空反馈 ----
      setDrag(on) {
        st.drag.on = !!on;
        if (on) {
          st.clip = null;
          st.state = 'drag';
          st.drag.rot = 0; st.drag.sy = 1; st.drag.ax = 0; st.drag.ay = 0;
        } else if (st.state === 'drag') {
          st.state = 'idle';
        }
      },
      dragVel(vx, vy) {
        st.drag.vx = num(vx, 0);
        st.drag.vy = num(vy, 0);
      },
      // 松手落地：竖直速度决定挤压强度
      endDrag(vy) {
        if (st.drag.on) { st.drag.on = false; st.state = 'idle'; }
        const k = clamp(Math.abs(num(vy, 0)) / 1400, 0.15, 1);
        return api.play('land', { force: true, scale: 0.45 + k * 0.75 });
      },

      // ---- 抛飞：被甩出去之后的腾空姿态 ----
      // 三个信号：起飞（初速）、飞行中每帧的真实速度、撞墙。
      // 速度必须每帧给 —— 只知道初速的话，撞墙之后身体会继续朝旧方向后仰。
      startFly(vx, vy) {
        const f = st.fly;
        f.on = true;
        f.vx = num(vx, 0); f.vy = num(vy, 0);
        f.rot = 0; f.bumpX = 0; f.bumpY = 0;
        st.clip = null;
        if (st.walk.on) { st.walk.on = false; st.walk.phase = 0; }
        st.state = 'fly';
        st.nextGestureAt = st.now + gap();   // 刚被甩过，别立刻自己找事做
      },
      flyVel(vx, vy) { st.fly.vx = num(vx, 0); st.fly.vy = num(vy, 0); },
      // 撞墙：只记强度，衰减和形变在 tick 里做 —— 免得多一个定时器
      bump(axis, power) {
        const p = clamp(num(power, 0), 0, 1);
        if (axis === 'y') st.fly.bumpY = Math.max(st.fly.bumpY, p);
        else st.fly.bumpX = Math.max(st.fly.bumpX, p);
      },
      // speed = 结束时的速度（决定落地压扁的力度）
      // land = 要不要播落地动作。半空中被抓住 / 窗口被隐藏时不播 ——
      //   抓飞在半空的宠会先收到 drag-start（setDrag 接管悬垂姿态），紧跟着再收到
      //   throw-end；这时如果播一段 600ms 的落地压扁，就会把"被拎在手里"的姿态顶掉。
      endFly(speed, land) {
        const f = st.fly;
        f.on = false; f.bumpX = 0; f.bumpY = 0;
        if (st.state === 'fly') st.state = 'idle';
        if (land === false) return false;
        const k = clamp(num(speed, 0) / 1400, 0.15, 1);
        return api.play('land', { force: true, scale: 0.45 + k * 0.75 });
      },
      get flying() { return st.fly.on; },

      // ---- 调度：什么时候自己搞点事 ----
      noteInteraction() {
        st.nextGestureAt = st.now + gap();
      },
      dueGesture() { return st.now >= st.nextGestureAt; },
      nextDelay() { return st.nextGestureAt - st.now; },
      pickGesture() {
        const pool = P.clips.filter((c) => !c.tags.includes('reaction'));
        if (!pool.length) return null;
        // 冷却和"不连着放同一个"都是硬约束：全在冷却里就宁可这轮不播，
        // 也不要为了凑一个动作而破坏节奏感。
        const cand = pool.filter((c) => {
          if (c.id === st.lastGesture) return false;
          const last = st.lastAt[c.id];
          return !(last !== undefined && st.now - last < P.schedule.cooldown);
        });
        if (!cand.length) return null;
        let total = 0;
        cand.forEach((c) => { total += c.weight; });
        let r = Math.random() * total;
        for (const c of cand) {
          r -= c.weight;
          if (r <= 0) return c.id;
        }
        return cand[cand.length - 1].id;
      },
      // 到点了就自己挑一个动作播；返回播了什么（没播返回 ''）
      maybeGesture() {
        if (!api.dueGesture()) return '';
        st.nextGestureAt = st.now + gap();
        if (isBusy() || st.walk.on || st.clip || st.external) return '';
        const id = api.pickGesture();
        if (!id) return '';
        return api.play(id) ? id : '';
      },

      // ---- 每帧推进 ----
      tick(dtMs) {
        const dt = clamp(num(dtMs, 16), 0, 200);
        st.now += dt;

        // 1) 动作关键帧
        let pose = {};
        CHANNELS.forEach((ch) => { pose[ch] = NEUTRAL[ch]; });
        pose.frame = '';
        if (st.clip) {
          const c = st.clip;
          const t = (st.now - c.t0) / c.def.dur;
          if (t >= 1) {
            st.clip = null;
            if (st.state === 'gesture' || st.state === 'land') st.state = 'idle';
          } else {
            const s = sampleKeys(c.def.keys, clamp(t, 0, 1));
            const k = c.scale;
            CHANNELS.forEach((ch) => {
              pose[ch] = NEUTRAL[ch] + (s[ch] - NEUTRAL[ch]) * k;
            });
            pose.frame = s.frame;
          }
        }

        // 2) 走动步态：由位移相位驱动
        let facing = 0;
        if (st.walk.on) {
          const g = P.gait;
          const p = st.walk.phase;
          const ph = (p % 1) * Math.PI * 2;
          // 起伏：落脚瞬间 = 静止高度（0），两脚之间抬到最高（-bob）。
          // 原来写的是 (0.5+0.5cos)，落脚时反而往下沉一个 bob —— 素材脚底贴在窗口
          // 最底一行、没有余量，这一沉就把整只脚推出窗口裁掉了。重心起伏应该在
          // "地面线以上"，而不是"踩进地面里"。
          const bob = -g.bob * (0.5 - 0.5 * Math.cos(ph));
          const sway = g.sway * Math.sin(ph);
          const sq = g.squash * Math.max(0, Math.cos(ph));
          pose.dy += bob;
          pose.dx += sway * st.walk.dir;
          pose.sy *= 1 - sq * 0.5;
          pose.sx *= 1 + sq * 0.5;
          // 前倾 (lean，朝行进方向) + 摇摆 (rock，每步左右各晃一次)。
          // 摇摆是"静态侧身帧不像滑行"的关键：速度感来自身体重心的周期性偏移，
          // 而不只是位置在平移。
          pose.rot += st.walk.dir * g.leanDeg + g.rockDeg * Math.sin(ph);
          facing = st.walk.dir;
        }

        // 3) 拖拽悬垂：身体滞后于手的运动方向
        if (st.drag.on) {
          const d = st.drag;
          const rotT = clamp(-d.vx * 0.018, -20, 20);
          const syT = 1 + clamp(Math.abs(d.vy) * 0.00045, 0, 0.1);
          d.rot += (rotT - d.rot) * 0.22;
          d.sy += (syT - d.sy) * 0.18;
          const wander = Math.sin(st.now / 420) * 1.1;
          pose.rot += d.rot + wander;
          pose.sy *= d.sy;
          pose.sx *= 1 - (d.sy - 1) * 0.55;
          pose.dy -= clamp(Math.abs(d.vy) * 0.00002, 0, 0.012);
        }

        // 4) 抛飞：身体朝运动反方向后仰 + 沿运动方向拉长 + 撞墙压扁
        //
        // 为什么倾斜方向是"反方向"：被甩出去的东西，重心在后面、被推的部分在前面，
        // 看起来就是"身体落在运动的后面"。和手里拎着甩（drag）用的是同一个符号。
        if (st.fly.on) {
          const f = st.fly, C = P.throw;
          const sp = Math.hypot(f.vx, f.vy);

          // 倾角：横向速度为主，纵向速度给一点点（往上下飞时"头朝那边偏"）
          const rotT = clamp(-f.vx * C.leanPerPx, -C.leanMax, C.leanMax)
                     + clamp(f.vy * C.leanPerPx * 0.25, -C.leanMax * 0.3, C.leanMax * 0.3);
          f.rot += (rotT - f.rot) * C.leanEase;
          pose.rot += f.rot;

          // 风压：速度越快沿运动方向拉得越长。分轴施加，斜着飞时两个轴都有份。
          const stretch = clamp(sp * C.stretchPerPx, 0, C.stretchMax);
          if (sp > 1) {
            const hx = Math.abs(f.vx) / sp, hy = Math.abs(f.vy) / sp;
            pose.sx *= 1 + stretch * hx;
            pose.sy *= 1 + stretch * hy;
            // 拉长的那一轴拿去补另一轴，整只的体积才不会被"吹大"
            pose.sx *= 1 - stretch * hy * 0.5;
            pose.sy *= 1 - stretch * hx * 0.5;
          }

          // 撞墙：撞左右墙压横向、撞上下墙压纵向，然后按 bumpDecay 弹回来。
          // 衰减放这里而不是在 bump() 里，是为了不额外开定时器 —— 每帧顺手乘一下。
          f.bumpX *= C.bumpDecay;
          f.bumpY *= C.bumpDecay;
          if (f.bumpX > 0.01) { pose.sx *= 1 - f.bumpX * C.bumpSquash; pose.sy *= 1 + f.bumpX * C.bumpSquash * 0.8; }
          if (f.bumpY > 0.01) { pose.sy *= 1 - f.bumpY * C.bumpSquash; pose.sx *= 1 + f.bumpY * C.bumpSquash * 0.8; }

          // 头被风甩在后面（整只后仰时头再慢半拍，才不像一根棍子）
          pose.headDx += clamp(-f.vx * C.headLag, -C.headLagMax, C.headLagMax);
          pose.headDy += clamp(-f.vy * C.headLag * 0.5, -C.headLagMax * 0.5, C.headLagMax * 0.5);
          pose.headRot += clamp(-f.rot * 0.35, -8, 8);
        }

        // 腾空感：起飞抬起来、落地压回去。用系数过渡而不是直接开关 ——
        // airDy 是 0.012（约 3px），一帧内跳变在静止的小猴身上看得出来。
        // 这一段故意放在 st.fly.on 外面：落地那一帧 on 已经变 false，但还得把空气感收回去。
        {
          const f = st.fly;
          f.air += ((f.on ? 1 : 0) - f.air) * 0.2;
          if (f.air > 0.002) pose.dy += P.throw.airDy * f.air;
        }

        // 5) 帧选择：动作指定 > 走动用侧身 > 待机正面
        let frame = pose.frame;
        if (!frame) {
          if (st.walk.on) frame = 'side';
          else frame = 'front';
        }
        if (st.state === 'drag' && !st.clip) frame = 'surprised';
        // 飞得快的时候是"被甩懵了"的脸，快停下时松一口气（换回正面）
        if (st.fly.on && !st.clip) {
          frame = Math.hypot(st.fly.vx, st.fly.vy) > P.throw.calmSpeed ? 'surprised' : 'front';
        }

        // 6) 安全网：脚是地面接触点，任何把它推出窗口的下沉都不成立。
        // 渲染层已经把整只动物上抬了 footRoom，所以 dy 一旦超过 footRoom，脚底
        // 就会跑到窗口外面被裁掉。动作表里已经没有一个动作下沉超过这个量，
        // 这条纯粹是防止以后新增动作时又把这条约束踩了。
        pose.dy = Math.min(pose.dy, P.footRoom);

        st.pose = {
          dx: pose.dx, dy: pose.dy, rot: pose.rot,
          sx: pose.sx, sy: pose.sy,
          headRot: pose.headRot, headDx: pose.headDx, headDy: pose.headDy,
          headSx: pose.headSx, headSy: pose.headSy,
          facing: facing || st.walk.dir * (st.walk.on ? 1 : 0),
          frame: P.resolveFrame(frame),
          state: st.state,
        };
        return st.pose;
      },
    };

    function gap() {
      const s = P.schedule;
      return s.gapMin + Math.random() * Math.max(0, s.gapMax - s.gapMin);
    }

    return api;
  }

  // ---------- 供主进程复用：走一段路要多久 ----------
  // 主进程按这个时长推窗口位置，渲染层按实际位移推相位 —— 两边不用互相同步时钟。
  function walkDuration(distPx, winW, profile) {
    const g = (profile && profile.gait) || {};
    const speed = Math.max(0.05, num(g.speed, 0.62));
    const pxPerSec = speed * Math.max(1, num(winW, 192));
    return Math.max(240, Math.abs(distPx) / pxPerSec * 1000);
  }

  // 梯形速度曲线：起步加速 → 中段匀速 → 末尾减速，返回 0..1 的**位移完成度**。
  // 匀速平移是"传送带感"的主要来源，加了加减速才有"自己走过去"的重量。
  // accel = 加减速各占整段的比例，越小越接近匀速。
  function walkEase(t, accel) {
    const a = clamp(num(accel, 0.18), 0.02, 0.45);
    const u = clamp(num(t, 0), 0, 1);
    const norm = 2 * a * (1 - a);
    let s;
    if (u <= a) s = (u * u) / norm;
    else if (u <= 1 - a) s = (a / 2 + (u - a)) / (1 - a);
    else { const y = 1 - u; s = 1 - (y * y) / norm; }
    return clamp(s, 0, 1);
  }

  return {
    create, normalize, sampleKeys, walkDuration, walkEase, NEUTRAL, clamp,
    CHANNELS, BODY_CHANNELS, HEAD_CHANNELS,
  };
});

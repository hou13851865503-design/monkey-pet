// 渲染进程：2D 八面图 + 情绪图 桌宠
// - 17 张素材叠层，靠 opacity 交叉淡入 => 切帧连贯
// - 朝向映射禁用 04/05/06（带背面）=> 永不露背
// - #tilt 透视倾斜 => 伪 3D 跟随鼠标
// - #gait 步态层 => 走路起伏 / 落地压扁 / 拖拽悬垂（anim.js 每帧算姿态）
// - 长按 + 滚轮 => 缩放
// - 系统闲置 => 睡觉；键鼠动 => 醒
// - 鼠标在身上快速来回 => 撸它（害羞/喜欢）
// - 双击 => 情绪菜单；单击 => 按部位给不同反应
// - 番茄钟专注态 => 思考脸
// 状态机：idle / emotion / drag / sleepy / focus / action / walk / gesture
// 角色相关的数值（步幅、命中盒、脚底支点、动作表）全在 character.json，
// 这里只负责把引擎算出来的姿态贴到 DOM 上。
(function () {
  const stage = document.getElementById('stage');
  const tilt = document.getElementById('tilt');
  const gaitEl = document.getElementById('gait');
  const breath = document.getElementById('breath');
  const headEl = document.getElementById('head');
  const headSpin = document.getElementById('headSpin');
  const headImg = headEl ? headEl.querySelector('img') : null;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ipc = window.pet || null;

  // 眩晕 / 喝酒抽烟等"正在做动作"的状态，提前声明避免 enter() 里的 TDZ
  let dizzyUntil = 0, dizzyTimer = null;
  let actionUntil = 0, actionTimer = null;

  // ---- 素材：8 朝向(d0..d7) + 9 情绪(e_xxx) ----
  const imgs = {};
  function addFrame(key, src) {
    const im = document.createElement('img');
    im.className = 'f';
    im.src = src;
    im.draggable = false;
    breath.appendChild(im);
    imgs[key] = im;
  }
  for (let i = 0; i < 8; i++) addFrame('d' + i, `./assets/${String(i + 1).padStart(2, '0')}.png`);

  // ---- 眩晕眼：在两只眼睛的位置画旋转的螺旋（盖住原瞳孔）----
  function spiralPath(cx, cy, r0, r1, turns, steps) {
    let d = '';
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = t * turns * Math.PI * 2;
      const r = r0 + (r1 - r0) * t;
      d += (i ? ' L' : 'M') + (cx + Math.cos(a) * r).toFixed(2) + ' ' + (cy + Math.sin(a) * r).toFixed(2);
    }
    return d;
  }
  ['angry', 'cheer', 'love', 'sad', 'shy', 'sleepy', 'surprised', 'thinking', 'wink']
    .forEach((n) => addFrame('e_' + n, `./assets/emotion_${n}.png`));

  let current = null;
  let frozenPose = null;   // 仅测试用：非 null 时主循环只贴这一帧（见 __petStrip）
  function show(key, force) {
    // 定格取帧期间禁止别的代码换帧：朝向跟随、眨眼、情绪定时器都还在跑，
    // 它们会把定格的那一帧顶掉（对比图里就会混进侧脸和眯眼）。
    if (frozenPose && force !== true) return;
    if (key === current) return;
    if (current && imgs[current]) imgs[current].classList.remove('active');
    if (imgs[key]) imgs[key].classList.add('active');
    current = key;
    // 头层是同一张图的第二份拷贝：换帧必须同步，否则头还是上一张脸。
    // 图已经在文档里加载过了，这里只是换个 src 指向同一个已解码资源，不会闪白。
    if (headImg && imgs[key] && headImg.getAttribute('src') !== imgs[key].getAttribute('src')) {
      headImg.setAttribute('src', imgs[key].getAttribute('src'));
    }
    // 告诉主进程当前帧，主进程据此做"透明处穿透"的像素判定
    try { if (window.pet && window.pet.setFrame) window.pet.setFrame(key); } catch (_) {}
  }

  // 朝向：素材只有"正面/轻微右转/右侧面"，没有左向帧（04/05/06 是背面）。
  // 左向 = 把右向帧水平镜像，身体和眼神一起翻，效果自然。
  const POSITIVE = ['cheer', 'love', 'shy'];

  let state = 'idle';
  let focusing = false;
  let dirK = 0;          // -1 看左(镜像) / 0 正面 / 1 看右；只有这两张帧
  let lastCursorAt = 0;  // 最近一次收到光标事件的时间（自主环顾要避让）
  let direction = 0;
  let blinkTimer = null, emotionTimer = null;

  // ---- 姿态引擎 ----
  // 角色档案由主进程读 character.json 后同步过来（尺寸、命中盒、脚底支点、步幅、动作表）。
  // 读不到就降级成"只有朝向、没有动作表"，绝不因为档案问题白屏。
  const FALLBACK_PROFILE = {
    size: [192, 223],
    frames: {
      front: 'd0', side: 'd2',
      emotions: {
        angry: 'e_angry', cheer: 'e_cheer', love: 'e_love', sad: 'e_sad', shy: 'e_shy',
        sleepy: 'e_sleepy', surprised: 'e_surprised', thinking: 'e_thinking', wink: 'e_wink',
      },
    },
    zones: [
      { id: 'head', box: [0.24, 0.03, 0.80, 0.46], reaction: 'headTap' },
      { id: 'body', box: [0.14, 0.46, 0.94, 1.00], reaction: 'bodyTap' },
    ],
    eyes: {
      ink: '#2f2116',
      points: [
        { x: 0.47526, y: 0.47657, w: 0.14344, h: 0.10621 },
        { x: 0.66276, y: 0.47657, w: 0.14344, h: 0.10621 },
      ],
    },
    clips: [],
  };
  let profile = FALLBACK_PROFILE;
  try {
    const fromMain = ipc && ipc.getCharacter ? ipc.getCharacter() : null;
    if (fromMain && Array.isArray(fromMain.clips) && fromMain.clips.length) profile = fromMain;
  } catch (_) {}
  const anim = window.PetAnim.create(profile);
  // 调试句柄：自动化测试要核对"主进程发了位移、渲染层步频有没有真的跟着走"，
  // 没有这个就只能看到窗口在动、看不到脚步在走。
  window.__petAnim = anim;
  // 脚底支点跟着档案走：换形象后旋转/挤压自动绕新素材的脚底发生
  try {
    if (profile.anchors && profile.anchors.foot) {
      document.documentElement.style.setProperty('--foot', String(profile.anchors.foot * 100) + '%');
    }
  } catch (_) {}

  // ---- 眩晕眼：盖住原瞳孔的卡通眼球 + 眼球里的旋转螺旋 ----
  // 几何全部来自档案（character.json 的 eyes），不是写死的像素。
  // 这是之前踩过的坑：位置写死在 CSS 里，素材一换（甚至只是量错 2%）就会露出半个
  // 原瞳孔，看着像多长了一只眼。所以现在按档案生成，档案没给就干脆不画。
  //
  // 螺旋本身就是"眩晕"，它必须在**眼睛里**转。原来它挂在 #stage 下的 #swirl 上，
  // 也就是窗口坐标系 —— 眩晕时身体在 dizzyWobble、头在跑，那个圈不跟着跑，
  // 就变成贴在屏幕上的一张贴纸。搬进来之后，锚点、尺寸、裁切全跟着眼球走。
  (function buildDizzyEyes() {
    const host = document.getElementById('eyes');
    if (!host) return;
    host.innerHTML = '';
    const def = profile.eyes;
    const pts = def && Array.isArray(def.points) ? def.points : [];
    if (!pts.length) return;   // 没量过眼球位置：只靠身体摇晃，不硬画
    const ink = def.ink || '#2f2116';
    // 圈数是被尺寸逼出来的，不是随手写的。眼球只有 27×23 px，螺旋每转一圈半径才
    // 前进 (8.8-1.6)/圈数；圈数一多，相邻两圈的白缝就比线宽还窄，整只眼睛会糊成
    // 一个黄甜甜圈（2.55 圈 / 2.5px 就是那样）。1.6 圈时缝宽 (7.2/1.6 - 1.9) ≈ 2.6
    // 单位 ≈ 2.8px，比线宽 1.9 还宽 —— 这才是"看得出是螺旋"的下限。
    // 圆心再点一个墨色瞳点，小尺寸下它负责"这是一只眼睛"，螺旋负责"在晕"。
    const svg =
      '<svg viewBox="0 0 24 24" preserveAspectRatio="none" aria-hidden="true">' +
        '<path d="' + spiralPath(12, 12, 1.6, 8.8, 1.6, 96) + '" fill="none" stroke="#e2870c" stroke-width="1.9" stroke-linecap="round"/>' +
        '<circle cx="12" cy="12" r="1.5" fill="' + ink + '"/>' +
      '</svg>';
    pts.forEach((pt) => {
      const el = document.createElement('i');
      el.className = 'eye';
      el.style.left = (pt.x * 100).toFixed(3) + '%';
      el.style.top = (pt.y * 100).toFixed(3) + '%';
      el.style.width = (pt.w * 100).toFixed(3) + '%';
      el.style.height = (pt.h * 100).toFixed(3) + '%';
      el.innerHTML = svg;
      host.appendChild(el);
    });
  })();

  // ---- 抽烟的道具几何 ----
  // 同样是坑过一次的东西：烟的位置和长度原来写死在 CSS 里（55.5% / 62.5% / 17% 长 / 26°），
  // 结果火头正好落在眼球高度，看着像烟烧进了眼睛。根因是这只猴子嘴（62%）到眼睛下缘（53%）
  // 之间只有 8% 的竖直空间，烟只要竖着往上叼就一定顶眼睛 —— 所以改成几乎横着斜出去。
  // 现在几何全在 character.json 的 props.cig，并且顺手把烟柱起点也挂到火头上。
  const CIG_FALLBACK = {
    frame: 'e_sleepy', at: [0.545, 0.622], deg: 72,
    len: 0.15, width: 0.028, burnSpan: 0.12,
  };
  const cig = Object.assign({}, CIG_FALLBACK, (profile.props && profile.props.cig) || {});
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const cigDeg = num(cig.deg, 72);
  const cigLen = num(cig.len, 0.15);
  const cigAt = Array.isArray(cig.at) ? cig.at : CIG_FALLBACK.at;
  const cigBurn = num(cig.burnSpan, 0.12);

  (function applyCigStyle() {
    const st = document.documentElement.style;
    st.setProperty('--cig-x', (num(cigAt[0], 0.545) * 100).toFixed(2) + '%');
    st.setProperty('--cig-y', (num(cigAt[1], 0.622) * 100).toFixed(2) + '%');
    st.setProperty('--cig-w', (num(cig.width, 0.028) * 100).toFixed(2) + '%');
    st.setProperty('--cig-len', (cigLen * 100).toFixed(2) + '%');
    st.setProperty('--cig-burn', (cigBurn * 100).toFixed(2) + '%');
    st.setProperty('--cig-deg', cigDeg.toFixed(2) + 'deg');
  })();

  // 火头位置 = 支点 + 当前长度沿倾角方向。烧短了火头会往嘴里退，烟柱得跟着退，
  // 否则抽到后半段烟就从"空中"冒出来了。
  // 注意 len 是按窗口高算的比例，横向位移要换算到窗宽：dx% = len * (H/W) * sin。
  const winRatio = (profile.size && profile.size[1] && profile.size[0])
    ? profile.size[1] / profile.size[0] : 1.16;
  function applyCigTip(burn) {
    const th = (cigDeg * Math.PI) / 180;
    const left = Math.max(0, cigLen - Math.min(0.55, Math.max(0, burn || 0)) * cigBurn);
    const ax = num(cigAt[0], 0.545);
    const ay = num(cigAt[1], 0.622);
    const x = ax + left * winRatio * Math.sin(th);
    const y = ay - left * Math.cos(th);
    const st = document.documentElement.style;
    st.setProperty('--cig-tip-x', (x * 100).toFixed(2) + '%');
    st.setProperty('--cig-tip-y', (y * 100).toFixed(2) + '%');
  }
  applyCigTip(0);

  // ---- 头层的切线/支点 ----
  // 头层靠一条横向蒙版把脖子以上切下来。切线在脖子上（轮廓最窄处），
  // 支点也在脖子上 —— 于是"头转"是绕脖子转，"头沉"是头往下压，身体不动。
  (function applyHeadGeom() {
    const g = (window.PetAnim && window.PetAnim.normalize(profile).headGeom) || { cut: 0.645, pivot: [0.5, 0.66] };
    const st = document.documentElement.style;
    st.setProperty('--head-cut', (g.cut * 100).toFixed(2) + '%');
    st.setProperty('--head-px', (g.pivot[0] * 100).toFixed(2) + '%');
    st.setProperty('--head-py', (g.pivot[1] * 100).toFixed(2) + '%');
    // 旋转支点单独一个：绕头心转才不会让整个头的轮廓平移出去（见 index.html 的注释）
    st.setProperty('--head-spx', (g.spin[0] * 100).toFixed(2) + '%');
    st.setProperty('--head-spy', (g.spin[1] * 100).toFixed(2) + '%');
    st.setProperty('--head-feather', ((profile.anchors && profile.anchors.headFeather) || 0.032) * 100 + '%');
  })();

  // 底部安全余量：整只动物在窗口里往上抬这么多。
  // 素材的脚底正好压在图片最后一行（底部留白 0px），所以只要姿态里有任何
  // "往下沉"（走路的起伏、落地下压、呼吸那 2px），脚就会被窗口底边整块裁掉。
  // 引擎已经把 dy 钳在 footRoom 以内，这里再把整体抬起来，脚就永远在窗口里。
  const footRoom = (anim.profile && anim.profile.footRoom) || 0;

  // 把引擎算出的姿态贴到 #gait（铺满窗口，所以百分比位移 = 窗口比例，天然与尺寸无关）
  function applyPose(pose) {
    gaitEl.style.transform =
      'translate(' + (pose.dx * 100).toFixed(3) + '%, ' +
        ((pose.dy - footRoom) * 100).toFixed(3) + '%)' +
      ' rotate(' + pose.rot.toFixed(2) + 'deg)' +
      ' scale(' + pose.sx.toFixed(4) + ', ' + pose.sy.toFixed(4) + ')';

    // 头层：单独的位移 + 旋转 + 缩放，#gait 那套不参与，所以头和身子可以各动各的。
    // 头像的缩放支点就在脖子上（蒙版切线下方一点），于是"头缩一下"是头朝脖子压下去
    // —— 这正是点头的样子，而且蒙版边界不动，不会有接缝。
    if (headEl) {
      const hr = pose.headRot || 0, hx = pose.headDx || 0, hy = pose.headDy || 0;
      const hsx = pose.headSx === undefined ? 1 : pose.headSx;
      const hsy = pose.headSy === undefined ? 1 : pose.headSy;
      const on = Math.abs(hr) > 0.12 || Math.abs(hx) > 0.0008 || Math.abs(hy) > 0.0008 ||
        Math.abs(hsx - 1) > 0.0012 || Math.abs(hsy - 1) > 0.0012;
      if (on) {
        headEl.style.transform =
          'translate(' + (hx * 100).toFixed(3) + '%, ' + (hy * 100).toFixed(3) + '%)' +
          ' scale(' + hsx.toFixed(4) + ', ' + hsy.toFixed(4) + ')';
        if (headSpin) headSpin.style.transform = 'rotate(' + hr.toFixed(2) + 'deg)';
      } else {
        if (headEl.style.transform) headEl.style.transform = '';
        if (headSpin && headSpin.style.transform) headSpin.style.transform = '';
      }
      document.body.classList.toggle('head-on', on);
    }
  }

  // 只有"走动 / 拖拽 / 抛飞 / 播动作"这几件事由引擎决定帧和镜像；
  // 其余时间（待机）还是按鼠标朝向选帧，保持原有手感。
  function animOwnsFrame() {
    return anim.walking || anim.state === 'drag' || anim.state === 'fly' || !!anim.clipId;
  }
  function applyAnimFrame(pose) {
    if (!animOwnsFrame()) return;
    if (anim.walking) {
      dirK = pose.facing;
      document.body.classList.toggle('faceLeft', pose.facing < 0);
    } else if (anim.state !== 'drag') {
      document.body.classList.remove('faceLeft');
    }
    if (pose.frame) show(pose.frame);   // 空帧（比如纯挤压动作）不动当前脸
  }

  // ---- 定格取帧（只给自动化测试用）----
  // 为什么需要：按时间采样截图的时机永远对不准。"抖一抖"0.9 秒抖 7 个来回，
  // 截图一张要几十毫秒，采到的相位完全随机 —— 有时正好全落在过零点，看起来
  // 就"根本没动"。这个钩子直接把动作按归一化时间 t 定格，想要哪一帧给哪一帧。
  window.__petStrip = function (id, t) {
    const def = anim.profile.clipById[id];
    if (!def) return false;
    const s = window.PetAnim.sampleKeys(def.keys, clamp(t, 0, 1));
    frozenPose = {
      dx: s.dx, dy: s.dy, rot: s.rot, sx: s.sx, sy: s.sy,
      headRot: s.headRot, headDx: s.headDx, headDy: s.headDy,
      headSx: s.headSx, headSy: s.headSy,
      frame: anim.profile.resolveFrame(s.frame || 'front'),
      facing: 0, state: 'gesture',
    };
    applyPose(frozenPose);
    show(frozenPose.frame, true);
    return true;
  };

  // 引擎的状态变化同步到渲染层状态机：走完/播完都要回到待机，否则朝向会卡住
  let animPhase = '';
  function syncAnimState() {
    // fly 也在这里收口：主进程那边可能因为"被抓住 / 窗口隐藏 / 出错"提前收手，
    // 那条路不一定发 throw-end。引擎的 flying 才是唯一真相。
    if (!anim.flying && animPhase === 'fly') {
      animPhase = '';
      if (state === 'fly') enter(focusing ? 'focus' : 'idle');
    }
    const cur = anim.walking ? 'walk' : (anim.clipId ? 'gesture' : (anim.flying ? 'fly' : 'idle'));
    if (cur === animPhase) return;
    const prev = animPhase;
    animPhase = cur;
    if (cur === 'walk') state = 'walk';
    else if (cur === 'gesture') state = 'gesture';
    else if (cur === 'fly') state = 'fly';
    else if (prev === 'walk' || prev === 'gesture') {
      enter(focusing ? 'focus' : 'idle');
      try { if (ipc && ipc.refreshFacing) ipc.refreshFacing(); } catch (_) {}
    }
  }

  function showDirection() {
    // 只有真正空闲时才换朝向帧：动作/情绪/拖拽/眩晕/专注期间一律让路，
    // 否则鼠标一动就会把正在播的动作帧顶掉，形成来回闪。
    if (state !== 'idle' || isBusy() || focusing) return;
    const k = dirK;
    // 只用两种朝向：正面(01) / 侧面(03)。02 那张 3/4 帧朝向与 03 不一致，弃用。
    document.body.classList.toggle('faceLeft', k < 0);
    show(k === 0 ? 'd0' : 'd2');
  }

  // 带迟滞的朝向判定：只有"明显偏在侧面"才转侧脸，其余一律正脸。
  // 条件有两个，必须同时满足 —— ① 横向够远（>SIDE_ON）② 横向明显大于纵向（不只是斜上方/斜下方）。
  // 这样鼠标在头顶上、脚下、或斜对角时都是正脸，符合"想看见正脸偏多"。
  const SIDE_ON = 260, SIDE_OFF = 190;
  function dirFrom(dx, dy, cur) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const sideways = ax > ay * 1.15;          // 是否"主要偏在侧面"
    if (cur === 0) {
      if (ax >= SIDE_ON && sideways) return dx < 0 ? -1 : 1;
      return 0;
    }
    if (ax < SIDE_OFF || !sideways) return 0; // 收窄了才回正，避免边界抖动
    return dx < 0 ? -1 : 1;
  }
  // 外部状态（睡 / 专注 / 抽烟喝酒 / 眩晕）期间锁住引擎，
  // 免得自主动作把正在演的画面顶掉；状态一变就重新对齐锁。
  function syncLock() {
    if (state === 'sleepy') { anim.lock(3600e3, 'sleep'); return; }
    if (state === 'focus') { anim.lock(3600e3, 'focus'); return; }
    if (state === 'action') return;             // setAction 自己锁了 30 秒，别在这里缩短
    if (isDizzy()) { anim.lock(1500, 'dizzy'); return; }
    anim.unlock();
  }

  // 走动被打断时必须同时通知主进程停步，否则会"一边演动作一边被平移"，看着像在滑行
  function interruptWalk() {
    if (!anim.walking) return;
    anim.stopWalk();
    try { if (ipc && ipc.stopWalk) ipc.stopWalk(); } catch (_) {}
  }

  function enter(s) {
    if (Date.now() < actionUntil) return;   // 抽烟/喝酒期间不让其它状态抢画面
    if (s !== 'walk') interruptWalk();
    state = s;
    document.body.classList.toggle('dragging', s === 'drag');
    if (s !== 'idle') document.body.classList.remove('faceLeft');  // 情绪/拖拽帧不镜像
    // 眩晕期间保持晕脸，不被切走 —— 但"被甩出去"是例外：甩晕和飞行是同一件事的
    // 前后两段，这时候拦下来就是"人已经飞了，脸还停在原地"。
    if (isDizzy() && s !== 'idle' && s !== 'fly') return;
    if (s === 'idle') {
      showDirection();
      // 让主进程按"当前真实光标"重算一次，避免沿用过期朝向（鼠标停着不动时尤其明显）
      try { if (window.pet && window.pet.refreshFacing) window.pet.refreshFacing(); } catch (_) {}
    }
    else if (s === 'sleepy') show('e_sleepy');
    else if (s === 'drag') show('e_surprised');
    else if (s === 'fly') show('e_surprised');
    else if (s === 'focus') show('e_thinking');
    syncLock();
  }
  function triggerEmotion(name, holdMs = 1500) {
    if (state === 'drag') return;
    if (isBusy()) return;                  // 眩晕 / 抽烟喝酒期间不被其它情绪打断
    // 走动途中不插表情：走动是一段连续的步态，中间被一张表情脸顶掉会明显顿一下。
    // 表情本来就是短反馈，等它走完再说（气泡是独立窗口，问候照样能看到）。
    if (anim.walking) return;
    clearTimeout(emotionTimer);
    enter('emotion');
    show('e_' + name);
    emotionTimer = setTimeout(() => {
      if (anim.walking) return;            // 情绪到期时如果已经在走动，就把画面让给步态
      enter(focusing ? 'focus' : 'idle');
    }, holdMs);
  }

  // ---- 眩晕：快速拖动触发，头顶转圈 + 身体摇晃 ----
  function isDizzy() { return Date.now() < dizzyUntil; }
  function setDizzy(ms = 2000) {
    if (Date.now() < actionUntil) return;   // 正在抽烟/喝酒时不打断
    dizzyUntil = Date.now() + ms;
    document.body.classList.add('dizzy');
    document.body.classList.remove('faceLeft');   // 眩晕用正面帧，别镜像
    clearTimeout(emotionTimer);
    show((profile.frames && profile.frames.front) || 'd0');   // 正面睁眼帧，和眼白/螺旋的位置对齐
    anim.cancel();                 // 晕的时候别让动作姿态继续扭
    anim.lock(ms + 150, 'dizzy');
    clearTimeout(dizzyTimer);
    dizzyTimer = setTimeout(() => {
      dizzyUntil = 0;
      document.body.classList.remove('dizzy');
      enter(focusing ? 'focus' : 'idle');
    }, ms);
  }

  // ---- 抽烟 / 喝酒：30 秒，随机两种结局 ----
  // 真实感的关键不在"转得多顺"，而在**节拍**：真人抽烟是「吸一口(1s) → 屏住(1~2s) →
  // 仰头吐(1s) → 发很久呆(5~10s)」，不是从头到尾匀速循环。所以下面用时间轴驱动，
  // 每一拍只做一件小事，拍与拍之间留长空档。
  function isBusy() { return Date.now() < dizzyUntil || Date.now() < actionUntil; }

  let beatTimers = [];
  let burnTimer = null;
  const pulseTimers = {};
  function cue(ms, fn) { beatTimers.push(setTimeout(() => { try { fn(); } catch (_) {} }, ms)); }
  function clearBeats() {
    beatTimers.forEach(clearTimeout); beatTimers = [];
    Object.keys(pulseTimers).forEach((k) => { clearTimeout(pulseTimers[k]); delete pulseTimers[k]; });
    clearInterval(burnTimer); burnTimer = null;
  }
  // 只亮/只生效 ms 毫秒的临时 class —— 一拍一个。
  // 同一个 class 反复喊（比如连灌三口）要"续时长"而不是互相取消，否则会闪。
  function pulse(cls, ms) {
    clearTimeout(pulseTimers[cls]);
    document.body.classList.add(cls);
    pulseTimers[cls] = setTimeout(() => {
      delete pulseTimers[cls];
      document.body.classList.remove(cls);
    }, ms);
  }
  function setVar(k, v) { document.body.style.setProperty(k, v); }

  function clearAction() {
    clearBeats();
    document.body.classList.remove(
      'drunk', 'drunk2', 'asleep', 'nod', 'smoking', 'blue', 'revive', 'drinking',
      'sip', 'sip-deep', 'gulp', 'tiltback', 'slump', 'ember', 'puffing', 'ash-tap'
    );
    setVar('--burn', 0);
    setVar('--sip', 0);
    actionUntil = 0;
  }

  function setAction(classes, ms, frame) {
    clearTimeout(actionTimer);
    clearAction();
    interruptWalk();                 // 抽烟/喝酒前先停步
    document.body.classList.remove('faceLeft');
    classes.split(' ').forEach((c) => { if (c) document.body.classList.add(c); });
    state = 'action';
    show(frame);
    // 动作期间目光落在远处，不再跟着鼠标转（忧郁的前提是"望远方"）
    tiltTarget.ry = 7; tiltTarget.rx = 2;
    actionUntil = Date.now() + ms;
    anim.cancel();                    // 抽烟/喝酒有自己的时间轴，别叠加引擎的姿态
    anim.lock(ms + 200, 'action');
    actionTimer = setTimeout(() => {
      clearAction();
      tiltTarget.ry = 0; tiltTarget.rx = 0;
      enter(focusing ? 'focus' : 'idle');
    }, ms);
  }

  // 烟：30 秒内烧掉约 40%。基础是极慢的阴燃，每吸一口再跳掉一小截
  let burnCur = 0;
  function smokeBurn(limit) {
    clearInterval(burnTimer);
    burnCur = 0;
    setVar('--burn', 0);
    applyCigTip(0);
    burnTimer = setInterval(() => {
      burnCur += 0.006;                      // 每秒约 2%
      if (burnCur > limit) { burnCur = limit; clearInterval(burnTimer); burnTimer = null; }
      setVar('--burn', burnCur.toFixed(3));
      applyCigTip(burnCur);                  // 火头退到哪，烟柱就从哪冒
    }, 300);
  }
  function bumpBurn(n) {
    burnCur = Math.min(0.55, burnCur + n);
    setVar('--burn', burnCur.toFixed(3));
    applyCigTip(burnCur);
  }

  // 抽烟：一口 = 吸 → 屏 → 仰头吐 → 发呆
  function smokeBeats(blue) {
    if (blue) document.body.classList.add('blue');
    smokeBurn(0.42);
    // 第 n 口：间隔越来越长（越抽越沉），吐烟也越来越慢
    // 全程只用一张脸：烟是按这张脸的嘴角（character.json 的 props.cig.at）定位的，
    // 中途换脸烟就会飘走。要换脸必须同时重量那个 at。
    const puff = (t, hold) => {
      cue(t, () => { pulse('ember', 950); });     // 吸：烟头骤亮
      cue(t + 400, () => bumpBurn(0.045));        // 吸掉一截
      cue(t + 900, () => pulse('slump', 700));    // 闷一下，肩膀沉
      cue(t + hold, () => {                       // 吐：仰头 + 三口烟涌出
        pulse('puffing', 2300);
        pulse('tiltback', 1500);
      });
    };
    puff(300, 2100);
    puff(9200, 2400);
    puff(18800, 2700);
    cue(14200, () => pulse('ash-tap', 1200));    // 弹灰
    cue(25600, () => pulse('ash-tap', 1200));
    cue(26500, () => { pulse('slump', 2600); }); // 结尾垮下肩，把忧郁落到身体上
    if (!blue) {
      // 满血复活是"抽完之后"的事：先把烟丢掉，再一下子精神起来
      cue(26600, () => {
        document.body.classList.remove('smoking');
        document.body.classList.add('revive');
        show('e_cheer');
      });
    }
  }

  // 喝酒：一次 = 举瓶 → 灌（三下咕咚）→ 放下 → 回味
  // 酒瓶的真实感全在"液面"上（见 index.html 的 #bottle）：每吞一口液面掉一格，
  // 举起来的时候酒往瓶口那头流、瓶颈里也有酒，放下时又流回去。
  function drinkBeats(drunk) {
    document.body.classList.add('drinking');
    show('e_sleepy');                    // 真喝醉的人不会瞪大眼
    if (!drunk) cue(6000, () => document.body.classList.add('nod'));
    // deep = 见底那一口：瓶底要竖得更高才够得着（body.sip-deep 加 14°）
    const gulp = (t, hold, sip, deep) => {
      cue(t, () => {
        pulse('sip', hold + 900);                   // 举瓶（1.15s 缓动抬起）
        if (deep) pulse('sip-deep', hold + 900);
      });
      cue(t + 650, () => setVar('--sip', sip));     // 液面下降（.7s，跟着吞咽走）
      for (let k = 0; k < 3; k++) {                               // 咕咚：瓶子跟着起伏
        cue(t + 900 + (hold / 3) * k, () => {
          pulse('tiltback', hold / 3 + 220);          // 头往后一仰
          pulse('gulp', 680);                         // 酒面晃一下再停住
        });
      }
      cue(t + hold + 800, () => pulse('slump', 1400));            // 放下后回一口气
    };
    gulp(400, 2000, 0.22);
    gulp(8200, 2100, 0.46);
    gulp(16400, 2200, 0.72);
    if (drunk) {
      gulp(23800, 1900, 0.9, true);                               // 醉的那条线还有第四口
      cue(15500, () => document.body.classList.add('drunk'));      // 前 15 秒还是清醒的
      cue(27500, () => document.body.classList.add('drunk2'));     // 后段晃得更厉害
    } else {
      // 困的那条线：喝到第三口就不喝了，慢慢打瞌睡（睡着还举着瓶子很假）
      cue(21400, () => { document.body.classList.remove('nod'); document.body.classList.add('asleep'); });
    }
  }

  function startAction(type) {
    if (isBusy()) return;
    const parts = String(type).split(':');   // drink:drunk / smoke:revive 可强制结局（调试用）
    const kind = parts[0];
    const force = parts[1] || '';
    if (kind === 'drink') {
      const drunk = force === 'drunk' || (!force && Math.random() < 0.55);
      setAction('drinking', 30000, 'e_sleepy');   // 结局在时间轴里逐步长出来
      drinkBeats(drunk);
    } else if (kind === 'smoke') {
      const blue = force === 'blue' || (force !== 'revive' && Math.random() < 0.5);
      // 抽烟用"半眯眼 + 张着嘴"的那张脸。原来用的是 e_sad —— 那张是闭嘴下撇的，
      // 烟叼在闭着的嘴上就说不通，用户直接反馈"没有张嘴的动作"。
      // 嘴的张合和半眯的眼一起给出"抽着烟神游天外"的意思，比单纯忧郁更贴。
      setAction('smoking', 30000, cig.frame || 'e_sleepy');
      smokeBeats(blue);
    }
  }
  function scheduleBlink() {
    const wait = 2200 + Math.random() * 4200;
    blinkTimer = setTimeout(() => {
      if (isBusy()) { scheduleBlink(); return; }   // 晕着/抽烟喝酒的时候别眨眼
      if (state === 'idle' && !focusing) {
        show('e_wink');
        setTimeout(() => { if (state === 'idle' && !focusing) showDirection(); }, 130);
      }
      scheduleBlink();
    }, wait);
  }

  // ---- 空闲自主动作 ----
  // 有动作表时交给引擎调度：动作之间留 7~18 秒静默（静默期只允许待机/转头）。
  // "一直在动"会烦人，"一直不动"像死物 —— 这个间隔就是自然感的来源。
  // 没有动作表时（浏览器直接预览）退回原来的环顾 / 换表情 / 小跳。
  let autoMood = true;
  let moodTimer = null;
  let lastMoodAt = 0;

  function pickMood() {
    const r = Math.random();
    if (ipc && ipc.debug) ipc.debug('mood r=' + r.toFixed(2));
    // 鼠标刚动过就别自己"环顾"，否则会和跟随鼠标的朝向打架
    const canLook = Date.now() - lastCursorAt > 4000;
    if (canLook && r < 0.5) {
      const old = dirK;
      const side = Math.random() < 0.5 ? -1 : 1;
      dirK = side;   // 只有正脸/侧脸两种帧，环顾就是直接转头
      showDirection();
      setTimeout(() => {
        if (state === 'idle' && !isDizzy()) {
          try {
            if (window.pet && window.pet.refreshFacing) window.pet.refreshFacing();
            else { dirK = old; showDirection(); }
          } catch (_) { dirK = old; showDirection(); }
        }
      }, 1100 + Math.random() * 900);
    } else if (r < 0.88) {
      const list = ['cheer', 'love', 'thinking', 'shy', 'surprised'];
      triggerEmotion(list[Math.floor(Math.random() * list.length)], 1400 + Math.random() * 700);
    } else {
      document.body.classList.add('hop');
      setTimeout(() => document.body.classList.remove('hop'), 650);
    }
  }

  function autoAct() {
    if (!autoMood || focusing || isDizzy() || document.hidden) return;
    if (state !== 'idle' || anim.busy || anim.walking || anim.clipId) return;
    if (profile.clips && profile.clips.length) { anim.maybeGesture(); return; }
    if (Date.now() - lastMoodAt < 120000 + Math.random() * 90000) return;
    lastMoodAt = Date.now();
    pickMood();
  }
  function scheduleMood() {
    clearInterval(moodTimer);
    moodTimer = setInterval(autoAct, 1000);
  }

  // 平滑倾斜 + 上下位移（看向上方/下方时整体轻微上移/下沉）
  const tiltTarget = { rx: 0, ry: 0 };
  const tiltCur = { rx: 0, ry: 0 };
  const gaze = { y: 0 };

  // ---- 撸它：鼠标在身上快速左右来回 => 害羞/喜欢 ----
  let revs = [], lastSign = 0, lastRub = 0;
  function rubCheck(dx, dy) {
    const overPet = Math.abs(dx) < 100 && Math.abs(dy) < 120;
    if (!overPet) { lastSign = 0; revs = []; return; }
    const s = Math.sign(dx);
    const now = Date.now();
    if (s !== 0 && lastSign !== 0 && s !== lastSign) revs.push(now);
    if (s !== 0) lastSign = s;
    revs = revs.filter((t) => now - t < 800);
    if (revs.length >= 3 && now - lastRub > 2500) {
      lastRub = now; revs = [];
      triggerEmotion(Math.random() < 0.5 ? 'shy' : 'love', 1800);
    }
  }

  // 鼠标偏移 -> 朝向 + 倾斜 + 撸
  function handleCursor(dx, dy) {
    if (state === 'sleepy') enter('idle');
    lastCursorAt = Date.now();
    // 抽烟/喝酒期间不跟鼠标：头保持"望向远处"的固定偏移，否则一边忧郁一边追光标很分裂
    if (Date.now() < actionUntil) return;
    // 满量程 = 窗口宽/高的 2.4 倍（约 260px）：近处正脸、稍远微转、很远才侧面
    const nx = clamp(dx / (Math.max(60, window.innerWidth) * 2.4), -1, 1);
    const ny = clamp(dy / (Math.max(60, window.innerHeight) * 2.4), -1, 1);

    // 身体（朝向帧）+ 眼神（随头转动）+ 透视倾斜 一起动
    tiltTarget.ry = nx * 14;
    tiltTarget.rx = ny * 14;
    gaze.y = ny * 3;                       // 鼠标偏上 => 整体微升；偏下 => 微沉

    if (!focusing) {
      const next = dirFrom(dx, dy, dirK);
      if (next !== dirK) { dirK = next; showDirection(); }
    }
    rubCheck(dx, dy);
  }

  // ---- 数据源：Electron 走 IPC；浏览器预览则监听鼠标 ----
  if (ipc) {
    ipc.onCursor(handleCursor);

    // ---- 走动：主进程决定"去哪儿"，渲染层只把位移换算成步频 ----
    // 这里传的是**这一帧真实移动了多少像素**，不是时间 —— 所以走得快脚步就快，
    // 走得慢脚步就慢，脚永远不会打滑。
    if (ipc.onWalkStart) {
      ipc.onWalkStart((d) => {
        if (state === 'drag' || isBusy()) return;
        anim.startWalk(d && d.dir < 0 ? -1 : 1);
      });
    }
    if (ipc.onWalkStep) ipc.onWalkStep((dx) => anim.advance(dx, window.innerWidth));
    if (ipc.onWalkEnd) ipc.onWalkEnd(() => anim.stopWalk());

    // ---- 拖拽：主进程每 16ms 给一次速度，用来做"身体滞后于手"的悬空感 ----
    if (ipc.onDragVel) ipc.onDragVel((vx, vy) => anim.dragVel(vx, vy));
    // 松手落地：竖直速度决定压扁强度
    if (ipc.onLand) ipc.onLand((vy) => anim.endDrag(vy));

    // ---- 甩出去：牵引 -> 松手 -> 惯性飞行 -> 撞墙反弹 ----
    // 姿态全在引擎里算（后仰 / 拉伸 / 撞击压扁），这里只负责把四个信号转进去，
    // 以及真落地之后把渲染层的状态机叫醒 —— 少一个信号画面就会卡在"永远在飞"。
    if (ipc.onThrow) {
      ipc.onThrow((vx, vy) => {
        enter('fly');
        anim.startFly(vx, vy);
      });
    }
    if (ipc.onThrowVel) ipc.onThrowVel((vx, vy) => anim.flyVel(vx, vy));
    if (ipc.onBump) ipc.onBump((axis, power) => anim.bump(axis, power));
    if (ipc.onThrowEnd) {
      ipc.onThrowEnd((reason, speed, bounces) => {
        // 只有"自己飞累了落地"才压扁。半空被抓住（grab）/ 窗口被隐藏（hide）都不播，
        // 否则那段落地动作会把"被拎在手里"的悬垂姿态顶掉 —— 抓过来的是一只会砸地的猴。
        anim.endFly(speed, reason === 'stop');
        if (state === 'fly' && reason === 'stop') enter(focusing ? 'focus' : 'idle');
        // 撞得够狠就吐个星星眼 —— 被扔了一圈之后的固定反馈
        if (reason === 'stop' && bounces >= 3) setDizzy(Math.min(1800, 500 + bounces * 180));
      });
    }

    // 右键菜单里手点某个动作
    if (ipc.onGesture) {
      ipc.onGesture((id) => {
        if (state === 'drag' || isBusy()) return;
        if (anim.play(id, { force: true })) state = 'gesture';
      });
    }
    if (ipc.onIdle) {
      ipc.onIdle((asleep) => {
        if (focusing) return;
        if (asleep) { if (state !== 'drag') enter('sleepy'); }
        else if (state === 'sleepy') enter('idle');
      });
    }
    if (ipc.onAction) {
      ipc.onAction((type) => startAction(type));
    }
    if (ipc.onAutoMood) {
      ipc.onAutoMood((on) => { autoMood = !!on; });
    }
    if (ipc.onEmotion) {
      ipc.onEmotion((n) => {
        if (n === 'idle') enter(focusing ? 'focus' : 'idle');
        else if (n === 'dizzy') setDizzy(2000);
        else triggerEmotion(n);
      });
    }
    if (ipc.onFocus) {
      ipc.onFocus((on) => {
        focusing = !!on;
        enter(on ? 'focus' : 'idle');
      });
    }
    if (ipc.onClickThrough) {
      ipc.onClickThrough((on) => document.body.classList.toggle('clickthrough', !!on));
    }
    if (ipc.onSpeak) {
      ipc.onSpeak((text) => {
        try {
          if (!text || !window.speechSynthesis) return;
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(String(text));
          u.lang = 'zh-CN';
          u.rate = 1.05;
          u.pitch = 1.05;
          const voices = window.speechSynthesis.getVoices() || [];
          const zh = voices.find((v) => /zh|Chinese|Xiaoxiao|Huihui|Yaoyao/i.test(v.lang + ' ' + v.name));
          if (zh) u.voice = zh;
          window.speechSynthesis.speak(u);
        } catch (_) {}
      });
      try { window.speechSynthesis && window.speechSynthesis.getVoices(); } catch (_) {}
    }
  } else {
    document.addEventListener('mousemove', (e) => {
      const r = stage.getBoundingClientRect();
      handleCursor(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    });
    window.Monkey2D = {
      setEmotion: (n) => { if (n === 'idle') { enter('idle'); } else triggerEmotion(n); },
    };
  }

  // ---- 主循环：先推进姿态引擎，再把姿态贴到 DOM，最后算透视倾斜 ----
  // 顺序不能反：姿态是"这一帧的事实"，透视只是在它外面套一层视角。
  let lastActivity = '';
  function reportActivity() {
    if (!ipc || !ipc.setActivity) return;
    const k = anim.walking ? 'walk' : (anim.clipId ? 'gesture' : state);
    if (k === lastActivity) return;
    lastActivity = k;
    try { ipc.setActivity(k); } catch (_) {}
  }

  let lastFrameAt = 0;
  function loop(ts) {
    requestAnimationFrame(loop);
    const dt = lastFrameAt ? Math.min(120, ts - lastFrameAt) : 16;
    lastFrameAt = ts;

    // 定格模式（只给自动化测试用）：引擎不推进，主循环只负责把定格的那一帧
    // 反复贴上去。否则 rAF 会在 16ms 内把 __petStrip 写的姿态覆盖掉，
    // 截出来的其实全是待机姿态 —— 这一版之前就踩了这个坑。
    if (frozenPose) {
      applyPose(frozenPose);
      tiltCur.rx = 0; tiltCur.ry = 0; gaze.y = 0;
      tilt.style.transform = 'perspective(700px) rotateY(0deg) rotateX(0deg) translateY(0px)';
      return;
    }

    const pose = anim.tick(dt);
    applyPose(pose);
    applyAnimFrame(pose);
    syncAnimState();
    reportActivity();

    tiltCur.rx += (tiltTarget.rx - tiltCur.rx) * 0.15;
    tiltCur.ry += (tiltTarget.ry - tiltCur.ry) * 0.15;
    tilt.style.transform = `perspective(700px) rotateY(${tiltCur.ry}deg) rotateX(${tiltCur.rx}deg) translateY(${gaze.y}px)`;
  }
  requestAnimationFrame(loop);

  // 清掉定格：恢复成"引擎说了算"
  window.__petStripEnd = function () { frozenPose = null; };

  // ---- 透明区域不挡鼠标 ----
  // 由主进程每 30ms 读取真实光标位置 + 当前帧 alpha 判断并切换，渲染端不参与，
  // 这样拖拽过程中不会被"忽略鼠标"打断。

  // ---- 拖拽 / 单击 / 双击 / 长按 ----
  let dragging = false, moved = false;
  let downX = 0, downY = 0, clickTimer = null;
  let downCX = 0, downCY = 0;
  let lpTimer = null, longPressed = false;
  let downZone = '';      // 按下的部位：head / body（来自角色档案的命中盒，换形象自动跟着变）

  function scheduleClick() {
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (state === 'drag' || isBusy()) return;
      // 走动时被戳：先让主进程停步，再给反应 —— 否则会边平移边演，像在滑行
      interruptWalk();
      // 点头 = 摸头（缩一下、害羞），点身子 = 被戳（先惊后开心）。
      // 两个反应都是引擎里的动作，所以换形象后照样成立；档案里没配动作就退回随机开心脸。
      const clip = downZone === 'head' ? 'headTap' : (downZone === 'body' ? 'bodyTap' : '');
      if (clip && anim.play(clip)) { state = 'gesture'; return; }
      triggerEmotion(POSITIVE[Math.floor(Math.random() * POSITIVE.length)]);
    }, 230);
  }
  function onWinUp() {
    window.removeEventListener('mouseup', onWinUp);
    window.removeEventListener('blur', onWinUp);
    clearTimeout(lpTimer);
    if (!dragging) return;
    dragging = false;
    if (longPressed) { longPressed = false; return; }   // 长按已触发专注，不再触发点击情绪
    if (moved) {
      anim.setDrag(false);
      if (ipc) ipc.dragEnd();       // 落地压扁由主进程回传的落速驱动
    } else { scheduleClick(); }
  }

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = false; longPressed = false;
    downX = e.screenX; downY = e.screenY;
    downCX = e.clientX; downCY = e.clientY;
    {
      const r = stage.getBoundingClientRect();
      const z = anim.zoneAt((e.clientX - r.left) / Math.max(1, r.width),
                            (e.clientY - r.top) / Math.max(1, r.height));
      downZone = z ? z.id : '';
    }
    anim.noteInteraction();   // 刚被摸过，自主动作重新计时
    scheduleMood();
    window.addEventListener('mouseup', onWinUp);
    window.addEventListener('blur', onWinUp);
    // 长按 0.65s 且没拖动 => 开始 / 停止专注
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      if (dragging && !moved) {
        longPressed = true;
        if (ipc && ipc.focusToggle) ipc.focusToggle();
      }
    }, 650);
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  });
  stage.addEventListener('pointermove', (e) => {
    if (!dragging || moved) return;
    // screenX 在个别环境下不会随移动更新，用 clientX 兜底，两者取大
    const dScreen = Math.abs(e.screenX - downX) + Math.abs(e.screenY - downY);
    const dClient = Math.abs(e.clientX - downCX) + Math.abs(e.clientY - downCY);
    if (Math.max(dScreen, dClient) > 4) {
      moved = true;
      clearTimeout(lpTimer);
      enter('drag');
      anim.setDrag(true);          // 悬空姿态从这一刻开始接管
      if (ipc) ipc.dragStart();
    }
  });
  function endPointer(e) {
    try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
    onWinUp();
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('dblclick', (e) => {
    e.preventDefault();
    clearTimeout(clickTimer);          // 双击时取消"单击随机情绪"
    clearTimeout(lpTimer);
    if (ipc && ipc.showEmotionMenu) ipc.showEmotionMenu();
    else triggerEmotion('surprised');
  });

  // ---- 右键菜单 ----
  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (ipc) ipc.showContextMenu();
  });

  // ---- 长按 + 滚轮缩放 ----
  let previewScale = 1;
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !(e.buttons & 1)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    if (ipc) ipc.zoomBy(factor);
    else { previewScale = clamp(previewScale * factor, 0.5, 2.5); stage.style.transform = `scale(${previewScale})`; }
  }, { passive: false });

  // ---- 拖图片到小猴身上 -> 名片结构化抽取 ----
  const stopDrag = (e) => { e.preventDefault(); e.stopPropagation(); };
  window.addEventListener('dragover', stopDrag);
  window.addEventListener('drop', stopDrag);
  stage.addEventListener('dragover', (e) => { e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {} });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = f.path || '';
    if (ipc && ipc.extractCard) {
      if (!p) { triggerEmotion('sad'); return; }
      triggerEmotion('surprised');
      ipc.extractCard(p);
    }
  });

  enter('idle');
  scheduleBlink();
  scheduleMood();
})();

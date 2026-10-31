// 眩晕眼探针：把 index.html 直接装进一个裸窗口（不带 preload —— 渲染层自己会降级到
// FALLBACK_PROFILE，眼睛的几何照样从档案来），加 body.dizzy，然后量眼睛的几何与旋转状态。
//
// 为什么不用真机钩子：PET_TEST_DIZZY 只能截一张图，"螺旋有没有真的在转、转的支点在哪、
// 眼白是不是跟着窗口大小缩放"这些都看不出来。这里是纯几何量测，跑得比开整只桌宠快。
//
// 用法：
//   electron tools/eye-probe.js --sizes=192,288,384 --out=_shots/eyes/x.png
//   --sizes  依次测这么多个窗口宽度（桌宠是等比缩放的，192 是设计尺寸）
//   --out    顺带存一张 192 宽的截图（可选）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const argv = process.argv;
const flag = (k, d) => {
  const p = '--' + k + '=';
  const hit = argv.find((a) => a.startsWith(p));
  return hit === undefined ? d : hit.slice(p.length);
};
const SIZES = (flag('sizes', '192') || '192').split(',').map(Number).filter((n) => n > 0);
const OUT = flag('out', '');

const ROOT = path.join(__dirname, '..');
const PROF = JSON.parse(fs.readFileSync(path.join(ROOT, 'character.json'), 'utf8'));
const RATIO = (PROF.size && PROF.size[1]) / (PROF.size && PROF.size[0]) || 223 / 192;

// 量：眼睛盒子的位置/尺寸、它自己的 transform（居中那一条）、裁切方式，
// 以及里面那个 svg 的尺寸、支点、当前旋转角度。
//
// 两个坑：
// ① 眩晕时 #breath 上挂着 dizzyWobble（±5° 旋转），getBoundingClientRect 拿到的是
//    旋转后的**外接框**，宽度会多出 ~2px。所以量之前先把那条动画关掉，量的是布局盒。
// ② 隐藏窗口不跑动画帧，连采两次 getComputedStyle 会拿到一模一样的角度，
//    看着像"没在转"。改用 Web Animations API 把时间轴定死再读，跟窗口可不可见无关。
const MEASURE = `(() => {
  // 关掉身体摇晃和淡入，只留眼睛本身 —— 量几何时不要被别的 transform 污染
  let st = document.getElementById('__probe_off');
  if (!st) {
    st = document.createElement('style');
    st.id = '__probe_off';
    st.textContent = '#breath { animation: none !important; } #eyes { transition: none !important; }';
    document.head.appendChild(st);
  }
  const angleOf = (t) => { const m = /matrix\\(([^)]+)\\)/.exec(t || ''); if (!m) return null;
    const v = m[1].split(',').map(Number); return Math.round(Math.atan2(v[1], v[0]) * 1800 / Math.PI) / 10; };
  const one = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const svg = el.querySelector('svg');
    // 把动画时间轴定死，量两个角度：0° 和半圈。两个值不同才说明它真的在转。
    let spin = null;
    if (svg) {
      const an = svg.getAnimations()[0];
      if (an) {
        an.pause();
        an.currentTime = 0;
        const a0 = angleOf(getComputedStyle(svg).transform);
        an.currentTime = 450;              // 周期 900ms，半圈
        const a1 = angleOf(getComputedStyle(svg).transform);
        an.play();
        spin = { at0: a0, at450: a1, name: getComputedStyle(svg).animationName };
      }
    }
    const ss = svg ? getComputedStyle(svg) : null;
    return {
      rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100),
      box: [el.offsetWidth, el.offsetHeight],          // 布局盒（不含旋转）
      transform: cs.transform,
      overflow: cs.overflow,
      radius: cs.borderRadius,
      parent: el.parentElement ? (el.parentElement.id || el.parentElement.className) : null,
      svg: svg ? {
        inside: el.contains(svg),
        // svg 元素没有 offsetWidth；而且它自己就在转，getBoundingClientRect 是转后的
        // 外接框（会大一圈）。要"铺满眼球"这个事实，读计算样式里的宽高。
        box: [parseFloat(ss.width), parseFloat(ss.height)].map((v) => Math.round(v * 100) / 100),
        origin: ss.transformOrigin,
        anim: ss.animationName,
        dur: ss.animationDuration,
        paths: svg.querySelectorAll('path').length,
        spin,
      } : null,
    };
  };
  const eyes = [...document.querySelectorAll('.eye')];
  const layer = document.getElementById('eyes');
  const lr = layer ? layer.getBoundingClientRect() : null;
  return {
    win: [innerWidth, innerHeight],
    // 旧的"头顶转圈"：#swirl 必须已经不存在，眩晕不许再挂在窗口坐标系上
    swirl: !!document.getElementById('swirl'),
    // 眩晕层自己的位置/层级。眼睛的百分比是相对**这一层**算的，所以断言也拿它当基准 ——
    // 直接拿窗口当基准会被 idle 的呼吸位移（#pose 的 dy）带偏两三像素，误判成"偏了"。
    layer: lr ? {
      rect: [lr.x, lr.y, lr.width, lr.height].map((v) => Math.round(v * 100) / 100),
      z: getComputedStyle(layer).zIndex,
      opacity: getComputedStyle(layer).opacity,
    } : null,
    frame: (document.querySelector('img.f.active') || {}).src || null,
    eyes: eyes.map(one),
  };
})()`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  // frame:false 是必须的：有边框的窗口 getBounds 含标题栏，content 会比要的矮一截，
  // 量出来的眼睛几何就整体被纵向压扁（而且缩放测试会算错比例）。
  const win = new BrowserWindow({
    width: 192, height: Math.round(192 * RATIO), show: false, frame: false,
    useContentSize: true, backgroundColor: '#20242c',
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  await win.loadFile(path.join(ROOT, 'index.html'));
  await new Promise((r) => setTimeout(r, 500));      // 等渲染层的 IIFE 把眼睛建出来

  const out = [];
  for (const w of SIZES) {
    // 用 setBounds 而不是 setContentSize：后者在隐藏窗口上偶发不生效（尺寸不变，
    // 于是两轮量到一模一样的数据，看着像"缩放没问题"）。
    win.setBounds({ x: 40, y: 40, width: w, height: Math.round(w * RATIO) });
    await new Promise((r) => setTimeout(r, 200));
    await js(`document.body.classList.add('dizzy')`);
    await new Promise((r) => setTimeout(r, 200));    // opacity 过渡 + 转几帧

    const m = await js(MEASURE);
    out.push(m);

    if (OUT && w === SIZES[0]) {
      // 隐藏窗口不合成新帧，capturePage 拿到的可能是加 dizzy 之前那一张（画面里
      // 眼睛还是原样，只有几何数是新的）—— 要截图就得先真的显示出来。
      win.show();
      await new Promise((r) => setTimeout(r, 260));
      const img = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
      fs.writeFileSync(path.resolve(OUT), img.toPNG());
      win.hide();
      console.log('WROTE ' + OUT);
    }
  }
  console.log('PROBE ' + JSON.stringify({ points: PROF.eyes.points, ratio: RATIO, runs: out }));
  app.exit(0);
}).catch((e) => { console.error('ERR ' + ((e && e.stack) || e)); app.exit(1); });

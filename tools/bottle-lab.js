// 酒瓶放大台：把 index.html 里**同一份样式**和同一段 DOM 拎出来，放大到能看清细节的尺寸再截图，
// 同时把"世界坐标里的液面倾角"算出来打一行 INFO（tools/test-bottle.cjs 就是读这行做断言的）。
//
// 为什么要它：真实窗口只有 192×223 CSS px，酒瓶才 17×42 px，
// 截图上放大 8 倍全是插值糊掉的颜色块 —— 判断不了"液面到底平不平"。
// 这里的截图是按设备像素原样抠出来的（不重采样），边缘是渲染出来的。
//
// 背景画了网格：横线 = 世界水平。液面要是真的只认重力，它就该和这些横线平行。
//
// 用法：
//   npx electron tools/bottle-lab.js --states=sip:0.22,sip:0.46 --out=_shots/lab/a.png
//   npx electron tools/bottle-lab.js --state=sip --sip=.22 --out=_shots/lab/a.png
//   --state / --states  加到 <body> 上的 class（":"后面是 --sip）
//   --probe             只量不截图（测试用，快）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const argv = process.argv;
const flag = (k, d) => {
  const p = '--' + k + '=';
  const hit = argv.find((a) => a.startsWith(p));
  return hit === undefined ? d : hit.slice(p.length);
};
const has = (k) => argv.includes('--' + k);

// "sip:0.22" / "drinking:0" / "sip-deep:0.9" -> { cls, sip }
const parseState = (s) => {
  const [cls, sip] = String(s).split(':');
  return { cls: (cls || '').trim(), sip: sip === undefined ? '0' : String(sip).trim() };
};
const STATES = (flag('states', '') || '')
  .split(',').filter(Boolean).map(parseState);
if (!STATES.length) STATES.push(parseState(flag('state', 'sip') + ':' + flag('sip', '0')));

const OUT = flag('out', '');
const PROBE = has('probe');
// 窗口比例跟真实宠物窗一致（192:223），瓶子在框里的形状比例才不会变
const W = 400, H = Math.round((W * 223) / 192);
const SETTLE = 1500;   // 最长的那条 transition 是 1.15s

function build(state) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const style = /<style>([\s\S]*?)<\/style>/.exec(src)[1];
  // 连外壳一起搬：#tilt > #gait > #pose > #lean > #breath > 酒瓶。
  // 少搬一层，祖先的自转就少了 —— 而酒液的补偿正是按"祖先转了多少"算的，
  // 所以外壳必须原样带上，不然放大台里看到的液面会比真机"更平"。
  const i = src.indexOf('<div id="tilt">');
  const j = src.indexOf('<div id="smoke">', i);
  if (i < 0 || j < 0) throw new Error('找不到 #tilt 段落');
  const dom = src.slice(i, j).trim();   // 未闭合的 5 层 div 由浏览器在 </body> 前自动闭合

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${style}
/* ---- 放大台覆盖 ---- */
html, body { background: #1b1f26; }
body {
  /* 横线 = 世界水平；竖线只为看出倾斜方向 */
  background:
    repeating-linear-gradient(0deg, rgba(255,90,90,.65) 0 1px, transparent 1px 8px),
    repeating-linear-gradient(90deg, rgba(110,190,255,.30) 0 1px, transparent 1px 8px);
}
/* 瓶子挪到左上角：窗口万一被屏幕高度限制裁掉下半截，也不影响截到它 */
#bottle { opacity: 1 !important; left: 30% !important; top: 8% !important; }
</style></head>
<body class="${state.cls}" style="--sip:${state.sip}">${dom}</body></html>`;
}

// 量：把整条祖先链的自转加起来，才是"世界坐标里的液面倾角"
// String.raw 是必需的：这段代码要原样塞进渲染进程，正则里的反斜杠不能被模板字符串吃掉
// （普通模板字符串里 "\(" 会变成 "("，正则就从"字面括号"变成了"分组"，静默量出错数）
const PROBE_JS = String.raw`(() => { try {
  const ang = (t) => { const m = /matrix\(([^)]+)\)/.exec(t || ''); if (!m) return null;
    const v = m[1].split(',').map(Number); return Math.round(Math.atan2(v[1], v[0]) * 1800 / Math.PI) / 10; };
  const bt = document.getElementById('bottle');
  const lq = bt.querySelector('.bt-liq');
  const nk = bt.querySelector('.bt-nliq');
  const bc = getComputedStyle(bt), lc = getComputedStyle(lq), nc = getComputedStyle(nk);
  let up = 0;
  for (let e = bt.parentElement; e && e !== document.body; e = e.parentElement) {
    const a = ang(getComputedStyle(e).transform); if (a) up += a;
  }
  const num = (v) => Math.round(parseFloat(v) * 1000) / 1000;
  // 瓶身/瓶颈的**布局**高度：不能用 getBoundingClientRect —— 瓶子是斜的，
  // 那个拿到的是旋转后的外接框，液面百分比会被放大成 69% 这种假数。
  const hOf = (el) => parseFloat(getComputedStyle(el).height);
  // 瓶颈液位：clip-path 的 inset(t r b l)，"从下往上裁掉多少"就是 b。
  // 简写有 1~4 个值，按 CSS 的展开规则取 bottom。
  const fillOf = (clip) => {
    const m = /inset\(([^)]*)\)/.exec(clip || '');
    if (!m) return 0;
    const p = m[1].trim().split(/\s+/).map(parseFloat);
    const b = p.length >= 3 ? p[2] : p.length === 2 ? p[0] : p[0];
    return Math.round((1 - (b || 0) / 100) * 1000) / 1000;
  };
  return {
    cls: document.body.className,
    bodyAng: ang(bc.transform), upAng: Math.round(up * 10) / 10, liqAng: ang(lc.transform),
    surface: Math.round((up + ang(bc.transform) + ang(lc.transform)) * 10) / 10,
    tilt: num(bc.getPropertyValue('--tilt')), leanA: num(bc.getPropertyValue('--leanA')),
    pour: num(bc.getPropertyValue('--pour')), sip: num(bc.getPropertyValue('--sip')),
    liqTopPct: Math.round(parseFloat(lc.top) / hOf(lq.parentElement) * 1000) / 10,
    neckIn: fillOf(nc.clipPath), neckClip: nc.clipPath,
    box: { w: bc.width, h: bc.height },
  };
} catch (e) { return { error: String((e && e.stack) || e) }; } })()`;

app.disableHardwareAcceleration();   // 无 GPU 环境下 capturePage 更稳
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false, backgroundColor: '#1b1f26' });
  const js = (code) => win.webContents.executeJavaScript(code);

  for (let k = 0; k < STATES.length; k++) {
    const st = STATES[k];
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(build(st)));
    await new Promise((r) => setTimeout(r, SETTLE));   // 等 transition 走完，量的是稳定态
    const info = await js(PROBE_JS);
    console.log('INFO ' + JSON.stringify(info));

    if (PROBE || !OUT) continue;
    // 只截"瓶子框住的那一小块"，按设备像素原样抠出来
    const rect = await js(`(() => {
      const r = document.getElementById('bottle').getBoundingClientRect();
      const p = 14;
      return { x: Math.max(0, Math.round(r.left - p)), y: Math.max(0, Math.round(r.top - p)),
               width: Math.round(r.width + 2 * p), height: Math.round(r.height + 2 * p) };
    })()`);
    const img = await win.webContents.capturePage(rect);
    const file = STATES.length > 1
      ? OUT.replace(/\.png$/i, '') + '_' + (st.cls || 'idle') + '_' + st.sip + '.png'
      : OUT;
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), img.toPNG());
    console.log('WROTE ' + file + ' ' + img.getSize().width + 'x' + img.getSize().height);
  }
  app.exit(0);
}).catch((e) => { console.error('ERR ' + (e && e.stack || e)); app.exit(1); });

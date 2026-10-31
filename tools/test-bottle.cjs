// 酒瓶视图回归：node tools/test-bottle.cjs
//
// 这里测的是**渲染出来的真实角度**，不是算出来的角度 —— 所以必须开 Electron，
// 用 tools/bottle-lab.js 把 index.html 的样式真跑一遍，再把
// 「#gait→#pose→#lean→#breath→瓶身→酒液」整条链的 matrix 解析出来累加。
//
// 要守住的核心不变量只有一条：
//   液面在世界坐标里恒为水平（--slosh 刻意抖动的那 0.68s 除外，这里量的是稳定态）。
// 它靠不住的典型症状：瓶身转到 -138° 而酒液没跟着反补 —— 酒"浮"在翘起的瓶底那头，
// 瓶口这边反而是空的，看着像在喝空气。
//
// 其余几条守的是"越喝越少"的手感别被改坏：
//   直立时酒在低处、颈空；倾倒时酒在瓶口那头、颈满；喝得越多液面越靠瓶口。
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// 一次启动跑完所有状态（每个 ~1.5s 等 transition 落定）
const STATES = [
  'drinking:0',          // 直立、满瓶
  'sip:0.22',            // 仰灌第一口
  'sip:0.46',            // 仰灌第二口
  'sip sip-deep:0.9',    // 见底那一口（瓶底竖得更高）
];
const ROOT = path.join(__dirname, '..');
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;   // 沙箱/测试环境常把它设上，设了就变成纯 node，拿不到 app

let out = '';
// require('electron') 在纯 node 环境下返回的是可执行文件路径（在 electron 主进程里才是 API 对象）
let BIN = 'electron';
try { BIN = require('electron'); } catch (_) {}
try {
  out = execFileSync(
    BIN,
    [path.join(ROOT, 'tools', 'bottle-lab.js'), '--states=' + STATES.join(','), '--probe'],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }
  );
} catch (e) {
  console.log('  FAIL 启动放大台 ' + (e.message || e));
  process.exit(1);
}

const rows = out.split(/\r?\n/).filter((l) => l.startsWith('INFO ')).map((l) => JSON.parse(l.slice(5)));
if (rows.length !== STATES.length) {
  console.log('  FAIL 量到 ' + rows.length + ' 个状态，应该是 ' + STATES.length + '\n' + out.slice(0, 800));
  process.exit(1);
}
const by = {};
rows.forEach((r, i) => { by[STATES[i]] = r; });

console.log('\n[酒瓶 · 液面只认重力]');
t('每个状态的液面在世界坐标里都是水平的（|surface| ≤ 0.1°）', () => {
  rows.forEach((r, i) => {
    assert.ok(Math.abs(r.surface) <= 0.1,
      STATES[i] + ' 的液面歪了 ' + r.surface + '°（bodyAng ' + r.bodyAng + ' + 祖先 ' + r.upAng + ' + 酒液 ' + r.liqAng + '）');
  });
});
t('酒液角度 = -(祖先自转 + 瓶身倾角)：补偿的是整条链，不只瓶身', () => {
  rows.forEach((r, i) => {
    const want = -(r.upAng + r.bodyAng);
    assert.ok(Math.abs(r.liqAng - want) <= 0.2,
      STATES[i] + ' 酒液转了 ' + r.liqAng + '°，应该是 ' + want.toFixed(1) + '°');
  });
});
t('仰头角真的被读进来补偿掉了：sip 时祖先链是 -6.5°，液面仍是 0°', () => {
  const r = by['sip:0.22'];
  assert.ok(Math.abs(r.upAng + 6.5) <= 0.2, '祖先链 ' + r.upAng + '°，应该是 -6.5°');
  assert.ok(Math.abs(r.leanA + 6.5) <= 0.2, '--leanA ' + r.leanA + '°，应该是 -6.5°');
  assert.strictEqual(r.surface, 0);
});

console.log('\n[酒瓶 · 酒往低处流]');
t('直立（满瓶）：瓶身 12°，酒面贴着瓶身上沿，瓶颈是空的', () => {
  const r = by['drinking:0'];
  assert.ok(Math.abs(r.tilt - 12) <= 0.2, 'tilt ' + r.tilt);
  assert.ok(r.liqTopPct <= 1, '液面在瓶身的 ' + r.liqTopPct + '%，满瓶应该 0%');
  assert.ok(r.neckIn <= 0.06, '瓶颈填了 ' + Math.round(r.neckIn * 100) + '%，直立时应该空');
});
t('仰灌：瓶身翻到 -138°，酒面落到瓶身 78%（贴在瓶口那头）', () => {
  const r = by['sip:0.22'];
  assert.ok(Math.abs(r.tilt + 138) <= 0.2, 'tilt ' + r.tilt);
  assert.ok(Math.abs(r.liqTopPct - 78) <= 2, '液面在 ' + r.liqTopPct + '%，应该 78%');
  assert.ok(r.neckIn >= 0.94, '瓶颈只填了 ' + Math.round(r.neckIn * 100) + '%，倾斜时应该有酒');
});
t('喝得越多，液面越往瓶口那头退（第二口比第一口更靠上）', () => {
  assert.ok(by['sip:0.46'].liqTopPct < by['sip:0.22'].liqTopPct - 15,
    '0.22 → ' + by['sip:0.22'].liqTopPct + '%，0.46 → ' + by['sip:0.46'].liqTopPct + '%，没有退');
});
t('见底那一口把瓶底竖得更高（-152°），液面照样水平', () => {
  const r = by['sip sip-deep:0.9'];
  assert.ok(Math.abs(r.tilt + 152) <= 0.2, 'tilt ' + r.tilt);
  assert.strictEqual(r.surface, 0);
  assert.ok(r.liqTopPct < by['sip:0.46'].liqTopPct, '见底了液面应该更靠瓶口：' + r.liqTopPct + '%');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

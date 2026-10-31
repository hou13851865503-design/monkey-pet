// 眩晕眼回归：node tools/test-eyes.cjs
//
// 这个测试守的是"眩晕效果到底挂在谁身上"。原来是挂在 #swirl 上的 —— 那东西是
// #stage 的直接子元素，也就是**窗口坐标系**：#tilt/#gait/#pose/#lean/#breath 任何
// 一层动，头会跑、螺旋不跑。眩晕时身体还在 dizzyWobble 左右晃，于是那个黄圈一直在
// 头顶飘着，越飘越离眼睛远，看着像贴在屏幕上的一张纸，不是长在猴子身上的反应。
//
// 现在效果全在 .eye 里（位置/尺寸来自 character.json 的 eyes），所以这里钉四件事：
//   ① 窗口坐标系上不许再有任何眩晕元素；
//   ② 眼睛盒子的位置和大小必须跟着档案 + 窗口缩放走（三个尺寸都验）；
//   ③ 眼球里的东西被 .eye 裁住，不许漏到眼睛外面；
//   ④ 转的是眼球里的图形，支点在眼球中心；而且"居中"那条 transform 不能被动画吃掉。
//
// ④ 是这类 bug 的常见死法：把 rotation 动画挂到 .eye 上，transform: translate(-50%,-50%)
// 会被整条覆盖 —— 眼球当场往右下角窜半个身位。表现和"挂错父元素"一模一样，都叫偏移。
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const ROOT = path.join(__dirname, '..');
let BIN = 'electron';
try { BIN = require('electron'); } catch (_) {}
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;   // 设了它 electron 就退化成纯 node，拿不到 app

const SIZES = [192, 288, 384];
let out = '';
try {
  out = execFileSync(
    BIN,
    [path.join(ROOT, 'tools', 'eye-probe.js'), '--sizes=' + SIZES.join(',')],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }
  );
} catch (e) {
  console.log('  FAIL 启动眼睛探针 ' + (e.message || e));
  process.exit(1);
}

const line = out.split(/\r?\n/).find((l) => l.startsWith('PROBE '));
if (!line) {
  console.log('  FAIL 探针没有输出\n' + out.slice(0, 800));
  process.exit(1);
}
const probe = JSON.parse(line.slice(6));
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'character.json'), 'utf8'));
const PTS = PROFILE.eyes.points;

if (probe.runs.length !== SIZES.length) {
  console.log('  FAIL 跑了 ' + probe.runs.length + ' 个尺寸，应该 ' + SIZES.length);
  process.exit(1);
}

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, msg + '（实际 ' + a + ' 期望 ' + b + '）');

console.log('\n[眩晕 · 挂载目标]');
t('窗口坐标系里已经没有 #swirl（眩晕不再挂在 stage 上）', () => {
  probe.runs.forEach((r) => assert.strictEqual(r.swirl, false, '窗口 ' + r.win + ' 还能找到 #swirl'));
});
t('眩晕图形在眼球里：.eye > svg，父节点是 #eyes', () => {
  probe.runs.forEach((r) => r.eyes.forEach((e, i) => {
    assert.strictEqual(e.parent, 'eyes', '第 ' + i + ' 只眼的父节点是 ' + e.parent);
    assert.ok(e.svg, '第 ' + i + ' 只眼里没有 svg');
    assert.ok(e.svg.inside, '第 ' + i + ' 只眼的 svg 不在眼球里');
    assert.ok(e.svg.paths >= 1, '第 ' + i + ' 只眼里没有螺旋路径');
  }));
});
t('眩晕层压在脸上面（#eyes z-index 4，dizzy 时 opacity 1）', () => {
  probe.runs.forEach((r) => {
    assert.strictEqual(r.layer.z, '4', 'z-index ' + r.layer.z);
    assert.strictEqual(r.layer.opacity, '1', 'opacity ' + r.layer.opacity);
  });
});

console.log('\n[眩晕 · 跟随眼睛的位置和大小]');
t('三档窗口下，眼球盒子的中心和尺寸都等于档案 × 层尺寸（误差 ≤ 0.4px）', () => {
  probe.runs.forEach((r) => {
    const [lx, ly, lw, lh] = r.layer.rect;
    assert.strictEqual(r.eyes.length, 2, '窗口 ' + r.win + ' 上有 ' + r.eyes.length + ' 只眼');
    r.eyes.forEach((e, i) => {
      const p = PTS[i];
      const cx = e.rect[0] + e.rect[2] / 2;
      const cy = e.rect[1] + e.rect[3] / 2;
      near(cx, lx + p.x * lw, 0.4, '窗口 ' + r.win + ' 第 ' + i + ' 只眼中心 x');
      near(cy, ly + p.y * lh, 0.4, '窗口 ' + r.win + ' 第 ' + i + ' 只眼中心 y');
      near(e.rect[2], p.w * lw, 0.4, '窗口 ' + r.win + ' 第 ' + i + ' 只眼宽');
      near(e.rect[3], p.h * lh, 0.4, '窗口 ' + r.win + ' 第 ' + i + ' 只眼高');
    });
  });
});
t('眼球里的图形铺满眼球（不是按窗口或按别的什么算尺寸）', () => {
  probe.runs.forEach((r) => r.eyes.forEach((e, i) => {
    near(e.svg.box[0], e.rect[2], 0.2, '窗口 ' + r.win + ' 第 ' + i + ' 只眼 svg 宽');
    near(e.svg.box[1], e.rect[3], 0.2, '窗口 ' + r.win + ' 第 ' + i + ' 只眼 svg 高');
  }));
});

console.log('\n[眩晕 · 只在眼睛区域内显示]');
t('眼球自己负责裁切：overflow hidden + 圆角 50%', () => {
  probe.runs.forEach((r) => r.eyes.forEach((e, i) => {
    assert.strictEqual(e.overflow, 'hidden', '第 ' + i + ' 只眼 overflow=' + e.overflow + '，螺旋会漏到脸上');
    assert.strictEqual(e.radius, '50%', '第 ' + i + ' 只眼圆角=' + e.radius);
  }));
});

console.log('\n[眩晕 · 转的是眼睛里的东西]');
t('旋转动画挂在 svg 上，支点在眼球中心（原地转，不绕圈）', () => {
  probe.runs.forEach((r) => r.eyes.forEach((e, i) => {
    const s = e.svg;
    assert.strictEqual(s.anim, 'dizzySpin', '第 ' + i + ' 只眼没挂 dizzySpin');
    near(parseFloat(s.origin), e.rect[2] / 2, 0.2, '第 ' + i + ' 只眼支点 x');
    near(parseFloat(s.origin.split(' ')[1]), e.rect[3] / 2, 0.2, '第 ' + i + ' 只眼支点 y');
  }));
});
t('时间轴走半圈，图形真的在转（0° → 180°）', () => {
  probe.runs.forEach((r) => r.eyes.forEach((e, i) => {
    const sp = e.svg.spin;
    assert.ok(sp, '第 ' + i + ' 只眼取不到动画');
    assert.ok(Math.abs(Math.abs(sp.at450 - sp.at0) - 180) <= 2,
      '半圈应该转 180°，实际 ' + sp.at0 + '° → ' + sp.at450 + '°');
  }));
});
t('居中那条 transform 还在：纯平移 (-50%,-50%)，没被旋转动画吃掉', () => {
  probe.runs.forEach((r) => r.eyes.forEach((e, i) => {
    const m = /matrix\(([^)]+)\)/.exec(e.transform);
    assert.ok(m, '第 ' + i + ' 只眼 transform=' + e.transform);
    const v = m[1].split(',').map(Number);
    near(v[0], 1, 0.001, '第 ' + i + ' 只眼 x 缩放');
    near(v[3], 1, 0.001, '第 ' + i + ' 只眼 y 缩放');
    near(v[1], 0, 0.001, '第 ' + i + ' 只眼旋转量');
    near(v[2], 0, 0.001, '第 ' + i + ' 只眼旋转量');
    near(v[4], -e.rect[2] / 2, 0.3, '第 ' + i + ' 只眼居中位移 x');
    near(v[5], -e.rect[3] / 2, 0.3, '第 ' + i + ' 只眼居中位移 y');
  }));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

// 用 Electron 原生 shell.writeShortcutLink 生成 Windows 快捷方式（合法 IDList，图标可用）
// 用法：electron --no-sandbox tools/make_shortcut.js [输出lnk] [图标ico]
const { app, shell } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv;
const si = argv.findIndex((a) => /make_shortcut\.js$/i.test(a));
const rest = (si >= 0 ? argv.slice(si + 1) : []).filter((a) => !a.startsWith('--'));

const OUT = rest[0] || path.join(ROOT, '桌宠.lnk');
const ICON = rest[1] || path.join(ROOT, 'assets', 'icons', 'monkey.ico');

app.whenReady().then(() => {
  const opts = {
    target: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    cwd: ROOT,
    // 只传应用路径。开关必须放在路径之后（放前面会 bad option 直接退出）；
    // 这里不加任何 Chromium 开关——用户正常桌面环境不需要，加了反而可能崩渲染进程。
    args: '"' + ROOT + '"',
    description: '小猴桌宠',
    icon: ICON,
    iconIndex: 0,
  };
  let ok = false;
  try {
    ok = shell.writeShortcutLink(OUT, 'create', opts);
  } catch (e) {
    console.log('write error: ' + (e && e.message));
  }
  console.log('writeShortcutLink=' + ok + ' -> ' + OUT);

  if (ok) {
    try {
      const r = shell.readShortcutLink(OUT);
      console.log('readback target=' + r.target);
      console.log('readback cwd=' + r.cwd + ' args=' + r.args);
      console.log('readback icon=' + r.icon + ' idx=' + r.iconIndex);
    } catch (e) {
      console.log('read error: ' + (e && e.message));
    }
  }
  app.exit(ok ? 0 : 1);
});

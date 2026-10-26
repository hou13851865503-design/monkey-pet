// 启动器：主动清除 ELECTRON_RUN_AS_NODE，避免被外部环境（如 WorkBuddy 沙箱）
// 注入后以"纯 node 模式"启动 electron 导致 app 模块缺失。支持 Windows / macOS / Linux。
const { spawn } = require('child_process');
const path = require('path');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const bin = process.platform === 'win32' ? 'electron.exe'
  : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron'
  : 'electron';
const electronPath = path.join(__dirname, 'node_modules', 'electron', 'dist', bin);

const child = spawn(electronPath, ['.'], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));

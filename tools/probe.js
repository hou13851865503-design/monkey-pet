// 开发用：把素材按 5% 网格渲染出来，方便量道具锚点（嘴、手、烟头）的百分比坐标
// 用法：electron tools/probe.js out.png
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 980, height: 420, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(path.join(__dirname, 'probe.html'));
  await new Promise((r) => setTimeout(r, 900));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(process.argv[2] || path.join(__dirname, '_probe.png'), img.toPNG());
  app.exit(0);
});

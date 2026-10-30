// lockSize 棘轮的对照实验：electron tools/probe-locksize.js --no-sandbox
//
// 背景：这台机器 scaleFactor = 1.785，Windows 上无边框 + resizable 的窗口，
// getBounds() 比客户区大约 5px（隐形拖拽边框），而 setMinimumSize/setMaximumSize
// 认的是客户区。于是"读回尺寸 -> 锁住它"每做一次就把窗口放大 1~2px。
//
// 结论（实测）：
//   A 锁定值固定     -> 20 次移动后尺寸在 ±1 之间来回摆，不发散
//   B 每次回喂当前值 -> 20 次移动 200→228，每移动一次长 1.4px
//
// 所以 lockSize() 只能吃"设计尺寸"（sizeForZoom 的结果），永远不要吃 getBounds()。
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = () => new BrowserWindow({
  width: 197, height: 228, frame: false, transparent: true, resizable: true, show: false,
});

app.whenReady().then(async () => {
  const A = mk(), B = mk();
  await sleep(150);
  console.log('display scale=' + require('electron').screen.getPrimaryDisplay().scaleFactor);

  A.setMinimumSize(197, 228); A.setMaximumSize(197, 228);
  await sleep(80);
  const a = [];
  for (let i = 0; i < 20; i++) {
    const b = A.getBounds();
    A.setPosition(b.x + 3, b.y + 2);
    await sleep(50);
    a.push(A.getBounds().width + 'x' + A.getBounds().height);
  }
  console.log('A 锁定值固定:     ' + a.join(' '));

  const b2 = [];
  for (let i = 0; i < 20; i++) {
    const p = B.getBounds();
    B.setPosition(p.x + 3, p.y + 2);
    await sleep(50);
    const q = B.getBounds();
    B.setMinimumSize(q.width, q.height); B.setMaximumSize(q.width, q.height);
    await sleep(30);
    b2.push(B.getBounds().width + 'x' + B.getBounds().height);
  }
  console.log('B 每次回喂当前值: ' + b2.join(' '));
  app.exit(0);
});

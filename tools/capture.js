// 截屏工具：用 Electron 的 desktopCapturer 抓主屏，并按小猴位置裁切出局部图。
// 用法：electron.exe --disable-gpu tools/capture.js [输出路径] [边距px]
const { app, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

// Electron 会把 --switch 一起塞进 argv，这里只取脚本路径之后的非 switch 参数
const argv = process.argv;
const si = argv.findIndex((a) => /capture\.js$/i.test(a));
const rest = (si >= 0 ? argv.slice(si + 1) : []).filter((a) => !a.startsWith('--'));
const OUT = rest[0] || path.join(__dirname, '..', 'docs', 'screenshot.png');
const MARGIN = Number(rest[1] || 90) || 90;

async function main() {
  await new Promise((r) => setTimeout(r, 900));
  const disp = screen.getPrimaryDisplay();
  const dw = disp.size.width, dh = disp.size.height;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(dw), height: Math.round(dh) },
  });
  if (!sources.length) { console.error('NO_SOURCE'); app.exit(2); return; }

  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  let img = src.thumbnail;
  const isz = img.getSize();
  if (!isz.width || !isz.height) { console.error('EMPTY_THUMB'); app.exit(3); return; }

  const scale = isz.width / dw;

  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'monkey-pet', 'settings.json'), 'utf8'));
  } catch (_) {}

  const z = Number(cfg.zoom) || 1;
  const pw = Math.round(192 * z);
  const ph = Math.round(pw * 223 / 192);
  const pos = (cfg.pos && Number.isFinite(cfg.pos.x)) ? cfg.pos : { x: dw - pw - 24, y: dh - ph - 24 };

  let x, y, w, h;
  if (rest.length >= 6) {
    // 显式指定区域：out margin x y w h
    x = Math.round(Number(rest[2]) * scale);
    y = Math.round(Number(rest[3]) * scale);
    w = Math.round(Number(rest[4]) * scale);
    h = Math.round(Number(rest[5]) * scale);
  } else {
    x = Math.round((pos.x - MARGIN) * scale);
    y = Math.round((pos.y - MARGIN) * scale);
    w = Math.round((pw + MARGIN * 2) * scale);
    h = Math.round((ph + MARGIN * 2) * scale);
  }

  x = Math.max(0, Math.min(isz.width - 20, x));
  y = Math.max(0, Math.min(isz.height - 20, y));
  w = Math.min(w, isz.width - x);
  h = Math.min(h, isz.height - y);

  img = img.crop({ x, y, width: w, height: h });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, img.toPNG());
  console.log('WROTE ' + OUT + ' ' + w + 'x' + h + ' scale=' + scale.toFixed(3) + ' pet=' + pw + 'x' + ph + ' at ' + pos.x + ',' + pos.y);
  app.exit(0);
}

app.whenReady().then(main).catch((e) => { console.error('ERR ' + (e && e.message)); app.exit(1); });

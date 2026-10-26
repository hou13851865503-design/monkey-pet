// 从 assets/01.png（八面图正面）生成多尺寸 monkey.ico（正方形、透明底、居中不拉伸）
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'assets', '01.png');
const OUT = path.join(__dirname, '..', 'assets', 'monkey.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// 把任意比例的图按"contain"放进 size x size 的透明画布
function squareIcon(srcImg, size) {
  const s = srcImg.getSize();
  const scale = Math.min(size / s.width, size / s.height);
  const dw = Math.max(1, Math.round(s.width * scale));
  const dh = Math.max(1, Math.round(s.height * scale));
  const fit = srcImg.resize({ width: dw, height: dh, quality: 'best' });
  const fb = fit.toBitmap();
  const out = Buffer.alloc(size * size * 4, 0);
  const ox = Math.floor((size - dw) / 2);
  const oy = Math.floor((size - dh) / 2);
  for (let y = 0; y < dh; y++) {
    const srcStart = y * dw * 4;
    const dstStart = ((y + oy) * size + ox) * 4;
    fb.copy(out, dstStart, srcStart, srcStart + dw * 4);
  }
  return nativeImage.createFromBitmap(out, { width: size, height: size });
}

app.whenReady().then(() => {
  const base = nativeImage.createFromPath(SRC);
  if (base.isEmpty()) { console.error('SRC EMPTY'); app.exit(1); return; }

  const pngs = SIZES.map((s) => squareIcon(base, s).toPNG());
  const n = SIZES.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);   // 1 = icon
  header.writeUInt16LE(n, 4);

  const entries = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  SIZES.forEach((s, i) => {
    const o = i * 16;
    entries[o] = s >= 256 ? 0 : s;        // 0 表示 256
    entries[o + 1] = s >= 256 ? 0 : s;
    entries[o + 2] = 0;                    // colorCount
    entries[o + 3] = 0;                    // reserved
    entries.writeUInt16LE(1, o + 4);       // planes
    entries.writeUInt16LE(32, o + 6);      // bitCount
    entries.writeUInt32LE(pngs[i].length, o + 8);
    entries.writeUInt32LE(offset, o + 12);
    offset += pngs[i].length;
  });

  fs.writeFileSync(OUT, Buffer.concat([header, entries].concat(pngs)));
  console.log('wrote ' + OUT + ' ' + fs.statSync(OUT).size + ' bytes, sizes=' + SIZES.join(','));
  app.exit(0);
});

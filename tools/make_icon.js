// 从 assets/01.png（八面图正面）生成多尺寸 monkey.ico
// 小尺寸用 32bpp BMP（兼容性最好），256 用 PNG（体积小）
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'assets', '01.png');
const OUT = path.join(__dirname, '..', 'assets', 'icons', 'monkey.ico');
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

// 32bpp BMP（ICO 内的 DIB：BITMAPINFOHEADER + 倒序 BGRA + AND 掩码）
function bmpEntry(img, size) {
  const buf = img.toBitmap();
  const head = Buffer.alloc(40, 0);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8);
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(0, 16);
  head.writeUInt32LE(size * size * 4, 20);

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    buf.copy(xor, y * size * 4, src, src + size * 4);
  }
  const rowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(rowBytes * size, 0);
  return Buffer.concat([head, xor, and]);
}

app.whenReady().then(() => {
  const base = nativeImage.createFromPath(SRC);
  if (base.isEmpty()) { console.error('SRC EMPTY'); app.exit(1); return; }

  const blobs = SIZES.map((s) => {
    const img = squareIcon(base, s);
    return s >= 256 ? img.toPNG() : bmpEntry(img, s);
  });

  const n = SIZES.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(n, 4);

  const entries = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  SIZES.forEach((s, i) => {
    const o = i * 16;
    entries[o] = s >= 256 ? 0 : s;
    entries[o + 1] = s >= 256 ? 0 : s;
    entries[o + 2] = 0;
    entries[o + 3] = 0;
    entries.writeUInt16LE(1, o + 4);
    entries.writeUInt16LE(32, o + 6);
    entries.writeUInt32LE(blobs[i].length, o + 8);
    entries.writeUInt32LE(offset, o + 12);
    offset += blobs[i].length;
  });

  fs.writeFileSync(OUT, Buffer.concat([header, entries].concat(blobs)));
  console.log('wrote ' + OUT + ' ' + fs.statSync(OUT).size + ' bytes');
  app.exit(0);
});

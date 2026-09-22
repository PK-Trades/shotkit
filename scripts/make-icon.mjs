// Renders the ShotKit icon (same design as src/main/icon.ts) to build/icon.png for electron-builder.
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIZE = 512;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const radius = size * 0.24;
  const ringR = size * 0.25;
  const ringW = size * 0.09;
  const dotR = size * 0.085;
  const c1 = [79, 124, 255];
  const c2 = [166, 77, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      const qx = Math.abs(fx - half) - (half - radius);
      const qy = Math.abs(fy - half) - (half - radius);
      const dRect = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      const a = clamp01(0.5 - dRect);
      if (a <= 0) continue;
      const t = (fx + fy) / (2 * size);
      let r = c1[0] + (c2[0] - c1[0]) * t;
      let g = c1[1] + (c2[1] - c1[1]) * t;
      let b = c1[2] + (c2[2] - c1[2]) * t;
      const dc = Math.hypot(fx - half, fy - half);
      const white = Math.max(clamp01(0.5 - (Math.abs(dc - ringR) - ringW / 2)), clamp01(0.5 - (dc - dotR)));
      r += (255 - r) * white;
      g += (255 - g) * white;
      b += (255 - b) * white;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(255 * a);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', encodePng(drawIcon(SIZE), SIZE));
console.log('Wrote build/icon.png');

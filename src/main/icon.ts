import { nativeImage, NativeImage } from 'electron';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Draws the app icon (gradient rounded square with a lens ring) into a BGRA bitmap. */
export function makeIcon(size: number, scaleFactor = 1): NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const half = size / 2;
  const radius = size * 0.24;
  const ringR = size * 0.25;
  const ringW = size * 0.09;
  const dotR = size * 0.085;
  const c1 = [79, 124, 255];
  const c2 = [166, 77, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const qx = Math.abs(px - half) - (half - radius);
      const qy = Math.abs(py - half) - (half - radius);
      const dRect = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      const a = clamp01(0.5 - dRect);
      if (a <= 0) continue;

      const t = (px + py) / (2 * size);
      let r = c1[0] + (c2[0] - c1[0]) * t;
      let g = c1[1] + (c2[1] - c1[1]) * t;
      let b = c1[2] + (c2[2] - c1[2]) * t;

      const dc = Math.hypot(px - half, py - half);
      const ring = clamp01(0.5 - (Math.abs(dc - ringR) - ringW / 2));
      const dot = clamp01(0.5 - (dc - dotR));
      const white = Math.max(ring, dot);
      r += (255 - r) * white;
      g += (255 - g) * white;
      b += (255 - b) * white;

      const i = (y * size + x) * 4;
      buf[i] = Math.round(b * a);
      buf[i + 1] = Math.round(g * a);
      buf[i + 2] = Math.round(r * a);
      buf[i + 3] = Math.round(255 * a);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor });
}

let cached: NativeImage | null = null;
export function appIcon(): NativeImage {
  if (!cached) cached = makeIcon(64);
  return cached;
}

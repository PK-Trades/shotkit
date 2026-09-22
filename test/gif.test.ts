import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GifEncoder, Quantizer } from '../src/renderer/recorder/gif';

/** A tiny GIF decoder (enough for these tests): returns each frame's RGB pixels and delay. */
function decode(gif: Uint8Array) {
  let p = 6;
  const word = () => gif[p++] | (gif[p++] << 8);
  const width = word();
  const height = word();
  p += 3;
  const frames: { delay: number; rgb: number[] }[] = [];
  let delay = 0;
  while (p < gif.length) {
    const b = gif[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = gif[p++];
      if (label === 0xf9) {
        p++; // size
        p++; // flags
        delay = word();
        p += 2;
      } else {
        while (gif[p]) p += gif[p] + 1;
        p++;
      }
      continue;
    }
    assert.equal(b, 0x2c);
    p += 8;
    const flags = gif[p++];
    const size = 2 << (flags & 7);
    const palette = gif.subarray(p, p + size * 3);
    p += size * 3;
    const minCode = gif[p++];
    const data: number[] = [];
    while (gif[p]) {
      const n = gif[p++];
      for (let i = 0; i < n; i++) data.push(gif[p++]);
    }
    p++;
    // LZW decode.
    const clear = 1 << minCode;
    let codeSize = minCode + 1;
    let dict: number[][] = [];
    const reset = () => {
      dict = [];
      for (let i = 0; i < clear; i++) dict.push([i]);
      dict.push([], []);
      codeSize = minCode + 1;
    };
    reset();
    const out: number[] = [];
    let bit = 0;
    let prev: number[] | null = null;
    for (;;) {
      let code = 0;
      for (let i = 0; i < codeSize; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
      if (code === clear) {
        reset();
        prev = null;
        continue;
      }
      if (code === clear + 1) break;
      const entry: number[] = code < dict.length ? dict[code] : [...prev!, prev![0]];
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    const rgb: number[] = [];
    for (const i of out) rgb.push(palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]);
    frames.push({ delay, rgb });
  }
  return { width, height, frames };
}

function frame(w: number, h: number, f: (x: number, y: number) => [number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      px.set([r, g, b, 255], (y * w + x) * 4);
    }
  return px;
}

test('encodes frames that decode back to the same picture', () => {
  const w = 64;
  const h = 40;
  const enc = new GifEncoder(w, h);
  const a = frame(w, h, (x, y) => (x < 32 ? [255, 0, 0] : y < 20 ? [0, 128, 255] : [255, 255, 255]));
  const b = frame(w, h, (x) => [x * 4, x * 4, x * 4]);
  enc.addFrame(a, 10);
  enc.addFrame(b, 25);
  const gif = enc.finish();
  assert.equal(String.fromCharCode(...gif.subarray(0, 6)), 'GIF89a');
  assert.equal(gif[gif.length - 1], 0x3b);

  const d = decode(gif);
  assert.equal(d.width, w);
  assert.equal(d.height, h);
  assert.equal(d.frames.length, 2);
  assert.deepEqual(
    d.frames.map((f) => f.delay),
    [10, 25],
  );
  // Few colours: exact.
  for (let i = 0; i < w * h; i++) {
    assert.deepEqual(d.frames[0].rgb.slice(i * 3, i * 3 + 3), [a[i * 4], a[i * 4 + 1], a[i * 4 + 2]]);
  }
  // A gradient: close (colours are bucketed to 5 bits per channel).
  for (let i = 0; i < w * h; i++) assert.ok(Math.abs(d.frames[1].rgb[i * 3] - b[i * 4]) <= 8);
});

test('large noisy frames survive LZW table resets', () => {
  const w = 200;
  const h = 150;
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255;
  const px = frame(w, h, () => [rand(), rand(), rand()]);
  const enc = new GifEncoder(w, h);
  enc.addFrame(px, 5);
  const d = decode(enc.finish());
  assert.equal(d.frames[0].rgb.length, w * h * 3);
});

test('never uses more than 256 colours', () => {
  const q = new Quantizer();
  const px = frame(100, 100, (x, y) => [x * 2, y * 2, (x + y) & 255]);
  const { palette, indices } = q.quantize(px, 10000);
  assert.equal(palette.length, 768);
  assert.ok(Math.max(...indices) < 256);
});

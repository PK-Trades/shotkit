// A small streaming GIF encoder: one 256-colour palette per frame (median cut over a 15-bit
// colour histogram) and LZW compression. Good for screen recordings, which have few colours.

class Bytes {
  private buf = new Uint8Array(1 << 16);
  length = 0;

  private grow(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  byte(b: number) {
    this.grow(1);
    this.buf[this.length++] = b;
  }

  word(w: number) {
    this.byte(w & 0xff);
    this.byte((w >> 8) & 0xff);
  }

  bytes(b: ArrayLike<number>, from = 0, to = b.length) {
    this.grow(to - from);
    for (let i = from; i < to; i++) this.buf[this.length++] = b[i];
  }

  string(s: string) {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

const key = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Reduces an RGBA frame to at most 256 colours. */
export class Quantizer {
  private count = new Uint32Array(32768);
  private sum = new Float64Array(32768 * 3);
  private map = new Uint8Array(32768);

  quantize(rgba: ArrayLike<number>, n: number): { palette: Uint8Array; indices: Uint8Array } {
    const { count, sum, map } = this;
    const used: number[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const k = key(rgba[o], rgba[o + 1], rgba[o + 2]);
      if (!count[k]++) used.push(k);
      sum[k * 3] += rgba[o];
      sum[k * 3 + 1] += rgba[o + 1];
      sum[k * 3 + 2] += rgba[o + 2];
    }

    // Median cut over the used buckets, splitting the box with the widest channel range each time.
    type Box = { keys: number[]; range: number; channel: number };
    const describe = (keys: number[]): Box => {
      const lo = [31, 31, 31];
      const hi = [0, 0, 0];
      for (const k of keys) {
        const c = [(k >> 10) & 31, (k >> 5) & 31, k & 31];
        for (let j = 0; j < 3; j++) {
          if (c[j] < lo[j]) lo[j] = c[j];
          if (c[j] > hi[j]) hi[j] = c[j];
        }
      }
      const r = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      const channel = r[1] >= r[0] && r[1] >= r[2] ? 1 : r[0] >= r[2] ? 0 : 2;
      return { keys, range: r[channel], channel };
    };
    const boxes: Box[] = [describe(used)];
    while (boxes.length < 256) {
      let bi = -1;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].keys.length > 1 && (bi < 0 || boxes[i].range > boxes[bi].range)) bi = i;
      }
      if (bi < 0 || boxes[bi].range === 0) break;
      const { keys, channel } = boxes[bi];
      const shift = channel === 0 ? 10 : channel === 1 ? 5 : 0;
      keys.sort((a, b) => ((a >> shift) & 31) - ((b >> shift) & 31));
      // Split at the pixel-weighted median.
      let total = 0;
      for (const k of keys) total += count[k];
      let acc = 0;
      let cut = 1;
      for (; cut < keys.length; cut++) {
        acc += count[keys[cut - 1]];
        if (acc >= total / 2) break;
      }
      cut = Math.min(Math.max(cut, 1), keys.length - 1);
      boxes.splice(bi, 1, describe(keys.slice(0, cut)), describe(keys.slice(cut)));
    }

    const palette = new Uint8Array(768);
    boxes.forEach((b, i) => {
      let n2 = 0,
        r = 0,
        g = 0,
        bl = 0;
      for (const k of b.keys) {
        n2 += count[k];
        r += sum[k * 3];
        g += sum[k * 3 + 1];
        bl += sum[k * 3 + 2];
        map[k] = i;
      }
      palette[i * 3] = Math.round(r / n2);
      palette[i * 3 + 1] = Math.round(g / n2);
      palette[i * 3 + 2] = Math.round(bl / n2);
    });

    const indices = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      indices[i] = map[key(rgba[o], rgba[o + 1], rgba[o + 2])];
    }
    // Reset only what was touched, ready for the next frame.
    for (const k of used) {
      count[k] = 0;
      sum[k * 3] = sum[k * 3 + 1] = sum[k * 3 + 2] = 0;
    }
    return { palette, indices };
  }
}

const MASKS = [
  0x0000, 0x0001, 0x0003, 0x0007, 0x000f, 0x001f, 0x003f, 0x007f, 0x00ff, 0x01ff, 0x03ff, 0x07ff, 0x0fff, 0x1fff,
  0x3fff, 0x7fff, 0xffff,
];

/** GIF-flavoured LZW with variable code sizes up to 12 bits, written as data sub-blocks. */
export function lzw(pixels: Uint8Array, minCodeSize: number, out: Bytes) {
  const BITS = 12;
  const HSIZE = 5003;
  const htab = new Int32Array(HSIZE).fill(-1);
  const codetab = new Int32Array(HSIZE);
  const accum = new Uint8Array(256);
  let aCount = 0;
  let curAccum = 0;
  let curBits = 0;
  const initBits = minCodeSize + 1;
  let nBits = initBits;
  let maxcode = (1 << nBits) - 1;
  const clearCode = 1 << minCodeSize;
  const eofCode = clearCode + 1;
  let freeEnt = clearCode + 2;
  let clearFlag = false;

  const flush = () => {
    if (aCount > 0) {
      out.byte(aCount);
      out.bytes(accum, 0, aCount);
      aCount = 0;
    }
  };
  const put = (c: number) => {
    accum[aCount++] = c;
    if (aCount >= 254) flush();
  };
  const output = (code: number) => {
    curAccum &= MASKS[curBits];
    curAccum = curBits > 0 ? curAccum | (code << curBits) : code;
    curBits += nBits;
    while (curBits >= 8) {
      put(curAccum & 0xff);
      curAccum >>= 8;
      curBits -= 8;
    }
    if (freeEnt > maxcode || clearFlag) {
      if (clearFlag) {
        nBits = initBits;
        maxcode = (1 << nBits) - 1;
        clearFlag = false;
      } else {
        nBits++;
        maxcode = nBits === BITS ? 1 << BITS : (1 << nBits) - 1;
      }
    }
    if (code === eofCode) {
      while (curBits > 0) {
        put(curAccum & 0xff);
        curAccum >>= 8;
        curBits -= 8;
      }
      flush();
    }
  };

  out.byte(minCodeSize);
  let hshift = 0;
  for (let f = HSIZE; f < 65536; f *= 2) hshift++;
  hshift = 8 - hshift;

  output(clearCode);
  let ent = pixels[0];
  outer: for (let pos = 1; pos < pixels.length; pos++) {
    const c = pixels[pos];
    const fcode = (c << BITS) + ent;
    let i = (c << hshift) ^ ent;
    if (htab[i] === fcode) {
      ent = codetab[i];
      continue;
    }
    if (htab[i] >= 0) {
      const disp = i === 0 ? 1 : HSIZE - i;
      do {
        i -= disp;
        if (i < 0) i += HSIZE;
        if (htab[i] === fcode) {
          ent = codetab[i];
          continue outer;
        }
      } while (htab[i] >= 0);
    }
    output(ent);
    ent = c;
    if (freeEnt < 1 << BITS) {
      codetab[i] = freeEnt++;
      htab[i] = fcode;
    } else {
      htab.fill(-1);
      freeEnt = clearCode + 2;
      clearFlag = true;
      output(clearCode);
    }
  }
  output(ent);
  output(eofCode);
  out.byte(0); // block terminator
}

export class GifEncoder {
  private out = new Bytes();
  private quantizer = new Quantizer();
  frames = 0;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    const o = this.out;
    o.string('GIF89a');
    o.word(width);
    o.word(height);
    o.byte(0); // no global colour table
    o.byte(0);
    o.byte(0);
    // Loop forever.
    o.byte(0x21);
    o.byte(0xff);
    o.byte(11);
    o.string('NETSCAPE2.0');
    o.byte(3);
    o.byte(1);
    o.word(0);
    o.byte(0);
  }

  /** Adds an RGBA frame shown for `delayCs` hundredths of a second. */
  addFrame(rgba: ArrayLike<number>, delayCs: number) {
    const o = this.out;
    const { palette, indices } = this.quantizer.quantize(rgba, this.width * this.height);
    o.byte(0x21);
    o.byte(0xf9);
    o.byte(4);
    o.byte(0);
    o.word(Math.max(2, Math.round(delayCs)));
    o.byte(0);
    o.byte(0);
    o.byte(0x2c);
    o.word(0);
    o.word(0);
    o.word(this.width);
    o.word(this.height);
    o.byte(0x87); // local colour table, 256 entries
    o.bytes(palette);
    lzw(indices, 8, o);
    this.frames++;
  }

  finish(): Uint8Array {
    this.out.byte(0x3b);
    return this.out.result();
  }
}

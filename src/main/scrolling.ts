// Scrolling capture: repeatedly scrolls the region under the cursor, grabs a frame,
// finds how far the content moved by matching row hashes, and stitches the new rows on.
import { Display, globalShortcut, nativeImage, NativeImage, Rectangle, screen } from 'electron';
import { cropShot, grabDisplays } from './screenshot';
import { openScrollControl } from './windows';
import * as win32 from './win32';
import { notify, sleep } from './util';

const MAX_HEIGHT = 30000;
const MAX_FRAMES = 150;

let stopRequest: 'none' | 'done' | 'cancel' = 'none';

export function requestScrollStop(kind: 'done' | 'cancel') {
  stopRequest = kind;
}

// Read through a function: the value changes from IPC/shortcut callbacks mid-loop.
const stopState = () => stopRequest;

function rowInfo(buf: Buffer, w: number, h: number): [Uint32Array, Uint8Array] {
  const bytes = buf.byteOffset % 4 === 0 ? buf : Buffer.from(buf);
  const px = new Uint32Array(bytes.buffer, bytes.byteOffset, w * h);
  const hashes = new Uint32Array(h);
  const uniform = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const first = px[o] & 0xffffff;
    let hash = 0x811c9dc5;
    let uni = 1;
    for (let x = 0; x < w; x++) {
      const v = px[o + x] & 0xffffff;
      if (v !== first) uni = 0;
      hash = Math.imul(hash ^ v, 16777619);
    }
    hashes[y] = hash >>> 0;
    uniform[y] = uni;
  }
  return [hashes, uniform];
}

class Stitcher {
  private parts: Buffer[] = [];
  private readonly rowBytes: number;
  /** Rows at the bottom that never move (sticky footer); -1 until detected. */
  private footer = -1;
  private last: Buffer;
  private prevHash: Uint32Array;
  frames = 1;
  height: number;

  constructor(first: Buffer, private readonly w: number, private readonly h: number) {
    this.rowBytes = w * 4;
    this.last = first;
    this.prevHash = rowInfo(first, w, h)[0];
    this.parts.push(first);
    this.height = h;
  }

  add(buf: Buffer): 'same' | 'lost' | 'ok' {
    const { w, h } = this;
    const [hash, uni] = rowInfo(buf, w, h);
    const prev = this.prevHash;

    let top = 0;
    while (top < h && hash[top] === prev[top]) top++;
    if (top === h) return 'same';
    let bottom = 0;
    while (bottom < h && hash[h - 1 - bottom] === prev[h - 1 - bottom]) bottom++;

    if (this.footer < 0) {
      this.footer = Math.min(bottom, Math.floor(h / 3));
      this.parts[0] = this.parts[0].subarray(0, (h - this.footer) * this.rowBytes);
      this.height = h - this.footer;
    }

    const lo = Math.min(top, Math.floor(h / 3));
    const hi = h - this.footer;
    let best = -1;
    let bestScore = 0;
    for (let s = 1; s < hi - lo - 8; s++) {
      let matched = 0;
      let counted = 0;
      for (let y = lo; y < hi - s; y++) {
        if (uni[y]) continue;
        counted++;
        if (hash[y] === prev[y + s]) matched++;
      }
      if (counted >= 4) {
        const score = matched / counted;
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
    }
    if (best < 0 || bestScore < 0.6) return 'lost';

    this.parts.push(buf.subarray((hi - best) * this.rowBytes, hi * this.rowBytes));
    this.height += best;
    this.frames++;
    this.last = buf;
    this.prevHash = hash;
    return 'ok';
  }

  result(): NativeImage {
    const parts = [...this.parts];
    const footer = Math.max(0, this.footer);
    if (footer > 0) parts.push(this.last.subarray((this.h - footer) * this.rowBytes));
    return nativeImage.createFromBitmap(Buffer.concat(parts), { width: this.w, height: this.height + footer });
  }
}

/** `rect` is in DIPs relative to the display. Resolves to null if cancelled. */
export async function runScrolling(display: Display, rect: Rectangle): Promise<NativeImage | null> {
  stopRequest = 'none';
  const abs = {
    x: Math.round(display.bounds.x + rect.x),
    y: Math.round(display.bounds.y + rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  const phys = screen.dipToScreenRect(null, abs);
  const control = openScrollControl(abs);
  const escRegistered = globalShortcut.register('Escape', () => requestScrollStop('cancel'));

  const grabFrame = async () => {
    const [shot] = await grabDisplays([display.id]);
    if (!shot) throw new Error('Screen capture failed');
    const img = cropShot(shot, rect);
    return { bitmap: img.toBitmap(), ...img.getSize() };
  };

  try {
    await sleep(250);
    const first = await grabFrame();
    const stitcher = new Stitcher(first.bitmap, first.width, first.height);
    win32.setCursorPos(phys.x + phys.width / 2, phys.y + phys.height / 2);
    const notches = first.height > 700 ? 3 : first.height > 350 ? 2 : 1;

    let still = 0;
    while (stopState() === 'none' && stitcher.frames < MAX_FRAMES && stitcher.height < MAX_HEIGHT) {
      win32.scrollWheel(-120 * notches);
      await sleep(450);
      if (stopState() !== 'none') break;
      const frame = await grabFrame();
      if (frame.width !== first.width || frame.height !== first.height) break;
      const r = stitcher.add(frame.bitmap);
      if (r === 'same') {
        if (++still >= 2) break; // reached the end of the page
        continue;
      }
      still = 0;
      if (r === 'lost') {
        notify('Scrolling capture stopped', "Couldn't match the scrolled content. Kept what was captured so far.");
        break;
      }
      if (!control.isDestroyed()) control.webContents.send('scroll:status', stitcher.frames, stitcher.height);
    }
    if (stopState() === 'cancel') return null;
    return stitcher.result();
  } finally {
    if (escRegistered) globalShortcut.unregister('Escape');
    if (!control.isDestroyed()) control.destroy();
  }
}

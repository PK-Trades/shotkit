// Runs image jobs in a hidden renderer (see renderer/worker): WebP encoding, drawing the pointer
// into captures and styling window captures.
import { BrowserWindow, ipcMain, nativeImage, NativeImage } from 'electron';
import { pagePath, webPrefs } from './windows';

type Job =
  | { kind: 'webp'; quality: number }
  | { kind: 'cursor'; x: number; y: number; size: number }
  | { kind: 'window'; radius: number; shadow: boolean; scale: number };

let worker: { win: BrowserWindow; ready: Promise<void> } | null = null;
const pending = new Map<number, { resolve: (b: Buffer) => void; reject: (e: Error) => void }>();
let nextId = 1;

ipcMain.on('job:done', (_e, id: number, bytes: Uint8Array | null, error: string | null) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (bytes) p.resolve(Buffer.from(bytes));
  else p.reject(new Error(error ?? 'Image job failed'));
});

function ensureWorker() {
  if (worker && !worker.win.isDestroyed()) return worker;
  const win = new BrowserWindow({ show: false, width: 100, height: 100, webPreferences: webPrefs() });
  const ready = new Promise<void>((r) => ipcMain.once('job:ready', () => r()));
  win.loadFile(pagePath('worker'));
  win.on('closed', () => {
    for (const p of pending.values()) p.reject(new Error('Image worker closed'));
    pending.clear();
  });
  worker = { win, ready };
  return worker;
}

async function run(png: Buffer, job: Job): Promise<Buffer> {
  const w = ensureWorker();
  await w.ready;
  const id = nextId++;
  return new Promise<Buffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.win.webContents.send('job', id, png, job);
  });
}

export function encodeWebp(img: NativeImage, quality = 0.9): Promise<Buffer> {
  return run(img.toPNG(), { kind: 'webp', quality });
}

/** Draws the mouse pointer with its tip at (x, y) physical pixels. */
export async function drawCursor(img: NativeImage, x: number, y: number, scale: number): Promise<NativeImage> {
  const out = await run(img.toPNG(), { kind: 'cursor', x, y, size: 22 * scale });
  return nativeImage.createFromBuffer(out);
}

/** Rounds a window capture's corners and optionally adds a drop shadow on transparency. */
export async function styleWindow(img: NativeImage, shadow: boolean, scale: number): Promise<NativeImage> {
  const out = await run(img.toPNG(), { kind: 'window', radius: 8 * scale, shadow, scale });
  return nativeImage.createFromBuffer(out);
}

import { app, nativeImage, NativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { encodeWebp } from './imagejobs';
import { renderName } from './naming';
import { recognizeText } from './ocr';
import { getSettings, updateSettings } from './settings';

export interface HistoryItem {
  /** File name inside the history folder. */
  id: string;
  path: string;
  time: number;
  width: number;
  height: number;
}

/** What we know about a capture besides its pixels (stored in .meta/<id>.json). */
export interface ItemMeta {
  /** Save path relative to the save folder, without extension (from the file name template). */
  name?: string;
  app?: string;
  title?: string;
  mode?: string;
  /** Display scale factor at capture time. */
  scale?: number;
  /** Text recognised in the capture, for search. */
  text?: string;
}

export interface CaptureInfo {
  app?: string;
  title?: string;
  mode?: string;
  scale?: number;
}

const THUMB_WIDTH = 520;
const THUMB_MAX_HEIGHT = 780;

export function historyDir(): string {
  const d = path.join(app.getPath('userData'), 'history');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function subDir(name: string): string {
  const d = path.join(historyDir(), name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export const thumbPath = (id: string) => path.join(subDir('.thumbs'), `${id}.jpg`);
// An edited capture keeps the flattened result at its usual path (so copy, drag, pin and thumbnails
// just work), the untouched capture in .originals and the editable annotations in .edits.
const originalPath = (id: string) => path.join(subDir('.originals'), id);
const editsPath = (id: string) => path.join(subDir('.edits'), `${id}.json`);
const metaPath = (id: string) => path.join(subDir('.meta'), `${id}.json`);

export function timestampName(d = new Date()): string {
  return renderName('ShotKit {date} at {time}', { date: d });
}

function uniqueName(dir: string, base: string, ext: string): string {
  let name = `${base}.${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base} (${i}).${ext}`;
  return name;
}

/** Reads width/height straight from the PNG IHDR chunk, avoiding a full decode. */
function pngSize(file: string): { width: number; height: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(24);
    fs.readSync(fd, b, 0, 24, 0);
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

function writeThumb(id: string, img: NativeImage) {
  let t = img;
  if (t.getSize().width > THUMB_WIDTH) t = t.resize({ width: THUMB_WIDTH, quality: 'good' });
  const s = t.getSize();
  if (s.height > THUMB_MAX_HEIGHT) t = t.crop({ x: 0, y: 0, width: s.width, height: THUMB_MAX_HEIGHT });
  fs.writeFileSync(thumbPath(id), t.toJPEG(85));
}

export function readMeta(id: string): ItemMeta {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return {};
  }
}

function writeMeta(id: string, patch: ItemMeta) {
  fs.writeFileSync(metaPath(id), JSON.stringify({ ...readMeta(id), ...patch }));
}

export function addToHistory(img: NativeImage, info: CaptureInfo = {}): HistoryItem {
  const s = getSettings();
  const { width, height } = img.getSize();
  const uses = (t: string) => s.fileNameTemplate.includes(`{${t}}`);
  const name = renderName(s.fileNameTemplate, { date: new Date(), width, height, n: s.fileCounter, ...info });
  if (uses('n')) updateSettings({ fileCounter: s.fileCounter + 1 }, true);
  const dir = historyDir();
  const id = uniqueName(dir, name.split('/').pop()!, 'png');
  const file = path.join(dir, id);
  fs.writeFileSync(file, img.toPNG());
  writeThumb(id, img);
  writeMeta(id, { ...info, name });
  prune();
  queueTextIndex(id);
  return { id, path: file, time: Date.now(), width, height };
}

export function getItem(id: string): HistoryItem | null {
  if (!id || path.basename(id) !== id) return null;
  const file = path.join(historyDir(), id);
  if (!fs.existsSync(file)) return null;
  return { id, path: file, time: fs.statSync(file).mtimeMs, ...pngSize(file) };
}

export function listHistory(): HistoryItem[] {
  const dir = historyDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .map((f) => getItem(f))
    .filter((x): x is HistoryItem => !!x)
    .sort((a, b) => b.time - a.time);
}

function prune() {
  const limit = Math.max(10, getSettings().historyLimit);
  for (const it of listHistory().slice(limit)) deleteItem(it.id);
}

export function deleteItem(id: string) {
  const it = getItem(id);
  if (!it) return;
  for (const f of [it.path, thumbPath(id), originalPath(id), editsPath(id), metaPath(id)]) fs.rmSync(f, { force: true });
}

export function clearHistory() {
  for (const it of listHistory()) deleteItem(it.id);
}

export function updateItem(id: string, png: Buffer) {
  const it = getItem(id);
  if (!it) return;
  fs.writeFileSync(it.path, png);
  writeThumb(id, nativeImage.createFromBuffer(png));
}

export function thumbDataUrl(item: HistoryItem): string {
  const t = thumbPath(item.id);
  if (!fs.existsSync(t)) writeThumb(item.id, nativeImage.createFromPath(item.path));
  return `data:image/jpeg;base64,${fs.readFileSync(t).toString('base64')}`;
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

/** The history id of a file inside the history folder, or null for any other file. */
export function historyIdOf(file: string): string | null {
  return path.resolve(path.dirname(file)) === path.resolve(historyDir()) ? path.basename(file) : null;
}

/** What the editor should open for `file`: the unedited image plus any saved annotations. */
export function loadForEditing(file: string): { base: string; doc: unknown } {
  const id = historyIdOf(file);
  if (id && fs.existsSync(originalPath(id)) && fs.existsSync(editsPath(id))) {
    try {
      return { base: originalPath(id), doc: JSON.parse(fs.readFileSync(editsPath(id), 'utf8')) };
    } catch (e) {
      console.warn('Ignoring unreadable edits for', id, e);
    }
  }
  return { base: file, doc: null };
}

/** Stores an edited capture: the flattened image, plus the original and annotations for re-editing. */
export function saveEdits(id: string, png: Buffer, docJson: string) {
  const it = getItem(id);
  if (!it) return;
  if (!fs.existsSync(originalPath(id))) fs.copyFileSync(it.path, originalPath(id));
  fs.writeFileSync(editsPath(id), docJson);
  updateItem(id, png);
}

// ---------------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------------

/** HiDPI captures are shrunk to their on-screen size when the user chose "1×". */
export function outputImage(img: NativeImage, scale = 1): NativeImage {
  if (getSettings().exportScale !== '1x' || scale <= 1) return img;
  const { width, height } = img.getSize();
  return img.resize({ width: Math.round(width / scale), height: Math.round(height / scale), quality: 'best' });
}

export async function encode(img: NativeImage, format: 'png' | 'jpg' | 'webp'): Promise<Buffer> {
  if (format === 'jpg') return img.toJPEG(Math.min(100, Math.max(50, getSettings().jpgQuality || 92)));
  if (format === 'webp') return encodeWebp(img);
  return img.toPNG();
}

/** Path (without extension) the item is saved under, relative to the save folder. */
export function savedNameFor(item: HistoryItem): string {
  return readMeta(item.id).name ?? path.parse(item.id).name;
}

/** Path the item would have (or has) in the user's save folder. */
export function savedPathFor(item: HistoryItem): string {
  const s = getSettings();
  return path.join(s.saveFolder, `${savedNameFor(item)}.${s.format}`);
}

export async function exportToFolder(item: HistoryItem): Promise<string> {
  const s = getSettings();
  const target = savedPathFor(item);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const img = outputImage(nativeImage.createFromPath(item.path), readMeta(item.id).scale);
  fs.writeFileSync(target, await encode(img, s.format));
  return target;
}

// ---------------------------------------------------------------------------------------------
// Text index (for searching history)
// ---------------------------------------------------------------------------------------------

const indexQueue: string[] = [];
let indexing = false;

function queueTextIndex(id: string) {
  if (!getSettings().indexText) return;
  indexQueue.push(id);
  if (!indexing) void drainIndex();
}

async function drainIndex() {
  indexing = true;
  try {
    // One at a time and after a pause, so OCR never competes with the capture itself.
    while (indexQueue.length) {
      await new Promise((r) => setTimeout(r, 1500));
      const id = indexQueue.shift()!;
      const it = getItem(id);
      if (!it) continue;
      try {
        const text = (await recognizeText(nativeImage.createFromPath(it.path))).replace(/\s+/g, ' ').trim();
        if (getItem(id)) writeMeta(id, { text });
      } catch (e) {
        console.warn('Text indexing failed for', id, e);
      }
    }
  } finally {
    indexing = false;
  }
}

/** Indexes older captures that have no text yet (e.g. from before this feature). */
export function indexMissingText() {
  if (!getSettings().indexText) return;
  for (const it of listHistory()) if (readMeta(it.id).text === undefined) indexQueue.push(it.id);
  if (indexQueue.length && !indexing) void drainIndex();
}

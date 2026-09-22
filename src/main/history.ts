import { app, nativeImage, NativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from './settings';

export interface HistoryItem {
  /** File name inside the history folder. */
  id: string;
  path: string;
  time: number;
  width: number;
  height: number;
}

const THUMB_WIDTH = 520;
const THUMB_MAX_HEIGHT = 780;

export function historyDir(): string {
  const d = path.join(app.getPath('userData'), 'history');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function thumbsDir(): string {
  const d = path.join(historyDir(), '.thumbs');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export const thumbPath = (id: string) => path.join(thumbsDir(), `${id}.jpg`);

// An edited capture keeps the flattened result at its usual path (so copy, drag, pin and thumbnails
// just work), the untouched capture in .originals and the editable annotations in .edits.
function subDir(name: string): string {
  const d = path.join(historyDir(), name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const originalPath = (id: string) => path.join(subDir('.originals'), id);
const editsPath = (id: string) => path.join(subDir('.edits'), `${id}.json`);

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

export function timestampName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ShotKit ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
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

export function addToHistory(img: NativeImage): HistoryItem {
  const dir = historyDir();
  const id = uniqueName(dir, timestampName(), 'png');
  const file = path.join(dir, id);
  fs.writeFileSync(file, img.toPNG());
  writeThumb(id, img);
  prune();
  const { width, height } = img.getSize();
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
  fs.rmSync(it.path, { force: true });
  fs.rmSync(thumbPath(id), { force: true });
  fs.rmSync(originalPath(id), { force: true });
  fs.rmSync(editsPath(id), { force: true });
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

/** Path the item would have (or has) in the user's save folder. */
export function savedPathFor(item: HistoryItem): string {
  const s = getSettings();
  return path.join(s.saveFolder, `${path.parse(item.id).name}.${s.format}`);
}

export function exportToFolder(item: HistoryItem): string {
  const s = getSettings();
  fs.mkdirSync(s.saveFolder, { recursive: true });
  const target = savedPathFor(item);
  if (s.format === 'png') fs.copyFileSync(item.path, target);
  else fs.writeFileSync(target, nativeImage.createFromPath(item.path).toJPEG(92));
  return target;
}

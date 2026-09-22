// Screen recording of an area: a hidden recorder window does the capture and encoding; a
// control bar and a red outline (both kept out of the recording) show what's going on.
import { BrowserWindow, desktopCapturer, Display, ipcMain, Rectangle, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { renderName } from './naming';
import { getSettings } from './settings';
import { pagePath, webPrefs } from './windows';
import { clamp, errorMessage, notify } from './util';

interface Session {
  recorder: BrowserWindow;
  bar: BrowserWindow;
  frame: BrowserWindow;
  started: Date;
  stopping: boolean;
}

let session: Session | null = null;

export const isRecording = () => !!session;

function end() {
  const s = session;
  session = null;
  if (!s) return;
  for (const w of [s.recorder, s.bar, s.frame]) if (!w.isDestroyed()) w.destroy();
}

export function stopRecording() {
  const s = session;
  if (!s || s.stopping) return;
  s.stopping = true;
  if (!s.bar.isDestroyed()) s.bar.webContents.send('rec:status', 'saving');
  s.recorder.webContents.send('rec:stop');
}

function cancelRecording() {
  if (!session) return;
  if (!session.recorder.isDestroyed()) session.recorder.webContents.send('rec:cancel');
  end();
}

function uniquePath(base: string, ext: string): string {
  let p = `${base}.${ext}`;
  for (let i = 2; fs.existsSync(p); i++) p = `${base} (${i}).${ext}`;
  return p;
}

ipcMain.on('rec:stopRequest', () => stopRecording());
ipcMain.on('rec:cancelRequest', () => cancelRecording());
ipcMain.on('rec:started', () => {
  if (session && !session.bar.isDestroyed()) session.bar.webContents.send('rec:status', 'recording');
});
ipcMain.on('rec:error', (_e, message: string) => {
  end();
  notify('Recording failed', message);
});
ipcMain.on('rec:done', (_e, bytes: Uint8Array, ext: string) => {
  const s = session;
  end();
  if (!s) return;
  try {
    const set = getSettings();
    const name = renderName(set.fileNameTemplate, { date: s.started, mode: 'recording' });
    const target = uniquePath(path.join(set.saveFolder, name), ext);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(bytes));
    notify('Recording saved', `${path.basename(target)} — click to show it`, () => shell.showItemInFolder(target));
  } catch (e) {
    notify('Could not save the recording', errorMessage(e));
  }
});

/** Starts recording `rect` (DIPs relative to `display`). */
export async function startRecording(display: Display, rect: Rectangle) {
  if (session) return;
  const set = getSettings();
  const sf = display.scaleFactor;
  const displayWidth = Math.round(display.bounds.width * sf);
  const displayHeight = Math.round(display.bounds.height * sf);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const all = screen.getAllDisplays();
  const source =
    sources.find((s) => s.display_id === String(display.id)) ??
    (sources.length === all.length ? sources[all.findIndex((d) => d.id === display.id)] : sources[0]);
  if (!source) {
    notify('Recording failed', 'Could not find the screen to record.');
    return;
  }

  const abs = {
    x: Math.round(display.bounds.x + rect.x),
    y: Math.round(display.bounds.y + rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };

  const recorder = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: webPrefs() });
  const ready = new Promise<void>((r) => ipcMain.once('rec:ready', () => r()));
  recorder.loadFile(pagePath('recorder'));

  // Red outline just outside the area; click-through and excluded from capture.
  const m = 3;
  const frame = new BrowserWindow({
    x: abs.x - m,
    y: abs.y - m,
    width: abs.width + m * 2,
    height: abs.height + m * 2,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    thickFrame: false,
    show: false,
    webPreferences: webPrefs(),
  });
  frame.setIgnoreMouseEvents(true);
  frame.setContentProtection(true);
  frame.setAlwaysOnTop(true, 'screen-saver');
  frame.loadFile(pagePath('recordbar'), { hash: 'frame' });
  frame.once('ready-to-show', () => frame.showInactive());

  // Control bar below the area (or above it, or inside it when there's no room).
  const W = 300;
  const H = 60;
  const wa = display.workArea;
  let y = abs.y + abs.height + 12;
  if (y + H > wa.y + wa.height) y = abs.y - H - 12;
  if (y < wa.y) y = abs.y + abs.height - H - 12;
  const bar = new BrowserWindow({
    x: Math.round(clamp(abs.x + abs.width / 2 - W / 2, wa.x + 8, wa.x + wa.width - W - 8)),
    y: Math.round(y),
    width: W,
    height: H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    thickFrame: false,
    show: false,
    webPreferences: webPrefs(),
  });
  bar.setAlwaysOnTop(true, 'screen-saver');
  bar.setContentProtection(true);
  bar.loadFile(pagePath('recordbar'));
  bar.once('ready-to-show', () => bar.showInactive());

  session = { recorder, bar, frame, started: new Date(), stopping: false };
  recorder.on('closed', () => {
    if (session?.recorder === recorder) end();
  });

  await ready;
  if (session?.recorder !== recorder) return;
  const crop = {
    x: Math.round(rect.x * sf),
    y: Math.round(rect.y * sf),
    width: Math.max(2, Math.round(rect.width * sf)),
    height: Math.max(2, Math.round(rect.height * sf)),
  };
  const format = set.recordFormat === 'gif' ? 'gif' : 'mp4';
  const fps = format === 'gif' ? Math.min(15, set.recordFps || 12) : clamp(set.recordFps || 30, 5, 60);
  recorder.webContents.send('rec:start', { sourceId: source.id, displayWidth, displayHeight, crop, fps, format });
}

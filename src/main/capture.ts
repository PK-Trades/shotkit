import { BrowserWindow, clipboard, Display, globalShortcut, NativeImage, Rectangle, screen, WebContents } from 'electron';
import { getSettings } from './settings';
import { addToHistory, exportToFolder } from './history';
import { cropShot, grabDisplays, Shot } from './screenshot';
import { helperWindowHandles, notifyHistoryChanged, openEditor, pagePath, showInQuickAccess, webPrefs } from './windows';
import { listWindows, WinInfo } from './win32';
import { ocrToClipboard } from './ocr';
import { runScrolling } from './scrolling';
import { errorMessage, notify } from './util';

export type CaptureMode = 'area' | 'window' | 'fullscreen' | 'scrolling' | 'ocr';

interface Overlay {
  win: BrowserWindow;
  loaded: Promise<void>;
  displayId: number;
}

export interface Selection {
  displayId: number;
  /** DIPs relative to the display's top-left corner. */
  rect: Rectangle;
}

const overlays = new Map<number, Overlay>();
let pending: { resolve: (s: Selection | null) => void } | null = null;
let busy = false;

export function initCapture() {
  const reset = () => {
    if (pending) return;
    for (const o of overlays.values()) if (!o.win.isDestroyed()) o.win.destroy();
    overlays.clear();
  };
  screen.on('display-added', reset);
  screen.on('display-removed', reset);
  screen.on('display-metrics-changed', reset);
  // Pre-create overlays so the first capture feels instant.
  for (const d of screen.getAllDisplays()) ensureOverlay(d);
}

function ensureOverlay(d: Display): Overlay {
  const existing = overlays.get(d.id);
  if (existing && !existing.win.isDestroyed()) return existing;
  const win = new BrowserWindow({
    ...d.bounds,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    thickFrame: false,
    enableLargerThanScreen: true,
    webPreferences: webPrefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  const loaded = new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
  win.loadFile(pagePath('overlay'));
  const o: Overlay = { win, loaded, displayId: d.id };
  overlays.set(d.id, o);
  win.on('closed', () => {
    if (overlays.get(d.id) === o) overlays.delete(d.id);
  });
  return o;
}

async function select(mode: CaptureMode, shots: Shot[]): Promise<Selection | null> {
  let windows: WinInfo[] = [];
  try {
    windows = listWindows(helperWindowHandles());
  } catch (e) {
    console.warn('Window enumeration unavailable:', e);
  }
  const cursor = screen.getCursorScreenPoint();
  const result = new Promise<Selection | null>((resolve) => (pending = { resolve }));
  // Fallback in case the overlay can't take keyboard focus from the foreground app.
  globalShortcut.register('Escape', () => finishSelection(null));
  const magnifier = getSettings().showMagnifier;

  for (const shot of shots) {
    const o = ensureOverlay(shot.display);
    await o.loaded;
    if (!pending) break;
    const b = shot.display.bounds;
    o.win.setBounds(b);
    const { width, height } = shot.image.getSize();
    const wins = windows
      .map((w) => {
        const r = screen.screenToDipRect(null, { x: w.x, y: w.y, width: w.width, height: w.height });
        return { title: w.title, x: r.x - b.x, y: r.y - b.y, width: r.width, height: r.height };
      })
      .filter((r) => r.x < b.width && r.y < b.height && r.x + r.width > 0 && r.y + r.height > 0);
    o.win.webContents.send('overlay:init', {
      displayId: shot.display.id,
      mode,
      width,
      height,
      pixels: shot.image.toBitmap(),
      windows: wins,
      cursor: { x: cursor.x - b.x, y: cursor.y - b.y },
      magnifier,
    });
  }
  return result;
}

/** Called when an overlay has painted its frozen screenshot and can be shown. */
export function overlayReady(sender: WebContents) {
  if (!pending) return;
  const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  for (const o of overlays.values()) {
    if (o.win.isDestroyed() || o.win.webContents !== sender) continue;
    const d = screen.getAllDisplays().find((x) => x.id === o.displayId);
    o.win.show();
    if (d) o.win.setBounds(d.bounds); // re-apply: Windows can mis-size windows on mixed-DPI setups
    o.win.setAlwaysOnTop(true, 'screen-saver');
    if (d?.id === cursorDisplay.id) o.win.focus();
  }
}

export function finishSelection(sel: Selection | null) {
  if (!pending) return;
  const p = pending;
  pending = null;
  globalShortcut.unregister('Escape');
  for (const o of overlays.values()) {
    if (o.win.isDestroyed()) continue;
    o.win.hide();
    o.win.webContents.send('overlay:reset');
  }
  p.resolve(sel);
}

async function deliver(img: NativeImage) {
  const s = getSettings();
  const item = addToHistory(img);
  if (s.copyToClipboard) clipboard.writeImage(img);
  if (s.autoSave) {
    try {
      exportToFolder(item);
    } catch (e) {
      notify('Could not save screenshot', errorMessage(e));
    }
  }
  notifyHistoryChanged();
  if (s.openEditorAfterCapture) openEditor(item.path);
  else if (s.showQuickAccess) await showInQuickAccess(item);
  else notify('Screenshot captured', s.copyToClipboard ? 'Copied to clipboard.' : 'Saved to capture history.');
}

export async function startCapture(mode: CaptureMode) {
  if (busy) return;
  busy = true;
  try {
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const shots = await grabDisplays(mode === 'fullscreen' ? [cursorDisplay.id] : undefined);
    if (!shots.length) throw new Error('Could not capture the screen.');

    if (mode === 'fullscreen') {
      await deliver(shots[0].image);
      return;
    }

    const sel = await select(mode, shots);
    if (!sel) return;
    const shot = shots.find((s) => s.display.id === sel.displayId);
    if (!shot) return;

    if (mode === 'scrolling') {
      const img = await runScrolling(shot.display, sel.rect);
      if (img) await deliver(img);
      return;
    }
    const img = cropShot(shot, sel.rect);
    if (mode === 'ocr') await ocrToClipboard(img);
    else await deliver(img);
  } catch (e) {
    finishSelection(null);
    notify('Capture failed', errorMessage(e));
  } finally {
    busy = false;
  }
}

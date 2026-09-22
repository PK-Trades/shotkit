import { BrowserWindow, clipboard, Display, globalShortcut, NativeImage, Rectangle, screen, WebContents } from 'electron';
import { getSettings } from './settings';
import { addToHistory, CaptureInfo, exportToFolder, outputImage } from './history';
import { drawCursor, styleWindow } from './imagejobs';
import { cropShot, grabDisplays, Shot } from './screenshot';
import {
  helperWindowHandles,
  notifyHistoryChanged,
  openCountdown,
  openEditor,
  pagePath,
  showInQuickAccess,
  webPrefs,
} from './windows';
import { foregroundWindow, listWindows, WinInfo } from './win32';
import { ocrToClipboard } from './ocr';
import { runScrolling } from './scrolling';
import { isRecording, startRecording, stopRecording } from './recording';
import { errorMessage, notify, sleep } from './util';

export type CaptureMode =
  | 'area'
  | 'window'
  | 'fullscreen'
  | 'scrolling'
  | 'ocr'
  | 'previous'
  | 'record'
  | 'color'
  | 'measure';

type OverlayMode = Exclude<CaptureMode, 'fullscreen' | 'previous'>;

interface Overlay {
  win: BrowserWindow;
  loaded: Promise<void>;
  displayId: number;
}

export interface Selection {
  displayId: number;
  /** DIPs relative to the display's top-left corner. */
  rect: Rectangle;
  /** Picked as a window (rather than dragged), and that window's title. */
  window?: boolean;
  title?: string;
  /** Colour picker result. */
  color?: string;
}

const overlays = new Map<number, Overlay>();
let pending: { resolve: (s: Selection | null) => void } | null = null;
let busy = false;
/** The last area or window captured, for "Capture Previous Area". */
let lastArea: { displayId: number; rect: Rectangle } | null = null;

export function initCapture() {
  let rebuild: NodeJS.Timeout | undefined;
  const reset = () => {
    if (pending) return;
    for (const o of overlays.values()) if (!o.win.isDestroyed()) o.win.destroy();
    overlays.clear();
    // Re-create them once things settle, so the next capture is still instant.
    clearTimeout(rebuild);
    rebuild = setTimeout(() => {
      if (!pending) for (const d of screen.getAllDisplays()) ensureOverlay(d);
    }, 1500);
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
    // Transparent so a live (unfrozen) selection can show the real screen underneath.
    transparent: true,
    backgroundColor: '#00000000',
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

/**
 * Shows the selection overlay on every display. With `shots` the screen is frozen (the overlay
 * shows the screenshot); without, the overlay is see-through and the screen stays live.
 */
async function select(mode: OverlayMode, shots: Shot[] | null): Promise<Selection | null> {
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
  const magnifier = getSettings().showMagnifier || mode === 'color';
  const displays = shots ? shots.map((s) => s.display) : screen.getAllDisplays();

  for (const display of displays) {
    const o = ensureOverlay(display);
    await o.loaded;
    if (!pending) break;
    const b = display.bounds;
    o.win.setBounds(b);
    const image = shots?.find((s) => s.display.id === display.id)?.image;
    const size = image?.getSize() ?? {
      width: Math.round(b.width * display.scaleFactor),
      height: Math.round(b.height * display.scaleFactor),
    };
    const wins = windows
      .map((w) => {
        const r = screen.screenToDipRect(null, { x: w.x, y: w.y, width: w.width, height: w.height });
        return { title: w.title, x: r.x - b.x, y: r.y - b.y, width: r.width, height: r.height };
      })
      .filter((r) => r.x < b.width && r.y < b.height && r.x + r.width > 0 && r.y + r.height > 0);
    o.win.webContents.send('overlay:init', {
      displayId: display.id,
      mode,
      width: size.width,
      height: size.height,
      pixels: image ? image.toBitmap() : null,
      windows: wins,
      cursor: { x: cursor.x - b.x, y: cursor.y - b.y },
      magnifier: magnifier && !!image,
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

async function deliver(img: NativeImage, info: CaptureInfo) {
  const s = getSettings();
  const item = addToHistory(img, info);
  if (s.copyToClipboard) clipboard.writeImage(outputImage(img, info.scale));
  if (s.autoSave) {
    try {
      await exportToFolder(item);
    } catch (e) {
      notify('Could not save screenshot', errorMessage(e));
    }
  }
  notifyHistoryChanged();
  if (s.openEditorAfterCapture) openEditor(item.path);
  else if (s.showQuickAccess) await showInQuickAccess(item);
  else notify('Screenshot captured', s.copyToClipboard ? 'Copied to clipboard.' : 'Saved to capture history.');
}

/**
 * Shows a click-through countdown. Resolves true when it runs out, or false if cancelled with Esc.
 */
async function countdown(seconds: number): Promise<boolean> {
  const { win, loaded } = openCountdown();
  await loaded;
  return new Promise((resolve) => {
    let left = seconds;
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = async (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      globalShortcut.unregister('Escape');
      if (!win.isDestroyed()) win.destroy();
      // Let the countdown disappear from the screen before it is grabbed.
      if (ok) await sleep(200);
      resolve(ok);
    };
    globalShortcut.register('Escape', () => finish(false));
    const tick = () => {
      if (win.isDestroyed()) return finish(false);
      if (left <= 0) return finish(true);
      win.webContents.send('countdown:tick', left, seconds);
      left--;
      timer = setTimeout(tick, 1000);
    };
    tick();
  });
}

/** Self-timer: captures with the configured mode after the configured delay. */
export function startTimedCapture(mode?: CaptureMode, delay?: number) {
  const s = getSettings();
  return startCapture(mode ?? s.timerMode, delay ?? (Number(s.timerDelay) || 5));
}

/** Draws the pointer into `img` (a crop of `display` at DIP `rect`) if it's inside. */
async function withCursor(img: NativeImage, display: Display, rect: Rectangle, cursor: Electron.Point) {
  if (!getSettings().captureCursor) return img;
  const x = cursor.x - display.bounds.x - rect.x;
  const y = cursor.y - display.bounds.y - rect.y;
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return img;
  const k = img.getSize().width / rect.width;
  try {
    return await drawCursor(img, x * k, y * k, display.scaleFactor);
  } catch (e) {
    console.warn('Could not draw the pointer:', e);
    return img;
  }
}

function foreground(): { app?: string; title?: string } {
  try {
    const f = foregroundWindow();
    return f ? { app: f.app || undefined, title: f.title || undefined } : {};
  } catch {
    return {};
  }
}

export async function startCapture(mode: CaptureMode, delay = 0) {
  // The record shortcut stops a recording in progress.
  if (mode === 'record' && isRecording()) {
    stopRecording();
    return;
  }
  if (busy) return;
  busy = true;
  try {
    // Hover menus and tooltips stay open while the timer runs, then the screen is frozen as-is.
    if (delay > 0 && !(await countdown(delay))) return;
    const s = getSettings();
    // Before any overlay takes focus: what app is the user capturing?
    const front = foreground();
    const cursor = screen.getCursorScreenPoint();
    const cursorDisplay = screen.getDisplayNearestPoint(cursor);
    const info = (display: Display, m: string, title = front.title): CaptureInfo => ({
      ...front,
      title,
      mode: m,
      scale: display.scaleFactor,
    });

    if (mode === 'previous') {
      const last = lastArea;
      const display = last && screen.getAllDisplays().find((d) => d.id === last.displayId);
      if (!last || !display) {
        notify('No previous area yet', 'Capture an area first; this repeats it.');
        return;
      }
      const [shot] = await grabDisplays([display.id]);
      if (!shot) throw new Error('Could not capture the screen.');
      const img = await withCursor(cropShot(shot, last.rect), display, last.rect, cursor);
      await deliver(img, info(display, 'area'));
      return;
    }

    if (mode === 'fullscreen') {
      const [shot] = await grabDisplays([cursorDisplay.id]);
      if (!shot) throw new Error('Could not capture the screen.');
      const full = { x: 0, y: 0, width: shot.display.bounds.width, height: shot.display.bounds.height };
      await deliver(await withCursor(shot.image, shot.display, full, cursor), info(shot.display, 'fullscreen'));
      return;
    }

    // Recording always selects on the live screen; the colour picker and ruler need pixels.
    const live = mode === 'record' || (!s.freezeScreen && mode !== 'color' && mode !== 'measure');
    const shots = live ? null : await grabDisplays();
    if (shots && !shots.length) throw new Error('Could not capture the screen.');

    const sel = await select(mode, shots);
    if (!sel) return;

    if (mode === 'color') {
      if (sel.color) {
        clipboard.writeText(sel.color);
        notify('Colour copied', sel.color);
      }
      return;
    }
    const display = screen.getAllDisplays().find((d) => d.id === sel.displayId);
    if (!display) return;

    if (mode === 'record') {
      await startRecording(display, sel.rect);
      return;
    }

    let shot = shots?.find((x) => x.display.id === sel.displayId);
    if (!shot) {
      // Live selection: grab now that the overlay is gone.
      await sleep(150);
      [shot] = await grabDisplays([sel.displayId]);
      if (!shot) throw new Error('Could not capture the screen.');
    }

    if (mode === 'scrolling') {
      const img = await runScrolling(display, sel.rect);
      if (img) await deliver(img, info(display, 'scrolling'));
      return;
    }

    let img = cropShot(shot, sel.rect);
    if (mode === 'ocr') {
      await ocrToClipboard(img);
      return;
    }
    lastArea = { displayId: sel.displayId, rect: sel.rect };
    img = await withCursor(img, display, sel.rect, cursor);
    if (sel.window && s.windowStyle !== 'plain') {
      try {
        img = await styleWindow(img, s.windowStyle === 'shadow', display.scaleFactor);
      } catch (e) {
        console.warn('Could not style the window capture:', e);
      }
    }
    await deliver(img, sel.window ? info(display, 'window', sel.title) : info(display, 'area'));
  } catch (e) {
    finishSelection(null);
    notify('Capture failed', errorMessage(e));
  } finally {
    busy = false;
  }
}

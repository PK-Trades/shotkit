import { BrowserWindow, dialog, nativeImage, NativeImage, Rectangle, screen, WebPreferences } from 'electron';
import path from 'node:path';
import { getSettings } from './settings';
import { addToHistory, HistoryItem, thumbDataUrl } from './history';
import { appIcon } from './icon';
import { clamp } from './util';

export const pagePath = (page: string) => path.join(__dirname, 'renderer', page, 'index.html');

export const webPrefs = (): WebPreferences => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
  backgroundThrottling: false,
});

const hwndOf = (win: BrowserWindow) => Number(win.getNativeWindowHandle().readBigUInt64LE(0));

const cursorDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

// ---------------------------------------------------------------------------------------------
// Quick Access overlay (the floating thumbnail stack shown after each capture)
// ---------------------------------------------------------------------------------------------

const QA_WIDTH = 300;
let qa: { win: BrowserWindow; loaded: Promise<void> } | null = null;

function ensureQuickAccess() {
  if (qa && !qa.win.isDestroyed()) return qa;
  const win = new BrowserWindow({
    width: QA_WIDTH,
    height: 10,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    thickFrame: false,
    webPreferences: webPrefs(),
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  // Keeps the overlay out of our own (and other apps') screenshots.
  win.setContentProtection(true);
  const loaded = new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()));
  win.loadFile(pagePath('quick'));
  qa = { win, loaded };
  return qa;
}

export async function showInQuickAccess(item: HistoryItem) {
  const q = ensureQuickAccess();
  await q.loaded;
  const s = getSettings();
  q.win.webContents.send('qa:add', {
    id: item.id,
    thumb: thumbDataUrl(item),
    width: item.width,
    height: item.height,
    timeout: s.quickAccessTimeout,
    side: s.quickAccessPosition,
  });
}

export function resizeQuickAccess(height: number) {
  if (!qa || qa.win.isDestroyed()) return;
  if (height <= 0) {
    qa.win.hide();
    return;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const h = Math.min(Math.ceil(height), wa.height);
  const x = getSettings().quickAccessPosition === 'right' ? wa.x + wa.width - QA_WIDTH : wa.x;
  qa.win.setBounds({ x, y: wa.y + wa.height - h, width: QA_WIDTH, height: h });
  if (!qa.win.isVisible()) qa.win.showInactive();
}

/** Native handles of our own always-on-top helper windows, excluded from window picking. */
export function helperWindowHandles(): Set<number> {
  const set = new Set<number>();
  if (qa && !qa.win.isDestroyed()) set.add(hwndOf(qa.win));
  return set;
}

// ---------------------------------------------------------------------------------------------
// Annotation editor
// ---------------------------------------------------------------------------------------------

const editorFiles = new Map<number, string>();

export const editorFile = (webContentsId: number) => editorFiles.get(webContentsId);

export function openEditor(file: string) {
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) {
    dialog.showErrorBox('ShotKit', `Could not open ${file}`);
    return;
  }
  const d = cursorDisplay();
  const wa = d.workArea;
  const { width, height } = img.getSize();
  const w = Math.round(Math.min(wa.width * 0.9, Math.max(980, width / d.scaleFactor + 120)));
  const h = Math.round(Math.min(wa.height * 0.9, Math.max(660, height / d.scaleFactor + 200)));
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + (wa.height - h) / 2),
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#18181b',
    title: 'ShotKit Editor',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: webPrefs(),
  });
  win.setMenu(null);
  const id = win.webContents.id;
  editorFiles.set(id, file);
  win.on('closed', () => editorFiles.delete(id));
  win.loadFile(pagePath('editor'));
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
}

export async function openEditorFromDialog() {
  const r = await dialog.showOpenDialog({
    title: 'Open image in ShotKit',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }],
  });
  if (!r.canceled && r.filePaths[0]) openEditor(r.filePaths[0]);
}

// ---------------------------------------------------------------------------------------------
// Pinned screenshots (floating always-on-top images)
// ---------------------------------------------------------------------------------------------

const pinImages = new Map<number, NativeImage>();

export const pinImage = (webContentsId: number) => pinImages.get(webContentsId);

export function openPin(img: NativeImage) {
  if (img.isEmpty()) return;
  const cursor = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(cursor);
  const wa = d.workArea;
  const size = img.getSize();
  let w = size.width / d.scaleFactor;
  let h = size.height / d.scaleFactor;
  const f = Math.min(1, (wa.width * 0.8) / w, (wa.height * 0.8) / h);
  w = Math.max(40, Math.round(w * f));
  h = Math.max(40, Math.round(h * f));
  const win = new BrowserWindow({
    x: Math.round(clamp(cursor.x - w / 2, wa.x, wa.x + wa.width - w)),
    y: Math.round(clamp(cursor.y - h / 2, wa.y, wa.y + wa.height - h)),
    width: w,
    height: h,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#000000',
    title: 'ShotKit Pin',
    icon: appIcon(),
    webPreferences: webPrefs(),
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setAspectRatio(w / h);
  win.setMinimumSize(40, 40);
  const id = win.webContents.id;
  pinImages.set(id, img);
  win.on('closed', () => pinImages.delete(id));
  win.loadFile(pagePath('pin'));
  win.once('ready-to-show', () => win.show());
}

export function zoomPin(win: BrowserWindow, factor: number) {
  const b = win.getBounds();
  const nw = Math.round(clamp(b.width * factor, 60, 8000));
  const nh = Math.round((nw * b.height) / b.width);
  win.setBounds({
    x: Math.round(b.x + (b.width - nw) / 2),
    y: Math.round(b.y + (b.height - nh) / 2),
    width: nw,
    height: nh,
  });
}

export async function openPinFromDialog() {
  const r = await dialog.showOpenDialog({
    title: 'Pin an image to the screen',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }],
  });
  if (!r.canceled && r.filePaths[0]) openPin(nativeImage.createFromPath(r.filePaths[0]));
}

/** Opens an in-memory image in the editor by saving it to history first. */
export function editImage(img: NativeImage) {
  const item = addToHistory(img);
  notifyHistoryChanged();
  openEditor(item.path);
}

// ---------------------------------------------------------------------------------------------
// History and Settings windows (singletons)
// ---------------------------------------------------------------------------------------------

let historyWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;

function singleton(existing: BrowserWindow | null, page: string, title: string, width: number, height: number) {
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 520,
    minHeight: 420,
    show: false,
    title,
    backgroundColor: '#18181b',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: webPrefs(),
  });
  win.setMenu(null);
  win.loadFile(pagePath(page));
  win.once('ready-to-show', () => win.show());
  return win;
}

export function openHistory() {
  historyWin = singleton(historyWin, 'history', 'ShotKit — Capture History', 1000, 700);
}

export function notifyHistoryChanged() {
  if (historyWin && !historyWin.isDestroyed()) historyWin.webContents.send('history:changed');
}

export function openSettings() {
  settingsWin = singleton(settingsWin, 'settings', 'ShotKit Settings', 620, 760);
}

// ---------------------------------------------------------------------------------------------
// Scrolling-capture control bar
// ---------------------------------------------------------------------------------------------

export function openScrollControl(area: Rectangle): BrowserWindow {
  const W = 340;
  const H = 60;
  const wa = screen.getDisplayMatching(area).workArea;
  const x = Math.round(clamp(area.x + area.width / 2 - W / 2, wa.x + 8, wa.x + wa.width - W - 8));
  let y = area.y + area.height + 12;
  if (y + H > wa.y + wa.height) {
    y = area.y - H - 12;
    if (y < wa.y) y = area.y + area.height - H - 12;
  }
  const win = new BrowserWindow({
    x,
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
    show: false,
    hasShadow: false,
    thickFrame: false,
    webPreferences: webPrefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true);
  win.loadFile(pagePath('scroll'));
  win.once('ready-to-show', () => win.showInactive());
  return win;
}

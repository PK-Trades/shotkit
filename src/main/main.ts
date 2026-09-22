import { app, globalShortcut, Menu, MenuItemConstructorOptions, nativeTheme, screen, Tray } from 'electron';
import { getSettings, isFirstRun, onSettingsChanged } from './settings';
import { CaptureMode, initCapture, startCapture } from './capture';
import { registerHotkeys } from './hotkeys';
import { registerIpc } from './ipc';
import { makeIcon } from './icon';
import { openEditorFromDialog, openHistory, openPinFromDialog, openSettings } from './windows';
import * as win32 from './win32';
import { notify } from './util';
import { checkForUpdates, downloadUpdate, initUpdater, installUpdate, updateState } from './updater';

let tray: Tray | null = null;

const LABELS: Record<string, string> = {
  area: 'Capture Area',
  window: 'Capture Window',
  fullscreen: 'Capture Fullscreen',
  scrolling: 'Scrolling Capture',
  ocr: 'Capture Text (OCR)',
  history: 'Capture History',
};

// Give the tray menu time to disappear so it isn't in the screenshot.
const captureLater = (mode: CaptureMode) => () => setTimeout(() => startCapture(mode), 250);

function buildMenu(): Menu {
  const hk = getSettings().hotkeys;
  const acc = (a: string): Partial<MenuItemConstructorOptions> =>
    a ? { accelerator: a, registerAccelerator: false } : {};
  let iconsVisible = true;
  try {
    iconsVisible = win32.desktopIconsVisible();
  } catch {
    // koffi unavailable
  }
  return Menu.buildFromTemplate([
    { label: LABELS.area, ...acc(hk.area), click: captureLater('area') },
    { label: LABELS.window, ...acc(hk.window), click: captureLater('window') },
    { label: LABELS.fullscreen, ...acc(hk.fullscreen), click: captureLater('fullscreen') },
    { label: LABELS.scrolling, ...acc(hk.scrolling), click: captureLater('scrolling') },
    { label: LABELS.ocr, ...acc(hk.ocr), click: captureLater('ocr') },
    { type: 'separator' },
    { label: 'Open Image in Editor…', click: () => openEditorFromDialog() },
    { label: 'Pin Image to Screen…', click: () => openPinFromDialog() },
    { label: LABELS.history, ...acc(hk.history), click: () => openHistory() },
    { type: 'separator' },
    {
      label: 'Hide Desktop Icons',
      type: 'checkbox',
      checked: !iconsVisible,
      click: (item) => {
        try {
          win32.setDesktopIconsVisible(!item.checked);
        } catch (e) {
          notify('Could not toggle desktop icons', String(e));
        }
      },
    },
    { type: 'separator' },
    updateMenuItem(),
    { label: 'Settings…', click: () => openSettings() },
    { label: `Quit ShotKit ${app.getVersion()}`, click: () => app.quit() },
  ]);
}

function updateMenuItem(): MenuItemConstructorOptions {
  const u = updateState();
  switch (u.status) {
    case 'checking':
      return { label: 'Checking for Updates…', enabled: false };
    case 'available':
      return { label: `Download Update ${u.version}…`, click: () => downloadUpdate() };
    case 'downloading':
      return { label: `Downloading Update… ${u.percent}%`, enabled: false };
    case 'ready':
      return { label: `Restart to Update to ${u.version}`, click: () => installUpdate() };
    default:
      return { label: 'Check for Updates…', click: () => checkForUpdates(true) };
  }
}

function refreshTrayTooltip() {
  const u = updateState();
  const suffix =
    u.status === 'downloading'
      ? ` — downloading update ${u.percent}%`
      : u.status === 'ready'
        ? ` — update ${u.version} ready`
        : u.status === 'available'
          ? ` — update ${u.version} available`
          : '';
  tray?.setToolTip(`ShotKit ${app.getVersion()}${suffix}`);
}

function applyLoginItem() {
  // Only meaningful for the installed app; in dev it would register electron.exe itself.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: getSettings().launchAtLogin });
}

function createTray() {
  const sf = screen.getPrimaryDisplay().scaleFactor;
  tray = new Tray(makeIcon(Math.round(16 * sf), sf));
  tray.setToolTip(`ShotKit ${app.getVersion()}`);
  const show = () => tray?.popUpContextMenu(buildMenu());
  tray.on('click', show);
  tray.on('right-click', show);
}

function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setAppUserModelId('com.shotkit.app');
  app.on('second-instance', () => openSettings());
  // Live in the tray: closing every window must not quit the app.
  app.on('window-all-closed', () => {});
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    try {
      if (!win32.desktopIconsVisible()) win32.setDesktopIconsVisible(true);
    } catch {
      // ignore
    }
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    Menu.setApplicationMenu(null);
    registerIpc();
    initCapture();
    createTray();
    initUpdater(refreshTrayTooltip);

    const failed = registerHotkeys();
    applyLoginItem();
    onSettingsChanged(() => {
      registerHotkeys();
      applyLoginItem();
    });

    if (isFirstRun()) {
      notify('ShotKit is running', 'Press Ctrl+Shift+4 to capture an area. Click the tray icon for more options.');
    }
    if (failed.length) {
      notify(
        'Some shortcuts are unavailable',
        `${failed.map((f) => LABELS[f]).join(', ')}: already used by another app. Change them in Settings.`,
      );
    }
  });
}

main();

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type HotkeyAction = 'area' | 'window' | 'fullscreen' | 'scrolling' | 'ocr' | 'history';

export interface Settings {
  hotkeys: Record<HotkeyAction, string>;
  saveFolder: string;
  autoSave: boolean;
  copyToClipboard: boolean;
  showQuickAccess: boolean;
  openEditorAfterCapture: boolean;
  quickAccessPosition: 'left' | 'right';
  /** Seconds before a Quick Access card closes itself; 0 = never. */
  quickAccessTimeout: number;
  format: 'png' | 'jpg';
  showMagnifier: boolean;
  launchAtLogin: boolean;
  historyLimit: number;
}

function defaults(): Settings {
  return {
    hotkeys: {
      area: 'CommandOrControl+Shift+4',
      window: 'CommandOrControl+Shift+5',
      fullscreen: 'CommandOrControl+Shift+3',
      scrolling: 'CommandOrControl+Shift+6',
      ocr: 'CommandOrControl+Shift+2',
      history: '',
    },
    saveFolder: path.join(app.getPath('pictures'), 'ShotKit'),
    autoSave: true,
    copyToClipboard: true,
    showQuickAccess: true,
    openEditorAfterCapture: true,
    quickAccessPosition: 'left',
    quickAccessTimeout: 30,
    format: 'png',
    showMagnifier: true,
    launchAtLogin: false,
    historyLimit: 200,
  };
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

let current: Settings | null = null;
let firstRun = false;
const listeners: ((s: Settings) => void)[] = [];

export function getSettings(): Settings {
  if (!current) {
    const d = defaults();
    try {
      const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
      current = { ...d, ...raw, hotkeys: { ...d.hotkeys, ...(raw.hotkeys ?? {}) } };
    } catch {
      firstRun = !fs.existsSync(settingsFile());
      current = d;
      persist(d);
    }
  }
  return current!;
}

export const isFirstRun = () => (getSettings(), firstRun);

function persist(s: Settings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const s = getSettings();
  current = { ...s, ...patch, hotkeys: { ...s.hotkeys, ...(patch.hotkeys ?? {}) } };
  persist(current);
  for (const l of listeners) l(current);
  return current;
}

export function onSettingsChanged(fn: (s: Settings) => void) {
  listeners.push(fn);
}

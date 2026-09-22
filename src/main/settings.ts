import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export type HotkeyAction =
  | 'area'
  | 'window'
  | 'fullscreen'
  | 'scrolling'
  | 'ocr'
  | 'timer'
  | 'previous'
  | 'record'
  | 'colorPicker'
  | 'measure'
  | 'history';
export type TimerMode = 'area' | 'window' | 'fullscreen';
export type UploadService = 'none' | 'imgur' | 'custom';

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
  format: 'png' | 'jpg' | 'webp';
  /** JPEG quality, 50–100. */
  jpgQuality: number;
  /** 'full' keeps HiDPI captures at full resolution; '1x' saves them at their on-screen size. */
  exportScale: 'full' | '1x';
  /**
   * File name for saved captures, without extension. Tokens: {date} {time} {year} {month} {day}
   * {hour} {minute} {second} {app} {title} {mode} {width} {height} {n}. "/" makes subfolders.
   */
  fileNameTemplate: string;
  /** Running number for {n}. */
  fileCounter: number;
  showMagnifier: boolean;
  /** Freeze the screen while selecting (off: live, so animations keep playing). */
  freezeScreen: boolean;
  /** Draw the mouse pointer into captures. */
  captureCursor: boolean;
  /** Window captures: as-is, with rounded corners, or rounded with a drop shadow on transparency. */
  windowStyle: 'plain' | 'rounded' | 'shadow';
  launchAtLogin: boolean;
  historyLimit: number;
  /** Read the text of every capture in the background so history can be searched by it. */
  indexText: boolean;
  /** Self-timer: what to capture, and after how many seconds. */
  timerMode: TimerMode;
  timerDelay: number;
  /** Format of the file dragged out of Quick Access. */
  dragFormat: 'png' | 'jpg';
  uploadService: UploadService;
  imgurClientId: string;
  /** Custom upload: POST multipart/form-data to `customUploadUrl` with the file in `customUploadField`. */
  customUploadUrl: string;
  customUploadField: string;
  /** Extra request headers, one "Name: value" per line. */
  customUploadHeaders: string;
  /** Where the link is in the JSON response, e.g. "data.link"; empty = the response body is the link. */
  customUploadUrlPath: string;
  recordFormat: 'mp4' | 'gif';
  recordFps: number;
}

function defaults(): Settings {
  return {
    hotkeys: {
      area: 'CommandOrControl+Shift+4',
      window: 'CommandOrControl+Shift+5',
      fullscreen: 'CommandOrControl+Shift+3',
      scrolling: 'CommandOrControl+Shift+6',
      ocr: 'CommandOrControl+Shift+2',
      timer: 'CommandOrControl+Shift+7',
      record: 'CommandOrControl+Shift+8',
      previous: '',
      colorPicker: '',
      measure: '',
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
    jpgQuality: 92,
    exportScale: 'full',
    fileNameTemplate: 'ShotKit {date} at {time}',
    fileCounter: 1,
    showMagnifier: true,
    freezeScreen: true,
    captureCursor: false,
    windowStyle: 'plain',
    launchAtLogin: false,
    historyLimit: 200,
    indexText: true,
    timerMode: 'area',
    timerDelay: 5,
    dragFormat: 'png',
    uploadService: 'none',
    imgurClientId: '',
    customUploadUrl: '',
    customUploadField: 'file',
    customUploadHeaders: '',
    customUploadUrlPath: '',
    recordFormat: 'mp4',
    recordFps: 30,
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

/** `quiet` skips the change listeners (hotkey re-registration etc.), e.g. for the file counter. */
export function updateSettings(patch: Partial<Settings>, quiet = false): Settings {
  const s = getSettings();
  current = { ...s, ...patch, hotkeys: { ...s.hotkeys, ...(patch.hotkeys ?? {}) } };
  persist(current);
  if (!quiet) for (const l of listeners) l(current);
  return current;
}

export function onSettingsChanged(fn: (s: Settings) => void) {
  listeners.push(fn);
}

import { globalShortcut } from 'electron';
import { getSettings, HotkeyAction } from './settings';
import { startCapture, startTimedCapture } from './capture';
import { openHistory } from './windows';

const actions: Record<HotkeyAction, () => void> = {
  area: () => startCapture('area'),
  window: () => startCapture('window'),
  fullscreen: () => startCapture('fullscreen'),
  scrolling: () => startCapture('scrolling'),
  ocr: () => startCapture('ocr'),
  timer: () => startTimedCapture(),
  history: () => openHistory(),
};

let registered: string[] = [];
let failed: HotkeyAction[] = [];

export function unregisterHotkeys() {
  for (const accel of registered) globalShortcut.unregister(accel);
  registered = [];
}

/** (Re)registers all configured shortcuts; returns the actions whose shortcut is taken. */
export function registerHotkeys(): HotkeyAction[] {
  unregisterHotkeys();
  failed = [];
  for (const [action, accel] of Object.entries(getSettings().hotkeys) as [HotkeyAction, string][]) {
    const handler = actions[action];
    if (!accel || !handler) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accel, handler);
    } catch {
      ok = false;
    }
    if (ok) registered.push(accel);
    else failed.push(action);
  }
  return failed;
}

export const failedHotkeys = () => failed;

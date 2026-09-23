// Auto-update from GitHub Releases (published by .github/workflows/release.yml).
// Flow: check (automatically, or from the tray) → notify / ask to download → download in the
// background → ask to restart.
import { app, dialog, Notification, powerMonitor } from 'electron';
import { autoUpdater, UpdateInfo } from 'electron-updater';
import { errorMessage, notify } from './util';

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string };

const STARTUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** After a failed automatic check (e.g. no network yet right after login), try again sooner. */
const RETRY_DELAY_MS = 5 * 60 * 1000;

let state: UpdateState = { status: 'idle' };
let manualCheck = false;
/** Versions already announced; automatic checks notify about each new version once per session. */
const announced = new Set<string>();
let nextCheck: NodeJS.Timeout | undefined;
/** Held so the toast (and its click handler) isn't garbage collected while it's on screen. */
let toast: Notification | undefined;
let onChange: () => void = () => {};

export const updateState = () => state;

function setState(s: UpdateState) {
  state = s;
  onChange();
}

function notes(info: UpdateInfo): string {
  const raw = Array.isArray(info.releaseNotes)
    ? info.releaseNotes.map((n) => n.note ?? '').join('\n')
    : (info.releaseNotes ?? '');
  const text = raw
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 600 ? `${text.slice(0, 597)}…` : text;
}

async function askToDownload(info: UpdateInfo) {
  const n = notes(info);
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'ShotKit update available',
    message: `ShotKit ${info.version} is available`,
    detail: `You have version ${app.getVersion()}.${n ? `\n\nWhat's new:\n${n}` : ''}\n\nDownload it now?`,
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) downloadUpdate();
}

function announce(info: UpdateInfo) {
  announced.add(info.version);
  toast = notify('ShotKit update available', `Version ${info.version} is available. Click to download it.`, () =>
    askToDownload(info),
  );
}

function scheduleCheck(ms: number) {
  clearTimeout(nextCheck);
  nextCheck = setTimeout(() => checkForUpdates(), ms);
}

async function askToRestart(version: string) {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'ShotKit update ready',
    message: `ShotKit ${version} has been downloaded`,
    detail: 'Restart ShotKit now to finish updating? If you choose Later, the update installs the next time you quit.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) installUpdate();
}

export function downloadUpdate() {
  if (state.status !== 'available') return;
  setState({ status: 'downloading', version: state.version, percent: 0 });
  autoUpdater.downloadUpdate().catch(() => {
    // Reported through the 'error' event.
  });
}

export function installUpdate() {
  if (state.status !== 'ready') return;
  // Silent install, then relaunch ShotKit.
  autoUpdater.quitAndInstall(true, true);
}

export async function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) notify('Updates', 'Update checks only work in the installed app.');
    return;
  }
  if (state.status === 'checking' || state.status === 'downloading') return;
  if (state.status === 'ready') {
    if (manual) askToRestart(state.version);
    return;
  }
  manualCheck = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // Reported through the 'error' event.
  }
}

export function initUpdater(changed: () => void) {
  onChange = changed;
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => {
    setState({ status: 'idle' });
    scheduleCheck(CHECK_INTERVAL_MS);
    if (manualCheck) notify('ShotKit is up to date', `You have the latest version (${app.getVersion()}).`);
  });
  autoUpdater.on('update-available', (info) => {
    setState({ status: 'available', version: info.version });
    scheduleCheck(CHECK_INTERVAL_MS);
    if (manualCheck) askToDownload(info);
    else if (!announced.has(info.version)) announce(info);
  });
  autoUpdater.on('download-progress', (p) => {
    if (state.status === 'downloading') setState({ ...state, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'ready', version: info.version });
    notify('ShotKit update ready', `Version ${info.version} will install when you restart ShotKit.`);
    askToRestart(info.version);
  });
  autoUpdater.on('error', (e) => {
    const wasDownloading = state.status === 'downloading';
    setState({ status: 'error', message: errorMessage(e) });
    if (manualCheck || wasDownloading) notify('Update failed', errorMessage(e));
    scheduleCheck(manualCheck || wasDownloading ? CHECK_INTERVAL_MS : RETRY_DELAY_MS);
  });

  // Give startup a moment, then keep checking (each check schedules the next one). Timers don't
  // run while the PC sleeps, so also check shortly after it wakes up.
  scheduleCheck(STARTUP_DELAY_MS);
  powerMonitor.on('resume', () => scheduleCheck(STARTUP_DELAY_MS));
}

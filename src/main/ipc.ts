import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { finishSelection, overlayReady, Selection } from './capture';
import {
  clearHistory,
  deleteItem,
  exportToFolder,
  getItem,
  historyDir,
  listHistory,
  savedPathFor,
  thumbDataUrl,
  thumbPath,
  timestampName,
  updateItem,
} from './history';
import { failedHotkeys, registerHotkeys, unregisterHotkeys } from './hotkeys';
import { ocrToClipboard, recognizeWords } from './ocr';
import { requestScrollStop } from './scrolling';
import { getSettings, Settings, updateSettings } from './settings';
import {
  editImage,
  editorFile,
  notifyHistoryChanged,
  openEditor,
  openPin,
  pinImage,
  resizeQuickAccess,
  zoomPin,
} from './windows';
import { clamp, notify } from './util';

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
};

/** Actions shared by the Quick Access overlay and the History window. */
async function itemAction(id: string, action: string) {
  const it = getItem(id);
  if (!it) return { ok: false };
  switch (action) {
    case 'copy':
      clipboard.writeImage(nativeImage.createFromPath(it.path));
      break;
    case 'save': {
      const p = exportToFolder(it);
      notify('Screenshot saved', p, () => shell.showItemInFolder(p));
      break;
    }
    case 'edit':
      openEditor(it.path);
      break;
    case 'pin':
      openPin(nativeImage.createFromPath(it.path));
      break;
    case 'ocr':
      await ocrToClipboard(nativeImage.createFromPath(it.path));
      break;
    case 'folder': {
      const saved = savedPathFor(it);
      shell.showItemInFolder(fs.existsSync(saved) ? saved : it.path);
      break;
    }
    case 'delete':
      deleteItem(id);
      notifyHistoryChanged();
      break;
  }
  return { ok: true };
}

export function registerIpc() {
  // Capture overlay -------------------------------------------------------------------------
  ipcMain.on('overlay:ready', (e) => overlayReady(e.sender));
  ipcMain.on('overlay:result', (_e, sel: Selection | null) => finishSelection(sel));

  // Quick Access ----------------------------------------------------------------------------
  ipcMain.on('qa:resize', (_e, height: number) => resizeQuickAccess(height));
  ipcMain.on('qa:drag', (e, id: string) => {
    const it = getItem(id);
    if (!it) return;
    let icon = nativeImage.createFromPath(thumbPath(id));
    icon = icon.isEmpty() ? nativeImage.createFromPath(it.path).resize({ width: 96 }) : icon.resize({ width: 96 });
    e.sender.startDrag({ file: it.path, icon });
  });
  ipcMain.handle('qa:action', (_e, id: string, action: string) => itemAction(id, action));

  // History ---------------------------------------------------------------------------------
  ipcMain.handle('history:list', () => listHistory().map((it) => ({ ...it, thumb: thumbDataUrl(it) })));
  ipcMain.handle('history:action', (_e, id: string, action: string) => itemAction(id, action));
  ipcMain.handle('history:clear', () => {
    clearHistory();
    notifyHistoryChanged();
  });
  ipcMain.handle('history:openFolder', () => {
    fs.mkdirSync(getSettings().saveFolder, { recursive: true });
    return shell.openPath(getSettings().saveFolder);
  });

  // Editor ----------------------------------------------------------------------------------
  ipcMain.handle('editor:load', (e) => {
    const file = editorFile(e.sender.id);
    if (!file) throw new Error('No image for this editor window');
    const mime = MIME[path.extname(file).toLowerCase()] ?? 'image/png';
    return {
      name: path.basename(file),
      dataUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`,
      scale: screen.getPrimaryDisplay().scaleFactor,
    };
  });

  ipcMain.handle('editor:words', async (e) => {
    const file = editorFile(e.sender.id);
    if (!file) return [];
    try {
      return await recognizeWords(nativeImage.createFromPath(file));
    } catch (err) {
      console.warn('Word detection failed:', err);
      return [];
    }
  });

  ipcMain.handle('editor:export',async (e, action: string, bytes: Uint8Array) => {
    const png = Buffer.from(bytes);
    const img = nativeImage.createFromBuffer(png);
    const src = editorFile(e.sender.id);
    const win = BrowserWindow.fromWebContents(e.sender);
    const s = getSettings();
    const inHistory = !!src && path.resolve(path.dirname(src)) === path.resolve(historyDir());
    const base = src ? path.parse(src).name + (inHistory ? '' : ' (edited)') : timestampName();

    switch (action) {
      case 'copy':
        clipboard.writeImage(img);
        return { ok: true, message: 'Copied to clipboard' };
      case 'save': {
        fs.mkdirSync(s.saveFolder, { recursive: true });
        const target = path.join(s.saveFolder, `${base}.${s.format}`);
        fs.writeFileSync(target, s.format === 'jpg' ? img.toJPEG(92) : png);
        if (inHistory && src) {
          updateItem(path.basename(src), png);
          notifyHistoryChanged();
        }
        return { ok: true, message: `Saved to ${target}` };
      }
      case 'saveAs': {
        const opts = {
          defaultPath: path.join(s.saveFolder, `${base}.png`),
          filters: [
            { name: 'PNG image', extensions: ['png'] },
            { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
          ],
        };
        const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
        if (r.canceled || !r.filePath) return { ok: false };
        const jpg = /\.jpe?g$/i.test(r.filePath);
        fs.writeFileSync(r.filePath, jpg ? img.toJPEG(92) : png);
        return { ok: true, message: `Saved to ${r.filePath}` };
      }
      case 'pin':
        openPin(img);
        return { ok: true };
    }
    return { ok: false };
  });

  // Pinned screenshots ----------------------------------------------------------------------
  const pinWin = (e: Electron.IpcMainEvent) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('pin:load', (e) => pinImage(e.sender.id)?.toDataURL());
  ipcMain.on('pin:move', (e, x: number, y: number) => pinWin(e)?.setPosition(Math.round(x), Math.round(y)));
  ipcMain.on('pin:zoom', (e, factor: number) => {
    const w = pinWin(e);
    if (w) zoomPin(w, factor);
  });
  ipcMain.on('pin:opacity', (e, v: number) => pinWin(e)?.setOpacity(clamp(v, 0.2, 1)));
  ipcMain.on('pin:close', (e) => pinWin(e)?.close());
  ipcMain.on('pin:copy', (e) => {
    const img = pinImage(e.sender.id);
    if (img) clipboard.writeImage(img);
  });
  ipcMain.on('pin:edit', (e) => {
    const img = pinImage(e.sender.id);
    if (img) editImage(img);
  });

  // Settings --------------------------------------------------------------------------------
  ipcMain.handle('settings:get', () => ({ settings: getSettings(), failed: failedHotkeys() }));
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const settings = updateSettings(patch);
    return { settings, failed: failedHotkeys() };
  });
  ipcMain.handle('settings:browse', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getSettings().saveFolder,
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.on('hotkeys:suspend', (_e, suspend: boolean) => {
    if (suspend) unregisterHotkeys();
    else registerHotkeys();
  });

  // Scrolling capture -----------------------------------------------------------------------
  ipcMain.on('scroll:stop', () => requestScrollStop('done'));
  ipcMain.on('scroll:cancel', () => requestScrollStop('cancel'));
}

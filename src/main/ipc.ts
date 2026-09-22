import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { finishSelection, overlayReady, Selection } from './capture';
import {
  clearHistory,
  deleteItem,
  encode,
  exportToFolder,
  getItem,
  historyIdOf,
  listHistory,
  loadForEditing,
  readMeta,
  savedNameFor,
  savedPathFor,
  saveEdits,
  thumbDataUrl,
  thumbPath,
  timestampName,
} from './history';
import { failedHotkeys, registerHotkeys, unregisterHotkeys } from './hotkeys';
import { ocrToClipboard, recognizeWords } from './ocr';
import { requestScrollStop } from './scrolling';
import { getSettings, Settings, updateSettings } from './settings';
import { uploadAndCopy, uploadConfigured } from './upload';
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
import { clamp, errorMessage, notify } from './util';

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
      try {
        const p = await exportToFolder(it);
        notify('Screenshot saved', p, () => shell.showItemInFolder(p));
      } catch (e) {
        notify('Could not save screenshot', errorMessage(e));
      }
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
    case 'upload':
      return { ok: !!(await uploadAndCopy(fs.readFileSync(it.path), `${path.basename(savedNameFor(it))}.png`)) };
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

/** The file to drag out of Quick Access, in the format chosen in Settings. */
function dragFile(id: string): string | null {
  const it = getItem(id);
  if (!it) return null;
  if (getSettings().dragFormat !== 'jpg') return it.path;
  const dir = path.join(app.getPath('temp'), 'shotkit', 'drag');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${path.basename(savedNameFor(it))}.jpg`);
  fs.writeFileSync(file, nativeImage.createFromPath(it.path).toJPEG(getSettings().jpgQuality || 92));
  return file;
}

/**
 * The file name (without extension, possibly with template folders) for an editor's result.
 * Also stores the annotations, so whatever the user does with the result, the capture in
 * history stays editable.
 */
function editorExportBase(senderId: number, png: Buffer, docJson?: string): string {
  const src = editorFile(senderId);
  const historyId = src ? historyIdOf(src) : null;
  const item = historyId ? getItem(historyId) : null;
  if (historyId && docJson) {
    try {
      saveEdits(historyId, png, docJson);
      notifyHistoryChanged();
    } catch (err) {
      console.warn('Could not store edits:', err);
    }
  }
  // History captures save under their template name; other files next to "<name> (edited)".
  return item ? savedNameFor(item) : src ? `${path.parse(src).name} (edited)` : timestampName();
}

export function registerIpc() {
  // Capture overlay -------------------------------------------------------------------------
  ipcMain.on('overlay:ready', (e) => overlayReady(e.sender));
  ipcMain.on('overlay:result', (_e, sel: Selection | null) => finishSelection(sel));

  // Quick Access ----------------------------------------------------------------------------
  ipcMain.on('qa:resize', (_e, height: number) => resizeQuickAccess(height));
  ipcMain.on('qa:drag', (e, id: string) => {
    const file = dragFile(id);
    if (!file) return;
    let icon = nativeImage.createFromPath(thumbPath(id));
    icon = icon.isEmpty() ? nativeImage.createFromPath(file).resize({ width: 96 }) : icon.resize({ width: 96 });
    e.sender.startDrag({ file, icon });
  });
  ipcMain.handle('qa:action', (_e, id: string, action: string) => itemAction(id, action));

  // History ---------------------------------------------------------------------------------
  ipcMain.handle('history:list', () => ({
    canUpload: uploadConfigured(),
    items: listHistory().map((it) => {
      const m = readMeta(it.id);
      return { ...it, thumb: thumbDataUrl(it), name: savedNameFor(it), app: m.app, title: m.title, text: m.text };
    }),
  }));
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
    const { base, doc } = loadForEditing(file);
    const mime = MIME[path.extname(base).toLowerCase()] ?? 'image/png';
    return {
      name: path.basename(file),
      dataUrl: `data:${mime};base64,${fs.readFileSync(base).toString('base64')}`,
      scale: screen.getPrimaryDisplay().scaleFactor,
      doc,
    };
  });

  ipcMain.handle('editor:words', async (e) => {
    const file = editorFile(e.sender.id);
    if (!file) return [];
    try {
      // Word positions must match the image the editor shows: the original, if it was edited before.
      return await recognizeWords(nativeImage.createFromPath(loadForEditing(file).base));
    } catch (err) {
      console.warn('Word detection failed:', err);
      return [];
    }
  });

  ipcMain.handle(
    'editor:export',
    async (e, action: string, bytes: Uint8Array, docJson?: string, extra?: { webp?: Uint8Array | null }) => {
      const png = Buffer.from(bytes);
      const img = nativeImage.createFromBuffer(png);
      const webp = extra?.webp ? Buffer.from(extra.webp) : null;
      const win = BrowserWindow.fromWebContents(e.sender);
      const s = getSettings();
      const base = editorExportBase(e.sender.id, png, docJson);

      const bytesFor = async (format: 'png' | 'jpg' | 'webp') =>
        format === 'webp' && webp ? webp : format === 'png' ? png : encode(img, format);

      try {
        switch (action) {
          case 'copy':
            clipboard.writeImage(img);
            return { ok: true, message: 'Copied to clipboard' };
          case 'save': {
            const target = path.join(s.saveFolder, `${base}.${s.format}`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, await bytesFor(s.format));
            return { ok: true, message: `Saved to ${target}` };
          }
          case 'saveAs': {
            const opts = {
              defaultPath: path.join(s.saveFolder, `${path.basename(base)}.png`),
              filters: [
                { name: 'PNG image', extensions: ['png'] },
                { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
                { name: 'WebP image (smaller)', extensions: ['webp'] },
              ],
            };
            const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
            if (r.canceled || !r.filePath) return { ok: false };
            const format = /\.jpe?g$/i.test(r.filePath) ? 'jpg' : /\.webp$/i.test(r.filePath) ? 'webp' : 'png';
            fs.writeFileSync(r.filePath, await bytesFor(format));
            return { ok: true, message: `Saved to ${r.filePath}` };
          }
          case 'upload': {
            const link = await uploadAndCopy(png, `${path.basename(base)}.png`);
            return { ok: !!link, message: link ? 'Link copied to the clipboard' : 'Upload failed' };
          }
          case 'pin':
            openPin(img);
            return { ok: true };
        }
      } catch (err) {
        return { ok: false, message: `Failed: ${errorMessage(err)}` };
      }
      return { ok: false };
    },
  );

  // "Drag me": the edited image, written to a temp file in the drag format, dragged out as a file.
  ipcMain.on('editor:drag', (e, bytes: Uint8Array, docJson?: string) => {
    const png = Buffer.from(bytes);
    const img = nativeImage.createFromBuffer(png);
    if (img.isEmpty()) return;
    const jpg = getSettings().dragFormat === 'jpg';
    const dir = path.join(app.getPath('temp'), 'shotkit', 'drag');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${path.basename(editorExportBase(e.sender.id, png, docJson))}.${jpg ? 'jpg' : 'png'}`);
    fs.writeFileSync(file, jpg ? img.toJPEG(getSettings().jpgQuality || 92) : png);
    const { width, height } = img.getSize();
    const icon = width >= height ? img.resize({ width: Math.min(width, 128) }) : img.resize({ height: Math.min(height, 128) });
    e.sender.startDrag({ file, icon });
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

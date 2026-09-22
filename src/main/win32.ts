// Thin Win32 bindings (via koffi FFI) for things Electron doesn't expose:
// enumerating top-level windows, synthesizing mouse-wheel input, and toggling desktop icons.
import koffi from 'koffi';

export interface WinInfo {
  hwnd: number;
  title: string;
  /** Physical screen pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_LAYERED = 0x80000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const MOUSEEVENTF_WHEEL = 0x0800;
const SW_HIDE = 0;
const SW_SHOW = 5;

type Fn = (...args: any[]) => any;
let api: Record<string, Fn> | null = null;

function load(): Record<string, Fn> {
  if (api) return api;
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  koffi.proto('bool EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
  api = {
    EnumWindows: user32.func('bool __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hWnd)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, void *lpString, int nMaxCount)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hWnd, void *lpClassName, int nMaxCount)'),
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int nIndex)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, void *lpRect)'),
    SetCursorPos: user32.func('bool __stdcall SetCursorPos(int X, int Y)'),
    mouse_event: user32.func(
      'void __stdcall mouse_event(uint32_t dwFlags, uint32_t dx, uint32_t dy, int32_t dwData, uintptr_t dwExtraInfo)',
    ),
    FindWindowW: user32.func('intptr_t __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)'),
    FindWindowExW: user32.func(
      'intptr_t __stdcall FindWindowExW(intptr_t hWndParent, intptr_t hWndChildAfter, str16 lpszClass, str16 lpszWindow)',
    ),
    ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)'),
    DwmGetWindowAttribute: dwmapi.func(
      'long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, void *pvAttribute, uint32_t cbAttribute)',
    ),
  };
  return api;
}

function className(w: Record<string, Fn>, hwnd: number, buf: Buffer): string {
  const n = w.GetClassNameW(hwnd, buf, buf.length / 2);
  return buf.toString('utf16le', 0, n * 2);
}

/** Visible top-level windows in z-order (topmost first). */
export function listWindows(exclude: Set<number> = new Set()): WinInfo[] {
  const w = load();
  const out: WinInfo[] = [];
  const rect = Buffer.alloc(16);
  const text = Buffer.alloc(1024);
  const cls = Buffer.alloc(512);
  const cloak = Buffer.alloc(4);

  w.EnumWindows((raw: number | bigint) => {
    const hwnd = Number(raw);
    try {
      if (exclude.has(hwnd) || !w.IsWindowVisible(hwnd) || w.IsIconic(hwnd)) return true;
      const ex = Number(w.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
      if (ex & WS_EX_TOOLWINDOW) return true;
      if (ex & WS_EX_LAYERED && ex & WS_EX_TRANSPARENT) return true;
      if (w.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloak, 4) === 0 && cloak.readUInt32LE(0) !== 0) return true;
      const klass = className(w, hwnd, cls);
      if (klass === 'Progman' || klass === 'WorkerW') return true;
      const len = w.GetWindowTextW(hwnd, text, text.length / 2);
      const title = text.toString('utf16le', 0, len * 2);
      if (!title && klass !== 'Shell_TrayWnd') return true;

      let ok = w.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) === 0;
      if (!ok) ok = w.GetWindowRect(hwnd, rect);
      if (!ok) return true;
      const l = rect.readInt32LE(0), t = rect.readInt32LE(4), r = rect.readInt32LE(8), b = rect.readInt32LE(12);
      if (r - l < 20 || b - t < 20) return true;
      out.push({ hwnd, title: title || 'Taskbar', x: l, y: t, width: r - l, height: b - t });
    } catch {
      // Ignore windows we can't inspect.
    }
    return true;
  }, 0);
  return out;
}

export function setCursorPos(x: number, y: number) {
  load().SetCursorPos(Math.round(x), Math.round(y));
}

/** Negative delta scrolls down (120 = one wheel notch). */
export function scrollWheel(delta: number) {
  load().mouse_event(MOUSEEVENTF_WHEEL, 0, 0, delta, 0);
}

function desktopListView(): number {
  const w = load();
  let defView = Number(w.FindWindowExW(Number(w.FindWindowW('Progman', null)), 0, 'SHELLDLL_DefView', null));
  if (!defView) {
    // With a wallpaper slideshow / some Windows builds the icons live under a WorkerW window.
    const cls = Buffer.alloc(512);
    w.EnumWindows((raw: number | bigint) => {
      const hwnd = Number(raw);
      if (className(w, hwnd, cls) !== 'WorkerW') return true;
      const dv = Number(w.FindWindowExW(hwnd, 0, 'SHELLDLL_DefView', null));
      if (dv) {
        defView = dv;
        return false;
      }
      return true;
    }, 0);
  }
  if (!defView) return 0;
  return Number(w.FindWindowExW(defView, 0, 'SysListView32', null));
}

export function desktopIconsVisible(): boolean {
  const lv = desktopListView();
  return lv ? load().IsWindowVisible(lv) : true;
}

export function setDesktopIconsVisible(visible: boolean) {
  const lv = desktopListView();
  if (lv) load().ShowWindow(lv, visible ? SW_SHOW : SW_HIDE);
}

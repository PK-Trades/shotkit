// Thin Win32 bindings (via koffi FFI) for things Electron doesn't expose: enumerating top-level
// windows, the app in front, synthesizing mouse-wheel input, and toggling desktop icons.
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
  const gdi32 = koffi.load('gdi32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const kernel32 = koffi.load('kernel32.dll');
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
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    GetWindowThreadProcessId: user32.func(
      'uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, void *lpdwProcessId)',
    ),
    OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
    QueryFullProcessImageNameW: kernel32.func(
      'bool __stdcall QueryFullProcessImageNameW(intptr_t hProcess, uint32_t flags, void *lpExeName, void *lpdwSize)',
    ),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t h)'),
    GetDC: user32.func('intptr_t __stdcall GetDC(intptr_t hWnd)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(intptr_t hWnd, intptr_t hDC)'),
    CreateCompatibleDC: gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t hdc)'),
    CreateCompatibleBitmap: gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t hdc, int cx, int cy)'),
    SelectObject: gdi32.func('intptr_t __stdcall SelectObject(intptr_t hdc, intptr_t h)'),
    BitBlt: gdi32.func(
      'bool __stdcall BitBlt(intptr_t hdc, int x, int y, int cx, int cy, intptr_t hdcSrc, int x1, int y1, uint32_t rop)',
    ),
    GetDIBits: gdi32.func(
      'int __stdcall GetDIBits(intptr_t hdc, intptr_t hbm, uint32_t start, uint32_t cLines, void *lpvBits, void *lpbmi, uint32_t usage)',
    ),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr_t ho)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(intptr_t hdc)'),
  };
  return api;
}

const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;

/**
 * BGRA pixels of a rectangle of the desktop (physical pixels), read through GDI. Unlike
 * desktopCapturer, GDI gets the desktop as SDR, so colours stay true when HDR is on.
 */
export function captureScreen(x: number, y: number, width: number, height: number): Buffer {
  const w = load();
  const screenDC = Number(w.GetDC(0));
  if (!screenDC) throw new Error('GetDC failed');
  const memDC = Number(w.CreateCompatibleDC(screenDC));
  const bmp = Number(w.CreateCompatibleBitmap(screenDC, width, height));
  try {
    if (!memDC || !bmp) throw new Error('Could not create a capture bitmap');
    const old = w.SelectObject(memDC, bmp);
    const copied = w.BitBlt(memDC, 0, 0, width, height, screenDC, x, y, SRCCOPY | CAPTUREBLT);
    // GetDIBits needs the bitmap deselected.
    w.SelectObject(memDC, old);
    if (!copied) throw new Error('BitBlt failed');
    // BITMAPINFOHEADER: 32 bits per pixel, negative height for top-down rows.
    const info = Buffer.alloc(40);
    info.writeUInt32LE(40, 0);
    info.writeInt32LE(width, 4);
    info.writeInt32LE(-height, 8);
    info.writeUInt16LE(1, 12);
    info.writeUInt16LE(32, 14);
    const pixels = Buffer.alloc(width * height * 4);
    if (w.GetDIBits(memDC, bmp, 0, height, pixels, info, 0) !== height) throw new Error('GetDIBits failed');
    // GDI leaves the alpha byte at 0: make every pixel opaque.
    const px = new Uint32Array(pixels.buffer, pixels.byteOffset, width * height);
    for (let i = 0; i < px.length; i++) px[i] |= 0xff000000;
    return pixels;
  } finally {
    if (bmp) w.DeleteObject(bmp);
    if (memDC) w.DeleteDC(memDC);
    w.ReleaseDC(0, screenDC);
  }
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

/** The app (executable name, e.g. "Chrome") and title of the window in front, if any. */
export function foregroundWindow(): { app: string; title: string } | null {
  const w = load();
  const hwnd = Number(w.GetForegroundWindow());
  if (!hwnd) return null;
  const text = Buffer.alloc(1024);
  const len = w.GetWindowTextW(hwnd, text, text.length / 2);
  const title = text.toString('utf16le', 0, len * 2);
  let app = '';
  const pidBuf = Buffer.alloc(4);
  w.GetWindowThreadProcessId(hwnd, pidBuf);
  const proc = Number(w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pidBuf.readUInt32LE(0)));
  if (proc) {
    try {
      const name = Buffer.alloc(1040);
      const size = Buffer.alloc(4);
      size.writeUInt32LE(520, 0);
      if (w.QueryFullProcessImageNameW(proc, 0, name, size)) {
        const full = name.toString('utf16le', 0, size.readUInt32LE(0) * 2);
        const exe = full.split('\\').pop()!.replace(/\.exe$/i, '');
        app = exe.charAt(0).toUpperCase() + exe.slice(1);
      }
    } finally {
      w.CloseHandle(proc);
    }
  }
  return { app, title };
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

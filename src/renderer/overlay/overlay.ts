// Full-screen capture overlay: shows a frozen screenshot of one display (or nothing, for a live
// selection) and lets the user drag out an area, pick a window, pick a colour or measure.
// All drawing happens in physical pixels.
export {};

interface WinRect {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

type Mode = 'area' | 'window' | 'scrolling' | 'ocr' | 'record' | 'color' | 'measure';

interface InitData {
  displayId: number;
  mode: Mode;
  width: number;
  height: number;
  /** BGRA pixels of the frozen screen, or null for a live selection. */
  pixels: Uint8Array | null;
  windows: WinRect[];
  cursor: { x: number; y: number };
  magnifier: boolean;
}

interface Pt {
  x: number;
  y: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hint = document.getElementById('hint') as HTMLDivElement;

const HINTS: Record<string, string> = {
  area: 'Drag to capture an area  ·  Space: window mode  ·  Esc: cancel',
  window: 'Click a window to capture it  ·  Space: area mode  ·  Esc: cancel',
  scrolling: 'Select the area to scroll-capture  ·  Esc: cancel',
  ocr: 'Select an area to copy its text  ·  Esc: cancel',
  record: 'Drag an area to record  ·  Click: whole screen  ·  Space: window  ·  Esc: cancel',
  recordWindow: 'Click a window to record it  ·  Space: area mode  ·  Esc: cancel',
  color: 'Click to copy a colour  ·  Esc: cancel',
  measure: 'Drag to measure  ·  Esc: close',
};

let data: InitData | null = null;
let shot: ImageBitmap | null = null;
let rgba: Uint8ClampedArray | null = null;
let mouse: Pt | null = null; // CSS px
let start: Pt | null = null;
let dragging = false;
let shiftKey = false;
let windowMode = false;
let hovered: WinRect | null = null;
/** Ruler mode: the last measurement stays on screen. */
let measured: Box | null = null;
let done = false;
let frame = 0;

function bgraToRgba(px: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(px.length);
  if (px.byteOffset % 4 === 0) {
    const src = new Uint32Array(px.buffer, px.byteOffset, px.length >> 2);
    const dst = new Uint32Array(out.buffer);
    for (let i = 0; i < src.length; i++) {
      const p = src[i];
      dst[i] = 0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >> 16) & 0xff);
    }
  } else {
    for (let i = 0; i < px.length; i += 4) {
      out[i] = px[i + 2];
      out[i + 1] = px[i + 1];
      out[i + 2] = px[i];
      out[i + 3] = 255;
    }
  }
  return out;
}

window.api.on('overlay:init', async (d: InitData) => {
  data = d;
  done = false;
  dragging = false;
  start = null;
  measured = null;
  windowMode = d.mode === 'window';
  const inside = d.cursor.x >= 0 && d.cursor.y >= 0 && d.cursor.x < innerWidth && d.cursor.y < innerHeight;
  mouse = inside ? d.cursor : null;

  shot?.close();
  shot = null;
  rgba = null;
  if (d.pixels) {
    rgba = bgraToRgba(d.pixels);
    shot = await createImageBitmap(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, d.width, d.height));
  }
  canvas.width = d.width;
  canvas.height = d.height;
  document.body.classList.toggle('live', !shot);
  hovered = windowMode && mouse ? windowAt(mouse) : null;
  updateHint();
  draw();
  window.api.send('overlay:ready');
});

window.api.on('overlay:reset', () => {
  shot?.close();
  shot = null;
  rgba = null;
  data = null;
  hint.hidden = true;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});

function updateHint() {
  if (!data) return;
  const key =
    data.mode === 'record' && windowMode ? 'recordWindow' : windowMode && data.mode === 'area' ? 'window' : data.mode;
  hint.textContent = HINTS[key] ?? '';
  hint.hidden = dragging;
}

const scale = () => canvas.width / innerWidth;
const canPickWindows = () => data?.mode === 'area' || data?.mode === 'window' || data?.mode === 'record';

function windowAt(p: Pt): WinRect | null {
  return data?.windows.find((w) => p.x >= w.x && p.x < w.x + w.width && p.y >= w.y && p.y < w.y + w.height) ?? null;
}

function clipToView(r: Box): Box {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return {
    x,
    y,
    width: Math.min(innerWidth, r.x + r.width) - x,
    height: Math.min(innerHeight, r.y + r.height) - y,
  };
}

function selectionRect(): Box | null {
  if (!start || !mouse || !dragging) return null;
  let w = mouse.x - start.x;
  let h = mouse.y - start.y;
  if (shiftKey) {
    const m = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * m;
    h = Math.sign(h || 1) * m;
  }
  return clipToView({
    x: Math.min(start.x, start.x + w),
    y: Math.min(start.y, start.y + h),
    width: Math.abs(w),
    height: Math.abs(h),
  });
}

function pill(text: string, x: number, y: number, s: number, anchor: 'left' | 'center' = 'left', swatch?: string) {
  ctx.font = `600 ${12 * s}px "Segoe UI", system-ui, sans-serif`;
  const tw = ctx.measureText(text).width;
  const padX = 8 * s;
  const sw = swatch ? 16 * s : 0;
  const h = 22 * s;
  const w = tw + padX * 2 + sw;
  let px = anchor === 'center' ? x - w / 2 : x;
  px = Math.max(4 * s, Math.min(canvas.width - w - 4 * s, px));
  const py = Math.max(4 * s, Math.min(canvas.height - h - 4 * s, y));
  ctx.fillStyle = 'rgba(15,15,18,0.85)';
  ctx.beginPath();
  ctx.roundRect(px, py, w, h, 6 * s);
  ctx.fill();
  if (swatch) {
    ctx.fillStyle = swatch;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = s;
    ctx.beginPath();
    ctx.roundRect(px + padX, py + 5 * s, 12 * s, 12 * s, 3 * s);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, px + padX + sw, py + h / 2 + 0.5 * s);
}

/** Dims everything outside the box. The box keeps a trace of alpha so it still takes clicks. */
function dimOutside(x: number, y: number, w: number, h: number, alpha: number) {
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  ctx.fillRect(0, 0, canvas.width, y);
  ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, canvas.width - x - w, h);
  if (!shot) {
    ctx.fillStyle = 'rgba(0,0,0,0.01)';
    ctx.fillRect(x, y, w, h);
  }
}

function colorAt(cx: number, cy: number): string | null {
  if (!rgba || !data || cx < 0 || cy < 0 || cx >= data.width || cy >= data.height) return null;
  const i = (cy * data.width + cx) * 4;
  return `#${[rgba[i], rgba[i + 1], rgba[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function drawMagnifier(m: Pt, s: number) {
  if (!shot || !data) return;
  const cells = 15;
  const size = 132 * s;
  const cell = size / cells;
  const cx = Math.floor(m.x * s);
  const cy = Math.floor(m.y * s);
  let x = cx + 26 * s;
  let y = cy + 26 * s;
  if (x + size > canvas.width) x = cx - 26 * s - size;
  if (y + size + 34 * s > canvas.height) y = cy - 26 * s - size - 34 * s;

  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, size, size);
  ctx.imageSmoothingEnabled = false;
  const half = Math.floor(cells / 2);
  ctx.drawImage(shot, cx - half, cy - half, cells, cells, x, y, size, size);
  ctx.strokeStyle = 'rgba(79,140,255,0.55)';
  ctx.lineWidth = cell;
  ctx.beginPath();
  ctx.moveTo(x, y + size / 2);
  ctx.lineTo(x + half * cell, y + size / 2);
  ctx.moveTo(x + (half + 1) * cell, y + size / 2);
  ctx.lineTo(x + size, y + size / 2);
  ctx.moveTo(x + size / 2, y);
  ctx.lineTo(x + size / 2, y + half * cell);
  ctx.moveTo(x + size / 2, y + (half + 1) * cell);
  ctx.lineTo(x + size / 2, y + size);
  ctx.globalAlpha = 0.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5 * s;
  ctx.strokeRect(x + half * cell, y + half * cell, cell, cell);
  ctx.restore();
  ctx.lineWidth = 3 * s;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  if (data.mode === 'color') {
    const c = colorAt(cx, cy);
    if (c) pill(c.toUpperCase(), x + size / 2, y + size + 8 * s, s, 'center', c);
  } else pill(`${cx}, ${cy}`, x + size / 2, y + size + 8 * s, s, 'center');
}

/** A measurement: the box, its size, and its diagonal. */
function drawMeasure(r: Box, s: number) {
  const x = r.x * s,
    y = r.y * s,
    w = r.width * s,
    h = r.height * s;
  ctx.fillStyle = 'rgba(255,45,149,0.12)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#ff2d95';
  ctx.lineWidth = Math.max(1, s);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.setLineDash([4 * s, 4 * s]);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y + h);
  ctx.stroke();
  ctx.setLineDash([]);
  const diag = Math.hypot(w, h);
  const label = `${Math.round(w)} × ${Math.round(h)} px  ·  ${Math.round(diag)} px diagonal`;
  const below = y + h + 8 * s + 22 * s < canvas.height;
  pill(label, x + w / 2, below ? y + h + 8 * s : y - 30 * s, s, 'center');
}

function draw() {
  if (!data) return;
  const s = scale();
  ctx.imageSmoothingEnabled = true;
  if (shot) ctx.drawImage(shot, 0, 0);
  else ctx.clearRect(0, 0, canvas.width, canvas.height);

  const sel = selectionRect();
  if (data.mode === 'measure') {
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const r = sel ?? measured;
    if (r) drawMeasure(r, s);
  } else if (sel) {
    const x = sel.x * s,
      y = sel.y * s,
      w = sel.width * s,
      h = sel.height * s;
    dimOutside(x, y, w, h, 0.45);
    ctx.strokeStyle = data.mode === 'record' ? '#ff453a' : '#fff';
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    const label = `${Math.round(w)} × ${Math.round(h)}`;
    const below = y + h + 8 * s + 22 * s < canvas.height;
    pill(label, x + w / 2, below ? y + h + 8 * s : y + h - 30 * s, s, 'center');
  } else if (windowMode && hovered) {
    const r = clipToView(hovered);
    const x = r.x * s,
      y = r.y * s,
      w = r.width * s,
      h = r.height * s;
    dimOutside(x, y, w, h, 0.45);
    ctx.fillStyle = 'rgba(79,140,255,0.16)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#4f8cff';
    ctx.lineWidth = 3 * s;
    ctx.strokeRect(x + 1.5 * s, y + 1.5 * s, w - 3 * s, h - 3 * s);
    const title = hovered.title.length > 60 ? `${hovered.title.slice(0, 57)}…` : hovered.title;
    pill(`${title}  ·  ${Math.round(w)} × ${Math.round(h)}`, x + w / 2, y + h / 2 - 11 * s, s, 'center');
  } else {
    ctx.fillStyle = data.mode === 'color' ? 'rgba(0,0,0,0.04)' : 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  if (!windowMode && mouse && !dragging && data.mode !== 'color') {
    const x = Math.floor(mouse.x * s) + 0.5;
    const y = Math.floor(mouse.y * s) + 0.5;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.moveTo(0, y + 1);
    ctx.lineTo(canvas.width, y + 1);
    ctx.moveTo(x + 1, 0);
    ctx.lineTo(x + 1, canvas.height);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  if (!windowMode && mouse && data.magnifier) drawMagnifier(mouse, s);
}

function schedule() {
  if (!frame)
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
}

function finish(result: { rect: Box; window?: boolean; title?: string; color?: string }) {
  if (done || !data) return;
  done = true;
  window.api.send('overlay:result', { displayId: data.displayId, ...result });
}

function cancel() {
  if (done) return;
  done = true;
  window.api.send('overlay:result', null);
}

window.addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  shiftKey = e.shiftKey;
  if (start && !dragging && Math.hypot(mouse.x - start.x, mouse.y - start.y) > 3) {
    dragging = true;
    updateHint();
  }
  if (windowMode) hovered = windowAt(mouse);
  schedule();
});

window.addEventListener('mousedown', (e) => {
  if (e.button === 2) {
    cancel();
    return;
  }
  if (e.button !== 0 || windowMode || !data) return;
  if (data.mode === 'color') {
    const s = scale();
    const c = colorAt(Math.floor(e.clientX * s), Math.floor(e.clientY * s));
    if (c) finish({ rect: { x: e.clientX, y: e.clientY, width: 1, height: 1 }, color: c });
    return;
  }
  start = { x: e.clientX, y: e.clientY };
  dragging = false;
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || done || !data) return;
  if (windowMode) {
    if (hovered) finish({ rect: clipToView(hovered), window: true, title: hovered.title });
    return;
  }
  const r = selectionRect();
  const wasDrag = dragging;
  start = null;
  dragging = false;
  if (data.mode === 'measure') {
    if (r) measured = r;
    updateHint();
    schedule();
    return;
  }
  if (r && r.width >= 2 && r.height >= 2) finish({ rect: r });
  else if (data.mode === 'record' && !wasDrag) finish({ rect: { x: 0, y: 0, width: innerWidth, height: innerHeight } });
  else {
    updateHint();
    schedule();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
  else if (e.key === ' ' && data && canPickWindows()) {
    windowMode = !windowMode;
    start = null;
    dragging = false;
    hovered = windowMode && mouse ? windowAt(mouse) : null;
    updateHint();
    schedule();
  } else if (e.key === 'Shift') {
    shiftKey = true;
    schedule();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') {
    shiftKey = false;
    schedule();
  }
});

window.addEventListener('mouseleave', () => {
  mouse = null;
  schedule();
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

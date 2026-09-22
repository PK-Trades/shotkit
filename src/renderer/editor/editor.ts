// Annotation editor. Shapes are stored in image pixel coordinates; the canvas shows the
// (optionally cropped) image plus an optional "beautify" background with padding.
import { IconName, svg } from '../shared/icons';

type ShapeType = 'arrow' | 'line' | 'rect' | 'ellipse' | 'blur' | 'pixelate' | 'pen' | 'highlighter' | 'text' | 'counter';
type Tool = 'select' | 'crop' | ShapeType;

interface P {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Geometry by type:
 * - line/arrow: start (x, y), vector (w, h)
 * - rect/ellipse/blur/pixelate: box (x, y, w, h)
 * - pen: points
 * - highlighter: rects (one straight bar per highlighted text line)
 * - text: top-left (x, y), measured size (w, h), font size in `width`
 * - counter: centre (x, y), radius in `width`
 */
interface Shape extends Rect {
  id: number;
  type: ShapeType;
  color: string;
  width: number;
  filled?: boolean;
  points?: P[];
  rects?: Rect[];
  /** Highlighter drawn over a dark background (uses a translucent overlay instead of multiply). */
  dark?: boolean;
  text?: string;
  n?: number;
}

interface Background {
  enabled: boolean;
  preset: string;
  padding: number;
  radius: number;
  shadow: boolean;
}

interface Doc {
  shapes: Shape[];
  crop: Rect | null;
  bg: Background;
}

/** A recognised line of text; `words` are sorted left to right. */
interface TextLine {
  words: Rect[];
  box: Rect;
}

/** Position in the recognised text: line index (reading order) and word index. */
interface Caret {
  line: number;
  word: number;
}

type Action =
  | { kind: 'draw'; shape: Shape; start: P }
  | { kind: 'highlight'; shape: Shape; start: P; caret: Caret | null }
  | { kind: 'move'; start: P; orig: Shape }
  | { kind: 'handle'; idx: number; orig: Shape }
  | { kind: 'crop'; start: P };

const TOOLS: { id: Tool; icon: IconName; label: string; key: string }[] = [
  { id: 'select', icon: 'select', label: 'Select & move', key: 'v' },
  { id: 'arrow', icon: 'arrow', label: 'Arrow', key: 'a' },
  { id: 'line', icon: 'line', label: 'Line', key: 'l' },
  { id: 'rect', icon: 'rect', label: 'Rectangle', key: 'r' },
  { id: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'o' },
  { id: 'text', icon: 'text', label: 'Text', key: 't' },
  { id: 'pen', icon: 'pen', label: 'Pen', key: 'p' },
  { id: 'highlighter', icon: 'highlighter', label: 'Highlighter', key: 'h' },
  { id: 'blur', icon: 'blur', label: 'Blur', key: 'b' },
  { id: 'pixelate', icon: 'pixelate', label: 'Pixelate', key: 'x' },
  { id: 'counter', icon: 'counter', label: 'Numbered step', key: 'n' },
  { id: 'crop', icon: 'crop', label: 'Crop', key: 'c' },
];

const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#1c1c1e'];
const STROKE = [3, 6, 10];
const TEXT_SIZE = [20, 32, 48];
const COUNTER_R = [13, 18, 24];
const HIGHLIGHT_BAR = [14, 22, 32];
const HIGHLIGHTER_DEFAULT = '#ffcc00';

const PRESETS: { id: string; stops?: string[]; solid?: string }[] = [
  { id: 'ocean', stops: ['#2e3192', '#1bffff'] },
  { id: 'purple', stops: ['#7f00ff', '#e100ff'] },
  { id: 'sunset', stops: ['#ff9a8b', '#ff6a88', '#ff99ac'] },
  { id: 'peach', stops: ['#f6d365', '#fda085'] },
  { id: 'mint', stops: ['#43e97b', '#38f9d7'] },
  { id: 'candy', stops: ['#a18cd1', '#fbc2eb'] },
  { id: 'fire', stops: ['#f83600', '#f9d423'] },
  { id: 'night', stops: ['#0f2027', '#203a43', '#2c5364'] },
  { id: 'white', solid: '#f5f5f7' },
  { id: 'dark', solid: '#1c1c1e' },
];

const FONT = '"Segoe UI", system-ui, sans-serif';
const font = (size: number) => `600 ${size}px ${FONT}`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const stage = $('stage');
const textInput = $<HTMLTextAreaElement>('textInput');
const cropBar = $('cropBar');
const bgPanel = $('bgPanel');

let img: HTMLImageElement;
let imgW = 0;
let imgH = 0;
let unit = 1;
let ready = false;

const doc: Doc = {
  shapes: [],
  crop: null,
  bg: { enabled: false, preset: 'ocean', padding: 64, radius: 12, shadow: true },
};

let tool: Tool = 'arrow';
let prevTool: Tool = 'arrow';
let color = COLORS[0];
let sizeIdx = 1;
let filled = false;
let selectedId: number | null = null;
let nextId = 1;
let action: Action | null = null;
let pendingCrop: Rect | null = null;
let editing: { shape: Shape; isNew: boolean } | null = null;
let shiftDown = false;
let textLines: TextLine[] = [];
let textDetection: 'pending' | 'done' | 'failed' = 'pending';
// The highlighter keeps its own colour (yellow by default), separate from the other tools.
let highlighterColor = HIGHLIGHTER_DEFAULT;
let drawColor = COLORS[0];
const effectCache: Partial<Record<'blur' | 'pixelate', HTMLCanvasElement>> = {};

const undoStack: string[] = [];
const redoStack: string[] = [];
let lastState = '';

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

const clone = (s: Shape): Shape => JSON.parse(JSON.stringify(s));
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function norm(r: Rect): Rect {
  return { x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) };
}

const inRect = (p: P, r: Rect, tol = 0) =>
  p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;

function distToSeg(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function isLight(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

function sizeFor(type: ShapeType, i: number): number {
  if (type === 'text') return TEXT_SIZE[i] * unit;
  if (type === 'counter') return COUNTER_R[i] * unit;
  if (type === 'highlighter') return HIGHLIGHT_BAR[i] * unit;
  return STROKE[i] * unit;
}

const selected = () => doc.shapes.find((s) => s.id === selectedId) ?? null;

// ---------------------------------------------------------------------------------------------
// Text-aware highlighter
// ---------------------------------------------------------------------------------------------

function union(rs: Rect[]): Rect {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}

/** Distance from a point to a rectangle (0 when inside). */
function rectDistance(r: Rect, p: P): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * Finds the word nearest to `p`. When `strict`, the point must be on (or very close to) a line
 * of text; otherwise it snaps to the nearest line wherever the pointer is.
 */
function caretAt(p: P, strict: boolean): Caret | null {
  let line = -1;
  if (strict) {
    // Must start on a line of text, or in the white space just beside it (like a text selection).
    let best = Infinity;
    textLines.forEach((l, i) => {
      const dx = Math.max(l.box.x - p.x, 0, p.x - (l.box.x + l.box.w));
      const dy = Math.max(l.box.y - p.y, 0, p.y - (l.box.y + l.box.h));
      if (dy > l.box.h * 0.5 || dx > l.box.h * 3) return;
      const d = rectDistance(l.box, p);
      if (d < best) {
        best = d;
        line = i;
      }
    });
    if (line < 0) return null;
  } else {
    // Like a text selection: pick the line by vertical position first, and only use
    // horizontal distance to choose between lines at the same height (e.g. columns).
    const dy = (l: TextLine) => Math.max(l.box.y - p.y, 0, p.y - (l.box.y + l.box.h));
    const dx = (l: TextLine) => Math.max(l.box.x - p.x, 0, p.x - (l.box.x + l.box.w));
    const minDy = Math.min(...textLines.map(dy));
    let best = Infinity;
    textLines.forEach((l, i) => {
      if (dy(l) > minDy + 2) return;
      if (dx(l) < best) {
        best = dx(l);
        line = i;
      }
    });
    if (line < 0) return null;
  }
  let word = 0;
  let wordDist = Infinity;
  textLines[line].words.forEach((w, j) => {
    const d = Math.max(w.x - p.x, 0, p.x - (w.x + w.w));
    if (d < wordDist) {
      wordDist = d;
      word = j;
    }
  });
  return { line, word };
}

/** One straight bar per text line between two carets, like a text selection. */
function highlightRects(a: Caret, b: Caret): Rect[] {
  const [s, e] = a.line < b.line || (a.line === b.line && a.word <= b.word) ? [a, b] : [b, a];
  const first = textLines[s.line].box;
  const last = textLines[e.line].box;
  const minX = Math.min(first.x, last.x);
  const maxX = Math.max(first.x + first.w, last.x + last.w);
  const rects: Rect[] = [];
  for (let i = s.line; i <= e.line; i++) {
    const l = textLines[i];
    // Skip lines in the reading order that belong to another column.
    if (i !== s.line && i !== e.line && (l.box.x > maxX || l.box.x + l.box.w < minX)) continue;
    const from = i === s.line ? s.word : 0;
    const to = i === e.line ? e.word : l.words.length - 1;
    if (from > to) continue;
    const x1 = l.words[from].x;
    const x2 = l.words[to].x + l.words[to].w;
    const padX = l.box.h * 0.15;
    const padY = l.box.h * 0.12;
    rects.push({ x: x1 - padX, y: l.box.y - padY, w: x2 - x1 + padX * 2, h: l.box.h + padY * 2 });
  }
  return rects;
}

const sampler = document.createElement('canvas');
sampler.width = sampler.height = 16;
const samplerCtx = sampler.getContext('2d', { willReadFrequently: true })!;

/** Whether the image under `r` is mostly dark (average luminance below mid-grey). */
function isDarkArea(r: Rect): boolean {
  const x = clamp(r.x, 0, imgW - 1);
  const y = clamp(r.y, 0, imgH - 1);
  const w = clamp(r.x + r.w, x + 1, imgW) - x;
  const h = clamp(r.y + r.h, y + 1, imgH) - y;
  samplerCtx.clearRect(0, 0, 16, 16);
  samplerCtx.drawImage(img, x, y, w, h, 0, 0, 16, 16);
  const d = samplerCtx.getImageData(0, 0, 16, 16).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / (d.length / 4) < 110;
}

function updateHighlight(a: Extract<Action, { kind: 'highlight' }>, p: P) {
  if (a.caret) {
    const end = caretAt(p, false);
    a.shape.rects = end ? highlightRects(a.caret, end) : [];
  } else {
    // No text under the starting point: a straight horizontal bar that follows the drag.
    const h = a.shape.width;
    a.shape.rects = [{ x: Math.min(a.start.x, p.x), y: a.start.y - h / 2, w: Math.abs(p.x - a.start.x), h }];
  }
  if (a.shape.rects.length) a.shape.dark = isDarkArea(union(a.shape.rects));
}

async function detectText() {
  try {
    const lines = await window.api.invoke<Rect[][]>('editor:words');
    // Windows OCR splits a visual row into several lines at wide gaps (e.g. a line number and
    // the code after it). Merge pieces on the same row that are reasonably close together.
    const rows: Rect[][] = [];
    for (const words of [...lines].sort((a, b) => union(a).x - union(b).x)) {
      const box = union(words);
      const row = rows.find((r) => {
        const rb = union(r);
        const overlap = Math.min(rb.y + rb.h, box.y + box.h) - Math.max(rb.y, box.y);
        const gap = box.x - (rb.x + rb.w);
        return overlap >= Math.min(rb.h, box.h) * 0.5 && gap <= Math.max(rb.h, box.h) * 4;
      });
      if (row) row.push(...words);
      else rows.push([...words]);
    }
    textLines = rows
      .map((words) => {
        const sorted = [...words].sort((a, b) => a.x - b.x);
        return { words: sorted, box: union(sorted) };
      })
      .sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2) || a.box.x - b.box.x);
    textDetection = 'done';
  } catch {
    textDetection = 'failed';
  }
}

// ---------------------------------------------------------------------------------------------
// View mapping
// ---------------------------------------------------------------------------------------------

function view() {
  const cropping = tool === 'crop';
  const base: Rect = !cropping && doc.crop ? doc.crop : { x: 0, y: 0, w: imgW, h: imgH };
  const bgOn = doc.bg.enabled && !cropping;
  const pad = bgOn ? Math.round(doc.bg.padding * unit) : 0;
  const radius = bgOn ? Math.min(doc.bg.radius * unit, base.w / 2, base.h / 2) : 0;
  return { base, pad, radius, bgOn };
}

/** CSS pixels per canvas pixel. */
const viewScale = () => canvas.getBoundingClientRect().width / canvas.width || 1;

function toImg(e: { clientX: number; clientY: number }): P {
  const r = canvas.getBoundingClientRect();
  const v = view();
  return {
    x: ((e.clientX - r.left) * canvas.width) / r.width - v.pad + v.base.x,
    y: ((e.clientY - r.top) * canvas.height) / r.height - v.pad + v.base.y,
  };
}

function toClient(p: P): P {
  const r = canvas.getBoundingClientRect();
  const v = view();
  const k = r.width / canvas.width;
  return { x: r.left + (p.x - v.base.x + v.pad) * k, y: r.top + (p.y - v.base.y + v.pad) * k };
}

function layout() {
  const st = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const natW = canvas.width / dpr;
  const natH = canvas.height / dpr;
  const f = Math.min(1, (st.width - 64) / natW, (st.height - 64) / natH);
  canvas.style.width = `${Math.max(1, natW * f)}px`;
  canvas.style.height = `${Math.max(1, natH * f)}px`;
  if (editing) positionTextInput();
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function effect(kind: 'blur' | 'pixelate'): HTMLCanvasElement {
  const cached = effectCache[kind];
  if (cached) return cached;
  const cv = document.createElement('canvas');
  cv.width = imgW;
  cv.height = imgH;
  const c = cv.getContext('2d')!;
  if (kind === 'blur') {
    c.drawImage(img, 0, 0);
    c.filter = `blur(${Math.round(12 * unit)}px)`;
    c.drawImage(img, 0, 0);
    c.filter = 'none';
  } else {
    const block = Math.max(6, Math.round(10 * unit));
    const sw = Math.ceil(imgW / block);
    const sh = Math.ceil(imgH / block);
    const small = document.createElement('canvas');
    small.width = sw;
    small.height = sh;
    small.getContext('2d')!.drawImage(img, 0, 0, sw * block, sh * block, 0, 0, sw, sh);
    c.imageSmoothingEnabled = false;
    c.drawImage(small, 0, 0, sw * block, sh * block);
  }
  effectCache[kind] = cv;
  return cv;
}

function strokePoints(c: CanvasRenderingContext2D, pts: P[]) {
  if (pts.length === 1) {
    c.beginPath();
    c.arc(pts[0].x, pts[0].y, c.lineWidth / 2, 0, Math.PI * 2);
    c.fill();
    return;
  }
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  }
  const last = pts[pts.length - 1];
  c.lineTo(last.x, last.y);
  c.stroke();
}

function drawArrow(c: CanvasRenderingContext2D, s: Shape) {
  const len = Math.hypot(s.w, s.h);
  if (len < 1) return;
  const x2 = s.x + s.w;
  const y2 = s.y + s.h;
  const ang = Math.atan2(s.h, s.w);
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const head = Math.min(len * 0.7, Math.max(s.width * 3.4, 12 * unit));
  const hw = head * 0.62;
  const bx = x2 - cos * head;
  const by = y2 - sin * head;
  c.beginPath();
  c.moveTo(s.x, s.y);
  c.lineTo(bx + cos * head * 0.3, by + sin * head * 0.3);
  c.stroke();
  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(bx - sin * hw, by + cos * hw);
  c.lineTo(bx + sin * hw, by - cos * hw);
  c.closePath();
  c.lineWidth = Math.max(1, s.width * 0.5);
  c.fill();
  c.stroke();
}

function drawText(c: CanvasRenderingContext2D, s: Shape) {
  const lh = s.width * 1.25;
  const off = (lh - s.width) / 2;
  c.font = font(s.width);
  c.textBaseline = 'top';
  c.lineWidth = Math.max(2, s.width * 0.18);
  c.strokeStyle = isLight(s.color) ? 'rgba(0,0,0,0.85)' : '#ffffff';
  (s.text ?? '').split('\n').forEach((line, i) => {
    const y = s.y + i * lh + off;
    c.strokeText(line, s.x, y);
    c.fillText(line, s.x, y);
  });
}

function measureText(s: Shape) {
  ctx.save();
  ctx.font = font(s.width);
  const lines = (s.text ?? '').split('\n');
  s.w = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
  s.h = lines.length * s.width * 1.25;
  ctx.restore();
}

function drawShape(c: CanvasRenderingContext2D, s: Shape) {
  c.save();
  c.strokeStyle = s.color;
  c.fillStyle = s.color;
  c.lineWidth = s.width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const shadow = () => {
    c.shadowColor = 'rgba(0,0,0,0.3)';
    c.shadowBlur = 4 * unit;
    c.shadowOffsetY = 1.5 * unit;
  };
  switch (s.type) {
    case 'line':
      shadow();
      c.beginPath();
      c.moveTo(s.x, s.y);
      c.lineTo(s.x + s.w, s.y + s.h);
      c.stroke();
      break;
    case 'arrow':
      shadow();
      drawArrow(c, s);
      break;
    case 'rect': {
      shadow();
      const r = norm(s);
      c.beginPath();
      c.roundRect(r.x, r.y, r.w, r.h, Math.min(s.width, r.w / 2, r.h / 2));
      if (s.filled) c.fill();
      else c.stroke();
      break;
    }
    case 'ellipse': {
      shadow();
      const r = norm(s);
      c.beginPath();
      c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      if (s.filled) c.fill();
      else c.stroke();
      break;
    }
    case 'blur':
    case 'pixelate': {
      const r = norm(s);
      const x = clamp(r.x, 0, imgW);
      const y = clamp(r.y, 0, imgH);
      const w = clamp(r.x + r.w, 0, imgW) - x;
      const h = clamp(r.y + r.h, 0, imgH) - y;
      if (w >= 1 && h >= 1) c.drawImage(effect(s.type), x, y, w, h, x, y, w, h);
      break;
    }
    case 'pen':
      shadow();
      strokePoints(c, s.points ?? []);
      break;
    case 'highlighter':
      // On light backgrounds multiply keeps dark text fully readable, like a real highlighter;
      // on dark backgrounds multiply would vanish, so use a translucent overlay instead.
      // All bars go in one path so overlapping parts aren't darkened twice.
      c.globalCompositeOperation = s.dark ? 'source-over' : 'multiply';
      c.globalAlpha = s.dark ? 0.4 : 0.75;
      c.beginPath();
      for (const r of s.rects ?? []) {
        if (r.w > 0 && r.h > 0) c.roundRect(r.x, r.y, r.w, r.h, Math.min(r.h * 0.2, 4 * unit));
      }
      c.fill();
      break;
    case 'text':
      drawText(c, s);
      break;
    case 'counter':
      shadow();
      c.beginPath();
      c.arc(s.x, s.y, s.width, 0, Math.PI * 2);
      c.fill();
      c.shadowColor = 'transparent';
      c.lineWidth = Math.max(1.5, s.width * 0.14);
      c.strokeStyle = '#fff';
      c.stroke();
      c.fillStyle = isLight(s.color) ? '#1c1c1e' : '#fff';
      c.font = `700 ${s.width * 1.1}px ${FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(s.n ?? 1), s.x, s.y + s.width * 0.05);
      break;
  }
  c.restore();
}

function bbox(s: Shape): Rect {
  switch (s.type) {
    case 'line':
    case 'arrow': {
      const r = norm(s);
      const m = s.width / 2;
      return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
    }
    case 'highlighter':
      return s.rects?.length ? union(s.rects) : { x: s.x, y: s.y, w: 0, h: 0 };
    case 'pen': {
      const xs = (s.points ?? []).map((p) => p.x);
      const ys = (s.points ?? []).map((p) => p.y);
      const m = s.width / 2;
      const x = Math.min(...xs) - m;
      const y = Math.min(...ys) - m;
      return { x, y, w: Math.max(...xs) + m - x, h: Math.max(...ys) + m - y };
    }
    case 'counter':
      return { x: s.x - s.width, y: s.y - s.width, w: s.width * 2, h: s.width * 2 };
    default:
      return norm(s);
  }
}

function handles(s: Shape): P[] {
  if (s.type === 'line' || s.type === 'arrow') {
    return [
      { x: s.x, y: s.y },
      { x: s.x + s.w, y: s.y + s.h },
    ];
  }
  if (s.type === 'rect' || s.type === 'ellipse' || s.type === 'blur' || s.type === 'pixelate') {
    const r = norm(s);
    return [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ];
  }
  return [];
}

function drawSelection(c: CanvasRenderingContext2D) {
  if (tool !== 'select') return;
  const s = selected();
  if (!s) return;
  const k = 1 / viewScale();
  const b = bbox(s);
  c.save();
  c.strokeStyle = '#4f8cff';
  c.lineWidth = 1.5 * k;
  c.setLineDash([5 * k, 4 * k]);
  c.strokeRect(b.x - 4 * k, b.y - 4 * k, b.w + 8 * k, b.h + 8 * k);
  c.setLineDash([]);
  for (const h of handles(s)) {
    c.fillStyle = '#fff';
    c.beginPath();
    c.rect(h.x - 5 * k, h.y - 5 * k, 10 * k, 10 * k);
    c.fill();
    c.stroke();
  }
  c.restore();
}

function drawCropUI(c: CanvasRenderingContext2D) {
  if (tool !== 'crop' || !pendingCrop) return;
  const r = norm(pendingCrop);
  const k = 1 / viewScale();
  c.save();
  c.fillStyle = 'rgba(0,0,0,0.55)';
  c.beginPath();
  c.rect(0, 0, imgW, imgH);
  c.rect(r.x, r.y, r.w, r.h);
  c.fill('evenodd');
  c.strokeStyle = 'rgba(255,255,255,0.35)';
  c.lineWidth = k;
  c.beginPath();
  for (const f of [1 / 3, 2 / 3]) {
    c.moveTo(r.x + r.w * f, r.y);
    c.lineTo(r.x + r.w * f, r.y + r.h);
    c.moveTo(r.x, r.y + r.h * f);
    c.lineTo(r.x + r.w, r.y + r.h * f);
  }
  c.stroke();
  c.strokeStyle = '#fff';
  c.lineWidth = 2 * k;
  c.strokeRect(r.x, r.y, r.w, r.h);
  c.restore();
}

function paintBackground(c: CanvasRenderingContext2D, W: number, H: number) {
  const p = PRESETS.find((x) => x.id === doc.bg.preset) ?? PRESETS[0];
  if (p.solid) c.fillStyle = p.solid;
  else {
    const g = c.createLinearGradient(0, 0, W, H);
    p.stops!.forEach((s, i, all) => g.addColorStop(i / (all.length - 1), s));
    c.fillStyle = g;
  }
  c.fillRect(0, 0, W, H);
}

function paint(c: CanvasRenderingContext2D, exporting: boolean) {
  const v = view();
  const W = Math.max(1, Math.round(v.base.w + v.pad * 2));
  const H = Math.max(1, Math.round(v.base.h + v.pad * 2));
  if (c.canvas.width !== W || c.canvas.height !== H) {
    c.canvas.width = W;
    c.canvas.height = H;
    if (!exporting) layout();
  }
  c.clearRect(0, 0, W, H);
  if (v.bgOn) {
    paintBackground(c, W, H);
    if (doc.bg.shadow && v.pad > 0) {
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.45)';
      c.shadowBlur = 36 * unit;
      c.shadowOffsetY = 12 * unit;
      c.fillStyle = '#000';
      c.beginPath();
      c.roundRect(v.pad, v.pad, v.base.w, v.base.h, v.radius);
      c.fill();
      c.restore();
    }
  }
  c.save();
  c.beginPath();
  c.roundRect(v.pad, v.pad, v.base.w, v.base.h, v.radius);
  c.clip();
  c.translate(v.pad - v.base.x, v.pad - v.base.y);
  c.drawImage(img, 0, 0);
  for (const s of doc.shapes) if (s.id !== editing?.shape.id) drawShape(c, s);
  if (action?.kind === 'draw' || action?.kind === 'highlight') drawShape(c, action.shape);
  c.restore();
  if (!exporting) {
    c.save();
    c.translate(v.pad - v.base.x, v.pad - v.base.y);
    drawSelection(c);
    drawCropUI(c);
    c.restore();
  }
}

let frame = 0;
function render() {
  if (!ready || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    paint(ctx, false);
  });
}

// ---------------------------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------------------------

function hit(s: Shape, p: P, tol: number): boolean {
  switch (s.type) {
    case 'line':
    case 'arrow':
      return distToSeg(p, { x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }) <= s.width / 2 + tol;
    case 'rect': {
      const r = norm(s);
      const m = tol + s.width / 2;
      if (!inRect(p, r, m)) return false;
      if (s.filled) return true;
      return !(p.x > r.x + m && p.x < r.x + r.w - m && p.y > r.y + m && p.y < r.y + r.h - m);
    }
    case 'ellipse': {
      const r = norm(s);
      const rx = r.w / 2;
      const ry = r.h / 2;
      if (rx < 1 || ry < 1) return false;
      const d = Math.hypot((p.x - r.x - rx) / rx, (p.y - r.y - ry) / ry);
      const band = (tol + s.width / 2) / Math.min(rx, ry);
      return s.filled ? d <= 1 + band : Math.abs(d - 1) <= band;
    }
    case 'blur':
    case 'pixelate':
      return inRect(p, norm(s), tol);
    case 'highlighter':
      return (s.rects ?? []).some((r) => inRect(p, r, tol));
    case 'pen': {
      const pts = s.points ?? [];
      const lim = s.width / 2 + tol;
      if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= lim;
      for (let i = 0; i < pts.length - 1; i++) if (distToSeg(p, pts[i], pts[i + 1]) <= lim) return true;
      return false;
    }
    case 'text':
      return inRect(p, s, tol);
    case 'counter':
      return Math.hypot(p.x - s.x, p.y - s.y) <= s.width + tol;
  }
}

function shapeAt(p: P): Shape | null {
  const tol = 6 / viewScale();
  for (let i = doc.shapes.length - 1; i >= 0; i--) if (hit(doc.shapes[i], p, tol)) return doc.shapes[i];
  return null;
}

// ---------------------------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------------------------

const snapshot = () => JSON.stringify({ shapes: doc.shapes, crop: doc.crop, bg: doc.bg });

function commit() {
  const now = snapshot();
  if (now === lastState) return;
  undoStack.push(lastState);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  lastState = now;
  updateToolbar();
}

function restore(json: string) {
  const d = JSON.parse(json) as Doc;
  doc.shapes = d.shapes;
  doc.crop = d.crop;
  doc.bg = d.bg;
  selectedId = null;
  syncBgPanel();
  updateToolbar();
  render();
}

function undo() {
  if (editing) commitText();
  const prev = undoStack.pop();
  if (prev === undefined) return;
  redoStack.push(lastState);
  lastState = prev;
  restore(prev);
}

function redo() {
  const next = redoStack.pop();
  if (next === undefined) return;
  undoStack.push(lastState);
  lastState = next;
  restore(next);
}

// ---------------------------------------------------------------------------------------------
// Text editing
// ---------------------------------------------------------------------------------------------

function positionTextInput() {
  if (!editing) return;
  const s = editing.shape;
  const k = viewScale();
  const p = toClient({ x: s.x, y: s.y });
  const st = stage.getBoundingClientRect();
  textInput.style.left = `${p.x - st.left - 1}px`;
  textInput.style.top = `${p.y - st.top - 1}px`;
  textInput.style.fontSize = `${s.width * k}px`;
  textInput.style.color = s.color;
  autosizeText();
}

function autosizeText() {
  if (!editing) return;
  const s = editing.shape;
  const k = viewScale();
  ctx.save();
  ctx.font = font(s.width);
  const lines = textInput.value.split('\n');
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width), s.width) * k;
  ctx.restore();
  textInput.style.width = `${w + s.width * k * 0.8 + 4}px`;
  textInput.style.height = `${lines.length * s.width * 1.25 * k + 2}px`;
}

function openText(s: Shape, isNew: boolean) {
  editing = { shape: s, isNew };
  textInput.value = s.text ?? '';
  textInput.hidden = false;
  positionTextInput();
  render();
  setTimeout(() => {
    textInput.focus();
    textInput.select();
  });
}

function commitText() {
  if (!editing) return;
  const { shape, isNew } = editing;
  editing = null;
  textInput.hidden = true;
  const text = textInput.value.replace(/\s+$/, '');
  if (!text) {
    if (!isNew) doc.shapes = doc.shapes.filter((x) => x.id !== shape.id);
  } else {
    shape.text = text;
    measureText(shape);
    if (isNew) doc.shapes.push(shape);
  }
  commit();
  render();
}

textInput.addEventListener('input', autosizeText);
textInput.addEventListener('blur', commitText);
textInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    commitText();
  }
});

// ---------------------------------------------------------------------------------------------
// Pointer interaction
// ---------------------------------------------------------------------------------------------

function newShape(type: ShapeType, p: P): Shape {
  return { id: nextId++, type, color, width: sizeFor(type, sizeIdx), x: p.x, y: p.y, w: 0, h: 0 };
}

function applyHandle(s: Shape, orig: Shape, idx: number, p: P) {
  if (s.type === 'line' || s.type === 'arrow') {
    if (idx === 0) {
      s.x = p.x;
      s.y = p.y;
      s.w = orig.x + orig.w - p.x;
      s.h = orig.y + orig.h - p.y;
    } else {
      s.w = p.x - orig.x;
      s.h = p.y - orig.y;
    }
    return;
  }
  const opp = handles(orig)[(idx + 2) % 4];
  s.x = opp.x;
  s.y = opp.y;
  s.w = p.x - opp.x;
  s.h = p.y - opp.y;
}

function normalizeBox(s: Shape) {
  if (s.type === 'rect' || s.type === 'ellipse' || s.type === 'blur' || s.type === 'pixelate') Object.assign(s, norm(s));
}

canvas.addEventListener('pointerdown', (e) => {
  if (!ready || e.button !== 0) return;
  if (editing) {
    commitText();
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  const p = toImg(e);

  if (tool === 'crop') {
    action = { kind: 'crop', start: p };
    pendingCrop = null;
    updateCropBar();
    return;
  }

  if (tool === 'select') {
    const sel = selected();
    if (sel) {
      const i = handles(sel).findIndex((h) => Math.hypot(h.x - p.x, h.y - p.y) <= 8 / viewScale());
      if (i >= 0) {
        action = { kind: 'handle', idx: i, orig: clone(sel) };
        return;
      }
    }
    const s = shapeAt(p);
    selectedId = s?.id ?? null;
    if (s) {
      color = s.color;
      action = { kind: 'move', start: p, orig: clone(s) };
    }
    updateToolbar();
    render();
    return;
  }

  if (tool === 'text') {
    const s = shapeAt(p);
    if (s?.type === 'text') openText(s, false);
    else openText({ ...newShape('text', p), text: '' }, true);
    return;
  }

  if (tool === 'counter') {
    const n = Math.max(0, ...doc.shapes.filter((s) => s.type === 'counter').map((s) => s.n ?? 0)) + 1;
    doc.shapes.push({ ...newShape('counter', p), n });
    commit();
    render();
    return;
  }

  if (tool === 'highlighter') {
    const a: Action = { kind: 'highlight', shape: newShape('highlighter', p), start: p, caret: caretAt(p, true) };
    selectedId = null;
    updateHighlight(a, p);
    action = a;
    render();
    return;
  }

  const shape = newShape(tool as ShapeType, p);
  if (tool === 'pen') shape.points = [p];
  if (tool === 'rect' || tool === 'ellipse') shape.filled = filled;
  selectedId = null;
  action = { kind: 'draw', shape, start: p };
});

canvas.addEventListener('pointermove', (e) => {
  if (!ready) return;
  const p = toImg(e);
  if (!action) {
    if (tool === 'select') {
      const sel = selected();
      const onHandle = sel && handles(sel).some((h) => Math.hypot(h.x - p.x, h.y - p.y) <= 8 / viewScale());
      canvas.style.cursor = onHandle ? 'crosshair' : shapeAt(p) ? 'move' : 'default';
    }
    return;
  }
  const shift = e.shiftKey || shiftDown;

  switch (action.kind) {
    case 'draw': {
      const s = action.shape;
      if (s.type === 'pen') {
        const last = s.points![s.points!.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * viewScale() >= 2) s.points!.push(p);
      } else {
        let w = p.x - action.start.x;
        let h = p.y - action.start.y;
        if (shift) {
          if (s.type === 'line' || s.type === 'arrow') {
            const ang = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(w, h);
            w = Math.cos(ang) * len;
            h = Math.sin(ang) * len;
          } else {
            const m = Math.max(Math.abs(w), Math.abs(h));
            w = Math.sign(w || 1) * m;
            h = Math.sign(h || 1) * m;
          }
        }
        s.w = w;
        s.h = h;
      }
      break;
    }
    case 'highlight':
      updateHighlight(action, p);
      break;
    case 'move': {
      const s = selected();
      if (!s) break;
      const dx = p.x - action.start.x;
      const dy = p.y - action.start.y;
      s.x = action.orig.x + dx;
      s.y = action.orig.y + dy;
      if (action.orig.points) s.points = action.orig.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      if (action.orig.rects) s.rects = action.orig.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
      break;
    }
    case 'handle': {
      const s = selected();
      if (s) applyHandle(s, action.orig, action.idx, p);
      break;
    }
    case 'crop': {
      const x1 = clamp(action.start.x, 0, imgW);
      const y1 = clamp(action.start.y, 0, imgH);
      const x2 = clamp(p.x, 0, imgW);
      const y2 = clamp(p.y, 0, imgH);
      pendingCrop = norm({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
      updateCropBar();
      break;
    }
  }
  render();
});

canvas.addEventListener('pointerup', () => {
  if (!action) return;
  const a = action;
  action = null;
  const minSize = 3 / viewScale();
  switch (a.kind) {
    case 'draw': {
      const s = a.shape;
      const big = s.type === 'pen' ? true : Math.abs(s.w) >= minSize || Math.abs(s.h) >= minSize;
      if (big) {
        normalizeBox(s);
        doc.shapes.push(s);
        commit();
      }
      break;
    }
    case 'highlight': {
      // A click on a word highlights that word; a click on empty space does nothing.
      const rects = (a.shape.rects ?? []).filter((r) => r.w >= minSize);
      if (rects.length) {
        a.shape.rects = rects;
        Object.assign(a.shape, { ...union(rects) });
        doc.shapes.push(a.shape);
        commit();
      }
      break;
    }
    case 'move':
    case 'handle': {
      const s = selected();
      if (s) normalizeBox(s);
      commit();
      break;
    }
    case 'crop':
      if (pendingCrop && (pendingCrop.w < 4 || pendingCrop.h < 4)) pendingCrop = null;
      updateCropBar();
      break;
  }
  render();
});

// ---------------------------------------------------------------------------------------------
// Tools, toolbar, crop and background controls
// ---------------------------------------------------------------------------------------------

function cursorFor(t: Tool) {
  return t === 'select' ? 'default' : t === 'text' ? 'text' : 'crosshair';
}

function setTool(t: Tool) {
  if (editing) commitText();
  if (t === tool) return;
  if (t === 'crop') {
    prevTool = tool;
    pendingCrop = doc.crop ? { ...doc.crop } : null;
  } else if (tool === 'crop') {
    pendingCrop = null;
  }
  if (t === 'highlighter') {
    drawColor = color;
    color = highlighterColor;
    if (textDetection === 'pending') toast('Detecting text… highlights will snap to text in a moment');
    else if (textDetection === 'done' && !textLines.length) toast('No text found — the highlighter will draw straight bars');
  } else if (tool === 'highlighter') {
    highlighterColor = color;
    color = drawColor;
  }
  tool = t;
  if (t !== 'select') selectedId = null;
  canvas.style.cursor = cursorFor(t);
  updateToolbar();
  updateCropBar();
  render();
}

function updateCropBar() {
  cropBar.hidden = tool !== 'crop';
  $('cropSize').textContent = pendingCrop
    ? `${Math.round(pendingCrop.w)} × ${Math.round(pendingCrop.h)}`
    : 'Drag to select';
}

function applyCrop() {
  doc.crop = pendingCrop
    ? {
        x: Math.round(pendingCrop.x),
        y: Math.round(pendingCrop.y),
        w: Math.round(pendingCrop.w),
        h: Math.round(pendingCrop.h),
      }
    : null;
  commit();
  setTool(prevTool);
}

function applyToSelected(fn: (s: Shape) => void) {
  const s = tool === 'select' ? selected() : null;
  if (!s) return;
  fn(s);
  if (s.type === 'text') measureText(s);
  commit();
  render();
}

function setSize(i: number) {
  sizeIdx = i;
  applyToSelected((s) => (s.width = sizeFor(s.type, i)));
  updateToolbar();
}

function toggleFill() {
  filled = !filled;
  applyToSelected((s) => {
    if (s.type === 'rect' || s.type === 'ellipse') s.filled = filled;
  });
  updateToolbar();
}

function deleteSelected() {
  if (selectedId === null) return;
  doc.shapes = doc.shapes.filter((s) => s.id !== selectedId);
  selectedId = null;
  commit();
  render();
}

function buildToolbar() {
  const tools = $('tools');
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.className = 'tool';
    b.dataset.tool = t.id;
    b.title = `${t.label} (${t.key.toUpperCase()})`;
    b.innerHTML = svg(t.icon);
    b.addEventListener('click', () => setTool(t.id));
    tools.appendChild(b);
  }

  const colors = $('colors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      color = c;
      applyToSelected((s) => (s.color = c));
      updateToolbar();
    });
    colors.appendChild(b);
  }

  const sizes = $('sizes');
  ['Small', 'Medium', 'Large'].forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'tool size';
    b.dataset.size = String(i);
    b.title = `${label} (${i + 1})`;
    const d = 4 + i * 4;
    b.innerHTML = `<span style="width:${d}px;height:${d}px"></span>`;
    b.addEventListener('click', () => setSize(i));
    sizes.appendChild(b);
  });

  $('fill').innerHTML = svg('fill');
  $('fill').addEventListener('click', toggleFill);
  $('undo').innerHTML = svg('undo');
  $('undo').addEventListener('click', undo);
  $('redo').innerHTML = svg('redo');
  $('redo').addEventListener('click', redo);
  $('bgToggle').innerHTML = `${svg('background')}<span>Background</span>`;
  $('bgToggle').addEventListener('click', toggleBgPanel);

  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-export]'))) {
    b.addEventListener('click', () => doExport(b.dataset.export!));
  }

  $('cropApply').addEventListener('click', applyCrop);
  $('cropCancel').addEventListener('click', () => setTool(prevTool));
  $('cropReset').addEventListener('click', () => {
    pendingCrop = null;
    updateCropBar();
    render();
  });
}

function updateToolbar() {
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-tool]'))) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-color]'))) {
    b.classList.toggle('active', b.dataset.color === color);
  }
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-size]'))) {
    b.classList.toggle('active', b.dataset.size === String(sizeIdx));
  }
  $('fill').classList.toggle('active', filled);
  ($('undo') as HTMLButtonElement).disabled = !undoStack.length;
  ($('redo') as HTMLButtonElement).disabled = !redoStack.length;
  $('bgToggle').classList.toggle('active', !bgPanel.hidden);
}

function buildBgPanel() {
  const sw = $('bgSwatches');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'bgswatch';
    b.dataset.preset = p.id;
    b.style.background = p.solid ?? `linear-gradient(135deg, ${p.stops!.join(', ')})`;
    b.addEventListener('click', () => {
      doc.bg.preset = p.id;
      doc.bg.enabled = true;
      commit();
      syncBgPanel();
      render();
    });
    sw.appendChild(b);
  }
  const enabled = $<HTMLInputElement>('bgEnabled');
  const padding = $<HTMLInputElement>('bgPadding');
  const radius = $<HTMLInputElement>('bgRadius');
  const shadow = $<HTMLInputElement>('bgShadow');
  enabled.addEventListener('change', () => {
    doc.bg.enabled = enabled.checked;
    commit();
    render();
  });
  shadow.addEventListener('change', () => {
    doc.bg.shadow = shadow.checked;
    commit();
    render();
  });
  for (const [el, key] of [
    [padding, 'padding'],
    [radius, 'radius'],
  ] as const) {
    el.addEventListener('input', () => {
      doc.bg[key] = Number(el.value);
      if (!doc.bg.enabled) {
        doc.bg.enabled = true;
        enabled.checked = true;
      }
      render();
    });
    el.addEventListener('change', commit);
  }
}

function syncBgPanel() {
  $<HTMLInputElement>('bgEnabled').checked = doc.bg.enabled;
  $<HTMLInputElement>('bgPadding').value = String(doc.bg.padding);
  $<HTMLInputElement>('bgRadius').value = String(doc.bg.radius);
  $<HTMLInputElement>('bgShadow').checked = doc.bg.shadow;
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-preset]'))) {
    b.classList.toggle('active', b.dataset.preset === doc.bg.preset);
  }
}

function toggleBgPanel() {
  bgPanel.hidden = !bgPanel.hidden;
  if (!bgPanel.hidden && !doc.bg.enabled) {
    doc.bg.enabled = true;
    commit();
    syncBgPanel();
  }
  updateToolbar();
  requestAnimationFrame(() => {
    layout();
    render();
  });
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

let toastTimer = 0;
function toast(text: string) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
}

async function doExport(kind: string) {
  if (!ready) return;
  if (editing) commitText();
  if (tool === 'crop') setTool(prevTool);
  const off = document.createElement('canvas');
  paint(off.getContext('2d')!, true);
  const blob = await new Promise<Blob | null>((r) => off.toBlob(r, 'image/png'));
  if (!blob) {
    toast('Export failed');
    return;
  }
  const res = await window.api.invoke<{ ok: boolean; message?: string }>(
    'editor:export',
    kind,
    new Uint8Array(await blob.arrayBuffer()),
  );
  // Copying is the "done" action: the image is on the clipboard, so close the editor.
  if (kind === 'copy' && res?.ok) {
    window.close();
    return;
  }
  if (res?.message) toast(res.message);
}

// ---------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') shiftDown = true;
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey) {
    if (k === 'z' && !e.shiftKey) undo();
    else if (k === 'y' || (k === 'z' && e.shiftKey)) redo();
    else if (k === 'c') doExport('copy');
    else if (k === 's') doExport(e.shiftKey ? 'saveAs' : 'save');
    else return;
    e.preventDefault();
    return;
  }
  if (tool === 'crop' && k === 'enter') return applyCrop();
  if (k === 'escape') {
    if (tool === 'crop') setTool(prevTool);
    else {
      selectedId = null;
      render();
    }
    return;
  }
  if (k === 'delete' || k === 'backspace') return deleteSelected();
  if (k === 'f') return toggleFill();
  if (k === '1' || k === '2' || k === '3') return setSize(Number(k) - 1);
  const t = TOOLS.find((x) => x.key === k);
  if (t && !e.altKey) setTool(t.id);
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') shiftDown = false;
});

window.addEventListener('resize', () => {
  if (ready) layout();
});

// ---------------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------------

async function init() {
  buildToolbar();
  buildBgPanel();
  const d = await window.api.invoke<{ name: string; dataUrl: string; scale: number }>('editor:load');
  document.title = `${d.name} — ShotKit Editor`;
  img = new Image();
  img.src = d.dataUrl;
  await img.decode();
  imgW = img.naturalWidth;
  imgH = img.naturalHeight;
  unit = Math.max(1, d.scale || 1);
  lastState = snapshot();
  ready = true;
  canvas.style.cursor = cursorFor(tool);
  syncBgPanel();
  updateToolbar();
  updateCropBar();
  paint(ctx, false);
  detectText();
}

init().catch((e) => toast(`Could not load image: ${e instanceof Error ? e.message : e}`));

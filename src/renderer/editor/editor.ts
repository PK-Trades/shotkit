// Annotation editor. Shapes are stored in image pixel coordinates; the canvas shows the
// (optionally cropped) image plus an optional "beautify" background with padding.
import { IconName, svg } from '../shared/icons';
import { findSensitive, PLURAL } from './redact';

type ShapeType =
  | 'arrow'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'blur'
  | 'pixelate'
  | 'pen'
  | 'highlighter'
  | 'text'
  | 'counter'
  | 'callout'
  | 'spotlight'
  | 'redact';
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
 * - line/arrow: start (x, y), vector (w, h), optional `bend`
 * - rect/ellipse/blur/pixelate/spotlight/redact: box (x, y, w, h)
 * - pen: points
 * - highlighter: rects (one straight bar per highlighted text line)
 * - text: top-left (x, y), measured size (w, h), font size in `width`
 * - callout: like text, plus the tail's `tip`
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
  /** line/arrow: offset of the curve's control point from the midpoint of start and end. */
  bend?: P;
  /** arrow: an arrow style id; spotlight: 'rect' or 'ellipse'. */
  style?: string;
  /** callout: the point the tail points at. */
  tip?: P;
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

/** A word found by OCR, in image pixels. */
interface Word extends Rect {
  text?: string;
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
  { id: 'callout', icon: 'callout', label: 'Callout', key: 'm' },
  { id: 'pen', icon: 'pen', label: 'Pen', key: 'p' },
  { id: 'highlighter', icon: 'highlighter', label: 'Highlighter', key: 'h' },
  { id: 'blur', icon: 'blur', label: 'Blur', key: 'b' },
  { id: 'pixelate', icon: 'pixelate', label: 'Pixelate', key: 'x' },
  { id: 'spotlight', icon: 'spotlight', label: 'Spotlight', key: 's' },
  { id: 'counter', icon: 'counter', label: 'Numbered step', key: 'n' },
  { id: 'crop', icon: 'crop', label: 'Crop', key: 'c' },
];

const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#1c1c1e'];
const STROKE = [3, 6, 10];
const TEXT_SIZE = [20, 32, 48];
const COUNTER_R = [13, 18, 24];
const HIGHLIGHT_BAR = [14, 22, 32];
const CALLOUT_SIZE = [16, 22, 30];
const HIGHLIGHTER_DEFAULT = '#ffcc00';
const REDACT_COLOR = '#111114';

/** Shape types with a style picker, and their styles (the first is the default). */
const STYLES: Partial<Record<ShapeType, { id: string; icon: IconName; label: string }[]>> = {
  arrow: [
    { id: 'solid', icon: 'arrowSolid', label: 'Standard arrow' },
    { id: 'tapered', icon: 'arrowTapered', label: 'Tapered arrow' },
    { id: 'open', icon: 'arrowOpen', label: 'Open arrowhead' },
    { id: 'double', icon: 'arrowDouble', label: 'Double-headed arrow' },
    { id: 'dashed', icon: 'arrowDashed', label: 'Dashed arrow' },
  ],
  spotlight: [
    { id: 'rect', icon: 'rect', label: 'Rectangular spotlight' },
    { id: 'ellipse', icon: 'ellipse', label: 'Round spotlight' },
  ],
};

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
const styles: Partial<Record<ShapeType, string>> = { arrow: 'solid', spotlight: 'rect' };
/** OCR lines as Windows returned them, before merging into rows (used by auto-redact). */
let ocrLines: Word[][] = [];
let textReady: Promise<void> = Promise.resolve();
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
  if (type === 'callout') return CALLOUT_SIZE[i] * unit;
  return STROKE[i] * unit;
}

const selected = () => doc.shapes.find((s) => s.id === selectedId) ?? null;

/** The selection shows (and can be edited) in the select tool, and right after drawing a shape. */
function visibleSelection(): Shape | null {
  const s = selected();
  return s && (tool === 'select' || s.type === tool) ? s : null;
}

const isBox = (t: ShapeType) =>
  t === 'rect' || t === 'ellipse' || t === 'blur' || t === 'pixelate' || t === 'spotlight' || t === 'redact';

// ---------------------------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------------------------

/** Points along a line or arrow; a bent one is sampled along its quadratic curve. */
function linePoints(s: Shape): P[] {
  const a = { x: s.x, y: s.y };
  const b = { x: s.x + s.w, y: s.y + s.h };
  if (!s.bend) return [a, b];
  const c = { x: s.x + s.w / 2 + s.bend.x, y: s.y + s.h / 2 + s.bend.y };
  const pts: P[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48;
    const u = 1 - t;
    pts.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
  }
  return pts;
}

/** Where the curve handle sits: the middle of the curve. */
const bendHandle = (s: Shape): P => ({
  x: s.x + s.w / 2 + (s.bend?.x ?? 0) / 2,
  y: s.y + s.h / 2 + (s.bend?.y ?? 0) / 2,
});

function pathLength(pts: P[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

/** The part of a polyline between two distances along it. */
function slicePath(pts: P[], from: number, to: number): P[] {
  const out: P[] = [];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    const s0 = acc;
    acc += seg;
    if (!seg || acc < from || s0 > to) continue;
    const at = (d: number) => ({ x: a.x + ((b.x - a.x) * (d - s0)) / seg, y: a.y + ((b.y - a.y) * (d - s0)) / seg });
    if (!out.length) out.push(at(Math.max(from, s0)));
    out.push(at(Math.min(to, acc)));
  }
  return out;
}

const pointAlong = (pts: P[], d: number): P => slicePath(pts, d, d)[0] ?? pts[0];

function distToPath(p: P, pts: P[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSeg(p, pts[i], pts[i + 1]));
  return best;
}

// ---------------------------------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------------------------------

/** The bubble around a callout's text. */
function calloutBox(s: Shape): Rect {
  const px = s.width * 0.6;
  const py = s.width * 0.4;
  return { x: s.x - px, y: s.y - py, w: s.w + px * 2, h: s.h + py * 2 };
}

/** The tail triangle, wound the same way as the bubble so that the two fill as one shape. */
function calloutTail(s: Shape): P[] | null {
  const b = calloutBox(s);
  const t = s.tip;
  if (!t || inRect(t, b)) return null;
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const len = Math.hypot(t.x - c.x, t.y - c.y);
  const dx = (t.x - c.x) / len;
  const dy = (t.y - c.y) / len;
  // The tail starts where the line to the tip leaves the bubble (tucked in a little so the two
  // join seamlessly), which keeps it wide at the bubble's edge.
  const toEdge = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  const half = Math.min(b.h * 0.3, b.w * 0.2);
  const back = Math.max(0, toEdge - half * 1.5);
  const base = { x: c.x + dx * back, y: c.y + dy * back };
  const p1 = { x: base.x - dy * half, y: base.y + dx * half };
  const p2 = { x: base.x + dy * half, y: base.y - dx * half };
  // roundRect() runs clockwise on screen, which is a positive signed area with y pointing down.
  const area = (t.x - p1.x) * (p2.y - p1.y) - (p2.x - p1.x) * (t.y - p1.y);
  return area > 0 ? [p1, t, p2] : [p2, t, p1];
}

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
    const lines = await window.api.invoke<Word[][]>('editor:words');
    ocrLines = lines;
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

function strokePath(c: CanvasRenderingContext2D, pts: P[]) {
  if (pts.length < 2) return;
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) c.lineTo(p.x, p.y);
  c.stroke();
}

/** A shaft that widens from a thin tail to the arrowhead. */
function fillTapered(c: CanvasRenderingContext2D, pts: P[], width: number) {
  const total = pathLength(pts);
  if (pts.length < 2 || !total) return;
  const left: P[] = [];
  const right: P[] = [];
  let acc = 0;
  pts.forEach((p, i) => {
    if (i) acc += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const half = width * (0.12 + 0.63 * (acc / total));
    const nx = (-(b.y - a.y) / d) * half;
    const ny = ((b.x - a.x) / d) * half;
    left.push({ x: p.x + nx, y: p.y + ny });
    right.push({ x: p.x - nx, y: p.y - ny });
  });
  c.beginPath();
  c.arc(pts[0].x, pts[0].y, width * 0.12, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  for (const p of [...left, ...right.reverse()]) c.lineTo(p.x, p.y);
  c.closePath();
  c.fill();
}

/** An arrowhead at `tip`, pointing away from `from`. */
function drawHead(c: CanvasRenderingContext2D, tip: P, from: P, head: number, open: boolean) {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const hw = head * (open ? 0.55 : 0.62);
  const bx = tip.x - cos * head;
  const by = tip.y - sin * head;
  c.beginPath();
  c.moveTo(bx - sin * hw, by + cos * hw);
  c.lineTo(tip.x, tip.y);
  c.lineTo(bx + sin * hw, by - cos * hw);
  if (open) {
    c.stroke();
    return;
  }
  c.closePath();
  const lw = c.lineWidth;
  c.lineWidth = Math.max(1, lw * 0.5);
  c.fill();
  c.stroke();
  c.lineWidth = lw;
}

function drawArrow(c: CanvasRenderingContext2D, s: Shape) {
  const pts = linePoints(s);
  const len = pathLength(pts);
  if (len < 1) return;
  const style = s.style ?? 'solid';
  const double = style === 'double';
  const open = style === 'open';
  const head = Math.min(len * (double ? 0.4 : 0.7), Math.max(s.width * 3.4, 12 * unit));
  // Filled heads cover the end of the shaft; an open head needs the shaft to reach the tip.
  const inset = open ? 0 : head * 0.7;
  const shaft = slicePath(pts, double ? inset : 0, len - inset);
  if (style === 'tapered') fillTapered(c, shaft, s.width);
  else {
    if (style === 'dashed') c.setLineDash([s.width * 1.5, s.width * 2.5]);
    strokePath(c, shaft);
    c.setLineDash([]);
  }
  // Aim each head along the last stretch of the path so that it follows a curve.
  drawHead(c, pts[pts.length - 1], pointAlong(pts, len - head), head, open);
  if (double) drawHead(c, pts[0], pointAlong(pts, head), head, false);
}

function drawText(c: CanvasRenderingContext2D, s: Shape, outline = true) {
  const lh = s.width * 1.25;
  const off = (lh - s.width) / 2;
  c.font = font(s.width);
  c.textBaseline = 'top';
  c.lineWidth = Math.max(2, s.width * 0.18);
  c.strokeStyle = isLight(s.color) ? 'rgba(0,0,0,0.85)' : '#ffffff';
  (s.text ?? '').split('\n').forEach((line, i) => {
    const y = s.y + i * lh + off;
    if (outline) c.strokeText(line, s.x, y);
    c.fillText(line, s.x, y);
  });
}

function drawCallout(c: CanvasRenderingContext2D, s: Shape) {
  const b = calloutBox(s);
  c.beginPath();
  c.roundRect(b.x, b.y, b.w, b.h, Math.min(s.width * 0.5, b.h / 2));
  const tail = calloutTail(s);
  if (tail) {
    c.moveTo(tail[0].x, tail[0].y);
    c.lineTo(tail[1].x, tail[1].y);
    c.lineTo(tail[2].x, tail[2].y);
    c.closePath();
  }
  c.fill();
  c.shadowColor = 'transparent';
  c.fillStyle = isLight(s.color) ? '#1c1c1e' : '#ffffff';
  drawText(c, s, false);
}

/** Sets a text or callout shape's size from its text. */
function measureText(s: Shape, text = s.text ?? '') {
  ctx.save();
  ctx.font = font(s.width);
  const lines = text.split('\n');
  const min = s.type === 'callout' ? s.width : 1;
  s.w = Math.max(...lines.map((l) => ctx.measureText(l).width), min);
  s.h = lines.length * s.width * 1.25;
  ctx.restore();
}

let dimCanvas: HTMLCanvasElement | null = null;

/** Dims the image outside every spotlight (together, so that overlapping ones don't stack). */
function paintSpotlights(c: CanvasRenderingContext2D, spots: Shape[]) {
  if (!spots.length) return;
  const cv = (dimCanvas ??= document.createElement('canvas'));
  if (cv.width !== imgW || cv.height !== imgH) {
    cv.width = imgW;
    cv.height = imgH;
  }
  const d = cv.getContext('2d')!;
  d.globalCompositeOperation = 'copy';
  d.fillStyle = 'rgba(0,0,0,0.6)';
  d.fillRect(0, 0, imgW, imgH);
  d.globalCompositeOperation = 'destination-out';
  d.fillStyle = '#000';
  for (const s of spots) {
    const r = norm(s);
    d.beginPath();
    if (s.style === 'ellipse') d.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    else d.roundRect(r.x, r.y, r.w, r.h, Math.min(6 * unit, r.w / 2, r.h / 2));
    d.fill();
  }
  c.drawImage(cv, 0, 0);
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
      strokePath(c, linePoints(s));
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
    case 'callout':
      shadow();
      drawCallout(c, s);
      break;
    case 'redact': {
      const r = norm(s);
      c.beginPath();
      c.roundRect(r.x, r.y, r.w, r.h, Math.min(2 * unit, r.w / 2, r.h / 2));
      c.fill();
      break;
    }
    case 'spotlight':
      // Painted for all spotlights at once by paintSpotlights().
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
      const r = union(linePoints(s).map((p) => ({ ...p, w: 0, h: 0 })));
      const m = s.width / 2;
      return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
    }
    case 'callout':
      return s.tip ? union([calloutBox(s), { ...s.tip, w: 0, h: 0 }]) : calloutBox(s);
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
    return [{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }, bendHandle(s)];
  }
  if (s.type === 'callout') return s.tip ? [s.tip] : [];
  if (isBox(s.type)) {
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
  const s = visibleSelection();
  if (!s || editing?.shape.id === s.id) return;
  const k = 1 / viewScale();
  const b = bbox(s);
  const line = s.type === 'line' || s.type === 'arrow';
  c.save();
  c.strokeStyle = '#4f8cff';
  c.lineWidth = 1.5 * k;
  // Lines and arrows show only their handles; a box around a diagonal line is just noise.
  if (!line || tool === 'select') {
    c.setLineDash([5 * k, 4 * k]);
    c.strokeRect(b.x - 4 * k, b.y - 4 * k, b.w + 8 * k, b.h + 8 * k);
    c.setLineDash([]);
  }
  handles(s).forEach((h, i) => {
    c.fillStyle = '#fff';
    c.beginPath();
    // The round handle bends a line or arrow into a curve.
    if (line && i === 2) c.arc(h.x, h.y, 5.5 * k, 0, Math.PI * 2);
    else c.rect(h.x - 5 * k, h.y - 5 * k, 10 * k, 10 * k);
    c.fill();
    c.stroke();
  });
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
  const list = doc.shapes.filter((s) => s.id !== editing?.shape.id);
  if (action?.kind === 'draw' || action?.kind === 'highlight') list.push(action.shape);
  // A callout keeps its bubble while its text is being typed.
  if (editing?.shape.type === 'callout') list.push({ ...editing.shape, text: '' });
  const spots = list.filter((s) => s.type === 'spotlight');
  // Blur and pixelate redraw image pixels, so they go under the spotlight's dimming.
  const under = spots.length ? list.filter((s) => s.type === 'blur' || s.type === 'pixelate') : [];
  for (const s of under) drawShape(c, s);
  paintSpotlights(c, spots);
  for (const s of list) if (!under.includes(s)) drawShape(c, s);
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

/** Hit test for a rectangle or ellipse: its whole area when filled, otherwise only its outline. */
function hitBox(s: Shape, p: P, tol: number, ellipse: boolean, filled: boolean, stroke: number): boolean {
  const r = norm(s);
  if (!ellipse) {
    const m = tol + stroke / 2;
    if (!inRect(p, r, m)) return false;
    if (filled) return true;
    return !(p.x > r.x + m && p.x < r.x + r.w - m && p.y > r.y + m && p.y < r.y + r.h - m);
  }
  const rx = r.w / 2;
  const ry = r.h / 2;
  if (rx < 1 || ry < 1) return false;
  const d = Math.hypot((p.x - r.x - rx) / rx, (p.y - r.y - ry) / ry);
  const band = (tol + stroke / 2) / Math.min(rx, ry);
  return filled ? d <= 1 + band : Math.abs(d - 1) <= band;
}

function hit(s: Shape, p: P, tol: number): boolean {
  switch (s.type) {
    case 'line':
    case 'arrow':
      return distToPath(p, linePoints(s)) <= s.width / 2 + tol;
    case 'rect':
      return hitBox(s, p, tol, false, !!s.filled, s.width);
    case 'ellipse':
      return hitBox(s, p, tol, true, !!s.filled, s.width);
    // A spotlight is picked by its edge, so that clicks inside it reach the shapes it lights up.
    case 'spotlight':
      return hitBox(s, p, tol, s.style === 'ellipse', false, 4 * unit);
    case 'blur':
    case 'pixelate':
    case 'redact':
      return inRect(p, norm(s), tol);
    case 'callout': {
      if (inRect(p, calloutBox(s), tol)) return true;
      const b = calloutBox(s);
      return !!s.tip && distToSeg(p, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, s.tip) <= tol + s.width * 0.3;
    }
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
  const callout = s.type === 'callout';
  textInput.style.color = callout ? (isLight(s.color) ? '#1c1c1e' : '#ffffff') : s.color;
  textInput.classList.toggle('callout', callout);
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
  if (s.type === 'callout') {
    // Grow the bubble as the text is typed.
    measureText(s, textInput.value);
    render();
  }
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
  const s: Shape = { id: nextId++, type, color, width: sizeFor(type, sizeIdx), x: p.x, y: p.y, w: 0, h: 0 };
  if (styles[type]) s.style = styles[type];
  return s;
}

/** Places a callout's bubble (sized for its current text) centred on `p`. */
function placeCallout(s: Shape, p: P) {
  measureText(s);
  s.x = p.x - s.w / 2;
  s.y = p.y - s.h / 2;
}

function applyHandle(s: Shape, orig: Shape, idx: number, p: P) {
  if (s.type === 'callout') {
    s.tip = { ...p };
    return;
  }
  if ((s.type === 'line' || s.type === 'arrow') && idx === 2) {
    const mid = { x: orig.x + orig.w / 2, y: orig.y + orig.h / 2 };
    const bend = { x: (p.x - mid.x) * 2, y: (p.y - mid.y) * 2 };
    // Snap back to a straight line when the handle is dragged close to it.
    const off = distToSeg(p, { x: orig.x, y: orig.y }, { x: orig.x + orig.w, y: orig.y + orig.h });
    s.bend = off * viewScale() < 6 ? undefined : bend;
    return;
  }
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

/** Where the current pointer press started, in client pixels. */
let downClient: P = { x: 0, y: 0 };

function normalizeBox(s: Shape) {
  if (isBox(s.type)) Object.assign(s, norm(s));
}

/** Index of the visible selection's handle under `p`, or -1. */
function handleAt(p: P): number {
  const sel = visibleSelection();
  if (!sel) return -1;
  return handles(sel).findIndex((h) => Math.hypot(h.x - p.x, h.y - p.y) <= 8 / viewScale());
}

canvas.addEventListener('pointerdown', (e) => {
  if (!ready || e.button !== 0) return;
  if (editing) {
    commitText();
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  downClient = { x: e.clientX, y: e.clientY };
  const p = toImg(e);

  if (tool === 'crop') {
    action = { kind: 'crop', start: p };
    pendingCrop = null;
    updateCropBar();
    return;
  }

  // Handles of the selection work in the select tool and right after drawing a shape.
  const hi = handleAt(p);
  if (hi >= 0) {
    action = { kind: 'handle', idx: hi, orig: clone(selected()!) };
    return;
  }

  if (tool === 'select') {
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

  if (tool === 'text' || tool === 'callout') {
    const s = shapeAt(p);
    if (s?.type === tool) {
      selectedId = null;
      openText(s, false);
      return;
    }
  }

  if (tool === 'text') {
    openText({ ...newShape('text', p), text: '' }, true);
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
  if (tool === 'callout') {
    // Drag from the point of interest to where the bubble goes.
    shape.text = '';
    shape.tip = { ...p };
    placeCallout(shape, p);
  }
  selectedId = null;
  action = { kind: 'draw', shape, start: p };
  render();
});

canvas.addEventListener('dblclick', (e) => {
  if (!ready || tool !== 'select') return;
  const s = shapeAt(toImg(e));
  if (s?.type === 'text' || s?.type === 'callout') openText(s, false);
});

canvas.addEventListener('pointermove', (e) => {
  if (!ready) return;
  const p = toImg(e);
  if (!action) {
    const onHandle = handleAt(p) >= 0;
    if (tool === 'select') canvas.style.cursor = onHandle ? 'crosshair' : shapeAt(p) ? 'move' : 'default';
    else if (tool !== 'crop' && tool !== 'text') canvas.style.cursor = onHandle ? 'grab' : cursorFor(tool);
    return;
  }
  const shift = e.shiftKey || shiftDown;

  switch (action.kind) {
    case 'draw': {
      const s = action.shape;
      if (s.type === 'callout') placeCallout(s, p);
      else if (s.type === 'pen') {
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
      if (action.orig.tip) s.tip = { x: action.orig.tip.x + dx, y: action.orig.tip.y + dy };
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

canvas.addEventListener('pointerup', (e) => {
  if (!action) return;
  const a = action;
  action = null;
  const minSize = 3 / viewScale();
  switch (a.kind) {
    case 'draw': {
      const s = a.shape;
      if (s.type === 'callout') {
        // A click (no drag) puts the bubble up and to the right of the point.
        const tip = s.tip!;
        if (Math.hypot(e.clientX - downClient.x, e.clientY - downClient.y) < 8) {
          placeCallout(s, { x: tip.x + s.width * 5, y: tip.y - s.width * 3.5 });
        }
        openText(s, true);
        return;
      }
      const big = s.type === 'pen' ? true : Math.abs(s.w) >= minSize || Math.abs(s.h) >= minSize;
      if (big) {
        normalizeBox(s);
        doc.shapes.push(s);
        // Keep the new shape selected so that its handles (e.g. an arrow's curve) are right there.
        if (s.type === 'line' || s.type === 'arrow' || isBox(s.type)) selectedId = s.id;
        commit();
        updateToolbar();
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
  const s = visibleSelection();
  if (!s) return;
  fn(s);
  if (s.type === 'text' || s.type === 'callout') measureText(s);
  commit();
  render();
}

/** The shape type whose styles the toolbar offers: the selection's, else the current tool's. */
function styleTarget(): ShapeType | null {
  const s = visibleSelection();
  if (s) return STYLES[s.type] ? s.type : null;
  return tool !== 'select' && tool !== 'crop' && STYLES[tool] ? tool : null;
}

function setStyle(type: ShapeType, id: string) {
  styles[type] = id;
  applyToSelected((s) => {
    if (s.type === type) s.style = id;
  });
  updateToolbar();
}

function cycleStyle() {
  const type = styleTarget();
  if (!type) return;
  const list = STYLES[type]!;
  const cur = visibleSelection()?.style ?? styles[type];
  setStyle(type, list[(list.findIndex((x) => x.id === cur) + 1) % list.length].id);
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
  $('redact').innerHTML = `${svg('redact')}<span>Redact</span>`;
  $('redact').addEventListener('click', autoRedact);
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
  updateStyles();
  ($('undo') as HTMLButtonElement).disabled = !undoStack.length;
  ($('redo') as HTMLButtonElement).disabled = !redoStack.length;
  $('bgToggle').classList.toggle('active', !bgPanel.hidden);
}

/** Shows the style picker for the current tool or selection (arrow and spotlight styles). */
function updateStyles() {
  const box = $('styles');
  const type = styleTarget();
  box.hidden = $('stylesSep').hidden = !type;
  if (!type) return;
  if (box.dataset.type !== type) {
    box.dataset.type = type;
    box.innerHTML = '';
    for (const st of STYLES[type]!) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.style = st.id;
      b.title = `${st.label} (press ${TOOLS.find((t) => t.id === type)!.key.toUpperCase()} again for the next style)`;
      b.innerHTML = svg(st.icon);
      b.addEventListener('click', () => setStyle(type, st.id));
      box.appendChild(b);
    }
  }
  const cur = visibleSelection()?.style ?? styles[type];
  for (const b of Array.from(box.querySelectorAll<HTMLElement>('[data-style]'))) {
    b.classList.toggle('active', b.dataset.style === cur);
  }
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
// Auto-redact
// ---------------------------------------------------------------------------------------------

let redacting = false;

/** Blacks out sensitive text found by OCR, as one undoable step. */
async function autoRedact() {
  if (!ready || redacting) return;
  redacting = true;
  try {
    if (textDetection === 'pending') toast('Reading text…');
    await textReady;
    if (textDetection === 'failed') {
      toast('Text recognition is unavailable, so there is nothing to redact');
      return;
    }
    const existing = doc.shapes.filter((s) => s.type === 'redact');
    const covered = (r: Rect) => existing.some((s) => inRect({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, norm(s)));
    const fresh = findSensitive(ocrLines).filter((f) => !covered(f.box));
    if (!fresh.length) {
      toast(existing.length ? 'Nothing else to redact' : 'No emails, numbers or keys found');
      return;
    }
    const counts = new Map<string, number>();
    for (const f of fresh) {
      doc.shapes.push({ id: nextId++, type: 'redact', color: REDACT_COLOR, width: 0, ...f.box });
      counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    }
    commit();
    render();
    const parts = [...counts].map(([k, n]) => `${n} ${n === 1 ? k : PLURAL[k] ?? k}`);
    toast(`Redacted ${parts.join(', ')}. Ctrl+Z to undo`);
  } finally {
    redacting = false;
  }
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
    snapshot(),
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
  if (!t || e.altKey) return;
  // Pressing an active tool's key again steps through its styles.
  if (t.id === tool && styleTarget()) cycleStyle();
  else setTool(t.id);
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') shiftDown = false;
});

// The stage also changes size when the toolbar wraps onto another row (e.g. as style buttons appear).
new ResizeObserver(() => {
  if (ready) layout();
}).observe(stage);

// ---------------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------------

async function init() {
  buildToolbar();
  buildBgPanel();
  const d = await window.api.invoke<{ name: string; dataUrl: string; scale: number; doc: Doc | null }>(
    'editor:load',
  );
  document.title = `${d.name} — ShotKit Editor`;
  img = new Image();
  img.src = d.dataUrl;
  await img.decode();
  imgW = img.naturalWidth;
  imgH = img.naturalHeight;
  unit = Math.max(1, d.scale || 1);
  if (d.doc) {
    // Annotations saved the last time this capture was edited.
    doc.shapes = d.doc.shapes ?? [];
    doc.crop = d.doc.crop ?? null;
    doc.bg = { ...doc.bg, ...d.doc.bg };
    nextId = Math.max(0, ...doc.shapes.map((s) => s.id)) + 1;
  }
  lastState = snapshot();
  ready = true;
  canvas.style.cursor = cursorFor(tool);
  syncBgPanel();
  updateToolbar();
  updateCropBar();
  paint(ctx, false);
  textReady = detectText();
}

init().catch((e) => toast(`Could not load image: ${e instanceof Error ? e.message : e}`));

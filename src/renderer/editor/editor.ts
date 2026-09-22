// Annotation editor. Shapes are stored in image pixel coordinates; the canvas shows the
// (optionally cropped) image plus an optional "beautify" background, frame and padding.
import { svg } from '../shared/icons';
import { env } from './env';
import { clamp, clone, inRect, intersects, norm, snapAngle, union } from './geometry';
import { loadPrefs, Prefs, readShapeClipboard, savePrefs, writeShapeClipboard } from './prefs';
import { findSensitive, PLURAL } from './redact';
import { ASPECTS, computeView, isDarkArea, onRenderRequest, paintDoc, PRESETS, View } from './render';
import {
  bbox,
  COLORS,
  handles,
  hasText,
  hasTextBox,
  HIGHLIGHTER_DEFAULT,
  hit,
  isBox,
  isLine,
  LINE_HEIGHT,
  measureText,
  OPTIONS,
  REDACT_COLOR,
  SIZE_LABELS,
  sizeFor,
  textWidth,
  TOOLS,
  translate,
} from './shapes';
import { Guides, snapBox, snapPoint } from './snap';
import { Caret, caretAt, detectText, highlightRects, text as ocr } from './textlines';
import { Doc, P, Rect, Shape, ShapeType, Tool, Word } from './types';

type Action =
  | { kind: 'draw'; shape: Shape; start: P }
  | { kind: 'highlight'; shape: Shape; start: P; caret: Caret | null }
  | { kind: 'move'; start: P; origs: Shape[]; moved: boolean }
  | { kind: 'handle'; idx: number; orig: Shape }
  | { kind: 'marquee'; start: P; end: P; base: number[] }
  | { kind: 'crop'; start: P }
  | { kind: 'pan'; x: number; y: number; left: number; top: number };

interface EditorSettings {
  format: 'png' | 'jpg' | 'webp';
  exportScale: 'full' | '1x';
  uploadService: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const stage = $('stage');
const stageWrap = $('stageWrap');
const textInput = $<HTMLTextAreaElement>('textInput');
const cropBar = $('cropBar');
const bgPanel = $('bgPanel');
const menu = $('menu');
const zoomLabel = $('zoomLabel');

let ready = false;
let settings: EditorSettings = { format: 'png', exportScale: 'full', uploadService: 'none' };

const doc: Doc = {
  shapes: [],
  crop: null,
  bg: {
    enabled: false,
    preset: 'ocean',
    padding: 64,
    radius: 12,
    shadow: true,
    aspect: 'auto',
    frame: 'none',
    frameText: '',
    frameTheme: 'auto',
  },
};

const prefs: Prefs = loadPrefs({
  tool: 'arrow',
  color: COLORS[0],
  highlighterColor: HIGHLIGHTER_DEFAULT,
  sizeIdx: 1,
  filled: false,
  opacity: 1,
  options: {},
  customColors: [],
});

let tool: Tool = prefs.tool === 'crop' ? 'arrow' : prefs.tool;
let prevTool: Tool = tool === 'select' ? 'arrow' : tool;
// The highlighter keeps its own colour (yellow by default), separate from the other tools.
let color = tool === 'highlighter' ? prefs.highlighterColor : prefs.color;
let sel: number[] = [];
let nextId = 1;
let action: Action | null = null;
let pendingCrop: Rect | null = null;
let editing: { shape: Shape; isNew: boolean } | null = null;
let shiftDown = false;
let spaceDown = false;
let guides: Guides = {};
/** CSS pixels per device pixel of the canvas; null = fit the window. */
let zoom: number | null = null;
/** Where the current pointer press started, in client pixels. */
let downClient: P = { x: 0, y: 0 };
let pasteCount = 0;

const undoStack: string[] = [];
const redoStack: string[] = [];
let lastState = '';

// ---------------------------------------------------------------------------------------------
// Selection and options
// ---------------------------------------------------------------------------------------------

const byId = (id: number) => doc.shapes.find((s) => s.id === id) ?? null;
const selectedShapes = () => doc.shapes.filter((s) => sel.includes(s.id));
const single = () => (sel.length === 1 ? byId(sel[0]) : null);

/** A single selection shows its handles in the select tool, and right after drawing a shape. */
function visibleSelection(): Shape | null {
  const s = single();
  return s && (tool === 'select' || s.type === tool) ? s : null;
}

/** The shapes that toolbar changes (colour, size, style…) apply to. */
function targets(): Shape[] {
  if (tool === 'select') return selectedShapes();
  const s = visibleSelection();
  return s ? [s] : [];
}

function option(type: ShapeType, key: string): string | undefined {
  return prefs.options[type]?.[key] ?? OPTIONS[type]?.find((g) => g.key === key)?.items[0].id;
}

function savePrefsSoon() {
  prefs.tool = tool === 'crop' ? prevTool : tool;
  if (tool === 'highlighter') prefs.highlighterColor = color;
  else prefs.color = color;
  savePrefs(prefs);
}

// ---------------------------------------------------------------------------------------------
// View mapping, zoom and pan
// ---------------------------------------------------------------------------------------------

const view = (): View => computeView(doc, tool === 'crop');

/** CSS pixels per canvas pixel. */
const viewScale = () => canvas.getBoundingClientRect().width / canvas.width || 1;
env.viewScale = viewScale;

function toImg(e: { clientX: number; clientY: number }): P {
  const r = canvas.getBoundingClientRect();
  const v = view();
  return {
    x: ((e.clientX - r.left) * canvas.width) / r.width - v.imgX + v.base.x,
    y: ((e.clientY - r.top) * canvas.height) / r.height - v.imgY + v.base.y,
  };
}

function toClient(p: P): P {
  const r = canvas.getBoundingClientRect();
  const v = view();
  const k = r.width / canvas.width;
  return { x: r.left + (p.x - v.base.x + v.imgX) * k, y: r.top + (p.y - v.base.y + v.imgY) * k };
}

function fitScale(): number {
  const dpr = window.devicePixelRatio || 1;
  const natW = canvas.width / dpr;
  const natH = canvas.height / dpr;
  return Math.min(1, (stage.clientWidth - 64) / natW, (stage.clientHeight - 64) / natH);
}

function layout() {
  const dpr = window.devicePixelRatio || 1;
  const k = zoom ?? fitScale();
  canvas.style.width = `${Math.max(1, (canvas.width / dpr) * k)}px`;
  canvas.style.height = `${Math.max(1, (canvas.height / dpr) * k)}px`;
  // Show crisp pixels once each image pixel covers two or more screen pixels.
  canvas.classList.toggle('pixelated', k >= 2);
  zoomLabel.textContent = `${Math.round(k * 100)}%`;
  zoomLabel.classList.toggle('fit', zoom === null);
  if (editing) positionTextInput();
}

/** Zooms to `k`, keeping the point under `anchor` (client px; default: the stage's centre) in place. */
function setZoom(k: number | null, anchor?: P) {
  const sr = stage.getBoundingClientRect();
  const a = anchor ?? { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 };
  const r = canvas.getBoundingClientRect();
  const fx = (a.x - r.left) / r.width;
  const fy = (a.y - r.top) / r.height;
  zoom = k === null ? null : clamp(k, 0.05, 16);
  layout();
  const r2 = canvas.getBoundingClientRect();
  stage.scrollLeft += r2.left + fx * r2.width - a.x;
  stage.scrollTop += r2.top + fy * r2.height - a.y;
}

const currentZoom = () => zoom ?? fitScale();

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function shapesToDraw(): Shape[] {
  const list = doc.shapes.filter((s) => s.id !== editing?.shape.id);
  if (action?.kind === 'draw' || action?.kind === 'highlight') list.push(action.shape);
  // A callout or pill keeps its box while its text is being typed.
  if (editing && hasTextBox(editing.shape)) list.push({ ...editing.shape, text: '' });
  return list;
}

function drawSelection(c: CanvasRenderingContext2D) {
  const k = 1 / viewScale();
  const shown = tool === 'select' ? selectedShapes() : [visibleSelection()].filter((s): s is Shape => !!s);
  c.save();
  c.strokeStyle = '#4f8cff';
  c.lineWidth = 1.5 * k;
  for (const s of shown) {
    if (editing?.shape.id === s.id) continue;
    // Lines and arrows being drawn show only their handles; a box around a line is just noise.
    if (tool === 'select' || !isLine(s.type)) {
      const b = bbox(s);
      c.setLineDash([5 * k, 4 * k]);
      c.strokeRect(b.x - 4 * k, b.y - 4 * k, b.w + 8 * k, b.h + 8 * k);
      c.setLineDash([]);
    }
  }
  const s = visibleSelection();
  if (s && editing?.shape.id !== s.id) {
    handles(s).forEach((h, i) => {
      c.fillStyle = '#fff';
      c.beginPath();
      // Round handles bend a line or arrow, or move what a magnifier magnifies.
      if ((isLine(s.type) && i === 2) || (s.type === 'magnifier' && i === 4) || s.type === 'callout') {
        c.arc(h.x, h.y, 5.5 * k, 0, Math.PI * 2);
      } else c.rect(h.x - 5 * k, h.y - 5 * k, 10 * k, 10 * k);
      c.fill();
      c.stroke();
    });
  }
  if (action?.kind === 'marquee') {
    const r = norm({ x: action.start.x, y: action.start.y, w: action.end.x - action.start.x, h: action.end.y - action.start.y });
    c.fillStyle = 'rgba(79,140,255,0.12)';
    c.fillRect(r.x, r.y, r.w, r.h);
    c.strokeRect(r.x, r.y, r.w, r.h);
  }
  c.restore();
}

function drawGuides(c: CanvasRenderingContext2D, v: View) {
  if (guides.x === undefined && guides.y === undefined) return;
  const k = 1 / viewScale();
  const b = v.base;
  c.save();
  c.strokeStyle = '#ff2d95';
  c.lineWidth = k;
  c.beginPath();
  if (guides.x !== undefined) {
    c.moveTo(guides.x, b.y);
    c.lineTo(guides.x, b.y + b.h);
  }
  if (guides.y !== undefined) {
    c.moveTo(b.x, guides.y);
    c.lineTo(b.x + b.w, guides.y);
  }
  c.stroke();
  c.restore();
}

function drawCropUI(c: CanvasRenderingContext2D) {
  if (tool !== 'crop' || !pendingCrop) return;
  const r = norm(pendingCrop);
  const k = 1 / viewScale();
  c.save();
  c.fillStyle = 'rgba(0,0,0,0.55)';
  c.beginPath();
  c.rect(0, 0, env.imgW, env.imgH);
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

function paint() {
  const v = view();
  if (canvas.width !== v.W || canvas.height !== v.H) {
    canvas.width = v.W;
    canvas.height = v.H;
    layout();
  }
  paintDoc(ctx, doc, v, shapesToDraw());
  ctx.save();
  ctx.translate(v.imgX - v.base.x, v.imgY - v.base.y);
  drawSelection(ctx);
  drawGuides(ctx, v);
  drawCropUI(ctx);
  ctx.restore();
}

let frame = 0;
function render() {
  if (!ready || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    paint();
  });
}
onRenderRequest(render);

// ---------------------------------------------------------------------------------------------
// Hit testing and snapping
// ---------------------------------------------------------------------------------------------

function shapeAt(p: P): Shape | null {
  const tol = 6 / viewScale();
  for (let i = doc.shapes.length - 1; i >= 0; i--) if (hit(doc.shapes[i], p, tol)) return doc.shapes[i];
  return null;
}

/** Index of the visible selection's handle under `p`, or -1. */
function handleAt(p: P): number {
  const s = visibleSelection();
  if (!s) return -1;
  return handles(s).findIndex((h) => Math.hypot(h.x - p.x, h.y - p.y) <= 8 / viewScale());
}

/** What shapes snap to: the other shapes and the image's edges and centre. */
function snapTargets(exclude: number[]): Rect[] {
  const b = view().base;
  return [b, ...doc.shapes.filter((s) => !exclude.includes(s.id) && s.type !== 'pen').map(bbox)];
}

const snapTol = () => 6 / viewScale();

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
  sel = sel.filter((id) => byId(id));
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

const contrast = (hex: string) => (isLightColor(hex) ? '#1c1c1e' : '#ffffff');

function isLightColor(hex: string): boolean {
  const n = parseInt(hex.slice(1, 7), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 170;
}

function positionTextInput() {
  if (!editing) return;
  const s = editing.shape;
  const k = viewScale();
  const p = toClient({ x: s.x, y: s.y });
  const st = stage.getBoundingClientRect();
  textInput.style.left = `${p.x - st.left + stage.scrollLeft - 1}px`;
  textInput.style.top = `${p.y - st.top + stage.scrollTop - 1}px`;
  textInput.style.fontSize = `${s.width * k}px`;
  const boxed = hasTextBox(s);
  textInput.style.color = boxed ? contrast(s.color) : s.color;
  textInput.style.textAlign = s.align ?? 'left';
  textInput.classList.toggle('boxed', boxed);
  autosizeText();
}

function autosizeText() {
  if (!editing) return;
  const s = editing.shape;
  const k = viewScale();
  const lines = textInput.value.split('\n');
  const w = Math.max(...lines.map((l) => textWidth(l, s.width)), s.width);
  textInput.style.width = `${w * k + s.width * k * 0.8 + 4}px`;
  textInput.style.height = `${lines.length * s.width * LINE_HEIGHT * k + 2}px`;
  if (hasTextBox(s) || s.align === 'center' || s.align === 'right') {
    // Grow the bubble (and keep alignment right) as the text is typed.
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
  const value = textInput.value.replace(/\s+$/, '');
  if (!value) {
    if (!isNew) doc.shapes = doc.shapes.filter((x) => x.id !== shape.id);
  } else {
    shape.text = value;
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
// Creating and editing shapes
// ---------------------------------------------------------------------------------------------

function newShape(type: ShapeType, p: P): Shape {
  const s: Shape = {
    id: nextId++,
    type,
    color: type === 'redact' ? REDACT_COLOR : color,
    width: sizeFor(type, prefs.sizeIdx),
    x: p.x,
    y: p.y,
    w: 0,
    h: 0,
  };
  const style = option(type, 'style');
  if (style) s.style = style;
  const align = option(type, 'align');
  if (align && align !== 'left') s.align = align;
  if (prefs.opacity < 1 && type !== 'redact' && type !== 'blur' && type !== 'pixelate') s.opacity = prefs.opacity;
  return s;
}

/** Places a callout's bubble (sized for its current text) centred on `p`. */
function placeCallout(s: Shape, p: P) {
  measureText(s);
  s.x = p.x - s.w / 2;
  s.y = p.y - s.h / 2;
}

const nextCounter = () => Math.max(0, ...doc.shapes.filter((s) => s.type === 'counter').map((s) => s.n ?? 0)) + 1;

/** Numbers steps 1, 2, 3… in their current order, closing gaps left by deleted steps. */
function renumberCounters() {
  doc.shapes
    .filter((s) => s.type === 'counter')
    .sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
    .forEach((s, i) => (s.n = i + 1));
}

function applyHandle(s: Shape, orig: Shape, idx: number, p: P) {
  if (s.type === 'callout' || (s.type === 'magnifier' && idx === 4)) {
    s.tip = { ...p };
    return;
  }
  if (isLine(s.type) && idx === 2) {
    const mid = { x: orig.x + orig.w / 2, y: orig.y + orig.h / 2 };
    const bend = { x: (p.x - mid.x) * 2, y: (p.y - mid.y) * 2 };
    // Snap back to a straight line when the handle is dragged close to it.
    const a = { x: orig.x, y: orig.y };
    const b = { x: orig.x + orig.w, y: orig.y + orig.h };
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const off = Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / len;
    s.bend = off * viewScale() < 6 ? undefined : bend;
    return;
  }
  if (isLine(s.type)) {
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
  if (s.type === 'magnifier' || s.type === 'stamp') squareUp(s);
}

/** Makes a box square, keeping the corner at (x, y) and the drag direction. */
function squareUp(s: Shape) {
  const m = Math.max(Math.abs(s.w), Math.abs(s.h));
  s.w = Math.sign(s.w || 1) * m;
  s.h = Math.sign(s.h || 1) * m;
}

function normalizeBox(s: Shape) {
  if (isBox(s.type)) Object.assign(s, norm(s));
}

function deleteSelected() {
  if (!sel.length) return;
  const hadCounter = selectedShapes().some((s) => s.type === 'counter');
  doc.shapes = doc.shapes.filter((s) => !sel.includes(s.id));
  sel = [];
  if (hadCounter) renumberCounters();
  commit();
  render();
}

/** Adds copies of `shapes`, offset by `d`, and selects them. */
function addCopies(shapes: Shape[], d: number) {
  if (!shapes.length) return;
  if (tool !== 'select') setTool('select');
  const ids: number[] = [];
  let n = nextCounter();
  for (const s of shapes) {
    const c = clone(s);
    c.id = nextId++;
    translate(c, s, d, d);
    if (c.type === 'counter') c.n = n++;
    doc.shapes.push(c);
    ids.push(c.id);
  }
  sel = ids;
  commit();
  render();
}

function copyShapes(cut: boolean) {
  const shapes = selectedShapes();
  if (!shapes.length) return;
  writeShapeClipboard(JSON.stringify(shapes));
  pasteCount = 0;
  if (cut) deleteSelected();
  else toast(`Copied ${shapes.length} shape${shapes.length === 1 ? '' : 's'}`);
}

function pasteShapes(): boolean {
  let shapes: Shape[];
  try {
    shapes = JSON.parse(readShapeClipboard() ?? '[]');
  } catch {
    return false;
  }
  if (!Array.isArray(shapes) || !shapes.length) return false;
  pasteCount++;
  addCopies(shapes, 12 * env.unit * pasteCount);
  return true;
}

type Arrange = 'front' | 'forward' | 'backward' | 'back';

function arrange(how: Arrange) {
  if (!sel.length) return;
  const on = (s: Shape) => sel.includes(s.id);
  const a = doc.shapes;
  if (how === 'front') doc.shapes = [...a.filter((s) => !on(s)), ...a.filter(on)];
  else if (how === 'back') doc.shapes = [...a.filter(on), ...a.filter((s) => !on(s))];
  else if (how === 'forward') {
    for (let i = a.length - 2; i >= 0; i--) if (on(a[i]) && !on(a[i + 1])) [a[i], a[i + 1]] = [a[i + 1], a[i]];
  } else {
    for (let i = 1; i < a.length; i++) if (on(a[i]) && !on(a[i - 1])) [a[i], a[i - 1]] = [a[i - 1], a[i]];
  }
  commit();
  render();
}

function nudge(dx: number, dy: number) {
  const shapes = targets();
  if (!shapes.length) return;
  for (const s of shapes) translate(s, clone(s), dx, dy);
  commit();
  render();
}

// ---------------------------------------------------------------------------------------------
// Pointer interaction
// ---------------------------------------------------------------------------------------------

function cursorFor(t: Tool) {
  if (spaceDown) return 'grab';
  return t === 'select' ? 'default' : t === 'text' ? 'text' : 'crosshair';
}

canvas.addEventListener('pointerdown', (e) => {
  if (!ready) return;
  hideMenu();
  // Middle button, or Space + drag: pan.
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    action = { kind: 'pan', x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    canvas.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;
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
    action = { kind: 'handle', idx: hi, orig: clone(single()!) };
    return;
  }

  if (tool === 'select') {
    const s = shapeAt(p);
    if (s && e.shiftKey) {
      sel = sel.includes(s.id) ? sel.filter((id) => id !== s.id) : [...sel, s.id];
    } else if (s) {
      if (!sel.includes(s.id)) sel = [s.id];
      if (sel.length === 1) color = s.color;
      action = { kind: 'move', start: p, origs: selectedShapes().map(clone), moved: false };
    } else {
      // Drag on empty space: select everything the box touches (Shift adds to the selection).
      const base = e.shiftKey ? sel : [];
      sel = base;
      action = { kind: 'marquee', start: p, end: p, base };
    }
    updateToolbar();
    render();
    return;
  }

  if (tool === 'text' || tool === 'callout') {
    const s = shapeAt(p);
    if (s?.type === tool) {
      sel = [];
      openText(s, false);
      return;
    }
  }

  if (tool === 'text') {
    openText({ ...newShape('text', p), text: '' }, true);
    return;
  }

  if (tool === 'counter') {
    doc.shapes.push({ ...newShape('counter', p), n: nextCounter() });
    commit();
    render();
    return;
  }

  if (tool === 'highlighter') {
    const a: Action = { kind: 'highlight', shape: newShape('highlighter', p), start: p, caret: caretAt(p, true) };
    sel = [];
    updateHighlight(a, p);
    action = a;
    render();
    return;
  }

  const shape = newShape(tool, p);
  if (tool === 'pen') shape.points = [p];
  if (tool === 'rect' || tool === 'ellipse') shape.filled = prefs.filled;
  if (tool === 'callout') {
    // Drag from the point of interest to where the bubble goes.
    shape.text = '';
    shape.tip = { ...p };
    placeCallout(shape, p);
  }
  sel = [];
  action = { kind: 'draw', shape, start: p };
  render();
});

canvas.addEventListener('dblclick', (e) => {
  if (!ready || tool !== 'select') return;
  const s = shapeAt(toImg(e));
  if (s && hasText(s.type)) openText(s, false);
});

canvas.addEventListener('pointermove', (e) => {
  if (!ready) return;
  if (action?.kind === 'pan') {
    stage.scrollLeft = action.left - (e.clientX - action.x);
    stage.scrollTop = action.top - (e.clientY - action.y);
    return;
  }
  const p = toImg(e);
  if (!action) {
    const onHandle = handleAt(p) >= 0;
    if (spaceDown) canvas.style.cursor = 'grab';
    else if (tool === 'select') canvas.style.cursor = onHandle ? 'crosshair' : shapeAt(p) ? 'move' : 'default';
    else if (tool !== 'crop' && tool !== 'text') canvas.style.cursor = onHandle ? 'grab' : cursorFor(tool);
    return;
  }
  const shift = e.shiftKey || shiftDown;
  // Hold Alt to place things freely, without snapping.
  const snap = !e.altKey;
  guides = {};

  switch (action.kind) {
    case 'draw': {
      const s = action.shape;
      if (s.type === 'callout') placeCallout(s, p);
      else if (s.type === 'pen') {
        const last = s.points![s.points!.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) * viewScale() >= 2) s.points!.push(p);
      } else {
        let end = p;
        if (isLine(s.type) && shift) {
          const v = snapAngle(p.x - action.start.x, p.y - action.start.y);
          end = { x: action.start.x + v.x, y: action.start.y + v.y };
        } else if (snap) {
          const r = snapPoint(p, snapTargets([s.id]), snapTol());
          end = r.p;
          guides = r.guides;
        }
        s.w = end.x - action.start.x;
        s.h = end.y - action.start.y;
        if (!isLine(s.type) && (shift || s.type === 'magnifier' || s.type === 'stamp')) squareUp(s);
      }
      break;
    }
    case 'highlight':
      updateHighlight(action, p);
      break;
    case 'move': {
      let dx = p.x - action.start.x;
      let dy = p.y - action.start.y;
      if (!action.moved && Math.hypot(dx, dy) * viewScale() < 2) break;
      action.moved = true;
      if (shift) {
        // Shift keeps the move horizontal or vertical.
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (snap) {
        const box = union(action.origs.map(bbox));
        const r = snapBox({ ...box, x: box.x + dx, y: box.y + dy }, snapTargets(sel), snapTol());
        dx += r.dx;
        dy += r.dy;
        guides = r.guides;
      }
      for (const o of action.origs) {
        const s = byId(o.id);
        if (s) translate(s, o, dx, dy);
      }
      break;
    }
    case 'handle': {
      const s = single();
      if (!s) break;
      let q = p;
      const curveHandle = (isLine(s.type) && action.idx === 2) || s.type === 'callout';
      if (isLine(s.type) && !curveHandle && shift) {
        // Keep the other end fixed and snap the angle.
        const o = action.orig;
        const fixed = action.idx === 0 ? { x: o.x + o.w, y: o.y + o.h } : { x: o.x, y: o.y };
        const v = snapAngle(p.x - fixed.x, p.y - fixed.y);
        q = { x: fixed.x + v.x, y: fixed.y + v.y };
      } else if (snap && !curveHandle) {
        const r = snapPoint(p, snapTargets([s.id]), snapTol());
        q = r.p;
        guides = r.guides;
      }
      applyHandle(s, action.orig, action.idx, q);
      break;
    }
    case 'marquee': {
      action.end = p;
      const r = norm({ x: action.start.x, y: action.start.y, w: p.x - action.start.x, h: p.y - action.start.y });
      const inside = doc.shapes.filter((s) => intersects(bbox(s), r)).map((s) => s.id);
      sel = [...new Set([...action.base, ...inside])];
      break;
    }
    case 'crop': {
      const x1 = clamp(action.start.x, 0, env.imgW);
      const y1 = clamp(action.start.y, 0, env.imgH);
      const x2 = clamp(p.x, 0, env.imgW);
      const y2 = clamp(p.y, 0, env.imgH);
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
  guides = {};
  const minSize = 3 / viewScale();
  const clicked = Math.hypot(e.clientX - downClient.x, e.clientY - downClient.y) < 5;
  switch (a.kind) {
    case 'pan':
      canvas.style.cursor = cursorFor(tool);
      return;
    case 'draw': {
      const s = a.shape;
      if (s.type === 'callout') {
        // A click (no drag) puts the bubble up and to the right of the point.
        const tip = s.tip!;
        if (clicked) placeCallout(s, { x: tip.x + s.width * 5, y: tip.y - s.width * 3.5 });
        openText(s, true);
        return;
      }
      if ((s.type === 'stamp' || s.type === 'magnifier') && clicked) {
        // A click places one at the default size.
        const d = s.type === 'magnifier' ? s.width * 2 : s.width;
        Object.assign(s, { x: a.start.x - d / 2, y: a.start.y - d / 2, w: d, h: d });
      }
      if (s.type === 'magnifier') {
        normalizeBox(s);
        s.tip = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
      }
      const big = s.type === 'pen' || Math.abs(s.w) >= minSize || Math.abs(s.h) >= minSize;
      if (big) {
        normalizeBox(s);
        doc.shapes.push(s);
        // Keep the new shape selected so that its handles (e.g. an arrow's curve) are right there.
        // Not stamps: picking the next stamp would otherwise change the one just placed.
        if (isLine(s.type) || (isBox(s.type) && s.type !== 'stamp')) sel = [s.id];
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
      if (a.moved) commit();
      break;
    case 'handle': {
      const s = single();
      if (s) normalizeBox(s);
      commit();
      break;
    }
    case 'marquee':
      break;
    case 'crop':
      if (pendingCrop && (pendingCrop.w < 4 || pendingCrop.h < 4)) pendingCrop = null;
      updateCropBar();
      break;
  }
  updateToolbar();
  render();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!ready || editing) return;
  const s = shapeAt(toImg(e));
  if (!s) {
    hideMenu();
    return;
  }
  if (!sel.includes(s.id)) {
    if (tool !== 'select') setTool('select');
    sel = [s.id];
  } else if (tool !== 'select') setTool('select');
  updateToolbar();
  render();
  showMenu(e.clientX, e.clientY);
});

stage.addEventListener(
  'wheel',
  (e) => {
    if (!ready || !e.ctrlKey) return;
    // Ctrl + wheel (and touchpad pinch) zooms around the pointer.
    e.preventDefault();
    setZoom(currentZoom() * Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
  },
  { passive: false },
);

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

// ---------------------------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------------------------

const MENU: ([string, string, () => void] | null)[] = [
  ['Duplicate', 'Ctrl+D', () => addCopies(selectedShapes(), 12 * env.unit)],
  ['Copy', 'Ctrl+C', () => copyShapes(false)],
  ['Cut', 'Ctrl+X', () => copyShapes(true)],
  null,
  ['Bring to front', 'Ctrl+]', () => arrange('front')],
  ['Bring forward', ']', () => arrange('forward')],
  ['Send backward', '[', () => arrange('backward')],
  ['Send to back', 'Ctrl+[', () => arrange('back')],
  null,
  ['Delete', 'Del', deleteSelected],
];

function buildMenu() {
  for (const item of MENU) {
    if (!item) {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'msep' }));
      continue;
    }
    const [label, key, run] = item;
    const b = document.createElement('button');
    b.innerHTML = `<span>${label}</span><kbd>${key}</kbd>`;
    b.addEventListener('click', () => {
      hideMenu();
      run();
    });
    menu.appendChild(b);
  }
}

function showMenu(x: number, y: number) {
  const wr = stageWrap.getBoundingClientRect();
  menu.hidden = false;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.min(x - wr.left, wr.width - mw - 8)}px`;
  menu.style.top = `${Math.min(y - wr.top, wr.height - mh - 8)}px`;
}

const hideMenu = () => (menu.hidden = true);
window.addEventListener('pointerdown', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) hideMenu();
});

// ---------------------------------------------------------------------------------------------
// Tools and toolbar
// ---------------------------------------------------------------------------------------------

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
    prefs.color = color;
    color = prefs.highlighterColor;
    if (ocr.status === 'pending') toast('Detecting text… highlights will snap to text in a moment');
    else if (ocr.status === 'done' && !ocr.lines.length) toast('No text found — the highlighter will draw straight bars');
  } else if (tool === 'highlighter') {
    prefs.highlighterColor = color;
    color = prefs.color;
  }
  tool = t;
  if (t !== 'select') sel = [];
  canvas.style.cursor = cursorFor(t);
  savePrefsSoon();
  updateToolbar();
  updateCropBar();
  render();
}

function updateCropBar() {
  cropBar.hidden = tool !== 'crop';
  $('dragOut').hidden = tool === 'crop';
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

function applyToSelected(fn: (s: Shape) => void, save = true) {
  const shapes = targets();
  if (!shapes.length) return;
  for (const s of shapes) {
    fn(s);
    if (hasText(s.type)) measureText(s);
  }
  if (save) commit();
  render();
}

function setColor(c: string) {
  color = c;
  applyToSelected((s) => (s.color = c));
  savePrefsSoon();
  updateToolbar();
}

function addCustomColor(c: string) {
  prefs.customColors = [c, ...prefs.customColors.filter((x) => x !== c)].slice(0, 3);
  buildSwatches();
  setColor(c);
}

function setSize(i: number) {
  prefs.sizeIdx = i;
  applyToSelected((s) => {
    if (s.type === 'redact' || s.type === 'blur' || s.type === 'pixelate' || s.type === 'spotlight') return;
    if (s.type === 'stamp' || s.type === 'magnifier') {
      // Resize around the centre.
      const d = s.type === 'magnifier' ? sizeFor(s.type, i) * 2 : sizeFor(s.type, i);
      const r = norm(s);
      Object.assign(s, { x: r.x + r.w / 2 - d / 2, y: r.y + r.h / 2 - d / 2, w: d, h: d, width: sizeFor(s.type, i) });
      return;
    }
    s.width = sizeFor(s.type, i);
  });
  savePrefsSoon();
  updateToolbar();
}

function toggleFill() {
  prefs.filled = !prefs.filled;
  applyToSelected((s) => {
    if (s.type === 'rect' || s.type === 'ellipse') s.filled = prefs.filled;
  });
  savePrefsSoon();
  updateToolbar();
}

/** The shape type whose options the toolbar offers: the selection's, else the current tool's. */
function optionTarget(): ShapeType | null {
  const shapes = targets();
  if (shapes.length) {
    const t = shapes[0].type;
    return OPTIONS[t] && shapes.every((s) => s.type === t) ? t : null;
  }
  return tool !== 'select' && tool !== 'crop' && OPTIONS[tool] ? tool : null;
}

function currentOption(type: ShapeType, key: 'style' | 'align'): string | undefined {
  const s = targets().find((x) => x.type === type);
  if (s) return (key === 'align' ? s.align ?? 'left' : s.style) ?? option(type, key);
  return option(type, key);
}

function setOption(type: ShapeType, key: 'style' | 'align', id: string) {
  (prefs.options[type] ??= {})[key] = id;
  applyToSelected((s) => {
    if (s.type !== type) return;
    if (key === 'align') s.align = id === 'left' ? undefined : id;
    else {
      s.style = id;
      // Elbow arrows route themselves.
      if (isLine(s.type) && id === 'elbow') s.bend = undefined;
    }
  });
  savePrefsSoon();
  updateToolbar();
}

/** Steps through the first option group of the current tool or selection. */
function cycleStyle() {
  const type = optionTarget();
  const group = type && OPTIONS[type]?.[0];
  if (!type || !group) return;
  const cur = currentOption(type, group.key);
  setOption(type, group.key, group.items[(group.items.findIndex((x) => x.id === cur) + 1) % group.items.length].id);
}

function setOpacity(v: number, save: boolean) {
  prefs.opacity = clamp(v, 0.1, 1);
  applyToSelected((s) => {
    if (s.type === 'redact' || s.type === 'blur' || s.type === 'pixelate') return;
    s.opacity = prefs.opacity < 1 ? prefs.opacity : undefined;
  }, save);
  if (save) savePrefsSoon();
  ($('opacity') as HTMLInputElement).value = String(Math.round(prefs.opacity * 100));
  $('opacityValue').textContent = `${Math.round(prefs.opacity * 100)}%`;
}

function buildSwatches() {
  const box = $('colors');
  box.innerHTML = '';
  for (const c of [...COLORS, ...prefs.customColors.filter((x) => !COLORS.includes(x))]) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => setColor(c));
    box.appendChild(b);
  }
  const custom = document.createElement('label');
  custom.className = 'tool mini';
  custom.title = 'Custom colour';
  custom.innerHTML = `${svg('plus')}<input type="color" id="colorInput">`;
  const input = custom.querySelector('input')!;
  input.addEventListener('change', () => addCustomColor(input.value));
  box.appendChild(custom);
  if ('EyeDropper' in window) {
    const b = document.createElement('button');
    b.className = 'tool mini';
    b.title = 'Pick a colour from the screen (I)';
    b.innerHTML = svg('eyedropper');
    b.addEventListener('click', pickColor);
    box.appendChild(b);
  }
  updateToolbar();
}

async function pickColor() {
  try {
    const r = await new (window as any).EyeDropper().open();
    if (r?.sRGBHex) addCustomColor(r.sRGBHex);
  } catch {
    // Cancelled with Esc.
  }
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
  buildSwatches();

  const sizes = $('sizes');
  SIZE_LABELS.forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'tool size';
    b.dataset.size = String(i);
    b.title = `${label} (${i + 1})`;
    const d = 4 + i * 3;
    b.innerHTML = `<span style="width:${d}px;height:${d}px"></span>`;
    b.addEventListener('click', () => setSize(i));
    sizes.appendChild(b);
  });

  $('fill').innerHTML = svg('fill');
  $('fill').addEventListener('click', toggleFill);
  $('opacityIcon').innerHTML = svg('opacity');
  const op = $<HTMLInputElement>('opacity');
  op.addEventListener('input', () => setOpacity(Number(op.value) / 100, false));
  op.addEventListener('change', () => setOpacity(Number(op.value) / 100, true));
  $('undo').innerHTML = svg('undo');
  $('undo').addEventListener('click', undo);
  $('redo').innerHTML = svg('redo');
  $('redo').addEventListener('click', redo);
  $('redact').innerHTML = `${svg('redact')}<span>Redact</span>`;
  $('redact').addEventListener('click', autoRedact);
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
  zoomLabel.addEventListener('click', () => setZoom(zoom === null ? 1 : null));
  const dragOut = $('dragOut');
  dragOut.innerHTML = `${svg('grip')}<span>Drag me</span>${svg('grip')}`;
  dragOut.addEventListener('dragstart', dragImageOut);
  buildMenu();
}

function updateToolbar() {
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-tool]'))) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-color]'))) {
    b.classList.toggle('active', b.dataset.color === color);
  }
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-size]'))) {
    b.classList.toggle('active', b.dataset.size === String(prefs.sizeIdx));
  }
  $('fill').classList.toggle('active', prefs.filled);
  updateOptions();
  ($('undo') as HTMLButtonElement).disabled = !undoStack.length;
  ($('redo') as HTMLButtonElement).disabled = !redoStack.length;
  $('bgToggle').classList.toggle('active', !bgPanel.hidden);
}

/** Shows the option buttons (styles, alignment) for the current tool or selection. */
function updateOptions() {
  const box = $('styles');
  const type = optionTarget();
  box.hidden = $('stylesSep').hidden = !type;
  if (!type) return;
  if (box.dataset.type !== type) {
    box.dataset.type = type;
    box.innerHTML = '';
    const key = TOOLS.find((t) => t.id === type)?.key.toUpperCase();
    OPTIONS[type]!.forEach((group, gi) => {
      if (gi) box.appendChild(Object.assign(document.createElement('div'), { className: 'sep small' }));
      for (const o of group.items) {
        const b = document.createElement('button');
        b.className = `tool${o.text ? ' textopt' : ''}`;
        b.dataset.group = group.key;
        b.dataset.opt = o.id;
        b.title = gi === 0 && key ? `${o.label} (press ${key} again for the next one)` : o.label;
        b.innerHTML = o.icon ? svg(o.icon) : `<span>${o.text}</span>`;
        b.addEventListener('click', () => setOption(type, group.key, o.id));
        box.appendChild(b);
      }
    });
  }
  for (const group of OPTIONS[type]!) {
    const cur = currentOption(type, group.key);
    for (const b of Array.from(box.querySelectorAll<HTMLElement>(`[data-group="${group.key}"]`))) {
      b.classList.toggle('active', b.dataset.opt === cur);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Background panel
// ---------------------------------------------------------------------------------------------

function bgChanged(save = true) {
  if (!doc.bg.enabled) {
    doc.bg.enabled = true;
    $<HTMLInputElement>('bgEnabled').checked = true;
  }
  if (save) commit();
  syncBgPanel();
  render();
}

/** Reads a picture and shrinks it to a reasonable size for a background. */
async function loadBackgroundImage(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k);
  cv.height = Math.round(bmp.height * k);
  cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.9);
}

function buildBgPanel() {
  const sw = $('bgSwatches');
  const swatch = (id: string, style: string, title: string) => {
    const b = document.createElement('button');
    b.className = 'bgswatch';
    b.dataset.preset = id;
    b.title = title;
    b.style.background = style;
    sw.appendChild(b);
    return b;
  };
  for (const p of PRESETS) {
    swatch(p.id, p.solid ?? `linear-gradient(135deg, ${p.stops!.join(', ')})`, p.id).addEventListener('click', () => {
      doc.bg.preset = p.id;
      bgChanged();
    });
  }
  swatch('blurred', 'linear-gradient(135deg,#555,#999)', 'Blurred screenshot').addEventListener('click', () => {
    doc.bg.preset = 'blurred';
    bgChanged();
  });
  sw.querySelector('[data-preset="blurred"]')!.innerHTML = svg('blur');

  const colorInput = $<HTMLInputElement>('bgColor');
  const customBtn = swatch('custom', 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)', 'Custom colour');
  customBtn.addEventListener('click', () => colorInput.click());
  colorInput.addEventListener('input', () => {
    doc.bg.preset = 'custom';
    doc.bg.color = colorInput.value;
    bgChanged(false);
  });
  colorInput.addEventListener('change', () => commit());

  const fileInput = $<HTMLInputElement>('bgFile');
  const imageBtn = swatch('image', '#2c2c31', 'Your own picture');
  imageBtn.innerHTML = svg('image');
  imageBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    try {
      doc.bg.image = await loadBackgroundImage(f);
      doc.bg.preset = 'image';
      bgChanged();
    } catch {
      toast('Could not read that picture');
    }
  });

  const enabled = $<HTMLInputElement>('bgEnabled');
  enabled.addEventListener('change', () => {
    doc.bg.enabled = enabled.checked;
    commit();
    render();
  });
  const shadow = $<HTMLInputElement>('bgShadow');
  shadow.addEventListener('change', () => {
    doc.bg.shadow = shadow.checked;
    commit();
    render();
  });
  for (const [id, key] of [
    ['bgPadding', 'padding'],
    ['bgRadius', 'radius'],
  ] as const) {
    const el = $<HTMLInputElement>(id);
    el.addEventListener('input', () => {
      doc.bg[key] = Number(el.value);
      bgChanged(false);
    });
    el.addEventListener('change', commit);
  }

  const aspect = $<HTMLSelectElement>('bgAspect');
  aspect.innerHTML = ASPECTS.map((a) => `<option value="${a}">${a === 'auto' ? 'Fit the screenshot' : a}</option>`).join('');
  aspect.addEventListener('change', () => {
    doc.bg.aspect = aspect.value;
    bgChanged();
  });

  // The frame works with or without the background.
  const frame = $<HTMLSelectElement>('bgFrame');
  frame.addEventListener('change', () => {
    doc.bg.frame = frame.value as Doc['bg']['frame'];
    commit();
    syncBgPanel();
    render();
  });
  const frameText = $<HTMLInputElement>('bgFrameText');
  frameText.addEventListener('input', () => {
    doc.bg.frameText = frameText.value;
    render();
  });
  frameText.addEventListener('change', commit);
  frameText.addEventListener('keydown', (e) => e.stopPropagation());
  const theme = $<HTMLSelectElement>('bgFrameTheme');
  theme.addEventListener('change', () => {
    doc.bg.frameTheme = theme.value as 'auto';
    commit();
    render();
  });
}

function syncBgPanel() {
  const bg = doc.bg;
  $<HTMLInputElement>('bgEnabled').checked = bg.enabled;
  $<HTMLInputElement>('bgPadding').value = String(bg.padding);
  $<HTMLInputElement>('bgRadius').value = String(bg.radius);
  $<HTMLInputElement>('bgShadow').checked = bg.shadow;
  $<HTMLSelectElement>('bgAspect').value = bg.aspect ?? 'auto';
  $<HTMLSelectElement>('bgFrame').value = bg.frame ?? 'none';
  $<HTMLInputElement>('bgFrameText').value = bg.frameText ?? '';
  $<HTMLSelectElement>('bgFrameTheme').value = bg.frameTheme ?? 'auto';
  const framed = (bg.frame ?? 'none') !== 'none';
  $('frameOptions').hidden = !framed;
  $<HTMLInputElement>('bgFrameText').placeholder = bg.frame === 'browser' ? 'Address, e.g. example.com' : 'Window title';
  if (bg.color) $<HTMLInputElement>('bgColor').value = bg.color;
  for (const b of Array.from(document.querySelectorAll<HTMLElement>('[data-preset]'))) {
    b.classList.toggle('active', b.dataset.preset === bg.preset);
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
    if (ocr.status === 'pending') toast('Reading text…');
    await ocr.ready;
    if (ocr.status === 'failed') {
      toast('Text recognition is unavailable, so there is nothing to redact');
      return;
    }
    const existing = doc.shapes.filter((s) => s.type === 'redact');
    const covered = (r: Rect) => existing.some((s) => inRect({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, norm(s)));
    const fresh = findSensitive(ocr.ocr).filter((f) => !covered(f.box));
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
    const parts = [...counts].map(([k, n]) => `${n} ${n === 1 ? k : (PLURAL[k] ?? k)}`);
    toast(`Redacted ${parts.join(', ')}. Ctrl+Z to undo`);
  } finally {
    redacting = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

let toastTimer = 0;
function toast(msg: string) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
}

const toBlob = (cv: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob | null>((r) => cv.toBlob(r, type, q));

const bytes = async (b: Blob | null) => (b ? new Uint8Array(await b.arrayBuffer()) : null);

/** The finished image, at 1× if the user asked for standard resolution. */
function renderFinal(): HTMLCanvasElement {
  const v = computeView(doc, false);
  const cv = document.createElement('canvas');
  cv.width = v.W;
  cv.height = v.H;
  paintDoc(cv.getContext('2d')!, doc, v, doc.shapes);
  if (settings.exportScale !== '1x' || env.unit <= 1) return cv;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(v.W / env.unit));
  out.height = Math.max(1, Math.round(v.H / env.unit));
  const c = out.getContext('2d')!;
  c.imageSmoothingQuality = 'high';
  c.drawImage(cv, 0, 0, out.width, out.height);
  return out;
}

async function doExport(kind: string) {
  if (!ready) return;
  if (editing) commitText();
  if (tool === 'crop') setTool(prevTool);
  const cv = renderFinal();
  const png = await bytes(await toBlob(cv, 'image/png'));
  if (!png) {
    toast('Export failed');
    return;
  }
  // WebP is encoded here (Electron's main process can't); only when it may be needed.
  const needWebp = kind === 'saveAs' || (kind === 'save' && settings.format === 'webp');
  const webp = needWebp ? await bytes(await toBlob(cv, 'image/webp', 0.9)) : null;
  if (kind === 'upload') toast('Uploading…');
  const res = await window.api.invoke<{ ok: boolean; message?: string }>('editor:export', kind, png, snapshot(), {
    webp,
  });
  // Copying is the "done" action: the image is on the clipboard, so close the editor.
  if (kind === 'copy' && res?.ok) {
    window.close();
    return;
  }
  if (res?.message) toast(res.message);
}

/**
 * Drags the finished image out as a file. The OS drag has to start while the mouse is still
 * down, so the image is encoded synchronously here and main writes it out before starting it.
 */
function dragImageOut(e: DragEvent) {
  e.preventDefault();
  if (!ready) return;
  if (editing) commitText();
  const url = renderFinal().toDataURL('image/png');
  const b64 = atob(url.slice(url.indexOf(',') + 1));
  const png = new Uint8Array(b64.length);
  for (let i = 0; i < b64.length; i++) png[i] = b64.charCodeAt(i);
  window.api.send('editor:drag', png, snapshot());
}

// ---------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') shiftDown = true;
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (e.key === ' ') {
    if (!spaceDown && !action) canvas.style.cursor = 'grab';
    spaceDown = true;
    e.preventDefault();
    return;
  }
  if (e.ctrlKey) {
    const shapesSelected = tool === 'select' && sel.length > 0;
    if (k === 'z' && !e.shiftKey) undo();
    else if (k === 'y' || (k === 'z' && e.shiftKey)) redo();
    // With shapes selected, Ctrl+C/X copy the shapes; otherwise Ctrl+C copies the image.
    else if (k === 'c' && shapesSelected) copyShapes(false);
    else if (k === 'x' && shapesSelected) copyShapes(true);
    else if (k === 'c') doExport('copy');
    else if (k === 'v') pasteShapes();
    else if (k === 'd') addCopies(targets(), 12 * env.unit);
    else if (k === 'a') {
      setTool('select');
      sel = doc.shapes.map((s) => s.id);
      updateToolbar();
      render();
    } else if (k === 's') doExport(e.shiftKey ? 'saveAs' : 'save');
    else if (k === '0') setZoom(null);
    else if (k === '1') setZoom(1);
    else if (k === '=' || k === '+') setZoom(currentZoom() * 1.25);
    else if (k === '-') setZoom(currentZoom() / 1.25);
    else if (k === ']') arrange('front');
    else if (k === '[') arrange('back');
    else return;
    e.preventDefault();
    return;
  }
  if (tool === 'crop' && k === 'enter') return applyCrop();
  if (k === 'escape') {
    if (!menu.hidden) hideMenu();
    else if (tool === 'crop') setTool(prevTool);
    else {
      sel = [];
      updateToolbar();
      render();
    }
    return;
  }
  const step = (e.shiftKey ? 10 : 1) * env.unit;
  const arrows: Record<string, P> = {
    arrowleft: { x: -step, y: 0 },
    arrowright: { x: step, y: 0 },
    arrowup: { x: 0, y: -step },
    arrowdown: { x: 0, y: step },
  };
  if (arrows[k] && targets().length) {
    e.preventDefault();
    return nudge(arrows[k].x, arrows[k].y);
  }
  if (k === 'delete' || k === 'backspace') return deleteSelected();
  if (k === ']') return arrange('forward');
  if (k === '[') return arrange('backward');
  if (k === 'f') return toggleFill();
  if (k === 'i' && 'EyeDropper' in window) return void pickColor();
  if (k >= '1' && k <= '4') return setSize(Number(k) - 1);
  const t = TOOLS.find((x) => x.key === k);
  if (!t || e.altKey) return;
  // Pressing an active tool's key again steps through its styles.
  if (t.id === tool && optionTarget()) cycleStyle();
  else setTool(t.id);
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') shiftDown = false;
  if (e.key === ' ') {
    spaceDown = false;
    if (action?.kind !== 'pan') canvas.style.cursor = cursorFor(tool);
  }
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
  setOpacity(prefs.opacity, false);
  const [d, s] = await Promise.all([
    window.api.invoke<{ name: string; dataUrl: string; scale: number; doc: Doc | null }>('editor:load'),
    window.api.invoke<{ settings: EditorSettings }>('settings:get').catch(() => null),
  ]);
  if (s?.settings) settings = { ...settings, ...s.settings };
  $('uploadBtn').hidden = !settings.uploadService || settings.uploadService === 'none';
  document.title = `${d.name} — ShotKit Editor`;
  const img = new Image();
  img.src = d.dataUrl;
  await img.decode();
  env.img = img;
  env.imgW = img.naturalWidth;
  env.imgH = img.naturalHeight;
  env.unit = Math.max(1, d.scale || 1);
  if (d.doc) {
    // Annotations saved the last time this capture was edited.
    doc.shapes = d.doc.shapes ?? [];
    doc.crop = d.doc.crop ?? null;
    doc.bg = { ...doc.bg, ...d.doc.bg };
    nextId = Math.max(0, ...doc.shapes.map((x) => x.id)) + 1;
  }
  lastState = snapshot();
  ready = true;
  canvas.style.cursor = cursorFor(tool);
  syncBgPanel();
  updateToolbar();
  updateCropBar();
  paint();
  detectText(() => window.api.invoke<Word[][]>('editor:words'));
}

init().catch((e) => toast(`Could not load image: ${e instanceof Error ? e.message : e}`));

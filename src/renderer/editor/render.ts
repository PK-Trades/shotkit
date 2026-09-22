// Drawing: shapes, spotlights, the beautify background and window frames, and the page layout.
import { drawPointer } from '../shared/cursor';
import { env } from './env';
import {
  calloutTail,
  clamp,
  counterLabel,
  isLight,
  linePoints,
  norm,
  pathLength,
  pointAlong,
  slicePath,
  textBox,
} from './geometry';
import { font, hasTextBox, LINE_HEIGHT, textWidth } from './shapes';
import { Background, Doc, P, Rect, Shape } from './types';

/** Called when something drawn asynchronously (a background picture) becomes available. */
export let requestRender = () => {};
export const onRenderRequest = (fn: () => void) => (requestRender = fn);

// ---------------------------------------------------------------------------------------------
// Image effects
// ---------------------------------------------------------------------------------------------

const effectCache: Partial<Record<'blur' | 'pixelate', HTMLCanvasElement>> = {};

function effect(kind: 'blur' | 'pixelate'): HTMLCanvasElement {
  const cached = effectCache[kind];
  if (cached) return cached;
  const { img, imgW, imgH, unit } = env;
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

const sampler = document.createElement('canvas');
sampler.width = sampler.height = 16;
const samplerCtx = sampler.getContext('2d', { willReadFrequently: true })!;

/** Whether the image under `r` is mostly dark (average luminance below mid-grey). */
export function isDarkArea(r: Rect): boolean {
  const { img, imgW, imgH } = env;
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

// ---------------------------------------------------------------------------------------------
// Lines and arrows
// ---------------------------------------------------------------------------------------------

function strokePath(c: CanvasRenderingContext2D, pts: P[]) {
  if (pts.length < 2) return;
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) c.lineTo(p.x, p.y);
  c.stroke();
}

function strokeSmooth(c: CanvasRenderingContext2D, pts: P[]) {
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
  const head = Math.min(len * (double ? 0.4 : 0.7), Math.max(s.width * 3.4, 12 * env.unit));
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

/** A small dark label with white text, centred on (x, y). */
function label(c: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) {
  c.save();
  c.shadowColor = 'transparent';
  c.font = font(size);
  const w = c.measureText(text).width + size;
  const h = size * 1.6;
  c.fillStyle = 'rgba(20,20,24,0.85)';
  c.beginPath();
  c.roundRect(x - w / 2, y - h / 2, w, h, h / 2);
  c.fill();
  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, x, y + size * 0.05);
  c.restore();
}

function drawLine(c: CanvasRenderingContext2D, s: Shape) {
  const pts = linePoints(s);
  const style = s.style ?? 'plain';
  if (style === 'dashed') c.setLineDash([s.width * 1.5, s.width * 2.5]);
  strokePath(c, pts);
  c.setLineDash([]);
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (style === 'dots') {
    for (const p of [a, b]) {
      c.beginPath();
      c.arc(p.x, p.y, s.width * 1.6, 0, Math.PI * 2);
      c.fill();
    }
  } else if (style === 'measure') {
    const len = pathLength(pts);
    if (len < 1) return;
    // Bars across both ends, square to the line there.
    const bar = Math.max(s.width * 2.5, 8 * env.unit);
    for (const [p, q] of [
      [a, pointAlong(pts, Math.min(len, 2))],
      [b, pointAlong(pts, Math.max(0, len - 2))],
    ]) {
      const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const nx = (-(q.y - p.y) / d) * bar;
      const ny = ((q.x - p.x) / d) * bar;
      c.beginPath();
      c.moveTo(p.x + nx, p.y + ny);
      c.lineTo(p.x - nx, p.y - ny);
      c.stroke();
    }
    const mid = pointAlong(pts, len / 2);
    label(c, `${Math.round(len)} px`, mid.x, mid.y, Math.max(12 * env.unit, s.width * 2));
  }
}

// ---------------------------------------------------------------------------------------------
// Text, callouts, stamps and magnifiers
// ---------------------------------------------------------------------------------------------

function drawTextLines(c: CanvasRenderingContext2D, s: Shape, outline: boolean) {
  const lh = s.width * LINE_HEIGHT;
  const off = (lh - s.width) / 2;
  c.font = font(s.width);
  c.textBaseline = 'top';
  c.lineWidth = Math.max(2, s.width * 0.18);
  c.strokeStyle = isLight(s.color) ? 'rgba(0,0,0,0.85)' : '#ffffff';
  (s.text ?? '').split('\n').forEach((line, i) => {
    const lw = textWidth(line, s.width);
    const x = s.align === 'center' ? s.x + (s.w - lw) / 2 : s.align === 'right' ? s.x + s.w - lw : s.x;
    const y = s.y + i * lh + off;
    if (outline) c.strokeText(line, x, y);
    c.fillText(line, x, y);
  });
}

/** Callouts and pill text: a filled box (plus a tail for callouts) with contrasting text. */
function drawTextBox(c: CanvasRenderingContext2D, s: Shape) {
  const b = textBox(s);
  c.beginPath();
  c.roundRect(b.x, b.y, b.w, b.h, Math.min(s.width * 0.5, b.h / 2));
  const tail = s.type === 'callout' ? calloutTail(s) : null;
  if (tail) {
    c.moveTo(tail[0].x, tail[0].y);
    c.lineTo(tail[1].x, tail[1].y);
    c.lineTo(tail[2].x, tail[2].y);
    c.closePath();
  }
  c.fill();
  c.shadowColor = 'transparent';
  c.fillStyle = isLight(s.color) ? '#1c1c1e' : '#ffffff';
  drawTextLines(c, s, false);
}

function drawStamp(c: CanvasRenderingContext2D, s: Shape) {
  const r = norm(s);
  const size = Math.min(r.w, r.h);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if (s.style === 'cursor') {
    drawPointer(c, cx - size * 0.28, cy - size / 2, size);
    return;
  }
  c.font = `${size * 0.82}px "Segoe UI Emoji", "Segoe UI Symbol", sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(s.style ?? '✅', cx, cy + size * 0.05);
}

function drawMagnifier(c: CanvasRenderingContext2D, s: Shape, shadow: () => void) {
  const r = norm(s);
  const rad = Math.min(r.w, r.h) / 2;
  if (rad < 2) return;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const zoom = Number(s.style) || 2;
  const t = s.tip ?? { x: cx, y: cy };
  const ring = Math.max(2, 3 * env.unit);
  const dist = Math.hypot(t.x - cx, t.y - cy);
  // When the lens sits away from what it magnifies, connect the two.
  if (dist > rad + rad / zoom) {
    const dx = (t.x - cx) / dist;
    const dy = (t.y - cy) / dist;
    c.save();
    shadow();
    c.lineWidth = ring * 0.7;
    c.beginPath();
    c.moveTo(cx + dx * rad, cy + dy * rad);
    c.lineTo(t.x - (dx * rad) / zoom, t.y - (dy * rad) / zoom);
    c.stroke();
    c.beginPath();
    c.arc(t.x, t.y, rad / zoom, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }
  c.save();
  shadow();
  c.beginPath();
  c.arc(cx, cy, rad, 0, Math.PI * 2);
  c.fillStyle = '#fff';
  c.fill();
  c.restore();
  c.save();
  c.beginPath();
  c.arc(cx, cy, rad, 0, Math.PI * 2);
  c.clip();
  c.imageSmoothingEnabled = zoom < 3;
  const src = rad / zoom;
  c.drawImage(env.img, t.x - src, t.y - src, src * 2, src * 2, cx - rad, cy - rad, rad * 2, rad * 2);
  c.restore();
  c.lineWidth = ring;
  c.beginPath();
  c.arc(cx, cy, rad, 0, Math.PI * 2);
  c.stroke();
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

export function drawShape(c: CanvasRenderingContext2D, s: Shape) {
  const unit = env.unit;
  c.save();
  c.globalAlpha = s.opacity ?? 1;
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
      drawLine(c, s);
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
      const x = clamp(r.x, 0, env.imgW);
      const y = clamp(r.y, 0, env.imgH);
      const w = clamp(r.x + r.w, 0, env.imgW) - x;
      const h = clamp(r.y + r.h, 0, env.imgH) - y;
      if (w >= 1 && h >= 1) c.drawImage(effect(s.type), x, y, w, h, x, y, w, h);
      break;
    }
    case 'redact': {
      const r = norm(s);
      c.beginPath();
      c.roundRect(r.x, r.y, r.w, r.h, Math.min(2 * unit, r.w / 2, r.h / 2));
      c.fill();
      break;
    }
    case 'pen':
      shadow();
      strokeSmooth(c, s.points ?? []);
      break;
    case 'highlighter':
      // On light backgrounds multiply keeps dark text fully readable, like a real highlighter;
      // on dark backgrounds multiply would vanish, so use a translucent overlay instead.
      // All bars go in one path so overlapping parts aren't darkened twice.
      c.globalCompositeOperation = s.dark ? 'source-over' : 'multiply';
      c.globalAlpha *= s.dark ? 0.4 : 0.75;
      c.beginPath();
      for (const r of s.rects ?? []) {
        if (r.w > 0 && r.h > 0) c.roundRect(r.x, r.y, r.w, r.h, Math.min(r.h * 0.2, 4 * unit));
      }
      c.fill();
      break;
    case 'text':
      if (hasTextBox(s)) {
        shadow();
        drawTextBox(c, s);
      } else drawTextLines(c, s, s.style !== 'plain');
      break;
    case 'callout':
      shadow();
      drawTextBox(c, s);
      break;
    case 'stamp':
      shadow();
      drawStamp(c, s);
      break;
    case 'magnifier':
      drawMagnifier(c, s, shadow);
      break;
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
      {
        const text = counterLabel(s.n ?? 1, s.style);
        // Long labels (e.g. "viii") shrink to stay inside the circle.
        const size = s.width * (text.length > 2 ? 2.2 / text.length : text.length === 2 ? 0.95 : 1.1);
        c.font = `700 ${size}px "Segoe UI", system-ui, sans-serif`;
      }
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(counterLabel(s.n ?? 1, s.style), s.x, s.y + s.width * 0.05);
      break;
  }
  c.restore();
}

let dimCanvas: HTMLCanvasElement | null = null;

/** Dims the image outside every spotlight (together, so that overlapping ones don't stack). */
function paintSpotlights(c: CanvasRenderingContext2D, spots: Shape[]) {
  if (!spots.length) return;
  const { imgW, imgH, unit } = env;
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

// ---------------------------------------------------------------------------------------------
// Background, frames and layout
// ---------------------------------------------------------------------------------------------

export const PRESETS: { id: string; stops?: string[]; solid?: string }[] = [
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

export const ASPECTS = ['auto', '16:9', '4:3', '3:2', '1:1', '4:5', '9:16'];

/** Where everything goes on the canvas. */
export interface View {
  /** The part of the image shown (the crop, or all of it). */
  base: Rect;
  W: number;
  H: number;
  /** The framed content (title bar + image) and its corner radius. */
  content: Rect;
  radius: number;
  barH: number;
  /** Top-left of the image on the canvas. */
  imgX: number;
  imgY: number;
  bgOn: boolean;
  frameOn: boolean;
}

export function computeView(doc: Doc, cropping: boolean): View {
  const { imgW, imgH, unit } = env;
  const bg = doc.bg;
  const base: Rect = !cropping && doc.crop ? doc.crop : { x: 0, y: 0, w: imgW, h: imgH };
  const frameOn = !cropping && !!bg.frame && bg.frame !== 'none';
  const barH = frameOn ? Math.round((bg.frame === 'browser' ? 42 : 34) * unit) : 0;
  const bgOn = bg.enabled && !cropping;
  const pad = bgOn ? Math.round(bg.padding * unit) : 0;
  const cw = base.w;
  const ch = base.h + barH;
  let W = cw + pad * 2;
  let H = ch + pad * 2;
  const m = bgOn && bg.aspect && bg.aspect !== 'auto' ? bg.aspect.split(':').map(Number) : null;
  if (m && m[0] > 0 && m[1] > 0) {
    const ratio = m[0] / m[1];
    if (W / H < ratio) W = H * ratio;
    else H = W / ratio;
  }
  W = Math.max(1, Math.round(W));
  H = Math.max(1, Math.round(H));
  const ox = Math.round((W - cw) / 2);
  const oy = Math.round((H - ch) / 2);
  const r = bgOn ? bg.radius * unit : frameOn ? 10 * unit : 0;
  return {
    base,
    W,
    H,
    content: { x: ox, y: oy, w: cw, h: ch },
    radius: Math.min(r, cw / 2, ch / 2),
    barH,
    imgX: ox,
    imgY: oy + barH,
    bgOn,
    frameOn,
  };
}

const bgImages = new Map<string, HTMLImageElement>();

function bgImage(url: string): HTMLImageElement | null {
  let im = bgImages.get(url);
  if (!im) {
    im = new Image();
    im.onload = () => requestRender();
    im.src = url;
    bgImages.set(url, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}

/** Draws `src` scaled to cover the W×H canvas, centred. */
function drawCover(c: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, W: number, H: number) {
  const k = Math.max(W / sw, H / sh);
  c.drawImage(src, (W - sw * k) / 2, (H - sh * k) / 2, sw * k, sh * k);
}

function paintBackground(c: CanvasRenderingContext2D, bg: Background, W: number, H: number) {
  if (bg.preset === 'custom') {
    c.fillStyle = bg.color ?? '#1c1c1e';
    c.fillRect(0, 0, W, H);
    return;
  }
  if (bg.preset === 'image' && bg.image) {
    c.fillStyle = '#1c1c1e';
    c.fillRect(0, 0, W, H);
    const im = bgImage(bg.image);
    if (im) drawCover(c, im, im.naturalWidth, im.naturalHeight, W, H);
    return;
  }
  if (bg.preset === 'blurred') {
    // The screenshot itself, blurred, behind the screenshot.
    c.save();
    c.filter = `blur(${Math.round(Math.max(W, H) / 30)}px) saturate(1.3)`;
    const over = 1.15;
    c.translate((W * (1 - over)) / 2, (H * (1 - over)) / 2);
    drawCover(c, env.img, env.imgW, env.imgH, W * over, H * over);
    c.restore();
    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fillRect(0, 0, W, H);
    return;
  }
  const p = PRESETS.find((x) => x.id === bg.preset) ?? PRESETS[0];
  if (p.solid) c.fillStyle = p.solid;
  else {
    const g = c.createLinearGradient(0, 0, W, H);
    p.stops!.forEach((s, i, all) => g.addColorStop(i / (all.length - 1), s));
    c.fillStyle = g;
  }
  c.fillRect(0, 0, W, H);
}

let themeCache = { key: '', dark: false };

function frameIsDark(bg: Background, base: Rect): boolean {
  if (bg.frameTheme === 'dark') return true;
  if (bg.frameTheme === 'light') return false;
  // Match the top of the screenshot so the bar looks like part of the window.
  const key = `${env.img.src.length}:${base.x},${base.y},${base.w}`;
  if (themeCache.key !== key) {
    themeCache = { key, dark: isDarkArea({ x: base.x, y: base.y, w: base.w, h: Math.min(base.h, 24 * env.unit) }) };
  }
  return themeCache.dark;
}

function drawFrame(c: CanvasRenderingContext2D, bg: Background, v: View) {
  const u = env.unit;
  const { x, y, w } = v.content;
  const h = v.barH;
  const dark = frameIsDark(bg, v.base);
  const fg = dark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.72)';
  c.save();
  c.fillStyle = dark ? '#2a2a2f' : '#ececef';
  c.fillRect(x, y, w, h);
  c.fillStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)';
  c.fillRect(x, y + h - Math.max(1, u), w, Math.max(1, u));
  const text = bg.frameText ?? '';
  c.textBaseline = 'middle';
  c.font = `500 ${13 * u}px "Segoe UI", system-ui, sans-serif`;
  const lights = () => {
    ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => {
      c.fillStyle = col;
      c.beginPath();
      c.arc(x + (18 + i * 20) * u, y + h / 2, 6 * u, 0, Math.PI * 2);
      c.fill();
    });
  };
  if (bg.frame === 'mac') {
    lights();
    c.fillStyle = fg;
    c.textAlign = 'center';
    if (text) c.fillText(text, x + w / 2, y + h / 2, w - 160 * u);
  } else if (bg.frame === 'windows') {
    c.fillStyle = fg;
    c.textAlign = 'left';
    if (text) c.fillText(text, x + 14 * u, y + h / 2, w - 170 * u);
    c.strokeStyle = fg;
    c.lineWidth = Math.max(1, u);
    const cy = y + h / 2;
    const s = 5 * u;
    const cx = [w - 115 * u, w - 69 * u, w - 23 * u].map((d) => x + d);
    c.beginPath();
    c.moveTo(cx[0] - s, cy);
    c.lineTo(cx[0] + s, cy);
    c.rect(cx[1] - s, cy - s, s * 2, s * 2);
    c.moveTo(cx[2] - s, cy - s);
    c.lineTo(cx[2] + s, cy + s);
    c.moveTo(cx[2] + s, cy - s);
    c.lineTo(cx[2] - s, cy + s);
    c.stroke();
  } else if (bg.frame === 'browser') {
    lights();
    const pw = Math.min(w - 120 * u, 640 * u);
    const px = x + Math.max(80 * u, (w - pw) / 2);
    const ph = 26 * u;
    c.fillStyle = dark ? '#3a3a41' : '#ffffff';
    c.beginPath();
    c.roundRect(px, y + (h - ph) / 2, Math.max(0, Math.min(pw, x + w - 16 * u - px)), ph, ph / 2);
    c.fill();
    c.fillStyle = dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)';
    c.textAlign = 'left';
    c.font = `400 ${12 * u}px "Segoe UI", system-ui, sans-serif`;
    if (text) c.fillText(text, px + 14 * u, y + h / 2, pw - 28 * u);
  }
  c.restore();
}

/**
 * Paints the document: background, frame, image and `shapes` (in order). Blur and pixelate go
 * under the spotlights' dimming because they redraw image pixels.
 */
export function paintDoc(c: CanvasRenderingContext2D, doc: Doc, v: View, shapes: Shape[]) {
  const { W, H, content, radius, base } = v;
  c.clearRect(0, 0, W, H);
  if (v.bgOn) {
    paintBackground(c, doc.bg, W, H);
    if (doc.bg.shadow && (W > content.w || H > content.h)) {
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.45)';
      c.shadowBlur = 36 * env.unit;
      c.shadowOffsetY = 12 * env.unit;
      c.fillStyle = '#000';
      c.beginPath();
      c.roundRect(content.x, content.y, content.w, content.h, radius);
      c.fill();
      c.restore();
    }
  }
  c.save();
  c.beginPath();
  c.roundRect(content.x, content.y, content.w, content.h, radius);
  c.clip();
  if (v.frameOn) drawFrame(c, doc.bg, v);
  c.beginPath();
  c.rect(v.imgX, v.imgY, base.w, base.h);
  c.clip();
  c.translate(v.imgX - base.x, v.imgY - base.y);
  c.drawImage(env.img, 0, 0);
  const spots = shapes.filter((s) => s.type === 'spotlight');
  const under = spots.length ? shapes.filter((s) => s.type === 'blur' || s.type === 'pixelate') : [];
  for (const s of under) drawShape(c, s);
  paintSpotlights(c, spots);
  for (const s of shapes) if (!under.includes(s)) drawShape(c, s);
  c.restore();
}

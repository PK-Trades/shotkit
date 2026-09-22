// Pure geometry helpers shared by the editor's drawing, hit testing and snapping.
import { P, Rect, Shape } from './types';

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export function norm(r: Rect): Rect {
  return { x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h) };
}

export const inRect = (p: P, r: Rect, tol = 0) =>
  p.x >= r.x - tol && p.x <= r.x + r.w + tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol;

export const intersects = (a: Rect, b: Rect) =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

export function union(rs: Rect[]): Rect {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
}

/** Distance from a point to a rectangle (0 when inside). */
export function rectDistance(r: Rect, p: P): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

export function distToSeg(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function isLight(hex: string): boolean {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

// ---------------------------------------------------------------------------------------------
// Lines and curves
// ---------------------------------------------------------------------------------------------

/** Right-angle path: across, down, across (or down, across, down for mostly vertical arrows). */
function elbowPoints(a: P, b: P): P[] {
  if (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)) {
    const mx = (a.x + b.x) / 2;
    return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b];
  }
  const my = (a.y + b.y) / 2;
  return [a, { x: a.x, y: my }, { x: b.x, y: my }, b];
}

/** Points along a line or arrow; a bent one is sampled along its quadratic curve. */
export function linePoints(s: Shape): P[] {
  const a = { x: s.x, y: s.y };
  const b = { x: s.x + s.w, y: s.y + s.h };
  if (s.type === 'arrow' && s.style === 'elbow') return elbowPoints(a, b);
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
export const bendHandle = (s: Shape): P => ({
  x: s.x + s.w / 2 + (s.bend?.x ?? 0) / 2,
  y: s.y + s.h / 2 + (s.bend?.y ?? 0) / 2,
});

export function pathLength(pts: P[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

/** The part of a polyline between two distances along it. */
export function slicePath(pts: P[], from: number, to: number): P[] {
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

export const pointAlong = (pts: P[], d: number): P => slicePath(pts, d, d)[0] ?? pts[0];

export function distToPath(p: P, pts: P[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSeg(p, pts[i], pts[i + 1]));
  return best;
}

/** Snaps the vector (w, h) to the nearest multiple of `step` radians, keeping its length. */
export function snapAngle(w: number, h: number, step = Math.PI / 12): P {
  const ang = Math.round(Math.atan2(h, w) / step) * step;
  const len = Math.hypot(w, h);
  return { x: Math.cos(ang) * len, y: Math.sin(ang) * len };
}

// ---------------------------------------------------------------------------------------------
// Callouts and labels
// ---------------------------------------------------------------------------------------------

/** The bubble (or pill) around a callout's or pill text's text. */
export function textBox(s: Shape): Rect {
  const px = s.width * 0.6;
  const py = s.width * 0.4;
  return { x: s.x - px, y: s.y - py, w: s.w + px * 2, h: s.h + py * 2 };
}

/** The tail triangle, wound the same way as the bubble so that the two fill as one shape. */
export function calloutTail(s: Shape): P[] | null {
  const b = textBox(s);
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

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

/** A step's label: 1, 2, 3…; A, B, … Z, AA…; or i, ii, iii… */
export function counterLabel(n: number, style = 'numbers'): string {
  if (style === 'letters') {
    let s = '';
    for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(65 + ((v - 1) % 26)) + s;
    return s;
  }
  if (style === 'roman') {
    let s = '';
    let v = n;
    for (const [k, r] of ROMAN) while (v >= k) (s += r), (v -= k);
    return s;
  }
  return String(n);
}

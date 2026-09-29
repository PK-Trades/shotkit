// The hand-drawn look: wobbly lines, loose loops and open arrowheads, built as filled outlines
// whose width varies like a marker's. Everything derives from the shape's id (its "seed"), so a
// shape looks the same on every repaint, when it is moved, and in the exported image.
import { clamp, pathLength } from './geometry';
import { P, Rect } from './types';

/** A pen stroke: a centre line and the pen's width at each of its points. */
export interface Stroke {
  pts: P[];
  widths: number[];
}

/** What a hand-drawn rectangle or ellipse is made of: its strokes, and a closed outline for filling. */
export interface SketchBox {
  strokes: Stroke[];
  fill: P[];
}

// ---------------------------------------------------------------------------------------------
// Repeatable randomness
// ---------------------------------------------------------------------------------------------

/** A small seeded random number generator (mulberry32): the same seed gives the same numbers. */
export function rng(seed: number): () => number {
  let a = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x6d2b79f5) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pseudo-random value in [-1, 1] for an integer lattice point. */
function lattice(seed: number, i: number): number {
  let h = Math.imul(i ^ Math.imul(seed | 0, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smooth noise in [-1, 1] with about one bump per unit of `x`. */
export function noise(seed: number, x: number): number {
  const i = Math.floor(x);
  const t = x - i;
  const u = t * t * (3 - 2 * t);
  return lattice(seed, i) * (1 - u) + lattice(seed, i + 1) * u;
}

/** Two octaves of noise: broad drift with a little finer unevenness. */
const drift = (seed: number, x: number) => noise(seed, x) * 0.7 + noise(seed + 101, x * 2.3) * 0.3;

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** Points about `step` apart along a polyline, including both ends. */
export function resample(pts: P[], step: number): P[] {
  const total = pathLength(pts);
  if (pts.length < 2 || total === 0) return pts.slice(0, 1);
  const n = Math.max(1, Math.round(total / step));
  const out: P[] = [pts[0]];
  let seg = 0;
  let start = 0;
  const segLen = (i: number) => Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  for (let k = 1; k <= n; k++) {
    const d = (total * k) / n;
    while (seg < pts.length - 2 && start + segLen(seg) < d) start += segLen(seg++);
    const a = pts[seg];
    const b = pts[seg + 1];
    const t = clamp((d - start) / (segLen(seg) || 1), 0, 1);
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/** Cumulative distance along a polyline at each of its points. */
function distances(pts: P[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return out;
}

/** Points along a quadratic curve from `a` to `b` bowed towards `c`. */
function curve(a: P, c: P, b: P, n: number): P[] {
  const out: P[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
  }
  return out;
}

/** Shifts each point sideways by smooth noise; the ends stay where they are. */
function wobble(pts: P[], seed: number, amp: number, wave: number): P[] {
  const d = distances(pts);
  const total = d[d.length - 1];
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const fade = smooth(Math.min(d[i], total - d[i]) / (wave * 0.5));
    const off = drift(seed, d[i] / wave) * amp * fade;
    return { x: p.x - ((b.y - a.y) / len) * off, y: p.y + ((b.x - a.x) / len) * off };
  });
}

/**
 * Marker-like widths along a path: `start` and `end` (fractions of `width`) at the two ends,
 * growing to the full width over `taper`, with a little unevenness in between.
 */
function widthsAlong(pts: P[], width: number, seed: number, start: number, end: number, taper: number): number[] {
  const d = distances(pts);
  const total = d[d.length - 1] || 1;
  const t = Math.max(1e-6, Math.min(taper, total / 2));
  return d.map((at) => {
    const ends = lerp(start, 1, smooth(at / t)) * lerp(end, 1, smooth((total - at) / t));
    return width * ends * (1 + 0.1 * noise(seed + 3, at / (width * 8)));
  });
}

// ---------------------------------------------------------------------------------------------
// Outlines
// ---------------------------------------------------------------------------------------------

const CAP_STEPS = 6;

/** A stroke as one closed polygon (with round ends), ready to fill. */
export function outline(stroke: Stroke): P[] {
  const { pts, widths } = stroke;
  const n = pts.length;
  if (n < 2) return [];
  const left: P[] = [];
  const right: P[] = [];
  const angle: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    angle.push(Math.atan2(b.y - a.y, b.x - a.x));
    const hw = widths[i] / 2;
    const nx = -Math.sin(angle[i]) * hw;
    const ny = Math.cos(angle[i]) * hw;
    left.push({ x: pts[i].x + nx, y: pts[i].y + ny });
    right.push({ x: pts[i].x - nx, y: pts[i].y - ny });
  }
  // Half a circle round each end, from one side of the stroke to the other.
  const cap = (i: number, from: number): P[] => {
    const out: P[] = [];
    for (let k = 1; k < CAP_STEPS; k++) {
      const a = from - (Math.PI * k) / CAP_STEPS;
      out.push({ x: pts[i].x + Math.cos(a) * (widths[i] / 2), y: pts[i].y + Math.sin(a) * (widths[i] / 2) });
    }
    return out;
  };
  return [
    ...left,
    ...cap(n - 1, angle[n - 1] + Math.PI / 2),
    ...right.reverse(),
    ...cap(0, angle[0] - Math.PI / 2),
  ];
}

// ---------------------------------------------------------------------------------------------
// Lines and arrows
// ---------------------------------------------------------------------------------------------

/** How much and how quickly a line of length `len` wanders off course. */
function wander(len: number, width: number, unit: number) {
  return {
    amp: Math.min(width * 0.32 + unit * 0.8, len * 0.03),
    wave: clamp(len / 3, 40 * unit, 110 * unit),
  };
}

/** A hand-drawn version of the path `path` (a line, or the curve of a bent one). */
export function sketchLine(path: P[], width: number, seed: number, unit: number, start = 0.55, end = 0.55): Stroke {
  const len = pathLength(path);
  const { amp, wave } = wander(len, width, unit);
  const pts = wobble(resample(path, Math.max(3 * unit, width * 0.6)), seed, amp, wave);
  return { pts, widths: widthsAlong(pts, width, seed, start, end, len * 0.35) };
}

/** A hand-drawn arrow along `path`: a shaft that thickens towards an open, two-stroke head. */
export function sketchArrow(path: P[], width: number, seed: number, unit: number): Stroke[] {
  const len = pathLength(path);
  if (len < 1) return [];
  const shaft = sketchLine(path, width, seed, unit, 0.4, 1);
  const tip = shaft.pts[shaft.pts.length - 1];
  const head = Math.min(len * 0.6, Math.max(width * 4, 16 * unit));
  // Aim the head along the last stretch of the shaft, so that it follows a curve.
  const d = distances(shaft.pts);
  const at = d[d.length - 1] - head;
  const i = Math.max(0, d.findIndex((v) => v >= at));
  const back = shaft.pts[i];
  const dir = Math.atan2(tip.y - back.y, tip.x - back.x);
  const rnd = rng(seed ^ 0x5bd1e995);
  const arms = [1, -1].map((side): Stroke => {
    const a = dir + Math.PI - side * (0.52 + 0.1 * (rnd() - 0.5));
    const arm = head * (0.9 + 0.3 * rnd());
    const end = { x: tip.x + Math.cos(a) * arm, y: tip.y + Math.sin(a) * arm };
    const bow = (rnd() - 0.5) * arm * 0.14;
    const c = { x: (tip.x + end.x) / 2 - Math.sin(a) * bow, y: (tip.y + end.y) / 2 + Math.cos(a) * bow };
    const pts = curve(tip, c, end, Math.max(4, Math.round(arm / (3 * unit))));
    return { pts, widths: widthsAlong(pts, width * 0.95, seed + side, 1, 0.65, arm) };
  });
  return [shaft, ...arms];
}

// ---------------------------------------------------------------------------------------------
// Rectangles and ellipses
// ---------------------------------------------------------------------------------------------

/**
 * A hand-drawn ellipse: one loop that overshoots its start and drifts inwards, as a pen does.
 * A filled one drifts less, so that the end of the loop merges into the fill.
 */
export function sketchEllipse(r: Rect, width: number, seed: number, unit: number, filled = false): SketchBox {
  const rnd = rng(seed);
  const rx = Math.max(r.w / 2, 0.5);
  const ry = Math.max(r.h / 2, 0.5);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const small = Math.min(rx, ry);
  // Roughly the length of the loop (Ramanujan's approximation).
  const circ = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const amp = Math.min(width * 0.5 + unit, small * 0.06);
  // How far the end of the stroke lies inside where it began.
  const gap = filled
    ? width * 0.3
    : Math.min(clamp(small * (0.1 + 0.08 * rnd()), 1.5 * width, 3.5 * width + 6 * unit), small * 0.4);
  const start = Math.PI * (0.9 + 0.5 * rnd());
  const sweep = Math.PI * 2 + 0.3 + 0.3 * rnd();
  const n = clamp(Math.round((circ * sweep) / (Math.PI * 2) / (3 * unit)), 40, 400);
  const at = (theta: number, radial: number) => ({
    x: cx + Math.cos(theta) * (rx + radial),
    y: cy + Math.sin(theta) * (ry + radial),
  });
  const pts: P[] = [];
  for (let i = 0; i <= n; i++) {
    const p = i / n;
    pts.push(at(start + sweep * p, gap * (0.5 - p) + amp * drift(seed + 11, p * 5)));
  }
  // The first turn of the loop is what a fill has to follow; the overshoot lies on top of it.
  const fill = pts.filter((_, i) => (sweep * i) / n <= Math.PI * 2);
  return { strokes: [{ pts, widths: widthsAlong(pts, width, seed, 0.35, 0.3, circ * 0.15) }], fill };
}

/** A hand-drawn rectangle: four slightly bowed strokes that overshoot the corners. */
export function sketchRect(r: Rect, width: number, seed: number, unit: number): SketchBox {
  const rnd = rng(seed);
  const jitter = Math.min(width * 0.6, Math.min(r.w, r.h) * 0.04);
  const j = () => (rnd() - 0.5) * 2 * jitter;
  const corners: P[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ].map((p) => ({ x: p.x + j(), y: p.y + j() }));
  const strokes: Stroke[] = [];
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) return;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    // A pen overshoots a corner by a few pixels, however thick it is.
    const back = Math.min(unit * 1.5 * rnd(), len * 0.1);
    const over = Math.min(unit * (1 + 5 * rnd()), len * 0.1);
    const from = { x: a.x - dx * back, y: a.y - dy * back };
    const to = { x: b.x + dx * over, y: b.y + dy * over };
    const bow = (rnd() - 0.5) * 2 * Math.min(len * 0.02, width * 1.2);
    const c = { x: (from.x + to.x) / 2 - dy * bow, y: (from.y + to.y) / 2 + dx * bow };
    const side = curve(from, c, to, Math.max(2, Math.round(len / (3 * unit))));
    const { amp, wave } = wander(len, width * 0.5, unit);
    const pts = wobble(resample(side, Math.max(3 * unit, width * 0.6)), seed + i * 17, amp, wave);
    strokes.push({ pts, widths: widthsAlong(pts, width, seed + i, 0.8, 0.8, len * 0.25) });
  });
  return { strokes, fill: corners };
}

// Tool and style tables, plus per-shape geometry: bounding boxes, handles and hit testing.
import { IconName } from '../shared/icons';
import { env } from './env';
import { distToPath, distToSeg, inRect, linePoints, norm, textBox, union, bendHandle } from './geometry';
import { P, Rect, Shape, ShapeType, Tool } from './types';

export const TOOLS: { id: Tool; icon: IconName; label: string; key: string }[] = [
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
  { id: 'redact', icon: 'redact', label: 'Redact (solid box)', key: 'k' },
  { id: 'spotlight', icon: 'spotlight', label: 'Spotlight', key: 's' },
  { id: 'magnifier', icon: 'magnifier', label: 'Magnifier', key: 'g' },
  { id: 'counter', icon: 'counter', label: 'Numbered step', key: 'n' },
  { id: 'stamp', icon: 'stamp', label: 'Stamp', key: 'e' },
  { id: 'crop', icon: 'crop', label: 'Crop', key: 'c' },
];

export const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#bf5af2', '#ffffff', '#1c1c1e'];
export const SIZE_LABELS = ['Small', 'Medium', 'Large', 'Extra large'];
const SIZES: Partial<Record<ShapeType, number[]>> = {
  text: [20, 32, 48, 72],
  counter: [13, 18, 24, 32],
  highlighter: [14, 22, 32, 44],
  callout: [16, 22, 30, 40],
  stamp: [32, 48, 72, 112],
  magnifier: [60, 90, 130, 180],
};
const STROKE = [3, 6, 10, 16];
export const HIGHLIGHTER_DEFAULT = '#ffcc00';
export const REDACT_COLOR = '#111114';

export function sizeFor(type: ShapeType, i: number): number {
  return (SIZES[type] ?? STROKE)[i] * env.unit;
}

export interface Option {
  id: string;
  label: string;
  icon?: IconName;
  /** Shown instead of an icon (emoji stamps, zoom levels). */
  text?: string;
}

export interface OptionGroup {
  key: 'style' | 'align';
  items: Option[];
}

/** Per-type options shown in the toolbar; the first item of each group is the default. */
export const OPTIONS: Partial<Record<ShapeType, OptionGroup[]>> = {
  arrow: [
    {
      key: 'style',
      items: [
        { id: 'solid', icon: 'arrowSolid', label: 'Standard arrow' },
        { id: 'tapered', icon: 'arrowTapered', label: 'Tapered arrow' },
        { id: 'open', icon: 'arrowOpen', label: 'Open arrowhead' },
        { id: 'double', icon: 'arrowDouble', label: 'Double-headed arrow' },
        { id: 'dashed', icon: 'arrowDashed', label: 'Dashed arrow' },
        { id: 'elbow', icon: 'arrowElbow', label: 'Elbow (right-angle) arrow' },
      ],
    },
  ],
  line: [
    {
      key: 'style',
      items: [
        { id: 'plain', icon: 'line', label: 'Plain line' },
        { id: 'dashed', icon: 'lineDashed', label: 'Dashed line' },
        { id: 'dots', icon: 'lineDots', label: 'Line with dot ends' },
        { id: 'measure', icon: 'lineMeasure', label: 'Measurement line (shows its length)' },
      ],
    },
  ],
  text: [
    {
      key: 'style',
      items: [
        { id: 'outline', icon: 'textOutline', label: 'Outlined text' },
        { id: 'plain', icon: 'text', label: 'Plain text' },
        { id: 'pill', icon: 'textPill', label: 'Text on a background' },
      ],
    },
    {
      key: 'align',
      items: [
        { id: 'left', icon: 'alignLeft', label: 'Align left' },
        { id: 'center', icon: 'alignCenter', label: 'Align centre' },
        { id: 'right', icon: 'alignRight', label: 'Align right' },
      ],
    },
  ],
  counter: [
    {
      key: 'style',
      items: [
        { id: 'numbers', text: '1', label: 'Numbers (1, 2, 3)' },
        { id: 'letters', text: 'A', label: 'Letters (A, B, C)' },
        { id: 'roman', text: 'i', label: 'Roman numerals (i, ii, iii)' },
      ],
    },
  ],
  spotlight: [
    {
      key: 'style',
      items: [
        { id: 'rect', icon: 'rect', label: 'Rectangular spotlight' },
        { id: 'ellipse', icon: 'ellipse', label: 'Round spotlight' },
      ],
    },
  ],
  magnifier: [
    {
      key: 'style',
      items: [
        { id: '2', text: '2×', label: 'Magnify 2×' },
        { id: '3', text: '3×', label: 'Magnify 3×' },
        { id: '4', text: '4×', label: 'Magnify 4×' },
      ],
    },
  ],
  stamp: [
    {
      key: 'style',
      items: [
        { id: '✅', text: '✅', label: 'Check mark' },
        { id: '❌', text: '❌', label: 'Cross' },
        { id: '⚠️', text: '⚠️', label: 'Warning' },
        { id: '⭐', text: '⭐', label: 'Star' },
        { id: '❤️', text: '❤️', label: 'Heart' },
        { id: '❓', text: '❓', label: 'Question mark' },
        { id: '👍', text: '👍', label: 'Thumbs up' },
        { id: 'cursor', icon: 'select', label: 'Mouse pointer' },
      ],
    },
  ],
};

export const isBox = (t: ShapeType) =>
  t === 'rect' ||
  t === 'ellipse' ||
  t === 'blur' ||
  t === 'pixelate' ||
  t === 'spotlight' ||
  t === 'redact' ||
  t === 'stamp' ||
  t === 'magnifier';

export const isLine = (t: ShapeType) => t === 'line' || t === 'arrow';
export const hasText = (t: ShapeType) => t === 'text' || t === 'callout';

// ---------------------------------------------------------------------------------------------
// Text measurement
// ---------------------------------------------------------------------------------------------

const FONT = '"Segoe UI", system-ui, sans-serif';
export const font = (size: number) => `600 ${size}px ${FONT}`;
export const LINE_HEIGHT = 1.25;
const measureCtx = document.createElement('canvas').getContext('2d')!;

export function textWidth(text: string, size: number): number {
  measureCtx.font = font(size);
  return measureCtx.measureText(text).width;
}

/** Sets a text or callout shape's size from its text. */
export function measureText(s: Shape, text = s.text ?? '') {
  const lines = text.split('\n');
  const min = s.type === 'callout' || s.style === 'pill' ? s.width : 1;
  s.w = Math.max(...lines.map((l) => textWidth(l, s.width)), min);
  s.h = lines.length * s.width * LINE_HEIGHT;
}

/** Text shapes with a background (callouts and pill text) are drawn inside a padded box. */
export const hasTextBox = (s: Shape) => s.type === 'callout' || (s.type === 'text' && s.style === 'pill');

// ---------------------------------------------------------------------------------------------
// Bounding boxes, handles and hit testing
// ---------------------------------------------------------------------------------------------

const pointRect = (p: P): Rect => ({ ...p, w: 0, h: 0 });

export function bbox(s: Shape): Rect {
  switch (s.type) {
    case 'line':
    case 'arrow': {
      const r = union(linePoints(s).map(pointRect));
      const m = s.width / 2;
      return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
    }
    case 'callout':
      return s.tip ? union([textBox(s), pointRect(s.tip)]) : textBox(s);
    case 'text':
      return hasTextBox(s) ? textBox(s) : norm(s);
    case 'magnifier':
      return s.tip ? union([norm(s), pointRect(s.tip)]) : norm(s);
    case 'highlighter':
      return s.rects?.length ? union(s.rects) : { x: s.x, y: s.y, w: 0, h: 0 };
    case 'pen': {
      const pts = s.points ?? [];
      const m = s.width / 2;
      const r = union(pts.map(pointRect));
      return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
    }
    case 'counter':
      return { x: s.x - s.width, y: s.y - s.width, w: s.width * 2, h: s.width * 2 };
    default:
      return norm(s);
  }
}

/** Drag handles in image pixels; which index means what is understood by applyHandle(). */
export function handles(s: Shape): P[] {
  if (isLine(s.type)) {
    const ends = [
      { x: s.x, y: s.y },
      { x: s.x + s.w, y: s.y + s.h },
    ];
    // Elbow arrows route themselves, so they have no curve handle.
    return s.style === 'elbow' ? ends : [...ends, bendHandle(s)];
  }
  if (s.type === 'callout') return s.tip ? [s.tip] : [];
  if (isBox(s.type)) {
    const r = norm(s);
    const corners = [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ];
    return s.type === 'magnifier' && s.tip ? [...corners, s.tip] : corners;
  }
  return [];
}

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

export function hit(s: Shape, p: P, tol: number): boolean {
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
      return hitBox(s, p, tol, s.style === 'ellipse', false, 4 * env.unit);
    case 'magnifier': {
      if (hitBox(s, p, tol, true, true, 0)) return true;
      const r = norm(s);
      return !!s.tip && distToSeg(p, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, s.tip) <= tol + 2 * env.unit;
    }
    case 'blur':
    case 'pixelate':
    case 'redact':
    case 'stamp':
      return inRect(p, norm(s), tol);
    case 'callout': {
      const b = textBox(s);
      if (inRect(p, b, tol)) return true;
      return !!s.tip && distToSeg(p, { x: b.x + b.w / 2, y: b.y + b.h / 2 }, s.tip) <= tol + s.width * 0.3;
    }
    case 'highlighter':
      return (s.rects ?? []).some((r) => inRect(p, r, tol));
    case 'pen': {
      const pts = s.points ?? [];
      const lim = s.width / 2 + tol;
      if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= lim;
      return distToPath(p, pts) <= lim;
    }
    case 'text':
      return inRect(p, hasTextBox(s) ? textBox(s) : s, tol);
    case 'counter':
      return Math.hypot(p.x - s.x, p.y - s.y) <= s.width + tol;
  }
}

/** Moves a shape by (dx, dy) relative to its original position `orig`. */
export function translate(s: Shape, orig: Shape, dx: number, dy: number) {
  s.x = orig.x + dx;
  s.y = orig.y + dy;
  if (orig.points) s.points = orig.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
  if (orig.rects) s.rects = orig.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  if (orig.tip) s.tip = { x: orig.tip.x + dx, y: orig.tip.y + dy };
}

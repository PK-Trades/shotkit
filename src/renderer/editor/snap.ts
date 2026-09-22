// Snapping to the edges and centres of other shapes (and the image), with guide lines to show it.
import { P, Rect } from './types';

export interface Guides {
  x?: number;
  y?: number;
}

function lines(targets: Rect[]) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of targets) {
    xs.push(r.x, r.x + r.w / 2, r.x + r.w);
    ys.push(r.y, r.y + r.h / 2, r.y + r.h);
  }
  return { xs, ys };
}

/** The candidate nearest to any of `values` within `tol`: the offset to apply and the line hit. */
function nearest(values: number[], candidates: number[], tol: number): { d: number; at: number } | null {
  let best: { d: number; at: number } | null = null;
  for (const v of values) {
    for (const c of candidates) {
      const d = c - v;
      if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: c };
    }
  }
  return best;
}

/** Snaps a point (a line end or a box corner) to nearby edges and centres. */
export function snapPoint(p: P, targets: Rect[], tol: number): { p: P; guides: Guides } {
  const { xs, ys } = lines(targets);
  const nx = nearest([p.x], xs, tol);
  const ny = nearest([p.y], ys, tol);
  return {
    p: { x: p.x + (nx?.d ?? 0), y: p.y + (ny?.d ?? 0) },
    guides: { x: nx?.at, y: ny?.at },
  };
}

/** Snaps a moving box by its edges or centre; returns the extra offset to apply. */
export function snapBox(r: Rect, targets: Rect[], tol: number): { dx: number; dy: number; guides: Guides } {
  const { xs, ys } = lines(targets);
  const nx = nearest([r.x, r.x + r.w / 2, r.x + r.w], xs, tol);
  const ny = nearest([r.y, r.y + r.h / 2, r.y + r.h], ys, tol);
  return { dx: nx?.d ?? 0, dy: ny?.d ?? 0, guides: { x: nx?.at, y: ny?.at } };
}

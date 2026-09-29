import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noise, outline, resample, rng, sketchArrow, sketchEllipse, sketchLine, sketchRect } from '../src/renderer/editor/sketch';
import { P } from '../src/renderer/editor/types';

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
const finite = (pts: P[]) => pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

test('the same seed draws the same shape, another seed a different one', () => {
  const line: P[] = [
    { x: 0, y: 0 },
    { x: 300, y: 40 },
  ];
  assert.deepEqual(sketchLine(line, 6, 7, 1), sketchLine(line, 6, 7, 1));
  assert.notDeepEqual(sketchLine(line, 6, 7, 1).pts, sketchLine(line, 6, 8, 1).pts);
  assert.deepEqual([rng(3)(), rng(3)()], [rng(3)(), rng(3)()]);
});

test('noise stays within [-1, 1] and is smooth', () => {
  let prev = noise(5, 0);
  for (let x = 0.01; x < 20; x += 0.01) {
    const v = noise(5, x);
    assert.ok(Math.abs(v) <= 1);
    assert.ok(Math.abs(v - prev) < 0.1, 'no jumps');
    prev = v;
  }
});

test('resampling keeps both ends and spaces the points evenly', () => {
  const pts = resample(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
    ],
    10,
  );
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[pts.length - 1], { x: 100, y: 50 });
  assert.equal(pts.length, 16);
  for (let i = 1; i < pts.length; i++) assert.ok(dist(pts[i], pts[i - 1]) <= 10.001);
});

test('a hand-drawn line starts and ends exactly where it was drawn', () => {
  const line: P[] = [
    { x: 10, y: 20 },
    { x: 410, y: 120 },
  ];
  const s = sketchLine(line, 6, 4, 1);
  assert.deepEqual(s.pts[0], line[0]);
  assert.ok(dist(s.pts[s.pts.length - 1], line[1]) < 1e-9);
  assert.equal(s.widths.length, s.pts.length);
  // It wanders, but not far.
  assert.ok(s.pts.some((p) => Math.abs((p.y - 20) * 400 - (p.x - 10) * 100) > 1));
  assert.ok(s.pts.every((p) => Math.abs((p.y - 20) * 400 - (p.x - 10) * 100) / Math.hypot(400, 100) < 8));
});

test('an outline wraps its stroke with round ends', () => {
  const pts: P[] = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 100, y: 0 },
  ];
  const poly = outline({ pts, widths: [10, 10, 10] });
  assert.ok(finite(poly));
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  // Half the width beyond each end (the caps), and half the width to either side.
  assert.ok(Math.abs(Math.min(...xs) + 5) < 0.01);
  assert.ok(Math.abs(Math.max(...xs) - 105) < 0.01);
  assert.ok(Math.abs(Math.max(...ys) - 5) < 0.01);
  assert.ok(Math.abs(Math.min(...ys) + 5) < 0.01);
  assert.deepEqual(outline({ pts: [pts[0]], widths: [10] }), []);
});

test('a hand-drawn ellipse is one loop that overshoots its start and ends inside it', () => {
  const box = { x: 100, y: 100, w: 240, h: 120 };
  const { strokes, fill } = sketchEllipse(box, 6, 9, 1);
  assert.equal(strokes.length, 1);
  const pts = strokes[0].pts;
  assert.ok(finite(pts));
  const first = pts[0];
  const last = pts[pts.length - 1];
  // The pen ends near where it began, but not on top of it.
  assert.ok(dist(first, last) > 2 && dist(first, last) < 60);
  // Everything stays close to the ellipse it stands for.
  const cx = 220;
  const cy = 160;
  for (const p of pts) {
    const d = Math.hypot((p.x - cx) / 120, (p.y - cy) / 60);
    assert.ok(d > 0.8 && d < 1.2, `radius ${d}`);
  }
  // A fill follows the first turn only.
  assert.ok(fill.length > 10 && fill.length < pts.length);
});

test('a hand-drawn rectangle is four strokes around its corners', () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };
  const { strokes, fill } = sketchRect(box, 6, 2, 1);
  assert.equal(strokes.length, 4);
  assert.equal(fill.length, 4);
  const corners = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 0, y: 100 },
  ];
  fill.forEach((p, i) => assert.ok(dist(p, corners[i]) < 6, 'corner stays put'));
  // Each side runs from one corner to the next, overshooting a little.
  strokes.forEach((s, i) => {
    assert.ok(dist(s.pts[0], corners[i]) < 14);
    assert.ok(dist(s.pts[s.pts.length - 1], corners[(i + 1) % 4]) < 20);
  });
});

test('a hand-drawn arrow is a shaft plus two arms that start at its tip', () => {
  const path: P[] = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
  ];
  const [shaft, a, b] = sketchArrow(path, 6, 1, 1);
  assert.ok(shaft && a && b);
  const tip = shaft.pts[shaft.pts.length - 1];
  assert.ok(dist(tip, path[1]) < 1e-9);
  assert.deepEqual(a.pts[0], tip);
  assert.deepEqual(b.pts[0], tip);
  // The arms sweep back from the tip, one to either side of the shaft.
  const ea = a.pts[a.pts.length - 1];
  const eb = b.pts[b.pts.length - 1];
  assert.ok(ea.x < tip.x && eb.x < tip.x);
  assert.ok(ea.y * eb.y < 0);
  assert.deepEqual(sketchArrow([{ x: 5, y: 5 }, { x: 5, y: 5 }], 6, 1, 1), []);
});

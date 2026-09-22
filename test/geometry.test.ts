import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calloutTail,
  counterLabel,
  distToSeg,
  linePoints,
  norm,
  pathLength,
  pointAlong,
  slicePath,
  snapAngle,
  textBox,
} from '../src/renderer/editor/geometry';
import { snapBox, snapPoint } from '../src/renderer/editor/snap';
import { Shape } from '../src/renderer/editor/types';

const shape = (p: Partial<Shape>): Shape => ({ id: 1, type: 'arrow', color: '#f00', width: 4, x: 0, y: 0, w: 0, h: 0, ...p });
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('norm flips negative sizes', () => {
  assert.deepEqual(norm({ x: 10, y: 10, w: -4, h: -6 }), { x: 6, y: 4, w: 4, h: 6 });
});

test('distance to a segment', () => {
  close(distToSeg({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  close(distToSeg({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
});

test('a straight line has two points; a bent one follows its curve', () => {
  assert.equal(linePoints(shape({ w: 100, h: 0 })).length, 2);
  const bent = linePoints(shape({ w: 100, h: 0, bend: { x: 0, y: 80 } }));
  assert.ok(bent.length > 2);
  // The curve's middle is halfway to the control point.
  const mid = bent[Math.floor(bent.length / 2)];
  close(mid.x, 50);
  close(mid.y, 40);
});

test('elbow arrows route at right angles', () => {
  const pts = linePoints(shape({ w: 100, h: 40, style: 'elbow' }));
  assert.deepEqual(pts, [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 40 },
    { x: 100, y: 40 },
  ]);
  const tall = linePoints(shape({ w: 20, h: 100, style: 'elbow' }));
  assert.equal(tall[1].x, 0);
  assert.equal(tall[1].y, 50);
});

test('slicing a path by distance', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  close(pathLength(pts), 20);
  assert.deepEqual(slicePath(pts, 5, 15), [
    { x: 5, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 5 },
  ]);
  assert.deepEqual(pointAlong(pts, 12), { x: 10, y: 2 });
});

test('Shift snaps angles to 15° steps', () => {
  const v = snapAngle(100, 20); // ~11.3° → 15°
  close(Math.atan2(v.y, v.x), Math.PI / 12);
  close(Math.hypot(v.x, v.y), Math.hypot(100, 20));
});

test('callout tail points at the tip and winds like the bubble', () => {
  const s = shape({ type: 'callout', x: 100, y: 100, w: 80, h: 20, width: 20, tip: { x: 0, y: 200 } });
  const tail = calloutTail(s)!;
  assert.deepEqual(tail[1], { x: 0, y: 200 });
  const [a, t, b] = tail;
  assert.ok((t.x - a.x) * (b.y - a.y) - (b.x - a.x) * (t.y - a.y) > 0, 'clockwise on screen');
  // No tail when the tip is inside the bubble.
  assert.equal(calloutTail({ ...s, tip: { x: 120, y: 105 } }), null);
  const box = textBox(s);
  assert.ok(box.w > s.w && box.h > s.h);
});

test('step labels', () => {
  assert.equal(counterLabel(3), '3');
  assert.equal(counterLabel(1, 'letters'), 'A');
  assert.equal(counterLabel(27, 'letters'), 'AA');
  assert.equal(counterLabel(4, 'roman'), 'iv');
  assert.equal(counterLabel(14, 'roman'), 'xiv');
});

test('snapping to edges and centres', () => {
  const targets = [{ x: 100, y: 100, w: 50, h: 50 }];
  const p = snapPoint({ x: 103, y: 124 }, targets, 5);
  assert.deepEqual(p.p, { x: 100, y: 125 });
  assert.deepEqual(p.guides, { x: 100, y: 125 });
  assert.deepEqual(snapPoint({ x: 300, y: 300 }, targets, 5).guides, { x: undefined, y: undefined });
  const b = snapBox({ x: 152, y: 0, w: 20, h: 20 }, targets, 5);
  assert.equal(b.dx, -2); // left edge onto the target's right edge
});

// The standard Windows mouse pointer, drawn with its tip at (x, y) and `size` pixels tall.
const POINTER = [
  [0, 0],
  [0, 0.78],
  [0.19, 0.6],
  [0.33, 0.92],
  [0.45, 0.87],
  [0.31, 0.56],
  [0.56, 0.56],
];

export function drawPointer(c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x: number, y: number, size: number) {
  c.save();
  c.beginPath();
  for (const [px, py] of POINTER) c.lineTo(x + px * size, y + py * size);
  c.closePath();
  c.shadowColor = 'rgba(0,0,0,0.35)';
  c.shadowBlur = size * 0.08;
  c.shadowOffsetY = size * 0.03;
  c.fillStyle = '#fff';
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = Math.max(1, size * 0.05);
  c.lineJoin = 'miter';
  c.strokeStyle = '#000';
  c.stroke();
  c.restore();
}

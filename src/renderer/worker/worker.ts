// Hidden helper page for image work the main process can't do: encoding WebP, drawing the
// pointer into a capture, and rounding/shadowing window captures.
import { drawPointer } from '../shared/cursor';

type Job =
  | { kind: 'webp'; quality: number }
  | { kind: 'cursor'; x: number; y: number; size: number }
  | { kind: 'window'; radius: number; shadow: boolean; scale: number };

async function encode(cv: OffscreenCanvas, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await cv.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

async function run(bytes: Uint8Array, job: Job): Promise<Uint8Array> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }));
  const { width: w, height: h } = bmp;
  switch (job.kind) {
    case 'webp': {
      const cv = new OffscreenCanvas(w, h);
      cv.getContext('2d')!.drawImage(bmp, 0, 0);
      return encode(cv, 'image/webp', job.quality);
    }
    case 'cursor': {
      const cv = new OffscreenCanvas(w, h);
      const c = cv.getContext('2d')!;
      c.drawImage(bmp, 0, 0);
      drawPointer(c, job.x, job.y, job.size);
      return encode(cv, 'image/png');
    }
    case 'window': {
      // Windows 11 windows have rounded corners; the desktop showing through them is cut away.
      const pad = job.shadow ? Math.round(36 * job.scale) : 0;
      const cv = new OffscreenCanvas(w + pad * 2, h + pad * 2);
      const c = cv.getContext('2d')!;
      if (job.shadow) {
        c.save();
        c.shadowColor = 'rgba(0,0,0,0.45)';
        c.shadowBlur = 28 * job.scale;
        c.shadowOffsetY = 10 * job.scale;
        c.fillStyle = '#000';
        c.beginPath();
        c.roundRect(pad, pad, w, h, job.radius);
        c.fill();
        c.restore();
      }
      c.beginPath();
      c.roundRect(pad, pad, w, h, job.radius);
      c.clip();
      c.clearRect(pad, pad, w, h);
      c.drawImage(bmp, pad, pad);
      return encode(cv, 'image/png');
    }
  }
}

window.api.on('job', async (id: number, bytes: Uint8Array, job: Job) => {
  try {
    window.api.send('job:done', id, await run(bytes, job), null);
  } catch (e) {
    window.api.send('job:done', id, null, e instanceof Error ? e.message : String(e));
  }
});

window.api.send('job:ready');

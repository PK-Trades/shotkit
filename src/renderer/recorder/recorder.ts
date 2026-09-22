// Hidden recorder: captures a display, crops it to the selected area and encodes it as a video
// (MediaRecorder: MP4 when available, otherwise WebM) or as a GIF.
import { GifEncoder } from './gif';

interface StartOptions {
  sourceId: string;
  /** The display's size in physical pixels. */
  displayWidth: number;
  displayHeight: number;
  /** Area to record, in physical pixels relative to the display. */
  crop: { x: number; y: number; width: number; height: number };
  fps: number;
  format: 'mp4' | 'gif';
}

const GIF_MAX_WIDTH = 960;
const MIME_TYPES = [
  'video/mp4;codecs=avc1.640028',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
];

let stopFn: (() => Promise<{ bytes: Uint8Array; ext: string }>) | null = null;
let cleanup: (() => void) | null = null;

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

async function start(o: StartOptions) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: o.sourceId,
        minWidth: o.displayWidth,
        maxWidth: o.displayWidth,
        minHeight: o.displayHeight,
        maxHeight: o.displayHeight,
        maxFrameRate: o.fps,
      },
    },
  } as MediaStreamConstraints);
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await video.play();

  const gif = o.format === 'gif';
  // GIFs are kept small; videos use even sizes, which H.264 requires.
  const k = gif ? Math.min(1, GIF_MAX_WIDTH / o.crop.width) : 1;
  const cv = document.createElement('canvas');
  cv.width = even(o.crop.width * k);
  cv.height = even(o.crop.height * k);
  const c = cv.getContext('2d', { alpha: false, willReadFrequently: gif })!;
  c.imageSmoothingQuality = 'high';
  const draw = () => {
    // The stream may arrive at a different size than asked for; scale the crop to match.
    const sx = video.videoWidth / o.displayWidth;
    const sy = video.videoHeight / o.displayHeight;
    c.drawImage(video, o.crop.x * sx, o.crop.y * sy, o.crop.width * sx, o.crop.height * sy, 0, 0, cv.width, cv.height);
  };
  cleanup = () => {
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  };

  if (gif) {
    const enc = new GifEncoder(cv.width, cv.height);
    // Each frame is written when the next arrives, so its delay is how long it was really shown;
    // identical frames just extend the previous one.
    let pending: { data: Uint8ClampedArray; t: number } | null = null;
    const flush = (now: number) => {
      if (pending) enc.addFrame(pending.data, (now - pending.t) / 10);
    };
    const tick = () => {
      draw();
      const now = performance.now();
      const data = c.getImageData(0, 0, cv.width, cv.height).data;
      if (pending && same(pending.data, data)) return;
      flush(now);
      pending = { data, t: now };
    };
    tick();
    const timer = setInterval(tick, 1000 / o.fps);
    stopFn = async () => {
      clearInterval(timer);
      flush(performance.now());
      return { bytes: enc.finish(), ext: 'gif' };
    };
    return;
  }

  const mimeType = MIME_TYPES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const out = cv.captureStream(0);
  const track = out.getVideoTracks()[0] as MediaStreamTrack & { requestFrame(): void };
  const rec = new MediaRecorder(out, {
    mimeType,
    videoBitsPerSecond: Math.min(25_000_000, Math.max(2_000_000, cv.width * cv.height * o.fps * 0.15)),
  });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(1000);
  draw();
  track.requestFrame();
  const timer = setInterval(() => {
    draw();
    track.requestFrame();
  }, 1000 / o.fps);
  stopFn = () =>
    new Promise((resolve) => {
      clearInterval(timer);
      rec.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
        resolve({ bytes: new Uint8Array(await blob.arrayBuffer()), ext: mimeType.includes('mp4') ? 'mp4' : 'webm' });
      };
      rec.stop();
    });
}

function same(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

window.api.on('rec:start', async (o: StartOptions) => {
  try {
    await start(o);
    window.api.send('rec:started');
  } catch (e) {
    window.api.send('rec:error', e instanceof Error ? e.message : String(e));
  }
});

window.api.on('rec:stop', async () => {
  try {
    const r = await stopFn?.();
    cleanup?.();
    if (r) window.api.send('rec:done', r.bytes, r.ext);
    else window.api.send('rec:error', 'Nothing was recorded');
  } catch (e) {
    window.api.send('rec:error', e instanceof Error ? e.message : String(e));
  }
});

window.api.on('rec:cancel', () => cleanup?.());

window.api.send('rec:ready');

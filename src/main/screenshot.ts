import { desktopCapturer, Display, NativeImage, nativeImage, Rectangle, screen } from 'electron';
import { clamp } from './util';
import { captureScreen } from './win32';

export interface Shot {
  display: Display;
  /** Full-resolution (physical pixel) image of the display. */
  image: NativeImage;
}

const physicalSize = (d: Display) => ({
  width: Math.round(d.bounds.width * d.scaleFactor),
  height: Math.round(d.bounds.height * d.scaleFactor),
});

/** Captures every display (or only the given ones) at native resolution. */
export async function grabDisplays(only?: number[]): Promise<Shot[]> {
  const all = screen.getAllDisplays();
  const displays = all.filter((d) => !only || only.includes(d.id));
  try {
    return displays.map((d) => ({ display: d, image: grabWithGdi(d) }));
  } catch (e) {
    console.warn('GDI capture failed, using desktopCapturer:', e);
    return grabWithDesktopCapturer(all, displays);
  }
}

/**
 * Preferred over desktopCapturer, whose images come out washed out on HDR displays (SDR content
 * is brightened by the SDR white level and clipped); GDI returns the true SDR colours.
 */
function grabWithGdi(d: Display): NativeImage {
  const r = screen.dipToScreenRect(null, d.bounds);
  const image = nativeImage.createFromBitmap(captureScreen(r.x, r.y, r.width, r.height), {
    width: r.width,
    height: r.height,
  });
  if (image.isEmpty()) throw new Error(`Empty capture of display ${d.id}`);
  return image;
}

async function grabWithDesktopCapturer(all: Display[], displays: Display[]): Promise<Shot[]> {
  // desktopCapturer scales every thumbnail to the same box, so request one batch per distinct size.
  const bySize = new Map<string, Display[]>();
  for (const d of displays) {
    const { width, height } = physicalSize(d);
    const key = `${width}x${height}`;
    bySize.set(key, [...(bySize.get(key) ?? []), d]);
  }

  const shots: Shot[] = [];
  for (const [key, group] of bySize) {
    const [width, height] = key.split('x').map(Number);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    for (const d of group) {
      const src =
        sources.find((s) => s.display_id === String(d.id)) ??
        (sources.length === all.length ? sources[all.indexOf(d)] : sources.length === 1 ? sources[0] : undefined);
      if (!src || src.thumbnail.isEmpty()) continue;
      let image = src.thumbnail;
      const size = image.getSize();
      if (size.width !== width || size.height !== height) image = image.resize({ width, height, quality: 'best' });
      shots.push({ display: d, image });
    }
  }
  return shots;
}

/** Crops a display shot using a DIP rectangle relative to the display's top-left corner. */
export function cropShot(shot: Shot, r: Rectangle): NativeImage {
  const { width: iw, height: ih } = shot.image.getSize();
  const sx = iw / shot.display.bounds.width;
  const sy = ih / shot.display.bounds.height;
  const x = clamp(Math.round(r.x * sx), 0, iw - 1);
  const y = clamp(Math.round(r.y * sy), 0, ih - 1);
  const width = clamp(Math.round(r.width * sx), 1, iw - x);
  const height = clamp(Math.round(r.height * sy), 1, ih - y);
  return shot.image.crop({ x, y, width, height });
}

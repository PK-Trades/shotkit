export type ShapeType =
  | 'arrow'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'blur'
  | 'pixelate'
  | 'pen'
  | 'highlighter'
  | 'text'
  | 'counter'
  | 'callout'
  | 'spotlight'
  | 'redact'
  | 'magnifier'
  | 'stamp';

export type Tool = 'select' | 'crop' | ShapeType;

export interface P {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Geometry by type:
 * - line/arrow: start (x, y), vector (w, h), optional `bend`
 * - rect/ellipse/blur/pixelate/spotlight/redact/stamp: box (x, y, w, h)
 * - magnifier: lens box (x, y, w, h), magnified point `tip`
 * - pen: points
 * - highlighter: rects (one straight bar per highlighted text line)
 * - text: top-left (x, y), measured size (w, h), font size in `width`
 * - callout: like text, plus the tail's `tip`
 * - counter: centre (x, y), radius in `width`
 */
export interface Shape extends Rect {
  id: number;
  type: ShapeType;
  color: string;
  width: number;
  filled?: boolean;
  points?: P[];
  rects?: Rect[];
  /** Highlighter drawn over a dark background (uses a translucent overlay instead of multiply). */
  dark?: boolean;
  text?: string;
  n?: number;
  /** line/arrow: offset of the curve's control point from the midpoint of start and end. */
  bend?: P;
  /** A style id from OPTIONS (arrow head, line ends, text look, counter numbering, stamp, zoom…). */
  style?: string;
  /** text: 'left' (default), 'center' or 'right'. */
  align?: string;
  /** callout: where the tail points; magnifier: the magnified point. */
  tip?: P;
  /** 0–1; omitted when fully opaque. */
  opacity?: number;
}

export type Frame = 'none' | 'mac' | 'windows' | 'browser';

export interface Background {
  enabled: boolean;
  /** A PRESETS id, or 'custom' (uses `color`), 'image' (uses `image`) or 'blurred'. */
  preset: string;
  padding: number;
  radius: number;
  shadow: boolean;
  /** 'auto' or "w:h", e.g. "16:9". */
  aspect?: string;
  color?: string;
  /** Data URL of a background picture. */
  image?: string;
  frame?: Frame;
  /** Title (mac/windows frames) or address (browser frame). */
  frameText?: string;
  frameTheme?: 'auto' | 'light' | 'dark';
}

export interface Doc {
  shapes: Shape[];
  crop: Rect | null;
  bg: Background;
}

/** A word found by OCR, in image pixels. */
export interface Word extends Rect {
  text?: string;
}

// Editor choices remembered between sessions (per user, in this browser profile).
import { ShapeType, Tool } from './types';

export interface Prefs {
  tool: Tool;
  color: string;
  highlighterColor: string;
  sizeIdx: number;
  filled: boolean;
  opacity: number;
  /** Per shape type: chosen option per option group (style, align). */
  options: Partial<Record<ShapeType, Record<string, string>>>;
  /** Recently picked custom colours, newest first. */
  customColors: string[];
}

const KEY = 'shotkit.editor.prefs';

export function loadPrefs(defaults: Prefs): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && typeof raw === 'object') return { ...defaults, ...raw, options: { ...defaults.options, ...raw.options } };
  } catch {
    // Storage unavailable or corrupt: use the defaults.
  }
  return defaults;
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Not fatal: the choices just aren't remembered.
  }
}

// Copied shapes, shared by all editor windows (same origin, so same localStorage).
const CLIP_KEY = 'shotkit.editor.clipboard';

export function writeShapeClipboard(json: string) {
  try {
    localStorage.setItem(CLIP_KEY, json);
  } catch {
    // ignore
  }
}

export function readShapeClipboard(): string | null {
  try {
    return localStorage.getItem(CLIP_KEY);
  } catch {
    return null;
  }
}

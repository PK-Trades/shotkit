// Text found by OCR: the highlighter snaps to it and auto-redact searches it.
import { rectDistance, union } from './geometry';
import { P, Rect, Word } from './types';

/** A recognised line of text; `words` are sorted left to right. */
interface TextLine {
  words: Rect[];
  box: Rect;
}

/** Position in the recognised text: line index (reading order) and word index. */
export interface Caret {
  line: number;
  word: number;
}

export const text = {
  status: 'pending' as 'pending' | 'done' | 'failed',
  /** Rows of words in reading order (OCR lines on the same row merged). */
  lines: [] as TextLine[],
  /** OCR lines as Windows returned them, before merging (used by auto-redact). */
  ocr: [] as Word[][],
  ready: Promise.resolve() as Promise<void>,
};

export function detectText(load: () => Promise<Word[][]>) {
  text.ready = (async () => {
    try {
      const lines = await load();
      text.ocr = lines;
      // Windows OCR splits a visual row into several lines at wide gaps (e.g. a line number and
      // the code after it). Merge pieces on the same row that are reasonably close together.
      const rows: Rect[][] = [];
      for (const words of [...lines].sort((a, b) => union(a).x - union(b).x)) {
        const box = union(words);
        const row = rows.find((r) => {
          const rb = union(r);
          const overlap = Math.min(rb.y + rb.h, box.y + box.h) - Math.max(rb.y, box.y);
          const gap = box.x - (rb.x + rb.w);
          return overlap >= Math.min(rb.h, box.h) * 0.5 && gap <= Math.max(rb.h, box.h) * 4;
        });
        if (row) row.push(...words);
        else rows.push([...words]);
      }
      text.lines = rows
        .map((words) => {
          const sorted = [...words].sort((a, b) => a.x - b.x);
          return { words: sorted, box: union(sorted) };
        })
        .sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2) || a.box.x - b.box.x);
      text.status = 'done';
    } catch {
      text.status = 'failed';
    }
  })();
}

/**
 * Finds the word nearest to `p`. When `strict`, the point must be on (or very close to) a line
 * of text; otherwise it snaps to the nearest line wherever the pointer is.
 */
export function caretAt(p: P, strict: boolean): Caret | null {
  const lines = text.lines;
  let line = -1;
  if (strict) {
    // Must start on a line of text, or in the white space just beside it (like a text selection).
    let best = Infinity;
    lines.forEach((l, i) => {
      const dx = Math.max(l.box.x - p.x, 0, p.x - (l.box.x + l.box.w));
      const dy = Math.max(l.box.y - p.y, 0, p.y - (l.box.y + l.box.h));
      if (dy > l.box.h * 0.5 || dx > l.box.h * 3) return;
      const d = rectDistance(l.box, p);
      if (d < best) {
        best = d;
        line = i;
      }
    });
    if (line < 0) return null;
  } else {
    // Like a text selection: pick the line by vertical position first, and only use
    // horizontal distance to choose between lines at the same height (e.g. columns).
    const dy = (l: TextLine) => Math.max(l.box.y - p.y, 0, p.y - (l.box.y + l.box.h));
    const dx = (l: TextLine) => Math.max(l.box.x - p.x, 0, p.x - (l.box.x + l.box.w));
    const minDy = Math.min(...lines.map(dy));
    let best = Infinity;
    lines.forEach((l, i) => {
      if (dy(l) > minDy + 2) return;
      if (dx(l) < best) {
        best = dx(l);
        line = i;
      }
    });
    if (line < 0) return null;
  }
  let word = 0;
  let wordDist = Infinity;
  lines[line].words.forEach((w, j) => {
    const d = Math.max(w.x - p.x, 0, p.x - (w.x + w.w));
    if (d < wordDist) {
      wordDist = d;
      word = j;
    }
  });
  return { line, word };
}

/** One straight bar per text line between two carets, like a text selection. */
export function highlightRects(a: Caret, b: Caret): Rect[] {
  const lines = text.lines;
  const [s, e] = a.line < b.line || (a.line === b.line && a.word <= b.word) ? [a, b] : [b, a];
  const first = lines[s.line].box;
  const last = lines[e.line].box;
  const minX = Math.min(first.x, last.x);
  const maxX = Math.max(first.x + first.w, last.x + last.w);
  const rects: Rect[] = [];
  for (let i = s.line; i <= e.line; i++) {
    const l = lines[i];
    // Skip lines in the reading order that belong to another column.
    if (i !== s.line && i !== e.line && (l.box.x > maxX || l.box.x + l.box.w < minX)) continue;
    const from = i === s.line ? s.word : 0;
    const to = i === e.line ? e.word : l.words.length - 1;
    if (from > to) continue;
    const x1 = l.words[from].x;
    const x2 = l.words[to].x + l.words[to].w;
    const padX = l.box.h * 0.15;
    const padY = l.box.h * 0.12;
    rects.push({ x: x1 - padX, y: l.box.y - padY, w: x2 - x1 + padX * 2, h: l.box.h + padY * 2 });
  }
  return rects;
}

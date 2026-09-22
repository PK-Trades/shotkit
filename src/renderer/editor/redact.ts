// Finds sensitive text (emails, phone numbers, keys, …) in OCR output for auto-redaction.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrWord extends Box {
  text?: string;
}

export interface Finding {
  kind: string;
  box: Box;
}

interface Rule {
  kind: string;
  re: RegExp;
  ok?: (match: string) => boolean;
}

const digits = (s: string) => s.replace(/\D/g, '');

function luhn(s: string): boolean {
  const d = digits(s);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function iban(s: string): boolean {
  const t = s.replace(/\s/g, '').toUpperCase();
  if (t.length < 15 || t.length > 34) return false;
  const moved = t.slice(4) + t.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const c of v) rem = (rem * 10 + Number(c)) % 97;
  }
  return rem === 1;
}

function phone(s: string): boolean {
  const n = digits(s).length;
  if (n < 9 || n > 15) return false;
  // Dates and times ("2026-09-23 10:30") have the right digit count but aren't phone numbers.
  if (/\b(19|20)\d\d[-./]\d\d?[-./]\d\d?\b/.test(s) || /\b\d\d?[-./]\d\d?[-./](19|20)\d\d\b/.test(s)) return false;
  return !/^(\d)\1+$/.test(digits(s));
}

/** Long tokens that look machine-generated: mixed letters and digits with many distinct characters. */
function randomToken(s: string): boolean {
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  const nums = (s.match(/\d/g) ?? []).length;
  return letters >= 4 && nums >= 4 && new Set(s).size >= 14;
}

// Earlier rules win where matches overlap (a card number isn't also reported as a phone number).
const RULES: Rule[] = [
  { kind: 'email', re: /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g },
  {
    kind: 'API key',
    re: /\b(?:sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|xox[abprs]-[\w-]{10,}|glpat-[\w-]{16,}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,})/g,
  },
  { kind: 'card number', re: /\b\d(?:[ -]?\d){12,18}\b/g, ok: luhn },
  { kind: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, ok: iban },
  {
    kind: 'IP address',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    ok: (m) => m.split('.').every((n) => Number(n) <= 255),
  },
  { kind: 'phone number', re: /(?:\+|\b)\d[\d ().-]{7,}\d\b/g, ok: phone },
  { kind: 'API key', re: /\b[A-Za-z0-9_\-+=]{32,}\b/g, ok: randomToken },
];

/** Plural labels for the summary message. */
export const PLURAL: Record<string, string> = {
  email: 'emails',
  'API key': 'API keys',
  'card number': 'card numbers',
  IBAN: 'IBANs',
  'IP address': 'IP addresses',
  'phone number': 'phone numbers',
};

/**
 * Scans each OCR line (words joined by spaces) and returns a box over every sensitive match.
 * A match that covers part of a word gets a box over roughly that part of the word.
 */
export function findSensitive(lines: OcrWord[][]): Finding[] {
  const out: Finding[] = [];
  for (const words of lines) {
    const sorted = words.filter((w) => w.text).sort((a, b) => a.x - b.x);
    let str = '';
    const spans = sorted.map((w, i) => {
      if (i) str += ' ';
      const start = str.length;
      str += w.text!;
      return { start, end: str.length, w };
    });
    const taken: [number, number][] = [];
    for (const rule of RULES) {
      for (const m of str.matchAll(rule.re)) {
        const ms = m.index!;
        const me = ms + m[0].length;
        if (taken.some(([a, b]) => ms < b && me > a)) continue;
        if (rule.ok && !rule.ok(m[0])) continue;
        taken.push([ms, me]);
        let x1 = Infinity;
        let x2 = -Infinity;
        let y1 = Infinity;
        let y2 = -Infinity;
        for (const { start, end, w } of spans) {
          if (start >= me || end <= ms) continue;
          const len = end - start;
          x1 = Math.min(x1, w.x + (w.w * Math.max(0, ms - start)) / len);
          x2 = Math.max(x2, w.x + (w.w * Math.min(len, me - start)) / len);
          y1 = Math.min(y1, w.y);
          y2 = Math.max(y2, w.y + w.h);
        }
        if (x2 <= x1) continue;
        const pad = (y2 - y1) * 0.18;
        out.push({ kind: rule.kind, box: { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 } });
      }
    }
  }
  return out;
}

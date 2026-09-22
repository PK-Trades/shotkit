// File names for captures from a user template, e.g. "{year}/{month}/{app} {date} at {time}".

export interface NameInfo {
  date: Date;
  app?: string;
  title?: string;
  mode?: string;
  width?: number;
  height?: number;
  n?: number;
}

export const DEFAULT_TEMPLATE = 'ShotKit {date} at {time}';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Characters Windows doesn't allow in file names, plus control characters. */
const INVALID = /[<>:"\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function cleanSegment(s: string): string {
  let out = s.replace(INVALID, '').replace(/\s+/g, ' ').trim();
  // Windows drops trailing dots and spaces; ".." would climb out of the save folder.
  out = out.replace(/[. ]+$/, '').replace(/^\.+/, '');
  if (RESERVED.test(out)) out = `_${out}`;
  return out.slice(0, 120).trim();
}

/** Renders a template into a relative path ("/"-separated, no extension). Never empty. */
export function renderName(template: string, info: NameInfo): string {
  const d = info.date;
  const tokens: Record<string, string> = {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`,
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate()),
    hour: pad(d.getHours()),
    minute: pad(d.getMinutes()),
    second: pad(d.getSeconds()),
    // Values may not create folders of their own.
    app: (info.app ?? '').replace(/[/\\]/g, '-'),
    title: (info.title ?? '').replace(/[/\\]/g, '-'),
    mode: info.mode ?? '',
    width: info.width ? String(info.width) : '',
    height: info.height ? String(info.height) : '',
    n: pad(info.n ?? 1, 3),
  };
  const filled = (template || DEFAULT_TEMPLATE).replace(/\{(\w+)\}/g, (m, k: string) =>
    k.toLowerCase() in tokens ? tokens[k.toLowerCase()] : m,
  );
  const parts = filled
    .split(/[/\\]+/)
    .map(cleanSegment)
    .filter(Boolean);
  if (!parts.length) return renderName(DEFAULT_TEMPLATE, info);
  return parts.join('/');
}

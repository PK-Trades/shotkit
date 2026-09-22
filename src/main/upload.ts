// Uploads a capture to Imgur or a custom HTTP endpoint and copies the link.
import { clipboard, shell } from 'electron';
import { getSettings } from './settings';
import { errorMessage, notify } from './util';

export const uploadConfigured = () => {
  const s = getSettings();
  if (s.uploadService === 'imgur') return !!s.imgurClientId.trim();
  if (s.uploadService === 'custom') return !!s.customUploadUrl.trim();
  return false;
};

/** Reads a dotted path such as "data.link" out of a JSON value. */
export function pick(obj: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), obj);
}

/** Parses "Name: value" lines into headers. */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

async function send(data: Buffer, fileName: string, mime: string): Promise<string> {
  const s = getSettings();
  const form = new FormData();
  const blob = new Blob([new Uint8Array(data)], { type: mime });
  if (s.uploadService === 'imgur') {
    form.append('image', blob, fileName);
    form.append('type', 'file');
    const res = await fetch('https://api.imgur.com/3/image', {
      method: 'POST',
      headers: { Authorization: `Client-ID ${s.imgurClientId.trim()}` },
      body: form,
    });
    const json = (await res.json().catch(() => null)) as { data?: { link?: string; error?: string } } | null;
    if (!res.ok || !json?.data?.link) throw new Error(json?.data?.error ?? `Imgur answered ${res.status}`);
    return json.data.link;
  }
  if (s.uploadService === 'custom') {
    form.append(s.customUploadField.trim() || 'file', blob, fileName);
    const res = await fetch(s.customUploadUrl.trim(), {
      method: 'POST',
      headers: parseHeaders(s.customUploadHeaders),
      body: form,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`The server answered ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
    const path = s.customUploadUrlPath.trim();
    const link = path ? pick(JSON.parse(body), path) : body.trim();
    if (typeof link !== 'string' || !/^https?:\/\//i.test(link)) {
      throw new Error(path ? `No link found at "${path}" in the response` : 'The response is not a link');
    }
    return link;
  }
  throw new Error('Choose an upload service in Settings first.');
}

/** Uploads, copies the link and tells the user. Returns the link, or null on failure. */
export async function uploadAndCopy(data: Buffer, fileName: string, mime = 'image/png'): Promise<string | null> {
  if (!uploadConfigured()) {
    notify('Uploading is not set up', 'Choose Imgur or a custom server under Settings → Sharing.');
    return null;
  }
  try {
    const link = await send(data, fileName, mime);
    clipboard.writeText(link);
    notify('Link copied', link, () => shell.openExternal(link));
    return link;
  } catch (e) {
    notify('Upload failed', errorMessage(e));
    return null;
  }
}

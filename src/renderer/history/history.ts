import { IconName, svg } from '../shared/icons';

interface Item {
  id: string;
  time: number;
  width: number;
  height: number;
  thumb: string;
  name: string;
  app?: string;
  title?: string;
  text?: string;
}

const grid = document.getElementById('grid')!;
const empty = document.getElementById('empty')!;
const count = document.getElementById('count')!;
const search = document.getElementById('search') as HTMLInputElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;

let items: Item[] = [];
let canUpload = false;

const tools = (): [string, IconName, string][] => [
  ['edit', 'edit', 'Annotate'],
  ['copy', 'copy', 'Copy'],
  ['pin', 'pin', 'Pin to screen'],
  ['ocr', 'text', 'Copy text (OCR)'],
  ...(canUpload ? [['upload', 'upload', 'Upload and copy the link'] as [string, IconName, string]] : []),
  ['folder', 'folder', 'Show in folder'],
  ['delete', 'trash', 'Delete'],
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Every word of the query must appear in the name, app, window title or recognised text. */
function matches(it: Item, words: string[]): boolean {
  const hay = `${it.name} ${it.app ?? ''} ${it.title ?? ''} ${it.text ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** A short piece of the recognised text around the first match. */
function snippet(it: Item, words: string[]): string {
  const text = it.text ?? '';
  const i = words.length ? text.toLowerCase().indexOf(words[0]) : -1;
  if (i < 0) return '';
  const from = Math.max(0, i - 30);
  return `${from ? '…' : ''}${text.slice(from, i + 60)}${i + 60 < text.length ? '…' : ''}`;
}

function render() {
  const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? items.filter((it) => matches(it, words)) : items;
  count.textContent = items.length
    ? words.length
      ? `${shown.length} of ${items.length}`
      : `${items.length} capture${items.length === 1 ? '' : 's'}`
    : '';
  empty.hidden = items.length > 0;
  grid.replaceChildren(
    ...shown.map((it) => {
      const el = document.createElement('div');
      el.className = 'item';
      const snip = snippet(it, words);
      el.innerHTML = `
        <div class="thumb" title="Double-click to annotate"><img src="${it.thumb}" alt=""></div>
        <div class="meta"><span>${new Date(it.time).toLocaleString()}</span><span>${it.width} × ${it.height}</span></div>
        ${it.app ? `<div class="app" title="${esc(it.title ?? '')}">${esc(it.app)}${it.title ? ` · ${esc(it.title)}` : ''}</div>` : ''}
        ${snip ? `<div class="snippet">${esc(snip)}</div>` : ''}
        <div class="tools">${tools()
          .map(
            ([a, icon, title]) =>
              `<button data-a="${a}" title="${title}" class="${a === 'delete' ? 'del' : ''}">${svg(icon)}</button>`,
          )
          .join('')}</div>`;
      el.querySelector('.thumb')!.addEventListener('dblclick', () => window.api.invoke('history:action', it.id, 'edit'));
      el.querySelector('.tools')!.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('button');
        if (!btn) return;
        await window.api.invoke('history:action', it.id, btn.dataset.a);
      });
      return el;
    }),
  );
  if (items.length && !shown.length) {
    const none = document.createElement('p');
    none.className = 'muted none';
    none.textContent = 'No captures match. Text in captures becomes searchable a few seconds after each capture.';
    grid.appendChild(none);
  }
}

async function load() {
  const r = await window.api.invoke<{ canUpload: boolean; items: Item[] }>('history:list');
  items = r.items;
  canUpload = r.canUpload;
  render();
}

search.addEventListener('input', render);
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    search.focus();
    search.select();
  } else if (e.key === 'Escape' && document.activeElement === search) {
    search.value = '';
    render();
  }
});

let confirmTimer = 0;
clearBtn.addEventListener('click', async () => {
  if (!clearBtn.dataset.confirm) {
    clearBtn.dataset.confirm = '1';
    clearBtn.textContent = 'Click again to confirm';
    confirmTimer = window.setTimeout(() => {
      delete clearBtn.dataset.confirm;
      clearBtn.textContent = 'Clear History';
    }, 3000);
    return;
  }
  clearTimeout(confirmTimer);
  delete clearBtn.dataset.confirm;
  clearBtn.textContent = 'Clear History';
  await window.api.invoke('history:clear');
});

document.getElementById('openFolder')!.addEventListener('click', () => window.api.invoke('history:openFolder'));
document.getElementById('searchIcon')!.innerHTML = svg('search');

window.api.on('history:changed', load);
load();

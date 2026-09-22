import { IconName, svg } from '../shared/icons';

interface Item {
  id: string;
  time: number;
  width: number;
  height: number;
  thumb: string;
}

const grid = document.getElementById('grid')!;
const empty = document.getElementById('empty')!;
const count = document.getElementById('count')!;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;

const TOOLS: [string, IconName, string][] = [
  ['edit', 'edit', 'Annotate'],
  ['copy', 'copy', 'Copy'],
  ['pin', 'pin', 'Pin to screen'],
  ['ocr', 'text', 'Copy text (OCR)'],
  ['folder', 'folder', 'Show in folder'],
  ['delete', 'trash', 'Delete'],
];

async function load() {
  const items = await window.api.invoke<Item[]>('history:list');
  count.textContent = items.length ? `${items.length} capture${items.length === 1 ? '' : 's'}` : '';
  empty.hidden = items.length > 0;
  grid.replaceChildren(
    ...items.map((it) => {
      const el = document.createElement('div');
      el.className = 'item';
      el.innerHTML = `
        <div class="thumb" title="Double-click to annotate"><img src="${it.thumb}" alt=""></div>
        <div class="meta"><span>${new Date(it.time).toLocaleString()}</span><span>${it.width} × ${it.height}</span></div>
        <div class="tools">${TOOLS.map(
          ([a, icon, title]) => `<button data-a="${a}" title="${title}" class="${a === 'delete' ? 'del' : ''}">${svg(icon)}</button>`,
        ).join('')}</div>`;
      el.querySelector('.thumb')!.addEventListener('dblclick', () => window.api.invoke('history:action', it.id, 'edit'));
      el.querySelector('.tools')!.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest('button');
        if (!btn) return;
        await window.api.invoke('history:action', it.id, btn.dataset.a);
      });
      return el;
    }),
  );
}

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

window.api.on('history:changed', load);
load();

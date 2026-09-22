import { svg } from '../shared/icons';

interface Item {
  id: string;
  thumb: string;
  width: number;
  height: number;
  timeout: number;
  side: 'left' | 'right';
  canUpload: boolean;
}

const MAX_CARDS = 6;
const stack = document.getElementById('stack') as HTMLDivElement;
const closeAll = document.getElementById('closeAll') as HTMLButtonElement;

const FLASH: Record<string, string> = { copy: 'Copied', save: 'Saved', ocr: 'Text copied', upload: 'Uploading…' };

const cards = () => Array.from(stack.querySelectorAll<HTMLElement>('.card:not(.leaving)'));

function reportSize() {
  closeAll.hidden = cards().length < 2;
  requestAnimationFrame(() => window.api.send('qa:resize', cards().length ? stack.offsetHeight : 0));
}

function removeCard(card: HTMLElement) {
  if (card.classList.contains('leaving')) return;
  card.classList.add('leaving');
  setTimeout(() => {
    card.remove();
    reportSize();
  }, 200);
}

function addCard(it: Item) {
  document.body.classList.toggle('right', it.side === 'right');

  const card = document.createElement('div');
  card.className = 'card entering';
  card.draggable = true;
  card.innerHTML = `
    <img class="thumb" src="${it.thumb}" alt="">
    <div class="hover">
      <button class="corner tl" data-a="close" title="Close">${svg('close')}</button>
      <button class="corner tr" data-a="edit" title="Annotate">${svg('edit')}</button>
      <button class="corner bl" data-a="pin" title="Pin to screen">${svg('pin')}</button>
      <button class="corner br" data-a="ocr" title="Copy text (OCR)">${svg('text')}</button>
      <div class="topmid">
        <button class="corner" data-a="folder" title="Show in folder">${svg('folder')}</button>
        ${it.canUpload ? `<button class="corner" data-a="upload" title="Upload and copy the link">${svg('upload')}</button>` : ''}
      </div>
      <div class="center">
        <button class="pill" data-a="copy">Copy</button>
        <button class="pill" data-a="save">Save</button>
      </div>
    </div>`;

  let timer = 0;
  const arm = () => {
    clearTimeout(timer);
    if (it.timeout > 0) timer = window.setTimeout(() => removeCard(card), it.timeout * 1000);
  };
  card.addEventListener('mouseenter', () => clearTimeout(timer));
  card.addEventListener('mouseleave', arm);
  arm();

  card.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    const action = btn.dataset.a!;
    clearTimeout(timer);
    if (action !== 'close') {
      if (FLASH[action]) {
        const flash = document.createElement('div');
        flash.className = 'flash';
        flash.textContent = action === 'ocr' ? 'Reading text…' : FLASH[action];
        card.appendChild(flash);
      }
      const res = await window.api.invoke<{ ok: boolean }>('qa:action', it.id, action);
      // Showing the folder leaves the card in place.
      if (action === 'folder') return arm();
      if (action === 'upload' && !res?.ok) {
        card.querySelector('.flash')?.remove();
        return arm();
      }
      if (action === 'ocr') await new Promise((r) => setTimeout(r, 300));
      else if (FLASH[action]) await new Promise((r) => setTimeout(r, 450));
    }
    removeCard(card);
  });

  card.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    window.api.invoke('qa:action', it.id, 'edit');
    removeCard(card);
  });

  card.addEventListener('dragstart', (e) => {
    e.preventDefault();
    window.api.send('qa:drag', it.id);
  });

  stack.appendChild(card);
  const all = cards();
  for (const old of all.slice(0, Math.max(0, all.length - MAX_CARDS))) old.remove();

  const img = card.querySelector('img')!;
  const show = () => {
    reportSize();
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove('entering')));
  };
  if (img.complete) show();
  else img.addEventListener('load', show, { once: true });
}

closeAll.addEventListener('click', () => {
  for (const c of cards()) removeCard(c);
});

window.api.on('qa:add', (it: Item) => addCard(it));

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const c of cards()) removeCard(c);
});

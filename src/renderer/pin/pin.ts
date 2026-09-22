import { IconName, svg } from '../shared/icons';

const img = document.getElementById('img') as HTMLImageElement;
const toastEl = document.getElementById('toast')!;
const OPACITY_STEPS = [1, 0.8, 0.6, 0.4];
let opacity = 1;
let drag: { ox: number; oy: number } | null = null;
let toastTimer = 0;

const ICONS: Record<string, IconName> = { opacity: 'opacity', copy: 'copy', edit: 'edit', close: 'close' };
for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.toolbar button'))) {
  btn.innerHTML = svg(ICONS[btn.dataset.a!]);
}

window.api.invoke<string>('pin:load').then((url) => {
  if (url) img.src = url;
});

function toast(text: string) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1000);
}

function setOpacity(v: number) {
  opacity = Math.min(1, Math.max(0.2, v));
  window.api.send('pin:opacity', opacity);
  toast(`${Math.round(opacity * 100)}%`);
}

function run(action: string) {
  switch (action) {
    case 'opacity': {
      const i = OPACITY_STEPS.findIndex((s) => Math.abs(s - opacity) < 0.05);
      setOpacity(OPACITY_STEPS[(i + 1) % OPACITY_STEPS.length]);
      break;
    }
    case 'copy':
      window.api.send('pin:copy');
      toast('Copied');
      break;
    case 'edit':
      window.api.send('pin:edit');
      break;
    case 'close':
      window.api.send('pin:close');
      break;
  }
}

document.querySelector('.toolbar')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn) run(btn.dataset.a!);
});

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest('.toolbar')) return;
  drag = { ox: e.screenX - window.screenX, oy: e.screenY - window.screenY };
  document.documentElement.setPointerCapture(e.pointerId);
});

document.addEventListener('pointermove', (e) => {
  if (drag) window.api.send('pin:move', e.screenX - drag.ox, e.screenY - drag.oy);
});

document.addEventListener('pointerup', () => (drag = null));

document.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey) setOpacity(opacity + (e.deltaY < 0 ? 0.1 : -0.1));
    else window.api.send('pin:zoom', e.deltaY < 0 ? 1.1 : 1 / 1.1);
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') run('close');
  else if (e.ctrlKey && e.key.toLowerCase() === 'c') run('copy');
  else if (e.key === '+' || e.key === '=') window.api.send('pin:zoom', 1.1);
  else if (e.key === '-') window.api.send('pin:zoom', 1 / 1.1);
});

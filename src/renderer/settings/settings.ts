export {};

type Settings = Record<string, any> & { hotkeys: Record<string, string>; saveFolder: string };
interface State {
  settings: Settings;
  failed: string[];
}

const HOTKEYS: [string, string][] = [
  ['area', 'Capture area'],
  ['window', 'Capture window'],
  ['fullscreen', 'Capture fullscreen'],
  ['scrolling', 'Scrolling capture'],
  ['ocr', 'Capture text (OCR)'],
  ['history', 'Open capture history'],
];

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  PrintScreen: 'PrintScreen',
};

let state: State;
const hotkeysEl = document.getElementById('hotkeys')!;

const pretty = (accel: string) => (accel ? accel.replace('CommandOrControl', 'Ctrl').split('+').join(' + ') : 'None');

function keyName(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  if (e.code.startsWith('Key')) return e.code.slice(3);
  if (e.code.startsWith('Digit')) return e.code.slice(5);
  if (e.code.startsWith('Numpad') && /^\d$/.test(e.code.slice(6))) return `num${e.code.slice(6)}`;
  if (/^F\d{1,2}$/.test(e.code)) return e.code;
  return CODE_KEYS[e.code] ?? null;
}

async function save(patch: Record<string, unknown>) {
  state = await window.api.invoke<State>('settings:set', patch);
  render();
}

function render() {
  const s = state.settings;
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]'))) {
    const v = s[el.dataset.setting!];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v;
    else if (document.activeElement !== el) el.value = String(v);
  }
  (document.getElementById('saveFolder') as HTMLInputElement).value = s.saveFolder;
  for (const input of Array.from(hotkeysEl.querySelectorAll<HTMLInputElement>('.hotkey'))) {
    const action = input.dataset.action!;
    if (!input.classList.contains('recording')) input.value = pretty(s.hotkeys[action]);
    const err = input.parentElement!.querySelector('.error') as HTMLElement;
    err.hidden = !state.failed.includes(action);
  }
}

function buildHotkeys() {
  for (const [action, label] of HOTKEYS) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label>${label} <span class="error" hidden>— in use by another app</span></label><input class="hotkey" readonly>`;
    const input = row.querySelector('input')!;
    input.dataset.action = action;

    const commit = async (accel: string) => {
      input.classList.remove('recording');
      input.blur();
      await save({ hotkeys: { [action]: accel } });
    };
    const handle = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') {
        input.blur();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        commit('');
        return;
      }
      const key = keyName(e);
      if (!key) return;
      const mods: string[] = [];
      if (e.ctrlKey) mods.push('CommandOrControl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      if (!mods.length && !/^(F\d+|PrintScreen)$/.test(key)) return;
      commit([...mods, key].join('+'));
    };

    input.addEventListener('focus', () => {
      window.api.send('hotkeys:suspend', true);
      input.classList.add('recording');
      input.value = 'Press keys…';
    });
    input.addEventListener('blur', () => {
      window.api.send('hotkeys:suspend', false);
      input.classList.remove('recording');
      render();
    });
    input.addEventListener('keydown', handle);
    // Windows only delivers keyup for Print Screen.
    input.addEventListener('keyup', (e) => {
      if (e.code === 'PrintScreen') handle(e);
    });
    hotkeysEl.appendChild(row);
  }
}

function bindInputs() {
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]'))) {
    el.addEventListener('change', () => {
      const key = el.dataset.setting!;
      let value: unknown = el.value;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') value = el.checked;
      else if (el instanceof HTMLInputElement && el.type === 'number') {
        const n = Number(el.value);
        value = Math.max(Number(el.min || 0), Math.min(Number(el.max || 1e9), Number.isFinite(n) ? Math.round(n) : 0));
      }
      save({ [key]: value });
    });
  }
  document.getElementById('browse')!.addEventListener('click', async () => {
    const folder = await window.api.invoke<string | null>('settings:browse');
    if (folder) save({ saveFolder: folder });
  });
  document.getElementById('openFolder')!.addEventListener('click', () => window.api.invoke('history:openFolder'));
}

async function init() {
  buildHotkeys();
  bindInputs();
  state = await window.api.invoke<State>('settings:get');
  render();
}

init();

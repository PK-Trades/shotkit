const PATHS = {
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3Z"/>',
  text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  save: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  select: '<path d="m4 4 7 17 2.5-7.5L21 11Z"/>',
  arrow: '<path d="M5 19 19 5"/><path d="M9 5h10v10"/>',
  line: '<path d="M5 19 19 5"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  pen: '<path d="M3 18c2.5-3 4-9 7-9s1.5 7 4.5 7S18 11 21 9"/>',
  highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  blur: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
  pixelate:
    '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/><rect x="13" y="4" width="7" height="7" opacity=".45"/><rect x="4" y="13" width="7" height="7" opacity=".45"/>',
  counter: '<circle cx="12" cy="12" r="9"/><path d="M10.5 9 12 8v8"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/>',
  background: '<rect x="3" y="3" width="18" height="18" rx="3"/><rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/>',
  fill: '<rect x="4" y="5" width="16" height="14" rx="1.5" fill="currentColor"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  opacity: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor"/>',
  callout: '<path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/>',
  spotlight:
    '<rect x="2" y="3" width="20" height="18" rx="2" fill="currentColor" opacity=".3" stroke="none"/><circle cx="12" cy="12" r="5"/>',
  redact: '<rect x="3" y="9" width="18" height="6" rx="1" fill="currentColor"/><path d="M3 5h7M14 5h7M3 19h4M11 19h10"/>',
  arrowSolid: '<path d="M5 19 13 11"/><path d="M19 5 17 13 11 7Z" fill="currentColor"/>',
  arrowTapered: '<path d="M4.5 19.5 12 11l1 1Z" fill="currentColor" stroke-width="1.5"/><path d="M19 5 17 13 11 7Z" fill="currentColor"/>',
  arrowOpen: '<path d="M5 19 19 5"/><path d="M10 5h9v9"/>',
  arrowDouble:
    '<path d="M9 15 15 9"/><path d="M19 5 17.5 11.5 12.5 6.5Z" fill="currentColor"/><path d="M5 19 6.5 12.5 11.5 17.5Z" fill="currentColor"/>',
  arrowDashed: '<path d="M5 19l2-2M10 14l2-2"/><path d="M19 5 17 13 11 7Z" fill="currentColor"/>',
};

export type IconName = keyof typeof PATHS;

export const svg = (name: IconName) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;

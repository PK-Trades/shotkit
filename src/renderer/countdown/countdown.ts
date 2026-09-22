export {};

const n = document.getElementById('n')!;
const ring = document.getElementById('ring')!;

window.api.on('countdown:tick', (left: number, total: number) => {
  n.textContent = String(left);
  // The ring empties over the second that follows each tick.
  ring.style.transition = 'none';
  ring.style.strokeDashoffset = String(100 - (left / total) * 100);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      ring.style.transition = '';
      ring.style.strokeDashoffset = String(100 - ((left - 1) / total) * 100);
    }),
  );
});

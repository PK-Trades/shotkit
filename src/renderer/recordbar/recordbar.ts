// Recording control bar (timer, Stop, Cancel). Opened with #frame, the same page is the red
// outline drawn around the recorded area.
export {};

if (location.hash === '#frame') {
  document.body.classList.add('frame');
  document.getElementById('frame')!.hidden = false;
} else {
  const time = document.getElementById('time')!;
  let started = 0;
  let timer = 0;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  window.api.on('rec:status', (status: 'recording' | 'saving') => {
    if (status === 'recording') {
      started = Date.now();
      const tick = () => (time.textContent = fmt(Math.floor((Date.now() - started) / 1000)));
      tick();
      timer = window.setInterval(tick, 500);
    } else {
      clearInterval(timer);
      time.textContent = 'Saving…';
      for (const b of Array.from(document.querySelectorAll('button'))) b.disabled = true;
    }
  });

  document.getElementById('stop')!.addEventListener('click', () => window.api.send('rec:stopRequest'));
  document.getElementById('cancel')!.addEventListener('click', () => window.api.send('rec:cancelRequest'));
}

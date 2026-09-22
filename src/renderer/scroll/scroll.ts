export {};

const status = document.getElementById('status')!;

window.api.on('scroll:status', (frames: number, height: number) => {
  status.textContent = `${frames} frames · ${height}px`;
});

document.getElementById('done')!.addEventListener('click', () => window.api.send('scroll:stop'));
document.getElementById('cancel')!.addEventListener('click', () => window.api.send('scroll:cancel'));

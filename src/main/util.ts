import { Notification } from 'electron';
import { appIcon } from './icon';

export function notify(title: string, body: string, onClick?: () => void) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: appIcon(), silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

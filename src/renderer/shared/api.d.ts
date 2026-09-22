export {};

declare global {
  interface Window {
    api: {
      invoke<T = any>(channel: string, ...args: unknown[]): Promise<T>;
      send(channel: string, ...args: unknown[]): void;
      on(channel: string, cb: (...args: any[]) => void): () => void;
    };
  }
}

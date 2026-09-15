export function check(signal: AbortSignal) { if (signal.aborted) throw new Error('Đã dừng tác vụ.'); }
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    check(signal);
    const previous = this.tails.get(key) || Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    let abort!: () => void;
    try {
      await Promise.race([previous, new Promise<never>((_, reject) => { abort = () => reject(new Error('Đã dừng tác vụ.')); signal.addEventListener('abort', abort, { once: true }); })]);
      check(signal); return await work();
    } finally {
      signal.removeEventListener('abort', abort); release();
      void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    }
  }
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  check(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error('Đã dừng tác vụ.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
export async function until<T>(read: () => Promise<T | null | false | undefined>, signal: AbortSignal, timeout = 15000, message = 'Hết thời gian chờ giao diện.'): Promise<T> {
  const deadline = Date.now() + timeout;
  do { check(signal); const result = await read(); if (result !== null && result !== false && result !== undefined) return result as T; await delay(250, signal); } while (Date.now() < deadline);
  throw new Error(message);
}
export async function pooled<T>(items: T[], concurrency: number, signal: AbortSignal, work: (item: T, slot: number) => Promise<void>) {
  let index = 0;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Số luồng không hợp lệ.');
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, (_, slot) => (async () => {
    while (!signal.aborted) { const position = index++; if (position >= items.length) return; await work(items[position], slot); }
  })()));
  check(signal);
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason;
}

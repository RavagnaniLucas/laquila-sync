/**
 * Limitador simples: no máximo `perSecond` chamadas por segundo, em fila.
 * Usado no Bling (3 req/s) e na Laquila (limite desconhecido, começamos devagar).
 */
export class RateLimiter {
  private queue: Array<() => void> = [];
  private stamps: number[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly perSecond: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => fn().then(resolve, reject));
      this.drain();
    });
  }

  private drain(): void {
    if (this.timer) return;
    const now = Date.now();
    this.stamps = this.stamps.filter((t) => now - t < 1000);
    while (this.queue.length && this.stamps.length < this.perSecond) {
      this.stamps.push(now);
      this.queue.shift()!();
    }
    if (this.queue.length) {
      const wait = 1000 - (now - this.stamps[0]!);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, Math.max(wait, 10));
    }
  }
}

export async function withRetry<T>(fn: () => Promise<T>, opts: { tries?: number; baseMs?: number; retryOn?: (e: unknown) => boolean } = {}): Promise<T> {
  const tries = opts.tries ?? 4;
  const base = opts.baseMs ?? 1000;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (opts.retryOn && !opts.retryOn(e)) throw e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, base * 2 ** i + Math.random() * 250));
    }
  }
  throw last;
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

export const isTransient = (e: unknown): boolean =>
  !(e instanceof HttpError) || e.status === 429 || e.status >= 500;

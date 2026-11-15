// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Caps how many requests a decision backend has in flight. A burst of gate
 * checks (a sync landing a hundred emails) would otherwise open a hundred
 * connections to a local server that answers one at a time, and every request
 * past the first few would time out waiting in its queue.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<{ start: () => void; signal?: AbortSignal }> = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error("Concurrency limit must be at least 1");
  }

  /** Requests currently running, for tests and diagnostics. */
  get running(): number {
    return this.active;
  }

  /** Requests waiting for a slot. */
  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          this.active += 1;
          resolve();
        },
        ...(signal ? { signal } : {}),
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(entry);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    next?.start();
  }
}

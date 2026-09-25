// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tiny helper that captures the timer-backed promise pattern used by
 * worker proxies: caller posts a message keyed by an id, awaits the
 * paired result, and gets a timeout-rejection if the worker never
 * answers. The proxy owns the id → PendingRequest map; this class just
 * holds the resolve/reject/timer trio and clears the timer on settle.
 */
export class PendingRequest<T> {
  readonly promise: Promise<T>;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (err: Error) => void;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs: number, onTimeout: () => void) {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    this.timer = setTimeout(onTimeout, timeoutMs);
  }

  settle(value: T): void {
    clearTimeout(this.timer);
    this.resolveFn(value);
  }

  fail(err: Error): void {
    clearTimeout(this.timer);
    this.rejectFn(err);
  }
}

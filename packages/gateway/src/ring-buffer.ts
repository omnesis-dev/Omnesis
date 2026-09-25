// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fixed-capacity ring buffer of timestamped samples.
 *
 * Overwrites the oldest sample once full. Shared by the process-vitals
 * collector and the request/writer-queue metrics registry — both keep
 * rolling time windows of `{ ts, … }` samples and read them back in
 * chronological order, so the head/count/modulo bookkeeping lives here once.
 */
export class Ring<T extends { ts: number }> {
  private buf: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private readonly size: number) {
    this.buf = new Array(size);
  }

  push(sample: T): void {
    this.buf[this.head] = sample;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count += 1;
  }

  inWindow(cutoff: number): T[] {
    // Walk from the logical oldest slot so the result is ascending by
    // ts. Once the ring is full, `head` points at the oldest sample
    // (the next write would overwrite it); before that the oldest is
    // slot 0. Iterating raw slot order would return a head-rotated,
    // non-chronological array once the ring has wrapped.
    const start = this.count < this.size ? 0 : this.head;
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const s = this.buf[(start + i) % this.size];
      if (s && s.ts >= cutoff) result.push(s);
    }
    return result;
  }

  latest(): T | null {
    if (this.count === 0) return null;
    const idx = (this.head - 1 + this.size) % this.size;
    return this.buf[idx] ?? null;
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface QuotaPacerOptions {
  /** The quota units the pacer lets through per minute, on average. */
  unitsPerMinute: number;
  /**
   * The most units it lets through at once after sitting idle. Over any
   * window of `t` minutes at most `burstUnits + unitsPerMinute * t` pass, so
   * the two together bound what one minute can spend.
   */
  burstUnits: number;
}

/**
 * A token bucket counted in quota units.
 *
 * Every request takes its cost from the bucket before it is sent, waiting
 * for the bucket to refill when it is short, so any number of concurrent
 * callers sharing one pacer spend no faster than its rate. Callers are served
 * in the order they asked, so a cheap request never starves an expensive one.
 */
export class QuotaPacer {
  private readonly unitsPerMs: number;
  private readonly burstUnits: number;
  private tokens: number;
  private refilledAt: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: QuotaPacerOptions) {
    if (!(opts.unitsPerMinute > 0)) throw new RangeError("unitsPerMinute must be positive");
    if (!(opts.burstUnits > 0)) throw new RangeError("burstUnits must be positive");
    this.unitsPerMs = opts.unitsPerMinute / 60_000;
    this.burstUnits = opts.burstUnits;
    this.tokens = opts.burstUnits;
    this.refilledAt = Date.now();
  }

  /** A pacer that never waits. */
  static unlimited(): QuotaPacer {
    return new QuotaPacer({
      unitsPerMinute: Number.POSITIVE_INFINITY,
      burstUnits: Number.POSITIVE_INFINITY,
    });
  }

  /** Resolve once `units` may be spent; they are spent from that moment on. */
  acquire(units: number): Promise<void> {
    if (!Number.isFinite(this.unitsPerMs)) return Promise.resolve();
    const turn = this.queue.then(() => this.take(units));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async take(units: number): Promise<void> {
    // A request dearer than the whole bucket waits for a full one and leaves
    // it in debt, so the average rate still holds.
    const needed = Math.min(units, this.burstUnits);
    for (;;) {
      this.refill();
      if (this.tokens >= needed) {
        this.tokens -= units;
        return;
      }
      const waitMs = Math.max(1, Math.ceil((needed - this.tokens) / this.unitsPerMs));
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.refilledAt);
    this.tokens = Math.min(this.burstUnits, this.tokens + elapsed * this.unitsPerMs);
    this.refilledAt = now;
  }
}

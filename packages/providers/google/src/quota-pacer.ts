// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export interface QuotaPacerOptions {
  /**
   * The quota units the pacer lets through per minute, on average. With
   * `adaptive`, it is the ceiling the pace starts at and never rises above.
   */
  unitsPerMinute: number;
  /**
   * The most units it lets through at once after sitting idle. Over any
   * window of `t` minutes at most `burstUnits + unitsPerMinute * t` pass, so
   * the two together bound what one minute can spend.
   */
  burstUnits: number;
  /** How the pace answers rate limits. Without it the pace is fixed. */
  adaptive?: AdaptivePaceOptions;
}

/**
 * Additive increase, multiplicative decrease: a rate limit cuts the pace by
 * `decreaseFactor`, and each quiet period after it adds back
 * `increaseUnitsPerMinute`. The quota a limit reports may be shared with
 * other clients of the same account, whose spend this pacer cannot see, so
 * the pace it can hold is learned from the limits it meets.
 */
export interface AdaptivePaceOptions {
  /** The lowest pace a rate limit cuts to. */
  floorUnitsPerMinute: number;
  /** What a rate limit multiplies the pace by, between 0 and 1. */
  decreaseFactor: number;
  /** What each quiet period adds back to the pace. */
  increaseUnitsPerMinute: number;
  /** How long without a rate limit, ending on a request that succeeds, makes a quiet period. */
  quietMs: number;
  /**
   * For this long after a rate limit, the pace rises to one increase short
   * of the pace that met it and no further; after it, the pace probes up to
   * the ceiling again, in case whatever else spent the quota has stopped.
   */
  holdMs: number;
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
  private readonly ceiling: number;
  private readonly burstUnits: number;
  private readonly adaptive: AdaptivePaceOptions | undefined;
  private rate: number;
  private tokens: number;
  private refilledAt: number;
  private queue: Promise<void> = Promise.resolve();
  /** When the current quiet period began: the last rate limit or the last increase. */
  private quietSince: number;
  /** The pace that met the last rate limit, and when. */
  private limited: { rate: number; at: number } | undefined;

  constructor(opts: QuotaPacerOptions) {
    if (!(opts.unitsPerMinute > 0)) throw new RangeError("unitsPerMinute must be positive");
    if (!(opts.burstUnits > 0)) throw new RangeError("burstUnits must be positive");
    const adaptive = opts.adaptive;
    if (adaptive) {
      if (!(
        adaptive.floorUnitsPerMinute > 0 && adaptive.floorUnitsPerMinute <= opts.unitsPerMinute
      ))
        throw new RangeError("floorUnitsPerMinute must be positive and at most unitsPerMinute");
      if (!(adaptive.decreaseFactor > 0 && adaptive.decreaseFactor < 1))
        throw new RangeError("decreaseFactor must be between 0 and 1");
      if (!(adaptive.increaseUnitsPerMinute > 0))
        throw new RangeError("increaseUnitsPerMinute must be positive");
    }
    this.ceiling = opts.unitsPerMinute;
    this.rate = opts.unitsPerMinute;
    this.burstUnits = opts.burstUnits;
    this.adaptive = Number.isFinite(opts.unitsPerMinute) ? adaptive : undefined;
    this.tokens = opts.burstUnits;
    this.refilledAt = Date.now();
    this.quietSince = this.refilledAt;
  }

  /** A pacer that never waits. */
  static unlimited(): QuotaPacer {
    return new QuotaPacer({
      unitsPerMinute: Number.POSITIVE_INFINITY,
      burstUnits: Number.POSITIVE_INFINITY,
    });
  }

  /** The pace now, in units per minute. */
  get unitsPerMinute(): number {
    return this.rate;
  }

  /** Resolve once `units` may be spent; they are spent from that moment on. */
  acquire(units: number): Promise<void> {
    if (!Number.isFinite(this.rate)) return Promise.resolve();
    const turn = this.queue.then(() => this.take(units));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  /**
   * A request was refused for rate limit: cut the pace and start a new quiet
   * period. Returns the new pace when it changed.
   */
  rateLimited(): number | undefined {
    const adaptive = this.adaptive;
    if (!adaptive) return undefined;
    const now = Date.now();
    this.quietSince = now;
    this.limited = { rate: this.rate, at: now };
    const next = Math.max(
      adaptive.floorUnitsPerMinute,
      Math.round(this.rate * adaptive.decreaseFactor),
    );
    return this.setRate(next);
  }

  /**
   * A request succeeded: once a quiet period has passed, raise the pace one
   * step and start the next. Returns the new pace when it changed.
   */
  succeeded(): number | undefined {
    const adaptive = this.adaptive;
    if (!adaptive) return undefined;
    const now = Date.now();
    if (now - this.quietSince < adaptive.quietMs) return undefined;
    const held =
      this.limited && now - this.limited.at < adaptive.holdMs
        ? this.limited.rate - adaptive.increaseUnitsPerMinute
        : this.ceiling;
    const next = Math.min(this.ceiling, held, this.rate + adaptive.increaseUnitsPerMinute);
    if (next <= this.rate) return undefined;
    this.quietSince = now;
    return this.setRate(next);
  }

  private setRate(next: number): number | undefined {
    if (next === this.rate) return undefined;
    // What the bucket gathered so far was gathered at the old pace.
    this.refill();
    this.rate = next;
    return next;
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
      const waitMs = Math.max(1, Math.ceil(((needed - this.tokens) * 60_000) / this.rate));
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.refilledAt);
    this.tokens = Math.min(this.burstUnits, this.tokens + (elapsed * this.rate) / 60_000);
    this.refilledAt = now;
  }
}

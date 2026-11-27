// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const PUBLIC_ROUTE_REFRESH_MS = 30_000;
export const PUBLIC_ROUTE_MAX_AGE_MS = 90_000;
export interface PublicRouteBinding {
  /** Internal identity only: origin, certificate and current tunnel incarnation. */
  identity: string;
  expiresAt: number;
}
export interface PublicRouteEvidence {
  checkedAt: number;
  validUntil: number;
}
/** One physical probe across all generations. Invalidated work can never publish fresh evidence. */
export class PublicRouteProbe {
  private generation = 0;
  private identity: string | undefined;
  private abort = new AbortController();
  private pending: { generation: number; work: Promise<boolean> } | undefined;
  private evidence: (PublicRouteEvidence & { monotonicAt: number }) | undefined;
  constructor(
    private readonly clocks = { wall: () => Date.now(), monotonic: () => performance.now() },
  ) {}

  invalidate(): void {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.identity = undefined;
    this.evidence = undefined;
  }
  /** Cancellation never releases physical ownership; stop/close joins this retained promise. */
  async join(): Promise<void> {
    await this.pending?.work;
  }
  private bind(binding: PublicRouteBinding): void {
    if (binding.identity === this.identity) return;
    this.invalidate();
    this.identity = binding.identity;
  }
  snapshot(binding: PublicRouteBinding): PublicRouteEvidence | undefined {
    this.bind(binding);
    const evidence = this.evidence;
    if (!evidence) return undefined;
    const now = this.clocks.wall(),
      elapsed = this.clocks.monotonic() - evidence.monotonicAt;
    if (
      now < evidence.checkedAt ||
      now >= evidence.validUntil ||
      elapsed < 0 ||
      elapsed >= evidence.validUntil - evidence.checkedAt ||
      binding.expiresAt <= now
    ) {
      this.evidence = undefined;
      return undefined;
    }
    return {
      checkedAt: evidence.checkedAt,
      validUntil: Math.min(evidence.validUntil, binding.expiresAt),
    };
  }
  async check(
    binding: PublicRouteBinding,
    signal: AbortSignal,
    probe: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<boolean> {
    signal.throwIfAborted();
    this.bind(binding);
    const generation = this.generation;
    // Even an aborted, noncooperative probe retains its slot until actual settlement.
    if (this.pending) {
      if (this.pending.generation === generation) return this.pending.work;
      await this.pending.work.catch(() => undefined);
      signal.throwIfAborted();
      if (generation !== this.generation) return false;
      return this.check(binding, signal, probe);
    }
    const active = AbortSignal.any([signal, this.abort.signal, AbortSignal.timeout(5000)]);
    const invalidate = () => {
      if (generation === this.generation) this.evidence = undefined;
    };
    active.addEventListener("abort", invalidate, { once: true });
    const work = Promise.resolve()
      .then(() => {
        active.throwIfAborted();
        return probe(active);
      })
      .then((ready) => {
        if (generation !== this.generation || active.aborted) return false;
        invalidate();
        if (!ready) return false;
        const checkedAt = this.clocks.wall(),
          validUntil = Math.min(checkedAt + PUBLIC_ROUTE_MAX_AGE_MS, binding.expiresAt);
        if (
          Number.isSafeInteger(checkedAt) &&
          Number.isSafeInteger(validUntil) &&
          validUntil > checkedAt
        )
          this.evidence = { checkedAt, validUntil, monotonicAt: this.clocks.monotonic() };
        return ready;
      })
      .catch((error: unknown) => {
        invalidate();
        throw error;
      })
      .finally(() => {
        active.removeEventListener("abort", invalidate);
        // A successor cannot acquire this physical slot until this promise settles.
        this.pending = undefined;
      });
    this.pending = { generation, work };
    return work;
  }
}

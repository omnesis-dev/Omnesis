// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-source recurring-sync timers with a jittered first tick.
 *
 * Without jitter, a collector restart synchronises every source timer
 * to t=0, so every `intervalMs` tick fires N sources in parallel — CPU
 * and network spikes. We delay the first tick by a random offset in
 * `[0, intervalMs * 0.25]` so sources spread out permanently
 * (subsequent ticks stay at the exact configured interval).
 */

/**
 * Hard ceiling on a one-shot rate-limit deferral (#616). Node's `setTimeout`
 * clamps any delay above ~24.8 days (2^31-1 ms, TIMEOUT_MAX) to 1 (it fires on
 * the next tick, effectively immediately) — so an un-capped `Retry-After` larger
 * than that would turn a back-off into an *immediate* retry loop against the
 * rate-limited upstream. Cap well under that so a hostile or buggy `Retry-After`
 * defers at most a day and never overflows.
 */
export const MAX_DEFER_MS = 24 * 60 * 60 * 1000; // 24h

export class SyncScheduler {
  private steady = new Map<string, ReturnType<typeof setInterval>>();
  /**
   * Handles for the one-shot timers that fire the *first* tick after
   * the jittered delay, and the one-shot deferral timer (#616). Both are
   * `setTimeout`s, so clearInterval doesn't touch them — we need
   * clearTimeout. The first-tick entry is cleared once it promotes into
   * the steady-state setInterval; the deferral entry is cleared when its
   * deferred tick fires and re-arms the steady interval.
   */
  private firstTick = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Per-source configured interval, remembered so a one-shot
   * {@link deferNext} can re-arm the steady cadence after the deferred
   * tick fires.
   */
  private intervals = new Map<string, number>();
  /**
   * The per-source tick callback, remembered for the same reason as
   * {@link intervals} — the deferred one-shot needs to invoke it and then
   * resume the steady interval over the identical callback.
   */
  private ticks = new Map<string, () => void>();

  /**
   * Schedule a source's recurring sync. Re-scheduling a source that's
   * already armed clears the old timer first to avoid leaking the
   * handle (Map.set overwrites the entry, but the underlying setInterval
   * keeps firing). This matters now that the re-auth flow replaces
   * source instances in place — the old timer's closure pinned the old
   * source ref with a now-revoked OAuth client.
   */
  schedule(sourceId: string, tick: () => void, intervalMs: number): void {
    this.clear(sourceId);
    this.intervals.set(sourceId, intervalMs);
    this.ticks.set(sourceId, tick);
    const jitterMs = Math.floor(Math.random() * intervalMs * 0.25);
    const firstDelay = intervalMs + jitterMs;
    const firstTick = setTimeout(() => {
      this.firstTick.delete(sourceId);
      tick();
      const steady = setInterval(tick, intervalMs);
      this.steady.set(sourceId, steady);
    }, firstDelay);
    this.firstTick.set(sourceId, firstTick);
  }

  /**
   * One-shot rate-limit deferral (#616). Tear down the source's current
   * timer (first-tick or steady) and arm a single `setTimeout` at
   * `delayMs`; when it fires it runs the remembered tick once and re-arms
   * the steady `setInterval` at the *configured* interval — so the source
   * returns to normal cadence after exactly one deferred tick.
   *
   * `delayMs` is computed by the caller as `max(interval, retryAfterMs)`
   * so a back-off shorter than the interval never pulls the next tick
   * *earlier* than the source would normally run, and is clamped to
   * {@link MAX_DEFER_MS} here so a huge `Retry-After` can't overflow
   * `setTimeout`. No-op if the source was never scheduled (e.g. push-based)
   * — there's nothing to defer.
   */
  deferNext(sourceId: string, delayMs: number): void {
    const tick = this.ticks.get(sourceId);
    const intervalMs = this.intervals.get(sourceId);
    if (tick === undefined || intervalMs === undefined) return;

    // Stop whatever timer is currently armed without forgetting the
    // remembered interval/tick (clear() drops those; we re-set below).
    const ft = this.firstTick.get(sourceId);
    if (ft) {
      clearTimeout(ft);
      this.firstTick.delete(sourceId);
    }
    const st = this.steady.get(sourceId);
    if (st) {
      clearInterval(st);
      this.steady.delete(sourceId);
    }

    const armDelay = Math.min(Math.max(0, delayMs), MAX_DEFER_MS);
    const deferred = setTimeout(() => {
      this.firstTick.delete(sourceId);
      tick();
      const steady = setInterval(tick, intervalMs);
      this.steady.set(sourceId, steady);
    }, armDelay);
    // Reuse the firstTick map: it already holds "one-shot setTimeout that
    // promotes to a steady interval", which is exactly this timer's shape,
    // so `clear` / `has` / `clearAll` handle it with no extra bookkeeping.
    this.firstTick.set(sourceId, deferred);
  }

  /** Clear both the first-tick timeout and the steady-state interval. */
  clear(sourceId: string): void {
    const ft = this.firstTick.get(sourceId);
    if (ft) {
      clearTimeout(ft);
      this.firstTick.delete(sourceId);
    }
    const st = this.steady.get(sourceId);
    if (st) {
      clearInterval(st);
      this.steady.delete(sourceId);
    }
    this.intervals.delete(sourceId);
    this.ticks.delete(sourceId);
  }

  /** True if a timer is armed (either first-tick pending or steady). */
  has(sourceId: string): boolean {
    return this.firstTick.has(sourceId) || this.steady.has(sourceId);
  }

  /** Tear down every timer. Used by `stopSyncLoop`. */
  clearAll(): void {
    for (const [, timer] of this.firstTick) clearTimeout(timer);
    this.firstTick.clear();
    for (const [, timer] of this.steady) clearInterval(timer);
    this.steady.clear();
    this.intervals.clear();
    this.ticks.clear();
  }
}

/** Format a millisecond interval as `Nh` / `Nm` / `Ns` for log lines. */
export function formatInterval(intervalMs: number): string {
  return intervalMs >= 3_600_000
    ? `${intervalMs / 3_600_000}h`
    : intervalMs >= 60_000
      ? `${intervalMs / 60_000}m`
      : `${intervalMs / 1000}s`;
}

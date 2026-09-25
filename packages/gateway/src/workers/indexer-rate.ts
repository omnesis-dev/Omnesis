// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure throughput / ETA math for the indexer.
 *
 * The indexer worker keeps a rolling history of {ts, totalIndexed} samples
 * (one per completed cycle) and derives a docs-per-second rate from it.
 * The /index/stats route then turns that rate plus the remaining backlog
 * into an ETA. Both computations live here as side-effect-free functions
 * so they can be unit-tested without booting a worker or an HTTP server.
 */

/** One throughput sample: an absolute indexed-document count at a wall-clock ms. */
export interface IndexRateSample {
  /** Wall-clock ms (Date.now()) when the sample was taken. */
  ts: number;
  /** Absolute count of indexed documents at `ts` (not a per-cycle delta). */
  totalIndexed: number;
}

/**
 * Minimum span the oldest→newest samples must cover before a rate is
 * trusted. A pair of samples a few hundred ms apart yields a noisy,
 * wildly-swinging rate; require a few seconds so the figure is stable.
 */
export const MIN_RATE_WINDOW_MS = 3_000;

/**
 * Compute docs/sec from a sample history, or null when there isn't enough
 * signal to trust a figure:
 *   - fewer than 2 samples (can't measure a delta),
 *   - oldest→newest span shorter than MIN_RATE_WINDOW_MS,
 *   - non-positive progress over the window (idle / went backwards).
 *
 * Uses the oldest and newest samples (the widest window available) rather
 * than adjacent pairs, smoothing over bursty single cycles.
 */
export function computeRatePerSec(history: readonly IndexRateSample[]): number | null {
  if (history.length < 2) return null;
  const oldest = history[0];
  const newest = history[history.length - 1];
  const elapsedMs = newest.ts - oldest.ts;
  if (elapsedMs < MIN_RATE_WINDOW_MS) return null;
  const progress = newest.totalIndexed - oldest.totalIndexed;
  if (progress <= 0) return null;
  return progress / (elapsedMs / 1000);
}

/**
 * Compute the ETA (whole seconds) to clear `remaining` docs at
 * `ratePerSec`, or null when an ETA is meaningless:
 *   - rate unknown (null) or non-positive,
 *   - nothing remaining (remaining <= 0).
 */
export function computeEtaSeconds(remaining: number, ratePerSec: number | null): number | null {
  if (ratePerSec === null || ratePerSec <= 0) return null;
  if (remaining <= 0) return null;
  return Math.round(remaining / ratePerSec);
}

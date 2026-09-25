// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Progress trackers — the four shapes a background job's progress can
 * take. Each implements `ProgressTracker.observe()` returning the
 * matching `JobProgress` variant.
 *
 * Trackers hold in-memory state. A task's `run()` updates its tracker
 * on each tick (e.g. `tracker.recordTick(processed)`); a periodic
 * ground-truth reconciliation elsewhere may call setters like
 * `tracker.setRemaining(count)` to correct drift.
 *
 * Trackers must NOT issue DB queries. They are read by the registry
 * cache refresh on a 2s tick — turning that into a per-tracker DB hit
 * would directly worsen writer-queue contention. Counters are always derived from
 * already-computed work or from external reconciliation.
 */

import type { JobProgress, ProgressTracker } from "./types.js";

// ── QueueTracker ─────────────────────────────────────────────────────

/**
 * Tracks a drip loop with a backlog of items to process.
 *
 *   - `recordTick(processed)`: called once per task tick with the count
 *     of items processed in that tick. Decrements `remaining` and feeds
 *     the rate window.
 *   - `setRemaining(n)`: called periodically (every ~5 min) by an
 *     external reconciler that issues the actual COUNT(*) and writes
 *     the ground truth back. Resets `remaining` so accumulated drift
 *     doesn't compound.
 *   - `recordItemsAdded(n)`: optional hook for when new work arrives
 *     faster than the next reconciliation. If wired up, keeps the
 *     gauge from underestimating between refreshes.
 */
export class QueueTracker implements ProgressTracker {
  private remaining: number;
  private processedSinceBoot = 0;
  /** Ring buffer of (ts, processed) for rate computation. */
  private readonly rateWindow: Array<{ ts: number; processed: number }> = [];
  /** Window for rate computation (ms). */
  private readonly rateWindowMs: number;
  private groundTruthAt?: number;
  private oldestPendingMs?: number;
  private pendingSlaMs?: number;

  constructor(
    opts: {
      /**
       * Initial backlog estimate. Pass 0 if unknown — the reconciler
       * should fix it on the first refresh.
       */
      initialRemaining?: number;
      /**
       * Window for rate computation (ms). Default 60_000 (last minute).
       */
      rateWindowMs?: number;
    } = {},
  ) {
    this.remaining = Math.max(0, opts.initialRemaining ?? 0);
    this.rateWindowMs = opts.rateWindowMs ?? 60_000;
  }

  /**
   * Record one tick's worth of work. `processed` items moved from the
   * backlog into "done"; `remaining` decreases by the same amount.
   * Pass 0 to record a tick that found no work (still feeds the rate
   * window; useful for "is the loop even running?").
   */
  recordTick(processed: number): void {
    if (!Number.isFinite(processed) || processed < 0) return;
    this.processedSinceBoot += processed;
    this.remaining = Math.max(0, this.remaining - processed);
    const now = Date.now();
    this.rateWindow.push({ ts: now, processed });
    this.evictExpired(now);
  }

  /**
   * Replace `remaining` with a freshly-computed ground truth.
   * Call this from a separate periodic reconciler that issues the
   * actual COUNT(*) — never from inside the tracker itself.
   */
  setRemaining(remaining: number, at: number = Date.now()): void {
    if (!Number.isFinite(remaining) || remaining < 0) return;
    this.remaining = Math.floor(remaining);
    this.groundTruthAt = at;
  }

  /**
   * Record how long the item at the head of the backlog has been waiting.
   * Supplied by the same ground-truth pass that sets `remaining` — the
   * scan that counts the backlog already visits its oldest row. Pass
   * null when the backlog is empty.
   */
  setOldestPendingMs(oldestPendingMs: number | null, slaMs?: number): void {
    this.oldestPendingMs =
      oldestPendingMs === null || !Number.isFinite(oldestPendingMs) || oldestPendingMs < 0
        ? undefined
        : Math.floor(oldestPendingMs);
    this.pendingSlaMs =
      slaMs === undefined || !Number.isFinite(slaMs) || slaMs <= 0 ? undefined : Math.floor(slaMs);
  }

  /**
   * Optional: bump the backlog when new work arrives. Useful for
   * tighter accuracy between reconciliation passes. Most callers can
   * skip this and rely on the periodic ground-truth refresh instead.
   */
  recordItemsAdded(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.remaining += Math.floor(count);
  }

  observe(): JobProgress {
    const now = Date.now();
    this.evictExpired(now);
    const totalProcessed = this.rateWindow.reduce((sum, e) => sum + e.processed, 0);
    // Per-second rate over the actual window (handles short uptime).
    const earliest = this.rateWindow[0]?.ts ?? now;
    const windowSec = Math.max(1, (now - earliest) / 1000);
    const rateLastMin = totalProcessed / windowSec;
    return {
      kind: "queue",
      remaining: this.remaining,
      processedSinceBoot: this.processedSinceBoot,
      rateLastMin: Math.round(rateLastMin * 100) / 100,
      groundTruthAt: this.groundTruthAt,
      oldestPendingMs: this.oldestPendingMs,
      pendingSlaMs: this.pendingSlaMs,
    };
  }

  private evictExpired(now: number): void {
    const cutoff = now - this.rateWindowMs;
    while (this.rateWindow.length > 0 && this.rateWindow[0].ts < cutoff) {
      this.rateWindow.shift();
    }
  }
}

// ── WatermarkTracker ─────────────────────────────────────────────────

/**
 * Tracks a loop that walks documents in cursor order (e.g. the indexer
 * cycle, which advances a `last_updated_at` watermark in index.db).
 *
 *   - `setWatermark(cursor, lagDocs?, lagSec?)`: called after each
 *     cycle with the new cursor and the gap to ground truth.
 */
export class WatermarkTracker implements ProgressTracker {
  private cursor: string = "";
  private lagDocs?: number;
  private lagSec?: number;

  setWatermark(cursor: string, lagDocs?: number, lagSec?: number): void {
    this.cursor = cursor;
    this.lagDocs = lagDocs;
    this.lagSec = lagSec;
  }

  observe(): JobProgress {
    return {
      kind: "watermark",
      cursor: this.cursor,
      lagDocs: this.lagDocs,
      lagSec: this.lagSec,
    };
  }
}

// ── ScanTracker ──────────────────────────────────────────────────────

/**
 * Tracks a sweep / scan loop that walks an entire dataset on each pass
 * (e.g. reconcile-deleted, reindex-missing). `coverage` is 0..1; a
 * completed sweep resets to 1 (fully covered) and updates the
 * `lastSweepCompletedAt` timestamp.
 *
 *   - `recordSweepProgress(coverage)`: optional, for sweeps that can
 *     report mid-pass progress.
 *   - `recordSweepCompleted({ checked, affected })`: called when a
 *     full pass finishes. Sets `coverage=1` and the timestamp.
 */
export class ScanTracker implements ProgressTracker {
  /** Coverage of the current sweep (0..1). 1 = up-to-date. */
  private coverage = 1;
  private lastSweepCompletedAt?: number;
  private itemsCheckedLastSweep?: number;
  private itemsAffectedLastSweep?: number;

  recordSweepProgress(coverage: number): void {
    if (!Number.isFinite(coverage)) return;
    this.coverage = Math.min(1, Math.max(0, coverage));
  }

  recordSweepCompleted(
    opts: {
      checked?: number;
      affected?: number;
    } = {},
  ): void {
    this.coverage = 1;
    this.lastSweepCompletedAt = Date.now();
    if (opts.checked !== undefined) this.itemsCheckedLastSweep = opts.checked;
    if (opts.affected !== undefined) {
      this.itemsAffectedLastSweep = opts.affected;
    }
  }

  /** Mark a fresh sweep as starting; coverage resets to 0. */
  recordSweepStarted(): void {
    this.coverage = 0;
  }

  observe(): JobProgress {
    return {
      kind: "scan",
      coverage: this.coverage,
      lastSweepCompletedAt: this.lastSweepCompletedAt,
      itemsCheckedLastSweep: this.itemsCheckedLastSweep,
      itemsAffectedLastSweep: this.itemsAffectedLastSweep,
    };
  }
}

// ── StatelessTracker ─────────────────────────────────────────────────

/**
 * For loops with no meaningful progress concept (cache refreshes, plumbing).
 * Always returns `{ kind: "stateless" }`. Exists so every BackgroundJob
 * has a tracker — keeping the registry / UI uniform — without forcing
 * fake progress numbers.
 */
export class StatelessTracker implements ProgressTracker {
  observe(): JobProgress {
    return { kind: "stateless" };
  }
}

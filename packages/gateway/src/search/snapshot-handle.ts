// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search snapshot handle.
 *
 * Opens a dedicated read-only connection to `index.db`, takes a WAL
 * read snapshot via `BEGIN`, and exposes the handle to the search
 * pipeline. The transaction stays open indefinitely so the per-
 * connection page cache isn't invalidated by concurrent indexer
 * writes — the reader's view is frozen at the snapshot point and
 * SQLite never needs to re-fetch already-cached pages.
 *
 * A periodic refresher runs `COMMIT; BEGIN;` on the same handle to
 * advance the snapshot to the latest WAL head. With the operator's
 * chosen cadence of 10 minutes, fresh writes become visible to search
 * within that window. The handle's own page cache survives the
 * refresh — only pages whose contents changed in the WAL need to be
 * re-read from disk, which is a small fraction of the working set.
 *
 * Concurrency notes:
 *
 *   - better-sqlite3 is fully synchronous and blocks the JS thread for
 *     the duration of each call. Two queries on the same connection
 *     cannot interleave from the same process, so we do NOT need a
 *     mutex around `COMMIT; BEGIN;` vs. ongoing reads: the periodic
 *     refresh fires from `setInterval`, which only executes between
 *     event-loop turns, i.e. when no SQL call is in flight.
 *   - A `refreshing` boolean prevents an in-flight refresh from
 *     overlapping with itself if a manual `refresh()` is called from
 *     the admin route while the periodic timer is mid-refresh (should
 *     be impossible given synchronous execution, but cheap defense).
 *
 * Failure handling:
 *
 *   - If `COMMIT` succeeds but `BEGIN` throws, we try `BEGIN` once
 *     more so the handle doesn't end up txn-less. If that also
 *     throws, the next query on the handle will auto-start an
 *     implicit transaction — correct but loses the long-snapshot
 *     property until the next periodic refresh.
 */

import { createLogger } from "@omnesis/core";
import { openIndexDb } from "../indexer/db.js";
import type Database from "better-sqlite3";

const log = createLogger("gateway:search").child("snapshot");

type Db = Database.Database;

export interface SearchSnapshotStats {
  /** Wall-clock ms when the handle was opened. */
  readonly openedAt: number;
  /** Number of successful `COMMIT; BEGIN;` refresh cycles since open. */
  readonly refreshCount: number;
  /** Wall-clock ms of the most recent successful refresh, or null. */
  readonly lastRefreshAt: number | null;
  /** Duration of the most recent refresh in ms. */
  readonly lastRefreshDurationMs: number;
  /** Number of refresh attempts that threw. */
  readonly refreshErrors: number;
}

export interface SearchSnapshotHandle {
  /** Read-only DB handle in a long-lived BEGIN. Use for search SQL. */
  readonly db: Db;
  /** Force a refresh now. Returns the refresh duration in ms. */
  refresh(): Promise<number>;
  /** Stop the periodic refresher (if any), COMMIT, and close the db. */
  close(): void;
  /** Snapshot of lifecycle stats. */
  stats(): SearchSnapshotStats;
}

export interface OpenSearchSnapshotHandleOptions {
  /**
   * Whether to hold a long-lived `BEGIN` on the handle for snapshot
   * isolation. Default `true` (the historic behaviour). When `false`,
   * the handle is opened read-only with the same pragmas
   * (`readHandle.mmapBytes` + `readHandle.cacheSizeBytes`) but no
   * transaction is anchored — each query takes its own implicit read
   * snapshot. Refresh becomes a no-op. Useful for measuring
   * "mmap-on, snapshot-off" configurations without giving up the
   * dedicated read handle.
   */
  holdSnapshot?: boolean;
  /**
   * Periodic refresh interval in ms. 0 (or omitted) disables the
   * automatic refresher; callers must invoke `refresh()` themselves
   * (e.g. from a manual admin endpoint). Useful for tests. Ignored
   * when `holdSnapshot === false`.
   */
  refreshIntervalMs?: number;
  /**
   * `PRAGMA mmap_size` value for this read-only handle. Sourced from
   * `search.readHandle.mmapBytes` in `omnesis.json` (default 1 GiB).
   * Phase-0 measurement showed mmap on the snapshot reader drops p99
   * by 82% under live ingest. See `OpenIndexDbOptions.mmapBytes` for
   * the safety reasoning.
   */
  mmapBytes?: number;
  /**
   * `PRAGMA cache_size` value for this handle in bytes. Sourced from
   * `search.readHandle.cacheSizeBytes`. Default 1 GiB. With mmap on,
   * the pcache is mostly redundant; a small value (~2 MiB) suffices
   * for prepared-statement plans + transaction state. Pending E8b
   * measurement before reducing the default.
   */
  cacheSizeBytes?: number;
  /** Index DB storage key, when live storage encryption is enabled. */
  encryptionKey?: Buffer | null;
}

class SnapshotHandleImpl implements SearchSnapshotHandle {
  readonly db: Db;
  private readonly holdSnapshot: boolean;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private closed = false;
  private readonly statsState: {
    openedAt: number;
    refreshCount: number;
    lastRefreshAt: number | null;
    lastRefreshDurationMs: number;
    refreshErrors: number;
  };

  constructor(db: Db, holdSnapshot: boolean) {
    this.db = db;
    this.holdSnapshot = holdSnapshot;
    this.statsState = {
      openedAt: Date.now(),
      refreshCount: 0,
      lastRefreshAt: null,
      lastRefreshDurationMs: 0,
      refreshErrors: 0,
    };
  }

  startPeriodicRefresh(intervalMs: number): void {
    if (!this.holdSnapshot) return;
    if (this.refreshTimer) return;
    if (intervalMs <= 0) return;
    this.refreshTimer = setInterval(() => {
      // Fire and forget — `refresh()` swallows its own errors into
      // refreshErrors so an unhandled rejection can't crash the
      // gateway from a transient SQLITE_BUSY.
      this.refresh().catch((err) => {
        log.error(`periodic refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
    this.refreshTimer.unref?.();
  }

  async refresh(): Promise<number> {
    if (this.closed) throw new Error("snapshot handle is closed");
    // When snapshot isolation isn't held, refresh is a no-op — the
    // handle has no anchored BEGIN to advance. Stats keep ticking so
    // observability remains identical.
    if (!this.holdSnapshot) {
      const t = performance.now();
      this.statsState.refreshCount += 1;
      this.statsState.lastRefreshAt = Date.now();
      this.statsState.lastRefreshDurationMs = performance.now() - t;
      return this.statsState.lastRefreshDurationMs;
    }
    if (this.refreshing) return 0;
    this.refreshing = true;
    const t0 = performance.now();
    try {
      this.db.exec("COMMIT");
      try {
        this.db.exec("BEGIN");
      } catch (beginErr) {
        // Try once more: if the first BEGIN threw on a transient
        // error, leaving us txn-less, recover so reads on this
        // handle keep their snapshot semantics.
        try {
          this.db.exec("BEGIN");
        } catch {
          // Swallow; the next query will start an implicit txn.
        }
        throw beginErr;
      }
      anchorSnapshot(this.db);
      const dur = performance.now() - t0;
      this.statsState.refreshCount += 1;
      this.statsState.lastRefreshAt = Date.now();
      this.statsState.lastRefreshDurationMs = dur;
      log.info(`refreshed in ${dur.toFixed(0)}ms`);
      return dur;
    } catch (err) {
      this.statsState.refreshErrors += 1;
      throw err;
    } finally {
      this.refreshing = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.holdSnapshot) {
      try {
        this.db.exec("COMMIT");
      } catch {
        // best-effort — connection may already be busted
      }
    }
    try {
      this.db.close();
    } catch (err) {
      log.warn(`close threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stats(): SearchSnapshotStats {
    return { ...this.statsState };
  }
}

/**
 * Claim the snapshot for a freshly issued `BEGIN`. A deferred transaction
 * takes its WAL read mark on the first statement that reads a database
 * page — a statement with no table reference (`SELECT 1`) reads none and
 * leaves the snapshot floating until the first real query. Reading the
 * schema table touches page 1 and pins it now.
 */
function anchorSnapshot(db: Db): void {
  db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
}

/**
 * Open a read-only snapshot handle on `index.db`.
 *
 * Steps:
 *   1. Open a new read-only connection via `openIndexDb`.
 *   2. `BEGIN` and anchor the snapshot with a trivial read.
 *   3. Start the periodic refresher if `refreshIntervalMs > 0`.
 */
export function openSearchSnapshotHandle(
  path: string,
  opts: OpenSearchSnapshotHandleOptions = {},
): SearchSnapshotHandle {
  const holdSnapshot = opts.holdSnapshot !== false;
  const db = openIndexDb(path, {
    readonly: true,
    mmapBytes: opts.mmapBytes,
    cacheSizeBytes: opts.cacheSizeBytes,
    encryptionKey: opts.encryptionKey ?? null,
  });
  if (holdSnapshot) {
    db.exec("BEGIN");
    anchorSnapshot(db);
  }

  const handle = new SnapshotHandleImpl(db, holdSnapshot);

  if (holdSnapshot && opts.refreshIntervalMs && opts.refreshIntervalMs > 0) {
    handle.startPeriodicRefresh(opts.refreshIntervalMs);
    log.info(`periodic refresh every ${opts.refreshIntervalMs}ms`);
  } else if (!holdSnapshot) {
    log.info(`read handle opened without snapshot isolation (each query takes an implicit txn)`);
  }

  return handle;
}

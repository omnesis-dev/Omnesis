// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { withActivity } from "../../observability/main-activity.js";
import {
  readStatusCacheSnapshot,
  type StatusCacheReads,
  type StatusCacheSnapshot,
} from "./status-cache-reads.js";
import type Database from "better-sqlite3";
import type { AnalyticsDb } from "../../analytics-db.js";

type Db = Database.Database;

const log = createLogger("gateway:http").child("status-cache");

/**
/**
 * A device revoked while it still hosts sources is a dormant machine, not a
 * retired one: its sources stay assigned, delete refuses to remove it, and
 * pairing it again under the same name resumes them. The device list and
 * the doctor report this the same way.
 */
export function deviceNeedsPairing(
  device: { revokedAt: number | null },
  hostsSources: boolean,
): boolean {
  return device.revokedAt !== null && hostsSources;
}

/**
 * Hot-read caches with a background refresh. The CLI and portal poll a handful
 * of read-only admin endpoints at 1-2 Hz each, so the response data is kept in
 * memory and refreshed on a two-second tick. With a read port the tick reads on
 * a read worker; without one it reads on the caller's handle.
 *
 * Mutation routes call `bump()`, which reads synchronously on the main handle
 * so the request that changed something sees the change in its own response
 * and every later read does too. A tick read that was already in flight when a
 * bump landed is discarded rather than applied over the bump's newer data.
 */
export class StatusCache {
  static readonly REFRESH_INTERVAL_MS = 2_000;

  latestActivity: StatusCacheSnapshot["latestActivity"] = {};
  analyticsByType: Record<string, number> = {};
  /**
   * Per-source "what's the most recent sample in DuckDB?" lookup. Keyed by
   * whatever value the analytics catalog stores in `source_id` — that's
   * the full `<type>:<account>` for exclusive ownership, or just the bare
   * `<type>` when sibling sources share the same table set.
   */
  latestAnalyticsActivity: Record<
    string,
    {
      latestActivityAt: string;
      tableName: string;
      tableDisplayName: string;
    }
  > = {};
  listSources: StatusCacheSnapshot["sources"] = [];
  listDevices: StatusCacheSnapshot["devices"] = [];
  /**
   * Devices that still own or are members of a source. A revoked device in
   * this set has durable state a re-pair would restore, which is what the
   * device list reports as `needsPairing`.
   */
  sourceHostingDeviceIds: Set<string> = new Set();
  listSyncStates: StatusCacheSnapshot["syncStates"] = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;
  /** Advances on every synchronous read, so an older tick read can tell it lost. */
  private dbGeneration = 0;

  constructor(
    private readonly db: Db,
    private readonly analyticsDb?: AnalyticsDb,
    private readonly reads?: StatusCacheReads,
  ) {}

  /**
   * Treat `database is locked` / `SQLITE_BUSY` as transient backpressure:
   * skip this refresh tick and keep the previous cache.
   */
  private static isTransientLockError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.message.includes("SQLITE_BUSY") || err.message.includes("database is locked");
  }

  private static isClosedDatabaseError(err: unknown): boolean {
    return err instanceof Error && err.message.includes("database connection is not open");
  }

  /**
   * Refresh the SQLite-backed caches (sources, devices, sync states, latest
   * activity) synchronously on the main handle.
   */
  refreshDb(): void {
    withActivity("statusCache.refreshDb", () => {
      this.dbGeneration++;
      try {
        this.apply(readStatusCacheSnapshot(this.db));
      } catch (err) {
        StatusCache.keepOnTransientLock(err);
      }
    });
  }

  /** The tick's refresh of the same caches, on the read port when there is one. */
  private async refreshDbInBackground(): Promise<void> {
    if (!this.reads) {
      this.refreshDb();
      return;
    }
    const generation = this.dbGeneration;
    let snapshot: StatusCacheSnapshot;
    try {
      snapshot = await this.reads.statusCacheSnapshot();
    } catch (err) {
      StatusCache.keepOnTransientLock(err);
      return;
    }
    if (generation === this.dbGeneration) this.apply(snapshot);
  }

  private apply(snapshot: StatusCacheSnapshot): void {
    this.latestActivity = snapshot.latestActivity;
    this.listSources = snapshot.sources;
    this.listSyncStates = snapshot.syncStates;
    this.listDevices = snapshot.devices;
    this.sourceHostingDeviceIds = new Set(snapshot.sourceHostingDeviceIds);
  }

  /** A transient lock keeps the previous cache until the next refresh; anything else is thrown. */
  private static keepOnTransientLock(err: unknown): void {
    if (!StatusCache.isTransientLockError(err)) throw err;
    log.debug(`refreshDb: transient lock, keeping previous cache (${(err as Error).message})`);
  }

  async refreshAnalytics(): Promise<void> {
    if (!this.analyticsDb) return;
    try {
      const tables = await this.analyticsDb.getCatalogActivity();
      const counts: Record<string, number> = {};
      const latest: Record<
        string,
        {
          latestActivityAt: string;
          latestActivityMs: number;
          tableName: string;
          tableDisplayName: string;
        }
      > = {};
      for (const t of tables) {
        if (!t.sourceId) continue;
        if (t.recordCount) {
          counts[t.sourceId] = (counts[t.sourceId] ?? 0) + t.recordCount;
        }
        const ms = parseAnalyticsTimestampMs(t.latestDate);
        if (ms === null) continue;
        const prev = latest[t.sourceId];
        if (!prev || ms > prev.latestActivityMs) {
          latest[t.sourceId] = {
            latestActivityAt: new Date(ms).toISOString(),
            latestActivityMs: ms,
            tableName: t.tableName,
            tableDisplayName: t.displayName,
          };
        }
      }
      this.analyticsByType = counts;
      const nextLatest: typeof this.latestAnalyticsActivity = {};
      for (const [k, v] of Object.entries(latest)) {
        nextLatest[k] = {
          latestActivityAt: v.latestActivityAt,
          tableName: v.tableName,
          tableDisplayName: v.tableDisplayName,
        };
      }
      this.latestAnalyticsActivity = nextLatest;
    } catch {
      /* ignore — keep previous cache */
    }
  }

  async refreshAll(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const dbStart = Date.now();
      await this.refreshDbInBackground();
      const dbMs = Date.now() - dbStart;
      const analyticsStart = Date.now();
      await this.refreshAnalytics();
      const analyticsMs = Date.now() - analyticsStart;
      if (dbMs > 1_000 || analyticsMs > 1_000) {
        log.info(`status cache refresh: db=${dbMs}ms analyticsCatalog=${analyticsMs}ms`);
      }
    } finally {
      this.inflight = false;
    }
  }

  /**
   * Synchronous invalidation hook called from mutation routes. Reading inline
   * keeps a mutation's effect visible to the next read of the cache, which a
   * worker read could not promise.
   */
  bump(): void {
    this.refreshDb();
  }

  /**
   * Synchronously prime the caches, so the first request after boot has them,
   * and start the background refresh tick.
   */
  start(): void {
    this.refreshDb();
    void this.refreshAnalytics();
    this.timer = setInterval(() => {
      this.refreshAll().catch((err) => {
        // The DB owns this cache's lifetime. Production stops it explicitly
        // during coordinated shutdown, while short-lived in-process servers
        // may simply close their DB. Retire the timer silently in that case so
        // it cannot keep polling or log after its owner has gone away.
        if (StatusCache.isClosedDatabaseError(err)) {
          this.stop();
          return;
        }
        log.warn(`refreshAll failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, StatusCache.REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Parse a DuckDB-style timestamp into epoch ms, or null when unparseable.
 * Catalog rows store `latest_date` in whatever format the underlying column
 * had — TIMESTAMPTZ surfaces as `YYYY-MM-DD HH:MM:SS[.fff]+TZ`, plain
 * TIMESTAMP as `YYYY-MM-DD HH:MM:SS[.fff]` (naive), DATE as `YYYY-MM-DD`.
 *
 * We coerce to ISO 8601 (`T` separator, `+HH:MM` offset) and assume UTC
 * for naive timestamps — DuckDB's TIMESTAMP is timezone-naive but every
 * source we ingest writes UTC into it, and `Date.parse` would otherwise
 * silently reinterpret naive values as the JS host's local time and skew
 * the per-source latest activity by an offset.
 */
export function parseAnalyticsTimestampMs(raw: string | null): number | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  s = s.replace(" ", "T");
  s = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  s = s.replace(/([+-]\d{2})$/, "$1:00");
  if (!/[+-]\d{2}:\d{2}$/.test(s) && !s.endsWith("Z")) {
    s += "Z";
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

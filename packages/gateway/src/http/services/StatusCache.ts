// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { getLatestActivityBySource, listSyncStates } from "../../db.js";
import { listDevices } from "../../data/repositories/DeviceRepository.js";
import {
  listDeviceIdsHostingSources,
  listSources,
} from "../../data/repositories/SourceRepository.js";
import type Database from "better-sqlite3";
import type { AnalyticsDb } from "../../analytics-db.js";

type Db = Database.Database;

const log = createLogger("gateway:http").child("status-cache");

/**
 * Hot-read caches with BACKGROUND refresh.
 * The cli + portal poll a handful of read-only admin endpoints at 1-2Hz each.
 * Even though each underlying SELECT is sub-ms, TRUNCATE journal mode forces
 * every read to acquire a SHARED lock that stalls behind any in-flight
 * writer EXCLUSIVE commit. Solution: keep the entire response payload in
 * RAM, refreshed on a 2s background tick on the read-only handle.
 *
 * Mutation routes call `bumpAdminCaches()` so the next read sees fresh
 * data immediately rather than waiting up to 2s for the next tick.
 */
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

export class StatusCache {
  static readonly REFRESH_INTERVAL_MS = 2_000;

  latestActivity: ReturnType<typeof getLatestActivityBySource> = {};
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
  listSources: ReturnType<typeof listSources> = [];
  listDevices: ReturnType<typeof listDevices> = [];
  /**
   * Devices that still own or are members of a source. A revoked device in
   * this set has durable state a re-pair would restore, which is what the
   * device list reports as `needsPairing`.
   */
  sourceHostingDeviceIds: Set<string> = new Set();
  listSyncStates: ReturnType<typeof listSyncStates> = [];

  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight = false;

  constructor(
    private readonly db: Db,
    private readonly analyticsDb?: AnalyticsDb,
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
   * Refresh just the SQLite-backed caches (sources, devices, sync_states,
   * latest activity). Synchronous — the underlying SELECTs are all sub-ms
   * uncontended.
   */
  refreshDb(): void {
    try {
      this.latestActivity = getLatestActivityBySource(this.db);
      this.listSources = listSources(this.db);
      this.listSyncStates = listSyncStates(this.db);
      this.listDevices = listDevices(this.db);
      this.sourceHostingDeviceIds = new Set(listDeviceIdsHostingSources(this.db));
    } catch (err) {
      if (StatusCache.isTransientLockError(err)) {
        log.debug(`refreshDb: transient lock, keeping previous cache (${(err as Error).message})`);
        return;
      }
      throw err;
    }
  }

  async refreshAnalytics(): Promise<void> {
    if (!this.analyticsDb) return;
    try {
      const tables = await this.analyticsDb.getCatalog();
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
      for (const t of tables ?? []) {
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
      this.refreshDb();
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
   * Synchronous invalidation hook called from mutation routes.
   * The DB SELECTs are sub-ms even contended (writer-worker commits
   * release the lock between commits, and we're picking up whatever
   * the latest committed snapshot is), so doing them inline keeps
   * mutations strictly serializable from the caller's POV.
   */
  bump(): void {
    this.refreshDb();
  }

  /**
   * Synchronously prime caches and start the background refresh tick.
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
type Db = Database.Database;
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLogger,
  toErrorMessage,
  openReadonlySqliteSnapshot,
  normalizeUrl,
  canonicalDomain,
  type SqliteSnapshot,
} from "@omnesis/core";
import { mapTransitionType } from "../filters.js";
import type {
  BrowserInfo,
  BrowserId,
  ChromiumProfile,
  RawVisit,
  RawSearchTerm,
  BrowserHistoryConfig,
} from "../types.js";
import type { BrowserHistoryReader, VisitBatch, SearchTermBatch } from "./types.js";

const log = createLogger("source:browser-history:chromium");

/** Chromium epoch: microseconds since 1601-01-01 */
const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000;

/**
 * Difference between the Chromium epoch (1601-01-01) and the Unix epoch
 * (1970-01-01) in seconds. Used inside SQL: `visit_time/1e6 - this`
 * yields Unix seconds. Module-level so a future epoch fix only changes
 * one place.
 */
const CHROMIUM_TO_UNIX_SECONDS = 11644473600;

/** SQL fragment that converts a Chromium native timestamp column to UTC date. */
function chromiumDateExpr(col: string): string {
  return `date(${col} / 1000000 - ${CHROMIUM_TO_UNIX_SECONDS}, 'unixepoch')`;
}

/** Convert Chromium timestamp (microseconds since 1601-01-01) to milliseconds since Unix epoch */
export function chromiumTimestampToMs(visitTime: number): number {
  return Math.round(visitTime / 1000 - CHROMIUM_EPOCH_OFFSET_MS);
}

/** Convert milliseconds since Unix epoch to Chromium timestamp */
export function msToChromiumTimestamp(ms: number): number {
  return (ms + CHROMIUM_EPOCH_OFFSET_MS) * 1000;
}

/**
 * Discover Chromium profiles from the Local State file.
 * Reuses the same pattern as the Chrome bookmarks provider.
 */
export function discoverProfiles(baseDir: string): ChromiumProfile[] {
  const localStatePath = join(baseDir, "Local State");
  if (!existsSync(localStatePath)) return [];

  try {
    const localState = JSON.parse(readFileSync(localStatePath, "utf-8"));
    const infoCache = localState?.profile?.info_cache;
    if (!infoCache || typeof infoCache !== "object") return [];

    return Object.entries(infoCache)
      .map(([dir, info]: [string, unknown]) => {
        const profileInfo = info as Record<string, string>;
        const email = profileInfo.user_name || undefined;
        return {
          dir,
          name: email || profileInfo.name || dir,
          email,
        };
      })
      .filter((p) => existsSync(join(baseDir, p.dir, "History")));
  } catch (err) {
    log.debug(`Failed to read Local State: ${toErrorMessage(err)}`);
    return [];
  }
}

/** Shape of the row returned by every visits SELECT. */
interface VisitRow {
  url: string;
  title: string;
  hidden: number;
  visit_time: number;
  visit_duration: number;
  transition: number;
  is_synced: number;
}

/**
 * Reads browser history from Chromium-based browsers (Chrome, Arc, Brave, Edge, Vivaldi).
 *
 * Per-cycle snapshot lifetime: each profile's History DB is
 * snapshot-copied once on first read and reused across `readVisits`,
 * `readVisitsForDate`, `readSearchTerms`, and `readDistinctVisitDates`.
 * `close()` removes the snapshots. The previous per-call snapshot pattern
 * copied a multi-MB DB file four times per profile per sync-cycle and
 * exposed each read to a different point-in-time of the same DB.
 */
export class ChromiumHistoryReader implements BrowserHistoryReader {
  private profiles: ChromiumProfile[];
  private browserId: BrowserId;
  private browserName: string;
  private baseDir: string;
  private config?: BrowserHistoryConfig;

  /**
   * Lazy snapshot cache keyed by profile.dir. A profile that fails to open
   * is recorded with `null` so we don't retry within the same reader's
   * lifetime — the single warn line at first attempt is enough.
   */
  private profileDbs = new Map<string, Db | null>();
  private snapshots: SqliteSnapshot[] = [];

  constructor(browserInfo: BrowserInfo, config?: BrowserHistoryConfig) {
    this.browserId = browserInfo.id;
    this.browserName = browserInfo.name;
    this.baseDir = browserInfo.baseDir;
    this.config = config;
    this.profiles = discoverProfiles(browserInfo.baseDir);

    if (config?.excludeProfiles?.length) {
      this.profiles = this.profiles.filter((p) => !config.excludeProfiles!.includes(p.name));
    }

    log.info(
      `Discovered ${this.profiles.length} ${browserInfo.name} profiles: ${this.profiles.map((p) => p.name).join(", ")}`,
    );
  }

  /**
   * Open (and cache) a per-profile snapshot. Returns `null` if the
   * snapshot or the DB open failed — caller should treat that as a
   * profile failure and continue with the next profile.
   *
   * Filesystem copy bypasses the exclusive lock Chromium holds on the
   * History file while the browser is running. `-wal/-shm/-journal`
   * sidecars are copied alongside with change detection. Recovery writes only
   * the private copy; profile queries use a reopened read-only connection.
   */
  private getProfileDb(profile: ChromiumProfile): Db | null {
    if (this.profileDbs.has(profile.dir)) {
      return this.profileDbs.get(profile.dir) ?? null;
    }
    try {
      const sourcePath = join(this.baseDir, profile.dir, "History");
      const snap = openReadonlySqliteSnapshot(
        sourcePath,
        (path, options) => new Database(path, options),
        "omnesis-chrome-history-",
      );
      const db = snap.db;
      this.snapshots.push(snap);
      this.profileDbs.set(profile.dir, db);
      return db;
    } catch (err) {
      log.warn(
        `Failed to open ${this.browserName} snapshot for profile "${profile.name}": ${toErrorMessage(err)}`,
      );
      this.profileDbs.set(profile.dir, null);
      return null;
    }
  }

  /**
   * Run the canonical visits SELECT against a profile DB. Pulled out so
   * `readVisits` and `readVisitsForDate` share the column list and joins
   * in one place — the only varying parts are the WHERE clause, the
   * params, and whether a LIMIT is in play.
   */
  private selectVisits(
    db: Db,
    where: string,
    params: number[],
    orderLimit = "ORDER BY v.visit_time ASC",
  ): VisitRow[] {
    return db
      .prepare<number[], VisitRow>(
        `
      SELECT
        u.url, u.title, u.hidden,
        v.visit_time, v.visit_duration, v.transition,
        CASE
          WHEN vs.source IS NOT NULL THEN 1
          WHEN v.originator_cache_guid IS NOT NULL AND v.originator_cache_guid != '' THEN 1
          ELSE 0
        END AS is_synced
      FROM visits v
      JOIN urls u ON v.url = u.id
      LEFT JOIN visit_source vs ON v.id = vs.id AND vs.source = 0
      WHERE ${where}
      ${orderLimit}
    `,
      )
      .all(...params);
  }

  private rowToVisit(row: VisitRow, profileName: string): RawVisit {
    return {
      url: normalizeUrl(row.url),
      domain: canonicalDomain(row.url),
      title: row.title ?? "",
      timestamp: chromiumTimestampToMs(row.visit_time),
      visitDuration:
        row.visit_duration > 0 ? Math.round(row.visit_duration / 1_000_000) : undefined,
      transitionType: mapTransitionType(row.transition),
      transitionRaw: row.transition,
      isSynced: row.is_synced === 1,
      profile: profileName,
      browser: this.browserId,
      hidden: row.hidden === 1,
    };
  }

  readVisits(after: Record<string, number>, defaultAfter: number, limit: number): VisitBatch {
    const allVisits: RawVisit[] = [];
    let anyHasMore = false;
    const lastByProfile: Record<string, number> = {};
    let profileFailures = 0;

    for (const profile of this.profiles) {
      const profileAfter = after[profile.name] ?? defaultAfter;
      const db = this.getProfileDb(profile);
      if (!db) {
        profileFailures++;
        continue;
      }
      try {
        const rows = this.selectVisits(
          db,
          "v.visit_time > ?",
          [profileAfter, limit],
          "ORDER BY v.visit_time ASC LIMIT ?",
        );
        if (rows.length >= limit) anyHasMore = true;

        let maxVisitTime = profileAfter;
        for (const row of rows) {
          if (row.visit_time > maxVisitTime) maxVisitTime = row.visit_time;
          allVisits.push(this.rowToVisit(row, profile.name));
        }
        if (rows.length > 0) lastByProfile[profile.name] = maxVisitTime;
      } catch (err) {
        log.warn(
          `Failed to read ${this.browserName} history for profile "${profile.name}": ${toErrorMessage(err)}`,
        );
        profileFailures++;
      }
    }

    allVisits.sort((a, b) => a.timestamp - b.timestamp);
    return { visits: allVisits, hasMore: anyHasMore, lastByProfile, profileFailures };
  }

  readVisitsForDate(dateStr: string): RawVisit[] {
    const dayStartMs = new Date(`${dateStr}T00:00:00.000Z`).getTime();
    const dayEndMs = new Date(`${dateStr}T23:59:59.999Z`).getTime();
    const startChromium = msToChromiumTimestamp(dayStartMs);
    const endChromium = msToChromiumTimestamp(dayEndMs);

    const allVisits: RawVisit[] = [];

    for (const profile of this.profiles) {
      const db = this.getProfileDb(profile);
      if (!db) continue;
      try {
        const rows = this.selectVisits(db, "v.visit_time >= ? AND v.visit_time <= ?", [
          startChromium,
          endChromium,
        ]);
        for (const row of rows) {
          allVisits.push(this.rowToVisit(row, profile.name));
        }
      } catch (err) {
        log.warn(
          `Failed to read ${this.browserName} visits for date ${dateStr}: ${toErrorMessage(err)}`,
        );
      }
    }

    allVisits.sort((a, b) => a.timestamp - b.timestamp);
    return allVisits;
  }

  readSearchTerms(
    after: Record<string, number>,
    defaultAfter: number,
    limit: number,
  ): SearchTermBatch {
    const allTerms: RawSearchTerm[] = [];
    let anyHasMore = false;
    const lastByProfile: Record<string, number> = {};
    let profileFailures = 0;

    for (const profile of this.profiles) {
      const profileAfter = after[profile.name] ?? defaultAfter;
      const db = this.getProfileDb(profile);
      if (!db) {
        profileFailures++;
        continue;
      }
      try {
        const rows = db
          .prepare<
            [number, number],
            {
              term: string;
              normalized_term: string;
              url: string;
              visit_time: number;
            }
          >(
            `
          SELECT
            kst.term, kst.normalized_term,
            u.url,
            MAX(v.visit_time) AS visit_time
          FROM keyword_search_terms kst
          JOIN urls u ON kst.url_id = u.id
          JOIN visits v ON v.url = u.id
          WHERE v.visit_time > ?
          GROUP BY kst.term, kst.normalized_term, u.url
          ORDER BY visit_time ASC
          LIMIT ?
        `,
          )
          .all(profileAfter, limit);

        if (rows.length >= limit) anyHasMore = true;

        let maxVisitTime = profileAfter;
        for (const row of rows) {
          if (row.visit_time > maxVisitTime) maxVisitTime = row.visit_time;
          allTerms.push({
            browser: this.browserId,
            profile: profile.name,
            timestamp: chromiumTimestampToMs(row.visit_time),
            term: row.term,
            normalizedTerm: row.normalized_term,
            searchEngineDomain: canonicalDomain(row.url),
          });
        }
        if (rows.length > 0) lastByProfile[profile.name] = maxVisitTime;
      } catch (err) {
        log.warn(
          `Failed to read ${this.browserName} search terms for profile "${profile.name}": ${toErrorMessage(err)}`,
        );
        profileFailures++;
      }
    }

    allTerms.sort((a, b) => a.timestamp - b.timestamp);
    return { terms: allTerms, hasMore: anyHasMore, lastByProfile, profileFailures };
  }

  getWatchPaths(): string[] {
    const paths: string[] = [];
    for (const profile of this.profiles) {
      const dbPath = join(this.baseDir, profile.dir, "History");
      paths.push(dbPath, `${dbPath}-wal`);
    }
    return paths;
  }

  getProfiles(): ChromiumProfile[] {
    return this.profiles;
  }

  hasMultipleProfiles(): boolean {
    return this.profiles.length > 1;
  }

  /**
   * Enumerate every UTC date that has at least one visit across every
   * Chromium profile. `partialFailure` is set when any profile DB couldn't
   * be opened (locked by a running Chromium, permission denied, file
   * missing). Without this guard, a snapshot built from a partial profile
   * read would tell the gateway to delete every day-doc owned by the
   * unread profile.
   */
  readDistinctVisitDates(): { dates: string[]; partialFailure: boolean } {
    if (this.profiles.length === 0) {
      return { dates: [], partialFailure: true };
    }
    const seen = new Set<string>();
    let partialFailure = false;

    for (const profile of this.profiles) {
      const db = this.getProfileDb(profile);
      if (!db) {
        partialFailure = true;
        continue;
      }
      try {
        const rows = db
          .prepare<[], { date: string }>(
            `SELECT DISTINCT ${chromiumDateExpr("visit_time")} AS date
             FROM visits
             WHERE visit_time IS NOT NULL`,
          )
          .all();
        for (const r of rows) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(r.date)) seen.add(r.date);
        }
      } catch (err) {
        log.warn(
          `Failed to enumerate ${this.browserName} visit dates for profile "${profile.name}": ${toErrorMessage(err)}`,
        );
        partialFailure = true;
      }
    }

    return { dates: Array.from(seen), partialFailure };
  }

  close(): void {
    this.profileDbs.clear();
    const snapshots = this.snapshots;
    this.snapshots = [];
    const errors: unknown[] = [];
    for (const snapshot of snapshots) {
      try {
        snapshot.cleanup();
      } catch (error) {
        // A snapshot is a private copy of the operator's browsing history, so
        // one left on disk is reported rather than swallowed. Throwing alone
        // would say only that some cleanup failed, and from a `finally` it can
        // stand in front of whatever the caller was already raising — so each
        // failure is logged with its own reason before that happens.
        log.error(`Failed to remove a ${this.browserName} snapshot: ${toErrorMessage(error)}`);
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close browser snapshots");
  }
}

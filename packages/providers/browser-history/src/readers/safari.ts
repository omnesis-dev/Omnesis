// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
type Db = Database.Database;
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createLogger,
  toErrorMessage,
  normalizeUrl,
  canonicalDomain,
  fullDiskAccessRemediation,
} from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import type { BrowserInfo, RawVisit } from "../types.js";
import type { BrowserHistoryReader, VisitBatch, SearchTermBatch } from "./types.js";

const log = createLogger("source:browser-history:safari");

/** Core Data epoch offset: seconds between 1970-01-01 and 2001-01-01 */
const CORE_DATA_EPOCH_OFFSET = 978307200;

/** Convert Safari/Core Data timestamp (seconds since 2001-01-01) to milliseconds since Unix epoch */
export function safariTimestampToMs(visitTime: number): number {
  return (visitTime + CORE_DATA_EPOCH_OFFSET) * 1000;
}

/** Convert milliseconds since Unix epoch to Safari/Core Data timestamp */
export function msToSafariTimestamp(ms: number): number {
  return ms / 1000 - CORE_DATA_EPOCH_OFFSET;
}

/**
 * Reads browser history from Safari's History.db.
 * Requires Full Disk Access on macOS.
 */
export class SafariHistoryReader implements BrowserHistoryReader {
  private dbPath: string;

  constructor(browserInfo: BrowserInfo) {
    this.dbPath = join(browserInfo.baseDir, "History.db");
  }

  /** Construct with an explicit DB path (for testing) */
  static withPath(dbPath: string): SafariHistoryReader {
    const reader = Object.create(SafariHistoryReader.prototype) as SafariHistoryReader;
    reader.dbPath = dbPath;
    return reader;
  }

  /**
   * Safari has one profile and one database: a permission denial here isn't
   * a profile going dark while its siblings keep syncing, it's the whole
   * configured source. Thrown as a `SyncError` (default `scope: "source"`)
   * so it reaches the collector with the remediation attached, rather than
   * being folded into a per-profile failure count that a caller logs and
   * moves past.
   *
   * The `existsSync` gate runs first because SQLite reports a missing file
   * and a file the OS refuses to open the same way (`unable to open database
   * file`) — without it, a profile that simply has no History.db yet would
   * be misread as one Full Disk Access is blocking.
   */
  private openDb(): Db {
    if (!existsSync(this.dbPath)) {
      throw new Error(`Safari history database not found at ${this.dbPath}`);
    }
    try {
      // Safari uses WAL mode — readonly access works without copying
      return new Database(this.dbPath, { readonly: true });
    } catch (err) {
      const msg = toErrorMessage(err);
      if (
        msg.includes("authorization denied") ||
        msg.includes("unable to open") ||
        msg.includes("permission denied")
      ) {
        throw new SyncError(
          "permission",
          "Cannot open the Safari history database — Full Disk Access required.",
          { remediation: fullDiskAccessRemediation(process.execPath), cause: err },
        );
      }
      throw err;
    }
  }

  readVisits(after: Record<string, number>, defaultAfter: number, limit: number): VisitBatch {
    // Safari has a single profile slot ("default"); fall back to the
    // generic default-after when no per-profile watermark is set.
    const afterNativeTimestamp = after.default ?? defaultAfter;
    let db: Db | undefined;
    try {
      db = this.openDb();
      const rows = db
        .prepare<
          [number, number],
          {
            url: string;
            title: string | null;
            visit_time: number;
            origin: number;
          }
        >(
          `
        SELECT
          hi.url,
          hv.title,
          hv.visit_time,
          hv.origin
        FROM history_visits hv
        JOIN history_items hi ON hv.history_item = hi.id
        WHERE hv.visit_time > ?
        ORDER BY hv.visit_time ASC
        LIMIT ?
      `,
        )
        .all(afterNativeTimestamp, limit);

      let maxVisitTime = afterNativeTimestamp;
      const visits: RawVisit[] = rows.map((row) => {
        if (row.visit_time > maxVisitTime) maxVisitTime = row.visit_time;
        return {
          url: normalizeUrl(row.url),
          domain: canonicalDomain(row.url),
          title: row.title ?? "",
          timestamp: safariTimestampToMs(row.visit_time),
          isSynced: row.origin > 0,
          profile: "default",
          browser: "safari" as const,
        };
      });

      return {
        visits,
        hasMore: rows.length >= limit,
        lastByProfile: rows.length > 0 ? { default: maxVisitTime } : {},
        profileFailures: 0,
      };
    } catch (err) {
      if (err instanceof SyncError) throw err;
      log.warn(`Failed to read Safari history: ${toErrorMessage(err)}`);
      return { visits: [], hasMore: false, lastByProfile: {}, profileFailures: 1 };
    } finally {
      db?.close();
    }
  }

  readVisitsForDate(dateStr: string): RawVisit[] {
    const dayStartMs = new Date(`${dateStr}T00:00:00.000Z`).getTime();
    const dayEndMs = new Date(`${dateStr}T23:59:59.999Z`).getTime();
    const startSafari = msToSafariTimestamp(dayStartMs);
    const endSafari = msToSafariTimestamp(dayEndMs);

    let db: Db | undefined;
    try {
      db = this.openDb();
      const rows = db
        .prepare<
          [number, number],
          {
            url: string;
            title: string | null;
            visit_time: number;
            origin: number;
          }
        >(
          `
        SELECT
          hi.url,
          hv.title,
          hv.visit_time,
          hv.origin
        FROM history_visits hv
        JOIN history_items hi ON hv.history_item = hi.id
        WHERE hv.visit_time >= ? AND hv.visit_time <= ?
        ORDER BY hv.visit_time ASC
      `,
        )
        .all(startSafari, endSafari);

      return rows.map((row) => ({
        url: normalizeUrl(row.url),
        domain: canonicalDomain(row.url),
        title: row.title ?? "",
        timestamp: safariTimestampToMs(row.visit_time),
        isSynced: row.origin > 0,
        profile: "default",
        browser: "safari" as const,
      }));
    } catch (err) {
      if (err instanceof SyncError) throw err;
      log.warn(`Failed to read Safari visits for date ${dateStr}: ${toErrorMessage(err)}`);
      return [];
    } finally {
      db?.close();
    }
  }

  /** Safari has no search terms table — always returns empty. */
  readSearchTerms(
    _after: Record<string, number>,
    _defaultAfter: number,
    _limit: number,
  ): SearchTermBatch {
    return { terms: [], hasMore: false, lastByProfile: {}, profileFailures: 0 };
  }

  /**
   * Enumerate every UTC date with at least one history visit. Safari is
   * single-profile so a single SELECT DISTINCT against the history DB
   * suffices; convert from Core Data seconds to ISO date in SQL.
   *
   * Returns `partialFailure: true` when the DB can't be opened — the
   * caller (the source) refuses to emit a snapshot in that case so we
   * don't tell the gateway to delete docs that exist in a now-locked DB.
   */
  readDistinctVisitDates(): { dates: string[]; partialFailure: boolean } {
    let db: Db | undefined;
    try {
      db = this.openDb();
      // Convert Core Data seconds → unix seconds → ISO date.
      // CORE_DATA_EPOCH_OFFSET is the constant from this file.
      const rows = db
        .prepare<[], { date: string }>(
          `SELECT DISTINCT date(hv.visit_time + ${CORE_DATA_EPOCH_OFFSET}, 'unixepoch') AS date
           FROM history_visits hv
           WHERE hv.visit_time IS NOT NULL`,
        )
        .all();
      return {
        dates: rows.map((r) => r.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
        partialFailure: false,
      };
    } catch (err) {
      if (err instanceof SyncError) throw err;
      log.warn(`Failed to enumerate Safari visit dates: ${toErrorMessage(err)}`);
      return { dates: [], partialFailure: true };
    } finally {
      db?.close();
    }
  }

  getWatchPaths(): string[] {
    return [this.dbPath, `${this.dbPath}-wal`];
  }

  close(): void {
    // Readers are opened and closed per-call, nothing to clean up
  }
}

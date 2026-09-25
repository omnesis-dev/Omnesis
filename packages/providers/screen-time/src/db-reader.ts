// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
type Db = Database.Database;
import {
  createLogger,
  toErrorMessage,
  openReadonlySqliteSnapshot,
  fullDiskAccessRemediation,
  SqliteSnapshotChangedError,
  type SqliteSnapshot,
} from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { CORE_DATA_EPOCH } from "./types.js";
import type { UsageSession } from "./types.js";

const log = createLogger("source:screen-time:db");

/** Whether a filesystem error is the OS refusing the read. */
function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Sanity bound for a single foreground session — anything longer is treated
 * as corrupt CoreData (sleep / clock-skew artefact) and dropped from the
 * stream. 24h is the natural cap because sessions that span a calendar
 * boundary are split server-side anyway.
 */
const SESSION_DURATION_CAP_SECONDS = 24 * 60 * 60;

/**
 * Columns the source depends on. The probe at construction-time runs
 * `PRAGMA table_info(ZOBJECT)` and warns if any are missing. Without this
 * check a future macOS that renames `ZSTREAMNAME` or `ZVALUESTRING` would
 * silently emit zero sessions on every cycle.
 */
const REQUIRED_ZOBJECT_COLUMNS = [
  "ZSTREAMNAME",
  "ZVALUESTRING",
  "ZSTARTDATE",
  "ZENDDATE",
  "ZCREATIONDATE",
] as const;

export interface FetchResult {
  sessions: UsageSession[];
  /**
   * Sessions that were dropped during this fetch because their duration
   * was negative or larger than the 24h sanity cap. A
   * non-zero count is logged once per call by the source.
   */
  invalidDurationCount: number;
}

/**
 * Reads app usage sessions from the Knowledge Store (knowledgeC.db).
 *
 * The Knowledge service holds an exclusive lock on knowledgeC.db; opening
 * it directly read-only fails with `database is locked` on machines where
 * Screen Time is active. The reader snapshot-copies the DB on
 * construction, reuses that snapshot for every fetch, and
 * removes it in `close()`.
 */
export class KnowledgeDbReader {
  private db: Db;
  private snapshot: SqliteSnapshot;
  /** Cached count — total app/usage rows. Populated lazily on first call. */
  private cachedCount: number | null = null;
  /** True if the schema probe succeeded; false if columns are missing. */
  readonly schemaOk: boolean;

  constructor(dbPath: string) {
    try {
      const snapshot = openReadonlySqliteSnapshot(
        dbPath,
        (path, options) => new Database(path, options),
        "omnesis-screen-time-",
      );
      this.snapshot = snapshot;
      this.db = snapshot.db;
    } catch (err) {
      if (err instanceof SqliteSnapshotChangedError) {
        // The Knowledge service writes this database continuously, so a copy
        // can lose the race with it. Nothing is wrong with the store and
        // nothing an operator does would help: the next cycle is likely to
        // win, and the source has to stay retryable rather than report itself
        // broken for as long as its database is busy.
        throw new SyncError("transient", `Knowledge Store (${dbPath}) is mid-write.`, {
          cause: err,
        });
      }
      if (isPermissionError(err)) {
        // The default source scope is the honest one. Full Disk Access is a
        // per-executable grant that other providers reading protected
        // databases depend on too, but they sit on their own connections:
        // Screen Time is the only source on this one, so a wider scope would
        // name siblings that do not exist rather than reach the sources that
        // are in fact refused the same way.
        throw new SyncError(
          "permission",
          `Cannot read the Knowledge Store (${dbPath}) — Full Disk Access required.`,
          { remediation: fullDiskAccessRemediation(process.execPath) },
        );
      }
      throw err;
    }
    this.schemaOk = this.probeSchema();
  }

  private probeSchema(): boolean {
    try {
      const rows = this.db.prepare<[], { name: string }>("PRAGMA table_info(ZOBJECT)").all();
      const present = new Set(rows.map((r) => r.name));
      const missing = REQUIRED_ZOBJECT_COLUMNS.filter((c) => !present.has(c));
      if (missing.length > 0) {
        log.warn(
          `Screen Time: knowledgeC.db schema unrecognised — missing columns ${missing.join(", ")}. ` +
            `Source will emit zero sessions until the schema is updated.`,
        );
        return false;
      }
      return true;
    } catch (err) {
      log.warn(`Screen Time: PRAGMA table_info(ZOBJECT) failed — ${toErrorMessage(err)}`);
      return false;
    }
  }

  /**
   * Fetch app usage sessions after the given `(creationDate, pk)` cursor
   * position. Returns sessions ordered by `(ZCREATIONDATE, Z_PK)` ASC for
   * cursor-based pagination.
   *
   * The composite `(creationDate, pk)` cursor is required because
   * ZCREATIONDATE is not unique: a strict `ZCREATIONDATE > ?` on its own would
   * permanently skip rows sharing the boundary timestamp whenever a LIMIT
   * batch ends mid-tie. Z_PK is the per-row primary key, so the pair is
   * strictly increasing and never drops a row.
   *
   * Filters at the SQL level: rejects negative durations and durations
   * longer than 24h, and counts the rejections so the
   * caller can surface a one-line warn when the count is non-zero.
   */
  fetchSessions(afterCreationDate: number, afterPk: number, limit: number): FetchResult {
    if (!this.schemaOk) return { sessions: [], invalidDurationCount: 0 };

    const allRows = this.db
      .prepare(
        `SELECT
          Z_PK AS pk,
          ZVALUESTRING AS bundleId,
          ZSTARTDATE AS startDate,
          ZENDDATE AS endDate,
          ZCREATIONDATE AS creationDate,
          CAST(ZENDDATE - ZSTARTDATE AS INTEGER) AS durationSeconds
        FROM ZOBJECT
        WHERE ZSTREAMNAME = '/app/usage'
          AND ZVALUESTRING IS NOT NULL
          AND ZSTARTDATE IS NOT NULL
          AND ZENDDATE IS NOT NULL
          AND (ZCREATIONDATE > ? OR (ZCREATIONDATE = ? AND Z_PK > ?))
        ORDER BY ZCREATIONDATE ASC, Z_PK ASC
        LIMIT ?`,
      )
      .all(afterCreationDate, afterCreationDate, afterPk, limit) as UsageSession[];

    return this.filterDurations(allRows);
  }

  /**
   * Fetch every app usage session whose UTC start date is `dateStr`
   * (YYYY-MM-DD), regardless of when it was created. Used by the daily
   * rollup to re-aggregate a whole day from the DB rather than from the
   * sessions read this cycle — otherwise an incremental cycle would
   * overwrite the day's row with a partial total. The duration sanity
   * bound is applied identically to `fetchSessions` so the day-row
   * matches the per-session table.
   */
  fetchSessionsForDate(dateStr: string): UsageSession[] {
    if (!this.schemaOk) return [];

    // UTC-midnight bounds of the requested calendar day, expressed in
    // Core Data seconds. `date` in records is derived from ZSTARTDATE via
    // the UTC-anchored coreDataToDate, so we bound on ZSTARTDATE here.
    const dayStartUnix = Date.parse(`${dateStr}T00:00:00.000Z`) / 1000;
    const dayStartCoreData = dayStartUnix - CORE_DATA_EPOCH;
    const dayEndCoreData = dayStartCoreData + 24 * 60 * 60;

    const allRows = this.db
      .prepare(
        `SELECT
          ZVALUESTRING AS bundleId,
          ZSTARTDATE AS startDate,
          ZENDDATE AS endDate,
          ZCREATIONDATE AS creationDate,
          CAST(ZENDDATE - ZSTARTDATE AS INTEGER) AS durationSeconds
        FROM ZOBJECT
        WHERE ZSTREAMNAME = '/app/usage'
          AND ZVALUESTRING IS NOT NULL
          AND ZSTARTDATE IS NOT NULL
          AND ZENDDATE IS NOT NULL
          AND ZSTARTDATE >= ?
          AND ZSTARTDATE < ?
        ORDER BY ZSTARTDATE ASC`,
      )
      .all(dayStartCoreData, dayEndCoreData) as UsageSession[];

    return this.filterDurations(allRows).sessions;
  }

  /**
   * Drop rows with a negative or >24h duration (corrupt CoreData) and
   * report how many were dropped, so callers can surface a one-line warn.
   */
  private filterDurations(rows: UsageSession[]): FetchResult {
    const sessions: UsageSession[] = [];
    let invalidDurationCount = 0;
    for (const row of rows) {
      if (row.durationSeconds < 0 || row.durationSeconds >= SESSION_DURATION_CAP_SECONDS) {
        invalidDurationCount++;
        continue;
      }
      sessions.push(row);
    }
    return { sessions, invalidDurationCount };
  }

  /**
   * Total /app/usage row count. Cached after the first call — the
   * percent-display denominator is allowed to be stale within a sync
   * cycle (sessions arriving mid-cycle don't change the user-facing
   * progress meaningfully) and re-running COUNT(*) per BATCH_SIZE batch
   * is a full-table scan amortised across thousands of small pages.
   */
  countSessions(): number {
    if (this.cachedCount !== null) return this.cachedCount;
    if (!this.schemaOk) {
      this.cachedCount = 0;
      return 0;
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM ZOBJECT
         WHERE ZSTREAMNAME = '/app/usage'
           AND ZVALUESTRING IS NOT NULL`,
      )
      .get() as { count: number };
    this.cachedCount = row.count;
    return row.count;
  }

  close(): void {
    this.snapshot.cleanup();
  }
}

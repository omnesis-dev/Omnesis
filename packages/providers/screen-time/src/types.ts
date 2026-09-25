// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Core Data epoch: 2001-01-01T00:00:00Z in Unix seconds.
 */
export const CORE_DATA_EPOCH = 978307200;

/**
 * Convert a Core Data timestamp (seconds since 2001-01-01) to ISO string.
 */
export function coreDataToISO(ts: number): string {
  return new Date((ts + CORE_DATA_EPOCH) * 1000).toISOString();
}

/**
 * Convert a Core Data timestamp to a YYYY-MM-DD date string.
 */
export function coreDataToDate(ts: number): string {
  return coreDataToISO(ts).slice(0, 10);
}

/**
 * UTC weekday for a Core Data timestamp (0=Sunday, 6=Saturday). Matches
 * the UTC-anchored `coreDataToDate`/`coreDataToISO` pair so the daily
 * (`date`, `day_of_week`) tuple is internally consistent. The previous
 * implementation read `getDay()` (local timezone) while `date` came from
 * `toISOString()` (UTC), producing a mismatched pair for late-night
 * sessions whenever the local TZ offset crossed a date boundary.
 */
export function coreDataToUtcWeekday(ts: number): number {
  return new Date((ts + CORE_DATA_EPOCH) * 1000).getUTCDay();
}

/**
 * A raw app usage session from knowledgeC.db.
 */
export interface UsageSession {
  /** ZOBJECT.Z_PK — unique row id, used as the pagination tiebreaker. */
  pk: number;
  bundleId: string;
  startDate: number; // Core Data timestamp
  endDate: number; // Core Data timestamp
  creationDate: number; // Core Data timestamp
  durationSeconds: number;
}

/**
 * Sync cursor for Screen Time source.
 */
export interface ScreenTimeSyncCursor extends Record<string, unknown> {
  phase: "sessions" | "daily" | "done";
  lastCreationDate: number; // Core Data timestamp
  /**
   * Z_PK of the last emitted session. Tiebreaker for the `(creationDate, pk)`
   * composite cursor: ZCREATIONDATE is not unique, so paging on it alone with a
   * strict `>` would skip rows sharing the boundary timestamp when a batch ends
   * mid-tie. Defaults to 0 (no row processed yet).
   */
  lastPk: number;
  sessionsProcessed: number;
  /** Dates that had new sessions in this sync (for targeted daily re-aggregation) */
  affectedDates: string[];
  /**
   * Set when the sessions phase found a store layout it does not recognise.
   *
   * Carried because the daily phase closes the cycle and cannot tell, from
   * "no dates were affected" alone, whether nothing happened or nothing could
   * be read — and those deserve opposite things said about them.
   */
  schemaUnreadable?: boolean;
}

/**
 * Extract a human-readable app name from a bundle ID.
 * "com.google.Chrome" → "Chrome"
 * "com.apple.Safari" → "Safari"
 * "com.googlecode.iterm2" → "iterm2"
 */
export function appNameFromBundleId(bundleId: string): string {
  const parts = bundleId.split(".");
  return parts[parts.length - 1] ?? bundleId;
}

/**
 * Default path to the Knowledge Store database.
 */
export const KNOWLEDGE_DB_PATH = `${process.env.HOME ?? "~"}/Library/Application Support/Knowledge/knowledgeC.db`;

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { RawVisit, RawSearchTerm } from "../types.js";

export interface VisitBatch {
  visits: RawVisit[];
  /** Whether there may be more visits after this batch */
  hasMore: boolean;
  /**
   * Per-profile max-visit-timestamp (native format) seen this batch. Lets
   * the caller track each profile's watermark independently — without this
   * a transient lock on profile A poisons the watermark for profile B,
   * since the next sync would filter B's older visits using A's high-water
   * mark. Single-profile readers (Safari) always emit one entry keyed by
   * a stable identifier.
   */
  lastByProfile: Record<string, number>;
  /**
   * Number of profile DBs that couldn't be opened or queried this batch
   * (locked, permission denied, missing file). Surfaced so the caller can
   * log a non-zero count distinct from a benign "no new visits" outcome.
   */
  profileFailures: number;
}

export interface SearchTermBatch {
  terms: RawSearchTerm[];
  hasMore: boolean;
  /**
   * Per-profile max-visit-timestamp seen this batch — same shape and
   * rationale as `VisitBatch.lastByProfile`. Without per-profile
   * watermarks the search-terms phase would re-read every profile's
   * search history on every sync.
   */
  lastByProfile: Record<string, number>;
  profileFailures: number;
}

/**
 * Interface for reading browser history from a local SQLite database.
 * Each implementation handles one browser engine (Chromium, Safari).
 * TODO: Add Firefox reader when Firefox support is implemented (#158).
 */
export interface BrowserHistoryReader {
  /**
   * Read a batch of visits with native timestamps greater than the
   * per-profile watermarks in `after`. Single-profile readers ignore keys
   * beyond their own. Profile-key not present → falls back to the
   * caller's `defaultAfter`, used for first-sync bootstrap and migration
   * from the old single-watermark cursor shape.
   */
  readVisits(after: Record<string, number>, defaultAfter: number, limit: number): VisitBatch;

  /** Read all visits within a date range (for building daily documents). */
  readVisitsForDate(dateStr: string): RawVisit[];

  /**
   * Read search terms with `MAX(v.visit_time) > after[profile.dir]` per
   * profile, falling back to `defaultAfter` for profiles with no entry.
   * The per-profile shape mirrors `readVisits` and fixes the legacy
   * single-key cursor that re-read every profile's search-terms on every
   * sync.
   */
  readSearchTerms(
    after: Record<string, number>,
    defaultAfter: number,
    limit: number,
  ): SearchTermBatch;

  /**
   * Enumerate every UTC date that has at least one visit in the source —
   * across every reachable profile DB. The returned `dates` are
   * `YYYY-MM-DD` strings; pair them with the browser slug to form the
   * day-doc external IDs (`<browser>:<date>`).
   *
   * `partialFailure` is true if ANY profile DB couldn't be read (locked,
   * permission denied, missing file). Callers MUST refuse to emit a
   * snapshot for source-removal purposes when partial — emitting an
   * incomplete enumeration would tell the gateway to delete every day-
   * doc belonging to the failed profile.
   */
  readDistinctVisitDates(): { dates: string[]; partialFailure: boolean };

  /** Get file paths to watch for changes. */
  getWatchPaths(): string[];

  /** Close all database connections. */
  close(): void;
}

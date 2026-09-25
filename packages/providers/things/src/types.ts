// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Sync cursor for Things source.
 * Uses userModificationDate as watermark for incremental sync.
 */
export interface ThingsSyncCursor extends Record<string, unknown> {
  lastModifiedTimestamp: number;
  /**
   * Queue size pinned at the start of the current sync cycle. Used so the
   * progress bar's `total` stays stable across pages within a cycle (counted
   * once on the first page, carried through subsequent pages, cleared when
   * the cycle ends with `hasMore: false`).
   */
  cycleQueueTotal?: number;
}

/**
 * Raw task/project row from Things main.sqlite.
 */
export interface RawThingsTask {
  uuid: string;
  title: string | null;
  notes: string | null;
  type: number; // 0 = task, 1 = project, 2 = heading
  status: number; // 0 = open, 3 = completed
  trashed: number;
  creationDate: number; // Unix timestamp (seconds)
  userModificationDate: number; // Unix timestamp (seconds)
  /**
   * Wall-clock calendar date with NO timezone, bit-packed as
   * `year << 16 | month << 12 | day << 7`. Things stores the date the
   * user typed, not a timestamp; consumers MUST treat the decoded
   * `YYYY-MM-DD` as a calendar-date string and NEVER parse it through
   * `new Date(...)`. Doing so applies the local timezone offset and
   * silently shifts the date by ±1 day across DST boundaries / travel.
   */
  startDate: number | null;
  /** Same wall-clock encoding as `startDate`. See its doc-comment. */
  deadline: number | null;
  stopDate: number | null; // Unix timestamp (seconds)
  start: number; // 0 = inbox, 1 = anytime/someday, 2 = scheduled
  project: string | null; // FK → TMTask.uuid (parent project)
  area: string | null; // FK → TMArea.uuid
  heading: string | null; // FK → TMTask.uuid (parent heading)
}

/**
 * Raw checklist item from Things main.sqlite.
 */
export interface RawThingsChecklistItem {
  uuid: string;
  title: string;
  status: number; // 0 = open, 3 = completed
  task: string; // FK → TMTask.uuid
  index: number;
}

/**
 * Raw area from Things main.sqlite.
 */
export interface RawThingsArea {
  uuid: string;
  title: string;
}

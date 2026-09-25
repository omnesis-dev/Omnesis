// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isSnapshotLedger, makeCursorValidator } from "@omnesis/source-sdk";
import type { SnapshotLedger, SyncCursor } from "@omnesis/source-sdk";
import type { NotionClient } from "./client.js";

// ── Provider Context ────────────────────────────────────────────────

/** Map from Notion user ID to display name + email. */
export type UserMap = Map<string, { name: string; email?: string }>;

export interface NotionContext {
  client: NotionClient;
  accountId: string;
  dataCutoff?: string;
  userMap: UserMap;
  /** Config dir the workspace's tokens live under — undefined means the default. */
  configDir?: string;
}

// ── Stored Tokens ───────────────────────────────────────────────────

export interface NotionTokens {
  access_token: string;
  refresh_token?: string;
  workspace_id: string;
  workspace_name: string;
  bot_id: string;
}

export interface NotionCredentials {
  client_id: string;
  client_secret: string;
}

// ── Pages Source Cursor ─────────────────────────────────────────────

export interface NotionPagesCursor extends SyncCursor {
  /** ISO 8601 timestamp of the most recently seen page edit */
  lastEditedTime?: string;
  /** Notion pagination cursor for search */
  startCursor?: string;
  /** Continuation tokens in the current search, to reject loops across restarts. */
  pageCursors?: string[];
  /**
   * ISO 8601 timestamp of the last completed snapshot (full re-walk of the
   * search list). Drives the snapshot-reconciliation cadence: when the
   * elapsed time since `lastSnapshotAt` crosses `SNAPSHOT_INTERVAL_MS`,
   * the next sync enters snapshot mode (ignores incremental cutoff,
   * accumulates page IDs, emits `presentExternalIds` on completion).
   */
  lastSnapshotAt?: string;
  /**
   * When set, the current sync run is in snapshot mode — accumulate every
   * page ID we visit into `snapshotIds` and ignore the incremental edit
   * cutoff. Cleared when the snapshot completes.
   */
  snapshotMode?: boolean;
  /**
   * Page IDs accumulated across the pages of an in-progress snapshot run.
   * Persisted in the cursor so a multi-page snapshot can resume across
   * sync() calls. Cleared on completion.
   */
  snapshotIds?: string[];
  /**
   * Set when some page of the in-progress rewalk could not be enumerated —
   * Notion returned a partial object where a full page was expected, so the
   * walk knows a page exists but not its identity. The snapshot is withheld
   * on completion rather than naming the pages that did come back: the
   * gateway deletes whatever a snapshot omits, and a page whose object arrived
   * partial has not gone anywhere. Cleared when the next rewalk starts.
   */
  snapshotDirty?: boolean;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((entry) => typeof entry === "string");
}

export function isNotionPagesCursor(v: unknown): v is NotionPagesCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (c.lastEditedTime !== undefined && typeof c.lastEditedTime !== "string") return false;
  if (c.startCursor !== undefined && typeof c.startCursor !== "string") return false;
  if (
    c.pageCursors !== undefined &&
    (!isStringArray(c.pageCursors) ||
      c.pageCursors.length > 10_000 ||
      c.pageCursors.some((token) => !token.trim() || token.length > 1024))
  )
    return false;
  if (c.lastSnapshotAt !== undefined && typeof c.lastSnapshotAt !== "string") return false;
  if (c.snapshotMode !== undefined && typeof c.snapshotMode !== "boolean") return false;
  if (c.snapshotIds !== undefined && !isStringArray(c.snapshotIds)) return false;
  if (c.snapshotDirty !== undefined && typeof c.snapshotDirty !== "boolean") return false;
  return true;
}

// ── Databases Source Cursor ─────────────────────────────────────────

export interface DatabaseMeta {
  /** Stable Notion database id. Kept as the cursor key for back-compat. */
  id: string;
  /** Notion API v5 data-source id used for schema retrieval and row queries. */
  dataSourceId?: string;
  title: string;
  lastEditedTime: string;
}

/** Backoff state for a database that returned 404/403 transiently. */
export interface SkippedDatabase {
  /** Consecutive failures — drives exponential backoff (1h → 6h → 24h). */
  failures: number;
  /** ISO 8601 — earliest time we should retry this database. */
  retryAfter: string;
  /** Last error code/message, kept for debugging. */
  lastError: string;
}

export interface NotionDatabasesCursor extends SyncCursor {
  phase: "discover" | "sync-db" | "done";
  /** Discovered databases to sync */
  databases: DatabaseMeta[];
  /** Index into databases array for current sync */
  currentDbIndex: number;
  /** Notion pagination cursor within current database query */
  dbPageCursor?: string;
  /** Whether we've emitted the summary doc for the current database */
  emittedSummary?: boolean;
  /** ISO 8601 timestamp of last successful sync */
  lastSyncTime?: string;
  /** Notion pagination cursor for database discovery search */
  discoveryCursor?: string;
  /** ISO 8601 — when the last full discovery completed. Drives the
   *  re-discovery TTL: while younger than `DISCOVERY_TTL_MS`, sync skips the
   *  search API and reuses the cached `databases` list. */
  discoveredAt?: string;
  /** Map of databaseId → backoff state. Populated when a DB returns 404/403
   *  on retrieve/query; the entry causes the source to skip that DB until
   *  `retryAfter` passes. */
  skippedDbs?: Record<string, SkippedDatabase>;
  /** Map of databaseId → contentHash of the last summary doc emitted. Used
   *  to skip re-emitting unchanged summary docs every cycle. */
  summaryHashes?: Record<string, string>;

  // ── Snapshot reconciliation (deletion detection) ──────────────────
  /**
   * ISO 8601 timestamp of the last completed snapshot rewalk. Drives
   * the cadence: when older than `SNAPSHOT_INTERVAL_MS`, the next
   * sync-db cycle runs in snapshot mode (lastSyncTime ignored, every
   * row across every reachable DB is enumerated). On completion,
   * `presentExternalIds` is emitted to the gateway for set-difference
   * deletion of doc rows whose Notion source vanished — or, when a database
   * could not be read, one claim per database that was.
   */
  lastSnapshotAt?: string;
  /**
   * When true, the current sync-db cycle is a snapshot rewalk: lastSyncTime is
   * suppressed and every page's row + summary external IDs go into `snapshot`,
   * under the database they came from. Cleared when the rewalk reaches `done`.
   */
  inSnapshotMode?: boolean;
  /**
   * The in-progress rewalk's enumeration, one partition per database.
   *
   * Which database an id came from is the difference between "one database
   * would not open, so no deletion is detected anywhere" and "one database
   * would not open, so no deletion is detected in it". A database that reached
   * the end of its own row pages is covered and becomes a claim; one skipped,
   * cooling down or returned as a partial object is left uncovered and is not
   * vouched for. A database Notion acknowledged during discovery but would not
   * describe never enters `databases` at all, so it is recorded as the
   * ledger's blind spot — the one hole no partition can express.
   *
   * Cleared when the rewalk closes.
   */
  snapshot?: SnapshotLedger;
  /**
   * Set when a discovery page contained a database Notion acknowledged but
   * would not describe. Such a database never enters `databases`, so a rewalk
   * cannot enumerate it and cannot even know it is missing — its rows would be
   * absent from the snapshot and swept.
   *
   * Tracked on its own rather than on the rewalk's enumeration because
   * discovery runs *before* the cycle knows whether it is a rewalk: the flag
   * has to survive every discovery page and be handed to the rewalk at the
   * moment it starts, as that enumeration's blind spot, rather than being
   * tested against a snapshot mode that is not decided yet.
   */
  discoveryIncomplete?: boolean;
  /** Inventory retained while a paginated discovery replaces `databases`. */
  previousDatabaseIds?: string[];
  /**
   * Databases absent from a complete discovery. Keep naming their empty
   * partitions until they reappear, so gateway absence deadlines can mature
   * even when an unrelated database remains unreadable.
   */
  missingDatabaseIds?: string[];

  // ── Analytics-row deletion detection (#156) ───────────────────────
  /**
   * Map of analytics `tableName` → the row primary-key values (`id` =
   * page UUID with dashes stripped) enumerated so far during the
   * IN-PROGRESS snapshot rewalk. Accumulated across the pages of one
   * database (and one entry per `notion_<dbId>` table). When a
   * database's rewalk completes cleanly, its set is diffed against
   * `lastSnapshotRowIdsByTable` to derive the DuckDB rows whose Notion
   * source vanished, then rolled into `lastSnapshotRowIdsByTable` and
   * dropped from here. Only the present set is kept (the issue's
   * documented cursor-size trade-off — acceptable for personal
   * workspaces).
   */
  snapshotRowIdsByTable?: Record<string, string[]>;
  /**
   * Map of analytics `tableName` → the row primary-key set present at
   * the END of the LAST cleanly-completed rewalk for that table. The
   * NEXT rewalk diffs its freshly-enumerated set against this to find
   * deleted rows (`deletedIds = last − current`). Updated per table
   * only when that table's enumeration completed without a skip — a
   * partial enumeration leaves the prior set untouched so deletions
   * are deferred, never falsely emitted.
   */
  lastSnapshotRowIdsByTable?: Record<string, string[]>;
}

export function isNotionDatabasesCursor(v: unknown): v is NotionDatabasesCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (c.phase !== "discover" && c.phase !== "sync-db" && c.phase !== "done") {
    return false;
  }
  // `databases` and `currentDbIndex` are non-optional fields the source
  // dereferences without guards. Reject if missing/wrong-type so we fall
  // back to the cursor=null branch (re-discovery).
  if (!Array.isArray(c.databases)) return false;
  if (typeof c.currentDbIndex !== "number") return false;
  // The rewalk's enumeration is resumed by iterating its stored id arrays, so a
  // malformed ledger throws part-way through a page instead of being refused —
  // and a value that decodes and then throws leaves the source retrying the
  // same cursor forever, where `onUnreadable` cannot reach it.
  if (c.snapshot !== undefined && !isSnapshotLedger(c.snapshot)) return false;
  if (c.previousDatabaseIds !== undefined && !isStringArray(c.previousDatabaseIds)) return false;
  if (c.missingDatabaseIds !== undefined && !isStringArray(c.missingDatabaseIds)) return false;
  return true;
}

export const validateNotionDatabasesCursor = makeCursorValidator(isNotionDatabasesCursor);

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SQLite storage for the omnesis-notes ledger: `note_entries`, the
 * append-only record of every quick-capture note the user addressed to
 * the assistant. One row per capture; `day` is the gateway-local
 * calendar day of `captured_at` and keys the per-day corpus document
 * (`upsert.ts` projects one document per day, `externalId = day`).
 *
 * Pure SQL functions over a better-sqlite3 handle — no scheduling, no
 * side-effects beyond the statements themselves. Callers route writes
 * through the WriteGate (`notes.*` writer ops); reads run on the
 * gateway's read handle.
 */

import { recordMcpToolInvocationAudit } from "../../access/store-audit.js";
import type Database from "better-sqlite3";
import type { DeviceId, TokenId, NoteCaptureContext } from "@omnesis/types";
import type { McpToolInvocationAuditInput } from "../../access/types.js";

type Db = Database.Database;

/** Authority checked atomically with a queued browser capture. */
export interface BrowserNoteAuthority {
  deviceId: DeviceId;
  tokenId: TokenId;
}

export interface NotePageContext {
  url: string;
  title?: string;
  selection?: string;
}

/** One captured note, as stored in `note_entries`. */
export interface NoteEntry {
  page?: NotePageContext;
  captureContext?: NoteCaptureContext | null;
  id: string;
  /** Capture-local calendar day, or gateway-local when no capture offset is available. */
  day: string;
  /** ISO-8601 instant the note was captured. */
  capturedAt: string;
  /** ISO-8601 instant of the last text edit (= `capturedAt` until edited). */
  updatedAt: string;
  capturedTimeZoneId: string | null;
  capturedUtcOffsetSeconds: number | null;
  /** Gateway receipt instant; null when unavailable. */
  receivedAt: string | null;
  /**
   * When the gateway's transcript of a voice note replaced the text; absent
   * for any other note. An `updatedAt` equal to it is that transcript, not an
   * edit.
   */
  transcribedAt?: string;
  text: string;
  /** Capture surface slug (e.g. "cli", "portal", "ios-app", "ios-siri"). */
  surface: string | null;
  deviceId: string | null;
  /**
   * WGS-84 latitude of where the note was captured, or null when the
   * capturing device had no location fix (permission denied, indoors, a
   * non-mobile surface). Location is per-entry — a day's notes can be
   * spoken in different places — so it lives on the ledger row, not on
   * the aggregated per-day document's typed metadata.
   */
  latitude: number | null;
  /** WGS-84 longitude, paired with `latitude` (both set or both null). */
  longitude: number | null;
  /**
   * Human place name reverse-geocoded on the capturing device from the
   * coordinate (locality → region → country), e.g. "Paris". Null when
   * there was no fix, or a fix but no geocode (offline at capture time).
   */
  placeName: string | null;
}

export function createNoteEntriesTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_entries (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      text TEXT NOT NULL,
      surface TEXT,
      device_id TEXT,
      latitude REAL,
      longitude REAL,
      place_name TEXT,
      captured_time_zone_id TEXT,
      captured_utc_offset_seconds INTEGER,
      received_at TEXT,
      capture_context TEXT,
      page_context TEXT,
      transcribed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_note_entries_day ON note_entries(day);
    CREATE INDEX IF NOT EXISTS idx_note_entries_captured_at ON note_entries(captured_at);
  `);
  // Idempotent live-shape repair. The numbered migration owns upgrades;
  // these guards also make direct schema setup safe in tests and fresh DBs.
  const columns = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('note_entries')")
      .all()
      .map((row) => row.name),
  );
  if (!columns.has("page_context"))
    db.exec("ALTER TABLE note_entries ADD COLUMN page_context TEXT");
  if (!columns.has("latitude")) db.exec("ALTER TABLE note_entries ADD COLUMN latitude REAL");
  if (!columns.has("longitude")) db.exec("ALTER TABLE note_entries ADD COLUMN longitude REAL");
  if (!columns.has("place_name")) db.exec("ALTER TABLE note_entries ADD COLUMN place_name TEXT");
  if (!columns.has("captured_time_zone_id"))
    db.exec("ALTER TABLE note_entries ADD COLUMN captured_time_zone_id TEXT");
  if (!columns.has("captured_utc_offset_seconds"))
    db.exec("ALTER TABLE note_entries ADD COLUMN captured_utc_offset_seconds INTEGER");
  if (!columns.has("capture_context"))
    db.exec("ALTER TABLE note_entries ADD COLUMN capture_context TEXT");
  if (!columns.has("received_at")) db.exec("ALTER TABLE note_entries ADD COLUMN received_at TEXT");
  if (!columns.has("transcribed_at"))
    db.exec("ALTER TABLE note_entries ADD COLUMN transcribed_at TEXT");
}

interface NoteEntryRow {
  page_context: string | null;
  capture_context: string | null;
  id: string;
  day: string;
  captured_at: string;
  updated_at: string;
  text: string;
  surface: string | null;
  device_id: string | null;
  latitude: number | null;
  longitude: number | null;
  place_name: string | null;
  captured_time_zone_id: string | null;
  captured_utc_offset_seconds: number | null;
  received_at: string | null;
  transcribed_at: string | null;
}

function rowToEntry(row: NoteEntryRow): NoteEntry {
  return {
    ...(row.page_context ? { page: JSON.parse(row.page_context) as NotePageContext } : {}),
    ...(row.capture_context
      ? { captureContext: JSON.parse(row.capture_context) as NoteCaptureContext }
      : {}),
    id: row.id,
    day: row.day,
    capturedAt: row.captured_at,
    updatedAt: row.updated_at,
    text: row.text,
    surface: row.surface,
    deviceId: row.device_id,
    latitude: row.latitude,
    longitude: row.longitude,
    placeName: row.place_name,
    capturedTimeZoneId: row.captured_time_zone_id,
    capturedUtcOffsetSeconds: row.captured_utc_offset_seconds,
    receivedAt: row.received_at,
    ...(row.transcribed_at ? { transcribedAt: row.transcribed_at } : {}),
  };
}

/**
 * Insert one entry. `INSERT OR IGNORE` because the entry id doubles as
 * the client idempotency key: a retried `POST /notes` (e.g. the first
 * attempt timed out after the commit) re-sends the same id and must not
 * create a duplicate row. Returns whether a row was actually inserted.
 */
export function insertNoteEntry(
  db: Db,
  entry: NoteEntry,
  audit?: McpToolInvocationAuditInput,
  browserAuthority?: BrowserNoteAuthority,
): boolean {
  // This authorization lookup belongs in the writer transaction: a reader
  // snapshot cannot fence a token revoked while the capture waited in the queue.
  if (browserAuthority) {
    return db.transaction(() => {
      const authorized = db
        .prepare<
          [string, string, number],
          { scopes: string }
        >(`SELECT tokens.scopes FROM tokens JOIN devices ON devices.id = tokens.device_id WHERE tokens.id = ? AND tokens.device_id = ? AND devices.kind = 'browser' AND devices.revoked_at IS NULL AND (tokens.expires_at IS NULL OR tokens.expires_at > ?)`)
        .get(browserAuthority.tokenId, browserAuthority.deviceId, Date.now());
      if (
        !authorized ||
        !(JSON.parse(authorized.scopes) as string[]).includes("notes:create") ||
        entry.deviceId !== browserAuthority.deviceId
      ) {
        const error = new Error("Browser note authority is no longer active");
        error.name = "BrowserNoteAuthorizationError";
        throw error;
      }
      return insertNoteEntry(db, entry, audit);
    })();
  }
  if (audit) {
    return db.transaction(() => {
      if (
        audit.capability !== "notes" ||
        audit.tool !== "add_note" ||
        !audit.requireActiveAuthority ||
        !recordMcpToolInvocationAudit(db, audit)
      ) {
        const error = new Error("Note capture authorization is no longer active.");
        error.name = "NoteCaptureAuthorizationError";
        throw error;
      }
      return insertNoteEntry(db, entry);
    })();
  }
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO note_entries
         (id, day, captured_at, updated_at, text, surface, device_id, latitude, longitude, place_name,
          captured_time_zone_id, captured_utc_offset_seconds, received_at, capture_context, page_context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.id,
      entry.day,
      entry.capturedAt,
      entry.updatedAt,
      entry.text,
      entry.surface,
      entry.deviceId,
      entry.latitude,
      entry.longitude,
      entry.placeName,
      entry.capturedTimeZoneId,
      entry.capturedUtcOffsetSeconds,
      entry.receivedAt,
      entry.captureContext ? JSON.stringify(entry.captureContext) : null,
      entry.page ? JSON.stringify(entry.page) : null,
    );
  return result.changes > 0;
}

/**
 * Replace an entry's text and bump `updated_at`. Returns false when no
 * row with that id exists.
 */
export function updateNoteEntryText(db: Db, id: string, text: string, nowIso: string): boolean {
  const result = db
    .prepare(`UPDATE note_entries SET text = ?, updated_at = ? WHERE id = ?`)
    .run(text, nowIso, id);
  return result.changes > 0;
}

/**
 * Write a voice note's gateway transcript over the entry's text, only while
 * the text still reads `expected` — so an edit the user made in the meantime
 * is never overwritten. Stamps both `updated_at` (the day document must notice
 * the change) and `transcribed_at` (so the change is not mistaken for an
 * edit). Returns the entry's day on success, so the caller can re-render it;
 * `changed` when the text no longer matches, `missing` when the entry is gone.
 */
export function applyNoteEntryTranscript(
  db: Db,
  id: string,
  expected: string,
  text: string,
  nowIso: string,
): { outcome: "replaced"; day: string } | { outcome: "changed" | "missing" } {
  const row = db
    .prepare<
      [string],
      { day: string; text: string }
    >(`SELECT day, text FROM note_entries WHERE id = ?`)
    .get(id);
  if (!row) return { outcome: "missing" };
  if (row.text !== expected) return { outcome: "changed" };
  db.prepare(
    `UPDATE note_entries SET text = ?, updated_at = ?, transcribed_at = ? WHERE id = ?`,
  ).run(text, nowIso, nowIso, id);
  return { outcome: "replaced", day: row.day };
}

/**
 * Hard-delete one entry. Returns whether a row was deleted plus its day,
 * so the caller can re-render (or drop) that day's projected document
 * without a separate read.
 */
export function deleteNoteEntry(db: Db, id: string): { deleted: boolean; day: string | null } {
  const row = db
    .prepare<[string], { day: string }>(`SELECT day FROM note_entries WHERE id = ?`)
    .get(id);
  if (!row) return { deleted: false, day: null };
  db.prepare(`DELETE FROM note_entries WHERE id = ?`).run(id);
  return { deleted: true, day: row.day };
}

export function getNoteEntry(db: Db, id: string): NoteEntry | null {
  const row = db.prepare<[string], NoteEntryRow>(`SELECT * FROM note_entries WHERE id = ?`).get(id);
  return row ? rowToEntry(row) : null;
}

/** Cursor for the cross-day history feed: the last entry of the previous page. */
export interface NoteHistoryCursor {
  capturedAt: string;
  id: string;
}

export interface NoteHistoryPage {
  entries: NoteEntry[];
  /** Cursor for the next page, or null when the ledger is exhausted. */
  nextCursor: NoteHistoryCursor | null;
}

/**
 * Newest-first history feed across all days. Orders by
 * (`captured_at` DESC, `id` ASC) — instants are canonical UTC ISO so they
 * sort lexically, and ids are unique so the order is total and stable:
 * a concurrent wall-clock capture sorts strictly before any live cursor
 * (never shifts an in-flight page), and edits/deletes never reorder it.
 * Backdated captures (client-supplied `capturedAt`) can land inside an
 * already-served range and be missed by that page — completeness needs a
 * re-fetch from the head. `beforeDay` seeds the upper bound at the
 * newest instant of any day `<= day`, so a link to an old (even emptied)
 * day still lands on relevant notes instead of failing.
 */
export function listNoteEntriesHistory(
  db: Db,
  limit: number,
  cursor?: NoteHistoryCursor | null,
  beforeDay?: string | null,
): NoteHistoryPage {
  const where: string[] = [];
  const params: unknown[] = [];
  if (cursor) {
    where.push(`(captured_at < ? OR (captured_at = ? AND id > ?))`);
    params.push(cursor.capturedAt, cursor.capturedAt, cursor.id);
  } else if (beforeDay) {
    where.push(`captured_at <= (SELECT MAX(captured_at) FROM note_entries WHERE day <= ?)`);
    params.push(beforeDay);
  }
  const rows = db
    .prepare<unknown[], NoteEntryRow>(
      `SELECT * FROM note_entries
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY captured_at DESC, id ASC
       LIMIT ?`,
    )
    .all(...params, limit + 1)
    .map(rowToEntry);
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const last = entries.at(-1);
  return {
    entries,
    nextCursor: hasMore && last ? { capturedAt: last.capturedAt, id: last.id } : null,
  };
}

/**
 * All entries for one day, in capture order. Two captures can share a
 * captured_at millisecond, and ids are random UUIDs — so the tiebreak is
 * rowid (insertion order), which is what "capture order" actually means.
 */
export function listNoteEntriesForDay(db: Db, day: string): NoteEntry[] {
  const rows = db
    .prepare<
      [string],
      NoteEntryRow
    >(`SELECT * FROM note_entries WHERE day = ? ORDER BY captured_at, rowid`)
    .all(day);
  return rows.map(rowToEntry);
}

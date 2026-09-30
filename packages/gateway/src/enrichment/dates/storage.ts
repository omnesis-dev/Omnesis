// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Storage for the date-enrichment signal.
 *
 * Extracted dates live in a sidecar table `document_extracted_dates` in
 * `omnesis.db`, keyed by `document_id` with `ON DELETE CASCADE` — so a
 * document delete atomically drops its date rows through the existing writer
 * delete op, with no cross-file reconcile machinery.
 *
 * Work discovery uses the `documents.dates_extracted_at` dirty-flag column
 * (mirrors `links_extracted_at` / `people_resolved_at`): NULL means "not yet
 * extracted". The document upsert nulls it whenever content changes, so new
 * documents, un-extracted old documents, and edited documents are all found
 * by the single query `WHERE dates_extracted_at IS NULL` (partial-indexed).
 *
 * These are plain functions over a `better-sqlite3` handle; the scheduler
 * lanes call them with the appropriate handle — the io pool for
 * {@link fetchDateExtractionBatch}, the writer for {@link applyExtractedDates},
 * the main read handle for {@link getExtractedDatesForDocument} and the counts.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import type { ExtractedDate } from "@omnesis/types";

import type { DateExtractionDocRow, DateExtractionResult } from "./extractor.js";

/**
 * Idempotent DDL for the date-enrichment sidecar table + its own indexes. The
 * table has no dependency on the `documents.dates_extracted_at` column, so it
 * is safe to call from `runSchemaSetup` (fresh installs) and from the numbered
 * migration (upgrades) — mirrors the doc_annotations pattern.
 *
 * The partial work-discovery index over `documents.dates_extracted_at` is NOT
 * created here: that column is added by the migration (via ALTER) *after*
 * `runSchemaSetup` runs, so its index must be created in the migration —
 * see {@link createDatesUnprocessedIndex}.
 */
export function createExtractedDatesTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_extracted_dates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      resolved_start TEXT,
      resolved_end TEXT,
      mod TEXT,
      relative INTEGER NOT NULL DEFAULT 0,
      matched_text TEXT NOT NULL,
      timex TEXT NOT NULL,
      char_start INTEGER NOT NULL,
      char_end INTEGER NOT NULL
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_document_extracted_dates_doc ON document_extracted_dates(document_id)",
  );
  // Supports the downstream "dates ahead of now" scan (the temporal-annotation
  // heuristic) — range-scan resolved_start instead of a full table scan.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_document_extracted_dates_start ON document_extracted_dates(resolved_start)",
  );
}

/** A two-bound range: the one shape that may begin before a window and end inside it. */
const MENTION_IS_RANGE = "(resolved_start IS NOT NULL AND resolved_end IS NOT NULL)";

/**
 * Add the day bounds the temporal query reads mentions by: the first day a
 * mention covers and the day after its last (`YYYY-MM-DD`, half-open), both
 * NULL for a date that is not a mention (see `mention-bounds.ts`), and
 * `mention_deadline` (1 when the phrase states a deadline). The extractor
 * decides them and the writer stores them with the date.
 *
 * - `idx_…_mention_start` on `(start, end)` — its implicit row-id suffix makes
 *   it the query's own order, so a page is an ordered index walk that stops
 *   at its limit.
 * - `idx_…_mention_range` on the same bounds, for two-bound ranges only — the
 *   few mentions that begin before a window and end inside it, found by a
 *   start no more than `MENTION_MAX_SPAN_DAYS` before the window.
 * - `idx_…_mention_thread` on the thread and bounds — whether a later message
 *   of the same thread repeats a mention.
 *
 * `thread_key` names the conversation the document belongs to (its source
 * and the `metadata.extra.threadId` / `conversationId` convention), NULL for
 * a document outside one.
 *
 * Idempotent: columns are added only when missing.
 */
export function ensureMentionDayColumns(db: Db): void {
  const columns = new Set(
    db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_info('document_extracted_dates')",
      )
      .all()
      .map((row) => row.name),
  );
  for (const [column, type] of [
    ["mention_start_day", "TEXT"],
    ["mention_end_day", "TEXT"],
    ["mention_deadline", "INTEGER"],
    ["thread_key", "TEXT"],
  ] as const) {
    if (!columns.has(column)) {
      db.exec(`ALTER TABLE document_extracted_dates ADD COLUMN ${column} ${type}`);
    }
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_document_extracted_dates_mention_start
       ON document_extracted_dates(mention_start_day, mention_end_day)
       WHERE mention_start_day IS NOT NULL`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_document_extracted_dates_mention_range
       ON document_extracted_dates(mention_start_day, mention_end_day)
       WHERE mention_start_day IS NOT NULL AND ${MENTION_IS_RANGE}`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_document_extracted_dates_mention_thread
       ON document_extracted_dates(thread_key, mention_start_day, mention_end_day)
       WHERE thread_key IS NOT NULL AND mention_start_day IS NOT NULL`,
  );
}

/**
 * Migration 185: add the mention columns and rescan every document, so every
 * stored date is read again with the current language routing and mention
 * rules.
 */
export function addDateMentions(db: Db): void {
  ensureMentionDayColumns(db);
  db.exec("UPDATE documents SET dates_extracted_at = NULL WHERE dates_extracted_at IS NOT NULL");
}

/**
 * Partial index over un-extracted documents — the extraction pass's cheap
 * "find work" query (mirrors idx_documents_links_unprocessed). References
 * `documents.dates_extracted_at`, which the migration adds by ALTER, so this
 * runs from the migration only (after the column exists), never from
 * `runSchemaSetup` (which runs before the migration on an upgrade).
 */
export function createDatesUnprocessedIndex(db: Db): void {
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_documents_dates_unprocessed ON documents(id) WHERE dates_extracted_at IS NULL",
  );
}

/**
 * Fetch up to `limit` documents that still need date extraction, truncating
 * `content` to `maxChars` so a large body never bloats the io→main→cpu copy
 * (the extractor caps its own input to the same budget). `title` rides along
 * for the extractor's language routing. Newest documents first (the partial
 * pending-age index serves exactly this), so live ingest clears the agent
 * readiness barrier promptly even while a large re-extraction backlog
 * drains behind it. Runs on the io pool's read-only handle.
 */
export function fetchDateExtractionBatch(
  db: Db,
  limit: number,
  maxChars: number,
): DateExtractionDocRow[] {
  return db
    .prepare(
      `SELECT id, title, substr(content, 1, ?) AS content,
              LENGTH(content) AS contentLength,
              COALESCE(source_updated_at, source_created_at) AS anchorAt,
              source_id || char(0) || COALESCE(
                json_extract(metadata, '$.extra.threadId'),
                json_extract(metadata, '$.extra.conversationId')
              ) AS threadKey
         FROM documents
        WHERE dates_extracted_at IS NULL
        ORDER BY ingested_at DESC
        LIMIT ?`,
    )
    .all(maxChars, limit) as DateExtractionDocRow[];
}

export interface ApplyExtractedDatesResult {
  /** Documents whose date rows were (re)written and flag stamped. */
  applied: number;
  /** Total date rows inserted across the batch. */
  datesWritten: number;
}

/**
 * Persist a batch of per-document extraction results and stamp each document's
 * `dates_extracted_at`. Runs on the single writer at background priority.
 *
 * Race-safety: a document may be deleted between fetch and apply. We stamp the
 * document row first; if that UPDATE hits zero rows the document is gone, so we
 * skip its date rows — avoiding an FK violation from inserting a child row for
 * a missing parent. The delete + inserts + stamp for the whole batch run in
 * one transaction.
 */
export function applyExtractedDates(
  db: Db,
  entries: DateExtractionResult[],
): ApplyExtractedDatesResult {
  const stamp = db.prepare(
    "UPDATE documents SET dates_extracted_at = ?, dates_truncated = ? WHERE id = ?",
  );
  const del = db.prepare("DELETE FROM document_extracted_dates WHERE document_id = ?");
  const ins = db.prepare(
    `INSERT INTO document_extracted_dates
       (document_id, kind, resolved_start, resolved_end, mod, relative, matched_text, timex, char_start, char_end,
        mention_start_day, mention_end_day, mention_deadline, thread_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  let applied = 0;
  let datesWritten = 0;

  const run = db.transaction((es: DateExtractionResult[]) => {
    for (const e of es) {
      // Stamp first — this is also the existence check. Zero changes means the
      // document was deleted since it was fetched; skip it entirely.
      if (stamp.run(now, e.truncated ? 1 : null, e.id).changes === 0) continue;
      applied++;
      del.run(e.id);
      for (const [index, d] of e.dates.entries()) {
        const mention = e.mentions?.[index] ?? null;
        ins.run(
          e.id,
          d.kind,
          d.resolvedStart,
          d.resolvedEnd,
          d.mod ?? null,
          d.relative ? 1 : 0,
          d.text,
          d.timex,
          d.charStart,
          d.charEnd,
          mention?.startDay ?? null,
          mention?.endDay ?? null,
          mention ? (mention.deadline ? 1 : 0) : null,
          e.threadKey ?? null,
        );
        datesWritten++;
      }
    }
  });
  run(entries);
  return { applied, datesWritten };
}

interface ExtractedDateRow {
  kind: string;
  resolved_start: string | null;
  resolved_end: string | null;
  mod: string | null;
  relative: number;
  matched_text: string;
  timex: string;
  char_start: number;
  char_end: number;
}

function rowToExtractedDate(row: ExtractedDateRow): ExtractedDate {
  return {
    kind: row.kind as ExtractedDate["kind"],
    resolvedStart: row.resolved_start,
    resolvedEnd: row.resolved_end,
    ...(row.mod != null ? { mod: row.mod } : {}),
    relative: row.relative === 1,
    text: row.matched_text,
    timex: row.timex,
    charStart: row.char_start,
    charEnd: row.char_end,
  };
}

/**
 * Read the extracted dates for one document, resolved dates first (by date),
 * then by position in the text. Runs on the main read handle (the satellite
 * `GET /documents/:id/dates` endpoint).
 */
export function getExtractedDatesForDocument(db: Db, documentId: string): ExtractedDate[] {
  const rows = db
    .prepare(
      `SELECT kind, resolved_start, resolved_end, mod, relative, matched_text, timex, char_start, char_end
         FROM document_extracted_dates
        WHERE document_id = ?
        ORDER BY (resolved_start IS NULL), resolved_start, char_start`,
    )
    .all(documentId) as ExtractedDateRow[];
  return rows.map(rowToExtractedDate);
}

/**
 * Count documents that still need date extraction (progress denominator),
 * optionally only those of some sources.
 */
export function countPendingDateExtraction(db: Db, sourceIds?: readonly string[]): number {
  const bySource = sourceIds?.length
    ? ` AND source_id IN (${sourceIds.map(() => "?").join(", ")})`
    : "";
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM documents WHERE dates_extracted_at IS NULL${bySource}`)
      .get(...(sourceIds ?? [])) as { c: number }
  ).c;
}

/** Count documents that have been date-extracted (progress numerator). */
export function countExtractedDocuments(db: Db): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM documents WHERE dates_extracted_at IS NOT NULL")
      .get() as {
      c: number;
    }
  ).c;
}

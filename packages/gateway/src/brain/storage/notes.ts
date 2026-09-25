// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Cognition Steward's persistent notes blob — a single, durable,
 * agent-curated text file injected into every run's prompt. Size-capped
 * at write time (the cap is a config knob; this layer takes it as a
 * parameter) so the per-run token cost stays bounded.
 *
 * Cap semantics: BYTES of UTF-8, not JS string length — the cap exists
 * to bound prompt size, and multi-byte text would otherwise sneak past
 * it. The cap plays two roles:
 *
 *   - For `writeCognitionNotes` (a full rewrite) it is a hard limit — an
 *     oversize rewrite throws {@link CognitionNotesCapError}. A rewrite
 *     re-emits the whole blob, so it can always be written under the cap.
 *   - For `appendCognitionNotes` / `editCognitionNotes` it is a soft
 *     curation target: writes that land between the cap and the 2x
 *     overflow ceiling are ACCEPTED and reported `overCap: true` so the
 *     caller can schedule the background compaction run. Memory writes
 *     must succeed immediately; curation is compaction's job, not the
 *     writing agent's. Only a write above the ceiling is refused.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

/** Default cap; mirrored by the config knob `notesMaxBytes`. */
export const DEFAULT_COGNITION_NOTES_MAX_BYTES = 8192;

/**
 * Hard ceiling for append/edit writes, as a multiple of the configured cap.
 * The configured cap is a curation TARGET — the background compaction run
 * brings the blob back under it — while the ceiling is the safety bound that
 * keeps the per-run prompt injection sane even before compaction lands.
 */
export const COGNITION_NOTES_OVERFLOW_FACTOR = 2;

export class CognitionNotesCapError extends Error {
  constructor(
    public readonly attemptedBytes: number,
    public readonly maxBytes: number,
  ) {
    super(
      `agent notes write of ${attemptedBytes} bytes is ${attemptedBytes - maxBytes} over the ${maxBytes}-byte cap — remove at least that much`,
    );
    this.name = "CognitionNotesCapError";
  }
}

/** Current notes content; empty string when never written or wiped. */
export function readCognitionNotes(db: Db): string {
  const row = db
    .prepare<[], { content: string }>("SELECT content FROM cognition_notes WHERE id = 1")
    .get();
  return row?.content ?? "";
}

function upsertCognitionNotesRow(db: Db, content: string, now: number): void {
  db.prepare<[string, number]>(
    `INSERT INTO cognition_notes (id, content, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  ).run(content, now);
}

/**
 * Replace the notes content (the `notes_rewrite` primitive). Returns the
 * stored content so callers can echo the post-write state back to the
 * agent. The cap is hard here: a rewrite emits the whole blob, so unlike
 * append/edit it has no overflow allowance to grow into.
 */
export function writeCognitionNotes(
  db: Db,
  content: string,
  opts: { maxBytes: number; now: number },
): string {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > opts.maxBytes) throw new CognitionNotesCapError(bytes, opts.maxBytes);
  upsertCognitionNotesRow(db, content, opts.now);
  return content;
}

/** Outcome of an atomic notes append. */
export interface AppendCognitionNotesResult {
  /** True = the append was written; false = it would exceed the overflow ceiling. */
  applied: boolean;
  /** The combined size in UTF-8 bytes (written when `applied`, else the would-be size). */
  bytes: number;
  /**
   * True = the blob is (or would be) above the soft cap. `applied && overCap`
   * means the write landed but compaction is needed; `!applied` implies
   * `overCap` (the write was refused above the hard ceiling).
   */
  overCap: boolean;
}

/**
 * The `notes_append` primitive: read-modify-write of the notes blob in ONE
 * synchronous transaction so concurrent daily runs (workerConcurrency > 1)
 * can't clobber each other's lesson. The read + concatenate + cap-check +
 * write all happen inside the writer worker's single-writer gate — never a
 * read on one connection and a write on another — so the append is a true
 * atomic accumulate. An append that lands above the soft cap but within the
 * overflow ceiling is written and reported `overCap: true` (the tool layer
 * schedules the compaction run); only a combined size above the ceiling
 * leaves the notes unchanged and reports `applied: false`.
 */
export function appendCognitionNotes(
  db: Db,
  text: string,
  opts: { maxBytes: number; now: number },
): AppendCognitionNotesResult {
  return db.transaction((): AppendCognitionNotesResult => {
    const current = readCognitionNotes(db);
    const combined = current.length > 0 ? `${current}\n${text}` : text;
    const bytes = Buffer.byteLength(combined, "utf8");
    if (bytes > opts.maxBytes * COGNITION_NOTES_OVERFLOW_FACTOR) {
      return { applied: false, bytes, overCap: true };
    }
    upsertCognitionNotesRow(db, combined, opts.now);
    return { applied: true, bytes, overCap: bytes > opts.maxBytes };
  })();
}

/** Outcome of an atomic notes edit. */
export type EditCognitionNotesResult =
  | { applied: true; bytes: number; overCap: boolean }
  /** `oldText` does not occur in the current notes. */
  | { applied: false; reason: "not_found" }
  /** `oldText` occurs more than once — the caller must pass a longer, unique span. */
  | { applied: false; reason: "ambiguous"; occurrences: number }
  /** The edited blob would exceed the overflow ceiling; notes unchanged. */
  | { applied: false; reason: "over_ceiling"; bytes: number }
  /** `oldText`/`newText` or the edited blob is not well-formed UTF-16 (lone surrogate half). */
  | { applied: false; reason: "malformed" };

/** Non-overlapping occurrence count; 0 for an empty needle. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * The `notes_edit` primitive: targeted in-place replacement, atomic under
 * the same single-transaction read-modify-write discipline as append.
 * Exact-substring semantics — `oldText` must occur exactly once in the
 * current blob, otherwise the edit is refused (`not_found` / `ambiguous`)
 * and the notes are unchanged. Both texts and the edited result must be
 * well-formed UTF-16: matching operates on code units, so a lone surrogate
 * half (e.g. half of an emoji) would splice through a character and
 * corrupt the stored blob — such edits are refused (`malformed`). A
 * successful edit enforces the same overflow ceiling as append, so edits
 * that shrink the blob always pass.
 */
export function editCognitionNotes(
  db: Db,
  oldText: string,
  newText: string,
  opts: { maxBytes: number; now: number },
): EditCognitionNotesResult {
  if (!oldText.isWellFormed() || !newText.isWellFormed()) {
    return { applied: false, reason: "malformed" };
  }
  return db.transaction((): EditCognitionNotesResult => {
    const current = readCognitionNotes(db);
    const occurrences = countOccurrences(current, oldText);
    if (occurrences === 0) return { applied: false, reason: "not_found" };
    if (occurrences > 1) return { applied: false, reason: "ambiguous", occurrences };
    // Index-based splice, not String.replace — replace() interprets `$`
    // patterns in the replacement, and newText is verbatim agent text.
    const at = current.indexOf(oldText);
    const next = current.slice(0, at) + newText + current.slice(at + oldText.length);
    // Defense in depth: with well-formed inputs the splice cannot create a
    // lone surrogate, but a blob that is already malformed must never be
    // written back through this path (better-sqlite3 would store U+FFFD).
    if (!next.isWellFormed()) return { applied: false, reason: "malformed" };
    const bytes = Buffer.byteLength(next, "utf8");
    if (bytes > opts.maxBytes * COGNITION_NOTES_OVERFLOW_FACTOR) {
      return { applied: false, reason: "over_ceiling", bytes };
    }
    upsertCognitionNotesRow(db, next, opts.now);
    return { applied: true, bytes, overCap: bytes > opts.maxBytes };
  })();
}

/** Operator-CLI wipe — the one operator mutation in V1. */
export function wipeCognitionNotes(db: Db, now: number): void {
  upsertCognitionNotesRow(db, "", now);
}

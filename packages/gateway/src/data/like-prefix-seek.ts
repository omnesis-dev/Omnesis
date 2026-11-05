// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Index seeks for SQLite `LIKE` prefix patterns.
 *
 * SQLite's default `LIKE` folds ASCII case, so it cannot use a BINARY index on
 * the column it tests: `id LIKE 'ab12%'` on the documents table reads every
 * row, which on a large encrypted store is seconds of synchronous work. Every
 * match of a pattern, however, starts with the pattern's literal head (the text
 * before its first `%` or `_`) up to ASCII case. A column whose stored values
 * hold no uppercase ASCII, or an index on `LOWER(column)`, can therefore seek
 * to the range of values starting with the head's lowercase form, and test the
 * original pattern only on the rows in that range. The result is exactly the
 * pattern's matches, wildcards and case-insensitivity included.
 *
 * SQLite's `LOWER()` and `LIKE` both fold ASCII only (this build has no ICU),
 * so lowercasing ASCII here, and leaving every other character as it is,
 * mirrors both.
 */

import type { Db } from "./types.js";

export interface LikePrefixSeek {
  /** Inclusive lower bound: the pattern's literal head, ASCII-lowercased. */
  lower: string;
  /**
   * Exclusive upper bound: the smallest string greater than every string that
   * starts with `lower`, or null when there is none (an empty head).
   */
  upper: string | null;
}

/** The seek range for a `LIKE` pattern used without an `ESCAPE` clause. */
export function likePrefixSeek(pattern: string): LikePrefixSeek {
  const wildcard = pattern.search(/[%_]/);
  // A bound parameter reaches SQLite as UTF-8, where a lone surrogate becomes
  // U+FFFD; computing the range on that form keeps it consistent with what
  // SQLite compares.
  const head = (wildcard === -1 ? pattern : pattern.slice(0, wildcard)).toWellFormed();
  const lower = head.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  return { lower, upper: prefixUpperBound(lower) };
}

/**
 * The smallest string greater, in SQLite's BINARY (UTF-8 byte) order, than
 * every string starting with `prefix`. Code point order is UTF-8 byte order,
 * so incrementing the last code point that can be incremented gives it.
 */
function prefixUpperBound(prefix: string): string | null {
  const codePoints = Array.from(prefix);
  while (codePoints.length > 0) {
    const last = codePoints.pop()!.codePointAt(0)!;
    if (last === 0x10ffff) continue;
    const next = last + 1 === 0xd800 ? 0xe000 : last + 1;
    return codePoints.join("") + String.fromCodePoint(next);
  }
  return null;
}

/**
 * A `WHERE` fragment and its parameters selecting the documents whose id
 * matches `id LIKE '<input>%'`, the gateway's id-prefix lookup, through a seek
 * on the documents primary key instead of a scan of the table.
 *
 * Equivalent to the `LIKE` because document ids are lowercase: every id is
 * minted by `randomUUID()`. `column` names the id column as the query refers
 * to it (`document.id` under an alias). Callers add their own `ORDER BY` and
 * `LIMIT`.
 */
export function documentIdPrefixFilter(
  input: string,
  column = "id",
): { sql: string; params: string[] } {
  const pattern = `${input}%`;
  const seek = likePrefixSeek(pattern);
  return seek.upper === null
    ? { sql: `${column} >= ? AND ${column} LIKE ?`, params: [seek.lower, pattern] }
    : {
        sql: `${column} >= ? AND ${column} < ? AND ${column} LIKE ?`,
        params: [seek.lower, seek.upper, pattern],
      };
}

/**
 * Up to two ids of documents matching an id or id prefix, in id order: one
 * id is a match, two mean the prefix is ambiguous. Reads only the primary
 * key's index.
 */
export function matchDocumentIdPrefix(db: Db, input: string): string[] {
  const filter = documentIdPrefixFilter(input);
  return db
    .prepare<string[], { id: string }>(
      `SELECT id FROM documents WHERE ${filter.sql} ORDER BY id LIMIT 2`,
    )
    .all(...filter.params)
    .map((row) => row.id);
}

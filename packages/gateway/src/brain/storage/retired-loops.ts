// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The consolidation store — an append-only `retired_loops` table that records
 * a compact structured trace of every loop the agent resolves (`done` /
 * `dismissed`) or removes through the write-gated delete (`decayed` /
 * `deleted`). Lexical matches from it surface during reconcile so a commitment
 * that keeps recurring is recognised as a KNOWN recurrence — with its cadence
 * and recurrence count — rather than minted as a fresh loop each time.
 *
 * A privacy delete never writes here (see `cascadeOpenLoopPrivacyDelete`): a
 * privacy delete purges derived content, and a lingering trace would leak it.
 *
 * Same conventions as the sibling repositories: plain functions over a
 * better-sqlite3 handle, and every write takes an explicit `now` (unix ms) so
 * tests control time.
 */

import type Database from "better-sqlite3";
import type { OpenLoopRow, RetiredLoopOutcome, RetiredLoopRow } from "./types.js";

type Db = Database.Database;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The recurrence key: lower-case the title, split on non-alphanumerics, keep
 * words of 3+ characters, sort them, and rejoin. Order- and punctuation-
 * insensitive so "Reply to the lawyer's email" and "email — reply, lawyer"
 * collapse to the same key. Unicode-aware (`\p{L}\p{N}`) so non-Latin titles
 * keep their words instead of normalising to the empty string.
 */
export function normalizeLoopTitle(title: string): string {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
    .sort()
    .join(" ");
}

/** Escape SQL LIKE metacharacters in a literal token (`ESCAPE '\'`). */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

interface RetiredLoopDbRow {
  id: string;
  title: string;
  title_norm: string;
  description: string;
  actors_json: string;
  involved_json: string;
  outcome: string;
  importance: number;
  deadline_json: string | null;
  created_at: number;
  retired_at: number;
  cadence_days: number | null;
  recurrence_count: number;
}

function rowToRetiredLoop(r: RetiredLoopDbRow): RetiredLoopRow {
  return {
    id: r.id,
    title: r.title,
    titleNorm: r.title_norm,
    description: r.description,
    actors: JSON.parse(r.actors_json) as string[],
    involved: JSON.parse(r.involved_json) as string[],
    outcome: r.outcome as RetiredLoopOutcome,
    importance: r.importance,
    deadline: r.deadline_json === null ? null : (JSON.parse(r.deadline_json) as unknown),
    createdAt: r.created_at,
    retiredAt: r.retired_at,
    cadenceDays: r.cadence_days,
    recurrenceCount: r.recurrence_count,
  };
}

/**
 * Append a retirement trace for `loop`, keyed by its normalized title. The
 * most-recent prior trace sharing that key (EXCLUDING this loop's own id, so a
 * loop retired twice never counts itself) sets the recurrence arithmetic:
 * `cadenceDays` = whole-day gap since that prior retirement (null on the
 * first), `recurrenceCount` = prior + 1 (1 on the first). `INSERT OR REPLACE`
 * keeps the store idempotent on the loop id.
 *
 * Callers snapshot the loop and invoke this BEFORE the UPDATE/DELETE that
 * retires it, so the row still reflects the loop's pre-retirement state.
 */
export function retireLoop(
  db: Db,
  loop: OpenLoopRow,
  outcome: RetiredLoopOutcome,
  now: number,
): void {
  const titleNorm = normalizeLoopTitle(loop.title);
  const prior = db
    .prepare<[string, string], { retired_at: number; recurrence_count: number }>(
      `SELECT retired_at, recurrence_count FROM retired_loops
       WHERE title_norm = ? AND id != ? ORDER BY retired_at DESC LIMIT 1`,
    )
    .get(titleNorm, loop.id);
  const cadenceDays = prior ? Math.floor((now - prior.retired_at) / DAY_MS) : null;
  const recurrenceCount = prior ? prior.recurrence_count + 1 : 1;

  db.prepare<unknown[]>(
    `INSERT OR REPLACE INTO retired_loops (
       id, title, title_norm, description, actors_json, involved_json,
       outcome, importance, deadline_json, created_at, retired_at,
       cadence_days, recurrence_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    loop.id,
    loop.title,
    titleNorm,
    loop.description,
    JSON.stringify(loop.actors),
    JSON.stringify(loop.involved),
    outcome,
    loop.importance,
    loop.deadline === undefined || loop.deadline === null ? null : JSON.stringify(loop.deadline),
    loop.createdAt,
    now,
    cadenceDays,
    recurrenceCount,
  );
}

/**
 * Every retirement trace, most-recently-retired first — the operator
 * consolidation-store read (the Cognition Memory surface). Read-only; the
 * store is append-only so this never mutates.
 */
export function listRetiredLoops(
  db: Db,
  options: { limit?: number; beforeRetired?: { retiredAt: number; id: string } } = {},
): RetiredLoopRow[] {
  const cursor = options.beforeRetired ? "WHERE (retired_at, id) < (?, ?)" : "";
  const params: Array<string | number> = [];
  if (options.beforeRetired) {
    params.push(options.beforeRetired.retiredAt, options.beforeRetired.id);
  }
  params.push(options.limit ?? 100);
  return db
    .prepare<(string | number)[], RetiredLoopDbRow>(
      `SELECT * FROM retired_loops INDEXED BY idx_retired_loops_page ${cursor}
       ORDER BY retired_at DESC, id DESC LIMIT ?`,
    )
    .all(...params)
    .map(rowToRetiredLoop);
}

/**
 * Lexical scan over the consolidation store, mirroring `searchOpenLoopsLexical`
 * over the active loops: case-insensitive substring match of any query token
 * (length ≥3, first 8 tokens) against title + description, most-recently-
 * retired first. Over-matching is acceptable — the agent inspects the traces.
 */
export function searchRetiredLoopsLexical(
  db: Db,
  query: string,
  options: { limit?: number } = {},
): RetiredLoopRow[] {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}#@_-]+/u)
    .filter((t) => t.length >= 3)
    .slice(0, 8);
  if (tokens.length === 0) return [];
  const clause = tokens
    .map(() => `(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(description) LIKE ? ESCAPE '\\')`)
    .join(" OR ");
  const params: (string | number)[] = [];
  for (const token of tokens) {
    const pattern = `%${escapeLike(token)}%`;
    params.push(pattern, pattern);
  }
  params.push(options.limit ?? 8);
  const rows = db
    .prepare<
      (string | number)[],
      RetiredLoopDbRow
    >(`SELECT * FROM retired_loops WHERE ${clause} ORDER BY retired_at DESC LIMIT ?`)
    .all(...params);
  return rows.map(rowToRetiredLoop);
}

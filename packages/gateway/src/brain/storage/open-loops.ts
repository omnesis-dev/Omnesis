// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Open-loop repository — CRUD over `open_loops` + `open_loop_docs` +
 * `open_loop_ledger`, the loop-deletion invariant, and the privacy-delete
 * cascade.
 *
 * Same conventions as the other `data/repositories` modules: plain
 * functions over a better-sqlite3 handle, mutations take an explicit
 * `now` (unix ms) so tests control time, and in production every write
 * routes through the writer worker (single-writer invariant).
 *
 * Two deletion rules live here:
 *
 *  - **Deletion invariant** (engine-enforced, not agent discretion):
 *    deleting a loop by any path deletes its attached NON-terminal
 *    briefs, so a showable brief's `related_loop_ids` never dangle.
 *    Terminal-dismissed briefs are never shown again, so they survive
 *    with the edge removed.
 *
 *  - **Privacy-delete cascade**: privacy-deleting a source document
 *    deletes every loop and brief derived from it (conservative: any
 *    loop whose `docs[]` — and any brief whose `citations[]` — contains
 *    the deleted document, plus ALL briefs attached to a cascaded loop,
 *    terminal included; derived agent text may embed the source
 *    content). The caller (the document privacy-delete path) then
 *    deletes the loops' mirrored corpus documents by external id.
 */

import { deleteBriefsAttachedToLoops, findActiveBriefsForLoops } from "./briefs.js";
import { bumpCognitionDecayDirty } from "./engine-state.js";
import { retireLoop } from "./retired-loops.js";
import type Database from "better-sqlite3";
import type { OpenLoopLedgerEntry, OpenLoopRow, OpenLoopState } from "./types.js";

type Db = Database.Database;

interface OpenLoopDbRow {
  id: string;
  created_by_run: string;
  state: string;
  confidence: number;
  importance: number;
  title: string;
  description: string;
  deadline_json: string | null;
  actors_json: string;
  involved_json: string;
  blocked_by_json: string;
  created_at: number;
  last_update: number;
  last_decay_check: number | null;
  decay_check_count: number;
}

function rowToOpenLoop(r: OpenLoopDbRow, docs: string[]): OpenLoopRow {
  return {
    id: r.id,
    createdByRun: r.created_by_run,
    state: r.state as OpenLoopState,
    confidence: r.confidence,
    importance: r.importance,
    title: r.title,
    description: r.description,
    deadline: r.deadline_json === null ? null : (JSON.parse(r.deadline_json) as unknown),
    actors: JSON.parse(r.actors_json) as string[],
    involved: JSON.parse(r.involved_json) as string[],
    docs,
    blockedBy: JSON.parse(r.blocked_by_json) as string[],
    createdAt: r.created_at,
    lastUpdate: r.last_update,
    lastDecayCheck: r.last_decay_check,
    decayCheckCount: r.decay_check_count,
  };
}

function loopDocs(db: Db, loopId: string): string[] {
  return db
    .prepare<[string], { doc_id: string }>(
      "SELECT doc_id FROM open_loop_docs WHERE loop_id = ? ORDER BY doc_id",
    )
    .all(loopId)
    .map((r) => r.doc_id);
}

function replaceLoopDocs(db: Db, loopId: string, docs: readonly string[]): void {
  db.prepare<[string]>("DELETE FROM open_loop_docs WHERE loop_id = ?").run(loopId);
  const insert = db.prepare<[string, string]>(
    "INSERT OR IGNORE INTO open_loop_docs (loop_id, doc_id) VALUES (?, ?)",
  );
  for (const docId of docs) insert.run(loopId, docId);
}

/**
 * Dual-write the `actors[]`/`involved[]` people ids into the
 * `open_loop_people` join table (the by-value reconcile index), mirroring
 * `replaceLoopDocs`. The (loop, *) set is rewritten whole from the loop's
 * effective people, so a caller must pass BOTH lists — on a partial update
 * `updateOpenLoop` re-derives the untouched list before calling here. A
 * person appearing on both roles yields one `'actor'` and one `'involved'`
 * row; `INSERT OR IGNORE` collapses an id repeated within one list.
 */
function replaceLoopPeople(
  db: Db,
  loopId: string,
  actors: readonly string[],
  involved: readonly string[],
): void {
  db.prepare<[string]>("DELETE FROM open_loop_people WHERE loop_id = ?").run(loopId);
  const insert = db.prepare<[string, string, string]>(
    "INSERT OR IGNORE INTO open_loop_people (loop_id, person_id, role) VALUES (?, ?, ?)",
  );
  for (const personId of actors) insert.run(loopId, personId, "actor");
  for (const personId of involved) insert.run(loopId, personId, "involved");
}

/** The people join-table rows for a loop, split by role (reconcile-index reader). */
export interface LoopPeople {
  actors: string[];
  involved: string[];
}

export function loopPeople(db: Db, loopId: string): LoopPeople {
  const rows = db
    .prepare<
      [string],
      { person_id: string; role: string }
    >("SELECT person_id, role FROM open_loop_people WHERE loop_id = ? ORDER BY role, person_id")
    .all(loopId);
  return {
    actors: rows.filter((r) => r.role === "actor").map((r) => r.person_id),
    involved: rows.filter((r) => r.role === "involved").map((r) => r.person_id),
  };
}

export interface CreateOpenLoopInput {
  id: string;
  createdByRun: string;
  title: string;
  description?: string;
  confidence: number;
  importance: number;
  state?: OpenLoopState;
  deadline?: unknown;
  actors?: string[];
  involved?: string[];
  docs?: string[];
  blockedBy?: string[];
}

export function createOpenLoop(db: Db, input: CreateOpenLoopInput, now: number): OpenLoopRow {
  db.prepare<unknown[]>(
    `INSERT INTO open_loops (
       id, created_by_run, state, confidence, importance, title, description,
       deadline_json, actors_json, involved_json, blocked_by_json,
       created_at, last_update
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.createdByRun,
    input.state ?? "open",
    input.confidence,
    input.importance,
    input.title,
    input.description ?? "",
    input.deadline === undefined || input.deadline === null ? null : JSON.stringify(input.deadline),
    JSON.stringify(input.actors ?? []),
    JSON.stringify(input.involved ?? []),
    JSON.stringify(input.blockedBy ?? []),
    now,
    now,
  );
  replaceLoopDocs(db, input.id, input.docs ?? []);
  replaceLoopPeople(db, input.id, input.actors ?? [], input.involved ?? []);
  bumpCognitionDecayDirty(db);
  const created = getOpenLoop(db, input.id);
  if (!created) throw new Error(`open loop ${input.id} vanished mid-create`);
  return created;
}

export function getOpenLoop(db: Db, id: string): OpenLoopRow | null {
  const row = db.prepare<[string], OpenLoopDbRow>("SELECT * FROM open_loops WHERE id = ?").get(id);
  if (!row) return null;
  return rowToOpenLoop(row, loopDocs(db, id));
}

/**
 * Title of a still-ACTIVE (open | snoozed) loop by id, or null when the loop
 * is gone or has resolved (done | dismissed). Purpose-built for surfacing a
 * loop's surviving blockers: a blocker that has been completed no longer
 * blocks, and a title-only read skips the linked-docs fetch `getOpenLoop`
 * would do.
 */
export function getActiveLoopTitle(db: Db, id: string): string | null {
  const row = db
    .prepare<
      [string],
      { title: string; state: string }
    >("SELECT title, state FROM open_loops WHERE id = ?")
    .get(id);
  if (!row) return null;
  return row.state === "open" || row.state === "snoozed" ? row.title : null;
}

/**
 * Active (open | snoozed) loops that name `docId` among their source docs —
 * "which tracked obligation is this document part of". The read behind the
 * agent's per-document memory lookup.
 */
export function listLoopsForDoc(db: Db, docId: string): OpenLoopRow[] {
  const ids = db
    .prepare<[string], { loop_id: string }>(
      "SELECT DISTINCT loop_id FROM open_loop_docs WHERE doc_id = ?",
    )
    .all(docId)
    .map((r) => r.loop_id);
  const loops: OpenLoopRow[] = [];
  for (const id of ids) {
    const loop = getOpenLoop(db, id);
    if (loop && (loop.state === "open" || loop.state === "snoozed")) loops.push(loop);
  }
  return loops;
}

/**
 * Active (open | snoozed) loops that name `personId` as an actor or involved —
 * "which tracked obligations concern this person". The person-keyed sibling of
 * {@link listLoopsForDoc}, read via the sparse agent-curated `open_loop_people`
 * join (never `document_people`), so it stays bounded even for a hub person.
 * Ordered most-recently-updated first.
 *
 * `personId` should be a canonical id (`resolvePersonId`'d by the caller); the
 * query expands it to its full merge equivalence class, because a *logical*
 * merge (`merged_into`) does not re-key `open_loop_people` — a loop authored
 * against a now-merged-away id would otherwise silently vanish from the
 * canonical's lookup. The seed's own rows are always kept (so a person id with
 * no `people` row still resolves); one hop adds people that merged directly
 * into it — deep loser→loser chains rely on the transitive-collapse task
 * having flattened `merged_into`.
 */
export function listLoopsForPerson(db: Db, personId: string): OpenLoopRow[] {
  const ids = db
    .prepare<[string, string], { loop_id: string }>(
      `SELECT DISTINCT loop_id FROM open_loop_people
        WHERE person_id = ? OR person_id IN (SELECT id FROM people WHERE merged_into = ?)`,
    )
    .all(personId, personId)
    .map((r) => r.loop_id);
  const loops: OpenLoopRow[] = [];
  for (const id of ids) {
    const loop = getOpenLoop(db, id);
    if (loop && (loop.state === "open" || loop.state === "snoozed")) loops.push(loop);
  }
  loops.sort((a, b) => b.lastUpdate - a.lastUpdate || a.id.localeCompare(b.id));
  return loops;
}

/**
 * Active (open | snoozed) loops the Cognition Steward grouped with `loopId` onto a
 * shared feed card that is *still live* — a curated "related work" cluster.
 * The grouping is only honored through a brief that would still (re)appear on
 * the feed ({@link findActiveBriefsForLoops}); a dismissed or expired card no
 * longer relates its loops. Bounded (a brief relates few loops), excludes the
 * loop itself, most-recently-updated first. `now` scopes brief relevance.
 */
export function listRelatedLoops(db: Db, loopId: string, now: number): OpenLoopRow[] {
  const briefIds = findActiveBriefsForLoops(db, [loopId], now).map((b) => b.id);
  if (briefIds.length === 0) return [];
  const placeholders = briefIds.map(() => "?").join(",");
  const ids = db
    .prepare<[...string[], string], { loop_id: string }>(
      `SELECT DISTINCT loop_id FROM brief_related_loops
        WHERE brief_id IN (${placeholders}) AND loop_id != ?`,
    )
    .all(...briefIds, loopId)
    .map((r) => r.loop_id);
  const loops: OpenLoopRow[] = [];
  for (const id of ids) {
    const loop = getOpenLoop(db, id);
    if (loop && (loop.state === "open" || loop.state === "snoozed")) loops.push(loop);
  }
  loops.sort((a, b) => b.lastUpdate - a.lastUpdate || a.id.localeCompare(b.id));
  return loops;
}

export interface ListOpenLoopsOptions {
  states?: readonly OpenLoopState[];
  limit?: number;
  /** Exclusive keyset for the default recency order. */
  beforeLastUpdate?: { lastUpdate: number; id: string };
  /** Exclusive keyset for the complete importance order. */
  afterImportance?: { importance: number; lastUpdate: number; id: string };
  /**
   * Row ordering. `"recency"` (default, unchanged for existing callers) is
   * most-recently-updated first. `"importance"` is highest-importance first
   * (recency as tiebreaker) — the right sort for a *capped* enumeration, so a
   * low-importance loop is what gets dropped at the limit, never a stale-but-
   * important one.
   */
  orderBy?: "recency" | "importance";
}

const ACTIVE_LOOP_PAGE_STATES: readonly OpenLoopState[] = ["open", "snoozed"];
const RESOLVED_LOOP_PAGE_STATES: readonly OpenLoopState[] = ["done", "dismissed"];

function hasExactlyStates<T extends string>(actual: readonly T[], expected: readonly T[]): boolean {
  return actual.length === expected.length && expected.every((state) => actual.includes(state));
}

/** Escape SQL LIKE metacharacters in a literal token (`ESCAPE '\'`). */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Fresh, tables-as-truth lexical match over open loops — the reconcile
 * overlay `open_loop_search` merges ahead of pipeline results. The search
 * pipeline reads index.db through a snapshot that advances on a coarse
 * cadence, and chunk/embedding writes land asynchronously — so a loop
 * created or updated moments ago (typically by the immediately preceding
 * run) can be invisible to it. Reconcile-before-create must never miss
 * those loops; this overlay reads the authoritative tables directly.
 *
 * Matching is deliberately simple: case-insensitive substring match of any
 * query token (length >= 3, first 8 tokens) against title + description.
 * Ranking is by the NUMBER of distinct query tokens matched (desc), then
 * most-recently-updated: the loop hitting several query tokens (typically
 * the one carrying the query's reference marker) must not be crowded out of
 * the limit by more-recent single-generic-token matches — an old, buried
 * loop is exactly the one a late resolution datum needs to find.
 * Over-matching is acceptable — the agent inspects the candidates; missing
 * a fresh loop is not.
 */
export function searchOpenLoopsLexical(
  db: Db,
  query: string,
  options: { limit?: number } = {},
): OpenLoopRow[] {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}#@_-]+/u)
    .filter((t) => t.length >= 3)
    .slice(0, 8);
  if (tokens.length === 0) return [];
  const tokenCase = tokens
    .map(
      () =>
        `(CASE WHEN LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(description) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`,
    )
    .join(" + ");
  const params: (string | number)[] = [];
  for (const token of tokens) {
    const pattern = `%${escapeLike(token)}%`;
    params.push(pattern, pattern);
  }
  params.push(options.limit ?? 8);
  const rows = db
    .prepare<(string | number)[], OpenLoopDbRow>(
      `SELECT * FROM (SELECT *, (${tokenCase}) AS matched_tokens FROM open_loops)
        WHERE matched_tokens > 0
        ORDER BY matched_tokens DESC, last_update DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => rowToOpenLoop(r, loopDocs(db, r.id)));
}

/** Loops ordered by most-recently-updated first. */
export function listOpenLoops(db: Db, options: ListOpenLoopsOptions = {}): OpenLoopRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const importanceOrder = options.orderBy === "importance";
  let pageIndex = importanceOrder ? "idx_open_loops_importance_page" : "idx_open_loops_update_page";
  if (options.states && options.states.length > 0) {
    if (hasExactlyStates(options.states, ACTIVE_LOOP_PAGE_STATES)) {
      // Literal predicates match the active/resolved partial order indexes.
      conditions.push("state IN ('open', 'snoozed')");
      pageIndex = importanceOrder
        ? "idx_open_loops_active_importance_page"
        : "idx_open_loops_active_update_page";
    } else if (hasExactlyStates(options.states, RESOLVED_LOOP_PAGE_STATES)) {
      conditions.push("state IN ('done', 'dismissed')");
      pageIndex = importanceOrder
        ? "idx_open_loops_resolved_importance_page"
        : "idx_open_loops_resolved_update_page";
    } else if (options.states.length === 1) {
      conditions.push("state = ?");
      params.push(options.states[0]);
      pageIndex = importanceOrder
        ? "idx_open_loops_state_importance_page"
        : "idx_open_loops_state_update";
    } else {
      conditions.push(`state IN (${options.states.map(() => "?").join(", ")})`);
      params.push(...options.states);
    }
  }
  if (options.beforeLastUpdate) {
    conditions.push("(last_update, id) < (?, ?)");
    params.push(options.beforeLastUpdate.lastUpdate, options.beforeLastUpdate.id);
  }
  if (options.afterImportance) {
    conditions.push("(importance, last_update, id) < (?, ?, ?)");
    params.push(
      options.afterImportance.importance,
      options.afterImportance.lastUpdate,
      options.afterImportance.id,
    );
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderBy = importanceOrder
    ? "importance DESC, last_update DESC, id DESC"
    : "last_update DESC, id DESC";
  params.push(options.limit ?? 100);
  const rows = db
    .prepare<(string | number)[], OpenLoopDbRow>(
      `SELECT * FROM open_loops INDEXED BY ${pageIndex} ${where}
       ORDER BY ${orderBy} LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => rowToOpenLoop(r, loopDocs(db, r.id)));
}

/**
 * Fields the agent may mutate on an existing loop. Absent = unchanged.
 * `deadline: null` clears the deadline (distinguished from absent).
 *
 * `lastDecayCheck` records a decay status-check KEEP verdict. It has a
 * side effect on the decay back-off counter: an update carrying it
 * increments `decay_check_count` (one more unreinforced check — the
 * back-off doubles), while any update WITHOUT it counts as reinforcement
 * and resets the counter to 0 (the next check comes after the base
 * delay again).
 */
export interface UpdateOpenLoopInput {
  state?: OpenLoopState;
  confidence?: number;
  importance?: number;
  title?: string;
  description?: string;
  deadline?: unknown | null;
  actors?: string[];
  involved?: string[];
  docs?: string[];
  blockedBy?: string[];
  lastDecayCheck?: number;
}

/**
 * Partial update. Always bumps `last_update` to `now` (the engine-owned
 * "the agent touched this loop" signal). Returns the updated row, or
 * null when the loop doesn't exist.
 */
/**
 * Rewrite ONLY a loop's person refs (`actors[]`/`involved[]` + the
 * `open_loop_people` join) — the person-ref normalization sweep's write.
 * Deliberately does NOT bump `last_update` or touch the decay bookkeeping:
 * this is data hygiene, not agent activity, and must not look like the
 * loop was touched. Returns false when the loop doesn't exist.
 */
export function rewriteOpenLoopPeople(
  db: Db,
  id: string,
  actors: readonly string[],
  involved: readonly string[],
): boolean {
  const res = db
    .prepare<
      [string, string, string]
    >("UPDATE open_loops SET actors_json = ?, involved_json = ? WHERE id = ?")
    .run(JSON.stringify(actors), JSON.stringify(involved), id);
  if (res.changes === 0) return false;
  replaceLoopPeople(db, id, actors, involved);
  return true;
}

export function updateOpenLoop(
  db: Db,
  id: string,
  input: UpdateOpenLoopInput,
  now: number,
): OpenLoopRow | null {
  const existing = db
    .prepare<[string], OpenLoopDbRow>("SELECT * FROM open_loops WHERE id = ?")
    .get(id);
  if (!existing) return null;

  // Consolidation trace on resolve: an open loop moving to a resolved state
  // (`done`/`dismissed`) is recorded in the append-only store BEFORE the
  // UPDATE, so the trace reflects the loop's pre-resolution state. A plain
  // open→open field update, or any transition out of a non-open state, does
  // not retire.
  if (existing.state === "open" && (input.state === "done" || input.state === "dismissed")) {
    retireLoop(db, rowToOpenLoop(existing, loopDocs(db, id)), input.state, now);
  }

  const sets: string[] = ["last_update = ?"];
  const params: (string | number | null)[] = [now];
  // Decay back-off bookkeeping — see the UpdateOpenLoopInput doc.
  sets.push(
    input.lastDecayCheck !== undefined
      ? "decay_check_count = decay_check_count + 1"
      : "decay_check_count = 0",
  );
  const push = (column: string, value: string | number | null) => {
    sets.push(`${column} = ?`);
    params.push(value);
  };
  if (input.state !== undefined) push("state", input.state);
  if (input.confidence !== undefined) push("confidence", input.confidence);
  if (input.importance !== undefined) push("importance", input.importance);
  if (input.title !== undefined) push("title", input.title);
  if (input.description !== undefined) push("description", input.description);
  if (input.deadline !== undefined)
    push("deadline_json", input.deadline === null ? null : JSON.stringify(input.deadline));
  if (input.actors !== undefined) push("actors_json", JSON.stringify(input.actors));
  if (input.involved !== undefined) push("involved_json", JSON.stringify(input.involved));
  if (input.blockedBy !== undefined) push("blocked_by_json", JSON.stringify(input.blockedBy));
  if (input.lastDecayCheck !== undefined) push("last_decay_check", input.lastDecayCheck);

  params.push(id);
  db.prepare<(string | number | null)[]>(
    `UPDATE open_loops SET ${sets.join(", ")} WHERE id = ?`,
  ).run(...params);
  if (input.docs !== undefined) replaceLoopDocs(db, id, input.docs);
  // Keep the people join table in step with actors/involved. Rewrite the
  // whole (loop, *) set from the loop's EFFECTIVE people so a partial update
  // — e.g. actors-only — never wipes the untouched role: an absent list
  // re-derives from the pre-update row (which the UPDATE above left intact).
  if (input.actors !== undefined || input.involved !== undefined) {
    const effectiveActors = input.actors ?? (JSON.parse(existing.actors_json) as string[]);
    const effectiveInvolved = input.involved ?? (JSON.parse(existing.involved_json) as string[]);
    replaceLoopPeople(db, id, effectiveActors, effectiveInvolved);
  }
  bumpCognitionDecayDirty(db);
  return getOpenLoop(db, id);
}

/**
 * Append a ledger entry (stamped with the appending run's id) and bump
 * the loop's `last_update`.
 */
export function appendOpenLoopLedger(
  db: Db,
  loopId: string,
  entry: { runId: string; note: string },
  now: number,
): void {
  db.prepare<[string, string, number, string]>(
    "INSERT INTO open_loop_ledger (loop_id, run_id, at, note) VALUES (?, ?, ?, ?)",
  ).run(loopId, entry.runId, now, entry.note);
  // A ledger append bumps `last_update` (the loop was touched) but must NOT
  // reset the decay back-off counter. A decay-check KEEP records its
  // investigation notes through this path before stamping the verdict with
  // `open_loop_update({ decayCheckPassed })`; resetting on the note would
  // cancel that increment and pin the back-off at its base forever. Only
  // genuine reinforcement — a substantive `open_loop_update` carrying new
  // external data (no `decayCheckPassed`) — resets `decay_check_count`.
  db.prepare<[number, string]>("UPDATE open_loops SET last_update = ? WHERE id = ?").run(
    now,
    loopId,
  );
  bumpCognitionDecayDirty(db);
}

/** Ledger entries oldest → newest. */
export function listOpenLoopLedger(
  db: Db,
  loopId: string,
  options: { limit?: number; beforeSeq?: number; order?: "asc" | "desc" } = {},
): OpenLoopLedgerEntry[] {
  const order = options.order === "desc" ? "DESC" : "ASC";
  const comparator = order === "DESC" ? "<" : ">";
  const cursor = options.beforeSeq === undefined ? "" : `AND seq ${comparator} ?`;
  const params: Array<string | number> = [loopId];
  if (options.beforeSeq !== undefined) params.push(options.beforeSeq);
  const limit = options.limit === undefined ? "" : "LIMIT ?";
  if (options.limit !== undefined) params.push(options.limit);
  return db
    .prepare<
      (string | number)[],
      { seq: number; loop_id: string; run_id: string; at: number; note: string }
    >(
      `SELECT * FROM open_loop_ledger
        WHERE loop_id = ? ${cursor}
        ORDER BY seq ${order} ${limit}`,
    )
    .all(...params)
    .map((r) => ({ seq: r.seq, loopId: r.loop_id, runId: r.run_id, at: r.at, note: r.note }));
}

export interface DeleteOpenLoopResult {
  /** False when the loop didn't exist. */
  deleted: boolean;
  /** Ids of attached non-terminal briefs deleted by the invariant. */
  deletedBriefIds: string[];
}

/**
 * Options for {@link deleteOpenLoop}.
 *
 * `retire` records a consolidation trace before the delete — the write-gated
 * `open_loop_delete` path sets it so an agent-issued delete leaves a
 * recurrence trace; direct/internal deletes (and the privacy cascade, which
 * has its own path) do not. `now` (unix ms) timestamps that trace; a retiring
 * caller passes its cognition clock, so the trace — and the cadence arithmetic
 * keyed off `retired_at` — holds under an injected clock. The wall-clock
 * default exists for the trace-free internal paths only.
 */
export interface DeleteOpenLoopOptions {
  retire?: boolean;
  now?: number;
}

/**
 * Delete a loop, enforcing the deletion invariant: attached non-terminal
 * briefs are deleted with it; terminal-dismissed briefs survive with the
 * edge removed. Ledger and doc-edge rows go via FK cascade.
 *
 * With `{ retire: true }`, a consolidation trace is appended BEFORE the
 * delete — `decayed` when the decay engine had been checking the loop
 * (`decay_check_count > 0`), otherwise `deleted` — so the row still exists to
 * snapshot.
 *
 * The loop's mirrored corpus document is NOT touched here (this module
 * never crosses into `documents`); callers delete it by external id —
 * see `open-loop-source/`.
 */
export function deleteOpenLoop(
  db: Db,
  id: string,
  opts: DeleteOpenLoopOptions = {},
): DeleteOpenLoopResult {
  const existing = db
    .prepare<[string], OpenLoopDbRow>("SELECT * FROM open_loops WHERE id = ?")
    .get(id);
  if (!existing) return { deleted: false, deletedBriefIds: [] };
  if (opts.retire) {
    const outcome = existing.decay_check_count > 0 ? "decayed" : "deleted";
    retireLoop(db, rowToOpenLoop(existing, loopDocs(db, id)), outcome, opts.now ?? Date.now());
  }
  const deletedBriefIds = deleteBriefsAttachedToLoops(db, [id], { includeTerminal: false });
  db.prepare<[string]>("DELETE FROM open_loops WHERE id = ?").run(id);
  bumpCognitionDecayDirty(db);
  return { deleted: true, deletedBriefIds };
}

export interface OpenLoopPrivacyCascadeResult {
  /** Loops deleted because their docs[] contained a deleted document. */
  deletedLoopIds: string[];
  /** Briefs deleted (cited a deleted document, or attached to a deleted loop). */
  deletedBriefIds: string[];
}

/**
 * Privacy-delete cascade. Given the internal ids of privacy-deleted
 * corpus documents, deletes every derived loop and brief. The caller
 * must then delete the cascaded loops' mirrored corpus documents (the
 * returned `deletedLoopIds` are their external ids) and cascade the
 * search index for them.
 *
 * All-states deletion here (terminal briefs included): a privacy delete
 * is about purging derived content, not feed behavior.
 *
 * **Privacy invariant:** this path NEVER writes a `retired_loops`
 * consolidation trace. A retirement trace snapshots the loop's title and
 * description — derived content a privacy delete exists to purge — so leaving
 * one behind would leak exactly what was deleted. The direct `DELETE` below
 * (never `deleteOpenLoop`, which can retire) keeps that guarantee structural.
 */
/**
 * Whether any open loop exists — the cheap guard the delete cascade reads so
 * an install that never enabled the Brain pays nothing for the check.
 */
export function hasAnyOpenLoops(db: Db): boolean {
  return (
    db.prepare<[], { one: number }>("SELECT 1 AS one FROM open_loops LIMIT 1").get() !== undefined
  );
}

/** Loop identities remain readable until the loop cascade commits. */
export function listLoopIdsCitingDocs(db: Db, documentIds: readonly string[]): string[] {
  if (documentIds.length === 0) return [];
  return db
    .prepare<[string], { loop_id: string }>(
      `SELECT DISTINCT loop_id FROM open_loop_docs
       WHERE doc_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(documentIds))
    .map((row) => row.loop_id);
}

export function cascadeOpenLoopPrivacyDelete(
  db: Db,
  deletedDocIds: readonly string[],
  knownLoopIds?: readonly string[],
): OpenLoopPrivacyCascadeResult {
  if (deletedDocIds.length === 0) return { deletedLoopIds: [], deletedBriefIds: [] };

  const placeholders = deletedDocIds.map(() => "?").join(", ");
  const loopIds = knownLoopIds ? [...knownLoopIds] : listLoopIdsCitingDocs(db, deletedDocIds);

  const briefIdSet = new Set<string>();
  // Briefs directly citing a deleted document.
  for (const r of db
    .prepare<
      string[],
      { brief_id: string }
    >(`SELECT DISTINCT brief_id FROM brief_citations WHERE doc_id IN (${placeholders})`)
    .all(...deletedDocIds)) {
    briefIdSet.add(r.brief_id);
  }
  // Briefs attached to a cascaded loop (terminal included).
  if (loopIds.length > 0) {
    for (const id of deleteBriefsAttachedToLoops(db, loopIds, { includeTerminal: true })) {
      briefIdSet.add(id);
    }
  }
  // Delete the directly-citing briefs (the attached ones are already gone).
  for (const briefId of briefIdSet) {
    db.prepare<[string]>("DELETE FROM briefs WHERE id = ?").run(briefId);
  }
  if (loopIds.length > 0) {
    const loopPlaceholders = loopIds.map(() => "?").join(", ");
    db.prepare<string[]>(`DELETE FROM open_loops WHERE id IN (${loopPlaceholders})`).run(
      ...loopIds,
    );
    bumpCognitionDecayDirty(db);
  }
  return { deletedLoopIds: loopIds, deletedBriefIds: [...briefIdSet] };
}

/**
 * The decay engine's scan: every `open` loop with the fields its
 * scheduling computation needs. Snoozed / done / dismissed loops are
 * deliberately excluded — decay exists to retire loops going stale
 * without the user's attention; a non-open state was itself a deliberate
 * verdict.
 */
export interface DecayCandidateLoop {
  id: string;
  lastUpdate: number;
  lastDecayCheck: number | null;
  decayCheckCount: number;
  /** 0-1 user-importance the agent assigned; stretches the decay curve. */
  importance: number;
  /** Agent-owned opaque deadline structure (or null) — dated vs undated split. */
  deadline: unknown | null;
}

export function listDecayCandidateLoops(db: Db): DecayCandidateLoop[] {
  return db
    .prepare<
      [],
      {
        id: string;
        last_update: number;
        last_decay_check: number | null;
        decay_check_count: number;
        importance: number;
        deadline_json: string | null;
      }
    >(
      `SELECT id, last_update, last_decay_check, decay_check_count, importance, deadline_json
       FROM open_loops WHERE state = 'open' ORDER BY last_update ASC`,
    )
    .all()
    .map((r) => ({
      id: r.id,
      lastUpdate: r.last_update,
      lastDecayCheck: r.last_decay_check,
      decayCheckCount: r.decay_check_count,
      importance: r.importance,
      deadline: r.deadline_json === null ? null : (JSON.parse(r.deadline_json) as unknown),
    }));
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The note agent's durable queue: one row per Tell Omnesis note it reads.
 *
 * Notes the owner's own clients capture after the note agent first ran are
 * queued as they appear; a note from an external agent or the browser
 * extension is never read, so a notes-only grant cannot change tasks or
 * memory through it. Earlier notes are not processed retroactively, and notes
 * captured while the owner has the note agent switched off are settled as
 * skipped, so switching it back on never acts on them. A row
 * waits until its note has settled (no edits for a short while, its voice transcript in),
 * runs once, and keeps the receipt the user sees under the note. Deleting a
 * note deletes its row.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

export type NoteAgentState = "pending" | "running" | "done" | "failed" | "skipped";

/** What the note agent did with one note, shown under it. */
export interface NoteAgentReceipt {
  /** One or two sentences: what was done, or why nothing was. */
  text: string;
  /** Task changes made, each undoable by its ledger sequence. */
  changes: Array<{ text: string; taskId: string | null; undoSeq: number | null }>;
}

export interface NoteAgentRow {
  entryId: string;
  state: NoteAgentState;
  attempts: number;
  runAfter: number;
  receipt: NoteAgentReceipt | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export function createNoteAgentTables(db: Db): void {
  const noteColumns = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('note_entries')")
    .all()
    .map((c) => c.name);
  if (noteColumns.length > 0 && !noteColumns.includes("from_owner"))
    db.exec("ALTER TABLE note_entries ADD COLUMN from_owner INTEGER NOT NULL DEFAULT 0");
  if (noteColumns.length > 0)
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_note_entries_owner_received ON note_entries(received_at) WHERE from_owner = 1",
    );
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_agent_runs (
      entry_id TEXT PRIMARY KEY REFERENCES note_entries(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'running', 'done', 'failed', 'skipped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      run_after INTEGER NOT NULL,
      receipt_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_note_agent_runs_due
      ON note_agent_runs(run_after) WHERE state = 'pending';
    CREATE INDEX IF NOT EXISTS idx_note_agent_runs_running
      ON note_agent_runs(updated_at) WHERE state = 'running';
    CREATE TABLE IF NOT EXISTS note_agent_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

interface DbRow {
  entry_id: string;
  state: string;
  attempts: number;
  run_after: number;
  receipt_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function toRow(r: DbRow): NoteAgentRow {
  return {
    entryId: r.entry_id,
    state: r.state as NoteAgentState,
    attempts: r.attempts,
    runAfter: r.run_after,
    receipt: r.receipt_json ? (JSON.parse(r.receipt_json) as NoteAgentReceipt) : null,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** How long a note must be left alone before the agent reads it. */
export const NOTE_SETTLE_MS = 10_000;
/** How long the agent waits for a voice note's transcript before reading what it has. */
export const NOTE_TRANSCRIPT_WAIT_MS = 30 * 60_000;
/** A run claimed this long ago without finishing is presumed lost and retried. */
export const NOTE_RUN_STALE_MS = 15 * 60_000;
export const NOTE_AGENT_MAX_ATTEMPTS = 3;

/**
 * Queue the owner's notes received since the last scan that have no row yet,
 * and return the number queued. The first call records the start; each call
 * advances a high-water mark over `received_at`, so a scan reads only the
 * notes that arrived since the previous one.
 */
export function enqueueNewNotes(db: Db, now: number): number {
  return scanNewNotes(db, now, "pending");
}

/**
 * Settle the owner's notes received since the last scan as skipped, and
 * return how many: what is told while the note agent is switched off is
 * never read, even once it is switched back on. Before the note agent first
 * ran there is no scan to continue, and nothing is recorded.
 */
export function skipNewNotes(db: Db, now: number): number {
  return scanNewNotes(db, now, "skipped");
}

function scanNewNotes(db: Db, now: number, state: "pending" | "skipped"): number {
  return db.transaction(() => {
    if (state === "pending")
      db.prepare<[string]>(
        "INSERT OR IGNORE INTO note_agent_meta (key, value) VALUES ('scanned', ?)",
      ).run(new Date(now).toISOString());
    const scanned = db
      .prepare<[], { value: string }>("SELECT value FROM note_agent_meta WHERE key = 'scanned'")
      .get()?.value;
    if (scanned === undefined) return 0;
    const res = db
      .prepare<[string, number, number, number, string]>(
        `INSERT OR IGNORE INTO note_agent_runs (entry_id, state, run_after, created_at, updated_at)
         SELECT n.id, ?, ?, ?, ?
           FROM note_entries n
          WHERE n.from_owner = 1 AND n.received_at >= ?
            AND NOT EXISTS (SELECT 1 FROM note_agent_runs r WHERE r.entry_id = n.id)`,
      )
      .run(state, now, now, now, scanned);
    const latest = db
      .prepare<
        [string],
        { latest: string | null }
      >("SELECT MAX(received_at) AS latest FROM note_entries WHERE from_owner = 1 AND received_at >= ?")
      .get(scanned)?.latest;
    if (latest && latest > scanned)
      db.prepare<[string]>("UPDATE note_agent_meta SET value = ? WHERE key = 'scanned'").run(
        latest,
      );
    return res.changes;
  })();
}

/**
 * Claim the next due note: pending, past its wait, settled, and not waiting
 * on a voice transcript (unless it has waited long enough). A run whose
 * claim went stale is reclaimed. Returns null when nothing is due.
 */
export function claimDueNote(db: Db, now: number): NoteAgentRow | null {
  return db.transaction(() => {
    // A claim that went stale is retried, unless it has used its attempts: a
    // note whose turn keeps dying must not be retried forever.
    db.prepare<[number, number, number, number]>(
      `UPDATE note_agent_runs
          SET state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
              error = CASE WHEN attempts >= ? THEN 'the turn did not finish' ELSE error END,
              updated_at = ?
        WHERE state = 'running' AND updated_at < ?`,
    ).run(NOTE_AGENT_MAX_ATTEMPTS, NOTE_AGENT_MAX_ATTEMPTS, now, now - NOTE_RUN_STALE_MS);
    const settledBefore = new Date(now - NOTE_SETTLE_MS).toISOString();
    const transcriptGiveUp = now - NOTE_TRANSCRIPT_WAIT_MS;
    const row = db
      .prepare<[number, string, number], DbRow>(
        `SELECT r.* FROM note_agent_runs r
           JOIN note_entries n ON n.id = r.entry_id
          WHERE r.state = 'pending' AND r.run_after <= ?
            AND n.updated_at <= ?
            AND (r.created_at <= ? OR NOT EXISTS
                 (SELECT 1 FROM voice_note_transcriptions v WHERE v.note_id = n.id))
          ORDER BY r.run_after ASC LIMIT 1`,
      )
      .get(now, settledBefore, transcriptGiveUp);
    if (!row) return null;
    db.prepare<[number, string]>(
      `UPDATE note_agent_runs SET state = 'running', attempts = attempts + 1, updated_at = ?
        WHERE entry_id = ?`,
    ).run(now, row.entry_id);
    return toRow({ ...row, state: "running", attempts: row.attempts + 1, updated_at: now });
  })();
}

/**
 * Record a run's outcome. A failure under the attempt cap goes back to
 * pending. Only the claim that is still current may finish: a turn whose
 * claim went stale and was reclaimed records nothing.
 */
export function finishNoteRun(
  db: Db,
  entryId: string,
  attempt: number,
  outcome:
    | { state: "done" | "skipped"; receipt: NoteAgentReceipt }
    | { state: "failed"; error: string; retryAt: number },
  now: number,
): void {
  if (outcome.state === "failed") {
    db.prepare<[number, string, number, number, string, number]>(
      `UPDATE note_agent_runs
          SET state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
              error = ?, run_after = ?, updated_at = ?
        WHERE entry_id = ? AND state = 'running' AND attempts = ?`,
    ).run(NOTE_AGENT_MAX_ATTEMPTS, outcome.error, outcome.retryAt, now, entryId, attempt);
    return;
  }
  db.prepare<[string, string, number, string, number]>(
    `UPDATE note_agent_runs SET state = ?, receipt_json = ?, error = NULL, updated_at = ?
      WHERE entry_id = ? AND state = 'running' AND attempts = ?`,
  ).run(outcome.state, JSON.stringify(outcome.receipt), now, entryId, attempt);
}

export function getNoteRuns(db: Db, entryIds: readonly string[]): Map<string, NoteAgentRow> {
  if (entryIds.length === 0) return new Map();
  const rows = db
    .prepare<
      string[],
      DbRow
    >(`SELECT * FROM note_agent_runs WHERE entry_id IN (${entryIds.map(() => "?").join(", ")})`)
    .all(...entryIds);
  return new Map(rows.map((r) => [r.entry_id, toRow(r)]));
}

/** True while any note is queued or running. */
export function hasPendingNotes(db: Db): boolean {
  return (
    db
      .prepare<
        [],
        { one: number }
      >("SELECT 1 AS one FROM note_agent_runs WHERE state IN ('pending', 'running') LIMIT 1")
      .get() !== undefined
  );
}

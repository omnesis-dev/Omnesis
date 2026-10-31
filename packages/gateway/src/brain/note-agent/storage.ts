// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The note agent's durable queue: one durable row per admitted revision of an owner note.
 *
 * Notes the owner's own clients capture after the note agent first ran are
 * queued as they appear; a note from an external agent or the browser
 * extension is never read, so a notes-only grant cannot change tasks or
 * memory through it. Earlier notes are not processed retroactively, and a
 * note captured while the owner has the note agent switched off is settled as
 * skipped with its capture, so switching it back on never acts on it. A row
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
  revision: number;
  inputText: string;
  previousText: string | null;
  previousReceipt: NoteAgentReceipt | null;
  priorUncertain: boolean;
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
  const legacy = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('note_agent_runs')")
    .all();
  if (legacy.length && !legacy.some((column) => column.name === "revision"))
    db.exec("ALTER TABLE note_agent_runs RENAME TO note_agent_runs_legacy");
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_agent_runs (
      entry_id TEXT NOT NULL REFERENCES note_entries(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0,
      input_text TEXT NOT NULL,
      previous_text TEXT,
      previous_receipt_json TEXT,
      prior_uncertain INTEGER NOT NULL DEFAULT 0,
      revision_attempts INTEGER NOT NULL DEFAULT 0,
      pending_mutations INTEGER NOT NULL DEFAULT 0,
      applied_mutations INTEGER NOT NULL DEFAULT 0,
      uncertain_mutations INTEGER NOT NULL DEFAULT 0,
      baseline INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'running', 'done', 'failed', 'skipped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      run_after INTEGER NOT NULL,
      receipt_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(entry_id, revision)
    );
    CREATE TABLE IF NOT EXISTS note_agent_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  if (legacy.length && !legacy.some((column) => column.name === "revision")) {
    db.exec(`INSERT INTO note_agent_runs(entry_id,revision,input_text,state,attempts,revision_attempts,run_after,receipt_json,error,created_at,updated_at,baseline,uncertain_mutations)
      SELECT r.entry_id,0,n.text,CASE WHEN r.state='running' THEN 'done' ELSE r.state END,r.attempts,r.attempts,r.run_after,
        CASE WHEN r.state='running' THEN '{"text":"An earlier action may have been applied or may still be running. Review its result before making a fresh separate request.","changes":[]}' ELSE r.receipt_json END,
        r.error,r.created_at,r.updated_at,CASE WHEN r.state IN ('done','skipped','running') THEN 1 ELSE 0 END,
        CASE WHEN r.state='running' OR
          json_extract(r.receipt_json,'$.text') LIKE 'An action may have been applied.%' OR
          json_extract(r.receipt_json,'$.text') LIKE 'An action is still running%'
          THEN 1 ELSE 0 END
      FROM note_agent_runs_legacy r JOIN note_entries n ON n.id=r.entry_id;
      DROP TABLE note_agent_runs_legacy;`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_note_agent_runs_due ON note_agent_runs(run_after) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS idx_note_agent_runs_running ON note_agent_runs(updated_at) WHERE state='running';`);
}

interface DbRow {
  entry_id: string;
  revision: number;
  input_text: string;
  previous_text: string | null;
  previous_receipt_json: string | null;
  prior_uncertain: number;
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
    revision: r.revision,
    inputText: r.input_text,
    previousText: r.previous_text,
    previousReceipt: r.previous_receipt_json
      ? (JSON.parse(r.previous_receipt_json) as NoteAgentReceipt)
      : null,
    priorUncertain: r.prior_uncertain === 1,
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
 * Settle a note as skipped as it is captured, in the capture's transaction:
 * the owner has the note agent switched off, so it is never read, however
 * soon the agent is switched back on and whether or not a scan saw it off.
 */
export function skipNoteAtCapture(db: Db, entryId: string, now: number): void {
  db.prepare<[number, number, number, string]>(
    `INSERT OR IGNORE INTO note_agent_runs (entry_id, input_text, state, run_after, created_at, updated_at,baseline)
     SELECT id,text,'skipped',?,?,?,1 FROM note_entries WHERE id=?`,
  ).run(now, now, now, entryId);
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
      .prepare<[string, number, number, number, string, string]>(
        `INSERT OR IGNORE INTO note_agent_runs (entry_id, input_text, state, run_after, created_at, updated_at,baseline)
         SELECT n.id,n.text, ?, ?, ?, ?, CASE WHEN ?='skipped' THEN 1 ELSE 0 END
           FROM note_entries n
          WHERE n.from_owner = 1 AND n.received_at >= ?
            AND NOT EXISTS (SELECT 1 FROM note_agent_runs r WHERE r.entry_id = n.id)`,
      )
      .run(state, now, now, now, state, scanned);
    const latest = db
      .prepare<[string], { latest: string | null }>(
        "SELECT MAX(received_at) AS latest FROM note_entries WHERE from_owner = 1 AND received_at >= ?",
      )
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
    // A crash after mutation admission is not proof of rollback. Preserve that
    // uncertain outcome and never replay it, including through a later edit.
    db.prepare(
      `UPDATE note_agent_runs SET state='done',baseline=1,uncertain_mutations=1,
      receipt_json='{"text":"An earlier action may have been applied or may still be running. Review its result before making a fresh separate request.","changes":[]}',updated_at=?
      WHERE state='running' AND updated_at<? AND (pending_mutations>0 OR applied_mutations>0 OR uncertain_mutations>0)`,
    ).run(now, now - NOTE_RUN_STALE_MS);
    db.prepare(
      `UPDATE note_agent_runs SET state=CASE WHEN revision_attempts>=? THEN 'failed' ELSE 'pending' END,
      error=CASE WHEN revision_attempts>=? THEN 'the turn did not finish' ELSE error END,updated_at=?
      WHERE state='running' AND updated_at<?`,
    ).run(NOTE_AGENT_MAX_ATTEMPTS, NOTE_AGENT_MAX_ATTEMPTS, now, now - NOTE_RUN_STALE_MS);
    db.prepare(
      "UPDATE note_agent_runs SET state='skipped',baseline=0 WHERE state='pending' AND EXISTS(SELECT 1 FROM note_agent_runs newer WHERE newer.entry_id=note_agent_runs.entry_id AND newer.revision>note_agent_runs.revision)",
    ).run();
    const settledBefore = new Date(now - NOTE_SETTLE_MS).toISOString();
    const transcriptGiveUp = now - NOTE_TRANSCRIPT_WAIT_MS;
    const row = db
      .prepare<[number, string, string, number, number], DbRow>(
        `SELECT r.* FROM note_agent_runs r
           JOIN note_entries n ON n.id = r.entry_id
          WHERE r.state = 'pending' AND r.run_after <= ?
            AND NOT EXISTS (SELECT 1 FROM note_agent_runs busy WHERE busy.entry_id=r.entry_id AND busy.state='running')
            AND NOT EXISTS (SELECT 1 FROM note_agent_runs newer WHERE newer.entry_id=r.entry_id AND newer.revision>r.revision)
            AND (n.updated_at<=? OR (n.updated_at>? AND r.created_at<=?))
            AND (r.created_at <= ? OR NOT EXISTS
                 (SELECT 1 FROM voice_note_transcriptions v WHERE v.note_id = n.id))
          ORDER BY r.run_after ASC LIMIT 1`,
      )
      .get(now, settledBefore, new Date(now).toISOString(), now - NOTE_SETTLE_MS, transcriptGiveUp);
    if (!row) return null;
    const previous = db
      .prepare<[string, number], { input_text: string; receipt_json: string | null }>(
        "SELECT input_text,receipt_json FROM note_agent_runs WHERE entry_id=? AND revision<? AND baseline=1 ORDER BY revision DESC LIMIT 1",
      )
      .get(row.entry_id, row.revision);
    const priorUncertain = !!db
      .prepare(
        "SELECT 1 FROM note_agent_runs WHERE entry_id=? AND revision<? AND (uncertain_mutations>0 OR pending_mutations>0) LIMIT 1",
      )
      .get(row.entry_id, row.revision);
    const attempt = db
      .prepare<[string], { n: number }>(
        "SELECT MAX(attempts)+1 AS n FROM note_agent_runs WHERE entry_id=?",
      )
      .get(row.entry_id)!.n;
    db.prepare(
      `UPDATE note_agent_runs SET state='running',attempts=?,revision_attempts=revision_attempts+1,
      previous_text=?,previous_receipt_json=?,prior_uncertain=?,updated_at=? WHERE entry_id=? AND revision=?`,
    ).run(
      attempt,
      previous?.input_text ?? null,
      previous?.receipt_json ?? null,
      priorUncertain ? 1 : 0,
      now,
      row.entry_id,
      row.revision,
    );
    return toRow({
      ...row,
      state: "running",
      attempts: attempt,
      previous_text: previous?.input_text ?? null,
      previous_receipt_json: previous?.receipt_json ?? null,
      prior_uncertain: priorUncertain ? 1 : 0,
      updated_at: now,
    });
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
    db.prepare(
      `UPDATE note_agent_runs SET
      state=CASE WHEN pending_mutations>0 OR applied_mutations>0 OR uncertain_mutations>0 THEN 'done'
        WHEN EXISTS(SELECT 1 FROM note_agent_runs newer WHERE newer.entry_id=note_agent_runs.entry_id AND newer.revision>note_agent_runs.revision) THEN 'skipped'
        WHEN revision_attempts>=? THEN 'failed' ELSE 'pending' END,
      baseline=CASE WHEN pending_mutations>0 OR applied_mutations>0 OR uncertain_mutations>0 THEN 1 ELSE 0 END,
      uncertain_mutations=CASE WHEN pending_mutations>0 THEN 1 ELSE uncertain_mutations END,
      receipt_json=CASE WHEN pending_mutations>0 OR applied_mutations>0 OR uncertain_mutations>0 THEN '{"text":"An earlier action may have been applied or may still be running. Review its result before making a fresh separate request.","changes":[]}' ELSE receipt_json END,
      error=?,run_after=?,updated_at=? WHERE entry_id=? AND state='running' AND attempts=?`,
    ).run(NOTE_AGENT_MAX_ATTEMPTS, outcome.error, outcome.retryAt, now, entryId, attempt);
    return;
  }
  db.prepare<[string, string, string, number, string, number]>(
    `UPDATE note_agent_runs SET state = ?, baseline=CASE WHEN ?='done' THEN 1 ELSE 0 END, receipt_json = ?, error = NULL, updated_at = ?
      WHERE entry_id = ? AND state = 'running' AND attempts = ?`,
  ).run(outcome.state, outcome.state, JSON.stringify(outcome.receipt), now, entryId, attempt);
}

export function getNoteRuns(db: Db, entryIds: readonly string[]): Map<string, NoteAgentRow> {
  if (entryIds.length === 0) return new Map();
  const rows = db
    .prepare<string[], DbRow>(
      `SELECT * FROM note_agent_runs r WHERE entry_id IN (${entryIds.map(() => "?").join(", ")}) AND revision=(SELECT MAX(newer.revision) FROM note_agent_runs newer WHERE newer.entry_id=r.entry_id)`,
    )
    .all(...entryIds);
  return new Map(rows.map((r) => [r.entry_id, toRow(r)]));
}

/** True while any note is queued or running. */
export function hasPendingNotes(db: Db): boolean {
  return (
    db
      .prepare<[], { one: number }>(
        "SELECT 1 AS one FROM note_agent_runs WHERE state IN ('pending', 'running') LIMIT 1",
      )
      .get() !== undefined
  );
}

/** Admit an authenticated owner edit, coalescing only revisions not yet claimed.
 * Untrusted writers can save notes but cannot turn their prose into owner tools.
 */
export function queueNoteEdit(
  db: Db,
  entryId: string,
  previousText: string,
  text: string,
  owner: boolean,
  enabled: boolean,
  now: number,
): void {
  if (previousText === text) return;
  const entry = db
    .prepare<[string], { from_owner: number }>("SELECT from_owner FROM note_entries WHERE id=?")
    .get(entryId);
  if (!entry?.from_owner) return;
  const latest = db
    .prepare<[string], { revision: number }>(
      "SELECT MAX(revision) AS revision FROM note_agent_runs WHERE entry_id=?",
    )
    .get(entryId);
  if (latest?.revision == null) {
    db.prepare(
      "INSERT INTO note_agent_runs(entry_id,revision,input_text,state,run_after,created_at,updated_at,baseline) VALUES(?,0,?,'skipped',?,?,?,1)",
    ).run(entryId, previousText, now, now, now);
  }
  // An edit revokes unfinished unclaimed prose, including an external edit.
  db.prepare(
    "UPDATE note_agent_runs SET state='skipped',baseline=0 WHERE entry_id=? AND state='pending'",
  ).run(entryId);
  const revision = (latest?.revision ?? 0) + 1;
  db.prepare(
    `INSERT INTO note_agent_runs(entry_id,revision,input_text,state,run_after,created_at,updated_at,baseline)
    VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    entryId,
    revision,
    text,
    owner && enabled ? "pending" : "skipped",
    now,
    now,
    now,
    owner && enabled ? 0 : 1,
  );
}

export type NoteMutationAdmission = "admitted" | "superseded" | "review_required";
/** Writer-boundary authority check, before an irreversible tool invocation. */
export function admitNoteMutation(
  db: Db,
  entryId: string,
  attempt: number,
  now: number,
): NoteMutationAdmission {
  return db.transaction(() => {
    const row = db
      .prepare<
        [string, number],
        DbRow & { pending_mutations: number; uncertain_mutations: number }
      >("SELECT * FROM note_agent_runs WHERE entry_id=? AND attempts=? AND state='running'")
      .get(entryId, attempt);
    if (!row) return "superseded";
    if (row.prior_uncertain || row.uncertain_mutations > 0) return "review_required";
    const current = db
      .prepare(
        "SELECT 1 FROM note_entries n WHERE n.id=? AND n.from_owner=1 AND n.text=? AND NOT EXISTS(SELECT 1 FROM note_agent_runs newer WHERE newer.entry_id=n.id AND newer.revision>?)",
      )
      .get(entryId, row.input_text, row.revision);
    if (!current) return "superseded";
    db.prepare(
      "UPDATE note_agent_runs SET pending_mutations=pending_mutations+1,updated_at=? WHERE entry_id=? AND revision=?",
    ).run(now, entryId, row.revision);
    return "admitted";
  })();
}

/** Persist action uncertainty across process loss; safe refusals remain retryable. */
export function settleNoteMutation(
  db: Db,
  entryId: string,
  attempt: number,
  outcome: "applied" | "safe_error" | "uncertain",
  now: number,
): void {
  db.prepare(
    `UPDATE note_agent_runs SET pending_mutations=MAX(0,pending_mutations-1),
    applied_mutations=applied_mutations+?,uncertain_mutations=MAX(uncertain_mutations,?),updated_at=?
    WHERE entry_id=? AND attempts=?`,
  ).run(outcome === "applied" ? 1 : 0, outcome === "uncertain" ? 1 : 0, now, entryId, attempt);
}

/** The captured audio may replace a phone transcript before the first turn. */
export function refreshNoteTranscript(db: Db, entryId: string, text: string): void {
  db.prepare(
    "UPDATE note_agent_runs SET input_text=? WHERE entry_id=? AND revision=0 AND state='pending' AND applied_mutations=0 AND pending_mutations=0 AND uncertain_mutations=0",
  ).run(text, entryId);
}

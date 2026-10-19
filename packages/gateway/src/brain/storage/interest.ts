// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The interest ledger — what the owner told Omnesis they care about, as
 * signed examples the decision gates compare new items against.
 *
 * A signal is one reaction the owner made on purpose: accepting, creating or
 * ignoring a task, a thumbs up or down on a morning-brief item, or a statement
 * in the Morning brief conversation. Each keeps the text the owner reacted to
 * and, once the embedder has seen it, a vector of that text. Nothing is
 * inferred from silence. A reaction the owner takes back (an undone accept, a
 * thumbs changed) supersedes the signal it produced rather than deleting it,
 * so the ledger stays an honest history.
 *
 * `brief_item_reactions` is the current thumbs state per shipped brief item,
 * which the clients render; the signals it produced live in `interest_signals`.
 */

import { assertNever } from "@omnesis/core";
import type { OpenLoopRow, TaskEvent } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export type InterestPolarity = 1 | -1;

/** What kind of thing the owner reacted to; a gate asks for examples of its own kind first. */
export type InterestKind = "task" | "observation" | "statement";

export type InterestSource =
  | "task_accepted"
  | "task_created"
  | "task_ignored"
  | "task_adopt_undone"
  | "brief_thumbs_up"
  | "brief_not_interested"
  | "statement";

export interface InterestSignal {
  id: string;
  polarity: InterestPolarity;
  kind: InterestKind;
  source: InterestSource;
  /** What the owner reacted to: a task's title and description, an observation's summary and why, or the statement. */
  subjectText: string;
  /** The owner's own words about it, when they gave any. */
  note: string | null;
  loopId: string | null;
  observationId: string | null;
  conversationId: string | null;
  /** The task-ledger entry that produced it; undoing that entry supersedes the signal. */
  ledgerSeq: number | null;
  embedding: Float32Array | null;
  embeddingModel: string | null;
  createdAt: number;
  supersededAt: number | null;
}

export type NewInterestSignal = Omit<
  InterestSignal,
  | "embedding"
  | "embeddingModel"
  | "supersededAt"
  | "note"
  | "loopId"
  | "observationId"
  | "conversationId"
  | "ledgerSeq"
> &
  Partial<
    Pick<InterestSignal, "note" | "loopId" | "observationId" | "conversationId" | "ledgerSeq">
  >;

export type BriefItemReactionKind = "up" | "not_interested" | "factual_error";

export interface BriefItemReaction {
  observationId: string;
  day: string;
  messageId: string;
  reaction: BriefItemReactionKind;
  note: string | null;
  /** The Tell Omnesis note a factual correction was saved as. */
  noteId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The longest subject text kept; the owner reacted to the gist, not a treatise. */
export const INTEREST_SUBJECT_MAX_CHARS = 1_000;
export const INTEREST_NOTE_MAX_CHARS = 2_000;

export function createInterestTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS interest_signals (
      id TEXT PRIMARY KEY,
      polarity INTEGER NOT NULL CHECK (polarity IN (-1, 1)),
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      subject_text TEXT NOT NULL,
      note TEXT,
      loop_id TEXT,
      observation_id TEXT,
      conversation_id TEXT,
      ledger_seq INTEGER,
      embedding BLOB,
      embedding_model TEXT,
      embed_attempts INTEGER NOT NULL DEFAULT 0,
      embed_after INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      superseded_at INTEGER
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_interest_signals_live ON interest_signals(created_at DESC) WHERE superseded_at IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_interest_signals_loop ON interest_signals(loop_id) WHERE loop_id IS NOT NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_interest_signals_observation ON interest_signals(observation_id) WHERE observation_id IS NOT NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_interest_signals_unembedded ON interest_signals(embed_after, created_at) WHERE embedding IS NULL AND superseded_at IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_interest_signals_ledger_seq ON interest_signals(ledger_seq) WHERE ledger_seq IS NOT NULL",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS brief_item_reactions (
      observation_id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      message_id TEXT NOT NULL,
      reaction TEXT NOT NULL CHECK (reaction IN ('up', 'not_interested', 'factual_error')),
      note TEXT,
      note_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

interface SignalRow {
  id: string;
  polarity: number;
  kind: string;
  source: string;
  subject_text: string;
  note: string | null;
  loop_id: string | null;
  observation_id: string | null;
  conversation_id: string | null;
  ledger_seq: number | null;
  embedding: Buffer | null;
  embedding_model: string | null;
  created_at: number;
  superseded_at: number | null;
}

const SIGNAL_COLUMNS =
  "id, polarity, kind, source, subject_text, note, loop_id, observation_id, conversation_id, ledger_seq, embedding, embedding_model, created_at, superseded_at";

/** Raw little-endian Float32 bytes, the same layout `chunks.embedding` uses. */
export function embeddingFromBlob(blob: Buffer | null): Float32Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4).slice();
}

export function embeddingToBlob(vector: ArrayLike<number>): Buffer {
  const typed = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
}

function toSignal(row: SignalRow): InterestSignal {
  return {
    id: row.id,
    polarity: row.polarity === 1 ? 1 : -1,
    kind: row.kind as InterestKind,
    source: row.source as InterestSource,
    subjectText: row.subject_text,
    note: row.note,
    loopId: row.loop_id,
    observationId: row.observation_id,
    conversationId: row.conversation_id,
    ledgerSeq: row.ledger_seq,
    embedding: embeddingFromBlob(row.embedding),
    embeddingModel: row.embedding_model,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
  };
}

export function clipInterestText(text: string, max = INTEREST_SUBJECT_MAX_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Insert one signal without a vector; the embedding backlog fills it in. */
export function insertInterestSignal(db: Db, signal: NewInterestSignal): InterestSignal {
  db.prepare<unknown[]>(
    `INSERT INTO interest_signals (
       id, polarity, kind, source, subject_text, note, loop_id, observation_id,
       conversation_id, ledger_seq, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    signal.id,
    signal.polarity,
    signal.kind,
    signal.source,
    clipInterestText(signal.subjectText),
    signal.note ? clipInterestText(signal.note, INTEREST_NOTE_MAX_CHARS) : null,
    signal.loopId ?? null,
    signal.observationId ?? null,
    signal.conversationId ?? null,
    signal.ledgerSeq ?? null,
    signal.createdAt,
  );
  return getInterestSignal(db, signal.id)!;
}

export function getInterestSignal(db: Db, id: string): InterestSignal | null {
  const row = db
    .prepare<[string], SignalRow>(`SELECT ${SIGNAL_COLUMNS} FROM interest_signals WHERE id = ?`)
    .get(id);
  return row ? toSignal(row) : null;
}

/**
 * Mark every live signal about a loop, an observation or a task-ledger entry
 * as superseded. Returns how many were.
 */
export interface InterestSupersedeScope {
  loopId?: string;
  observationId?: string;
  ledgerSeq?: number;
  /** A statement about the same subject, compared case-insensitively. */
  statementText?: string;
  /** Only signals of this kind; alone it names nothing. */
  kind?: InterestKind;
}

export function supersedeInterestSignals(db: Db, by: InterestSupersedeScope, now: number): number {
  const where: string[] = [];
  const args: Array<string | number> = [now];
  if (by.kind !== undefined) {
    where.push("kind = ?");
    args.push(by.kind);
  }
  if (by.statementText !== undefined) {
    where.push("kind = 'statement' AND lower(trim(subject_text)) = lower(trim(?))");
    args.push(by.statementText);
  }
  if (by.loopId !== undefined) {
    where.push("loop_id = ?");
    args.push(by.loopId);
  }
  if (by.observationId !== undefined) {
    where.push("observation_id = ?");
    args.push(by.observationId);
  }
  if (by.ledgerSeq !== undefined) {
    where.push("ledger_seq = ?");
    args.push(by.ledgerSeq);
  }
  // `kind` alone names no signal; a scope needs the thing reacted to.
  if (where.length === 0 || (where.length === 1 && by.kind !== undefined)) return 0;
  return db
    .prepare<
      Array<string | number>
    >(`UPDATE interest_signals SET superseded_at = ? WHERE superseded_at IS NULL AND ${where.join(" AND ")}`)
    .run(...args).changes;
}

/**
 * Record one signal, first superseding the live signals `supersede` names,
 * in one transaction, so a reader never sees both the old and the new.
 */
export function recordInterestSignal(
  db: Db,
  signal: NewInterestSignal,
  supersede: InterestSupersedeScope | null,
): InterestSignal {
  return db.transaction(() => {
    if (supersede) supersedeInterestSignals(db, supersede, signal.createdAt);
    return insertInterestSignal(db, signal);
  })();
}

/**
 * Forget every signal about a loop or an observation that is being purged:
 * their text came from the owner's documents, and a privacy deletion must not
 * leave a copy behind. Supersession is for reactions taken back; this is for
 * evidence that no longer exists.
 */
export function deleteInterestSignalsFor(
  db: Db,
  by: { loopId?: string; observationId?: string },
): number {
  let changes = 0;
  if (by.loopId !== undefined)
    changes += db
      .prepare<[string]>("DELETE FROM interest_signals WHERE loop_id = ?")
      .run(by.loopId).changes;
  if (by.observationId !== undefined) {
    changes += db
      .prepare<[string]>("DELETE FROM interest_signals WHERE observation_id = ?")
      .run(by.observationId).changes;
    deleteBriefItemReaction(db, by.observationId);
  }
  return changes;
}

/**
 * A cheap summary of the live ledger that changes whenever a lookup's input
 * would: rows added, superseded, deleted or embedded. The engine compares it
 * before re-reading the whole set.
 */
export function interestLedgerFingerprint(db: Db): string {
  const row = db
    .prepare<[], { live: number; newest: number; embedded: number; superseded: number }>(
      `SELECT COALESCE(SUM(superseded_at IS NULL), 0) AS live, COALESCE(MAX(created_at), 0) AS newest,
              COALESCE(SUM(embedding IS NOT NULL AND superseded_at IS NULL), 0) AS embedded,
              COALESCE(SUM(superseded_at IS NOT NULL), 0) AS superseded
         FROM interest_signals`,
    )
    .get();
  return `${row?.live ?? 0}:${row?.newest ?? 0}:${row?.embedded ?? 0}:${row?.superseded ?? 0}`;
}

export interface InterestCounts {
  live: number;
  superseded: number;
  positive: number;
  negative: number;
  statements: number;
}

/** Whole-ledger counts; `positive`, `negative` and `statements` count live signals only. */
export function countInterestSignals(db: Db): InterestCounts {
  const rows = db
    .prepare<[], { live: number; polarity: number; kind: string; n: number }>(
      `SELECT (superseded_at IS NULL) AS live, polarity, kind, COUNT(*) AS n
         FROM interest_signals GROUP BY live, polarity, kind`,
    )
    .all();
  const counts: InterestCounts = {
    live: 0,
    superseded: 0,
    positive: 0,
    negative: 0,
    statements: 0,
  };
  for (const row of rows) {
    if (!row.live) {
      counts.superseded += row.n;
      continue;
    }
    counts.live += row.n;
    if (row.kind === "statement") counts.statements += row.n;
    else if (row.polarity === 1) counts.positive += row.n;
    else counts.negative += row.n;
  }
  return counts;
}

/** Live signals, newest first, bounded. */
export function listLiveInterestSignals(
  db: Db,
  opts: { limit: number; since?: number } = { limit: 2_000 },
): InterestSignal[] {
  return db
    .prepare<[number, number], SignalRow>(
      `SELECT ${SIGNAL_COLUMNS} FROM interest_signals
        WHERE superseded_at IS NULL AND created_at >= ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(opts.since ?? 0, opts.limit)
    .map(toSignal);
}

/** Every signal, superseded included, newest first — the audit view. */
export function listInterestSignals(db: Db, opts: { limit: number }): InterestSignal[] {
  return db
    .prepare<
      [number],
      SignalRow
    >(`SELECT ${SIGNAL_COLUMNS} FROM interest_signals ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(opts.limit)
    .map(toSignal);
}

/** The wait after a failed embedding, doubling per attempt from this up to {@link INTEREST_EMBED_BACKOFF_MAX_MS}. */
export const INTEREST_EMBED_BACKOFF_BASE_MS = 15 * 60 * 1000;
export const INTEREST_EMBED_BACKOFF_MAX_MS = 16 * 60 * 60 * 1000;

/** When a row that has failed `attempts` times may be tried again. */
export function interestEmbedRetryAt(attempts: number, now: number): number {
  const wait = Math.min(
    INTEREST_EMBED_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
    INTEREST_EMBED_BACKOFF_MAX_MS,
  );
  return now + wait;
}

/**
 * Live signals waiting for a vector that are due a try at `now`, oldest
 * first, continuing after `after` so a pass can page through the backlog.
 */
export function listUnembeddedInterestSignals(
  db: Db,
  opts: { limit: number; now: number; after?: { createdAt: number; id: string } },
): InterestSignal[] {
  const after = opts.after ?? { createdAt: -1, id: "" };
  return db
    .prepare<[number, number, number, string, number], SignalRow>(
      `SELECT ${SIGNAL_COLUMNS} FROM interest_signals
        WHERE embedding IS NULL AND superseded_at IS NULL AND embed_after <= ?
          AND (created_at > ? OR (created_at = ? AND id > ?))
        ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
    .all(opts.now, after.createdAt, after.createdAt, after.id, opts.limit)
    .map(toSignal);
}

/** Live signals without a vector that are due a try at `now`. */
export function countUnembeddedInterestSignals(db: Db, now: number): number {
  return (
    db
      .prepare<
        [number],
        { n: number }
      >("SELECT COUNT(*) AS n FROM interest_signals WHERE embedding IS NULL AND superseded_at IS NULL AND embed_after <= ?")
      .get(now)?.n ?? 0
  );
}

/**
 * Store a signal's vector, or record a failed attempt (`embedding` null) and
 * push the next try out by a wait that doubles per failure.
 */
export function setInterestSignalEmbedding(
  db: Db,
  id: string,
  embedding: { vector: ArrayLike<number>; model: string } | null,
  now: number,
): boolean {
  if (!embedding) {
    const current = db
      .prepare<
        [string],
        { embed_attempts: number }
      >("SELECT embed_attempts FROM interest_signals WHERE id = ?")
      .get(id);
    if (!current) return false;
    const attempts = current.embed_attempts + 1;
    return (
      db
        .prepare<
          [number, number, string]
        >("UPDATE interest_signals SET embed_attempts = ?, embed_after = ? WHERE id = ?")
        .run(attempts, interestEmbedRetryAt(attempts, now), id).changes > 0
    );
  }
  return (
    db
      .prepare<
        [Buffer, string, string]
      >("UPDATE interest_signals SET embedding = ?, embedding_model = ?, embed_attempts = embed_attempts + 1, embed_after = 0 WHERE id = ?")
      .run(embeddingToBlob(embedding.vector), embedding.model, id).changes > 0
  );
}

/** Whether any live vector was made by an embedder other than `model`. */
export function hasInterestEmbeddingsNotFrom(db: Db, model: string): boolean {
  return (
    db
      .prepare<
        [string]
      >("SELECT 1 FROM interest_signals WHERE embedding IS NOT NULL AND superseded_at IS NULL AND embedding_model IS NOT ? LIMIT 1")
      .get(model) !== undefined
  );
}

/**
 * Forget every vector made by another embedder, so the backlog re-embeds them
 * with the live one. Vectors from two models are not comparable.
 */
export function resetInterestEmbeddingsNotFrom(db: Db, model: string): number {
  return db
    .prepare<
      [string]
    >("UPDATE interest_signals SET embedding = NULL, embedding_model = NULL, embed_attempts = 0, embed_after = 0 WHERE embedding IS NOT NULL AND embedding_model IS NOT ?")
    .run(model).changes;
}

// ---------------------------------------------------------------------------
// The task hook
// ---------------------------------------------------------------------------

/** The text a task signal is matched by: its title, then its description. */
export function taskSubjectText(loop: Pick<OpenLoopRow, "title" | "description">): string {
  return loop.description.trim() ? `${loop.title}\n${loop.description}` : loop.title;
}

/**
 * Turn one task-ledger event into its interest signal, in the same writer
 * transaction as the event. Accepting a suggestion, or creating a task, says
 * the owner wants to track this; ignoring a suggestion says they do not.
 * Undoing one of those takes the signal back, and undoing a task the Brain
 * adopted on its own is the loudest "no" the ledger records. Everything else a
 * task goes through (done, struck, moved, edited) says nothing about interest
 * and records nothing.
 */
export function recordTaskInterest(
  db: Db,
  input: {
    loop: OpenLoopRow;
    event: TaskEvent;
    seq: number;
    /** For `undone`: the event that was reverted. */
    undone?: TaskEvent | null;
    /**
     * False while the ledger is switched off: nothing new is recorded, but an
     * undo still takes back what an earlier reaction recorded.
     */
    record?: boolean;
    idGen: () => string;
  },
  now: number,
): InterestSignal | null {
  const { loop, event, seq } = input;
  const record = input.record ?? true;
  const emit = (polarity: InterestPolarity, source: InterestSource): InterestSignal | null =>
    !record
      ? null
      : insertInterestSignal(db, {
          id: `int_${input.idGen()}`,
          polarity,
          kind: "task",
          source,
          subjectText: taskSubjectText(loop),
          note: event.note ?? null,
          loopId: loop.id,
          conversationId: event.conversationId ?? null,
          ledgerSeq: seq,
          createdAt: now,
        });
  // The owner's latest verdict on a loop is the one that counts: an accept
  // after an ignore takes the ignore back, whatever the ledger switch says.
  const replace = (polarity: InterestPolarity, source: InterestSource): InterestSignal | null => {
    supersedeInterestSignals(db, { loopId: loop.id, kind: "task" }, now);
    return emit(polarity, source);
  };
  switch (event.kind) {
    case "created":
      return loop.origin === "brain" ? null : emit(1, "task_created");
    case "accepted":
      return replace(1, "task_accepted");
    case "ignored":
      return replace(-1, "task_ignored");
    case "undone": {
      if (event.undoOf !== undefined)
        supersedeInterestSignals(db, { ledgerSeq: event.undoOf }, now);
      return input.undone?.kind === "auto_accepted" ? replace(-1, "task_adopt_undone") : null;
    }
    // Done, struck, moved, edited, reopened, a proposal answered, a change
    // Omnesis applied or a verdict the gate enforced: none says what the
    // owner cares about.
    case "refused":
    case "migrated":
    case "completed":
    case "struck":
    case "edited":
    case "reopened":
    case "proposal_confirmed":
    case "proposal_kept":
    case "auto_applied":
    case "auto_accepted":
    case "withheld":
      return null;
    default:
      return assertNever(event.kind);
  }
}

// ---------------------------------------------------------------------------
// Brief item reactions
// ---------------------------------------------------------------------------

interface ReactionRow {
  observation_id: string;
  day: string;
  message_id: string;
  reaction: string;
  note: string | null;
  note_id: string | null;
  created_at: number;
  updated_at: number;
}

function toReaction(row: ReactionRow): BriefItemReaction {
  return {
    observationId: row.observation_id,
    day: row.day,
    messageId: row.message_id,
    reaction: row.reaction as BriefItemReactionKind,
    note: row.note,
    noteId: row.note_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertBriefItemReactionInput {
  observationId: string;
  day: string;
  messageId: string;
  reaction: BriefItemReactionKind;
  note?: string | null;
  noteId?: string | null;
}

export function upsertBriefItemReaction(
  db: Db,
  input: UpsertBriefItemReactionInput,
  now: number,
): BriefItemReaction {
  db.prepare<unknown[]>(
    `INSERT INTO brief_item_reactions (observation_id, day, message_id, reaction, note, note_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(observation_id) DO UPDATE SET
       day = excluded.day, message_id = excluded.message_id, reaction = excluded.reaction,
       note = excluded.note, note_id = excluded.note_id, updated_at = excluded.updated_at`,
  ).run(
    input.observationId,
    input.day,
    input.messageId,
    input.reaction,
    input.note ? clipInterestText(input.note, INTEREST_NOTE_MAX_CHARS) : null,
    input.noteId ?? null,
    now,
    now,
  );
  return getBriefItemReaction(db, input.observationId)!;
}

/** How a reaction reads on the observation row, where other tools look for what the owner did. */
export const REACTION_USER_ACTIONS: Record<BriefItemReactionKind, string> = {
  up: "thumbs_up",
  not_interested: "not_interested",
  factual_error: "disputed",
};

export interface ApplyBriefReactionInput {
  observationId: string;
  day: string;
  messageId: string;
  /** Null clears the owner's thumbs. */
  reaction: BriefItemReactionKind | null;
  note?: string | null;
  noteId?: string | null;
  /** The signal a thumbs up or "not interested" leaves; absent for a factual error or while the ledger is off. */
  signal?: NewInterestSignal | null;
}

/**
 * Apply the owner's thumbs on one brief item in one transaction: the live
 * observation signals about the item are superseded, the new signal (if any)
 * inserted, the reaction row set or cleared, and the observation's user action
 * updated. Clearing leaves a user action another tool wrote (a suppression)
 * untouched.
 */
export function applyBriefReaction(
  db: Db,
  input: ApplyBriefReactionInput,
  now: number,
): BriefItemReaction | null {
  return db.transaction(() => {
    supersedeInterestSignals(db, { observationId: input.observationId, kind: "observation" }, now);
    if (input.signal) insertInterestSignal(db, input.signal);
    if (input.reaction === null) {
      deleteBriefItemReaction(db, input.observationId);
      const current = db
        .prepare<
          [string],
          { user_action: string | null }
        >("SELECT user_action FROM observations WHERE id = ?")
        .get(input.observationId);
      if (
        current?.user_action &&
        Object.values(REACTION_USER_ACTIONS).includes(current.user_action)
      )
        setUserAction(db, input.observationId, null, now);
      return null;
    }
    const stored = upsertBriefItemReaction(
      db,
      {
        observationId: input.observationId,
        day: input.day,
        messageId: input.messageId,
        reaction: input.reaction,
        note: input.note ?? null,
        noteId: input.noteId ?? null,
      },
      now,
    );
    setUserAction(db, input.observationId, REACTION_USER_ACTIONS[input.reaction], now);
    return stored;
  })();
}

function setUserAction(db: Db, observationId: string, action: string | null, now: number): void {
  db.prepare<[string | null, number, string]>(
    "UPDATE observations SET user_action = ?, updated_at = ? WHERE id = ?",
  ).run(action, now, observationId);
}

export function deleteBriefItemReaction(db: Db, observationId: string): boolean {
  return (
    db
      .prepare<[string]>("DELETE FROM brief_item_reactions WHERE observation_id = ?")
      .run(observationId).changes > 0
  );
}

export function getBriefItemReaction(db: Db, observationId: string): BriefItemReaction | null {
  const row = db
    .prepare<[string], ReactionRow>("SELECT * FROM brief_item_reactions WHERE observation_id = ?")
    .get(observationId);
  return row ? toReaction(row) : null;
}

/** The reactions on one sent brief's items, keyed by observation id. */
export function listBriefItemReactions(db: Db, messageId: string): Map<string, BriefItemReaction> {
  const rows = db
    .prepare<[string], ReactionRow>("SELECT * FROM brief_item_reactions WHERE message_id = ?")
    .all(messageId);
  return new Map(rows.map((row) => [row.observation_id, toReaction(row)]));
}

// ---------------------------------------------------------------------------
// Withheld suggestions
// ---------------------------------------------------------------------------

export interface WithheldSuggestion {
  loopId: string;
  title: string;
  /** The `withheld` ledger entry, the handle undo takes. */
  seq: number;
  at: number;
  /** The gate's reason, as the ledger note reads. */
  note: string;
}

/**
 * Open Brain suggestions the gate kept out of the Tasks views, newest first:
 * still ignored, with `withheld` as the latest change in their history. The
 * Tasks views never list these, so the surface that does is the only way to
 * offer one again.
 */
export function listWithheldSuggestions(db: Db, limit = 100): WithheldSuggestion[] {
  return db
    .prepare<[number], { loop_id: string; title: string; seq: number; at: number; note: string }>(
      `SELECT l.loop_id, o.title, l.seq, l.at, l.note
         FROM open_loop_ledger l
         JOIN open_loops o ON o.id = l.loop_id
        WHERE o.origin = 'brain' AND o.accepted = 0 AND o.ignored = 1 AND o.state = 'open'
          AND l.seq = (SELECT MAX(seq) FROM open_loop_ledger WHERE loop_id = l.loop_id AND event_json IS NOT NULL)
          AND json_extract(l.event_json, '$.kind') = 'withheld'
        ORDER BY l.at DESC, l.seq DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({
      loopId: row.loop_id,
      title: row.title,
      seq: row.seq,
      at: row.at,
      note: row.note,
    }));
}

/** Whether the latest change in a loop's history is the gate withholding it. */
export function isWithheldSuggestion(db: Db, loopId: string): boolean {
  const latest = db
    .prepare<
      [string],
      { event_json: string }
    >("SELECT event_json FROM open_loop_ledger WHERE loop_id = ? AND event_json IS NOT NULL ORDER BY seq DESC LIMIT 1")
    .get(loopId);
  return latest !== undefined && (JSON.parse(latest.event_json) as TaskEvent).kind === "withheld";
}

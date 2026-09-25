// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where a watch's live instances live between events.
 *
 * A stateful node holds an instance from the arm that created it until the
 * fire, cancel or deadline that ends it, and "between" can be days. That state
 * has to survive a restart, so it is a database rather than a map: SQLite,
 * one file per runtime.
 *
 * The consumer cursor advances **in the same transaction** as the node-state
 * changes an event caused. That is the whole crash-safety argument: either an
 * event's effects and its cursor advance both land, or neither does, so a
 * restart re-reads exactly the events whose effects were lost and no others.
 *
 * Effectively-once effects fall out of two things rather than one. The cursor
 * bounds what is replayed; a unique constraint on `(watch_id, seq, node_id)`
 * makes a firing that *is* replayed idempotent. Without the second, a crash
 * between the effect and the commit would double-count on resume.
 *
 * A cell is identified by `(watch, node, key, instance)`. The instance
 * dimension is what makes `spawn` possible: without it there is exactly one
 * cell per key, parallel instances are structurally unrepresentable, and
 * `spawn` silently degrades into `reset`.
 */

import { createHash } from "node:crypto";

import DatabaseConstructor, { type Database } from "better-sqlite3";

import { HOLDING_SQL, SPEC_TABLE, specRow, type WatchHoldingSpec } from "./holding.js";
import { addMissingColumns, type ColumnAdditions } from "./schema-additions.js";
import { FAILURE_CLASSES, type FailureClass } from "./trace.js";

/**
 * Why a watch stopped, and where it stopped.
 *
 * The class is what may be shown to an operator; the sequence is what a
 * recovery acts on. Deliberately no message: a backend's error text can quote
 * a value out of the corpus, and this record outlives the trace that holds it.
 */
export interface WatchFailure {
  /** The journal event being evaluated. Negative for a journaled timer. */
  readonly seq: number;
  readonly nodeId: string;
  readonly failure: FailureClass;
}

function isFailureClass(value: unknown): value is FailureClass {
  return typeof value === "string" && (FAILURE_CLASSES as readonly string[]).includes(value);
}

/** What one watch is holding, counted rather than described. */
export interface WatchLiveState {
  /**
   * Distinct keys with a cell anywhere in the graph — the whole population,
   * whether or not any of it is still waiting for something.
   */
  keys: number;
  /** Cells behind those keys; more than `keys` where a node spawns instances. */
  cells: number;
  /**
   * Of those keys, the ones actually holding something.
   *
   * The number a surface may call "tracking". A cell is kept for reasons other
   * than waiting — a spent cooldown stamp, a drained persistence window, a SQL
   * node's resting level — and each node type decides which of its own cells
   * count, in `holding.ts`. Never greater than {@link keys}.
   */
  holdingKeys: number;
  /** Cells behind those keys, on the same reading. */
  holdingCells: number;
  timers: number;
  /** When the soonest of them comes due, or null when none is armed. */
  nextDueAtMs: number | null;
  /**
   * How far this watch has been evaluated, or null before it ever has.
   *
   * Against the journal head it is the one state that looks like idleness and
   * is not: a watch behind the head is holding nothing yet because it has not
   * read the events that would fill it.
   *
   * Null rather than zero when no cursor row exists, because those are
   * different facts. A watch is added at the journal head and its cursor is
   * seeded from `fromSeq` on the first pass that evaluates it, so until then
   * "no row" means "has not started" — and reading it as sequence zero accuses
   * a watch of a backlog of the entire journal it was never going to read.
   */
  cursorSeq: number | null;
}

/** A node instance: what it is waiting for, and until when. */
export interface NodeCell {
  readonly watchId: string;
  readonly nodeId: string;
  readonly keyHash: string;
  /**
   * Which instance of this key. `0` for every node that keeps at most one;
   * `spawn` allocates increasing ordinals so parallel instances coexist.
   */
  readonly instance: number;
  readonly key: Readonly<Record<string, unknown>>;
  /** `live` dies on fire; `accumulating` survives it. */
  state: "live" | "accumulating";
  /** When this instance was created. Anchors its deadline. */
  armedAtMs: number;
  /**
   * When the predicate this node watches became true, and null while it does
   * not hold. Anchors `persistence` — a different clock from the instance's
   * own, which does not restart. Null rather than the last evaluation's instant
   * because "since when has this been true" has no answer for something false,
   * and an instant there is indistinguishable from one that just became true.
   */
  heldSinceMs: number | null;
  /** When this instance gives up, or null for a node with no deadline. */
  deadlineAtMs: number | null;
  /**
   * The last boolean level this node observed, for rising-edge detection.
   * `null` means it has never observed one.
   */
  level: boolean | null;
  /**
   * Which inputs have arrived, for AND / N-of-M / sequence. Each keeps the
   * provenance it arrived with, so a join can address every branch rather than
   * only whichever one happened to complete it.
   */
  slots: Record<
    string,
    {
      seq: number;
      payload: Record<string, unknown>;
      provenance?: Record<
        string,
        {
          payload: Record<string, unknown>;
          key: Record<string, unknown>;
          firedBy?: unknown;
          documentId?: string;
        }
      >;
    }
  >;
  /** The output this instance will carry forward when it fires. */
  payload: Record<string, unknown>;
  /**
   * What everything upstream fired with when this instance was armed.
   *
   * Persisted rather than recomputed because an instance can outlive the event
   * that armed it by days: when a wait's deadline elapses, the arming event is
   * long gone, and its `output_map` still has to resolve `$n.<source>.<field>`.
   */
  provenance: Record<
    string,
    {
      payload: Record<string, unknown>;
      key: Record<string, unknown>;
      firedBy?: unknown;
      documentId?: string;
    }
  >;
  /** When this node last fired on this key, for cooldown. */
  lastFiredAtMs: number | null;
  /** Arm arrivals inside the window, for persistence. */
  arrivals: number[];
}

export interface TimerRow {
  readonly watchId: string;
  readonly nodeId: string;
  readonly keyHash: string;
  readonly key: Readonly<Record<string, unknown>>;
  readonly instance: number;
  readonly dueAtMs: number;
  /**
   * What comes due. `wait` fires the node; `deadline` expires the instance;
   * `tick` is a time source's next boundary; `poll` re-runs a SQL node.
   */
  readonly kind: "tick" | "deadline" | "wait" | "poll";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS node_cells (
  watch_id        TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  key_hash        TEXT NOT NULL,
  instance        INTEGER NOT NULL,
  key_json        TEXT NOT NULL,
  state           TEXT NOT NULL,
  armed_at_ms     INTEGER NOT NULL,
  deadline_at_ms  INTEGER,
  level           INTEGER,
  slots_json      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  last_fired_at_ms INTEGER,
  arrivals_json   TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  held_since_ms   INTEGER,
  PRIMARY KEY (watch_id, node_id, key_hash, instance)
);

CREATE TABLE IF NOT EXISTS timers (
  watch_id  TEXT NOT NULL,
  node_id   TEXT NOT NULL,
  key_hash  TEXT NOT NULL,
  instance  INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  key_json  TEXT NOT NULL,
  due_at_ms INTEGER NOT NULL,
  PRIMARY KEY (watch_id, node_id, key_hash, instance, kind)
);
CREATE INDEX IF NOT EXISTS timers_due ON timers (due_at_ms);

-- The unique constraint is what makes a replayed firing idempotent: a crash
-- between the effect and the commit re-runs the event, and the second attempt
-- is silently discarded rather than counted twice.
CREATE TABLE IF NOT EXISTS watch_firings (
  watch_id     TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  node_id      TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  -- The subject's time: when the thing this firing is about happened.
  fired_at     TEXT NOT NULL,
  -- When the runtime recorded it. Nullable, because a store written before
  -- this column existed has firings that predate the answer.
  noticed_at   TEXT,
  payload_json TEXT NOT NULL,
  -- Every document this firing was reached through, as a JSON array. The
  -- payload carries whatever the watch's author chose to report; this is what
  -- the runtime saw, which is what a reader asking "why did this fire?" needs.
  -- Nullable: a store written before this column has firings that cannot say.
  document_ids TEXT,
  -- 1 when an operator fired this watch by hand rather than the runtime
  -- reaching it through the journal. Nullable and absent-means-organic, so a
  -- store written before this column reads correctly: nothing recorded then
  -- was forced, because there was no way to force one.
  forced       INTEGER,
  UNIQUE (watch_id, seq, node_id, key_hash)
);

-- What happened when a firing was delivered, one row per attempt.
--
-- A notification that never arrived is otherwise indistinguishable from a
-- watch that never fired: the operator sees silence either way, and only one
-- of those is working as intended. Keyed by the firing's full identity, so a
-- watch that fires twice at one sequence number keeps two answers.
CREATE TABLE IF NOT EXISTS watch_deliveries (
  watch_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  node_id     TEXT NOT NULL,
  key_hash    TEXT NOT NULL,
  -- omnesis-notify or agent-wake: the same firing can only have one channel, but
  -- reading a row should not require looking the watch up to find out which.
  kind        TEXT NOT NULL,
  attempted   INTEGER,
  delivered   INTEGER NOT NULL,
  error       TEXT,
  -- Set when the firing shipped as something less than the channel can send —
  -- a plain banner where the operator should have got the agent's account of
  -- what happened and a tap that lands in it. NULL is the ordinary case.
  --
  -- A closed class, never a provider's error text: a backend can quote a value
  -- out of the corpus, and this row outlives the trace that holds it.
  degraded    TEXT,
  retry_attempted INTEGER,
  retry_delivered INTEGER,
  retry_error TEXT,
  at          TEXT NOT NULL,
  UNIQUE (watch_id, seq, node_id, key_hash)
);

CREATE TABLE IF NOT EXISTS consumer_cursor (
  watch_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watch_state (
  watch_id       TEXT PRIMARY KEY,
  active         INTEGER NOT NULL,
  -- The next sequence number to mint for a journaled timer. Persisted because
  -- a resumed run must not reissue one an earlier run already used: the
  -- firings table is unique on it, and a collision discards a real firing.
  next_timer_seq INTEGER NOT NULL DEFAULT -1,
  -- What stopped the watch, when something did. All three are set together and
  -- cleared together, and all three are NULL on a watch that is simply held.
  --
  -- The event is here because it is the thing a recovery needs: a watch that
  -- fails on one poison event fails on it again on every pass, since the cursor
  -- deliberately does not advance past an event whose effects were rolled back.
  -- Without knowing which event that was, the only way past it is to delete the
  -- watch and add it again — which restarts it at the journal head and discards
  -- every firing it ever recorded.
  failed_seq     INTEGER,
  failed_node    TEXT,
  failed_class   TEXT
);

-- Which document event each nominating node last looked at a document on.
--
-- The rule it enforces — one nomination per lifecycle a source subscribes to —
-- is a property of the (node, document) pair over the whole journal, not of one
-- run. Held only in memory it would be rebuilt by replaying every consumed
-- event, which is affordable for a fixture journal and not for a live one; and
-- a consumer that cannot replay would re-nominate everything it had already
-- spoken about on every restart.
--
-- Bounded by the documents each node's filter actually matched, not by the
-- corpus.
CREATE TABLE IF NOT EXISTS node_looks (
  watch_id  TEXT NOT NULL,
  node_id   TEXT NOT NULL,
  doc_id    TEXT NOT NULL,
  -- The doc.event sequence the look was made against. Equal means the same
  -- document as last time; different means it moved.
  looked_on INTEGER NOT NULL,
  PRIMARY KEY (watch_id, node_id, doc_id)
) WITHOUT ROWID;

-- Nominations a judge was asked for and could not afford.
--
-- A recall arm nominating a document is the expensive half done: the filters
-- matched, the embedding was scored, and the only thing left is the judgement.
-- When the day's budget is spent, dropping it there would lose the firing
-- outright — the cursor moves on, the look is recorded, and nothing ever
-- reconsiders it. Worse, the trace would say the judge declined, so budget
-- exhaustion and a precision judgement become indistinguishable in exactly the
-- measurement a shadow period exists to take.
--
-- So the nomination is parked instead, and drained in journal order when
-- budget is available again. The look is deliberately NOT recorded for a parked
-- document: recording it is what says "this node has considered this", and it
-- has not.
CREATE TABLE IF NOT EXISTS pending_nominations (
  watch_id TEXT NOT NULL,
  node_id  TEXT NOT NULL,
  doc_id   TEXT NOT NULL,
  -- The doc.indexed sequence that nominated it, which is both the order the
  -- queue drains in and the bound the document is looked up at.
  seq      INTEGER NOT NULL,
  at_ms    INTEGER NOT NULL,
  -- When the journal saw the event that nominated it. Carried across the park
  -- because the drain runs on a later pass, long after that event has gone by,
  -- and a firing it produces has to be stamped with it (see noticed_at on
  -- watch_firings). Null on rows parked before this was kept.
  observed_at TEXT,
  -- Earliest instant at which the judge asked to see this nomination again.
  -- Zero keeps rows written by older runtimes immediately eligible.
  retry_at_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (watch_id, node_id, doc_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pending_nominations_order
  ON pending_nominations (watch_id, seq);

-- Index events that arrived before the document they are about.
--
-- A node whose recall carries a semantic arm is answered on the index event,
-- because a semantic arm compares an embedding and there is no embedding until
-- the indexer has made one. Finding the document is then a lookup, and nothing
-- guarantees the document event was written first: an index event can land
-- ahead of its own document by a sequence or two. Without somewhere to keep it,
-- the node neither considers nor declines that document — an absence, which is
-- the one outcome a trace cannot express.
--
-- So the index is remembered and settled when the document lands. Ordering
-- follows the journal either way, which is what lets a replay of the same
-- journal reach the same answers; the alternative — reading ahead for a
-- document at a later sequence — would make an event's outcome depend on events
-- after it, and on where a batch happened to end.
CREATE TABLE IF NOT EXISTS pending_index (
  watch_id TEXT NOT NULL,
  doc_id   TEXT NOT NULL,
  -- The doc.indexed sequence, kept so the oldest can be dropped first.
  seq      INTEGER NOT NULL,
  PRIMARY KEY (watch_id, doc_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pending_index_order ON pending_index (watch_id, seq);

-- How many notifications each watch has sent on each day.
--
-- Durable because the cap it enforces is a promise about a day, and a restart
-- must not hand a watch a fresh allowance. Keyed on the host's own calendar day
-- rather than on a rolling window: a person understands "at most this many
-- today", and a rolling window would let a quiet morning pay for an afternoon
-- that interrupts them repeatedly.
--
-- Rows are kept rather than pruned on write — a day's count is a small integer,
-- and the history is what tells an operator whether a cap is the right one.
CREATE TABLE IF NOT EXISTS delivery_counts (
  watch_id TEXT NOT NULL,
  day      TEXT NOT NULL,
  sent     INTEGER NOT NULL,
  PRIMARY KEY (watch_id, day)
) WITHOUT ROWID;

-- How many agents each watch has woken on each day.
--
-- A ledger of its own rather than a column on the one above, because the two
-- bound different things and are therefore different budgets. A notification
-- spends a person's attention; a wake spends an agent's tokens and its time.
-- An install may reasonably want to be interrupted rarely and to think often,
-- or the reverse, and one number cannot express both.
CREATE TABLE IF NOT EXISTS wake_counts (
  watch_id TEXT NOT NULL,
  day      TEXT NOT NULL,
  sent     INTEGER NOT NULL,
  PRIMARY KEY (watch_id, day)
) WITHOUT ROWID;
`;

/**
 * The columns {@link SCHEMA} declares that a store already on disk will not
 * have, by table.
 *
 * Every column added to a table after that table shipped belongs here as well
 * as in `SCHEMA`. The two halves are read by different installs — the `CREATE`
 * statements by a file that does not exist yet, these by one that does — so
 * neither can catch the other being forgotten. `schema-additions.test.ts`
 * holds them against each other.
 */
export const STATE_COLUMN_ADDITIONS: Readonly<Record<string, ColumnAdditions>> = {
  watch_firings: { noticed_at: "TEXT", document_ids: "TEXT", forced: "INTEGER" },
  watch_state: { failed_seq: "INTEGER", failed_node: "TEXT", failed_class: "TEXT" },
  pending_nominations: { observed_at: "TEXT", retry_at_ms: "INTEGER NOT NULL DEFAULT 0" },
  watch_deliveries: {
    degraded: "TEXT",
    retry_attempted: "INTEGER",
    retry_delivered: "INTEGER",
    retry_error: "TEXT",
  },
};

/**
 * How many unsettled index events one watch may hold.
 *
 * An entry is settled by the document it is waiting for, which in ordinary
 * running arrives within a few sequences. One that is never settled means the
 * producer wrote an index event for a document it never journalled — a defect
 * upstream, and not a reason to grow a table without bound. The oldest go
 * first: they are the ones least likely to ever be answered.
 */
const PENDING_INDEX_LIMIT = 1000;

/** A stable hash of an instance key, for the primary key. */
export function hashKey(key: Readonly<Record<string, unknown>>): string {
  const canonical = Object.entries(key)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}\u0000${JSON.stringify(value ?? null)}`)
    .join("\u0001");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export class WatchStateStore {
  private readonly db: Database;
  private readonly ownsConnection: boolean;

  /** Where this store lives, so a caller can reopen it after a restart. */
  readonly path: string;

  /**
   * A store of its own, at `path`.
   *
   * Pass a connection instead — see {@link WatchStateStore.on} — when the file
   * has to be opened in a way this package cannot arrange.
   */
  constructor(path = ":memory:", attached?: Database) {
    this.path = path;
    this.ownsConnection = attached === undefined;
    if (attached) {
      this.db = attached;
    } else {
      this.db = new DatabaseConstructor(path);
      this.db.pragma("journal_mode = WAL");
    }
    this.db.exec(SCHEMA);
    this.addMissingColumns();
  }

  /**
   * Bring a store written by an older build up to the current shape.
   *
   * The other half of {@link SCHEMA}: those `CREATE TABLE IF NOT EXISTS`
   * statements are read only by a file that does not exist yet, and these are
   * read only by one that does. A column added above and not here is invisible
   * on every install already running, and the first query naming it fails
   * there and nowhere else.
   *
   * Exported as {@link STATE_COLUMN_ADDITIONS} so a test can hold the two
   * halves against each other rather than trusting them to be edited together.
   */
  private addMissingColumns(): void {
    for (const [table, additions] of Object.entries(STATE_COLUMN_ADDITIONS)) {
      addMissingColumns(this.db, table, additions);
    }
  }

  /**
   * A store over a connection the caller already holds.
   *
   * A host may need this file opened in a way the package cannot arrange —
   * keyed with an install's storage key, most obviously, since an encrypted
   * store is opened by a different driver than the plain one. Handing the
   * connection in keeps that decision where the keys are, and this class stops
   * owning a lifetime it did not create: `close()` becomes the caller's.
   */
  static on(db: Database, path = "(attached)"): WatchStateStore {
    return new WatchStateStore(path, db);
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  /**
   * Open a unit of work spanning one event.
   *
   * Everything an event changes — cells, timers, firings, the cursor — commits
   * together or not at all. A mutation that committed outside would be one a
   * crash could keep while the cursor stayed behind, and the replay would then
   * apply it twice.
   *
   * The transaction is opened explicitly rather than through better-sqlite3's
   * `transaction()` wrapper because dispatching an event is asynchronous (a SQL
   * node awaits a query) and that wrapper takes a synchronous function. Reads
   * inside still see the writes before them: it is one connection, used by one
   * engine. A second engine sharing one store file is not supported.
   */
  begin(): void {
    if (!this.db.inTransaction) this.db.prepare("BEGIN").run();
  }

  /**
   * Whether a unit of work is open.
   *
   * Exposed so the engine's central discipline — that nothing off this host is
   * called while a write transaction is held — is a thing a test can assert
   * rather than a thing a reader has to trace by hand.
   */
  get open(): boolean {
    return this.db.inTransaction;
  }

  commit(): void {
    if (this.db.inTransaction) this.db.prepare("COMMIT").run();
  }

  /** Discard a half-applied event, so the replay finds it untouched. */
  rollback(): void {
    if (this.db.inTransaction) this.db.prepare("ROLLBACK").run();
  }

  advanceCursor(watchId: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO consumer_cursor (watch_id, last_seq) VALUES (?, ?)
         ON CONFLICT (watch_id) DO UPDATE SET last_seq = max(last_seq, excluded.last_seq)`,
      )
      .run(watchId, seq);
  }

  /**
   * The furthest any watch has read.
   *
   * The maximum rather than the minimum: the question it answers is whether
   * the engine is turning at all, and one watch added at the journal head
   * legitimately sits far ahead of one catching up from a week ago. A minimum
   * would call a healthy engine stalled for as long as its slowest watch takes
   * to catch up.
   */
  evaluatedThroughSeq(): number {
    const row = this.db
      .prepare<[], { seq: number | null }>("SELECT MAX(last_seq) AS seq FROM consumer_cursor")
      .get();
    return row?.seq ?? 0;
  }

  cursor(watchId: string): number {
    const row = this.db
      .prepare("SELECT last_seq FROM consumer_cursor WHERE watch_id = ?")
      .get(watchId) as { last_seq: number } | undefined;
    return row?.last_seq ?? 0;
  }

  /**
   * What every watch is holding, in one read.
   *
   * For a list, where the per-watch snapshot is the wrong shape: that one
   * reads a watch's whole population to describe it cell by cell, and doing it
   * once per row would read the entire runtime to render a summary line. These
   * are three grouped counts over indexed columns instead.
   *
   * Keys rather than cells is the number a reader wants: a key is one thing the
   * watch is tracking, where a node holding three instances of one key is
   * still tracking one. Both are here because the two answer different
   * questions and only the caller knows which it is asking.
   *
   * A watch with nothing live is simply absent — the caller has the list of
   * watches and reads a miss as zero, which is a real answer rather than a
   * gap.
   *
   * `specs` is how each node type says which of its cells are holding something
   * rather than merely remembering it (see `holding.ts`). A node with no spec
   * counts as holding, so a caller with nothing to say about its node types
   * gets the whole population back as the held count.
   *
   * `nowMs` is the caller's, like every other instant this package takes: a
   * cooldown that is still suppressing and one that is spent are the same row
   * read against two different clocks, and a package that read its own could
   * not be replayed.
   */
  liveState(specs: readonly WatchHoldingSpec[], nowMs: number): Map<string, WatchLiveState> {
    const held = new Map<string, WatchLiveState>();
    const of = (watchId: string): WatchLiveState => {
      const found = held.get(watchId) ?? {
        keys: 0,
        cells: 0,
        holdingKeys: 0,
        holdingCells: 0,
        timers: 0,
        nextDueAtMs: null,
        cursorSeq: null,
      };
      held.set(watchId, found);
      return found;
    };
    this.db.exec(SPEC_TABLE);
    const spec = this.db.prepare<[string, string, string, number]>(
      `INSERT OR REPLACE INTO watch_holding_spec (watch_id, node_id, kind, ms) VALUES (?, ?, ?, ?)`,
    );
    this.db.prepare("DELETE FROM watch_holding_spec").run();
    for (const entry of specs) spec.run(...specRow(entry));
    const cells = this.db
      .prepare<
        Record<string, string | number>,
        {
          watch_id: string;
          keys: number;
          cells: number;
          holding_keys: number;
          holding_cells: number;
        }
      >(
        `WITH cell AS (
                SELECT c.watch_id AS watch_id, c.key_hash AS key_hash, ${HOLDING_SQL} AS holding
                  FROM node_cells c
                  LEFT JOIN watch_holding_spec s
                    ON s.watch_id = c.watch_id AND s.node_id = c.node_id
              )
         SELECT watch_id,
                COUNT(DISTINCT key_hash) AS keys,
                COUNT(*) AS cells,
                COUNT(DISTINCT CASE WHEN holding THEN key_hash END) AS holding_keys,
                SUM(CASE WHEN holding THEN 1 ELSE 0 END) AS holding_cells
           FROM cell GROUP BY watch_id`,
      )
      .all({ now: nowMs });
    for (const row of cells) {
      const state = of(row.watch_id);
      state.keys = row.keys;
      state.cells = row.cells;
      state.holdingKeys = row.holding_keys;
      state.holdingCells = row.holding_cells;
    }
    const timers = this.db
      .prepare<[], { watch_id: string; timers: number; next: number | null }>(
        `SELECT watch_id, COUNT(*) AS timers, MIN(due_at_ms) AS next
           FROM timers GROUP BY watch_id`,
      )
      .all();
    for (const row of timers) {
      const state = of(row.watch_id);
      state.timers = row.timers;
      state.nextDueAtMs = row.next;
    }
    // Read here rather than left to a per-watch call, so every number on a row
    // comes out of the same turn. A cursor fetched separately could be read
    // after an event this count was taken before, and the row would report a
    // watch as caught up on a population it no longer holds.
    const cursors = this.db
      .prepare<
        [],
        { watch_id: string; last_seq: number }
      >("SELECT watch_id, last_seq FROM consumer_cursor")
      .all();
    for (const row of cursors) of(row.watch_id).cursorSeq = row.last_seq;
    return held;
  }

  // --- cells ---------------------------------------------------------------

  /** The cells live for one key, oldest instance first. */
  cellsForKey(watchId: string, nodeId: string, keyHash: string): NodeCell[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM node_cells WHERE watch_id = ? AND node_id = ? AND key_hash = ?
         ORDER BY instance`,
      )
      .all(watchId, nodeId, keyHash) as Record<string, unknown>[];
    return rows.map(toCell);
  }

  /**
   * The single cell a key holds, for every node that keeps at most one. Throws
   * rather than guessing if a node that should keep one holds several — that is
   * a state-model bug, and picking a cell would hide it.
   */
  cell(watchId: string, nodeId: string, keyHash: string): NodeCell | null {
    const cells = this.cellsForKey(watchId, nodeId, keyHash);
    if (cells.length > 1) {
      throw new Error(
        `${nodeId} holds ${cells.length} instances for one key but keeps at most one.`,
      );
    }
    return cells[0] ?? null;
  }

  /** The next free instance ordinal for a key. */
  nextInstance(watchId: string, nodeId: string, keyHash: string): number {
    const row = this.db
      .prepare(
        `SELECT coalesce(max(instance), -1) + 1 AS next FROM node_cells
         WHERE watch_id = ? AND node_id = ? AND key_hash = ?`,
      )
      .get(watchId, nodeId, keyHash) as { next: number };
    return row.next;
  }

  cellsFor(watchId: string, nodeId: string): NodeCell[] {
    const rows = this.db
      .prepare("SELECT * FROM node_cells WHERE watch_id = ? AND node_id = ? ORDER BY key_hash")
      .all(watchId, nodeId) as Record<string, unknown>[];
    return rows.map(toCell);
  }

  putCell(cell: NodeCell): void {
    this.db
      .prepare(
        `INSERT INTO node_cells
           (watch_id, node_id, key_hash, instance, key_json, state, armed_at_ms, deadline_at_ms,
            level, slots_json, payload_json, last_fired_at_ms, arrivals_json, provenance_json,
            held_since_ms)
         VALUES (@watch_id, @node_id, @key_hash, @instance, @key_json, @state, @armed_at_ms,
                 @deadline_at_ms, @level, @slots_json, @payload_json, @last_fired_at_ms,
                 @arrivals_json, @provenance_json, @held_since_ms)
         ON CONFLICT (watch_id, node_id, key_hash, instance) DO UPDATE SET
           state = excluded.state,
           armed_at_ms = excluded.armed_at_ms,
           deadline_at_ms = excluded.deadline_at_ms,
           level = excluded.level,
           slots_json = excluded.slots_json,
           payload_json = excluded.payload_json,
           last_fired_at_ms = excluded.last_fired_at_ms,
           arrivals_json = excluded.arrivals_json,
           provenance_json = excluded.provenance_json,
           held_since_ms = excluded.held_since_ms`,
      )
      .run({
        watch_id: cell.watchId,
        node_id: cell.nodeId,
        key_hash: cell.keyHash,
        instance: cell.instance,
        key_json: JSON.stringify(cell.key),
        state: cell.state,
        armed_at_ms: cell.armedAtMs,
        deadline_at_ms: cell.deadlineAtMs,
        level: cell.level === null ? null : cell.level ? 1 : 0,
        slots_json: JSON.stringify(cell.slots),
        payload_json: JSON.stringify(cell.payload),
        last_fired_at_ms: cell.lastFiredAtMs,
        arrivals_json: JSON.stringify(cell.arrivals),
        provenance_json: JSON.stringify(cell.provenance),
        held_since_ms: cell.heldSinceMs,
      });
  }

  dropCell(watchId: string, nodeId: string, keyHash: string, instance: number): void {
    this.db
      .prepare(
        "DELETE FROM node_cells WHERE watch_id = ? AND node_id = ? AND key_hash = ? AND instance = ?",
      )
      .run(watchId, nodeId, keyHash, instance);
    this.clearTimers(watchId, nodeId, keyHash, instance);
  }

  // --- timers --------------------------------------------------------------

  /**
   * Schedule a timer only if that slot is empty.
   *
   * Arming a recurring source on start must not disturb a tick the store is
   * already holding: a run that crashed before its first event committed still
   * has the boundaries it fired, and moving the tick back to where a fresh run
   * would put it makes every one of them fire again.
   */
  setTimerIfAbsent(timer: TimerRow): void {
    const existing = this.db
      .prepare(
        `SELECT 1 FROM timers
         WHERE watch_id = ? AND node_id = ? AND key_hash = ? AND instance = ? AND kind = ?`,
      )
      .get(timer.watchId, timer.nodeId, timer.keyHash, timer.instance, timer.kind);
    if (existing === undefined) this.setTimer(timer);
  }

  setTimer(timer: TimerRow): void {
    this.db
      .prepare(
        `INSERT INTO timers (watch_id, node_id, key_hash, instance, kind, key_json, due_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (watch_id, node_id, key_hash, instance, kind)
           DO UPDATE SET due_at_ms = excluded.due_at_ms`,
      )
      .run(
        timer.watchId,
        timer.nodeId,
        timer.keyHash,
        timer.instance,
        timer.kind,
        JSON.stringify(timer.key),
        timer.dueAtMs,
      );
  }

  /**
   * Timers due at or before `atMs`, oldest first. Ordering by due time and then
   * by node makes catch-up after downtime deterministic: the same outage
   * produces the same sequence of expiries every run.
   */
  dueTimers(watchId: string, atMs: number): TimerRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM timers WHERE watch_id = ? AND due_at_ms <= ?
         ORDER BY due_at_ms, node_id, key_hash, instance, kind`,
      )
      .all(watchId, atMs) as Record<string, unknown>[];
    return rows.map((row) => ({
      watchId: row.watch_id as string,
      nodeId: row.node_id as string,
      keyHash: row.key_hash as string,
      instance: row.instance as number,
      key: JSON.parse(row.key_json as string) as Record<string, unknown>,
      dueAtMs: row.due_at_ms as number,
      kind: row.kind as TimerRow["kind"],
    }));
  }

  clearTimer(
    watchId: string,
    nodeId: string,
    keyHash: string,
    instance: number,
    kind: TimerRow["kind"],
  ): void {
    this.db
      .prepare(
        `DELETE FROM timers WHERE watch_id = ? AND node_id = ? AND key_hash = ?
         AND instance = ? AND kind = ?`,
      )
      .run(watchId, nodeId, keyHash, instance, kind);
  }

  clearTimers(watchId: string, nodeId: string, keyHash: string, instance: number): void {
    this.db
      .prepare(
        "DELETE FROM timers WHERE watch_id = ? AND node_id = ? AND key_hash = ? AND instance = ?",
      )
      .run(watchId, nodeId, keyHash, instance);
  }

  // --- firings and activity ------------------------------------------------

  /**
   * Record a firing. Returns whether it was new: a replayed event re-attempts
   * the same `(seq, node, key)` and the unique constraint discards it, which is
   * what stops a resume from double-counting.
   */
  recordFiring(
    watchId: string,
    seq: number,
    nodeId: string,
    keyHash: string,
    firedAt: string,
    payload: unknown,
    noticedAt: string | null,
    documentIds: readonly string[],
    /** True only when an operator fired the watch by hand. */
    forced = false,
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO watch_firings
           (watch_id, seq, node_id, key_hash, fired_at, noticed_at, payload_json, document_ids, forced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        watchId,
        seq,
        nodeId,
        keyHash,
        firedAt,
        noticedAt,
        JSON.stringify(payload),
        JSON.stringify(documentIds),
        forced ? 1 : null,
      );
    return result.changes > 0;
  }

  /**
   * Every firing recorded for a watch, in order. Survives a restart.
   *
   * Two times, because they answer different questions and can be far apart.
   *
   * `firedAt` is the *subject's* time. The engine runs on journal time so that
   * a replay reaches the same answers, so a firing is stamped with when the
   * thing it is about happened.
   *
   * `noticedAt` is when the journal saw the event that caused it. For most
   * watches the two are the same instant; for a watch about something that
   * already had a date of its own they are not. A calendar event created in
   * June and moved today has a semantic time in June, so its firing is stamped
   * June — which, read as a ledger of when a watch spoke, says the watch fired
   * last month.
   *
   * It arrives as data on the journal event rather than from a clock: this
   * package reads none, so that a replay of the same journal reaches the same
   * answers.
   *
   * Null for firings recorded before this was kept.
   */
  firings(
    watchId: string,
    /** How many of the most recent to decode. Every one of them when absent. */
    limit?: number,
  ): {
    seq: number;
    /** The node and key-instance that fired: with `seq`, the firing's identity. */
    nodeId: string;
    keyHash: string;
    firedAt: string;
    noticedAt: string | null;
    payload: unknown;
    /** Empty for a firing recorded before documents were kept, and for one
     * reached through no document at all — a clock, a row, a deadline. */
    documentIds: string[];
    /**
     * True when an operator fired this watch by hand.
     *
     * Carried out of the store rather than left to a trace lookup, because
     * every surface that lists firings has to be able to say which ones the
     * runtime reached on its own — a forced firing that read as organic would
     * be a watch appearing to have caught something it never saw.
     */
    forced: boolean;
  }[] {
    // Bounded at the store, newest first, then handed back oldest-first, which
    // is the order every caller reads. Unbounded, this decoded every payload a
    // watch had ever recorded so a route could keep the last twenty: free at a
    // few hundred rows, and a year of a chatty watch otherwise. Ordered by
    // `rowid` rather than `seq`, because a forced or timer firing carries a
    // negative sequence and insertion order is what "most recent" means here.
    const rows = (
      this.db
        .prepare(
          `SELECT seq, node_id, key_hash, fired_at, noticed_at, payload_json, document_ids, forced
             FROM watch_firings WHERE watch_id = ? ORDER BY rowid DESC LIMIT ?`,
        )
        .all(watchId, limit ?? -1) as Record<string, unknown>[]
    ).reverse();
    return rows.map((row) => ({
      seq: row.seq as number,
      nodeId: row.node_id as string,
      keyHash: row.key_hash as string,
      firedAt: row.fired_at as string,
      noticedAt: (row.noticed_at as string | null) ?? null,
      payload: JSON.parse(row.payload_json as string) as unknown,
      documentIds: parseDocumentIds(row.document_ids),
      forced: row.forced === 1,
    }));
  }

  /**
   * How many times a watch has *caught* something, without decoding any of it.
   *
   * Forced firings are excluded. They are the operator asking to see where a
   * firing goes, and this number is read on a listing as "what this watch has
   * found" — a watch credited with catching something it never saw is a watch
   * that looks like it works. The detail view lists them, marked, so the count
   * and the ledger are reconcilable rather than in disagreement.
   */
  firingCount(watchId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM watch_firings WHERE watch_id = ? AND forced IS NULL")
      .get(watchId) as { n: number };
    return row.n;
  }

  /**
   * What every watch has caught, and when it last did, in one read.
   *
   * The per-watch count above is a seek on the unique index and cheap enough,
   * but a listing asks it once per row and then has no way at all to ask when
   * — and "has never fired" and "fired last March" are the same number on a
   * page that only counts. A watch that has caught nothing is absent, the way
   * {@link liveState} treats a watch holding nothing.
   *
   * `noticed_at` rather than `fired_at`, and the difference is the whole
   * usefulness of the number. `fired_at` is the *subject's* time — a calendar
   * event created in June and moved today has a semantic time in June — so a
   * watch that spoke this morning about an old document would report having
   * last fired months ago, which reads as a watch that has stopped. What a
   * reader means by "last fired" is when the watch spoke. `fired_at` is the
   * fallback for rows written before `noticed_at` existed, which is the only
   * answer those rows can give.
   */
  firingSummaryAll(): Map<string, { count: number; lastFiredAtMs: number | null }> {
    const rows = this.db
      .prepare(
        `SELECT watch_id, COUNT(*) AS n, MAX(COALESCE(noticed_at, fired_at)) AS last_fired_at
           FROM watch_firings
          WHERE forced IS NULL
          GROUP BY watch_id`,
      )
      .all() as { watch_id: string; n: number; last_fired_at: string | null }[];
    const out = new Map<string, { count: number; lastFiredAtMs: number | null }>();
    for (const row of rows) {
      const at = row.last_fired_at === null ? NaN : Date.parse(row.last_fired_at);
      out.set(row.watch_id, {
        count: row.n,
        lastFiredAtMs: Number.isFinite(at) ? at : null,
      });
    }
    return out;
  }

  /** The next timer sequence number, consumed atomically. */
  takeTimerSeq(watchId: string): number {
    this.db
      .prepare(
        `INSERT INTO watch_state (watch_id, active) VALUES (?, 1)
         ON CONFLICT (watch_id) DO NOTHING`,
      )
      .run(watchId);
    const row = this.db
      .prepare("SELECT next_timer_seq AS seq FROM watch_state WHERE watch_id = ?")
      .get(watchId) as { seq: number };
    this.db
      .prepare("UPDATE watch_state SET next_timer_seq = next_timer_seq - 1 WHERE watch_id = ?")
      .run(watchId);
    return row.seq;
  }

  /**
   * Erase everything held for a watch.
   *
   * What `remove` has to mean, or a watch's cursor, its record of which
   * documents it has already looked at, its live instances, its parked
   * nominations and its firings outlive it — and the next watch to be given the
   * same identity would inherit all of them.
   */
  forget(watchId: string): void {
    // `delivery_counts` is deliberately not in the list below. It is a ledger of
    // how often a person has been interrupted today, not state belonging to the
    // watch — clearing it would give every *other* watch its allowance back
    // because one was removed, and re-adding the removed one would mint it a
    // fresh five. A stale row is a small integer that ages out with the day.
    for (const table of [
      "node_cells",
      "timers",
      "watch_firings",
      "consumer_cursor",
      "watch_state",
      "node_looks",
      "pending_nominations",
      "pending_index",
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE watch_id = ?`).run(watchId);
    }
  }

  /**
   * Let a watch run, or stop it.
   *
   * Letting one run clears whatever stopped it: a recorded failure describes
   * *why the watch is not running*, so keeping it against a watch that is
   * would make the next reader diagnose a fault that has been dealt with.
   */
  setActive(watchId: string, active: boolean): void {
    this.db
      .prepare(
        `INSERT INTO watch_state (watch_id, active) VALUES (?, ?)
         ON CONFLICT (watch_id) DO UPDATE SET active = excluded.active`,
      )
      .run(watchId, active ? 1 : 0);
    if (active) this.clearFailure(watchId);
  }

  /**
   * Stop a watch and say why, in one statement.
   *
   * The two halves cannot be separate writes. Stopping a watch and recording
   * the reason are the same fact, and a crash between two statements would
   * leave a watch that is visibly stopped and cannot say what stopped it —
   * which is the state this record exists to make impossible, and which then
   * makes every recovery path refuse for want of a reason to act on.
   */
  recordFailure(watchId: string, failure: WatchFailure): void {
    this.db
      .prepare(
        `INSERT INTO watch_state (watch_id, active, failed_seq, failed_node, failed_class)
         VALUES (?, 0, ?, ?, ?)
         ON CONFLICT (watch_id) DO UPDATE SET
           active = 0,
           failed_seq = excluded.failed_seq,
           failed_node = excluded.failed_node,
           failed_class = excluded.failed_class`,
      )
      .run(watchId, failure.seq, failure.nodeId, failure.failure);
  }

  clearFailure(watchId: string): void {
    this.db
      .prepare(
        `UPDATE watch_state SET failed_seq = NULL, failed_node = NULL, failed_class = NULL
         WHERE watch_id = ?`,
      )
      .run(watchId);
  }

  /** What stopped this watch, or null if nothing did. */
  failure(watchId: string): WatchFailure | null {
    const row = this.db
      .prepare("SELECT failed_seq, failed_node, failed_class FROM watch_state WHERE watch_id = ?")
      .get(watchId) as
      | { failed_seq: number | null; failed_node: string | null; failed_class: string | null }
      | undefined;
    if (!row || row.failed_seq === null || row.failed_node === null) return null;
    return {
      seq: row.failed_seq,
      nodeId: row.failed_node,
      failure: isFailureClass(row.failed_class) ? row.failed_class : "internal",
    };
  }

  isActive(watchId: string): boolean {
    const row = this.db
      .prepare("SELECT active FROM watch_state WHERE watch_id = ?")
      .get(watchId) as { active: number } | undefined;
    return row === undefined || row.active === 1;
  }

  // --- nomination ----------------------------------------------------------

  /**
   * Which document event this node last looked at this document on, or `null`
   * if it never has.
   *
   * Read inside the same transaction as the firing it decides, so a crash
   * between looking and speaking leaves both undone.
   */
  lookedOn(watchId: string, nodeId: string, docId: string): number | null {
    const row = this.db
      .prepare("SELECT looked_on FROM node_looks WHERE watch_id = ? AND node_id = ? AND doc_id = ?")
      .get(watchId, nodeId, docId) as { looked_on: number } | undefined;
    return row?.looked_on ?? null;
  }

  /** Record that this node has now looked at this document at this event. */
  recordLook(watchId: string, nodeId: string, docId: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO node_looks (watch_id, node_id, doc_id, looked_on) VALUES (?, ?, ?, ?)
           ON CONFLICT(watch_id, node_id, doc_id) DO UPDATE SET looked_on = excluded.looked_on`,
      )
      .run(watchId, nodeId, docId, seq);
  }

  /**
   * Park a nomination the judge could not afford, to be reconsidered later.
   *
   * Keyed by (watch, node, document) so a document nominated twice before the
   * queue drains occupies one slot rather than two. The later sequence wins:
   * it is the more recent revision of the document, and judging the older one
   * would decide about text that has since changed. Its instant moves with it —
   * assigning the two independently would judge one revision and anchor
   * whatever it fires on the other one's clock.
   */
  parkNomination(
    watchId: string,
    nodeId: string,
    docId: string,
    seq: number,
    atMs: number,
    observedAt: string | null = null,
    retryAtMs = 0,
  ): void {
    this.db
      .prepare(
        `INSERT INTO pending_nominations
           (watch_id, node_id, doc_id, seq, at_ms, observed_at, retry_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(watch_id, node_id, doc_id) DO UPDATE SET
             at_ms = CASE WHEN excluded.seq > seq THEN excluded.at_ms ELSE at_ms END,
             observed_at =
               CASE WHEN excluded.seq > seq THEN excluded.observed_at ELSE observed_at END,
             retry_at_ms = CASE
               WHEN excluded.seq >= seq THEN excluded.retry_at_ms ELSE retry_at_ms END,
             seq = max(seq, excluded.seq)`,
      )
      .run(watchId, nodeId, docId, seq, atMs, observedAt, retryAtMs);
  }

  /** Parked nominations for a watch, oldest first — the order they drain in. */
  pendingNominations(watchId: string, limit: number): PendingNomination[] {
    return (
      this.db
        .prepare(
          `SELECT node_id, doc_id, seq, at_ms, observed_at, retry_at_ms FROM pending_nominations
            WHERE watch_id = ? ORDER BY seq, node_id LIMIT ?`,
        )
        .all(watchId, limit) as Record<string, unknown>[]
    ).map((row) => ({
      nodeId: row.node_id as string,
      docId: row.doc_id as string,
      seq: row.seq as number,
      atMs: row.at_ms as number,
      observedAt: (row.observed_at as string | null) ?? null,
      retryAtMs: (row.retry_at_ms as number | null) ?? 0,
    }));
  }

  /** Keep an unanswered nomination parked until the provider says to retry. */
  rescheduleNomination(watchId: string, nodeId: string, docId: string, retryAtMs: number): void {
    this.db
      .prepare(
        `UPDATE pending_nominations SET retry_at_ms = ?
          WHERE watch_id = ? AND node_id = ? AND doc_id = ?`,
      )
      .run(retryAtMs, watchId, nodeId, docId);
  }

  clearNomination(watchId: string, nodeId: string, docId: string): void {
    this.db
      .prepare("DELETE FROM pending_nominations WHERE watch_id = ? AND node_id = ? AND doc_id = ?")
      .run(watchId, nodeId, docId);
  }

  /** How many nominations are still waiting on budget, for the shadow report. */
  pendingCount(watchId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM pending_nominations WHERE watch_id = ?")
      .get(watchId) as { n: number };
    return row.n;
  }

  // --- index events awaiting their document --------------------------------

  /**
   * Remember an index event whose document has not been journalled yet.
   *
   * One slot per document: a document indexed twice before it lands is still
   * one document to consider, and the earlier sequence is kept because it is
   * the one that first said this document had become scorable.
   *
   * The oldest are dropped past the limit. An entry that is never settled means
   * an index event was written for a document that never arrived, which is a
   * defect upstream rather than a reason to hold rows forever.
   */
  parkIndex(watchId: string, docId: string, seq: number): number {
    this.db
      .prepare(
        `INSERT INTO pending_index (watch_id, doc_id, seq) VALUES (?, ?, ?)
           ON CONFLICT(watch_id, doc_id) DO UPDATE SET seq = min(seq, excluded.seq)`,
      )
      .run(watchId, docId, seq);
    const evicted = this.db
      .prepare(
        `DELETE FROM pending_index
          WHERE watch_id = ?
            AND doc_id NOT IN (
              SELECT doc_id FROM pending_index WHERE watch_id = ? ORDER BY seq DESC LIMIT ?
            )`,
      )
      .run(watchId, watchId, PENDING_INDEX_LIMIT);
    // Reported rather than swallowed. An eviction is a document this watch
    // will now never consider, which is the outcome the queue exists to
    // prevent — so it has to be visible to the caller that can say so.
    return evicted.changes;
  }

  /**
   * The sequence of an index event still waiting on this document, or null.
   *
   * Consumed by the arrival of the document itself, which is why it is read and
   * cleared in the same transaction as the decision it lets the node make.
   */
  indexOwed(watchId: string, docId: string): number | null {
    const row = this.db
      .prepare("SELECT seq FROM pending_index WHERE watch_id = ? AND doc_id = ?")
      .get(watchId, docId) as { seq: number } | undefined;
    return row?.seq ?? null;
  }

  clearIndex(watchId: string, docId: string): void {
    this.db
      .prepare("DELETE FROM pending_index WHERE watch_id = ? AND doc_id = ?")
      .run(watchId, docId);
  }

  /** How many index events are still waiting on their documents. */
  pendingIndexCount(watchId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM pending_index WHERE watch_id = ?")
      .get(watchId) as { n: number };
    return row.n;
  }

  // --- delivery ------------------------------------------------------------

  /** How many agents this watch has woken on this day. */
  wokeOn(watchId: string, day: string): number {
    const row = this.db
      .prepare("SELECT sent FROM wake_counts WHERE watch_id = ? AND day = ?")
      .get(watchId, day) as { sent: number } | undefined;
    return row?.sent ?? 0;
  }

  /** How many every watch together has woken on this day. */
  wokeAllOn(day: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(sent), 0) AS n FROM wake_counts WHERE day = ?")
      .get(day) as { n: number };
    return row.n;
  }

  /** Count one wake against a watch's day, on the same terms as a notification. */
  recordWake(watchId: string, day: string): void {
    this.db
      .prepare(
        `INSERT INTO wake_counts (watch_id, day, sent) VALUES (?, ?, 1)
           ON CONFLICT(watch_id, day) DO UPDATE SET sent = sent + 1`,
      )
      .run(watchId, day);
  }

  /** How many notifications this watch has sent on this day. */
  deliveredOn(watchId: string, day: string): number {
    const row = this.db
      .prepare("SELECT sent FROM delivery_counts WHERE watch_id = ? AND day = ?")
      .get(watchId, day) as { sent: number } | undefined;
    return row?.sent ?? 0;
  }

  /**
   * How many deliveries in an instant range arrived as less than they should have.
   *
   * Counted off the outcome rows rather than off `delivery_counts`, which
   * knows only how much allowance was spent. The host supplies the UTC instant
   * bounds of its local day; ISO instants sort chronologically, including on
   * 23-hour and 25-hour DST days.
   *
   * `excluding` names degrade classes that are not, on this install, a degrade
   * at all. Which classes those are is a question about how the host is wired
   * and the runtime has no way to answer it, so the host says — the rows are
   * kept either way, and only the count changes.
   */
  degradedBetween(startAt: string, endAt: string, excluding: readonly string[] = []): number {
    const placeholders = excluding.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM watch_deliveries
           WHERE degraded IS NOT NULL AND at >= ? AND at < ?
           ${excluding.length === 0 ? "" : `AND degraded NOT IN (${placeholders})`}`,
      )
      .get(startAt, endAt, ...excluding) as { n: number };
    return row.n;
  }

  /** How many every watch together has sent on this day. */
  deliveredAllOn(day: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(sent), 0) AS n FROM delivery_counts WHERE day = ?")
      .get(day) as { n: number };
    return row.n;
  }

  /**
   * Count one notification against a watch's day.
   *
   * Recorded when the send is *attempted*, not when it is accepted. A cap
   * exists to bound how often a person is interrupted, and a push that reached
   * APNs has already spent that budget whatever the device did with it.
   */
  /**
   * What one attempt to deliver a firing did.
   *
   * Separate from {@link recordDelivery}, which counts against a daily cap and
   * knows nothing about outcomes. This is the answer to "it did not arrive —
   * did it try?", and it is written for a failure as readily as a success.
   */
  recordDeliveryOutcome(input: {
    watchId: string;
    seq: number;
    nodeId: string;
    keyHash: string;
    kind: string;
    attempted: number | null;
    delivered: number;
    error: string | null;
    degraded: string | null;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO watch_deliveries
           (watch_id, seq, node_id, key_hash, kind, attempted, delivered, error, degraded, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(watch_id, seq, node_id, key_hash) DO UPDATE SET
           kind = excluded.kind,
           attempted = COALESCE(watch_deliveries.retry_attempted, excluded.attempted),
           delivered = COALESCE(watch_deliveries.retry_delivered, excluded.delivered),
           error = CASE WHEN watch_deliveries.retry_attempted IS NULL
                        THEN excluded.error ELSE watch_deliveries.retry_error END,
           degraded = excluded.degraded, at = excluded.at`,
      )
      .run(
        input.watchId,
        input.seq,
        input.nodeId,
        input.keyHash,
        input.kind,
        input.attempted,
        input.delivered,
        input.error,
        input.degraded,
        input.at,
      );
  }

  /** Persist the latest durable wake result, even if the initial row is not written yet. */
  recordDeliveryRetryOutcome(input: {
    watchId: string;
    seq: number;
    nodeId: string;
    keyHash: string;
    attempted: number;
    delivered: number;
    error: string | null;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO watch_deliveries
           (watch_id, seq, node_id, key_hash, kind, attempted, delivered, error, degraded, at,
            retry_attempted, retry_delivered, retry_error)
         VALUES (?, ?, ?, ?, 'omnesis-notify', ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(watch_id, seq, node_id, key_hash) DO UPDATE SET
           attempted = excluded.attempted,
           delivered = excluded.delivered,
           error = excluded.error,
           retry_attempted = excluded.retry_attempted,
           retry_delivered = excluded.retry_delivered,
           retry_error = excluded.retry_error
         WHERE watch_deliveries.retry_attempted IS NOT excluded.retry_attempted
            OR watch_deliveries.retry_delivered IS NOT excluded.retry_delivered
            OR watch_deliveries.retry_error IS NOT excluded.retry_error`,
      )
      .run(
        input.watchId,
        input.seq,
        input.nodeId,
        input.keyHash,
        input.attempted,
        input.delivered,
        input.error,
        input.at,
        input.attempted,
        input.delivered,
        input.error,
      );
  }

  /** Every delivery a watch has attempted, oldest first, like its firings. */
  deliveries(watchId: string): {
    seq: number;
    nodeId: string;
    keyHash: string;
    kind: string;
    attempted: number | null;
    delivered: number;
    error: string | null;
    degraded: string | null;
    at: string;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT seq, node_id, key_hash, kind, attempted, delivered, error, degraded, at
           FROM watch_deliveries WHERE watch_id = ? ORDER BY rowid`,
      )
      .all(watchId) as Record<string, unknown>[];
    return rows.map((row) => ({
      seq: row.seq as number,
      nodeId: row.node_id as string,
      keyHash: row.key_hash as string,
      kind: row.kind as string,
      attempted: (row.attempted as number | null) ?? null,
      delivered: row.delivered as number,
      error: (row.error as string | null) ?? null,
      degraded: (row.degraded as string | null) ?? null,
      at: row.at as string,
    }));
  }

  recordDelivery(watchId: string, day: string): void {
    this.db
      .prepare(
        `INSERT INTO delivery_counts (watch_id, day, sent) VALUES (?, ?, 1)
           ON CONFLICT(watch_id, day) DO UPDATE SET sent = sent + 1`,
      )
      .run(watchId, day);
  }
}

/** A nomination waiting for judge budget. */
export interface PendingNomination {
  readonly nodeId: string;
  readonly docId: string;
  /** The `doc.indexed` sequence it was nominated at. */
  readonly seq: number;
  readonly atMs: number;
  /**
   * When the journal saw the event that nominated it, or null for a row parked
   * before this was kept.
   */
  readonly observedAt: string | null;
  /** Earliest wall-clock instant at which the judge should be retried. */
  readonly retryAtMs: number;
}

function toCell(row: Record<string, unknown>): NodeCell {
  return {
    watchId: row.watch_id as string,
    nodeId: row.node_id as string,
    keyHash: row.key_hash as string,
    instance: row.instance as number,
    key: JSON.parse(row.key_json as string) as Record<string, unknown>,
    state: row.state as NodeCell["state"],
    heldSinceMs: (row.held_since_ms as number | null) ?? null,
    armedAtMs: row.armed_at_ms as number,
    deadlineAtMs: (row.deadline_at_ms as number | null) ?? null,
    level: row.level === null ? null : row.level === 1,
    slots: JSON.parse(row.slots_json as string) as NodeCell["slots"],
    payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
    lastFiredAtMs: (row.last_fired_at_ms as number | null) ?? null,
    arrivals: JSON.parse(row.arrivals_json as string) as number[],
    provenance: JSON.parse(
      (row.provenance_json as string | null) ?? "{}",
    ) as NodeCell["provenance"],
  };
}

/**
 * The documents a firing was reached through, read defensively.
 *
 * Null for a row written before the column existed, which is a different fact
 * from "no documents" but reads the same to a caller — neither can be shown
 * anything, and inventing a distinction here would put it in the UI too.
 */
function parseDocumentIds(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

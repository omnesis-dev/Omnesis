// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The evaluation engine.
 *
 * One loop drives everything: take the next event, let it arm whatever source
 * nodes match, and propagate the resulting signals down to the sink. Live
 * evaluation and backtesting are the same loop; they differ only in how fast
 * events arrive and in what the judge does.
 *
 * Four properties are load-bearing.
 *
 * **Timers are events.** A due-gate coming due is journaled like anything else,
 * with its own sequence number, and dispatched through the same path. That is
 * what makes "a backtest replays time" true rather than aspirational: time is
 * not a side effect of running, it is entries in the sequence. A deadline that
 * came due during an outage is caught up on the way back — once, at its due
 * instant, not once per missed boundary.
 *
 * **A key decides identity, and an instance decides which one.** Every arm
 * computes a key from the arriving payload and the cancel edge computes one the
 * same way, so an arm and a cancel that disagree can never meet. Under `spawn`
 * a key can hold several live instances at once, and each carries its own
 * payload — which is why nothing here keeps a per-node "last output": with two
 * live keys, a global last-write would hand the firing instance the other one's
 * data.
 *
 * **A cancel at the same instant as a deadline wins.** They are simultaneous
 * only in semantic time; the cancel is an observation about the world and the
 * deadline is the absence of one, so an arriving cancel is the better evidence.
 * Concretely: cancels are delivered before due timers are swept at each instant.
 *
 * **A failing instance pauses the watch; it never aborts the run.** A query
 * that throws is a defect in one watch, and losing the whole replay — along
 * with the trace that would explain it — makes that defect harder to find, not
 * safer.
 *
 * **No off-host call is made while a write transaction is open.** An event's
 * effects and its cursor advance commit together, so the transaction is held
 * for as long as the event takes to evaluate — and a judge or a recall scorer
 * is a network call that can take a minute. A host running this beside anything
 * else that writes the same file would have that writer blocked for the whole
 * call, and a store whose writes are synchronous blocks its thread rather than
 * merely waiting.
 *
 * So evaluation never awaits a provider. It asks for the answer; if the answer
 * is not already held, it raises {@link NeedsOffHost}, the attempt is rolled
 * back and the trace rewound, the answer is fetched with no transaction open,
 * and the event is evaluated again from exactly the state it started in.
 * Evaluation is deterministic given (state, event, answers), so the retry
 * reaches the same point and proceeds. What is inside a transaction is then
 * bounded by local work, which is the property the arrangement exists for.
 */

import { sourceIdAddresses } from "@omnesis/types";
import { nodeInputs } from "../dsl/schema.js";
import { durationMs, parseDuration, type Duration } from "../time/duration.js";
import { nextCronOccurrence, parseCron } from "../time/cron.js";
import { isKind, type DocEvent, type JournalEvent } from "../journal/event.js";
import { isAnalyticsColumnType } from "../ontology/snapshot.js";
import { VirtualClock } from "./clock.js";
import { evaluateMap, evaluatePredicate, type EvaluationScope } from "./evaluate.js";
import { hashKey, WatchStateStore, type NodeCell, type WatchFailure } from "./state.js";
import {
  renderKey,
  SINGLETON_KEY,
  TraceRecorder,
  type FailureClass,
  type TraceMark,
  type WatchTrace,
} from "./trace.js";
import { containsTerm, normalizeForMatch } from "./lexical.js";
import type { WatchValueTypes } from "../validator/diagnostics.js";
import type { ValueType } from "../dsl/value-type.js";
import type { QueryResult, SqlParameter } from "../universe/analytics.js";
import type { AnalyticsTableSnapshot, Ontology } from "../ontology/snapshot.js";
import type { WatchDefinition, WatchNode } from "../dsl/schema.js";
import type {
  JudgeProvider,
  JudgeRequest,
  JudgeVerdict,
  RecallRequest,
  RecallScorer,
} from "./providers.js";

/**
 * The analytics store, as the engine needs it.
 *
 * `query` is the whole of what evaluation asks for. `applyRow` is the other
 * half of a specific arrangement: when the store is *built from the journal* —
 * a fixture universe materialized by replaying it — the engine has to write
 * each row in as it walks past, so a SQL node never reads a row from its own
 * future.
 *
 * A store that lives beside the journal rather than downstream of it omits
 * `applyRow`, and its absence is the declaration: the rows are already there,
 * the engine must not write them, and there is nothing for a resumed run to
 * rebuild.
 */
export interface AnalyticsPort {
  query(sql: string, values?: Readonly<Record<string, SqlParameter>>): Promise<QueryResult>;
  applyRow?(table: AnalyticsTableSnapshot, row: Readonly<Record<string, unknown>>): Promise<void>;
}

/** A document event the journal holds, and where it sits in the sequence. */
export interface JournalDocument {
  readonly event: DocEvent;
  readonly seq: number;
}

export interface EngineOptions {
  readonly watch: WatchDefinition;
  /**
   * The identity every piece of durable state is kept under. Defaults to the
   * DSL's name.
   *
   * A run that owns its store has only one name for a watch and the DSL's will
   * do. A host that lets an operator remove a watch and add another by the same
   * name needs its own, or the second inherits the first's cursor, its record
   * of which documents it has already looked at, its firings, and — if the
   * first retired — its retirement, which it would be stamped with before
   * seeing a single event.
   */
  readonly watchId?: string;
  /**
   * What the validator worked out this watch's values are, from `validateWatch`.
   *
   * Optional so a caller that never runs a `sql` node need not thread it, and
   * because a run over a hand-built definition may not have validated at all.
   * Absent, a reference binds on the shape of its value — which is how a
   * decimal that crossed the journal as a string binds VARCHAR and stops the
   * watch in the binder.
   */
  readonly valueTypes?: WatchValueTypes;
  readonly ontology: Ontology;
  readonly journal: readonly JournalEvent[];
  /**
   * Asked between events: should the run hand the event loop back now?
   *
   * A run is a loop of `await`s over work that is mostly synchronous — a
   * lexical arm, a key extraction, a cell write — and awaiting synchronous work
   * queues a microtask, which Node drains to completion before it serves
   * anything else. So a long replay starves the process it runs in: requests
   * queue, and on a host that is also *running* watches, the live engine stops
   * ticking. When this answers true the engine awaits a macrotask, which really
   * does return control.
   *
   * A predicate rather than an interval because this package reads no clock:
   * the engine's own time is virtual so a replay is deterministic, and a
   * deadline is scheduling rather than domain time. The caller holds the clock
   * and decides; here it is a hook.
   *
   * The live engine leaves it unset: it consumes a small slice per tick and the
   * scheduler already decides when it runs.
   */
  readonly shouldYield?: () => boolean;
  readonly analytics: AnalyticsPort;
  /**
   * Find the document a `doc.indexed` event is about: the most recent
   * `doc.event` for that document **at or before** `atSeq`.
   *
   * The bound is the whole point. A live consumer sits at the head of the
   * journal, where "most recent" and "most recent so far" are the same thing —
   * but one catching up after a restart is walking a backlog, and an unbounded
   * lookup would hand it a revision that had not happened yet at the event it
   * is evaluating. A watch would then decide differently depending on how far
   * behind it was, which is the one thing a durable journal exists to prevent.
   *
   * Supplying this says the journal is queryable rather than a list held in
   * memory, and the engine then keeps no document memo of its own and replays
   * nothing on resume. That is what a live consumer needs: the memo would grow
   * to the size of the corpus, and the replay would be the whole journal on
   * every restart.
   *
   * Absent, the engine remembers the documents it has walked past — which is
   * exactly right for a fixture journal it is handed whole.
   */
  readonly lookupDocument?: (docId: string, atSeq: number) => JournalDocument | null;
  readonly judge: JudgeProvider;
  readonly recall: RecallScorer;
  readonly store?: WatchStateStore;
  /**
   * Run one write transaction under whatever the host uses to keep its *other*
   * writers off the state file while this one is open.
   *
   * A host that writes this file from more than one place needs the two to take
   * turns. SQLite will serialise them regardless, but a synchronous driver
   * makes the loser block its thread inside the busy handler rather than yield
   * — so a host that shares a thread between its writers supplies this and the
   * waiting becomes an await.
   *
   * Absent, transactions run directly, which is right for a run that owns its
   * store outright.
   *
   * The turn is assumed **not** to be reentrant: nothing the engine runs inside
   * one may take it again. A host's lease is a queue, and a section that waits
   * on its own queue never reaches the front of it.
   */
  readonly serializeWrites?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Where the clock starts. Defaults to the first event's semantic time. */
  readonly startAt?: string;
  /**
   * The evaluation timezone, as an offset from UTC in minutes. A watch's
   * `$today`, its cron boundaries and its business days are all civil, not
   * UTC — so the zone is an input rather than an assumption. Defaults to UTC.
   */
  readonly timeZoneOffsetMinutes?: number;
  /**
   * How far time has actually got, for a host that is not replaying.
   *
   * A backtest's clock belongs to the journal: time stops where the events
   * stop, because a deadline past the last event has not come due — it simply
   * has not been reached. A live runtime knows better, and needs to, because a
   * watch whose only outstanding work is a deadline has no events to be
   * carried forward by. Without this such a watch waits for an unrelated event
   * to arrive and drag the clock past its deadline, so whether a daily digest
   * fires depends on whether anything else happened that morning.
   *
   * Supplied, it is the instant timers are drained through at the end of a run.
   */
  readonly timeReachedMs?: number;
}

/** An edge, as the engine walks it. */
interface Edge {
  readonly from: string;
  readonly to: string;
  readonly role: "arm" | "cancel";
  readonly key?: Readonly<Record<string, string>>;
  readonly broadcast: boolean;
}

/**
 * What one node fired with, and what everything upstream of it fired with.
 *
 * `provenance` travels with the signal rather than living in a per-node map,
 * and that is the whole reason two concurrently-live keys cannot contaminate
 * each other: a `$n.<node>.<field>` reference resolves against the chain that
 * produced *this* signal, not against whatever that node did most recently.
 */
interface Provenance {
  readonly payload: Record<string, unknown>;
  readonly key: Record<string, unknown>;
  readonly firedBy?: unknown;
  /**
   * The document this link of the chain fired on, when it fired on one.
   *
   * Carried here rather than in a channel of its own because provenance is
   * already the record of what produced a signal, and it is already persisted
   * on a cell — so a firing that happens days after the document arrived still
   * knows which document it was about. A payload cannot answer that: what a
   * payload holds is whatever the author's `output_map` named, which may not
   * include the document at all.
   */
  readonly documentId?: string;
}

interface Signal {
  readonly seq: number;
  readonly atMs: number;
  readonly payload: Record<string, unknown>;
  readonly key: Record<string, unknown>;
  readonly firedBy: string;
  readonly provenance: ReadonlyMap<string, Provenance>;
  /** Which instance of the key produced this, when the node spawns several. */
  readonly instance?: number;
}

/**
 * Raised when an instance cannot be evaluated. Pauses the watch, not the run.
 *
 * The class is chosen where the failure is raised, because that is the only
 * place that knows what was being attempted. Deriving it later from the
 * message would mean pattern-matching whatever a backend happened to say.
 */
class InstanceFailure extends Error {
  constructor(
    readonly nodeId: string,
    readonly key: string,
    cause: unknown,
    readonly failure: FailureClass = "internal",
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "InstanceFailure";
  }
}

/** An answer only a provider can give, and the identity it is cached under. */
type OffHostNeed =
  | { readonly kind: "judge"; readonly cacheKey: string; readonly request: JudgeRequest }
  | { readonly kind: "recall"; readonly cacheKey: string; readonly request: RecallRequest };

const DAY_MS = 86_400_000;

/**
 * How many times one unit of work may go off the host before giving up.
 *
 * A round fetches **every** answer that unit turned out to need, so this bounds
 * the dependency depth — how many times an answer has to arrive before the next
 * question is even reachable — rather than the number of questions. Depth is a
 * property of the watch's graph and is small; fan-out is a property of how much
 * happened, and is not.
 *
 * Counting questions instead was a live defect: an hourly watch catching up
 * after a two-day outage asks once per missed boundary, and a judged node
 * behind a broadcast arm asks once per live instance. Both are ordinary, and
 * both used to exhaust the budget and pause the watch permanently.
 */
const MAX_OFFHOST_ROUNDS = 64;

/**
 * What a provider call returns during a pass that is only finding out what to
 * fetch. Both are the declining answer, so a speculative pass explores the
 * branch a watch takes when nothing matches — the cheap one.
 */
const SPECULATIVE_VERDICT: JudgeVerdict = { fired: false, output: {} };
const SPECULATIVE_SCORE = 0;

/** Parked nominations reconsidered per run, so one drain cannot run long. */
const PENDING_DRAIN_LIMIT = 50;
const DEFAULT_UNANSWERED_RETRY_MS = 60_000;
const MAX_UNANSWERED_RETRY_MS = 48 * 60 * 60 * 1_000;

/**
 * How many revisions back an index event looks for the one a node is owed.
 *
 * A document is normally touched once or twice between arriving and becoming
 * searchable, so the walk ends on its first or second step, and a walk that
 * reaches the document's creation stops there because nothing is older. The
 * limit binds the remaining case: a document already in the corpus when the
 * journal started has no creation to reach, so its walk ends only by running
 * out of history — and without a limit every re-index of a heavily churned
 * document would cost a lookup per revision of it, on the thread the whole
 * gateway writes through.
 */
const REVISION_WALK_LIMIT = 8;

/**
 * How much of the judge's own sentence a trace record keeps.
 *
 * Bounded because it is model-authored text about a document: the judge is
 * asked for one sentence and usually writes one, and a trace that grew a page
 * of it per declined document would be unreadable at exactly the moment
 * someone is scrolling it to find out why nothing fired.
 */
const DECLINE_DETAIL_MAX = 300;

/** What evaluating one event decided about the rest of the run. */
type EventOutcome = "continue" | "stop";

export class WatchEngine {
  private readonly watchId: string;
  private readonly nodes: ReadonlyMap<string, WatchNode>;
  /**
   * The nominating nodes that have to wait for the index, computed once.
   *
   * Also the answer to "does this watch care about index events at all" —
   * without it, every watch in the install would remember every index event
   * whose document had not landed yet, including the ones that never score an
   * embedding.
   */
  private readonly waitingNodes: readonly Extract<WatchNode, { type: "source.document_event" }>[];
  private readonly edges: readonly Edge[];
  private readonly outgoing: ReadonlyMap<string, readonly Edge[]>;
  private readonly store: WatchStateStore;
  private readonly ownsStore: boolean;
  private readonly clock: VirtualClock;
  private readonly trace: TraceRecorder;
  private readonly constants: Readonly<Record<string, unknown>>;
  /**
   * Document events seen, so a later `doc.indexed` can find its document.
   *
   * Unused when the caller supplies `lookupDocument` — a live consumer reads
   * the journal instead, because this memo would otherwise grow to the size of
   * the corpus and be rebuilt from scratch on every restart.
   */
  private readonly documents = new Map<string, JournalDocument>();
  /**
   * Provider answers fetched for the unit of work currently being applied.
   *
   * Lives for one unit and no longer. Held across the retries an off-host
   * answer costs, so the same question is paid for once; cleared afterwards, so
   * a later event asking the same question asks it again rather than reusing a
   * verdict about a document it has since re-read — and so the judge's spend
   * counts every judgement the runtime actually asked for.
   */
  private readonly offHost = new Map<string, JudgeVerdict | number>();
  /**
   * What the pass currently being applied asked for and did not have.
   *
   * A pass that reaches an unanswered provider does not stop there — it takes
   * the declining placeholder and carries on, so one pass discovers everything
   * that has to be fetched rather than the first thing. That is what keeps the
   * cost of an event proportional to how deeply its questions nest instead of
   * to how many of them there are.
   */
  private readonly needed = new Map<string, OffHostNeed>();
  /**
   * Which document event a node last looked at a document on.
   *
   * Keyed per (node, document), because nomination is a property of the pair:
   * two recall sources over one document each get their own first look.
   *
   * The value is the sequence number of the `doc.event` the look was made
   * against, which is what tells a document that changed from one that was
   * merely re-indexed. Indexing happens for reasons of its own — a backfill, an
   * embedding-model change, a retry — and none of those is news. A watch that
   * spoke on each of them would be reporting the indexer.
   *
   * Persisted rather than held in memory, in the same transaction as the firing
   * it decides: a consumer that lost it on restart would speak again about
   * everything it had already spoken about.
   */
  private readonly tz: number;
  private paused = false;
  private pauseOnRollback = false;
  /** What stopped this run, kept so the pause can be written with a reason. */
  private failure: WatchFailure | null = null;
  private currentSeq = 0;
  /**
   * When the journal saw the event being processed.
   *
   * A firing is stamped with its subject's time, which is what makes a replay
   * agree with the live run — and what makes a watch about a month-old document
   * record a firing dated a month ago. This is the other half, and it is read
   * off the event rather than off a clock, because this package reads none.
   */
  private currentObservedAt: string | null = null;
  /**
   * How much of the journal this run actually took in.
   *
   * A watch that retires partway through — at its horizon, or on `once_ever` —
   * was not live for the rest of the journal, and anything dividing its cost by
   * a span it did not run in reports a rate nobody experienced.
   */
  private consumed = 0;
  /** The watch's horizon in epoch ms, or null when it declared none. */
  private readonly horizonMs: number | null;

  constructor(private readonly options: EngineOptions) {
    this.watchId = options.watchId ?? options.watch.name;
    this.nodes = new Map(options.watch.nodes.map((node) => [node.id, node]));
    this.waitingNodes = options.watch.nodes.filter(
      (node): node is Extract<WatchNode, { type: "source.document_event" }> =>
        node.type === "source.document_event" && waitsForTheIndex(node),
    );

    const edges: Edge[] = [];
    for (const node of options.watch.nodes) {
      for (const [from, input] of Object.entries(nodeInputs(node))) {
        edges.push({
          from,
          to: node.id,
          role: input.role,
          ...(input.key ? { key: input.key } : {}),
          broadcast: input.broadcast === true,
        });
      }
    }
    this.edges = edges;

    const outgoing = new Map<string, Edge[]>();
    for (const edge of edges) {
      const list = outgoing.get(edge.from) ?? [];
      list.push(edge);
      outgoing.set(edge.from, list);
    }
    this.outgoing = outgoing;

    this.store = options.store ?? new WatchStateStore();
    this.ownsStore = options.store === undefined;
    this.trace = new TraceRecorder(this.watchId);
    this.constants = Object.fromEntries(
      Object.entries(options.watch.constants ?? {}).map(([name, c]) => [name, c.value]),
    );

    const horizon = options.watch.expires_at;
    this.horizonMs = horizon === undefined ? null : Date.parse(horizon);

    this.tz = options.timeZoneOffsetMinutes ?? 0;
    const start =
      options.startAt ??
      options.journal[0]?.occurredAt ??
      options.timeReachedMs ??
      "1970-01-01T00:00:00Z";
    this.clock = new VirtualClock(start, this.tz);
  }

  /**
   * Replay the journal and return what happened.
   *
   * Resumes from the store's cursor, so replaying the second half of a journal
   * against a store that saw the first half continues rather than restarting.
   * The store is closed on every path, including a failure — a leaked handle
   * outlives the run and holds a file open.
   */
  /** Events this run dispatched or replayed, in journal order. */
  get eventsConsumed(): number {
    return this.consumed;
  }

  async run(): Promise<WatchTrace> {
    try {
      const resumeFrom = this.store.cursor(this.watchId);
      // A retired watch is not owed any more boundaries; arming before this
      // check would give one a fresh tick row on every pass, forever.
      if (!this.store.isActive(this.watchId)) return this.trace.finish();

      // Every run, not only the first. A live host seeds a new watch's cursor
      // to the journal head before its first evaluation, so a run gated on a
      // cursor of zero would arm a recurring source exactly never — the watch
      // would install, validate, sit active, and have no timer to fire.
      // `setTimerIfAbsent` is what makes repeating this safe: a boundary the
      // store is already holding is left where it is. In a transaction like
      // every other write, so it takes the host's turn rather than reaching
      // SQLite while another writer holds the lock.
      await this.transact(() => {
        this.armTimeSources();
        return Promise.resolve("continue");
      });

      // Nominations a spent judge budget parked earlier. Ahead of the new
      // events, because they are older than all of them and a queue that
      // drained newest-first would starve whatever was parked when the budget
      // ran out.
      if (!(await this.drainParked())) return this.trace.finish();

      const shouldYield = this.options.shouldYield;
      for (const [index, event] of this.options.journal.entries()) {
        if (event.seq <= resumeFrom) {
          // Already consumed, so it must not be dispatched again — but the
          // projections a consumed event contributed to are projections of the
          // whole journal, not of the part this run happened to handle.
          // Rebuilding them needs every event, or a resumed run sees a corpus
          // missing everything before the crash and decides differently from
          // one that never crashed. A defective consumed event pauses the
          // watch exactly as it would have on the run that first saw it,
          // rather than throwing out of `run` and crash-looping every restart.
          this.currentSeq = event.seq;
          this.consumed = index + 1;
          if (!(await this.guarded(() => this.replayConsumed(event)))) break;
          continue;
        }
        if (this.paused || !this.store.isActive(this.watchId)) break;

        // Between events, never inside the transaction below: a yield with a
        // transaction open would hold it across the whole of whatever the host
        // does next.
        if (shouldYield?.() === true) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }

        this.currentSeq = event.seq;
        this.currentObservedAt = event.observedAt;
        this.consumed = index + 1;
        const atMs = Date.parse(event.occurredAt);
        // The horizon is read on the clock that only moves forward. `occurredAt`
        // is the event's *semantic* time and a backfill can carry one years out;
        // retiring on it would let a single forward-dated document — a save-the-
        // date, a scheduled send, a wrong header — end a watch that still had
        // months of question left, permanently and durably.
        const expired = this.hasExpired(Date.parse(event.observedAt));

        // Then the ones due at this exact instant — after every event at that
        // instant has had its say. A cancel and a deadline that fall together
        // are simultaneous only in semantic time, and the cancel is an
        // observation about the world where the deadline is the absence of one,
        // so the cancel wins.
        //
        // The wait is until the instant is exhausted, not merely until this
        // event is done: sweeping after each event would let any unrelated
        // message sharing the timestamp fire the deadline before the cancel
        // behind it was ever dispatched, so whether a watch cancelled or fired
        // would turn on what else happened to be recorded at the same second.
        const nextAtMs = this.options.journal[index + 1]?.occurredAt;
        const instantExhausted = nextAtMs === undefined || Date.parse(nextAtMs) !== atMs;

        // One event, one unit of work: its effects and its cursor advance
        // commit together, so a crash leaves the event untouched rather than
        // half-applied and marked consumed. The timer drains are inside that
        // unit too — expiring an instance consumes a timer and drops a cell,
        // and letting those auto-commit outside the transaction would destroy
        // a deadline the repaired watch still owes.
        const outcome = await this.transact(async () => {
          // Timers due strictly BEFORE this event fire first: they came due in
          // the gap, and nothing this event does can un-due them.
          //
          // Ahead of the horizon check, because a deadline that came due before
          // the watch expired is a deadline the watch owed. Retiring first
          // would make whether it is honoured depend on whether an unrelated
          // event happened to land in the gap, and would record the watch as
          // overtaken when it had an answer waiting.
          await this.drainTimers(this.drainThrough(atMs - 1));

          // Past its horizon the watch is not asking a question any more, so
          // nothing it would have said is worth saying. Retired rather than
          // deleted, because a ledger a watch vanished from cannot be read.
          if (expired) {
            this.consumed = index;
            this.store.setActive(this.watchId, false);
            this.trace.end("expired");
            return "stop";
          }

          if (!this.paused) {
            this.clock.advanceTo(atMs);
            await this.guarded(() => this.dispatch(event));
          }

          if (!this.paused && instantExhausted) await this.drainTimers(this.drainThrough(atMs));

          // A failure anywhere above — dispatch or either drain — takes the
          // whole event back, cursor included, so a restart re-reads it rather
          // than resuming past work that was never done.
          if (this.paused) return "stop";

          this.store.advanceCursor(this.watchId, event.seq);
          return "continue";
        });
        if (outcome === "stop") break;
      }

      // Where time has got to. A live host says so outright; for a replay it is
      // the journal's own end, because a deadline beyond the last observed
      // instant has not come due, it simply has not been reached.
      const end = this.options.journal.at(-1);
      const reachedMs = this.options.timeReachedMs ?? (end ? Date.parse(end.occurredAt) : null);
      if (reachedMs !== null && !this.paused && this.store.isActive(this.watchId)) {
        await this.transact(async () => {
          await this.drainTimers(reachedMs);
          return this.paused ? "stop" : "continue";
        });
      }

      // The horizon is a fact about time passing, not about the journal, so a
      // watch whose horizon went by during a quiet spell has to retire on the
      // clock. Read on the arriving event alone it would stay `active` — and
      // go on drawing passes, and go on delivering — until something unrelated
      // happened to be indexed.
      //
      // Only where a host supplies real time. A replay has none, and its
      // stand-in is the journal's own semantic end, which a single forward-
      // dated document carries years out; retiring on that would end a watch
      // that still had months of question left.
      const realNowMs = this.options.timeReachedMs;
      if (
        realNowMs !== undefined &&
        !this.paused &&
        this.hasExpired(realNowMs) &&
        this.store.isActive(this.watchId)
      ) {
        await this.transact(() => {
          this.store.setActive(this.watchId, false);
          this.trace.end("expired");
          return Promise.resolve("continue");
        });
      }
    } finally {
      // A paused run leaves nothing half-committed behind it.
      this.store.rollback();
      // Where a pause is written, whatever paused the run. Nothing applies one
      // from inside an attempt: a pause is a write and takes the turn, the turn
      // is not reentrant, and taking it from a section that already holds it
      // wedges the lease for the whole process. This is reached with nothing
      // held and with no work in between — a paused attempt returns `stop`,
      // which breaks the event loop and skips the trailing drain above.
      await this.applyPause();
      if (this.ownsStore) this.store.close();
    }
    return this.trace.finish();
  }

  /** Re-apply an already-consumed event's analytics rows, dispatching nothing. */
  private async replayConsumed(event: JournalEvent): Promise<void> {
    // A document's index lands on a later clock than the document itself, so a
    // run that resumes between the two still has to find what it is indexing.
    // Like the analytics tables, this memo is a projection of the whole
    // journal rather than of the slice one run happened to consume.
    if (isKind(event, "doc.event")) {
      this.documents.set(event.payload.docId, { event: event.payload, seq: event.seq });
      return;
    }
    // A consumed index needs nothing rebuilt: the look it represents is in the
    // store, written in the same transaction as the decision it made.
    if (isKind(event, "doc.indexed")) return;
    if (!isKind(event, "analytics.row")) return;
    const apply = this.options.analytics.applyRow?.bind(this.options.analytics);
    const table = apply ? this.options.ontology.table(event.payload.table) : null;
    if (table && apply) await apply(table, event.payload.row);
  }

  /**
   * Run one unit of work, containing a failure to the watch that caused it.
   *
   * A watch whose query throws is broken, and the useful response is a trace
   * that says which instance broke and a paused watch — not a lost run.
   */
  private async guarded(work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      return true;
    } catch (error) {
      const failure =
        error instanceof InstanceFailure
          ? error
          : new InstanceFailure("<watch>", SINGLETON_KEY, error);
      this.trace.fail(
        this.currentSeq,
        failure.nodeId,
        failure.key,
        failure.failure,
        failure.message,
      );
      // Held for the pause below, and written durably with it. A watch that is
      // stopped and cannot say what stopped it is one an operator has to
      // delete and re-add, which costs it every firing it has recorded.
      this.failure = {
        seq: this.currentSeq,
        nodeId: failure.nodeId,
        failure: failure.failure,
      };
      this.paused = true;
      // Recorded after the rollback, not inside it: pausing is the one effect
      // of a failure that must survive, or a restart replays the same event,
      // fails the same way, and calls that a paused watch.
      this.pauseOnRollback = true;
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Off-host answers
  // -------------------------------------------------------------------------

  /**
   * Run one unit of work in a write transaction, fetching whatever it turns out
   * to need from off the host *outside* that transaction.
   *
   * The attempt runs to the first provider call it cannot answer from what is
   * already held, then unwinds completely — the transaction rolls back and the
   * trace rewinds to where the attempt began, so nothing of the abandoned pass
   * survives. The answer is fetched with no transaction open and the work is
   * run again from the same state. Since evaluation is a function of state,
   * event and answers, the retry reaches the same call, finds the answer, and
   * carries on to the next one.
   *
   * The cost is re-doing an event's *local* work once per off-host answer it
   * needs, which is a few SQLite reads. The alternative is holding a write lock
   * across a network call, which stalls anything else writing this file for as
   * long as a model takes to think.
   */
  private async transact(work: () => Promise<EventOutcome>): Promise<EventOutcome> {
    const serialize = this.options.serializeWrites ?? ((run) => run());
    try {
      for (let round = 0; round <= MAX_OFFHOST_ROUNDS; round += 1) {
        const mark = this.trace.mark();
        const clockAt = this.clock.position;
        // The attempt, from opening the transaction to committing it, is what
        // the host serialises. Fetching an off-host answer deliberately sits
        // outside it: that is the whole reason the attempt unwinds rather than
        // waiting, and holding the turn across a model call would hand the
        // stall back to whatever else writes this file.
        const attempt = await serialize(async () => {
          this.needed.clear();
          this.store.begin();
          try {
            const outcome = await work();
            // Anything asked for that was not already held makes this a pass
            // that found out what to fetch rather than one that decided
            // anything. Its answers were placeholders, so none of what it did
            // may be kept.
            if (this.needed.size > 0) return this.unwind(mark, clockAt);
            if (this.paused) {
              this.store.rollback();
              // The rollback took the firing rows with it, and the trace has to
              // follow. A broadcast arm fires the sink for one cell and the
              // next cell's query throws: without this the host would read a
              // firing off the trace and notify somebody about it, while the
              // row behind it no longer exists — and then notify them again
              // when the paused watch is resumed and the event is re-read.
              //
              // The records stay. They are the account of what the attempt did
              // before it broke, including the failure itself, and they are
              // what `watch trace` is read to see.
              this.trace.rewindEffects(mark);
              // Nothing applies the pause here, deliberately. Pausing is a
              // write like any other and takes the turn, and the turn is not
              // reentrant: taking it from inside the section that already holds
              // it queues the pause behind itself, and the host's every other
              // writer behind that. `run()`'s `finally` applies it, with
              // nothing held — the paused attempt returns `stop`, which takes
              // the run straight there and does no work on the way.
            } else {
              this.store.commit();
            }
            return { done: true as const, outcome };
          } catch (error) {
            // A speculative pass runs on declining placeholders, so it can
            // reach states the real one never would and fail there. That is not
            // a defect in the watch, and pausing on it would retire a healthy
            // watch for a value it was never going to be given.
            if (this.needed.size > 0) return this.unwind(mark, clockAt);
            this.store.rollback();
            this.trace.rewind(mark);
            this.clock.position = clockAt;
            throw error;
          }
        });
        if (attempt.done) return attempt.outcome;

        // Every answer this pass turned out to need, fetched together and with
        // nothing open. Depth rather than fan-out is what costs a round.
        //
        // A provider that throws is contained exactly as one that threw inside
        // the attempt would have been: the watch pauses, the run does not.
        // Fetching happens outside `guarded`'s reach, so the containment has to
        // be repeated here — without it a judge backend having a bad afternoon
        // takes down the evaluation of every other watch too.
        if (!(await this.guarded(() => this.resolveAll(attempt.needs)))) {
          // Nothing is open to roll back — the attempt already unwound — so the
          // pause is applied directly. The instance and any deadline it owes
          // survive untouched, which is what makes a repaired watch still owe
          // them.
          await this.applyPause();
          return "stop";
        }
      }
      // Contained like any other instance failure: the watch pauses with a
      // trace saying so, and the rest of the run — and every other watch in the
      // pass — carries on. Raising here would leave an operator with a watch
      // filed as broken and nothing at all explaining it.
      await this.guarded(() =>
        Promise.reject(
          new InstanceFailure(
            "<watch>",
            SINGLETON_KEY,
            new Error(
              `evaluating one event needed off-host answers ${MAX_OFFHOST_ROUNDS} times over`,
            ),
            "budget",
          ),
        ),
      );
      await this.applyPause();
      return "stop";
    } finally {
      this.offHost.clear();
      this.needed.clear();
    }
  }

  /**
   * Stop the watch, and say what stopped it.
   *
   * Applied outside the transaction the failure rolled back, because the pause
   * is the one effect of a failure that must survive it — a pause discarded
   * with the rest would leave a restart replaying the same event, failing the
   * same way, and calling the result a watch that is running.
   *
   * The reason is written with it rather than left in the trace alone. A trace
   * is a per-run artifact and is pruned; the question an operator asks days
   * later is "why is this watch stopped", and the answer has to be durable
   * enough to still be there when they ask.
   */
  private async applyPause(): Promise<void> {
    if (!this.pauseOnRollback) return;
    const serialize = this.options.serializeWrites ?? ((run) => run());
    // Through the same turn-taking as every other write to this file. A write
    // that skipped it would reach SQLite while another writer held the lock,
    // and a synchronous driver blocks its thread there rather than yielding.
    await serialize(() => {
      // One statement, so the stop and its reason cannot come apart.
      if (this.failure) this.store.recordFailure(this.watchId, this.failure);
      else this.store.setActive(this.watchId, false);
      return Promise.resolve();
    });
  }

  /** Take back an attempt that only found out what to fetch. */
  private unwind(mark: TraceMark, clockAt: number): { done: false; needs: readonly OffHostNeed[] } {
    this.store.rollback();
    this.trace.rewind(mark);
    this.clock.position = clockAt;
    this.paused = false;
    this.pauseOnRollback = false;
    this.failure = null;
    return { done: false, needs: [...this.needed.values()] };
  }

  /** Fetch a pass's answers together, with no transaction open. */
  private async resolveAll(needs: readonly OffHostNeed[]): Promise<void> {
    for (const need of needs) await this.resolve(need);
  }

  /** Fetch one answer and hold it, with no transaction open. */
  private async resolve(need: OffHostNeed): Promise<void> {
    try {
      const answer =
        need.kind === "judge"
          ? await this.options.judge.judge(need.request)
          : await this.options.recall.score(need.request);
      this.offHost.set(need.cacheKey, answer);
    } catch (error) {
      // Attributed to the node that asked. A provider outage recorded against
      // the watch as a whole reads like a defect in the definition, and the
      // first thing an operator does with that is rewrite a watch that was
      // never wrong.
      throw new InstanceFailure(
        need.request.nodeId,
        need.kind === "judge" ? need.request.key : SINGLETON_KEY,
        error,
        "provider",
      );
    }
  }

  /**
   * A judgement, if it has already been fetched for this event.
   *
   * Keyed on the whole request, so two nodes asking different things of the
   * same document each get their own answer and a retry asking the identical
   * question gets the one already paid for.
   */
  private judgeVerdict(request: JudgeRequest): JudgeVerdict {
    const cacheKey = `judge:${JSON.stringify(request)}`;
    if (this.offHost.has(cacheKey)) return this.offHost.get(cacheKey) as JudgeVerdict;
    // `has`, not a check for `undefined`: a provider that answered with nothing
    // would otherwise be indistinguishable from one that has not answered, and
    // the pass would ask again for as many rounds as it is allowed.
    this.needed.set(cacheKey, { kind: "judge", cacheKey, request });
    return SPECULATIVE_VERDICT;
  }

  /** A recall score, if it has already been fetched for this event. */
  private recallScore(request: RecallRequest): number {
    const cacheKey = `recall:${JSON.stringify(request)}`;
    if (this.offHost.has(cacheKey)) return this.offHost.get(cacheKey) as number;
    this.needed.set(cacheKey, { kind: "recall", cacheKey, request });
    return SPECULATIVE_SCORE;
  }

  /**
   * Reconsider nominations an exhausted judge budget parked.
   *
   * Oldest first, and it stops at the first one the budget still cannot afford
   * — draining past it would reorder the queue by which document happened to be
   * cheap, and the order is the only fairness this has.
   *
   * Returns whether the run should continue.
   */
  private async drainParked(): Promise<boolean> {
    for (const parked of this.store.pendingNominations(this.watchId, PENDING_DRAIN_LIMIT)) {
      if (this.paused || !this.store.isActive(this.watchId)) return false;
      const reached = this.options.timeReachedMs ?? this.clock.nowMs;
      const node = this.nodes.get(parked.nodeId);
      const held = this.documentFor(parked.docId, parked.seq);
      // The node was edited out of the watch, or the document is out of the
      // journal's reach. Neither is a nomination any more. Discarded in a
      // transaction like every other write here.
      if (!node || node.type !== "source.document_event" || node.recall === undefined || !held) {
        await this.transact(() => {
          this.store.clearNomination(this.watchId, parked.nodeId, parked.docId);
          return Promise.resolve("continue");
        });
        continue;
      }
      // FIFO is the fairness contract among valid nominations. Stale rows are
      // cleaned first so an edited-out node cannot block the live queue until
      // its old retry date.
      if (parked.retryAtMs > reached) return true;

      this.currentSeq = parked.seq;
      // The instant the journal saw the event that nominated this document,
      // carried across the park. A firing the drain produces is stamped with
      // it, and without it the firing has only the document's own semantic
      // time — so a watch that spoke this afternoon about a document dated
      // last spring is read everywhere as having last fired last spring.
      this.currentObservedAt = parked.observedAt;
      const outcome = await this.transact(async () => {
        const verdict = this.judgeVerdict(this.judgeRequestFor(node, held.event));
        // Stops the drain rather than skipping this one: whatever kept the
        // judge from answering will keep it from answering the next, and
        // walking the rest would spend the pass proving that against every
        // parked nomination in turn.
        if (verdict.unanswered) {
          this.store.rescheduleNomination(
            this.watchId,
            parked.nodeId,
            parked.docId,
            normalizedRetryAt(verdict.unanswered.retryAtMs, reached),
          );
          return "stop";
        }
        this.store.clearNomination(this.watchId, parked.nodeId, parked.docId);
        this.noteLook(node, held);
        await this.guarded(() =>
          this.settleNomination(node, held.event, verdict, parked.seq, parked.atMs),
        );
        return this.paused ? "stop" : "continue";
      });
      if (outcome === "stop") {
        this.currentObservedAt = null;
        return !this.paused;
      }
    }
    // The journal loop stamps its own, and a timer firing on a quiet pass has
    // none: neither may inherit a drained nomination's.
    this.currentObservedAt = null;
    return true;
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  /** Give every recurring time source its first due-gate. */
  private armTimeSources(): void {
    // Never behind real time, where a host has told us what real time is. The
    // semantic clock starts at the first event in the slice, and a source
    // backfilling carries instants from years ago — arming a daily boundary
    // back there would make the first drain fire every boundary since, for a
    // watch that did not exist for any of them.
    const from = Math.max(this.clock.nowMs, this.options.timeReachedMs ?? this.clock.nowMs);
    for (const node of this.nodes.values()) {
      if (node.type !== "source.time") continue;
      const due = this.nextTick(node, from);
      if (due !== null) {
        // Only if the store is not already holding a tick for this source. A
        // crash before the first event commits leaves fired boundaries behind
        // with the cursor still at zero, so a resumed run re-enters this path;
        // overwriting the tick would wind it back and fire them all again.
        this.store.setTimerIfAbsent({
          watchId: this.watchId,
          nodeId: node.id,
          keyHash: hashKey({}),
          instance: 0,
          key: {},
          dueAtMs: due,
          kind: "tick",
        });
      }
    }
  }

  private nextTick(
    node: Extract<WatchNode, { type: "source.time" }>,
    afterMs: number,
  ): number | null {
    if (node.one_off !== undefined) {
      const at = Date.parse(node.one_off);
      return at > afterMs ? at : null;
    }
    const cron = node.recurring === undefined ? null : parseCron(node.recurring);
    return cron ? nextCronOccurrence(cron, afterMs, this.tz) : null;
  }

  /** The document a `doc.indexed` event is about, from wherever it is held. */
  private documentFor(docId: string, atSeq: number): JournalDocument | null {
    const lookup = this.options.lookupDocument;
    if (lookup) return lookup(docId, atSeq);
    // The memo only ever holds documents already walked past, so it is bounded
    // by construction. It keeps one revision per document — the newest walked —
    // so it can only answer a bound at or after that revision. An older bound
    // falls through to the journal, which carries every revision the run was
    // handed.
    const walked = this.documents.get(docId);
    if (walked && walked.seq <= atSeq) return walked;
    // Nothing walked past yet. A parked nomination is by definition older than
    // this run, and it is drained before the journal is replayed, so the memo
    // is empty exactly when the queue needs it — falling back to the journal
    // this run was handed is what stops the queue being unreachable, and
    // therefore never drained, for a run holding its events in memory.
    for (let index = this.options.journal.length - 1; index >= 0; index -= 1) {
      const event = this.options.journal[index]!;
      if (event.seq > atSeq || !isKind(event, "doc.event")) continue;
      if (event.payload.docId !== docId) continue;
      return { event: event.payload, seq: event.seq };
    }
    return null;
  }

  /**
   * Let every index-waiting node consider a document now known to be indexed.
   *
   * Reached from two directions and it must behave the same from both: the
   * index event arriving after its document, and the document arriving after
   * its index event. `looksNew` is keyed on the document's own event sequence,
   * so a re-index later cannot nominate the same revision twice whichever
   * direction it came from.
   */
  private async scoreOnTheIndex(held: JournalDocument, seq: number, atMs: number): Promise<void> {
    for (const node of this.waitingNodes) {
      const revision = this.revisionOwed(node, held, seq);
      if (revision === null) continue;
      if (!this.looksNew(node, revision)) continue;
      await this.runRecall(node, revision, seq, atMs);
    }
  }

  /**
   * Which revision of this document this node is owed a look at, or null.
   *
   * Usually the one the index event resolved to — the newest at that sequence.
   * But the index lands on a clock of its own, and a document can be touched
   * again between arriving and becoming searchable. A node subscribed to
   * creations alone would then be offered an update, refuse it on `op`, and
   * never consider a document it was written to catch: the creation is never
   * nominated, never traced, and no later event brings it back, because every
   * later one is an update too. The revision it wanted is still in the journal,
   * below this one.
   *
   * So an unmatched head is walked backwards, newest first, down to the
   * revision this node last looked at — or to the document's first, if it never
   * has. The first revision the filter accepts is the newest one this node is
   * owed, and scoring that keeps one look per lifecycle exactly as `looksNew`
   * describes. Revisions at or below the last look are not walked into: those
   * were already considered, and re-offering one would be a second firing about
   * the same episode.
   */
  private revisionOwed(
    node: Extract<WatchNode, { type: "source.document_event" }>,
    held: JournalDocument,
    seq: number,
  ): JournalDocument | null {
    if (this.documentMatches(node, held.event)) return held;
    const floor = this.store.lookedOn(this.watchId, node.id, held.event.docId) ?? 0;
    let cursor = held.seq;
    for (let step = 0; step < REVISION_WALK_LIMIT; step += 1) {
      if (cursor <= floor + 1) return null;
      const older = this.documentFor(held.event.docId, cursor - 1);
      if (older === null || older.seq <= floor) return null;
      if (this.documentMatches(node, older.event)) return older;
      // A document is created once, so a creation that did not match is the
      // end of its history and there is nothing further back to want.
      if (older.event.op === "created") return null;
      cursor = older.seq;
    }
    // Said out loud rather than dropped quietly: the walk ran out of steps
    // rather than out of history, so this node may be owed a revision it will
    // now never be offered — and an absence is the one outcome a trace cannot
    // express.
    this.trace.record(
      seq,
      node.id,
      SINGLETON_KEY,
      "dropped",
      `looked back ${REVISION_WALK_LIMIT} revisions without finding one this filter accepts`,
    );
    return null;
  }

  private async dispatch(event: JournalEvent): Promise<void> {
    if (isKind(event, "doc.event")) {
      if (!this.options.lookupDocument) {
        this.documents.set(event.payload.docId, { event: event.payload, seq: event.seq });
      }
      for (const node of this.nodes.values()) {
        if (node.type !== "source.document_event") continue;
        if (waitsForTheIndex(node)) continue;
        if (node.recall === undefined) {
          if (!this.documentMatches(node, event.payload)) continue;
          await this.fireSource(node, event.seq, Date.parse(event.occurredAt), {
            event: event.payload,
          });
          continue;
        }
        // A recall with no semantic arm is answerable from the document itself.
        const held = { event: event.payload, seq: event.seq };
        if (!this.documentMatches(node, held.event)) continue;
        if (!this.looksNew(node, held)) continue;
        await this.runRecall(node, held, event.seq, Date.parse(event.occurredAt));
      }
      // An index event that arrived before this document was owed an answer.
      // Now that the document is here it can have one, at this event rather
      // than at the index's — which is where both facts were first true, and
      // the only position a replay of this journal would reach it at too.
      if (this.store.indexOwed(this.watchId, event.payload.docId) !== null) {
        this.store.clearIndex(this.watchId, event.payload.docId);
        await this.scoreOnTheIndex(
          { event: event.payload, seq: event.seq },
          event.seq,
          Date.parse(event.occurredAt),
        );
      }
      return;
    }

    if (isKind(event, "doc.indexed")) {
      const held = this.documentFor(event.payload.docId, event.seq);
      if (!held) {
        // The document has not been journalled yet, so there is nothing to
        // score. Dropping the event would leave the node having neither
        // considered nor declined it — an absence a trace cannot express, and
        // one only a later re-index could accidentally repair.
        if (this.waitingNodes.length > 0) {
          const evicted = this.store.parkIndex(this.watchId, event.payload.docId, event.seq);
          for (const node of this.waitingNodes) {
            this.trace.record(
              event.seq,
              node.id,
              SINGLETON_KEY,
              "held",
              "the document has not been journalled yet; deferred",
            );
            // An evicted entry is a document this node will never consider,
            // which is the outcome the queue exists to prevent. Said out loud,
            // because a queue that silently forgets is indistinguishable from
            // one that never held the thing in the first place.
            if (evicted > 0) {
              this.trace.record(
                event.seq,
                node.id,
                SINGLETON_KEY,
                "dropped",
                `${evicted} older deferral(s) discarded at the queue's limit`,
              );
            }
          }
        }
        return;
      }
      await this.scoreOnTheIndex(held, event.seq, Date.parse(event.occurredAt));
      return;
    }

    if (isKind(event, "analytics.row")) {
      // When the store is built from the journal, the row lands before
      // anything queries for it — a SQL node must never be able to read a row
      // from its own future. When the store lives beside the journal the row is
      // already there, and writing it again would be the engine editing the
      // corpus.
      const apply = this.options.analytics.applyRow?.bind(this.options.analytics);
      const table = apply ? this.options.ontology.table(event.payload.table) : null;
      if (table && apply) await apply(table, event.payload.row);

      for (const node of this.nodes.values()) {
        if (node.type !== "source.analytics_row") continue;
        if (node.table !== event.payload.table) continue;
        if (!node.op.includes(event.payload.op)) continue;
        // A replayed row still reached the store above — an aggregate over the
        // history is not wrong just because the trip-wire is quiet. What it
        // does not do is wake anything, unless this node asked for it.
        if (event.payload.backfill === true && node.backfill === "ignore") continue;
        if (!(await this.rowMatches(node, event.payload.row))) continue;
        await this.fireSource(node, event.seq, Date.parse(event.occurredAt), {
          event: event.payload,
        });
      }
      return;
    }

    if (isKind(event, "loop.event")) {
      for (const node of this.nodes.values()) {
        if (node.type !== "source.open_loop") continue;
        if (!node.op.includes(event.payload.op)) continue;
        if (node.loop_ids && !node.loop_ids.includes(event.payload.loopId)) continue;
        const states = node.filter?.state;
        if (states && !states.includes(event.payload.after.state)) continue;
        await this.fireSource(node, event.seq, Date.parse(event.occurredAt), {
          event: event.payload,
        });
      }
    }
  }

  /**
   * Whether this index is news to this node, and records the look either way.
   *
   * A document is nominated at most once per lifecycle a source subscribes to.
   * A source watching only creations gets one look at each document — its first
   * index — because the only later events that reach here are updates, and its
   * filter refuses those upstream. A source that also watches updates gets
   * another look when the document's *content* changed, and none when only its
   * bookkeeping did.
   *
   * Structural rather than a heuristic on timing, because the failure it
   * prevents does not announce itself: every individual decision in an update
   * storm is locally correct, and only a person noticing the repetition can
   * tell the watch has stopped saying anything new.
   */
  private looksNew(
    node: Extract<WatchNode, { type: "source.document_event" }>,
    held: JournalDocument,
  ): boolean {
    const last = this.store.lookedOn(this.watchId, node.id, held.event.docId);
    if (last === null) return true;

    // The same document event, indexed again: the indexer's business, not the
    // watch's, however many times it happens.
    if (last === held.seq) return false;

    // Only the content matters here. Whether this node subscribes to updates at
    // all was already settled upstream — `documentMatches` requires the
    // arriving event's `op` to be one the filter names — so a node watching
    // creations alone never reaches this line holding an update.
    return held.event.contentChanged;
  }

  /**
   * Record that this node has now considered this document.
   *
   * Written *after* the nomination has been settled rather than when the look
   * is taken, because the look is what stops the document ever being considered
   * again. A nomination the judge could not afford has not been considered — it
   * is parked — and recording a look for it would be the runtime forgetting a
   * question it never asked.
   */
  private noteLook(
    node: Extract<WatchNode, { type: "source.document_event" }>,
    held: JournalDocument,
  ): void {
    if (this.store.lookedOn(this.watchId, node.id, held.event.docId) === held.seq) return;
    this.store.recordLook(this.watchId, node.id, held.event.docId, held.seq);
  }

  /**
   * Whether the watch's horizon has passed.
   *
   * Expiry is about *relevance*, not absence: it says the question has ended,
   * not that the answer was no. "She never declined and the dinner happened" is
   * a different question, and a watch that wanted it would have to have been
   * written to wait for it.
   */
  private hasExpired(atMs: number): boolean {
    return this.horizonMs !== null && atMs > this.horizonMs;
  }

  /** Whether a document event satisfies a source node's structural filter. */
  private documentMatches(
    node: Extract<WatchNode, { type: "source.document_event" }>,
    document: DocEvent,
  ): boolean {
    const sources =
      typeof node.filter.source === "string" ? [node.filter.source] : node.filter.source;
    if (!sources.some((named) => sourceMatches(named, document.sourceId))) return false;
    if (!(node.filter.event as readonly string[]).includes(document.op)) return false;

    if (node.filter.documentType !== undefined) {
      const types =
        typeof node.filter.documentType === "string"
          ? [node.filter.documentType]
          : node.filter.documentType;
      // A document whose source declared no type matches no type filter. Not
      // the same as matching every one: the watch asked for a kind of thing,
      // and this is a document nobody said the kind of.
      if (document.documentType === null) return false;
      if (!types.includes(document.documentType)) return false;
    }

    for (const predicate of node.filter.people ?? []) {
      const matched = document.people.some((mention) => {
        if (mention.role !== predicate.role) return false;
        if (predicate.isSelf !== undefined && mention.isSelf !== predicate.isSelf) return false;
        if (predicate.person !== undefined) {
          // Re-canonicalize: a person merged after this watch was compiled is
          // still the same human, and a watch keyed on them must not split.
          const wanted =
            this.options.ontology.canonicalPersonId(predicate.person) ?? predicate.person;
          const actual =
            mention.personId === null
              ? null
              : (this.options.ontology.canonicalPersonId(mention.personId) ?? mention.personId);
          if (actual !== wanted) return false;
        }
        return true;
      });
      if (!matched) return false;
    }

    for (const predicate of node.filter.metadata ?? []) {
      if (!metadataMatches(document.metadata, predicate)) return false;
    }

    return true;
  }

  private async rowMatches(
    node: Extract<WatchNode, { type: "source.analytics_row" }>,
    row: Readonly<Record<string, unknown>>,
  ): Promise<boolean> {
    if (node.predicate === undefined) return true;
    // Evaluate the predicate against the arriving row on the real engine, so a
    // fixture never disagrees with what production SQL would decide.
    //
    // Two things a predicate needs that the row alone cannot give it.
    //
    // **Types.** A row that has been through JSON no longer carries them: a
    // `DECIMAL(18,4)` arrives as a string, so a bare parameter binds VARCHAR
    // and `amount < 0` is a comparison the binder refuses outright — failing
    // the node over a column whose declared type says exactly what it is. Each
    // value is therefore cast to the type its column is declared to hold.
    //
    // **Columns the row omits.** A page of records is written under the keys
    // its first record happens to carry, so a record that left an optional
    // field out reaches the journal with no such key at all. Projecting only
    // the keys present would leave a predicate naming that column unable to
    // bind, which is the same permanent pause arrived at from the other side.
    // Every declared column is projected, absent ones as NULL.
    //
    // `CAST` rather than `TRY_CAST`: a value that does not fit its declared
    // type means the catalog and the data disagree, and the watch should say so
    // rather than quietly read it as NULL and decide the predicate is false.
    // Ingest has already cast every value into the declared column before this
    // row was journalled, so a cast that fails here means the catalog moved
    // after the row was written — which is a fact, not a formatting quirk.
    const declared = this.options.ontology.table(node.table)?.columns ?? [];
    // Re-checked against the closed union at the point of interpolation. The
    // parser admits nothing else, so this never fires today; it is here because
    // the type is the one part of the statement that is written rather than
    // bound, and a reader of this line should not have to trust three packages
    // to see why that is safe. A type it cannot vouch for is simply not cast.
    const declaredTypes = new Map(
      declared.filter((col) => isAnalyticsColumnType(col.type)).map((col) => [col.name, col.type]),
    );
    const names = [...new Set([...declared.map((col) => col.name), ...Object.keys(row)])];

    const values: Record<string, SqlParameter> = {};
    const projection = names
      .map((name, i) => {
        values[`$c${i}`] = (row[name] ?? null) as SqlParameter;
        const type = declaredTypes.get(name);
        // A column the ontology does not describe has no type to cast to, so it
        // is bound as it arrives. The ontology is a snapshot refreshed on an
        // interval, so a row can legitimately carry a column newer than it.
        const bound = type === undefined ? `$c${i}` : `CAST($c${i} AS ${type})`;
        return `${bound} AS ${JSON.stringify(name)}`;
      })
      .join(", ");

    try {
      const result = await this.options.analytics.query(
        `SELECT (${node.predicate}) AS fires FROM (SELECT ${projection})`,
        values,
      );
      return result.rows[0]?.fires === true;
    } catch (error) {
      // Named, because a watch may hold several row nodes over different
      // tables and "a node failed" does not say which one to go and look at.
      throw new InstanceFailure(node.id, SINGLETON_KEY, error, "query");
    }
  }

  private async runRecall(
    node: Extract<WatchNode, { type: "source.document_event" }>,
    held: JournalDocument,
    seq: number,
    atMs: number,
  ): Promise<void> {
    const document = held.event;
    const recall = node.recall!;
    const reasons: string[] = [];
    let nominated = false;

    // The arms are OR-composed: the first that nominates ends the question,
    // and the reasons collected are only from arms that declined. An embedding
    // is blind exactly where a literal term is exact — a rare token scores near
    // zero against a topical floor — and the point of having two is that either
    // alone leaves a class of request unanswerable.
    if (recall.semantic) {
      const score = this.recallScore({
        nodeId: node.id,
        documentId: document.docId,
        query: recall.semantic.query,
      });
      if (score >= recall.semantic.threshold) nominated = true;
      else reasons.push(`semantic ${score.toFixed(2)} below ${recall.semantic.threshold}`);
    }

    if (!nominated && recall.lexical) {
      // The title, which is the text a journal event carries. A live install
      // would read the body here the way the judge does; this journal has no
      // bodies, and matching against text the substrate does not have would be
      // a capability the runtime only appears to offer.
      const haystack = normalizeForMatch(document.title ?? "");
      const hit = recall.lexical.terms.find((term) => containsTerm(haystack, term));
      if (hit !== undefined) nominated = true;
      else reasons.push(`no lexical term of ${recall.lexical.terms.length} matched`);
    }

    if (!nominated) {
      // `ignored`, not `held`. A document no arm nominated never reached the
      // judge, and a trace that recorded it as a judgement would say this watch
      // put a hundred documents in front of a model when it put two. The
      // distinction is what the reach count is for, and a lexical arm makes it
      // load-bearing: its whole economy is that it nominates rarely.
      this.noteLook(node, held);
      this.store.clearNomination(this.watchId, node.id, document.docId);
      this.trace.record(seq, node.id, SINGLETON_KEY, "ignored", reasons.join("; "));
      return;
    }

    const verdict = this.judgeVerdict(this.judgeRequestFor(node, document));

    // The question was not answered — the budget was spent, or the judge could
    // not run. Park it and leave the look unrecorded, because a document no
    // judge read has not been considered, and recording the look would retire
    // it from this watch permanently on the strength of an outage. The drain
    // asks again on a later pass.
    if (verdict.unanswered) {
      this.store.parkNomination(
        this.watchId,
        node.id,
        document.docId,
        seq,
        atMs,
        this.currentObservedAt,
        normalizedRetryAt(
          verdict.unanswered.retryAtMs,
          this.options.timeReachedMs ?? this.clock.nowMs,
        ),
      );
      this.trace.unanswered(
        seq,
        node.id,
        SINGLETON_KEY,
        verdict.unanswered.failure,
        `${verdict.unanswered.reason}; parked`,
      );
      return;
    }

    this.noteLook(node, held);
    // Whatever the queue was still holding for this document is now answered.
    // Leaving it would let the drain judge the same revision again on a later
    // pass — a second paid judgement and a second firing, which the firings
    // table does not deduplicate because the two carry different sequences.
    this.store.clearNomination(this.watchId, node.id, document.docId);
    await this.settleNomination(node, document, verdict, seq, atMs);
  }

  /** What the judge is asked about a nominated document. */
  private judgeRequestFor(
    node: Extract<WatchNode, { type: "source.document_event" }>,
    document: DocEvent,
  ): JudgeRequest {
    return {
      watch: this.watchId,
      nodeId: node.id,
      key: SINGLETON_KEY,
      proposition: node.judge!.proposition,
      documentIds: [document.docId],
      ...(document.contentHash ? { documentRevision: document.contentHash } : {}),
      // Keep the portable runtime's evidence structural. The hosted judge may
      // enrich it with a bounded body excerpt from its own document reader,
      // while off-host and scripted judges still receive enough provenance to
      // distinguish authorship and document kind without importing gateway
      // storage into @omnesis/watch.
      evidence: {
        docId: document.docId,
        documentType: document.documentType,
        title: document.title,
        semanticTime: document.semanticTime,
        people: boundedPersonRoles(document.people),
      },
      outputSchema: node.judge!.output_schema,
    };
  }

  /** Act on a settled verdict — the one path a nomination and a parked one share. */
  private async settleNomination(
    node: Extract<WatchNode, { type: "source.document_event" }>,
    document: DocEvent,
    verdict: JudgeVerdict,
    seq: number,
    atMs: number,
  ): Promise<void> {
    if (!verdict.fired) {
      this.trace.record(seq, node.id, SINGLETON_KEY, "held", declineDetail(verdict));
      return;
    }
    await this.fireSource(node, seq, atMs, { event: document, judge: verdict.output });
  }

  private async fireSource(
    node: WatchNode,
    seq: number,
    atMs: number,
    scope: Pick<EvaluationScope, "event" | "judge">,
  ): Promise<void> {
    const payload = evaluateMap(node.output_map, {
      ...scope,
      constants: this.constants,
      native: scope.event,
    });
    this.trace.record(seq, node.id, SINGLETON_KEY, "fired");
    // A document source knows which document it fired on even when the author's
    // `output_map` never mentions it. That is what makes a firing answerable
    // afterwards, so it is recorded whether or not the watch asked for it.
    const documentId = scope.event?.docId;
    await this.propagate(node.id, {
      seq,
      atMs,
      payload,
      key: {},
      firedBy: node.id,
      provenance: new Map([
        [
          node.id,
          {
            payload,
            key: {},
            ...(typeof documentId === "string" ? { documentId } : {}),
          },
        ],
      ]),
    });
  }

  // -------------------------------------------------------------------------
  // Propagation
  // -------------------------------------------------------------------------

  private async propagate(fromId: string, signal: Signal): Promise<void> {
    if (this.options.watch.sink.input === fromId) this.fireSink(fromId, signal);

    // Cancels first, at every instant: a cancel and a deadline that fall
    // together are simultaneous only in semantic time, and the cancel is the
    // observation.
    const edges = [...(this.outgoing.get(fromId) ?? [])].sort((a, b) =>
      a.role === b.role ? 0 : a.role === "cancel" ? -1 : 1,
    );

    for (const edge of edges) {
      const target = this.nodes.get(edge.to);
      if (!target) continue;

      if (edge.broadcast) {
        // `broadcast` says how an edge reaches instances — every live key
        // rather than one computed key. It does not say what the edge means,
        // which is still its role. Deciding routing first and dropping the role
        // would make a declared cancel a no-op, so the role is dispatched here
        // and the exhaustiveness check keeps a new one from silently falling
        // onto this path.
        for (const cell of this.store.cellsFor(this.watchId, edge.to)) {
          switch (edge.role) {
            case "cancel":
              // Fanning out a cancel is safe in the way fanning out an arm is
              // not: it creates nothing, it only ends what is already there.
              this.cancel(target, { ...signal, key: cell.key });
              break;
            case "arm":
              // A keyless arm re-evaluates whatever is already live. It creates
              // nothing and replaces nothing: the instance keeps the payload and
              // provenance it was armed with, and only the clock has moved.
              // Anything else lets a daily tick manufacture instances out of one
              // real event, forever.
              await this.reevaluate(edge, target, cell, signal);
              break;
            default:
              assertNever(edge.role);
          }
        }
        continue;
      }

      const key = edge.key
        ? evaluateMap(edge.key, { edge: signal.payload, constants: this.constants })
        : signal.key;

      // A key component that cannot be computed is not a key. Routing on it
      // would collapse unrelated instances into one shared cell, so the arm is
      // refused and said so in the trace.
      const missing = Object.entries(key)
        .filter(([, value]) => value === null || value === undefined)
        .map(([name]) => name);
      if (missing.length > 0) {
        this.trace.record(
          signal.seq,
          edge.to,
          renderKey(key),
          "quarantined",
          `key component${missing.length > 1 ? "s" : ""} ${missing.join(", ")} evaluated to null`,
        );
        continue;
      }

      await this.deliver(edge, target, { ...signal, key });
    }
  }

  /**
   * Re-run a live instance because a broadcast input said time had passed.
   *
   * Only a node that evaluates something has anything to re-run. A wait is
   * counting down and a gate is waiting for its other arm; poking either would
   * restart it, which is the opposite of what a broadcast means.
   */
  private async reevaluate(
    edge: Edge,
    target: WatchNode,
    cell: NodeCell,
    signal: Signal,
  ): Promise<void> {
    const rendered = renderKey(cell.key);
    const instanceSignal: Signal = {
      ...signal,
      payload: cell.payload,
      key: cell.key,
      provenance: new Map(Object.entries(cell.provenance)),
    };

    if (target.type === "sql") {
      await this.armSql(target, instanceSignal, cell.keyHash, rendered, cell.instance);
      return;
    }
    if (target.type === "llm") {
      await this.armLlm(target, instanceSignal, cell.keyHash, rendered, cell.instance);
      return;
    }
    this.trace.record(
      signal.seq,
      target.id,
      rendered,
      "held",
      `broadcast from ${edge.from}; nothing to re-evaluate`,
      cell.instance,
    );
  }

  private async deliver(
    edge: Edge,
    target: WatchNode,
    signal: Signal,
    instance?: number,
  ): Promise<void> {
    if (edge.role === "cancel") {
      this.cancel(target, signal);
      return;
    }
    await this.arm(target, signal, edge, instance);
  }

  private fireSink(fromId: string, signal: Signal): void {
    if (!this.store.isActive(this.watchId)) return;

    const payload = evaluateMap(
      this.options.watch.sink.output_map,
      this.scopeFor(signal),
      signal.payload,
    );
    const firedAt = new Date(signal.atMs).toISOString();

    // Every document any link of this signal's chain fired on. A join over two
    // document arms contributes both, which is what someone asking "what
    // caused this" needs — the answer is rarely one document. Stored with the
    // firing rather than only traced, because the trace is bounded and rolls
    // off while the firing is kept: a firing whose evidence lived only in the
    // trace becomes unexplainable the week after it happened.
    const documentIds = [
      ...new Set(
        [...signal.provenance.values()]
          .map((entry) => entry.documentId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];

    // A replayed event re-attempts the same firing; the store discards it.
    const keyHash = `${hashKey(signal.key)}:${signal.instance ?? 0}`;
    const isNew = this.store.recordFiring(
      this.watchId,
      signal.seq,
      fromId,
      keyHash,
      firedAt,
      payload,
      this.currentObservedAt,
      documentIds,
    );
    if (!isNew) return;

    this.trace.fire(
      signal.seq,
      fromId,
      keyHash,
      renderKey(signal.key),
      firedAt,
      payload,
      documentIds,
    );
    if (this.options.watch.firing_policy === "once_ever") {
      this.store.setActive(this.watchId, false);
      this.trace.end("fired");
    }
  }

  /**
   * The references a node's `output_map` can reach, resolved against the chain
   * that produced *this* signal rather than against whatever each node did most
   * recently. That distinction is the whole of key isolation.
   */
  private scopeFor(signal: Signal): EvaluationScope {
    const upstream: Record<string, Record<string, unknown>> = {};
    const upstreamKeys: Record<string, Record<string, unknown>> = {};
    const firedBy: Record<string, unknown> = {};
    for (const [nodeId, entry] of signal.provenance) {
      upstream[nodeId] = entry.payload;
      upstreamKeys[nodeId] = entry.key;
      if (entry.firedBy !== undefined) firedBy[nodeId] = entry.firedBy;
    }
    return {
      upstream,
      upstreamKeys,
      firedBy,
      key: signal.key,
      constants: this.constants,
      native: signal.payload,
    };
  }

  /** The signal a node emits, carrying its own contribution to the chain. */
  private emit(
    node: WatchNode,
    signal: Signal,
    payload: Record<string, unknown>,
    firedBy?: unknown,
    instance?: number,
  ): Signal {
    const provenance = new Map(signal.provenance);
    provenance.set(node.id, {
      payload,
      key: signal.key,
      ...(firedBy === undefined ? {} : { firedBy }),
    });
    // The instance travels with the signal: two live instances of one key that
    // fire at the same sequence number are two firings, and the firings table
    // is unique on that identity. Without it the second is discarded as a
    // duplicate and its payload is lost.
    return { ...signal, payload, provenance, ...(instance === undefined ? {} : { instance }) };
  }

  // -------------------------------------------------------------------------
  // Node behaviour
  // -------------------------------------------------------------------------

  private async arm(
    node: WatchNode,
    signal: Signal,
    edge: Edge,
    broadcastInstance?: number,
  ): Promise<void> {
    const rendered = renderKey(signal.key);
    const keyHash = hashKey(signal.key);

    switch (node.type) {
      case "source.document_event":
      case "source.analytics_row":
      case "source.open_loop":
      case "source.time":
        // Trip-wires have no inputs; nothing can arm them.
        return;

      case "stateless.or": {
        const payload = evaluateMap(node.output_map, this.scopeFor(signal), signal.payload);
        this.trace.record(signal.seq, node.id, rendered, "fired", `via ${edge.from}`);
        await this.propagate(node.id, this.emit(node, signal, payload, edge.from));
        return;
      }

      case "stateless.transform": {
        const columns = await this.queryColumns(node.query, signal, node.id, rendered);
        const fired = columns.fires === true;
        this.trace.record(signal.seq, node.id, rendered, fired ? "fired" : "held");
        if (!fired) return;
        const payload = evaluateMap(
          node.output_map,
          { ...this.scopeFor(signal), native: columns },
          signal.payload,
        );
        await this.propagate(node.id, this.emit(node, signal, payload));
        return;
      }

      case "stateful.wait":
        this.armWait(node, signal, keyHash, rendered);
        return;

      case "stateful.and":
      case "stateful.threshold":
      case "stateful.sequence":
        await this.armMultiInput(node, signal, edge, keyHash, rendered);
        return;

      case "stateful.cooldown":
        await this.armCooldown(node, signal, keyHash, rendered);
        return;

      case "stateful.persistence":
        await this.armPersistence(node, signal, keyHash, rendered);
        return;

      case "sql":
        await this.armSql(node, signal, keyHash, rendered, broadcastInstance);
        return;

      case "llm":
        await this.armLlm(node, signal, keyHash, rendered);
        return;

      default:
        // Every node type is handled above. A new one fails to compile here
        // rather than silently doing nothing, which is how the last round of
        // unimplemented semantics went unnoticed.
        return assertNever(node);
    }
  }

  /**
   * Whether an arm may start a new instance under this collision mode, and
   * what to do with the ones already live.
   *
   * Returns the instance ordinal to write, or `null` when the arm is refused.
   */
  private resolveCollision(
    node: WatchNode,
    mode: "reset" | "ignore" | "spawn" | "accumulate",
    keyHash: string,
    rendered: string,
    seq: number,
  ): number | null {
    const live = this.store.cellsForKey(this.watchId, node.id, keyHash);

    if (mode === "spawn") {
      const ceiling = "max_live_instances" in node ? node.max_live_instances : undefined;
      if (ceiling !== undefined && live.length >= ceiling) {
        this.trace.record(
          seq,
          node.id,
          rendered,
          "refused",
          `already at its ceiling of ${ceiling} live instances`,
        );
        return null;
      }
      return this.store.nextInstance(this.watchId, node.id, keyHash);
    }

    if (live.length === 0) return 0;

    if (mode === "ignore") {
      this.trace.record(seq, node.id, rendered, "ignored", "an instance is already live");
      return null;
    }

    if (mode === "reset") {
      // A real reset: the old instance and its deadline go, and the new arm
      // starts the lifecycle over.
      for (const cell of live) this.store.dropCell(this.watchId, node.id, keyHash, cell.instance);
      this.trace.record(seq, node.id, rendered, "reset");
      return 0;
    }

    // accumulate: the cell survives and is fed rather than replaced.
    return live[0]!.instance;
  }

  private armWait(
    node: Extract<WatchNode, { type: "stateful.wait" }>,
    signal: Signal,
    keyHash: string,
    rendered: string,
  ): void {
    const instance = this.resolveCollision(node, node.on_collision, keyHash, rendered, signal.seq);
    if (instance === null) return;

    const duration = parseDuration(node.duration);
    // Anchored to the clock, not to the event: a source backfilling a
    // month-old email must not pull a live deadline into the past.
    const armedAt = Math.max(signal.atMs, this.clock.nowMs);
    const dueAt = duration ? this.addDuration(armedAt, duration) : armedAt;

    this.saveCell(node.id, keyHash, instance, signal.key, {
      state: "live",
      armedAtMs: armedAt,
      deadlineAtMs: dueAt,
      level: null,
      slots: {},
      payload: signal.payload,
      lastFiredAtMs: null,
      arrivals: [],
      provenance: Object.fromEntries(signal.provenance),
      heldSinceMs: null,
    });
    this.store.setTimer({
      watchId: this.watchId,
      nodeId: node.id,
      keyHash,
      instance,
      key: signal.key,
      dueAtMs: dueAt,
      kind: "wait",
    });
    this.trace.record(signal.seq, node.id, rendered, "armed", undefined, instance);
  }

  private async armMultiInput(
    node: Extract<WatchNode, { type: "stateful.and" | "stateful.threshold" | "stateful.sequence" }>,
    signal: Signal,
    edge: Edge,
    keyHash: string,
    rendered: string,
  ): Promise<void> {
    // Broadcast edges are excluded from arming and from the count: they carry
    // no channel of their own, so letting one occupy a slot would make "two of
    // three sources agreed" mean "one source agreed and a week passed".
    if (edge.broadcast) {
      const live = this.store.cellsForKey(this.watchId, node.id, keyHash);
      this.trace.record(
        signal.seq,
        node.id,
        rendered,
        live.length > 0 ? "held" : "dropped",
        live.length > 0 ? "broadcast to a live instance" : "broadcast with no live instance",
      );
      return;
    }

    const armInputs = Object.entries(nodeInputs(node))
      .filter(([, input]) => input.role === "arm" && input.broadcast !== true)
      .map(([id]) => id);

    let existing = this.store.cell(this.watchId, node.id, keyHash);

    if (node.type === "stateful.sequence") {
      // Positions are counted over the inputs that can actually occupy a slot.
      // A broadcast input may be named in `order`, but broadcast edges are
      // routed to re-evaluation and never fill anything, so counting it would
      // leave the expected position permanently ahead of the filled count and
      // the gate would drop every arrival after its first.
      const ordered = node.order.filter((id) => armInputs.includes(id));
      const position = ordered.indexOf(edge.from);
      const filled = Object.keys(existing?.slots ?? {}).length;
      if (position !== filled) {
        // An out-of-order arrival is dropped, not stashed: stashing it would
        // silently degrade the gate into an unordered AND. Restarting the
        // sequence on its own first element is the one exception, and only
        // under `reset`.
        if (!(position === 0 && node.on_collision === "reset" && existing)) {
          this.trace.record(
            signal.seq,
            node.id,
            rendered,
            "dropped",
            `expected ${ordered[filled] ?? "nothing"}`,
          );
          return;
        }
        this.store.dropCell(this.watchId, node.id, keyHash, existing.instance);
        this.trace.record(signal.seq, node.id, rendered, "reset");
        existing = null;
      }

      // An ordered gate asserts that one thing happened *after* another, so an
      // element has to arrive later than the one it follows. Two source nodes
      // whose filters both match the same document fire at the same sequence
      // off the same event: nothing followed anything, and admitting it would
      // let one document satisfy a whole sequence — with the verdict decided by
      // the order the source nodes happen to be declared in, since that is what
      // sets which fires first within the event.
      if (existing && position > 0) {
        const latest = Math.max(...Object.values(existing.slots).map((slot) => slot.seq));
        if (signal.seq <= latest) {
          this.trace.record(
            signal.seq,
            node.id,
            rendered,
            "dropped",
            `${edge.from} did not follow ${ordered[position - 1]}; both arrived at the same event`,
          );
          return;
        }
      }
    } else if (existing && existing.slots[edge.from]) {
      if (node.on_collision === "ignore") {
        this.trace.record(signal.seq, node.id, rendered, "ignored", `${edge.from} already arrived`);
        return;
      }
      // reset: this input's slot restarts, and the deadline re-anchors to it.
      this.store.dropCell(this.watchId, node.id, keyHash, existing.instance);
      this.trace.record(signal.seq, node.id, rendered, "reset");
      existing = null;
    }

    const slots = { ...(existing?.slots ?? {}) };
    // Each branch keeps its own provenance. Merging only payloads would make
    // `$n.<earlier-branch>.<field>` resolve to null and let arrival order decide
    // which branch of a join is addressable — the one thing a join is for.
    slots[edge.from] = {
      seq: signal.seq,
      payload: signal.payload,
      provenance: Object.fromEntries(signal.provenance),
    };

    const required = node.type === "stateful.threshold" ? node.n : armInputs.length;
    const arrived = Object.keys(slots).length;

    if (arrived >= required) {
      if (existing) this.store.dropCell(this.watchId, node.id, keyHash, existing.instance);
      const merged = Object.assign(
        {},
        ...Object.values(slots).map((slot) => slot.payload),
      ) as Record<string, unknown>;
      const provenance = new Map(signal.provenance);
      for (const slot of Object.values(slots)) {
        for (const [nodeId, entry] of Object.entries(slot.provenance ?? {})) {
          provenance.set(nodeId, entry);
        }
      }
      this.trace.record(signal.seq, node.id, rendered, "fired");
      const firedBy = node.type === "stateful.threshold" ? Object.keys(slots).sort() : undefined;
      const joined = { ...signal, payload: merged, provenance };
      const payload = evaluateMap(node.output_map, this.scopeFor(joined), merged);
      await this.propagate(node.id, this.emit(node, joined, payload, firedBy));
      return;
    }

    const armedAtMs = existing?.armedAtMs ?? Math.max(signal.atMs, this.clock.nowMs);
    const deadline = node.deadline === "infinite" ? null : parseDuration(node.deadline);
    const deadlineAtMs = deadline ? this.addDuration(armedAtMs, deadline) : null;

    this.saveCell(node.id, keyHash, existing?.instance ?? 0, signal.key, {
      state: "live",
      armedAtMs,
      deadlineAtMs,
      level: null,
      slots,
      payload: signal.payload,
      lastFiredAtMs: null,
      arrivals: [],
      provenance: Object.fromEntries(signal.provenance),
      heldSinceMs: null,
    });
    if (deadlineAtMs !== null) {
      this.store.setTimer({
        watchId: this.watchId,
        nodeId: node.id,
        keyHash,
        instance: existing?.instance ?? 0,
        key: signal.key,
        dueAtMs: deadlineAtMs,
        kind: "deadline",
      });
    }
    this.trace.record(
      signal.seq,
      node.id,
      rendered,
      existing ? "accumulated" : "armed",
      `${arrived}/${required}`,
    );
  }

  private async armCooldown(
    node: Extract<WatchNode, { type: "stateful.cooldown" }>,
    signal: Signal,
    keyHash: string,
    rendered: string,
  ): Promise<void> {
    // The only mode these nodes accept is `accumulate`, and the validator
    // enforces it. Resolving it anyway keeps the engine reading the DSL rather
    // than assuming it: a mode added later cannot be silently ignored here.
    const instance = this.resolveCollision(
      node,
      node.on_collision ?? "accumulate",
      keyHash,
      rendered,
      signal.seq,
    );
    if (instance === null) return;

    const existing = this.store.cell(this.watchId, node.id, keyHash);
    const interval = parseDuration(node.min_interval);
    const since = existing?.lastFiredAtMs ?? null;
    const ready = since === null || !interval || signal.atMs - since >= durationMs(interval);

    this.saveCell(node.id, keyHash, instance, signal.key, {
      state: "accumulating",
      armedAtMs: signal.atMs,
      deadlineAtMs: null,
      level: null,
      slots: {},
      payload: signal.payload,
      lastFiredAtMs: ready ? signal.atMs : since,
      arrivals: [],
      provenance: Object.fromEntries(signal.provenance),
      heldSinceMs: null,
    });

    this.trace.record(
      signal.seq,
      node.id,
      rendered,
      ready ? "fired" : "held",
      ready ? undefined : "within the cooldown",
    );
    if (!ready) return;

    const payload = evaluateMap(node.output_map, this.scopeFor(signal), signal.payload);
    await this.propagate(node.id, this.emit(node, signal, payload));
  }

  private async armPersistence(
    node: Extract<WatchNode, { type: "stateful.persistence" }>,
    signal: Signal,
    keyHash: string,
    rendered: string,
  ): Promise<void> {
    const instance = this.resolveCollision(
      node,
      node.on_collision ?? "accumulate",
      keyHash,
      rendered,
      signal.seq,
    );
    if (instance === null) return;

    const existing = this.store.cell(this.watchId, node.id, keyHash);
    const window = parseDuration(node.duration);
    const windowMs = window ? durationMs(window) : DAY_MS;
    const arrivals = [...(existing?.arrivals ?? []), signal.atMs].filter(
      (at) => signal.atMs - at <= windowMs,
    );
    const fired = arrivals.length >= node.min_events;

    this.saveCell(node.id, keyHash, instance, signal.key, {
      state: "accumulating",
      armedAtMs: existing?.armedAtMs ?? signal.atMs,
      deadlineAtMs: null,
      level: null,
      slots: {},
      payload: signal.payload,
      lastFiredAtMs: fired ? signal.atMs : (existing?.lastFiredAtMs ?? null),
      arrivals: fired ? [] : arrivals,
      provenance: Object.fromEntries(signal.provenance),
      heldSinceMs: null,
    });

    this.trace.record(
      signal.seq,
      node.id,
      rendered,
      fired ? "fired" : "accumulated",
      fired ? undefined : `${arrivals.length} of ${node.min_events} within ${node.duration}`,
    );
    if (!fired) return;

    const payload = evaluateMap(node.output_map, this.scopeFor(signal), signal.payload);
    await this.propagate(node.id, this.emit(node, signal, payload));
  }

  /**
   * A SQL node, in whichever of its forms the DSL declared.
   *
   * Arm-driven and instant when it has no timer, no persistence and no level to
   * remember. With any of those it holds a cell: a `timer` re-runs the query on
   * an interval, `persistence` requires the predicate to keep holding for a
   * duration before it fires, and a `deadline` gives the whole thing an end.
   */
  private async armSql(
    node: Extract<WatchNode, { type: "sql" }>,
    signal: Signal,
    keyHash: string,
    rendered: string,
    broadcastInstance?: number,
  ): Promise<void> {
    const stateful = isStatefulSql(node);
    let instance = broadcastInstance ?? 0;

    if (stateful && broadcastInstance === undefined) {
      const resolved = this.resolveCollision(
        node,
        node.on_collision ?? "accumulate",
        keyHash,
        rendered,
        signal.seq,
      );
      if (resolved === null) return;
      instance = resolved;
    }

    const existing = stateful
      ? (this.store
          .cellsForKey(this.watchId, node.id, keyHash)
          .find((c) => c.instance === instance) ?? null)
      : null;

    const columns = await this.queryColumns(node.query, signal, node.id, rendered);
    const holds = columns.fires === true;

    // `persistence` requires the predicate to keep holding for a duration
    // before it counts. The moment the raw condition lapses, the clock on it
    // restarts; while it holds, the instant it first became true is kept.
    const persistence = node.persistence === undefined ? null : parseDuration(node.persistence);
    // The predicate's own clock, distinct from the instance's: it restarts the
    // moment the predicate lapses, while the instance's deadline does not.
    // Null while the predicate does not hold, rather than the instant it was
    // last evaluated at — "since when has this been true" has no answer for
    // something that is false, and stamping the evaluation there makes a cell
    // that holds nothing indistinguishable from one that just became true.
    const heldSinceMs = holds ? (existing?.heldSinceMs ?? signal.atMs) : null;
    const persisted =
      !persistence ||
      (holds && heldSinceMs !== null && signal.atMs - heldSinceMs >= durationMs(persistence));

    // The condition the node fires on. With persistence that is "has held long
    // enough", not "holds right now" — and the edge has to be measured against
    // *that*, or the first observation consumes the rise and the node can never
    // fire once the duration finally elapses.
    const effective = holds && persisted;
    const previous = existing?.level ?? null;
    const rising = node.fire_on === "rising_edge";
    const baseline = previous ?? (node.initial_level === "assume_false" ? false : effective);
    const fired = rising ? effective && !baseline : effective;

    if (stateful) {
      const deadline =
        node.deadline === undefined || node.deadline === "infinite"
          ? null
          : parseDuration(node.deadline);
      // One anchor for both the cell and the deadline stored beside it. A
      // backfilled event carries a semantic time well behind the clock, and
      // taking the deadline from the raw event time while the cell records the
      // clamped one gives an instance a deadline already in the past — dead on
      // arrival, then silently moved to a different instant by its first poll,
      // which re-derives it from the cell instead.
      const armedAtMs = existing?.armedAtMs ?? Math.max(signal.atMs, this.clock.nowMs);
      const deadlineAtMs = deadline ? this.addDuration(armedAtMs, deadline) : null;

      this.saveCell(node.id, keyHash, instance, signal.key, {
        state: "accumulating",
        armedAtMs,
        heldSinceMs,
        deadlineAtMs,
        level: effective,
        slots: {},
        payload: signal.payload,
        lastFiredAtMs: fired ? signal.atMs : (existing?.lastFiredAtMs ?? null),
        arrivals: [],
        provenance: Object.fromEntries(signal.provenance),
      });

      if (deadlineAtMs !== null) {
        this.store.setTimer({
          watchId: this.watchId,
          nodeId: node.id,
          keyHash,
          instance,
          key: signal.key,
          dueAtMs: deadlineAtMs,
          kind: "deadline",
        });
      }

      // A `timer` re-runs the query on its own interval, independently of any
      // arm — that is what makes a polling watch poll.
      const poll = node.timer === undefined ? null : parseDuration(node.timer);
      const pollDueAt = poll ? signal.atMs + durationMs(poll) : null;
      // A poll scheduled past the instance's own deadline would keep the cell
      // alive forever; the deadline is what ends it.
      if (poll && !fired && (deadlineAtMs === null || pollDueAt! <= deadlineAtMs)) {
        this.store.setTimer({
          watchId: this.watchId,
          nodeId: node.id,
          keyHash,
          instance,
          key: signal.key,
          dueAtMs: pollDueAt!,
          kind: "poll",
        });
      }
    }

    this.trace.record(
      signal.seq,
      node.id,
      rendered,
      fired ? "fired" : "held",
      !fired && holds && !persisted
        ? `holding, but not yet for ${node.persistence}`
        : !fired && rising && effective
          ? "already holding"
          : undefined,
      instance,
    );
    if (!fired) return;

    // A fired instance is over, and leaving its cell behind leaks one row per
    // key forever — under `spawn`, wedging the key at its ceiling permanently.
    //
    // `accumulate` is the exception, and deliberately so: it is the one mode
    // whose cell outlives its own firing. The cell is also the only place the
    // last observed boolean is kept, so dropping it here would erase the level
    // a rising edge is measured against and the node would re-fire on every
    // later arm — turning `rising_edge` into `every_true`.
    if (stateful && node.on_collision !== "accumulate") {
      this.store.dropCell(this.watchId, node.id, keyHash, instance);
    }
    const payload = evaluateMap(
      node.output_map,
      { ...this.scopeFor(signal), native: columns },
      columns,
    );
    await this.propagate(node.id, this.emit(node, signal, payload, undefined, instance));
  }

  private async armLlm(
    node: Extract<WatchNode, { type: "llm" }>,
    signal: Signal,
    keyHash: string,
    rendered: string,
    reevaluating?: number,
  ): Promise<void> {
    const mode = node.on_collision ?? "reset";
    // A broadcast re-evaluation names the instance it is re-running, so the
    // collision policy is not consulted: there is no new arm to collide.
    const instance =
      reevaluating ?? this.resolveCollision(node, mode, keyHash, rendered, signal.seq);
    if (instance === null) return;

    const existing = this.store
      .cellsForKey(this.watchId, node.id, keyHash)
      .find((c) => c.instance === instance);

    // An accumulate cell gathers evidence across evaluations, so the judge sees
    // what earlier arms contributed rather than only the latest.
    const evidence = { ...(mode === "accumulate" ? existing?.payload : {}), ...signal.payload };
    const documentIds = collectDocumentIds(evidence);

    const verdict = this.judgeVerdict({
      watch: this.watchId,
      nodeId: node.id,
      key: rendered,
      proposition: node.proposition,
      documentIds,
      evidence,
      outputSchema: node.output_schema,
    });

    // A question the judge never answered is not a judgement. The instance
    // keeps its cell either way — an unfired one is live — so the next arm or
    // poll asks again; what must not happen is the trace calling it a decline,
    // which is how a spent budget or a missing model gets read as precision.
    const unanswered = verdict.unanswered;
    const fired =
      unanswered === undefined &&
      verdict.fired &&
      (node.fire_when === undefined || evaluatePredicate(node.fire_when, verdict.output));

    const deadline =
      node.deadline === undefined || node.deadline === "infinite"
        ? null
        : parseDuration(node.deadline);
    // The deadline is anchored to the arm that created the instance, not to
    // whatever last touched it. A broadcast re-evaluation is not a new arm — it
    // is the same instance being looked at again — so re-anchoring here would
    // push the deadline out by one interval on every tick and the instance
    // would never expire, re-invoking the judge for as long as the watch ran.
    const anchorMs = reevaluating !== undefined && existing ? existing.armedAtMs : signal.atMs;
    const deadlineAtMs = deadline
      ? this.addDuration(
          Math.max(anchorMs, reevaluating !== undefined ? anchorMs : this.clock.nowMs),
          deadline,
        )
      : null;

    // An instance that has not fired is live, and a live instance is written
    // down whether or not it has a deadline. `deadline: "infinite"` says the
    // instance never expires — not that it does not exist — and the cell is
    // what `max_live_instances` counts, so skipping it for want of a deadline
    // would make the ceiling unreachable and turn `spawn` unbounded.
    if (mode === "accumulate" || !fired) {
      this.saveCell(node.id, keyHash, instance, signal.key, {
        state: mode === "accumulate" ? "accumulating" : "live",
        armedAtMs: anchorMs,
        deadlineAtMs,
        level: null,
        slots: {},
        payload: { ...evidence, ...verdict.output },
        lastFiredAtMs: fired ? signal.atMs : (existing?.lastFiredAtMs ?? null),
        arrivals: [],
        provenance: Object.fromEntries(signal.provenance),
        heldSinceMs: null,
      });
      if (deadlineAtMs !== null) {
        this.store.setTimer({
          watchId: this.watchId,
          nodeId: node.id,
          keyHash,
          instance,
          key: signal.key,
          dueAtMs: deadlineAtMs,
          kind: "deadline",
        });
      }
    }

    if (unanswered) {
      const retryAtMs = normalizedTimerRetryAt(
        unanswered.retryAtMs,
        this.options.timeReachedMs ?? this.clock.nowMs,
      );
      if (deadlineAtMs === null || retryAtMs <= deadlineAtMs) {
        this.store.setTimer({
          watchId: this.watchId,
          nodeId: node.id,
          keyHash,
          instance,
          key: signal.key,
          dueAtMs: retryAtMs,
          kind: "poll",
        });
      }
      this.trace.unanswered(
        signal.seq,
        node.id,
        rendered,
        unanswered.failure,
        unanswered.reason,
        instance,
      );
    } else {
      this.trace.record(
        signal.seq,
        node.id,
        rendered,
        fired ? "fired" : "held",
        fired ? undefined : declineDetail(verdict),
        instance,
      );
    }
    if (!fired) return;

    if (mode !== "accumulate") this.store.dropCell(this.watchId, node.id, keyHash, instance);
    const payload = evaluateMap(
      node.output_map,
      { ...this.scopeFor(signal), native: verdict.output },
      verdict.output,
    );
    await this.propagate(node.id, this.emit(node, signal, payload, undefined, instance));
  }

  /**
   * Write an instance, supplying the four fields that identify it.
   *
   * Every caller names the same watch, the same node, and the key and instance
   * it is already holding, so repeating them at each site is ceremony around
   * the part that actually differs — and four more places for a new identity
   * field to be forgotten.
   */
  private saveCell(
    nodeId: string,
    keyHash: string,
    instance: number,
    key: Record<string, unknown>,
    fields: Omit<NodeCell, "watchId" | "nodeId" | "keyHash" | "instance" | "key">,
  ): void {
    this.store.putCell({ watchId: this.watchId, nodeId, keyHash, instance, key, ...fields });
  }

  private cancel(node: WatchNode, signal: Signal): void {
    const keyHash = hashKey(signal.key);
    const cells = this.store.cellsForKey(this.watchId, node.id, keyHash);
    if (cells.length === 0) return;
    // A cancel for a key ends every instance armed under it.
    for (const cell of cells) {
      this.store.dropCell(this.watchId, node.id, keyHash, cell.instance);
      this.trace.record(
        signal.seq,
        node.id,
        renderKey(signal.key),
        "cancelled",
        undefined,
        cell.instance,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  /**
   * Fire every timer due at or before `untilMs`, containing a failure the way
   * an event dispatch is contained. Swept after the arriving event's cancels
   * have been delivered at the same instant, which is the tie rule.
   */
  /**
   * How far timers may be drained for the event being processed.
   *
   * A timer comes due in *real* time, and an event's semantic time is not real
   * time. A calendar row carries the appointment's start, so making an
   * appointment for tomorrow puts a journal event dated tomorrow on the feed
   * today — and draining to it fires every timer due between now and then. A
   * daily tick loses the boundary it was going to fire on, having already
   * fired it early against data that did not exist yet, and the schedule
   * silently skips a day.
   *
   * This is the argument the horizon check makes a few lines above, applied to
   * the other thing a forward-dated document must not be allowed to move.
   *
   * A replay supplies no real time and needs none: its journal is the whole of
   * what happened, so semantic time is the only time there is.
   */
  private drainThrough(semanticMs: number): number {
    const reached = this.options.timeReachedMs;
    return reached === undefined ? semanticMs : Math.min(semanticMs, reached);
  }

  /**
   * Fire timers due through `untilMs`, never past the horizon.
   *
   * A deadline that came due before the watch expired is a deadline the watch
   * owed, and the drains above run before the horizon is read so that it is
   * honoured. One that comes due after is not owed at all: the question had
   * ended by the time it arrived. Without the bound, whether a past-horizon
   * boundary fires would turn on how far an arriving event — or a live host's
   * clock — happened to drag the sweep, which is how a retired daily digest
   * goes on interrupting somebody every morning.
   */
  private async drainTimers(untilMs: number): Promise<void> {
    const horizon = this.horizonMs;
    const bounded = horizon === null ? untilMs : Math.min(untilMs, horizon);
    await this.guarded(() => this.fireDueTimers(bounded));
  }

  private async fireDueTimers(untilMs: number): Promise<void> {
    for (;;) {
      if (this.paused || !this.store.isActive(this.watchId)) return;
      const due = this.store.dueTimers(this.watchId, untilMs);
      if (due.length === 0) return;

      const timer = due[0]!;
      this.clock.advanceTo(timer.dueAtMs);

      // The timer is journaled: it gets a sequence number of its own, so the
      // trace attributes an expiry to the timer rather than to whichever event
      // happened to be in flight.
      const seq = this.store.takeTimerSeq(this.watchId);
      this.currentSeq = seq;

      const node = this.nodes.get(timer.nodeId);
      if (!node) {
        this.store.clearTimer(
          this.watchId,
          timer.nodeId,
          timer.keyHash,
          timer.instance,
          timer.kind,
        );
        continue;
      }

      // Consumed only once the work it schedules has been done. Clearing it up
      // front means a failure mid-evaluation loses the deadline outright, and
      // repairing the watch could never recover the firing it owed.
      const consume = (): void =>
        this.store.clearTimer(
          this.watchId,
          timer.nodeId,
          timer.keyHash,
          timer.instance,
          timer.kind,
        );

      const rendered = renderKey(timer.key);
      const signal: Signal = {
        seq,
        atMs: timer.dueAtMs,
        payload: { timerId: node.id, dueAt: new Date(timer.dueAtMs).toISOString() },
        key: timer.key,
        firedBy: node.id,
        provenance: new Map(),
      };

      if (timer.kind === "tick" && node.type === "source.time") {
        consume();
        this.trace.record(seq, node.id, SINGLETON_KEY, "fired");
        await this.propagate(
          node.id,
          this.emit(node, signal, { timerId: node.id, dueAt: signal.payload.dueAt as string }),
        );
        // Catch-up re-arms from the boundary, so an outage produces the
        // boundaries it missed in order rather than a burst at the resume.
        const next = this.nextTick(node, timer.dueAtMs);
        if (next !== null) this.store.setTimer({ ...timer, dueAtMs: next });
        continue;
      }

      const cell = this.store
        .cellsForKey(this.watchId, timer.nodeId, timer.keyHash)
        .find((c) => c.instance === timer.instance);
      if (!cell) {
        consume();
        continue;
      }

      const cellSignal: Signal = {
        ...signal,
        payload: cell.payload,
        key: cell.key,
        provenance: new Map(Object.entries(cell.provenance)),
      };

      if (timer.kind === "wait") {
        // For a wait, the deadline expiring *is* the fire.
        consume();
        this.store.dropCell(this.watchId, timer.nodeId, timer.keyHash, timer.instance);
        this.trace.record(seq, node.id, rendered, "fired", "the wait elapsed", timer.instance);
        const payload = evaluateMap(node.output_map, this.scopeFor(cellSignal), cell.payload);
        await this.propagate(
          node.id,
          this.emit(node, cellSignal, payload, undefined, timer.instance),
        );
        continue;
      }

      if (timer.kind === "poll" && node.type === "sql") {
        consume();
        // Re-run the query without an arm. The cell already holds the payload
        // the original arm carried, so bindings stay the ones it was armed on.
        await this.armSql(node, cellSignal, timer.keyHash, rendered, timer.instance);
        continue;
      }

      if (timer.kind === "poll" && node.type === "llm") {
        consume();
        await this.armLlm(node, cellSignal, timer.keyHash, rendered, timer.instance);
        continue;
      }

      consume();
      this.store.dropCell(this.watchId, timer.nodeId, timer.keyHash, timer.instance);
      this.trace.record(seq, node.id, rendered, "expired", undefined, timer.instance);
    }
  }

  // -------------------------------------------------------------------------
  // SQL
  // -------------------------------------------------------------------------

  private async queryColumns(
    query: string,
    signal: Signal,
    nodeId: string,
    rendered: string,
  ): Promise<Record<string, unknown>> {
    const values: Record<string, SqlParameter> = {
      $today: this.clock.today,
      $now: this.clock.now,
    };

    for (const match of query.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)) {
      const reference = match[0];
      if (reference === "$today" || reference === "$now") continue;
      values[reference] = this.bind(reference, this.resolveReference(reference, signal), nodeId);
    }

    try {
      const result = await this.options.analytics.query(query, values);
      return (result.rows[0] as Record<string, unknown> | undefined) ?? { fires: false };
    } catch (error) {
      throw new InstanceFailure(nodeId, rendered, error, "query");
    }
  }

  /**
   * Bind a reference's value with the type the definition says it holds.
   *
   * A value that has crossed the journal has been through JSON, which has no
   * decimal, no date and no interval. So a `DECIMAL(18,4)` column reaches a
   * binding site as a string, binds VARCHAR, and `abs($n.spend.amount)` is
   * refused by the binder — not answered wrongly, refused, which stops the
   * watch. The declared type is what puts the type back.
   *
   * The shape of the value is still the fallback, and has to be: a judge
   * returns whatever its `output_schema` says and a SQL node's own result
   * columns are untyped by the analyzer, so plenty of references resolve to
   * `unknown` here. Where the validator does know, it wins.
   */
  private bind(reference: string, value: unknown, nodeId: string): SqlParameter {
    const sqlType = sqlTypeFor(this.declaredType(reference, nodeId));
    if (sqlType === undefined) return asSqlParameter(value);
    return { sqlType, value: value as string | number | boolean | null };
  }

  /** What the validator worked out this reference resolves to, if anything. */
  private declaredType(reference: string, nodeId: string): ValueType | undefined {
    const types = this.options.valueTypes;
    if (!types) return undefined;
    const parts = reference.slice(1).split(".");
    if (parts[0] === "n") return types.nodes.get(parts[1] ?? "")?.get(parts[2] ?? "");
    if (parts[0] === "key") return types.keys.get(nodeId)?.get(parts[1] ?? "");
    if (parts[0] === "const") return types.constants.get(parts[1] ?? "");
    return undefined;
  }

  private resolveReference(reference: string, signal: Signal): unknown {
    const scope = this.scopeFor(signal);
    const parts = reference.slice(1).split(".");
    if (parts[0] === "key") return scope.key?.[parts[1] ?? ""] ?? null;
    if (parts[0] === "const") return this.constants[parts[1] ?? ""] ?? null;
    if (parts[0] === "n") return scope.upstream?.[parts[1] ?? ""]?.[parts[2] ?? ""] ?? null;
    return null;
  }

  /**
   * Advance an instant by a duration, in the evaluation timezone. Business days
   * are a calendar unit: five of them after a Friday is the following Friday,
   * and a deadline never lands on a weekend.
   */
  private addDuration(atMs: number, duration: Duration): number {
    if (duration.unit !== "business_days") return atMs + durationMs(duration);

    const offset = this.tz * 60_000;
    let cursor = atMs;
    let remaining = Math.max(0, Math.floor(duration.amount));
    while (remaining > 0) {
      cursor += DAY_MS;
      if (isWeekday(cursor + offset)) remaining -= 1;
    }
    while (!isWeekday(cursor + offset)) cursor += DAY_MS;
    return cursor;
  }
}

/** Bounded role/direction evidence; identities belong in structural filters. */
function boundedPersonRoles(
  people: readonly { role: string; isSelf: boolean }[],
): { role: string; isSelf: boolean }[] {
  const result: { role: string; isSelf: boolean }[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    const key = `${person.role}\u0000${person.isSelf ? "self" : "other"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ role: person.role, isSelf: person.isSelf });
    if (result.length === 32) break;
  }
  return result;
}

/**
 * Whether a source a filter names covers the source a document came from.
 *
 * A source is identified as `<type>` or `<type>:<account>`, and the two halves
 * of the system see different ones. A profile is published per **type**, so the
 * ontology a watch is validated against declares `gmail`; a document carries
 * the **account-qualified** id its row holds, `gmail:someone@example.com`. A
 * filter written against the declaration is therefore checked against events
 * that name the account.
 *
 * So naming a type covers every account of it, and naming an account covers
 * only that one. Compared on the type component rather than as a string prefix,
 * or `gmail` would also swallow `gmail-archive:…`.
 *
 * Equality here was silent in the worst way: every fixture universe names its
 * sources by bare type, so equality passed the entire suite and then matched
 * nothing on an install that had ever added an account — the watch validating,
 * installing, sitting active and never firing, with no error to find, because
 * "nothing matched the filter" is not an error.
 */
function sourceMatches(named: string, documentSourceId: string): boolean {
  return sourceIdAddresses(named, documentSourceId);
}

/**
 * Whether a nominating source has to wait for the document to be indexed.
 *
 * A **semantic** arm compares an embedding, which does not exist until the
 * indexer has made one — so a node carrying one waits for `doc.indexed`, and
 * the semantic clock is the only clock it can run on.
 *
 * A **lexical** arm is a term match against the document's own title. Nothing
 * about it needs an index, and waiting for one costs more than latency: the
 * order documents finish indexing in is the order embedding work happens to
 * complete, which bears no relation to the order they arrived. A
 * `stateful.sequence` fed from lexical arms therefore could not answer "did A
 * come before B" — two mails sent a minute apart and indexed in one batch
 * reached the gate in whichever order the workers finished, and the gate
 * faithfully reported that. Evaluated on `doc.event`, the journal's order is
 * the order, which is the only order that means anything.
 */
function waitsForTheIndex(node: Extract<WatchNode, { type: "source.document_event" }>): boolean {
  return node.recall?.semantic !== undefined;
}

/** Whether a SQL node holds an instance between arm and fire. */
function isStatefulSql(node: Extract<WatchNode, { type: "sql" }>): boolean {
  return (
    node.timer !== undefined ||
    node.persistence !== undefined ||
    node.fire_on === "rising_edge" ||
    node.on_collision === "accumulate"
  );
}

/**
 * What to write down about a judge that considered the evidence and said no.
 *
 * The judge is asked for a sentence, and it is the only account of why this
 * watch stayed quiet on a document the operator can see it looked at. Recording
 * a constant instead would leave "it decided against every one of these" and
 * "it decided against this one because the amount was under the threshold"
 * looking identical.
 *
 * Read defensively because `output` is model-authored: a judge that returned
 * something other than a sentence falls back to naming the decision alone.
 */
function declineDetail(verdict: JudgeVerdict): string {
  const because = verdict.output.because;
  if (typeof because !== "string") return "judge declined";
  const said = because.trim();
  return said === "" ? "judge declined" : `judge declined: ${said.slice(0, DECLINE_DETAIL_MAX)}`;
}

function assertNever(value: never): never {
  throw new Error(`unhandled node type: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Bind a reference's value with a SQL type when its shape says what it is.
 *
 * A judge that declares `depart_date: "date"` hands back a string, and
 * `$n.trip.depart_date + INTERVAL 6 MONTH` is how a watch compares it — which
 * DuckDB cannot do with text. The shape is the only thing available here: node
 * outputs are typed in the DSL, but a value arriving from a judge carries no
 * type at run time. Anything that is not date-shaped binds as it is.
 *
 * Used only where the validator could not type the reference — a judge's
 * output, or a SQL result column the analyzer could not name. Where it could,
 * `WatchEngine.bind` uses the declared type instead.
 */
function asSqlParameter(value: unknown): SqlParameter {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { sqlType: "DATE", value };
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return { sqlType: "TIMESTAMPTZ", value };
  }
  return value as SqlParameter;
}

/**
 * The SQL type a DSL value type binds as, or undefined to leave it alone.
 *
 * Only the four kinds that are genuinely a different type in SQL than the
 * string a JSON round trip leaves behind. Strings, ids, enums and lists are
 * already text and casting them to VARCHAR would achieve nothing except
 * overriding the date-shape fallback, which is the only thing that gets an
 * untyped judge output bound as an instant.
 */
function sqlTypeFor(
  type: ValueType | undefined,
): "DOUBLE" | "BOOLEAN" | "DATE" | "TIMESTAMPTZ" | undefined {
  switch (type?.kind) {
    case "number":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "date":
      return "DATE";
    case "timestamp":
      return "TIMESTAMPTZ";
    default:
      return undefined;
  }
}

function isWeekday(atMs: number): boolean {
  const day = new Date(atMs).getUTCDay();
  return day >= 1 && day <= 5;
}

function metadataMatches(
  metadata: Readonly<Record<string, unknown>>,
  predicate: { path: string; op: string; value?: unknown },
): boolean {
  const actual = predicate.path
    .split(".")
    .reduce<unknown>(
      (cursor, step) =>
        cursor !== null && typeof cursor === "object" && Object.hasOwn(cursor, step)
          ? (cursor as Record<string, unknown>)[step]
          : null,
      metadata,
    );

  switch (predicate.op) {
    case "exists":
      return actual !== null && actual !== undefined;
    case "eq":
      return actual === predicate.value;
    case "neq":
      return actual !== predicate.value;
    case "in":
      return Array.isArray(predicate.value) && predicate.value.includes(actual as never);
    case "not_in":
      return Array.isArray(predicate.value) && !predicate.value.includes(actual as never);
    case "contains":
      return Array.isArray(actual) && actual.includes(predicate.value as never);
    default:
      return false;
  }
}

/** Document ids a judge should be understood to have read. */
function collectDocumentIds(evidence: Readonly<Record<string, unknown>>): string[] {
  const ids: string[] = [];
  for (const [name, value] of Object.entries(evidence)) {
    if (typeof value !== "string") continue;
    if (/doc|evidence/i.test(name)) ids.push(value);
  }
  return ids;
}

/** Keep a host/provider bug from turning a durable retry into a hot loop or a permanent park. */
function normalizedRetryAt(candidate: number | undefined, reachedMs: number): number {
  const fallback = reachedMs + DEFAULT_UNANSWERED_RETRY_MS;
  // Providers predating retry hints keep the historical next-pass behavior.
  // The live Watch judge always supplies an explicit bounded cooldown.
  if (candidate === undefined) return 0;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < reachedMs ||
    candidate > reachedMs + MAX_UNANSWERED_RETRY_MS
  ) {
    return fallback;
  }
  return candidate;
}

/** Timer retries must always move forward or the due-timer drain cannot terminate. */
function normalizedTimerRetryAt(candidate: number | undefined, reachedMs: number): number {
  const fallback = reachedMs + DEFAULT_UNANSWERED_RETRY_MS;
  if (
    candidate === undefined ||
    !Number.isSafeInteger(candidate) ||
    candidate <= reachedMs ||
    candidate > reachedMs + MAX_UNANSWERED_RETRY_MS
  ) {
    return fallback;
  }
  return candidate;
}

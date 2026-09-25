// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The runtime as a scheduler task, and the connection it owns.
 *
 * Separate from `host.ts` (which owns the materializer) because the two are
 * separate tasks with separate lifetimes — and, deliberately, separate
 * connections to the same file. The materializer writes the journal from its
 * drain; this reads the journal and writes cells, timers, firings and cursors
 * from its own tick. A shared connection would let one open a transaction while
 * the other was mid-transaction, which is a bug class rather than a bug.
 *
 * WAL plus a busy timeout is what makes two writers on one file ordinary rather
 * than clever: SQLite serialises them and each waits its turn. What it does not
 * make ordinary is *how* the loser waits — a synchronous driver blocks its
 * thread inside the busy handler, and both tasks run on the main one — so the
 * two also share a lease and take turns before reaching SQLite at all. The busy
 * timeout stays as the guard against anything outside this pair.
 */

import { createHash } from "node:crypto";
import {
  createLogger,
  type CompleteCapability,
  type Logger,
  type ResolvedAssignment,
} from "@omnesis/core";
import {
  prepareQuery,
  sqlTypeHints,
  WatchStateStore,
  type AnalyticsPort,
  type JudgeRequest,
  type WatchFailure,
  type WatchLiveState,
} from "@omnesis/watch";
import { openEncryptedSqlite, type EncryptedSqliteDatabase } from "../sqlite-encryption.js";
import { WatchDefinitionStore } from "./definitions.js";
import {
  DEFAULT_IDLE_EVALUATE_INTERVAL_MS,
  WatchEngineHost,
  type DeliveryCaps,
  type EvaluationLatency,
  type EvaluationResult,
  type SkipPlan,
  type WatchDeliveryPort,
  type WatchFireByHandResult,
  type WatchStateResult,
} from "./engine-host.js";
import {
  DEFAULT_JUDGE_BUDGET,
  LiveJudge,
  type JudgeBudget,
  type JudgeBudgetPosition,
  type JudgeTally,
} from "./judge.js";
import { WATCH_JOURNAL_FILENAME } from "./journal-path.js";
import { LiveRecall } from "./recall.js";
import { WatchTraceStore } from "./traces.js";
import type { WatchLayerHealth } from "./health.js";
import type { OntologyCoverage } from "./ontology.js";
import type { AnalyticsDb } from "../analytics-db.js";
import type { Db } from "../data/types.js";
import type { WatchJournalStore } from "./store.js";
import type { WatchNotificationWakeOutcome } from "../push/queue.js";
import type { WriteLease } from "./write-lease.js";
import type { PeriodicTask, TaskOutcome } from "../scheduler/types.js";

const log: Logger = createLogger("gateway").child("watch-v2:engine");

/** How often the watches are evaluated while the journal has events for them. */
const DEFAULT_EVALUATE_INTERVAL_MS = 5_000;
/**
 * How long a connection to the journal waits out a peer holding the write lock.
 *
 * Long enough to sit through a CLI reading the file, short enough that a boot
 * blocked behind something that is not going to let go says so rather than
 * hanging.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
/**
 * The judge needs body context, but an unbounded document can exhaust the
 * model's context before it reaches the proposition. The beginning includes
 * provider headers and the primary body for ordinary messages and documents.
 */
const MAX_JUDGE_EVIDENCE_CHARS = 8_000;
/** And when it does not — which also bounds how late a due timer can fire. */

export interface WatchV2EngineTunables {
  /** Evaluation cadence while the journal has events. */
  readonly evaluateIntervalMs?: number;
  /**
   * Evaluation cadence when it does not.
   *
   * Its own knob rather than the materializer's, whose idle cadence is about
   * how long a captured event may sit in memory. This one also bounds how late
   * a purely time-driven watch fires, since a due deadline is found by a pass
   * rather than announced.
   */
  readonly idleEvaluateIntervalMs?: number;
  /** Journal events handed to one watch per tick. */
  readonly eventsPerWatch?: number;
  /** Trace records kept per watch — how much of a week stays reviewable. */
  readonly traceRetained?: number;
  readonly judge?: Partial<JudgeBudget>;
  /** How often a watch may interrupt a person. */
  readonly delivery?: Partial<DeliveryCaps>;
  /** How often a watch may wake an agent, budgeted apart from interruptions. */
  readonly wake?: Partial<DeliveryCaps>;
}

export interface WatchV2EngineOptions {
  /**
   * The journal, already settled on its path.
   *
   * The same file the materializer writes, and passed in for the same reason:
   * two places computing a filename is how one of them gets moved and the
   * other does not, which on this file means two half-populated journals.
   */
  /**
   * The connections and the stores over them, already opened.
   *
   * Handed in rather than opened here so that the one step of this that can
   * refuse — bringing a file written by an older build up to the shape these
   * queries expect, which takes the write lock — is a step the caller can see
   * refuse. See {@link openWatchStores}.
   */
  readonly stores: WatchStores;
  readonly journal: WatchJournalStore;
  /** The materializer's lease on this file, so the two writers take turns. */
  readonly writes: WriteLease;
  readonly analyticsDb: AnalyticsDb | null;
  readonly indexDb: Db | null;
  /** The documents/people store, for the ontology. */
  readonly ontologyDb: Db;
  readonly tunables?: WatchV2EngineTunables;
  readonly getEmbedder: () => { embedQuery(text: string): Promise<number[]> } | null;
  readonly getCompleter: () => CompleteCapability | null;
  /** Cheap readiness check used by reports; must not instantiate a local model. */
  readonly completerReadiness?: () => { loadable: boolean; reason: string | null };
  /**
   * Identity of the live judge assignment. When it changes, the cached
   * provider is disposed and rebuilt before another Watch can use it.
   */
  readonly getCompleterKey?: () => string;
  /** Where a delivery-bearing watch's firings go. Absent on a shadow-only host. */
  readonly delivery?: () => WatchDeliveryPort | null;
  /** Where an `agent-wake` firing goes. Absent on a host with no agent integration. */
  readonly wake?: () => WatchDeliveryPort | null;
  /**
   * Whether this install has an agent integration configured at all.
   *
   * Not derivable from `delivery`: the production wiring always supplies an
   * opener, and whether that opener finds an agent behind it is a separate
   * question asked per firing. Absent on a host that cannot answer it.
   */
  readonly agentIntegration?: () => boolean;
}

/**
 * Read bounded body context only while the journaled document revision is
 * still current. Old events stay title-only rather than borrowing a newer
 * revision, and deleted or superseded events fall back to portable evidence.
 */
export function createJudgeEvidenceReader(
  db: Db,
): (request: JudgeRequest) => Promise<Readonly<Record<string, unknown>> | null> {
  const readDocument = db.prepare<[number, string], { excerpt: string; content_hash: string }>(
    `SELECT substr(content, 1, ?) AS excerpt, content_hash
       FROM documents
      WHERE id = ?`,
  );
  return (request) => {
    const documentId = request.documentIds[0];
    // Without a revision fence there is no safe live-body lookup. Portable
    // structural evidence is already complete for the proposition.
    if (!documentId || !request.documentRevision) return Promise.resolve(request.evidence);
    // One extra character says whether the SQL-level bound clipped the body;
    // the full value is never materialized in this process.
    const row = readDocument.get(MAX_JUDGE_EVIDENCE_CHARS + 1, documentId);
    // A deletion or newer revision removes only the optional disambiguating
    // body. The journaled title remains the portable evidence for this event.
    if (!row || row.content_hash !== request.documentRevision) {
      return Promise.resolve(request.evidence);
    }
    const clipped = row.excerpt.slice(0, MAX_JUDGE_EVIDENCE_CHARS);
    return Promise.resolve({
      ...request.evidence,
      excerpt:
        row.excerpt.length > MAX_JUDGE_EVIDENCE_CHARS ? `${clipped}\n[excerpt truncated]` : clipped,
    });
  };
}

export interface WatchV2Engine {
  readonly definitions: WatchDefinitionStore;
  readonly traces: WatchTraceStore;
  readonly task: PeriodicTask<unknown, EvaluationResult>;
  /** What a watch has said. Keyed by the definition's id, not its DSL name. */
  firings(
    watchId: string,
    /** How many of the most recent. Every one of them when absent. */
    limit?: number,
  ): {
    seq: number;
    /** With `seq`, the firing's identity — what a delivery row is keyed by. */
    nodeId: string;
    keyHash: string;
    firedAt: string;
    noticedAt: string | null;
    payload: unknown;
    /** The documents it was reached through, if any were. */
    documentIds: string[];
    /** True when an operator fired the watch by hand rather than the runtime. */
    forced: boolean;
  }[];
  /** How many times, without decoding the payloads. */
  firingCount(watchId: string): number;
  /** What delivering each firing did, keyed by the firing's own identity. */
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
  }[];
  reconcilePushRetryOutcomes(outcomes: readonly WatchNotificationWakeOutcome[]): Promise<void>;
  /** What the judge has spent since boot, for the shadow report. */
  judgeSpend(): JudgeTally;
  /** Whether the assigned judge backend can be loaded, and why not when it cannot. */
  judgeReadiness(): { loadable: boolean; reason: string | null };
  /** Where one watch stands against today's judge allowance. */
  judgeBudget(watchId: string): JudgeBudgetPosition;
  /** Everything the runtime holds for one watch, cut at one commit boundary. */
  stateSnapshot(watchId: string, parkedLimit: number): Promise<WatchStateResult>;
  /** How much every watch is holding, counted, for a list rather than a page. */
  liveState(): Promise<{ held: Map<string, WatchLiveState>; journalHead: number }>;
  firingSummary(): Promise<Map<string, { count: number; lastFiredAtMs: number | null }>>;
  /** How long evaluating one watch has been taking. */
  latency(): EvaluationLatency;
  /** Nominations waiting on judge budget. */
  pending(watchId: string): number;
  /** Erase everything held for a watch — what removing one has to mean. */
  forget(watchId: string): void;
  /** How much of the substrate the DSL can address. */
  ontologyCoverage(): OntologyCoverage | null;
  /** Whether the layer is evaluating, and what stopped whatever is not. */
  health(): WatchLayerHealth;
  /** Let a watch run again after it was held. */
  reactivate(watchId: string): void;
  /** Why the runtime stopped a watch, or null if it did not. */
  failure(watchId: string): WatchFailure | null;
  /** Today's notification allowance and how much of it has been spent. */
  deliveryToday(): {
    dailyCap: number;
    perWatchDailyCap: number;
    attempted: number;
    degraded: number;
  };
  /** How many notifications one watch has attempted today. */
  attemptedToday(watchId: string): number;
  /** What it would take to move a watch past the thing it is stuck on, or null. */
  skipPlan(watchId: string): SkipPlan | null;
  /** Carry out a skip, synchronously, inside the caller's write turn. */
  applySkip(watchId: string, plan: SkipPlan): void;
  /**
   * Fire a watch by hand, so where its firings go can be proved on demand
   * rather than waited for. Evaluates nothing and spends no judge budget.
   */
  fireByHand(
    watchId: string,
    input?: {
      readonly payload?: Readonly<Record<string, unknown>>;
      readonly documentIds?: readonly string[];
    },
  ): Promise<WatchFireByHandResult>;
  stop(): Promise<void>;
}

/**
 * The analytics port the runtime queries through.
 *
 * Query-only: the analytics store is the source the journal was made from, and
 * an engine that wrote rows back into it would be editing the corpus it is
 * watching. The absent `applyRow` is what says so.
 *
 * Named and exported rather than built inline, because it is the only
 * implementation production runs and the only one a test can hold to the
 * contract. An inline one is reachable solely by booting the whole engine, so
 * a divergence between it and the package's own implementation is invisible
 * until an install hits it.
 */
export function analyticsPortFor(analyticsDb: AnalyticsDb | null): AnalyticsPort {
  return {
    query: async (sql, values) => {
      if (!analyticsDb) throw new Error("no analytics database is configured");
      // The DSL writes `$today`, `$key.month`, `$n.node.field`. `prepareQuery`
      // rewrites those into named binds and tells us which reference became
      // which name, so every value the DSL supplies is *bound* rather than
      // written into the statement. Interpolating them would put journal
      // content — which is corpus content — into SQL text, and no amount of
      // quote-escaping makes that the right shape.
      //
      // The hints are the other half, and the statement is wrong without them.
      // A value that crossed the journal has been through JSON, which has no
      // decimal and no date, so the type it binds as is whatever shape it
      // happens to have arrived in unless the cast is asked for by name.
      const supplied = values ?? {};
      const prepared = prepareQuery(sql, sqlTypeHints(supplied));
      const params: Record<string, string | number | boolean | null> = {};
      for (const parameter of prepared.parameters) {
        const value = supplied[parameter.reference];
        if (value === undefined) {
          throw new Error(`query binds ${parameter.reference} but nothing supplied it`);
        }
        params[parameter.name] = scalar(value);
      }
      const result = await analyticsDb.executeQuery(prepared.sql, { params });
      // The sandbox returns positional rows; the engine reads columns by name
      // (`result.rows[0]?.fires`). Handing arrays through would make every
      // guard read `undefined` — false forever, silently, with no error
      // anywhere. Zipping here is the whole translation between the two.
      return {
        columns: result.columns,
        rows: result.rows.map((row) =>
          Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
        ),
      };
    },
  };
}

/**
 * The two connections to the watch journal and the stores over them.
 *
 * Opened as a step of its own so that failing to open them is a step of its
 * own. Each store brings its file up to the shape its queries expect, and one
 * of those upgrades takes the write lock — so another process holding the file
 * longer than the busy timeout makes construction throw. Thrown from inside the
 * engine factory that is called straight from boot, that is an uncaught
 * exception on the way up: a gateway under a restarting supervisor retries,
 * takes the lock again, and loops.
 */
export interface WatchStores {
  readonly db: EncryptedSqliteDatabase;
  readonly adminDb: EncryptedSqliteDatabase;
  readonly definitions: WatchDefinitionStore;
  readonly traces: WatchTraceStore;
}

/**
 * Open them, or say why not.
 *
 * The same posture the journal's own resolution takes: a refusal disables the
 * watch subsystem and lets the rest of the gateway boot, because under a
 * restarting supervisor exiting is an outage and the operator needs a running
 * gateway to read the reason from. Both handles are closed on the way out, so a
 * failure leaves no connection holding the file it could not finish upgrading.
 */
export interface OpenWatchStoresOptions {
  readonly journalPath: string;
  readonly storageKey: Buffer | null;
  readonly tunables?: WatchV2EngineOptions["tunables"];
  /**
   * How long to wait for a peer to let go of the write lock before giving up.
   *
   * Settable so a test can reach the refusal in milliseconds rather than
   * spending the production wait to prove the same thing. Nothing in the
   * gateway passes it.
   */
  readonly busyTimeoutMs?: number;
}

export function openWatchStores(
  options: OpenWatchStoresOptions,
): { ok: true; stores: WatchStores } | { ok: false; reason: string } {
  const open = (): EncryptedSqliteDatabase => {
    const handle = openEncryptedSqlite(options.journalPath, { key: options.storageKey });
    handle.pragma("journal_mode = WAL");
    handle.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    return handle;
  };

  let db: EncryptedSqliteDatabase | undefined;
  let adminDb: EncryptedSqliteDatabase | undefined;
  try {
    // The evaluation connection, private to the engine's state store. Opened
    // through the encrypted driver when the install is keyed, which is why the
    // state store attaches to a connection rather than opening one.
    db = open();

    // A second handle, for the stores an HTTP request writes.
    //
    // Not a nicety. The engine holds an explicit transaction open across awaits
    // — that is what makes an event's effects and its cursor commit together —
    // and anything writing the *same connection* joins it. An operator adding a
    // watch through the admin surface would have that write rolled back the
    // next time the engine retried an event or paused one, having already been
    // told 201. Separate connections make the two independent; the shared lease
    // is what keeps them from meeting in SQLite's busy handler instead.
    adminDb = open();

    // Attached here rather than left to the host, because this is the other
    // schema on this file that an older build's copy has to be brought up to
    // — and the whole point of this step is that every such upgrade refuses in
    // one place. The host attaches it again over an already-current file,
    // where `CREATE TABLE IF NOT EXISTS` reads `sqlite_master` and takes no
    // lock at all.
    WatchStateStore.on(db, WATCH_JOURNAL_FILENAME);

    return {
      ok: true,
      stores: {
        db,
        adminDb,
        definitions: new WatchDefinitionStore(adminDb),
        traces: new WatchTraceStore(adminDb, options.tunables?.traceRetained),
      },
    };
  } catch (err) {
    adminDb?.close();
    db?.close();
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function startWatchV2Engine(options: WatchV2EngineOptions): WatchV2Engine {
  const { db, adminDb, definitions, traces } = options.stores;
  const completer = watchCompleterCache(options.getCompleter, options.getCompleterKey);
  const judge = new LiveJudge({
    // Reused while the assignment is unchanged. Resolving per judgement would
    // rebuild a local model repeatedly; pinning it forever would keep a stale
    // provider after an operator switches or disables the role.
    completer: () => null,
    acquireCompleter: completer.acquire,
    budget: {
      dailyCap: options.tunables?.judge?.dailyCap ?? DEFAULT_JUDGE_BUDGET.dailyCap,
      perWatchDailyCap:
        options.tunables?.judge?.perWatchDailyCap ?? DEFAULT_JUDGE_BUDGET.perWatchDailyCap,
    },
    enrichEvidence: createJudgeEvidenceReader(options.ontologyDb),
    // Recorded beside the traces, on the admin connection, so a decision
    // outlives the process that made it — and through the same lease as every
    // other write to that file, because the engine and the materializer write
    // it too and the loser of a race blocks the thread rather than yielding.
    recordJudgement: (entry) =>
      options.writes.run(() => Promise.resolve(traces.recordJudgement(entry))),
    // Beside it, through the same lease. What the judge was asked and what it
    // answered, for the reads that have to explain a verdict rather than
    // count it.
    recordExchange: (entry) =>
      options.writes.run(() => Promise.resolve(traces.recordJudgeExchange(entry))),
    // The day's allowance, kept where a restart can find it. Without this the
    // cap is a per-process one wearing a day's name, and a gateway that
    // restarts twice in an afternoon pays for the day three times.
    spentOn: (day) => traces.judgeSpendOn(day),
    chargeCall: (entry) =>
      options.writes.run(() => Promise.resolve(traces.recordJudgeCall(entry.watchId, entry.day))),
  });

  const analytics: AnalyticsPort = analyticsPortFor(options.analyticsDb);

  const host = new WatchEngineHost({
    db,
    journal: options.journal,
    definitions,
    traces,
    writes: options.writes,
    analytics,
    judge,
    recall: new LiveRecall({ indexDb: options.indexDb, embedder: options.getEmbedder }),
    ontology: {
      db: options.ontologyDb,
      analyticsDb: options.analyticsDb,
      // Every source the gateway indexes is chunked and embedded; the indexer
      // does not pick and choose by source.
      semanticallyIndexed: () => true,
    },
    ...(options.tunables?.idleEvaluateIntervalMs === undefined
      ? {}
      : { idleEvaluateIntervalMs: options.tunables.idleEvaluateIntervalMs }),
    ...(options.tunables?.eventsPerWatch === undefined
      ? {}
      : { eventsPerWatch: options.tunables.eventsPerWatch }),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    ...(options.wake ? { wake: options.wake } : {}),
    ...(options.agentIntegration ? { agentIntegration: options.agentIntegration } : {}),
    ...(options.tunables?.delivery ? { deliveryCaps: options.tunables.delivery } : {}),
    ...(options.tunables?.wake ? { wakeCaps: options.tunables.wake } : {}),
  });

  const task: PeriodicTask<unknown, EvaluationResult> = {
    name: "watchV2.evaluate.tick",
    runner: "main",
    priority: "background",
    latencyBudgetMs: 100,
    periodMs: options.tunables?.evaluateIntervalMs ?? DEFAULT_EVALUATE_INTERVAL_MS,
    idlePeriodMs: options.tunables?.idleEvaluateIntervalMs ?? DEFAULT_IDLE_EVALUATE_INTERVAL_MS,
    startDelayMs: options.tunables?.evaluateIntervalMs ?? DEFAULT_EVALUATE_INTERVAL_MS,
    initialArgs: undefined,
    isIdle: (result) => result.idle,
    async run(_args, ctx): Promise<TaskOutcome<unknown, EvaluationResult>> {
      try {
        const result = await host.evaluate(ctx.shouldYield);
        if (!result.idle) {
          log.debug(
            `evaluated ${result.watches} watch(es) over ${result.events} event(s): ` +
              `${result.firings} firing(s), ${result.paused} paused`,
          );
        }
        return { kind: "done", value: result };
      } catch (err) {
        log.warn(`watch evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
        return {
          kind: "done",
          value: {
            watches: 0,
            events: 0,
            firings: 0,
            paused: 0,
            delivered: 0,
            suppressed: 0,
            idle: true,
          },
        };
      }
    },
  };

  // What is wired, not what the subsystem once was. This line is the first
  // thing read when a watch did not reach someone, and one that always claimed
  // nothing was delivered sent every such reader looking in the wrong place.
  log.info(
    options.delivery
      ? "watch runtime active — firings are delivered"
      : "watch runtime active — firings are recorded only, with nowhere to deliver them",
  );

  return {
    definitions,
    traces,
    task,
    firings: (watchId, limit) => host.firings(watchId, limit),
    deliveries: (watchId) => host.deliveries(watchId),
    reconcilePushRetryOutcomes: (outcomes) => host.reconcilePushRetryOutcomes(outcomes),
    firingCount: (watchId) => host.firingCount(watchId),
    judgeSpend: () => judge.spent(),
    judgeReadiness: () =>
      options.completerReadiness?.() ?? {
        loadable: completer.get() !== null,
        reason: null,
      },
    judgeBudget: (watchId) => judge.budgetFor(watchId),
    stateSnapshot: (watchId, parkedLimit) => host.stateSnapshot(watchId, parkedLimit),
    liveState: () => host.liveState(),
    firingSummary: () => host.firingSummary(),
    latency: () => host.latency(),
    ontologyCoverage: () => host.ontologyCoverage(),
    health: () => host.health(),
    pending: (watchId) => host.pending(watchId),
    forget: (watchId) => host.forget(watchId),
    reactivate: (watchId) => host.reactivate(watchId),
    failure: (watchId) => host.failure(watchId),
    deliveryToday: () => host.deliveryToday(),
    attemptedToday: (watchId) => host.attemptedToday(watchId),
    skipPlan: (watchId) => host.skipPlan(watchId),
    applySkip: (watchId, plan) => host.applySkip(watchId, plan),
    fireByHand: (watchId, input) => host.fireByHand(watchId, input),
    stop: async () => {
      await completer.dispose();
      adminDb.close();
      db.close();
    },
  };
}

/**
 * Cache a provider until its assignment identity changes.
 *
 * Without an identity callback, a `null` is not an answer — it means the role
 * may become available after boot, so only a real provider is kept. Production
 * supplies an identity and therefore also observes provider reachability,
 * egress-policy, protocol, and model changes.
 */
export function watchCompleterCache(
  resolve: () => CompleteCapability | null,
  key?: () => string,
): {
  get: () => CompleteCapability | null;
  acquire: () => { completer: CompleteCapability; release(): void } | null;
  dispose: () => Promise<void>;
} {
  interface Entry {
    readonly provider: CompleteCapability;
    facade: CompleteCapability;
    active: number;
    retired: boolean;
    disposed: boolean;
    readonly disposedPromise: Promise<void>;
    resolveDisposed: () => void;
  }

  let held: Entry | null = null;
  let heldKey: string | undefined;
  let initialized = false;

  const retired = new Set<Entry>();
  const finishDisposal = (entry: Entry): void => {
    if (!entry.retired || entry.active > 0 || entry.disposed) return;
    entry.disposed = true;
    void Promise.resolve()
      .then(() => entry.provider.dispose())
      .catch((err) => {
        log.warn(
          `watch judge provider disposal failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        retired.delete(entry);
        entry.resolveDisposed();
      });
  };
  const retire = (entry: Entry | null): void => {
    if (!entry || entry.retired) return;
    entry.retired = true;
    retired.add(entry);
    finishDisposal(entry);
  };
  const wrap = (provider: CompleteCapability): Entry => {
    let resolveDisposed = () => {};
    const disposedPromise = new Promise<void>((resolveDone) => {
      resolveDisposed = resolveDone;
    });
    const entry: Entry = {
      provider,
      facade: provider,
      active: 0,
      retired: false,
      disposed: false,
      disposedPromise,
      resolveDisposed,
    };
    const complete = async (
      prompt: string,
      opts?: Parameters<CompleteCapability["complete"]>[1],
    ): Promise<string> => {
      entry.active += 1;
      try {
        return await provider.complete(prompt, opts);
      } finally {
        entry.active -= 1;
        finishDisposal(entry);
      }
    };
    entry.facade = {
      get name() {
        return provider.name;
      },
      get modelId() {
        return provider.modelId;
      },
      complete,
      // The cache owns provider lifetime. A caller only borrows the facade.
      dispose: async () => {},
    } satisfies CompleteCapability;
    return entry;
  };
  const load = (): Entry | null => {
    const provider = resolve();
    return provider ? wrap(provider) : null;
  };
  const cacheGet = (): CompleteCapability | null => {
    if (!key) {
      held ??= load();
      return held?.facade ?? null;
    }
    const nextKey = key();
    if (initialized && nextKey === heldKey) return held?.facade ?? null;
    // Construct before publishing the new identity. If construction throws,
    // the next lookup retries and the known-good generation stays available.
    const next = load();
    const previous = held;
    heldKey = nextKey;
    initialized = true;
    held = next;
    retire(previous);
    return held?.facade ?? null;
  };
  return {
    get: cacheGet,
    acquire: () => {
      const facade = cacheGet();
      const entry = held;
      if (!facade || !entry) return null;
      entry.active += 1;
      let released = false;
      return {
        completer: facade,
        release: () => {
          if (released) return;
          released = true;
          entry.active -= 1;
          finishDisposal(entry);
        },
      };
    },
    dispose: async () => {
      const previous = held;
      held = null;
      retire(previous);
      await Promise.all([...retired].map((entry) => entry.disposedPromise));
    },
  };
}

/** Opaque provider identity; credentials are hashed in full and never exposed. */
export function watchCompleterIdentity(
  resolved: ResolvedAssignment,
  credentialIdentity?: string,
): string {
  const credentialFingerprint = createHash("sha256")
    .update(credentialIdentity ?? "")
    .digest("hex");
  return JSON.stringify([resolved, credentialFingerprint]);
}

/** Memoize assignment resolution behind a cheap, mutation-driven revision. */
export function watchCompleterKeyResolver(deps: {
  revision(): string;
  resolve(): ResolvedAssignment;
  credentialIdentity(resolved: ResolvedAssignment): string | undefined;
}): () => string {
  let heldRevision: string | undefined;
  let heldKey: string | undefined;
  return () => {
    const revision = deps.revision();
    if (heldKey !== undefined && revision === heldRevision) return heldKey;
    const resolved = deps.resolve();
    heldKey = watchCompleterIdentity(resolved, deps.credentialIdentity(resolved));
    heldRevision = revision;
    return heldKey;
  };
}

/**
 * A DSL-supplied value as something DuckDB can bind.
 *
 * The DSL's typed-parameter wrapper carries a SQL type alongside the value; the
 * sandbox infers types itself, so only the value travels. Anything that is not
 * a scalar becomes its JSON text, which is what a comparison against a JSON
 * column expects and what every other shape would have to become anyway.
 */
function scalar(value: unknown): string | number | boolean | null {
  const unwrapped =
    value !== null && typeof value === "object" && "value" in value
      ? (value as { value: unknown }).value
      : value;
  if (unwrapped === null || unwrapped === undefined) return null;
  if (typeof unwrapped === "number") return Number.isFinite(unwrapped) ? unwrapped : null;
  if (typeof unwrapped === "boolean" || typeof unwrapped === "string") return unwrapped;
  if (unwrapped instanceof Date) return unwrapped.toISOString();
  return JSON.stringify(unwrapped);
}

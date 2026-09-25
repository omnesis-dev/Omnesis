// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Running the watches, over the journal the materializer produces.
 *
 * One engine per watch per tick, each consuming the journal through its own
 * persisted cursor. The engine is constructed fresh each time and that costs
 * nothing, because everything it remembers lives in its state store.
 *
 * **Shadow by default.** A firing is a row in `watch_firings` and a trace, and
 * for a watch that says nothing about delivery that is all it ever is. A watch
 * carrying a `delivery` block also notifies, bounded by a per-watch and a
 * global daily cap — because the failure mode of a notification is not that it
 * is wrong, it is that there are so many of them the person stops reading any.
 *
 * ## Separate connections, and one turn between them
 *
 * The materializer writes the journal from its drain task, this writes it from
 * the evaluation task, and the admin surface writes it from an HTTP handler.
 * Each holds its own connection, because a write on a *shared* connection joins
 * whatever transaction is already open on it — and the evaluation transaction
 * is held across awaits, so an operator's write would be rolled back with it.
 *
 * Separate connections make them independent; the shared `WriteLease` is what
 * keeps them from meeting in SQLite's busy handler, where a synchronous driver
 * blocks its thread rather than yielding. Every write on every one of the three
 * takes a turn — including the ones this host makes between evaluations.
 *
 * A keyed install opens each through the encrypted driver, which is why the
 * state store attaches to a connection rather than opening its own.
 *
 * ## Where a watch starts
 *
 * At the journal head, unless it says otherwise. "Tell me when someone emails
 * about X" is a claim about what happens next, and a watch that woke on four
 * years of history would be answering a question nobody asked. The cursor is
 * seeded from the definition's `fromSeq` the first time the watch is seen.
 */

import { createLogger, localDayBounds, localDayKey, type Logger } from "@omnesis/core";
import {
  Ontology,
  RecordingOntology,
  WatchEngine,
  WatchStateStore,
  readWatchState,
  validateWatch,
  watchDslSchema,
  type AnalyticsPort,
  type JournalDocument,
  type JudgeProvider,
  type RecallScorer,
  type WatchFailure,
  type WatchDefinition,
  type WatchFiring,
  type TraceRecord,
  type WatchTrace,
  type WatchStateSnapshot,
  type WatchLiveState,
  holdingSpecs,
  SINGLETON_KEY,
} from "@omnesis/watch";
import { assertNever } from "@omnesis/core";
import { watchV2FiringKey } from "../subscriptions/watch-v2-plan.js";
import {
  driftNote,
  layerHealth,
  nodeFailedNote,
  surfaceNote,
  SURFACE_MOVED,
  SURFACE_UNRECORDED,
  THREW_NOTE,
  type WatchLayerHealth,
} from "./health.js";
import { watchNotificationCopy } from "./push-copy.js";
import {
  LiveOntology,
  type OntologyCoverage,
  type LiveOntologySnapshot,
  type OntologyDeps,
} from "./ontology.js";
import { WATCH_JOURNAL_FILENAME } from "./journal-path.js";
import { withFingerprint } from "./definitions.js";
import type { WatchDefinitionStore, StoredWatch, WatchStatus } from "./definitions.js";
import type { WatchTraceStore } from "./traces.js";
import type { WatchJournalStore } from "./store.js";
import type { WatchNotificationWakeOutcome } from "../push/queue.js";
import type { WriteLease } from "./write-lease.js";
import type { EncryptedSqliteDatabase } from "../sqlite-encryption.js";

const log: Logger = createLogger("gateway").child("watch-v2:engine");

/** Journal events handed to one watch in one tick. */
const DEFAULT_EVENTS_PER_WATCH = 200;

/**
 * How far into a watch's parked queue a skip looks for the failing nomination.
 *
 * The queue drains in sequence order and the one that failed is the one the
 * drain stopped on, so it is at the front. The bound is there so a watch with a
 * long queue cannot turn one admin request into a full scan of it.
 */
const PENDING_SCAN_LIMIT = 200;

/**
 * The one thing a stuck watch has to get past, and how.
 *
 * `event` is a journal event the cursor has not reached; `nomination` is a
 * parked nomination whose sequence the cursor is already beyond, where the
 * cursor is not what is holding the watch up.
 */
export type SkipPlan =
  | { readonly what: "event"; readonly seq: number; readonly nodeId: string; readonly why: string }
  | {
      readonly what: "nomination";
      readonly seq: number;
      readonly nodeId: string;
      readonly docId: string;
      readonly why: string;
    };

/**
 * What reading a watch's live state produced.
 *
 * `unreadable` is its own outcome rather than an empty snapshot: a definition
 * this build cannot parse has state the runtime is still holding, and reporting
 * "no live state" for it would be a lie in the one direction that matters.
 */
export type WatchStateResult =
  | {
      readonly outcome: "read";
      readonly snapshot: WatchStateSnapshot;
      /** Where the producer has reached. Always at or ahead of `asOfSeq`. */
      readonly journalHead: number;
      /** When the read was taken, on the host's clock. */
      readonly atMs: number;
    }
  | { readonly outcome: "no-watch" }
  | { readonly outcome: "unreadable"; readonly why: string };

export interface EngineHostDeps {
  /** This host's own connection to the journal. Never the materializer's. */
  readonly db: EncryptedSqliteDatabase;
  readonly journal: WatchJournalStore;
  readonly definitions: WatchDefinitionStore;
  /**
   * The cadence the scheduler evaluates at when nothing is arriving. The host
   * does not run the loop, but it is the only thing that can say whether the
   * loop has stopped — and "how long is too long" is that cadence's question.
   */
  readonly idleEvaluateIntervalMs?: number;
  readonly analytics: AnalyticsPort;
  readonly judge: JudgeProvider;
  readonly recall: RecallScorer;
  readonly ontology: OntologyDeps;
  /** Where each run's trace is kept, so a firing can be explained afterwards. */
  readonly traces: WatchTraceStore;
  /** Shared with the materializer, so the two writers of this file take turns. */
  readonly writes: WriteLease;
  readonly eventsPerWatch?: number;
  readonly now?: () => number;
  /**
   * Where a delivery-bearing watch's firings go.
   *
   * A thunk so evaluation always uses the host's current push wiring rather
   * than a cached delivery port that may have been replaced. `null` is an
   * install with no push wired, where a delivery-bearing watch is refused
   * rather than quietly shadowed.
   */
  readonly delivery?: () => WatchDeliveryPort | null;
  readonly deliveryCaps?: Partial<DeliveryCaps>;
  /**
   * Where an `agent-wake` firing goes. Absent on an install with no agent
   * integration, where such a watch runs and records and wakes nobody.
   */
  readonly wake?: () => WatchDeliveryPort | null;
  /**
   * Whether this install has an agent integration configured at all.
   *
   * Only the report reads it, and only to decide whether a firing that shipped
   * as a plain banner is worth counting as a degrade. Omitted where the host
   * has no way to know — a test, a harness — and then nothing is excluded,
   * which is the reading that hides nothing.
   */
  readonly agentIntegration?: () => boolean;
  readonly wakeCaps?: Partial<DeliveryCaps>;
}

/** What one pass over the active watches did. */
export interface EvaluationResult {
  watches: number;
  events: number;
  firings: number;
  paused: number;
  /** Firings that reached a person. */
  delivered: number;
  /** Firings a cap kept from reaching one. */
  suppressed: number;
  idle: boolean;
}

/** What forcing a firing came to. */
export type WatchFireByHandResult =
  | {
      readonly outcome: "fired";
      /** The synthetic sequence the firing was recorded at — always negative. */
      readonly seq: number;
      readonly delivered: number;
      readonly suppressed: number;
      /**
       * Why nothing arrived, when nothing did and no cap was the reason.
       *
       * The whole point of firing by hand is finding out that the transport is
       * not wired, so the reason travels back with the answer rather than
       * being left on a row the operator has to know to go and read.
       */
      readonly error?: string;
    }
  | { readonly outcome: "no-watch" }
  /** The runtime is not running this watch, so it must not deliver for it. */
  | { readonly outcome: "not-active"; readonly status: WatchStatus }
  /** The watch records and interrupts nobody, so there is no path to prove. */
  | { readonly outcome: "delivers-nowhere" }
  /** This build cannot read the stored definition. */
  | { readonly outcome: "unreadable"; readonly why: string };

/**
 * One notification, already written.
 *
 * The host renders; this sends. Keeping the two apart is what lets the V1
 * delivery tail stay the thing that selects transports — it already knows
 * which devices exist, how to reach them, and what to do when one has gone away.
 */
export interface WatchNotification {
  readonly watchId: string;
  readonly watchName: string;
  /**
   * What a tap deep-links to: `<watchId>:<seq>`, the string clients take apart
   * to find the line of the ledger a banner was about.
   *
   * Not an identity. A broadcast arm re-judges every live cell at the tick's
   * own sequence number, so two firings with different evidence can share a
   * `seq` — and this string with them. Use {@link firingId} to tell one firing
   * from another.
   */
  readonly firingKey: string;
  /**
   * The firing's durable identity — all four components the store is unique
   * on, so no two firings of a watch ever collide.
   *
   * This is what anything keying idempotent work on a firing must use: the
   * conversation a notification opens about it, and the anchor a wake is
   * reported into. Both are places where two firings of one tick would
   * otherwise be taken for one, and the second one silently discarded.
   *
   * Opaque. It is written into durable rows and reaches an admin surface, but
   * nothing parses it — the components are recoverable from the ledger, and a
   * reader taking it apart would be depending on a shape that exists for
   * uniqueness rather than for description.
   */
  readonly firingId: string;
  readonly title: string;
  readonly body: string;
  /**
   * The copy fields the watch's author wrote by hand, if any.
   *
   * A delivery that can say something better than the default must still not
   * say it over words somebody chose on purpose. Empty for the ordinary watch,
   * whose copy the runtime composed.
   */
  readonly authoredCopy: { readonly title?: string; readonly body?: string };
  /**
   * What the operator asked to be told about, in their own words.
   *
   * Distinct from `body`, which is what a banner shows and which the operator
   * may have overridden with their own copy. This is the request itself, and
   * it is what an agent opening a conversation about the firing is briefed on.
   */
  readonly condition: string;
  /** Semantic time of the firing — what a wake records as the instant. */
  readonly firedAt: string;
  /**
   * The documents that made the firing true, if any.
   *
   * Never used by a notification — a banner says what was asked for, not what
   * was found. It is the wake that needs them: they are what an agent is
   * allowed to read when it asks what caused the firing, and the only thing
   * standing between "an agent was woken" and "an agent can act on it".
   */
  readonly documentIds: readonly string[];
  /**
   * What the plan reported as satisfying the condition — the fields its author
   * chose to record. Never shown to a reader: a banner says what was asked
   * for, not what was found. A wake carries it into the firing's evidence so
   * that an agent asking what happened is told about *this* occurrence rather
   * than whichever one a later query happens to return.
   */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Why a firing shipped as less than its channel can send.
 *
 * A closed class rather than a message. The reason always originates in a
 * backend, and a backend's error text can quote a value out of the corpus —
 * the same caution the failure record is built on. These three are what an
 * operator can act on: wire an agent, wait, or look at why the turn failed.
 */
export const WATCH_THREAD_DEGRADES = [
  /** The install has no agent integration wired at all. */
  "no-opener",
  /** Wired, but no agent answered inside the wait — mid-swap, or unassigned. */
  "no-agent",
  /** An agent was there and the turn did not produce a conversation. */
  "open-failed",
] as const;

/** @see WATCH_THREAD_DEGRADES */
export type WatchThreadDegrade = (typeof WATCH_THREAD_DEGRADES)[number];

/**
 * The two classes that mean "there is no agent here", rather than "the agent
 * that is here did not answer".
 *
 * They are the same sentence written from either side of the wiring: no opener
 * was supplied at all, or one was and the gateway it asks has no agent. On an
 * install where an agent integration *is* configured they are genuine degrades
 * — a swap that outran the wait, an agent that has gone away — and are counted.
 * On one where it is not, they describe the install rather than a fault.
 */
const UNWIRED_DEGRADES: readonly WatchThreadDegrade[] = ["no-opener", "no-agent"];

/** What one attempt to deliver a firing did. */
export interface WatchDeliveryOutcome {
  /** How many destinations accepted it. Zero is an ordinary answer. */
  readonly delivered: number;
  /** How many were tried, when the channel knows. */
  readonly attempted?: number;
  /**
   * Why nothing arrived, in one line, when the channel can say.
   *
   * Recorded because a notification that never arrived is otherwise
   * indistinguishable from a watch that never fired — the operator sees
   * silence either way, and only one of them is working as intended.
   */
  readonly error?: string;
  /**
   * That the firing arrived as less than it should have, when it did.
   *
   * A degraded delivery is a success by every count above — it was attempted,
   * it arrived — so nothing else on this row can say that the operator got a
   * plain banner where they should have got the agent's account of what
   * happened, and a tap that lands in it. Absent when nothing was lost.
   */
  readonly degraded?: WatchThreadDegrade;
}

/** Where a delivered firing goes. Absent on an install with no push wired. */
export interface WatchDeliveryPort {
  send(notification: WatchNotification): Promise<WatchDeliveryOutcome>;
}

/**
 * One channel's ledger and allowance, chosen by delivery kind.
 *
 * The two channels bound different things — a notification spends a person's
 * attention, a wake spends an agent's tokens — so they keep separate counts
 * against separate caps. What they share is the shape of the decision, which
 * is why it is written once.
 */
interface DeliveryChannel {
  readonly caps: DeliveryCaps;
  readonly spentByWatch: (watchId: string, day: string) => number;
  readonly spentOverall: (day: string) => number;
  readonly record: (watchId: string, day: string) => void;
  /** How the suppression record reads: "has already <noun> N time(s) today". */
  readonly noun: string;
  /** How the global one reads: "N <plural> have gone out today". */
  readonly plural: string;
}

/**
 * How often a watch may wake an agent.
 *
 * Higher than the push caps and for a different reason. A notification the
 * operator does not want is an interruption; a wake they do not want is spent
 * tokens and an agent doing something nobody asked for. The first is worse per
 * event, which is why it is capped tighter.
 */
const DEFAULT_WAKE_CAPS: DeliveryCaps = { dailyCap: 25, perWatchDailyCap: 10 };

/** Evaluation cadence when the journal has nothing new. */
export const DEFAULT_IDLE_EVALUATE_INTERVAL_MS = 30_000;

/**
 * How often a watch may interrupt a person.
 *
 * Two caps rather than one. The per-watch cap stops a single chatty watch from
 * being the only thing anyone hears from; the global one bounds the day whatever
 * combination of watches produced it. A firing over either is **suppressed**,
 * not queued: a notification that arrives an hour after the thing it is about
 * is a wrong notification, and a queue would turn a cap into a delay.
 */
export interface DeliveryCaps {
  readonly dailyCap: number;
  readonly perWatchDailyCap: number;
}

const DEFAULT_DELIVERY_CAPS: DeliveryCaps = { dailyCap: 20, perWatchDailyCap: 5 };

/** How long evaluation has been taking, as the shadow report states it. */
export interface EvaluationLatency {
  /** Watch evaluations measured since boot. */
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

/**
 * Keeps the most recent evaluation times, for the percentiles the report shows.
 *
 * A ring rather than a growing list: the runtime is meant to run for a week,
 * and a p95 over every evaluation since boot would be dominated by whatever the
 * first hour was like long after it stopped being true.
 */
const LATENCY_WINDOW = 512;

export class WatchEngineHost {
  private readonly state: WatchStateStore;
  private readonly eventsPerWatch: number;
  private readonly now: () => number;
  /** The declared surface as last seen, so a move can be said out loud once. */
  private lastFingerprint: string | null = null;
  /** The last indexed ontology, reused while its snapshot is the same object. */
  private cached: { snapshot: LiveOntologySnapshot; ontology: Ontology } | null = null;
  private readonly ontology: LiveOntology;
  /** Recent evaluation times, newest last. */
  private readonly latencies: number[] = [];
  /**
   * When the engine last consumed journal events, and how far it has read.
   *
   * Held in memory rather than persisted: the question it answers is "is this
   * gateway evaluating", and a value that survived a restart would answer it
   * for a process that is no longer running.
   */
  private lastEvaluatedAt: number | null = null;
  private evaluatedThroughSeq = 0;
  /** When this process began reading, so a fresh boot is not a stalled one. */
  private readonly startedAt: number;
  /** The last alarm said, so a standing fault is stated once rather than per tick. */
  private warnedAlarm: string | null = null;
  private readonly idleEvaluateIntervalMs: number;
  /** First Watch for the next cooperatively-preempted pass. */
  private nextWatchId: string | null = null;

  private readonly caps: DeliveryCaps;
  private readonly wakeCaps: DeliveryCaps;

  constructor(private readonly deps: EngineHostDeps) {
    this.state = WatchStateStore.on(deps.db, WATCH_JOURNAL_FILENAME);
    this.caps = { ...DEFAULT_DELIVERY_CAPS, ...deps.deliveryCaps };
    this.wakeCaps = { ...DEFAULT_WAKE_CAPS, ...deps.wakeCaps };
    this.ontology = new LiveOntology(deps.ontology, deps.now ? { now: deps.now } : {});
    this.eventsPerWatch = deps.eventsPerWatch ?? DEFAULT_EVENTS_PER_WATCH;
    this.idleEvaluateIntervalMs = deps.idleEvaluateIntervalMs ?? DEFAULT_IDLE_EVALUATE_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    // Seeded from the durable cursors rather than zero: the engine has read up
    // to here, and starting at zero made every restart look arbitrarily far
    // behind a journal it had in fact already consumed.
    this.evaluatedThroughSeq = this.state.evaluatedThroughSeq();
  }

  /** How long evaluating one watch has been taking, for the shadow report. */
  latency(): EvaluationLatency {
    if (this.latencies.length === 0) return { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (fraction: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
    return {
      samples: sorted.length,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
      maxMs: sorted[sorted.length - 1]!,
    };
  }

  /** How much of the substrate the DSL can address, as of the last assembly. */
  ontologyCoverage(): OntologyCoverage | null {
    return this.ontology.coverage();
  }

  /** Erase everything the runtime holds for a watch — what removing one means. */
  forget(watchId: string): void {
    this.state.forget(watchId);
  }

  /** Let a watch run again after it was held. */
  reactivate(watchId: string): void {
    this.state.setActive(watchId, true);
  }

  /** Nominations waiting on judge budget, for the shadow report. */
  pending(watchId: string): number {
    return this.state.pendingCount(watchId);
  }

  /**
   * Everything the runtime is holding for one watch, at one moment.
   *
   * The moment is the point. Cells, timers, parked nominations and the cursor
   * all commit together with the event that changed them, so read at a commit
   * boundary they describe one consistent state — and read anywhere else they
   * describe a half-applied event that will be rolled back if it fails. This
   * host's evaluation transaction is held open across awaits on the very
   * connection these reads use, so the read takes a **write-lease turn**: the
   * engine wraps `begin`→`commit` in one turn of the same lease, and a turn
   * therefore cannot start in the middle of one.
   *
   * The journal head comes back with it, read inside the same turn. It is the
   * producer's clock rather than this watch's — only `head >= asOfSeq` is ever
   * assertable, since the two live in different files — and the difference is
   * how far behind the head this watch is.
   */
  async stateSnapshot(watchId: string, parkedLimit: number): Promise<WatchStateResult> {
    const stored = this.deps.definitions.get(watchId);
    if (!stored) return { outcome: "no-watch" };
    const parsed = watchDslSchema.safeParse(stored.dsl);
    if (!parsed.success) {
      return {
        outcome: "unreadable",
        why: parsed.error.issues[0]?.message ?? "invalid definition",
      };
    }
    const watch = parsed.data.watch;
    return this.deps.writes.run(() =>
      Promise.resolve({
        outcome: "read" as const,
        atMs: this.now(),
        journalHead: this.deps.journal.head(),
        snapshot: readWatchState({ watch, watchId, store: this.state, parkedLimit }),
      }),
    );
  }

  /**
   * What every watch is holding, for a list rather than a page.
   *
   * Takes the same write-lease turn `stateSnapshot` takes, for the same reason
   * and one more: a listing read outside a turn could count a watch's cells
   * mid-event, and the number it produced would disagree with the page a
   * reader reaches by clicking that very row. Two screens differing by one is
   * a worse fault here than either being a moment stale, because only one of
   * them looks like a bug.
   *
   * Three grouped counts, so the cost does not grow with how much any one
   * watch holds — which is what makes it safe on a polled list.
   */
  async liveState(): Promise<{ held: Map<string, WatchLiveState>; journalHead: number }> {
    // Derived before the turn is taken, not inside it: how each node type reads
    // its own cells comes out of the stored definitions, which are a different
    // store and pure CPU to walk. Nothing about it needs the lease, and the
    // lease is the thing the whole gateway queues behind.
    const specs = this.deps.definitions
      .list()
      .flatMap((stored) => holdingSpecs(stored.id, stored.dsl));
    const now = this.now();
    return this.deps.writes.run(() =>
      Promise.resolve({
        held: this.state.liveState(specs, now),
        journalHead: this.deps.journal.head(),
      }),
    );
  }

  /** What every watch has caught, and when — one grouped read for a listing. */
  async firingSummary(): Promise<Map<string, { count: number; lastFiredAtMs: number | null }>> {
    return this.deps.writes.run(() => Promise.resolve(this.state.firingSummaryAll()));
  }

  /**
   * Fire a watch by hand, to find out where its firings actually go.
   *
   * A watch's condition is the half you can read. The other half — the caps,
   * the transport, the anchor, the agent that opens a conversation about it —
   * only runs when the world produces the condition, which for a watch worth
   * having is rare and unschedulable. So a delivery path that is broken stays
   * broken silently until the day it was needed: the wake canary on the last
   * deploy could verify an anchor mints and could not verify the round trip,
   * for exactly this reason.
   *
   * **Nothing is evaluated.** No event is read, no node arms, no judge is
   * asked, and no judge budget is spent — there is nothing here to bypass,
   * only the engine not being invoked. What runs is `deliver()`, verbatim,
   * over a trace holding one firing this method built.
   *
   * **It is never mistaken for an organic firing.** The trace record is its
   * own transition, the ledger row carries `forced`, and the sequence number
   * comes from the timer counter — negative, monotonically decreasing, and
   * unable to collide with a journal event. Reusing an organic sequence would
   * be worse than untidy: the firings table is `INSERT OR IGNORE` on
   * `(watch, seq, node, key)`, so the row would be silently dropped, and the
   * deliveries table is upsert on the same tuple, so the manual attempt would
   * overwrite what the real firing recorded.
   *
   * **The daily caps still apply.** They are what `deliver()` does, and this
   * runs `deliver()` as it is. A forced firing that ignored them would not be
   * exercising the path it claims to prove — and the report says plainly when
   * a cap was what stopped it, rather than leaving a silent nothing.
   *
   * **The watch's own state is untouched.** A `once_ever` watch is not retired
   * by this, its cursor does not move, and its liveness is not restamped: a
   * stalled runtime must not be made to look alive by an operator poking it.
   */
  async fireByHand(
    watchId: string,
    input: {
      /**
       * What the firing carries. `omnesis watch firings` prints it, and a wake
       * on a condition-only watch passes it into the firing's evidence as what
       * the plan observed.
       */
      readonly payload?: Readonly<Record<string, unknown>>;
      /**
       * The documents this firing is about.
       *
       * The one input with reach: a woken agent may ask what caused the firing
       * and is answered from these — bounded, still, by what the anchor was
       * approved to offer, so a condition-only watch loses them at the wake.
       */
      readonly documentIds?: readonly string[];
    } = {},
  ): Promise<WatchFireByHandResult> {
    const stored = this.deps.definitions.get(watchId);
    if (!stored) return { outcome: "no-watch" };
    // A watch the runtime is not running must not deliver. Paused means held —
    // an operator who paused a watch because it was wrong would not expect it
    // to interrupt them — and a retired watch has had its anchor swept, so a
    // wake would report `attempted 1, delivered 0` and read as a broken
    // transport rather than as a watch that is over.
    if (stored.status !== "active") return { outcome: "not-active", status: stored.status };
    const parsed = watchDslSchema.safeParse(stored.dsl);
    if (!parsed.success) {
      return {
        outcome: "unreadable",
        why: parsed.error.issues[0]?.message ?? "invalid definition",
      };
    }
    const watch = parsed.data.watch;
    // Refused rather than recorded. `deliver()` returns immediately for a watch
    // with no delivery block, so a firing forced into one would be a row, a
    // trace and a report of success with nothing having gone anywhere — which
    // reads as the delivery path being broken.
    if (!watch.delivery) return { outcome: "delivers-nowhere" };

    const seq = await this.deps.writes.run(() => Promise.resolve(this.state.takeTimerSeq(watchId)));
    const at = new Date(this.now()).toISOString();
    const firing: WatchFiring = {
      seq,
      nodeId: watch.sink.input,
      // A hand-fired firing belongs to no instance: an operator fired the watch,
      // not one of the things it tracks.
      keyHash: SINGLETON_KEY,
      key: SINGLETON_KEY,
      firedAt: at,
      payload: input.payload ?? {},
      documentIds: [...(input.documentIds ?? [])],
    };
    const trace: WatchTrace = {
      watch: watchId,
      records: [
        {
          seq,
          nodeId: firing.nodeId,
          key: SINGLETON_KEY,
          transition: "forced",
          detail: "an operator fired this watch by hand; nothing was evaluated",
        },
      ],
      firings: [firing],
    };

    // The row first, then the trace, then delivery — the same order an
    // evaluation uses, so a crash anywhere in it leaves the same shape of
    // partial record rather than a new one.
    await this.deps.writes.run(() =>
      Promise.resolve(
        this.state.recordFiring(
          watchId,
          seq,
          firing.nodeId,
          firing.keyHash,
          firing.firedAt,
          firing.payload,
          at,
          firing.documentIds,
          true,
        ),
      ),
    );
    await this.deps.writes.run(() => Promise.resolve(this.deps.traces.record(trace, at)));
    log.info(`watch ${stored.name} was fired by hand at seq ${seq}`);

    const sent = await this.deliver(stored, watch, trace);
    // Read back what delivery recorded, rather than inferring it from the
    // counts. `delivered: 0, suppressed: 0` is the shape of every way a
    // transport declined — no device registered, no agent connected, a push
    // rejected — and those are the cases this verb exists to name. The row is
    // written by `recordOutcome` under the firing's own identity.
    const outcome = this.state
      .deliveries(watchId)
      .find((row) => row.seq === seq && row.nodeId === firing.nodeId);
    return {
      outcome: "fired",
      seq,
      ...sent,
      ...(outcome?.error ? { error: outcome.error } : {}),
    };
  }

  /**
   * Record what became of a watch, taking a turn to do it.
   *
   * Every write to the journal goes through the lease, including the ones this
   * host makes between evaluations. They are outside any transaction, so
   * without a turn they would reach SQLite while the materializer's drain held
   * the write lock — and a synchronous driver blocks the thread there rather
   * than yielding.
   */
  private async setStatus(id: string, status: WatchStatus, note: string): Promise<void> {
    await this.deps.writes.run(() =>
      Promise.resolve(this.deps.definitions.setStatus(id, status, note)),
    );
  }

  /**
   * Evaluate every active watch over whatever the journal has for it.
   *
   * A watch whose own evaluation throws is paused rather than retried forever:
   * a broken watch is a fact about that watch, and letting it take the pass
   * down would let one bad definition silence every other.
   */
  async evaluate(shouldYield?: () => boolean): Promise<EvaluationResult> {
    const result: EvaluationResult = {
      watches: 0,
      events: 0,
      firings: 0,
      paused: 0,
      delivered: 0,
      suppressed: 0,
      idle: true,
    };

    const listed = this.deps.definitions.active();
    const resumeAt =
      this.nextWatchId === null ? -1 : listed.findIndex((w) => w.id === this.nextWatchId);
    const active =
      resumeAt > 0 ? [...listed.slice(resumeAt), ...listed.slice(0, resumeAt)] : listed;
    this.nextWatchId = null;
    // Refreshed and announced before the early return, not after it. An
    // install whose every watch is paused takes that return on every tick, and
    // the pass that stopped them is the only one that would ever have spoken —
    // so across a restart the log said nothing at all about a layer that was
    // completely inert. That is precisely the case the alarm exists for.
    this.evaluatedThroughSeq = this.state.evaluatedThroughSeq();
    if (active.length === 0) {
      this.announceHealth();
      return result;
    }

    const ontology = await this.currentOntology();
    let attempted = 0;

    for (const stored of active) {
      // Each completed watch has committed its own cursor and effects, so this
      // is a safe boundary at which to let foreground scheduler work go first.
      if (attempted > 0 && shouldYield?.() === true) {
        this.nextWatchId = stored.id;
        // Keep the scheduler on the active cadence so the continuation is not
        // delayed by the 30-second idle interval.
        result.idle = false;
        break;
      }
      attempted += 1;
      const started = this.now();
      try {
        const evaluated = await this.evaluateOne(stored, ontology, shouldYield);
        if (evaluated === null) {
          result.paused += 1;
          continue;
        }
        // A watch whose node threw is paused just as durably as one that failed
        // validation, and the summary line has to say so. The engine contains a
        // node failure rather than raising it, so nothing here would otherwise
        // distinguish that pass from an entirely successful one.
        if (evaluated.paused) result.paused += 1;
        result.watches += 1;
        result.events += evaluated.events;
        result.firings += evaluated.firings;
        result.delivered += evaluated.delivered;
        result.suppressed += evaluated.suppressed;
        // Every pass is measured, not only the busy ones: a p95 taken from
        // busy passes alone describes the exception rather than the cadence,
        // and the report presents it as how long evaluating a watch takes.
        this.latencies.push(this.now() - started);
        if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
        // A tick that fired a timer did work even though no event arrived, so
        // idleness is about what happened rather than about what was read —
        // otherwise the scheduler backs a purely time-driven watch off to its
        // idle cadence and calls that quiet.
        if (evaluated.events > 0 || evaluated.firings > 0) result.idle = false;
        // Liveness is about the engine, not about any one watch: a pass that
        // read events proves the loop is turning even if nothing matched.
        if (evaluated.events > 0) this.lastEvaluatedAt = this.now();
      } catch (err) {
        // The message goes to the log, which is local; the note does not. A
        // note is read on a listing, copied into a report and kept for as long
        // as the watch exists, and an error from a query engine or a model
        // backend can quote a value out of the corpus.
        log.warn(
          `watch ${stored.name} paused: evaluation threw — ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.setStatus(stored.id, "paused", THREW_NOTE);
        result.paused += 1;
      }
    }
    this.evaluatedThroughSeq = this.state.evaluatedThroughSeq();
    this.announceHealth();
    return result;
  }

  /**
   * Say what is wrong, once per change.
   *
   * Same discipline as the ontology coverage alarm: a standing fault repeated
   * every tick becomes the loudest thing in the log and stops being read, while
   * one that is never repeated is invisible to whoever arrives after it. So the
   * line is emitted when the sentence changes — including back to healthy,
   * which is the recovery nobody would otherwise see.
   */
  private announceHealth(): void {
    const alarm = this.health().alarm;
    if (alarm !== this.warnedAlarm) {
      if (alarm !== null) log.warn(alarm);
      else if (this.warnedAlarm !== null) log.info("every watch is evaluating again");
    }
    this.warnedAlarm = alarm;
  }

  /**
   * Whether the layer is doing anything.
   *
   * Assembled here rather than in the route because the engine is the only
   * thing that knows when it last evaluated, and a report that had to ask two
   * places could describe a moment that never existed.
   */
  health(): WatchLayerHealth {
    const watches = this.deps.definitions.list().map((stored) => ({
      status: stored.status,
      note: stored.note,
      hasNodeFailure: this.state.failure(stored.id) !== null,
    }));
    const head = this.deps.journal.headAt();
    return layerHealth({
      watches,
      lastEvaluatedAtMs: this.lastEvaluatedAt,
      journalHead: head.seq,
      journalHeadAtMs: head.observedAtMs,
      evaluatedThroughSeq: this.evaluatedThroughSeq,
      startedAtMs: this.startedAt,
      idleEvaluateIntervalMs: this.idleEvaluateIntervalMs,
      now: this.now(),
    });
  }

  /** What one watch has said, read from the state the engine keeps. */
  firings(watchId: string, limit?: number): ReturnType<WatchStateStore["firings"]> {
    return this.state.firings(watchId, limit);
  }

  /** What delivering each of them did — the other half of the ledger. */
  deliveries(watchId: string): ReturnType<WatchStateStore["deliveries"]> {
    return this.state.deliveries(watchId);
  }

  /** Persist queue-derived retry truth before private notification rows expire. */
  async reconcilePushRetryOutcomes(
    outcomes: readonly WatchNotificationWakeOutcome[],
  ): Promise<void> {
    if (outcomes.length === 0) return;
    await this.deps.writes.run(() => {
      const firingsByWatch = new Map<
        string,
        Map<string, ReturnType<WatchStateStore["firings"]>[number]>
      >();
      for (const outcome of outcomes) {
        let firings = firingsByWatch.get(outcome.watchId);
        if (!firings) {
          firings = new Map(
            this.state.firings(outcome.watchId).map((candidate) => [
              watchV2FiringKey({
                watchId: outcome.watchId,
                seq: candidate.seq,
                nodeId: candidate.nodeId,
                keyHash: candidate.keyHash,
              }),
              candidate,
            ]),
          );
          firingsByWatch.set(outcome.watchId, firings);
        }
        const firing = firings.get(outcome.firingId);
        if (!firing) continue;
        const error =
          outcome.outstanding > 0
            ? `notification wake retry pending for ${outcome.outstanding} device(s)`
            : outcome.failed > 0
              ? `notification wake failed for ${outcome.failed} device(s)`
              : null;
        this.state.recordDeliveryRetryOutcome({
          watchId: outcome.watchId,
          seq: firing.seq,
          nodeId: firing.nodeId,
          keyHash: firing.keyHash,
          attempted: outcome.attempted,
          delivered: outcome.delivered,
          error,
          at: firing.firedAt,
        });
      }
      return Promise.resolve();
    });
  }

  /** How many times it has said it, without decoding any of them. */
  firingCount(watchId: string): number {
    return this.state.firingCount(watchId);
  }

  /**
   * One watch's slice of the journal, or `null` when it was paused instead.
   *
   * A definition is re-validated against the live ontology every time it is
   * loaded. That is the `profile_drift` discipline: a source shipping a new
   * profile can change what a filter means, and a watch whose meaning moved
   * under it is not the watch the operator approved. Pausing says so; silently
   * evaluating it would not.
   */
  private async evaluateOne(
    stored: StoredWatch,
    ontology: Ontology,
    shouldYield?: () => boolean,
  ): Promise<{
    events: number;
    firings: number;
    paused: boolean;
    delivered: number;
    suppressed: number;
  } | null> {
    // Validated through a recorder, so the pass that decides whether the watch
    // runs also produces the only evidence that could justify re-stamping it
    // later: exactly which ontology entries the answer rested on.
    const reading = new RecordingOntology(ontology);
    let check = validateWatch(stored.dsl, reading);
    let dsl = stored.dsl;
    let referenceDigest = check.valid ? reading.digest() : null;
    /**
     * Why this watch is being held for review rather than paused as broken,
     * when it is. Null while it still validates, and while it does not
     * validate for a reason of its own.
     */
    let held: string | null = null;
    if (!check.valid) {
      const errors = check.diagnostics.filter((d) => d.severity === "error");
      // The install's shape is one hash over everything, so a source shipping a
      // table no watch has ever heard of moves it for all of them at once — and
      // every watch on the install stops, having been told nothing it names
      // changed. That is the common case, not the rare one: drift arrives when
      // new *data* first lands, long after the deploy that made it possible.
      //
      // So the fingerprint alone is not a reason to stop. But "it still
      // validates" is not enough of a reason to carry on, either: a field whose
      // type widened, an enum that gained a member, a table that gained a
      // column a `SELECT *` now projects — each of those re-validates cleanly
      // and each changes what the watch *means*. Re-stamping on validity alone
      // would reinterpret the watch, which is the one thing this design forbids.
      //
      // What is safe is the case both live incidents actually were: the install
      // grew somewhere else entirely. So the bar is byte-identity of what this
      // watch reads — every ontology entry its last successful validation
      // consulted, unchanged. Identical inputs cannot produce a different
      // meaning, so nothing has been reinterpreted; anything else pauses and
      // waits for a person, exactly as before.
      //
      // Only attempted when the fingerprint is among the complaints: a watch
      // failing for any other reason is failing about something real, and
      // re-asking every pass would be work that cannot change the answer. And
      // only when there is a digest to compare against — a watch that has not
      // validated since the column existed has an unproven surface, and
      // unproven is treated as changed.
      const restampable = errors.some((d) => d.code === "ONTOLOGY_FINGERPRINT_MISMATCH");
      if (restampable) {
        const candidate = withFingerprint(stored.dsl, ontology.fingerprint);
        const rereading = new RecordingOntology(ontology);
        const revalidated = validateWatch(candidate, rereading);
        const surface = rereading.digest();
        if (revalidated.valid && stored.referenceDigest === null) {
          // Nothing on record to compare against. Held, and told which of the
          // two it is: "we never checked" is a different sentence from "we
          // checked and it moved", and one `watch restamp` clears it for good.
          held = SURFACE_UNRECORDED;
        } else if (revalidated.valid && surface === stored.referenceDigest) {
          await this.deps.writes.run(() =>
            Promise.resolve(this.deps.definitions.restamp(stored.id, ontology.fingerprint)),
          );
          // Logged, not silent: the watch is now checked against a world it was
          // never checked against by a person, and that is a thing to be able
          // to find afterwards.
          log.info(
            `watch ${stored.name} re-stamped to ${ontology.fingerprint} — the install's shape grew and nothing this watch reads moved`,
          );
          check = revalidated;
          dsl = candidate;
          referenceDigest = surface;
        } else if (revalidated.valid) {
          // The interesting refusal, and the reason this check exists. The
          // watch would have passed; it is held anyway, because something it
          // reads is not what it was approved against.
          log.info(
            `watch ${stored.name} still validates but the ontology it reads has changed — held for review rather than re-stamped`,
          );
          held = SURFACE_MOVED;
        }
      }
    }
    if (!check.valid) {
      // Two sentences, because they ask for two different things. A watch that
      // genuinely stopped validating needs rewriting and its codes name what
      // moved; one that validates and was held needs a person to look at what
      // changed and re-stamp it if it is still the watch they wanted. Writing
      // the first for both would tell the operator, falsely, that their watch
      // is broken.
      if (held !== null) {
        log.warn(`watch ${stored.id} held for review — the ontology it reads has changed`);
        await this.setStatus(stored.id, "paused", surfaceNote(held));
        return null;
      }
      const codes = check.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => d.code)
        .join(", ");
      log.warn(`watch ${stored.id} no longer validates (${codes}) — paused`);
      await this.setStatus(stored.id, "paused", driftNote(codes));
      return null;
    }

    // The watch means what it says against *this* surface, so this is the
    // surface a later drift is measured against. Written only when it moves,
    // which after the first pass is only when something the watch reads has
    // actually changed underneath a still-valid definition — a person merge,
    // say, which the install-wide fingerprint does not cover at all.
    if (referenceDigest !== null && referenceDigest !== stored.referenceDigest) {
      const digest = referenceDigest;
      await this.deps.writes.run(() =>
        Promise.resolve(this.deps.definitions.recordReferenceDigest(stored.id, digest)),
      );
    }

    // The definition's own id, not the name its DSL carries. Two watches may
    // hold the same name — an operator removing one and adding a replacement is
    // the ordinary way that happens — and keying durable state on the name
    // would hand the replacement the first one's cursor, its record of what it
    // had already looked at, its firings and its retirement.
    const watchId = stored.id;

    // The cursor is the watch's own. Seeded from the definition the first time
    // it is seen, so a watch added today starts at the head rather than at the
    // beginning of the corpus.
    if (this.state.cursor(watchId) === 0 && stored.fromSeq > 0) {
      await this.deps.writes.run(() =>
        Promise.resolve(this.state.advanceCursor(watchId, stored.fromSeq)),
      );
    }

    const from = this.state.cursor(watchId);
    const events = this.deps.journal.read(from, this.eventsPerWatch);

    // Run even with nothing new to read. A watch whose outstanding work is a
    // deadline — a recurring digest, a wait that has run out — has no event to
    // be carried forward by, and a pass that returned here would leave it
    // waiting for an unrelated document to arrive and drag the clock past it.
    // A parked nomination waiting on judge budget is in the same position.
    const trace = await new WatchEngine({
      watch: watchDslSchema.parse(dsl).watch,
      watchId,
      ontology,
      // The types the validation above already worked out. A `sql` node binding
      // an upstream value binds it as the definition says it is, rather than as
      // whatever shape a JSON round trip left it in.
      ...(check.types ? { valueTypes: check.types } : {}),
      journal: events,
      // Real time, which is what decides whether a deadline has come due. A
      // replay takes this from the journal's own end; a live runtime cannot,
      // because the journal ending says nothing about what o'clock it is.
      timeReachedMs: this.now(),
      // The store owns its own rows, the journal can be asked rather than
      // remembered, and the state lives on a connection this host opened.
      analytics: this.deps.analytics,
      lookupDocument: (docId, atSeq) => this.lookupDocument(docId, atSeq),
      store: this.state,
      judge: this.deps.judge,
      recall: this.deps.recall,
      // The materializer writes this file from its own task on the same thread.
      // Without a turn to take, the one that arrives second blocks the event
      // loop inside SQLite's busy handler instead of yielding.
      serializeWrites: (write) => this.deps.writes.run(write),
      ...(shouldYield ? { shouldYield } : {}),
    }).run();

    await this.deps.writes.run(() =>
      Promise.resolve(this.deps.traces.record(trace, new Date(this.now()).toISOString())),
    );

    if (trace.firings.length > 0) {
      log.info(
        `watch ${stored.name} fired ${trace.firings.length} time(s) over ${events.length} event(s)`,
      );
    }
    // Delivered before the outcome is decided, because a firing that reached
    // the ledger has to reach the person whatever happened *after* it. Each
    // event commits on its own, so a pass can fire on one and fail on the next
    // — and the firing before the failure is a committed row the cursor has
    // already moved past. Nothing will ever revisit it, so a delivery skipped
    // here is one that never happens, silently, which is precisely the shape
    // the suppression record exists to make impossible.
    const sent = await this.deliver(stored, watchDslSchema.parse(dsl).watch, trace);

    // Three ways a watch stops, and they must not be confused. The engine
    // deactivates a watch both when it is finished and when one of its nodes
    // threw — it contains the failure rather than raising it, so `run()` returns
    // normally either way and the catch above never sees it. Reading only
    // `isActive` would file a watch that broke as one that fired and finished,
    // which is a note an operator would believe.
    const failed = trace.records.find((record) => record.transition === "failed");
    if (trace.ended === "expired") {
      await this.setStatus(stored.id, "retired", "its horizon passed");
    } else if (failed) {
      const reason = nodeFailedNote(failed.nodeId, failed.failure ?? null);
      log.warn(`watch ${stored.name} paused: ${reason}`);
      await this.setStatus(stored.id, "paused", reason);
      return { events: events.length, firings: trace.firings.length, paused: true, ...sent };
    } else if (!this.state.isActive(watchId)) {
      // Inactive says the engine stopped this watch; it does not say why, and
      // the two reasons want opposite notes. The failure record does say, and
      // it outlives the process — which matters because the pause and the note
      // are two writes to two stores: a crash between them leaves a watch that
      // is active by definition and inactive by state, and this branch is where
      // the next tick reads it. Filing that as "fired once and was done" tells
      // an operator a broken watch finished, takes it out of the layer alarm,
      // and there is nothing left to correct it.
      const prior = this.state.failure(watchId);
      if (prior) {
        const reason = nodeFailedNote(prior.nodeId, prior.failure ?? null);
        log.warn(`watch ${stored.name} was left stopped by an earlier failure: ${reason}`);
        await this.setStatus(stored.id, "paused", reason);
        return { events: events.length, firings: trace.firings.length, paused: true, ...sent };
      }
      await this.setStatus(stored.id, "retired", "fired once and was done");
    }

    return { events: events.length, firings: trace.firings.length, paused: false, ...sent };
  }

  /**
   * Send what a delivery-bearing watch just said, as far as its caps allow.
   *
   * After the trace is recorded, not before: a firing is a row first and a
   * notification second, so a delivery that fails cannot cost the ledger the
   * record of what the watch decided.
   *
   * Suppression is written into the trace and counted. A cap that silently
   * dropped notifications would be indistinguishable from a watch that stopped
   * firing, which is the one thing a person relying on it cannot be left to
   * guess about.
   */
  private async deliver(
    stored: StoredWatch,
    watch: WatchDefinition,
    trace: WatchTrace,
  ): Promise<{ delivered: number; suppressed: number }> {
    if (!watch.delivery || trace.firings.length === 0) return { delivered: 0, suppressed: 0 };

    // Which ledger, which cap, and which transport — chosen once by kind, so
    // the loop below is the same for both and there is one place where a third
    // kind would have to be answered. `assertNever` makes that place a compile
    // error rather than a default anyone can fall through.
    const kind = watch.delivery.kind;
    const channel: DeliveryChannel =
      kind === "omnesis-notify"
        ? {
            caps: this.caps,
            spentByWatch: (id, day) => this.state.deliveredOn(id, day),
            spentOverall: (day) => this.state.deliveredAllOn(day),
            record: (id, day) => this.state.recordDelivery(id, day),
            noun: "notified you",
            plural: "notification(s)",
          }
        : kind === "agent-wake"
          ? {
              caps: this.wakeCaps,
              spentByWatch: (id, day) => this.state.wokeOn(id, day),
              spentOverall: (day) => this.state.wokeAllOn(day),
              record: (id, day) => this.state.recordWake(id, day),
              noun: "woken an agent",
              plural: "wake(s)",
            }
          : assertNever(kind);

    const send = kind === "omnesis-notify" ? this.deps.delivery?.() : this.deps.wake?.();
    if (!send) {
      log.warn(`watch ${stored.name} asks for ${kind} but none is wired — nothing was sent`);
      return { delivered: 0, suppressed: 0 };
    }

    const suppressed: TraceRecord[] = [];
    let delivered = 0;

    for (const firing of trace.firings) {
      // The cap entry and its outcome are one attempt. Anchor both to the same
      // instant so a slow transport crossing local midnight cannot split them
      // across different reporting days.
      const attemptedAtMs = this.now();
      const attemptedAt = new Date(attemptedAtMs).toISOString();
      const day = this.today(attemptedAtMs);
      // Re-read per firing rather than once: two firings in one pass spend the
      // same allowance, and a count taken before the loop would let the second
      // through on the strength of the first not having happened yet.
      const overall = channel.spentOverall(day);
      const own = channel.spentByWatch(stored.id, day);
      const why =
        own >= channel.caps.perWatchDailyCap
          ? `this watch has already ${channel.noun} ${own} time(s) today`
          : overall >= channel.caps.dailyCap
            ? `${overall} ${channel.plural} have gone out today across every watch`
            : null;
      if (why !== null) {
        suppressed.push({
          seq: firing.seq,
          nodeId: watch.sink.input,
          // The firing's own key, which it carries rendered alongside its hash.
          // Naming `singleton` here regardless would grow a phantom cell on
          // every keyed watch and leave the real key's history missing exactly
          // the records that explain why nothing arrived.
          key: firing.key,
          transition: "suppressed",
          detail: `not delivered: ${why}`,
        });
        continue;
      }

      const { title, body, authored } = watchNotificationCopy(watch);
      // Counted before the send, so a crash between the two costs one delivery
      // rather than un-capping the day.
      await this.deps.writes.run(() => Promise.resolve(channel.record(stored.id, day)));
      try {
        const outcome = await send.send({
          watchId: stored.id,
          watchName: stored.name,
          // `<watchId>:<seq>`, and a delivered notification is the only place
          // this shape is stated — the firings route returns the sequence but
          // no key, so a client that wants to point at the firing a banner was
          // about takes this apart. Changing the shape changes that landing.
          firingKey: `${stored.id}:${firing.seq}`,
          firingId: watchV2FiringKey({
            watchId: stored.id,
            seq: firing.seq,
            nodeId: firing.nodeId,
            keyHash: firing.keyHash,
          }),
          title,
          body,
          authoredCopy: authored,
          condition: watch.nl_query?.replace(/\s+/g, " ").trim() || stored.name,
          firedAt: firing.firedAt,
          documentIds: firing.documentIds,
          payload: firing.payload,
        });
        if (outcome.delivered > 0) delivered += 1;
        await this.recordOutcome(stored.id, firing, kind, outcome, attemptedAt);
      } catch (err) {
        // A transport that threw is a fact about the transport, not about the
        // watch. Stopping the watch for it would cost every firing behind this
        // one, and leave an operator resuming a watch that was never wrong.
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`watch ${stored.name}: delivery threw — ${message}`);
        // Recorded like any other outcome. A transport that threw is the case
        // an operator is most likely to be asking about later, and it is the
        // one a counter alone cannot tell them.
        await this.recordOutcome(
          stored.id,
          firing,
          kind,
          { delivered: 0, error: message },
          attemptedAt,
        );
      }
    }

    if (suppressed.length > 0) {
      log.warn(
        `watch ${stored.name}: ${suppressed.length} firing(s) not delivered — a daily cap is spent`,
      );
      await this.deps.writes.run(() =>
        Promise.resolve(
          this.deps.traces.record(
            { watch: stored.id, records: suppressed, firings: [] },
            new Date(this.now()).toISOString(),
          ),
        ),
      );
    }
    return { delivered, suppressed: suppressed.length };
  }

  /**
   * Write down what a delivery did, keyed by the firing's own identity.
   *
   * Never allowed to fail the pass: the firing happened whatever the bookkeeping
   * does, and losing a ledger row is a smaller harm than an evaluation that
   * stops because it could not write one.
   */
  private async recordOutcome(
    watchId: string,
    firing: WatchFiring,
    kind: string,
    outcome: WatchDeliveryOutcome,
    attemptedAt: string,
  ): Promise<void> {
    try {
      await this.deps.writes.run(() =>
        Promise.resolve(
          this.state.recordDeliveryOutcome({
            watchId,
            seq: firing.seq,
            nodeId: firing.nodeId,
            keyHash: firing.keyHash,
            kind,
            attempted: outcome.attempted ?? null,
            delivered: outcome.delivered,
            error: outcome.error ?? null,
            degraded: outcome.degraded ?? null,
            at: attemptedAt,
          }),
        ),
      );
    } catch (err) {
      log.warn(
        `watch ${watchId}: could not record what delivery did — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * How much of today's notification allowance is spent, and what it is.
   *
   * In the report because a cap that is being hit is a thing to know before
   * someone concludes their watches have gone quiet.
   */
  deliveryToday(): {
    dailyCap: number;
    perWatchDailyCap: number;
    attempted: number;
    degraded: number;
  } {
    const day = this.today();
    const { startMs, endMs } = localDayBounds(day);
    return {
      ...this.caps,
      attempted: this.state.deliveredAllOn(day),
      // Counted beside the allowance rather than buried in per-firing rows. A
      // degrade is invisible in every other number on the report — the
      // notifications went out and were accepted — so this is the only place a
      // reader learns that today's banners were the lesser ones.
      //
      // On an install with no agent integration at all, the two classes that
      // say so are not degrades: nothing is failing, and the banner every
      // firing ships is the best this install can send. Counting them would
      // make the number equal to today's firings on such an install, which
      // reads as an outage and is really a configuration. The rows stay — the
      // per-firing answer to "why was this one plain" is still true — but they
      // do not accumulate into an alarm the operator cannot act on.
      degraded: this.state.degradedBetween(
        new Date(startMs).toISOString(),
        new Date(endMs).toISOString(),
        this.unwired() ? UNWIRED_DEGRADES : [],
      ),
    };
  }

  /** Whether this install is known to have no agent integration wired. */
  private unwired(): boolean {
    // Unknown is not the same as unwired: a host that did not say gets the
    // count it has always got.
    return this.deps.agentIntegration !== undefined && !this.deps.agentIntegration();
  }

  /** How many notifications one watch has attempted today. */
  attemptedToday(watchId: string): number {
    return this.state.deliveredOn(watchId, this.today());
  }

  /**
   * The day a cap is a promise about.
   *
   * The **host's own** calendar day, not UTC. A cap bounds how often a person
   * is interrupted, which is a claim about their day — and on UTC an operator
   * in a western timezone gets their allowance back in the afternoon, so an
   * evening and the following morning are billed to different days. A
   * self-hosted gateway runs on their machine, so its local day is theirs.
   */
  private today(atMs = this.now()): string {
    return localDayKey(atMs);
  }

  /** Why a watch is stopped, as the runtime recorded it. */
  failure(watchId: string): WatchFailure | null {
    return this.state.failure(watchId);
  }

  /**
   * What it would take to move a watch past the thing it cannot get through.
   *
   * A node failure rolls its work back, cursor included, so the next pass meets
   * the same thing and stops on it again. That is the right default — work
   * whose effects were lost must not be skipped in silence — but it leaves a
   * watch that meets one poison item permanently stopped, with deleting and
   * re-adding it the only way out. That costs the watch its cursor, its live
   * instances and every firing it has recorded.
   *
   * There are two places a watch can be stuck, and only one of them is an
   * event the cursor has yet to pass:
   *
   * - a **journal event** ahead of the cursor, where advancing past it is the
   *   escape;
   * - a **parked nomination**, whose sequence is behind the cursor because it
   *   committed with it. Advancing a cursor that is already past it moves
   *   nothing at all; the thing to drop is the nomination.
   *
   * Anything else — a journaled timer, or work replayed over an already
   * consumed event — has no sequence a skip can act on, and is reported as
   * having nothing to skip rather than as a skip that did nothing. A recovery
   * that says it worked and did not is worse than one that refuses.
   *
   * Read-only: the plan is decided here so a caller can refuse before writing
   * anything, and applied in the same turn as the resume it belongs to.
   */
  skipPlan(watchId: string): SkipPlan | null {
    const failure = this.state.failure(watchId);
    if (!failure) return null;
    if (failure.seq > this.state.cursor(watchId)) {
      return { what: "event", seq: failure.seq, nodeId: failure.nodeId, why: failure.failure };
    }
    const parked = this.state
      .pendingNominations(watchId, PENDING_SCAN_LIMIT)
      .find((entry) => entry.nodeId === failure.nodeId && entry.seq === failure.seq);
    if (!parked) return null;
    return {
      what: "nomination",
      seq: failure.seq,
      nodeId: failure.nodeId,
      docId: parked.docId,
      why: failure.failure,
    };
  }

  /**
   * Carry out a skip, and say so in the ledger.
   *
   * Synchronous and lease-free on purpose: the caller applies it in the same
   * turn as the status change it accompanies. Split across two turns, a failure
   * between them would leave the cursor advanced and a record claiming an
   * operator moved past something, as part of a resume that never happened.
   */
  applySkip(watchId: string, plan: SkipPlan): void {
    if (plan.what === "event") {
      this.state.advanceCursor(watchId, plan.seq);
    } else {
      this.state.clearNomination(watchId, plan.nodeId, plan.docId);
    }
    this.deps.traces.record(
      {
        // A trace is filed under the watch's *id*, which is what survives a
        // watch being removed and a replacement taking its name.
        watch: watchId,
        records: [
          {
            seq: plan.seq,
            nodeId: plan.nodeId,
            key: SINGLETON_KEY,
            transition: "skipped",
            detail: `an operator moved past this ${plan.what} after a ${plan.why} failure`,
          },
        ],
        firings: [],
      },
      new Date(this.now()).toISOString(),
    );
    log.warn(`watch ${watchId} skipped ${plan.what} ${plan.seq} after a ${plan.why} failure`);
  }

  /**
   * The most recent `doc.event` for a document at or before `atSeq`.
   *
   * The bound is what keeps a host catching up after a restart from reading a
   * revision that had not happened yet at the event it is evaluating.
   */
  private lookupDocument(docId: string, atSeq: number): JournalDocument | null {
    return this.deps.journal.documentAt(docId, atSeq);
  }

  /**
   * The live ontology, as it is right now.
   *
   * Assembling one is not free: a scan of the corpus for which provider owns
   * which source, a read of the person directory, and one catalog round trip
   * per analytics table. At an evaluation every few seconds that is a
   * noticeable slice of the main thread spent re-deriving something that
   * changes when a provider ships a new profile — which is to say, on a
   * restart.
   *
   * So the snapshot is reused while its **fingerprint** holds. The fingerprint
   * covers the declared surface and deliberately omits the person directory, so
   * it cannot be the thing that decides whether people are fresh — and a stale
   * directory is not a performance question, it is a correctness one: a watch
   * naming someone who joined after the cache was filled would be accepted by
   * the route, which builds its own snapshot, and then paused by the next tick
   * with `PERSON_UNKNOWN`. Person-scoped watches are the flagship case and
   * cannot be the ones that break.
   *
   * The two are therefore refreshed on different clocks: the declared half is
   * rebuilt only when its fingerprint moves, and the people are re-read every
   * pass. `peopleChanged` is the cheap question that decides whether even that
   * needs re-indexing.
   */
  private async currentOntology(): Promise<Ontology> {
    const snapshot = await this.ontology.current();
    if (this.lastFingerprint !== null && this.lastFingerprint !== snapshot.fingerprint) {
      log.info(`ontology moved (${this.lastFingerprint} → ${snapshot.fingerprint})`);
    }
    this.lastFingerprint = snapshot.fingerprint;
    if (this.cached?.snapshot === snapshot) return this.cached.ontology;
    const ontology = Ontology.parse(snapshot);
    this.cached = { snapshot, ontology };
    return ontology;
  }
}

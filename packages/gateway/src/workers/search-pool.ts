// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SearchWorkerPool — pool of N search workers, each owning its own read-only
 * `index.db` handle + {@link UsearchReadRegistry}, driving the synchronous
 * candidate-generation core off the main event loop (Slice 3B).
 *
 * Unlike the io/writer/cpu pools, this pool is NOT a Scheduler `TaskRunner`:
 * the search hot path calls it DIRECTLY from `SearchPipeline`, bypassing
 * admission control, priorities, preemption, and reserved slots. Search must be
 * a direct, low-latency call with a synchronous saturation gate — the
 * scheduler's queueing machinery is the wrong shape for it. So the pool lives
 * here next to its worker + protocol, exposes `isReady`/`isDisposed`/
 * `inflightCount`/`maxInflightBeforeFallback` for the pipeline's delegate-or-
 * fallback gate, and the pipeline holds it directly.
 *
 * Calls beyond the workers' capacity queue on them: candidate generation holds
 * its thread for the whole query, and on the main thread that would stall every
 * request and WebSocket the gateway serves. On a worker problem (init failure,
 * crash, exit, rejected call) the pipeline degrades to running the IDENTICAL
 * `runCandidateGen` inline on the main thread — search is never failed by a
 * worker fault; it just loses the event-loop de-blocking for that query. An
 * operator can also opt into a saturation fallback with
 * `maxInflightBeforeFallback`.
 *
 * A slot whose worker has reported ready at least once is respawned whenever
 * that worker dies — by exit or by error, and whether or not `start()` has
 * settled yet. Calls route only to slots whose current worker is ready, so
 * the surviving workers keep serving while the replacement boots. The respawn
 * is bounded: a slot whose worker keeps dying without `respawnStableMs` of
 * service in between waits out an exponential backoff between attempts and is
 * abandoned after `maxRespawnStreak` of them, so a worker that crashes on
 * start cannot spin. `start()` resolves once every slot has reported ready at
 * least once, and rejects when a slot fails — exits, errors or reports
 * `initError` — before it ever reported ready: such a slot is not respawned,
 * and what becomes of the pool is the caller's to decide.
 *
 * The pool also reads each query's temporal intent (`temporalIntent`), so the
 * date recognizer runs on the workers. A reading asked for while the pool is
 * still starting waits (for a bounded time) for its first worker instead of
 * being refused: the caller's fallback would run the recognizer on the main
 * thread, and building its models there is the stall the workers exist to
 * avoid. Each worker holds its own models, a few tens of megabytes.
 */

import { Worker } from "node:worker_threads";
import { assertNever, createLogger } from "@omnesis/core";
import { ambientAnswerProfiler, type AnswerProfiler } from "../privacy/answer-profile.js";
import { DEFAULT_BACKGROUND_WORKER_NICE } from "./worker-priority.js";
import type { LexicalIndexData } from "../search/lexical-index-data.js";
import type { CandidateGenRequest, CandidateGenResult } from "../search/candidate-gen.js";
import type { TemporalIntent, TemporalIntentOptions } from "../search/temporal-intent.js";
import type { MainToSearch, SearchInit, SearchToMain } from "./search-protocol.js";

const log = createLogger("gateway:search-pool");

export interface SearchWorkerPoolOptions {
  indexDbPath: string;
  indexDbKeyHex?: string;
  configDir: string;
  /** Page-cache budget in bytes for each worker's read handle. */
  cacheSizeBytes?: number;
  /** Number of worker threads. Must be >= 1 (0 disables the pool at the call site). */
  concurrency: number;
  /**
   * When set and the inflight call count reaches it, the pipeline runs inline
   * on main instead of queueing on the workers. Unset, calls always queue.
   */
  maxInflightBeforeFallback?: number;
  heartbeatIntervalMs?: number;
  heartbeatWarnGapMs?: number;
  backgroundWorkerNice?: number;
  workerUrl: URL;
  workerExecArgv?: string[];
  /** Delay before the first respawn of a slot; doubles per consecutive crash. */
  respawnBaseDelayMs?: number;
  /** Ceiling on the respawn delay. */
  respawnMaxDelayMs?: number;
  /** Service time after which a worker's next crash starts a fresh streak. */
  respawnStableMs?: number;
  /** Respawns allowed in one streak before the slot is abandoned. */
  maxRespawnStreak?: number;
  /**
   * Whether `warmDateRecognizers()` builds the date recognizer's models on the
   * workers. Off when the temporal lane is.
   */
  warmTemporalIntent?: boolean;
  /** How long a temporal-intent reading waits for a starting pool's first worker. */
  startWaitMs?: number;
}

interface Pending {
  slot: WorkerSlot;
  resolve: (value: CandidateGenResult | TemporalIntent | null) => void;
  reject: (err: Error) => void;
  /**
   * Profiler captured at enqueue time. The reply lands in a `message`
   * handler outside any request's async context, so the ambient lookup
   * would always miss — the reference travels with the pending entry.
   */
  profiler: AnswerProfiler | undefined;
  /** The queue name the call's span is recorded under. */
  span: string;
}

interface WorkerSlot {
  readonly index: number;
  /** Null while the slot waits out a respawn delay or has been abandoned. */
  worker: Worker | null;
  /** The current worker has reported `ready` and may take calls. */
  ready: boolean;
  /**
   * Some worker in this slot has reported `ready` — kept across respawns.
   * Such a slot is respawned when its worker dies; one that never came up
   * fails `start()` instead.
   */
  everReady: boolean;
  /** When the current worker reported ready; null until it does. */
  readySince: number | null;
  /** Consecutive crashes not separated by `respawnStableMs` of service. */
  crashStreak: number;
  respawnTimer: ReturnType<typeof setTimeout> | null;
  lastHeartbeat: number;
  heartbeatCheck: ReturnType<typeof setInterval> | null;
  shutdownResolve: (() => void) | null;
  unresponsiveSince: number | null;
  /** Where the current worker's date recognizer models stand; a new worker starts cold. */
  temporal: "cold" | "warming" | "warm";
}

/**
 * The candidate with the fewest calls in flight. Ties rotate with `turn`, so an
 * idle pool spreads calls across workers as round-robin would.
 */
export function leastLoaded<T>(candidates: readonly T[], inflight: readonly T[], turn: number): T {
  const load = new Map<T, number>();
  for (const s of inflight) load.set(s, (load.get(s) ?? 0) + 1);
  let best = candidates[turn % candidates.length];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[(turn + i) % candidates.length];
    if ((load.get(c) ?? 0) < (load.get(best) ?? 0)) best = c;
  }
  return best;
}

export class SearchWorkerPool {
  readonly concurrency: number;
  readonly maxInflightBeforeFallback: number;

  private slots: WorkerSlot[] = [];
  private ready = false;
  /** `start()`'s promise has resolved or rejected; it settles once. */
  private readySettled = false;
  private disposed = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  /** Settles when the first worker reports ready, or when `start()` fails first. */
  private firstReadyPromise: Promise<void>;
  private resolveFirstReady!: () => void;
  private rejectFirstReady!: (err: Error) => void;
  private nextId = 1;
  private inflight = new Map<number, Pending>();
  /** The lexical index every worker ranks with; re-sent to respawned workers. */
  private lexicalIndex: LexicalIndexData | undefined;
  /** `warmDateRecognizers()` was called: every worker, respawned ones too, is to be warmed. */
  private temporalWarmRequested = false;
  private readonly opts: Required<
    Omit<SearchWorkerPoolOptions, "indexDbKeyHex" | "cacheSizeBytes">
  > & {
    indexDbKeyHex: string | undefined;
    cacheSizeBytes: number | undefined;
  };

  constructor(opts: SearchWorkerPoolOptions) {
    this.concurrency = Math.max(1, opts.concurrency);
    this.maxInflightBeforeFallback =
      opts.maxInflightBeforeFallback === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(1, opts.maxInflightBeforeFallback);
    this.opts = {
      indexDbPath: opts.indexDbPath,
      indexDbKeyHex: opts.indexDbKeyHex,
      configDir: opts.configDir,
      cacheSizeBytes: opts.cacheSizeBytes,
      concurrency: this.concurrency,
      maxInflightBeforeFallback: this.maxInflightBeforeFallback,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 5_000,
      heartbeatWarnGapMs: opts.heartbeatWarnGapMs ?? 30_000,
      backgroundWorkerNice: opts.backgroundWorkerNice ?? DEFAULT_BACKGROUND_WORKER_NICE,
      workerUrl: opts.workerUrl,
      workerExecArgv: opts.workerExecArgv ?? [],
      respawnBaseDelayMs: opts.respawnBaseDelayMs ?? 1_000,
      respawnMaxDelayMs: opts.respawnMaxDelayMs ?? 30_000,
      respawnStableMs: opts.respawnStableMs ?? 60_000,
      maxRespawnStreak: opts.maxRespawnStreak ?? 5,
      warmTemporalIntent: opts.warmTemporalIntent ?? false,
      startWaitMs: opts.startWaitMs ?? 5_000,
    };
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.firstReadyPromise = new Promise<void>((resolve, reject) => {
      this.resolveFirstReady = resolve;
      this.rejectFirstReady = reject;
    });
    // Awaited only by readings asked for during start; a failed start is
    // reported through `start()` itself.
    this.firstReadyPromise.catch(() => {});
  }

  /** True while at least one worker has reported `ready`. Read by the pipeline's gate. */
  get isReady(): boolean {
    return this.ready && !this.disposed;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** True from `start()` until it settles: no worker has reported ready yet, and none has failed. */
  get isStarting(): boolean {
    return this.slots.length > 0 && !this.readySettled && !this.ready && !this.disposed;
  }

  /** Current in-flight calls of either operation — the synchronous saturation signal. */
  get inflightCount(): number {
    return this.inflight.size;
  }

  async start(): Promise<void> {
    if (this.slots.length > 0) return this.readyPromise;

    for (let i = 0; i < this.concurrency; i++) {
      const slot: WorkerSlot = {
        index: i,
        worker: null,
        ready: false,
        everReady: false,
        readySince: null,
        crashStreak: 0,
        respawnTimer: null,
        lastHeartbeat: 0,
        heartbeatCheck: null,
        shutdownResolve: null,
        unresponsiveSince: null,
        temporal: "cold",
      };
      this.slots.push(slot);
      this.spawn(slot);

      slot.heartbeatCheck = setInterval(() => {
        if (!slot.lastHeartbeat) return;
        const gap = Date.now() - slot.lastHeartbeat;
        if (gap > this.opts.heartbeatWarnGapMs && slot.unresponsiveSince === null) {
          slot.unresponsiveSince = Date.now();
          log.warn(
            `search worker ${i} unresponsive (last heartbeat ${Math.round(gap / 1000)}s ago)`,
          );
        }
      }, this.opts.heartbeatIntervalMs);
      slot.heartbeatCheck.unref?.();
    }

    log.info(`starting ${this.concurrency} search worker(s)`);
    await this.readyPromise;
  }

  /**
   * Run candidate generation on a worker. Picks the ready worker with the
   * fewest calls in flight (ties rotate), so a fast query never waits behind a
   * slow one while another worker sits idle, and correlates the reply by id.
   * Rejects if the pool is disposed, no worker is ready, or the worker fails —
   * a starting pool waits for its first ready worker. Unfiltered callers may
   * retain their inline fallback; filtered callers require worker execution.
   */
  async candidateGen(request: CandidateGenRequest): Promise<CandidateGenResult> {
    if (this.isStarting) await this.firstReady();
    return (await this.dispatch("search-worker", (id, enqueueMs) => ({
      type: "call",
      id,
      request,
      enqueueMs,
    }))) as CandidateGenResult;
  }

  /**
   * Read the time a query names on a worker — the same `parseTemporalIntent`
   * the caller would run, over the same text and options. While `start()` has
   * not settled it waits up to `startWaitMs` for the first worker to report
   * ready. Rejects like
   * {@link candidateGen}, and when the pool fails to start.
   */
  async temporalIntent(
    text: string,
    options: TemporalIntentOptions,
  ): Promise<TemporalIntent | null> {
    if (this.isStarting) await this.firstReady();
    return (await this.dispatch("search-worker:temporal-intent", (id, enqueueMs) => ({
      type: "temporalIntent",
      id,
      text,
      options,
      enqueueMs,
    }))) as TemporalIntent | null;
  }

  /**
   * Build the date recognizer's models on every worker, one worker at a time,
   * and on each worker that replaces a dead one. Building them takes a second
   * or more of CPU per worker, so all workers at once would occupy as many
   * cores just as the gateway starts serving; one at a time occupies one.
   * Readings are dispatched as always meanwhile, and one that reaches a worker
   * that is not warm yet builds the models it needs there.
   */
  warmDateRecognizers(): void {
    if (!this.opts.warmTemporalIntent || this.disposed) return;
    this.temporalWarmRequested = true;
    this.warmNextWorker();
  }

  /** Ask the next ready, cold worker to warm, unless one is warming already. */
  private warmNextWorker(): void {
    if (!this.temporalWarmRequested || this.disposed) return;
    if (this.slots.some((s) => s.temporal === "warming")) return;
    const next = this.slots.find((s) => s.ready && s.worker !== null && s.temporal === "cold");
    if (!next) return;
    next.temporal = "warming";
    next.worker!.postMessage({ type: "warmTemporalIntent" } satisfies MainToSearch);
  }

  /**
   * The first worker's `ready`, waited for at most `startWaitMs`: a worker that
   * never answers its `init` must not hold every search that names a time.
   */
  private async firstReady(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`no search worker reported ready within ${this.opts.startWaitMs}ms`)),
        this.opts.startWaitMs,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([this.firstReadyPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Post one operation to the ready worker with the fewest calls in flight
   * (ties rotate) and correlate its reply by id.
   */
  private dispatch(
    span: string,
    message: (id: number, enqueueMs: number) => MainToSearch,
  ): Promise<CandidateGenResult | TemporalIntent | null> {
    if (this.disposed) return Promise.reject(new Error("search worker pool disposed"));
    if (this.slots.length === 0) return Promise.reject(new Error("search worker pool not started"));
    const live = this.slots.filter((s) => s.ready && s.worker !== null);
    if (live.length === 0) return Promise.reject(new Error("no search worker is ready"));
    const id = this.nextId++;
    const slot = leastLoaded(
      live,
      [...this.inflight.values()].map((p) => p.slot),
      id,
    );
    const enqueueMs = Date.now();
    // Captured here, in the caller's async chain: the reply handler cannot
    // see the ambient profiler (cross-thread event), so the reference
    // travels with the pending entry.
    const profiler = ambientAnswerProfiler();
    return new Promise((resolve, reject) => {
      this.inflight.set(id, { slot, resolve, reject, profiler, span });
      slot.worker!.postMessage(message(id, enqueueMs));
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectFirstReady(new Error("search worker pool disposed"));

    const shutdowns = this.slots.map((slot) => {
      if (slot.heartbeatCheck) clearInterval(slot.heartbeatCheck);
      if (slot.respawnTimer) clearTimeout(slot.respawnTimer);
      slot.respawnTimer = null;
      const worker = slot.worker;
      if (!worker) return Promise.resolve();
      const p = new Promise<void>((resolve) => {
        slot.shutdownResolve = resolve;
      });
      worker.postMessage({ type: "shutdown" } satisfies MainToSearch);
      const fallback = setTimeout(() => {
        log.warn(`search worker ${slot.index} shutdown timed out — terminating`);
        try {
          void worker.terminate();
        } catch {
          /* best-effort */
        }
        slot.shutdownResolve?.();
      }, 5_000);
      fallback.unref?.();
      return p.then(() => clearTimeout(fallback));
    });

    await Promise.all(shutdowns);
    this.rejectAllInflight(new Error("search worker pool shut down"));
  }

  /**
   * Hand every worker the lexical index, replacing any earlier one. The arrays
   * are shared memory, so this costs no copy; a worker spawned later receives
   * the same index right after its `init`.
   */
  setLexicalIndex(data: LexicalIndexData): void {
    this.lexicalIndex = data;
    for (const slot of this.slots) {
      slot.worker?.postMessage({ type: "lexicalIndex", data } satisfies MainToSearch);
    }
  }

  // ────────────────────────────────────────────────────────────────────

  /** Boot a worker into `slot` — at start and again after a crash. */
  private spawn(slot: WorkerSlot): void {
    const worker = new Worker(this.opts.workerUrl, { execArgv: this.opts.workerExecArgv });
    slot.worker = worker;
    slot.ready = false;
    slot.readySince = null;
    slot.lastHeartbeat = 0;
    slot.unresponsiveSince = null;
    slot.temporal = "cold";

    // A worker that has been replaced may still have messages queued; only the
    // slot's current worker speaks for it.
    worker.on("message", (msg: SearchToMain) => {
      if (slot.worker === worker) this.handleMessage(slot, msg);
    });
    worker.on("error", (err) => {
      log.error(`search worker ${slot.index} error: ${err.message ?? err}`);
      // Fail safe: a faulted worker stops taking calls at once so the
      // pipeline's gate runs candidate-gen on main rather than posting to a
      // thread that is about to exit. The exit that follows decides the
      // slot's fate; the error is only recorded here so that a slot which
      // never came up fails `start()` with the fault rather than the exit code.
      this.markDown(slot, new Error(`search worker error: ${err.message ?? err}`));
      if (!slot.everReady) this.rejectStart(err);
    });
    worker.on("exit", (code) => {
      if (slot.worker !== worker) return;
      if (!this.disposed) {
        log.error(`search worker ${slot.index} exited unexpectedly with code=${code}`);
      }
      this.markDown(slot, new Error(`search worker exited code=${code}`));
      slot.shutdownResolve?.();
      if (this.disposed) return;
      if (slot.everReady) {
        this.scheduleRespawn(slot);
      } else {
        this.rejectStart(
          new Error(`search worker ${slot.index} exited code=${code} before reporting ready`),
        );
      }
    });

    const init: SearchInit = {
      type: "init",
      indexDbPath: this.opts.indexDbPath,
      configDir: this.opts.configDir,
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
      backgroundWorkerNice: this.opts.backgroundWorkerNice,
      ...(this.opts.indexDbKeyHex ? { indexDbKeyHex: this.opts.indexDbKeyHex } : {}),
      ...(this.opts.cacheSizeBytes != null ? { cacheSizeBytes: this.opts.cacheSizeBytes } : {}),
    };
    worker.postMessage(init);
    if (this.lexicalIndex) {
      worker.postMessage({ type: "lexicalIndex", data: this.lexicalIndex } satisfies MainToSearch);
    }
  }

  /** Take a slot out of rotation and fail the calls it was serving. */
  private markDown(slot: WorkerSlot, err: Error): void {
    slot.ready = false;
    slot.lastHeartbeat = 0;
    slot.unresponsiveSince = null;
    // Its replacement starts cold; meanwhile another worker may take the turn.
    slot.temporal = "cold";
    this.warmNextWorker();
    this.ready = this.slots.some((s) => s.ready);
    for (const [id, p] of this.inflight) {
      if (p.slot === slot) {
        p.reject(err);
        this.inflight.delete(id);
      }
    }
  }

  /**
   * Queue a replacement for a dead worker, or abandon the slot when the
   * streak says the replacement would die the same way.
   */
  private scheduleRespawn(slot: WorkerSlot): void {
    const servedMs = slot.readySince === null ? 0 : Date.now() - slot.readySince;
    slot.crashStreak = servedMs >= this.opts.respawnStableMs ? 1 : slot.crashStreak + 1;
    slot.worker = null;
    slot.readySince = null;

    const { maxRespawnStreak, respawnBaseDelayMs, respawnMaxDelayMs, respawnStableMs } = this.opts;
    if (slot.crashStreak > maxRespawnStreak) {
      log.error(
        `search worker ${slot.index} crashed ${slot.crashStreak} times without ${respawnStableMs}ms of service between — ` +
          `not respawning it again; its share of candidate generation runs on the main thread until the gateway restarts`,
      );
      return;
    }
    const delayMs = Math.min(respawnBaseDelayMs * 2 ** (slot.crashStreak - 1), respawnMaxDelayMs);
    log.info(
      `search worker ${slot.index} respawning in ${delayMs}ms (crash ${slot.crashStreak}/${maxRespawnStreak})`,
    );
    slot.respawnTimer = setTimeout(() => {
      slot.respawnTimer = null;
      if (this.disposed) return;
      this.spawn(slot);
    }, delayMs);
    slot.respawnTimer.unref?.();
  }

  private resolveStart(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady();
  }

  private rejectStart(err: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.rejectReady(err);
    this.rejectFirstReady(err);
  }

  private handleMessage(slot: WorkerSlot, msg: SearchToMain): void {
    switch (msg.type) {
      case "ready":
        slot.ready = true;
        slot.everReady = true;
        slot.readySince = Date.now();
        slot.lastHeartbeat = slot.readySince;
        this.ready = true;
        this.resolveFirstReady();
        if (slot.crashStreak > 0) log.info(`search worker ${slot.index} respawned and ready`);
        if (this.slots.every((s) => s.everReady)) this.resolveStart();
        this.warmNextWorker();
        break;
      case "temporalIntentWarm":
        slot.temporal = "warm";
        this.warmNextWorker();
        break;
      case "initError":
        if (slot.everReady) {
          // A replacement that cannot open its handle: end it so the exit
          // handler counts the attempt against the streak.
          void slot.worker?.terminate().catch(() => {});
        } else {
          this.rejectStart(new Error(msg.error));
        }
        break;
      case "heartbeat":
        if (slot.unresponsiveSince !== null) {
          const blockedMs = Date.now() - slot.unresponsiveSince;
          log.info(`search worker ${slot.index} recovered after ${Math.round(blockedMs / 1000)}s`);
          slot.unresponsiveSince = null;
        }
        slot.lastHeartbeat = msg.ts;
        break;
      case "log":
        log.child(msg.component)[msg.level](msg.message);
        break;
      case "result": {
        const pending = this.inflight.get(msg.id);
        if (!pending) {
          log.warn(`unexpected search result for id=${msg.id} (no pending entry)`);
          return;
        }
        this.inflight.delete(msg.id);
        // The profiler rode in on the pending entry (see dispatch): the
        // ambient store is unreachable from this handler.
        pending.profiler?.recordQueueSpan(pending.span, msg.queueMs, msg.execMs);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new Error(msg.error));
        break;
      }
      case "shutdownComplete":
        slot.shutdownResolve?.();
        break;
      default:
        assertNever(msg);
    }
  }

  private rejectAllInflight(err: Error): void {
    for (const [, p] of this.inflight) p.reject(err);
    this.inflight.clear();
  }
}

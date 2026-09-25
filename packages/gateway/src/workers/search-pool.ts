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
 * On any worker problem (init failure, crash, exit, rejected call, saturation)
 * the pipeline degrades to running the IDENTICAL `runCandidateGen` inline on
 * the main thread — search is never failed by a worker fault; it just loses the
 * event-loop de-blocking for that query.
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
 */

import { Worker } from "node:worker_threads";
import { createLogger } from "@omnesis/core";
import { ambientAnswerProfiler, type AnswerProfiler } from "../privacy/answer-profile.js";
import { DEFAULT_BACKGROUND_WORKER_NICE } from "./worker-priority.js";
import type { CandidateGenRequest, CandidateGenResult } from "../search/candidate-gen.js";
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
   * When the inflight call count reaches this, the pipeline runs inline on main
   * instead of queueing behind a slow query on the single-worker FIFO — bounds
   * worst-case per-request latency (#1436 posture).
   */
  maxInflightBeforeFallback: number;
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
}

interface Pending {
  slot: WorkerSlot;
  resolve: (value: CandidateGenResult) => void;
  reject: (err: Error) => void;
  /**
   * Profiler captured at enqueue time. The reply lands in a `message`
   * handler outside any request's async context, so the ambient lookup
   * would always miss — the reference travels with the pending entry.
   */
  profiler: AnswerProfiler | undefined;
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
  private nextId = 1;
  private inflight = new Map<number, Pending>();
  private readonly opts: Required<
    Omit<SearchWorkerPoolOptions, "indexDbKeyHex" | "cacheSizeBytes">
  > & {
    indexDbKeyHex: string | undefined;
    cacheSizeBytes: number | undefined;
  };

  constructor(opts: SearchWorkerPoolOptions) {
    this.concurrency = Math.max(1, opts.concurrency);
    this.maxInflightBeforeFallback = Math.max(1, opts.maxInflightBeforeFallback);
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
    };
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  /** True while at least one worker has reported `ready`. Read by the pipeline's gate. */
  get isReady(): boolean {
    return this.ready && !this.disposed;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Current in-flight candidate-gen calls — the synchronous saturation signal. */
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
   * Run candidate generation on a worker. Round-robins across the slots whose
   * worker is ready and correlates the reply by id. Rejects if the pool is
   * disposed, no worker is ready, or the worker fails — the caller
   * (`SearchPipeline.candidateGen`) catches and falls back to the identical
   * `runCandidateGen` on main.
   */
  async candidateGen(request: CandidateGenRequest): Promise<CandidateGenResult> {
    if (this.disposed) throw new Error("search worker pool disposed");
    if (this.slots.length === 0) throw new Error("search worker pool not started");
    const live = this.slots.filter((s) => s.ready && s.worker !== null);
    if (live.length === 0) throw new Error("no search worker is ready");
    const id = this.nextId++;
    const slot = live[id % live.length];
    const enqueueMs = Date.now();
    // Captured here, in the caller's async chain: the reply handler cannot
    // see the ambient profiler (cross-thread event), so the reference
    // travels with the pending entry.
    const profiler = ambientAnswerProfiler();
    return new Promise<CandidateGenResult>((resolve, reject) => {
      this.inflight.set(id, { slot, resolve, reject, profiler });
      slot.worker!.postMessage({ type: "call", id, request, enqueueMs } satisfies MainToSearch);
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

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

  // ────────────────────────────────────────────────────────────────────

  /** Boot a worker into `slot` — at start and again after a crash. */
  private spawn(slot: WorkerSlot): void {
    const worker = new Worker(this.opts.workerUrl, { execArgv: this.opts.workerExecArgv });
    slot.worker = worker;
    slot.ready = false;
    slot.readySince = null;
    slot.lastHeartbeat = 0;
    slot.unresponsiveSince = null;

    worker.on("message", (msg: SearchToMain) => this.handleMessage(slot, msg));
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
  }

  /** Take a slot out of rotation and fail the calls it was serving. */
  private markDown(slot: WorkerSlot, err: Error): void {
    slot.ready = false;
    slot.lastHeartbeat = 0;
    slot.unresponsiveSince = null;
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
  }

  private handleMessage(slot: WorkerSlot, msg: SearchToMain): void {
    switch (msg.type) {
      case "ready":
        slot.ready = true;
        slot.everReady = true;
        slot.readySince = Date.now();
        slot.lastHeartbeat = slot.readySince;
        this.ready = true;
        if (slot.crashStreak > 0) log.info(`search worker ${slot.index} respawned and ready`);
        if (this.slots.every((s) => s.everReady)) this.resolveStart();
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
        // The profiler rode in on the pending entry (see candidateGen):
        // the ambient store is unreachable from this handler.
        pending.profiler?.recordQueueSpan("search-worker", msg.queueMs, msg.execMs);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new Error(msg.error));
        break;
      }
      case "shutdownComplete":
        slot.shutdownResolve?.();
        break;
    }
  }

  private rejectAllInflight(err: Error): void {
    for (const [, p] of this.inflight) p.reject(err);
    this.inflight.clear();
  }
}

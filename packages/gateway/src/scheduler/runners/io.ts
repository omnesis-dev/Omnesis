// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * IoTaskRunner — pool of N read-only io workers, each owning
 * its own `better-sqlite3` handle on `omnesis.db`. The Scheduler
 * dispatches up to `concurrency` tasks in parallel; each call is routed
 * to an idle worker (not a static `id % N` slot), so a worker stuck on a
 * slow op never collects a backlog while its peers sit idle — the property
 * the Scheduler's reserved-user-slot depends on to keep a latency-sensitive
 * read off a jammed worker.
 *
 * Each worker is a full `io-worker.ts` instance with its own read-only
 * SQLite connection. Under WAL mode, multiple readers see consistent
 * snapshots via MVCC — no coordination needed.
 */

import { Worker } from "node:worker_threads";
import { createLogger } from "@omnesis/core";
import { TaskExecutionError } from "../types.js";
import { DEFAULT_BACKGROUND_WORKER_NICE } from "../../workers/worker-priority.js";
import type { TaskRunner } from "../runner.js";
import type { Task, TaskContext, TaskOutcome } from "../types.js";
import type { IoInit, IoToMain, MainToIo } from "../../workers/protocol.js";

const log = createLogger("gateway:scheduler:io");

/** Constructs the worker thread. Overridable in tests to inject a fake. */
export type IoWorkerFactory = (url: URL, opts: { execArgv: string[] }) => Worker;

export interface IoTaskRunnerOptions {
  gatewayDbPath: string;
  gatewayDbKeyHex?: string;
  concurrency?: number;
  heartbeatIntervalMs?: number;
  heartbeatWarnGapMs?: number;
  workerUrl: URL;
  workerExecArgv?: string[];
  /** OS nice for the worker threads (resolved in runtime-settings). */
  backgroundWorkerNice?: number;
  /** Page-cache budget in bytes for each io worker's read handle. */
  cacheSizeBytes?: number;
  /** Test seam: override worker construction. Defaults to `new Worker`. */
  createWorker?: IoWorkerFactory;
}

interface PendingExec {
  resolve: (outcome: TaskOutcome<unknown, unknown>) => void;
  reject: (err: Error) => void;
  taskName: string;
}

/** A submitted call awaiting (or assigned to) a worker. */
interface QueuedCall {
  id: number;
  op: string;
  args: unknown[];
  enqueueMs: number;
}

function asOutcome<TArgs, TResult>(raw: unknown): TaskOutcome<TArgs, TResult> {
  if (raw !== null && typeof raw === "object" && "kind" in (raw as object)) {
    const k = (raw as { kind: unknown }).kind;
    if (k === "done" || k === "yield") {
      return raw as TaskOutcome<TArgs, TResult>;
    }
  }
  return { kind: "done", value: raw as TResult };
}

interface WorkerSlot {
  index: number;
  worker: Worker;
  lastHeartbeat: number;
  heartbeatCheck: ReturnType<typeof setInterval> | null;
  shutdownResolve: (() => void) | null;
  unresponsiveSince: number | null;
  /** Id of the call this worker is currently processing, or null if idle. */
  currentId: number | null;
  /** Set once the worker has exited/errored — never routed new work. */
  dead: boolean;
}

export class IoTaskRunner implements TaskRunner {
  public readonly kind = "io" as const;
  public readonly concurrency: number;

  private slots: WorkerSlot[] = [];
  private readyCount = 0;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private nextId = 1;
  private inflight = new Map<number, PendingExec>();
  /** Calls submitted while every worker was busy — drained as slots free. */
  private waiting: QueuedCall[] = [];
  private disposed = false;
  private readonly createWorker: IoWorkerFactory;
  private readonly opts: Required<
    Omit<IoTaskRunnerOptions, "concurrency" | "gatewayDbKeyHex" | "cacheSizeBytes" | "createWorker">
  > & {
    gatewayDbKeyHex: string | undefined;
    cacheSizeBytes: number | undefined;
  };

  constructor(opts: IoTaskRunnerOptions) {
    this.concurrency = opts.concurrency ?? 1;
    this.createWorker = opts.createWorker ?? ((url, o) => new Worker(url, o));
    this.opts = {
      gatewayDbPath: opts.gatewayDbPath,
      gatewayDbKeyHex: opts.gatewayDbKeyHex,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 5_000,
      heartbeatWarnGapMs: opts.heartbeatWarnGapMs ?? 30_000,
      workerUrl: opts.workerUrl,
      workerExecArgv: opts.workerExecArgv ?? [],
      backgroundWorkerNice: opts.backgroundWorkerNice ?? DEFAULT_BACKGROUND_WORKER_NICE,
      cacheSizeBytes: opts.cacheSizeBytes,
    };
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  async start(): Promise<void> {
    if (this.slots.length > 0) return this.readyPromise;

    for (let i = 0; i < this.concurrency; i++) {
      const worker = this.createWorker(this.opts.workerUrl, {
        execArgv: this.opts.workerExecArgv,
      });
      const slot: WorkerSlot = {
        index: i,
        worker,
        lastHeartbeat: 0,
        heartbeatCheck: null,
        shutdownResolve: null,
        unresponsiveSince: null,
        currentId: null,
        dead: false,
      };

      worker.on("message", (msg: IoToMain) => this.handleMessage(slot, msg));
      worker.on("error", (err) => {
        log.error(`io worker ${i} error: ${err.message ?? err}`);
        slot.dead = true;
        this.rejectInflightForWorker(slot, new Error(`io worker error: ${err.message ?? err}`));
        this.rejectReady(err);
        this.drainWaiting();
      });
      worker.on("exit", (code) => {
        if (!this.disposed) {
          log.error(`io worker ${i} exited unexpectedly with code=${code}`);
        }
        slot.dead = true;
        this.rejectInflightForWorker(slot, new Error(`io worker exited code=${code}`));
        slot.shutdownResolve?.();
        this.drainWaiting();
      });

      const init: IoInit = {
        type: "init",
        gatewayDbPath: this.opts.gatewayDbPath,
        heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
        backgroundWorkerNice: this.opts.backgroundWorkerNice,
        ...(this.opts.gatewayDbKeyHex ? { gatewayDbKeyHex: this.opts.gatewayDbKeyHex } : {}),
        ...(this.opts.cacheSizeBytes != null ? { cacheSizeBytes: this.opts.cacheSizeBytes } : {}),
      };
      worker.postMessage(init);

      slot.heartbeatCheck = setInterval(() => {
        if (!slot.lastHeartbeat) return;
        const gap = Date.now() - slot.lastHeartbeat;
        if (gap > this.opts.heartbeatWarnGapMs && slot.unresponsiveSince === null) {
          slot.unresponsiveSince = Date.now();
          log.warn(`io worker ${i} unresponsive (last heartbeat ${Math.round(gap / 1000)}s ago)`);
        }
      }, this.opts.heartbeatIntervalMs);
      slot.heartbeatCheck.unref?.();

      this.slots.push(slot);
    }

    log.info(`starting ${this.concurrency} io worker(s)`);
    await this.readyPromise;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const shutdowns = this.slots.map((slot) => {
      if (slot.heartbeatCheck) clearInterval(slot.heartbeatCheck);
      const p = new Promise<void>((resolve) => {
        slot.shutdownResolve = resolve;
      });
      slot.worker.postMessage({ type: "shutdown" } satisfies MainToIo);
      const fallback = setTimeout(() => {
        log.warn(`io worker ${slot.index} shutdown timed out — terminating`);
        try {
          slot.worker.terminate();
        } catch {
          /* best-effort */
        }
        slot.shutdownResolve?.();
      }, 5_000);
      fallback.unref?.();
      return p.then(() => clearTimeout(fallback));
    });

    await Promise.all(shutdowns);
    this.rejectAllInflight(new Error("io workers shut down"));
  }

  async exec<TArgs, TResult>(
    task: Task<TArgs, TResult>,
    args: TArgs,
    _ctx: TaskContext,
  ): Promise<TaskOutcome<TArgs, TResult>> {
    if (this.disposed) {
      throw new Error("io task runner disposed");
    }
    const id = this.nextId++;
    const argsArray = Array.isArray(args) ? (args as unknown[]) : [args];
    return new Promise<TaskOutcome<TArgs, TResult>>((resolve, reject) => {
      this.inflight.set(id, {
        resolve: resolve as (o: TaskOutcome<unknown, unknown>) => void,
        reject,
        taskName: task.name,
      });
      const call: QueuedCall = { id, op: task.name, args: argsArray, enqueueMs: Date.now() };
      const slot = this.idleSlot();
      if (slot) this.dispatchTo(slot, call);
      else this.waiting.push(call);
    });
  }

  // ────────────────────────────────────────────────────────────────────

  /** First live, idle worker — or null if all are busy or dead. */
  private idleSlot(): WorkerSlot | null {
    for (const slot of this.slots) {
      if (!slot.dead && slot.currentId === null) return slot;
    }
    return null;
  }

  private dispatchTo(slot: WorkerSlot, call: QueuedCall): void {
    slot.currentId = call.id;
    slot.worker.postMessage({
      type: "call",
      id: call.id,
      op: call.op,
      args: call.args,
      enqueueMs: call.enqueueMs,
    } satisfies MainToIo);
  }

  /** Hand queued calls to any idle workers (no-op when `waiting` is empty). */
  private drainWaiting(): void {
    while (this.waiting.length > 0) {
      const slot = this.idleSlot();
      if (!slot) break;
      this.dispatchTo(slot, this.waiting.shift()!);
    }
  }

  private handleMessage(slot: WorkerSlot, msg: IoToMain): void {
    switch (msg.type) {
      case "ready":
        slot.lastHeartbeat = Date.now();
        this.readyCount += 1;
        if (this.readyCount >= this.concurrency) {
          this.resolveReady();
        }
        break;
      case "initError":
        this.rejectReady(new Error(msg.error));
        break;
      case "heartbeat":
        if (slot.unresponsiveSince !== null) {
          const blockedMs = Date.now() - slot.unresponsiveSince;
          log.info(`io worker ${slot.index} recovered after ${Math.round(blockedMs / 1000)}s`);
          slot.unresponsiveSince = null;
        }
        slot.lastHeartbeat = msg.ts;
        break;
      case "log":
        log.child(msg.component)[msg.level](msg.message);
        break;
      case "result": {
        const pending = this.inflight.get(msg.id);
        // Free the worker and immediately hand it the next queued call
        // before settling the promise (the resolve may synchronously
        // enqueue more work through the Scheduler continuation path).
        if (slot.currentId === msg.id) {
          slot.currentId = null;
          const next = this.waiting.shift();
          if (next) this.dispatchTo(slot, next);
        }
        if (!pending) {
          log.warn(`unexpected result for id=${msg.id} (no pending entry)`);
          return;
        }
        this.inflight.delete(msg.id);
        if (msg.ok) {
          const outcome = asOutcome(msg.value);
          outcome.cpuUserUs = msg.cpuUserUs;
          outcome.cpuSystemUs = msg.cpuSystemUs;
          pending.resolve(outcome);
        } else {
          pending.reject(new TaskExecutionError(pending.taskName, new Error(msg.error)));
        }
        break;
      }
      case "shutdownComplete":
        slot.shutdownResolve?.();
        break;
    }
  }

  private rejectInflightForWorker(slot: WorkerSlot, err: Error): void {
    if (slot.currentId === null) return;
    const pending = this.inflight.get(slot.currentId);
    if (pending) {
      pending.reject(err);
      this.inflight.delete(slot.currentId);
    }
    slot.currentId = null;
  }

  private rejectAllInflight(err: Error): void {
    for (const [, p] of this.inflight) p.reject(err);
    this.inflight.clear();
    this.waiting.length = 0;
  }
}

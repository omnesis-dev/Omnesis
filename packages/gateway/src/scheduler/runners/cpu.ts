// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * CpuTaskRunner — pool of N pure-compute workers with no database
 * handle. Structural sibling of IoTaskRunner; the only difference
 * is the init message (no DB path) and the worker file
 * (`workers/cpu-worker.ts` instead of `workers/io-worker.ts`).
 *
 * Default concurrency: `max(1, availableParallelism() - 5)`, leaving
 * room for the main thread, writer, compute pool, and indexer.
 */

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { createLogger } from "@omnesis/core";
import { TaskExecutionError } from "../types.js";
import { DEFAULT_BACKGROUND_WORKER_NICE } from "../../workers/worker-priority.js";
import type { TaskRunner } from "../runner.js";
import type { Task, TaskContext, TaskOutcome } from "../types.js";
import type { CpuInit, CpuToMain, MainToCpu } from "../../workers/protocol.js";

const log = createLogger("gateway:scheduler:cpu");

export interface CpuTaskRunnerOptions {
  concurrency?: number;
  heartbeatIntervalMs?: number;
  heartbeatWarnGapMs?: number;
  workerUrl: URL;
  workerExecArgv?: string[];
  /** OS nice for the worker threads (resolved in runtime-settings). */
  backgroundWorkerNice?: number;
}

interface PendingExec {
  resolve: (outcome: TaskOutcome<unknown, unknown>) => void;
  reject: (err: Error) => void;
  taskName: string;
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
  worker: Worker;
  lastHeartbeat: number;
  heartbeatCheck: ReturnType<typeof setInterval> | null;
  shutdownResolve: (() => void) | null;
  unresponsiveSince: number | null;
}

export class CpuTaskRunner implements TaskRunner {
  public readonly kind = "cpu" as const;
  public readonly concurrency: number;

  private slots: WorkerSlot[] = [];
  private readyCount = 0;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private nextId = 1;
  private inflight = new Map<number, PendingExec>();
  private disposed = false;
  private readonly opts: Required<Omit<CpuTaskRunnerOptions, "concurrency">>;

  constructor(opts: CpuTaskRunnerOptions) {
    this.concurrency = opts.concurrency ?? Math.max(1, availableParallelism() - 5);
    this.opts = {
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 5_000,
      heartbeatWarnGapMs: opts.heartbeatWarnGapMs ?? 30_000,
      workerUrl: opts.workerUrl,
      workerExecArgv: opts.workerExecArgv ?? [],
      backgroundWorkerNice: opts.backgroundWorkerNice ?? DEFAULT_BACKGROUND_WORKER_NICE,
    };
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  async start(): Promise<void> {
    if (this.slots.length > 0) return this.readyPromise;

    for (let i = 0; i < this.concurrency; i++) {
      const worker = new Worker(this.opts.workerUrl, {
        execArgv: this.opts.workerExecArgv,
      });
      const slot: WorkerSlot = {
        worker,
        lastHeartbeat: 0,
        heartbeatCheck: null,
        shutdownResolve: null,
        unresponsiveSince: null,
      };

      worker.on("message", (msg: CpuToMain) => this.handleMessage(slot, msg));
      worker.on("error", (err) => {
        log.error(`cpu worker ${i} error: ${err.message ?? err}`);
        this.rejectInflightForWorker(slot, new Error(`cpu worker error: ${err.message ?? err}`));
        this.rejectReady(err);
      });
      worker.on("exit", (code) => {
        if (!this.disposed) {
          log.error(`cpu worker ${i} exited unexpectedly with code=${code}`);
        }
        this.rejectInflightForWorker(slot, new Error(`cpu worker exited code=${code}`));
        slot.shutdownResolve?.();
      });

      const init: CpuInit = {
        type: "init",
        heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
        backgroundWorkerNice: this.opts.backgroundWorkerNice,
      };
      worker.postMessage(init);

      slot.heartbeatCheck = setInterval(() => {
        if (!slot.lastHeartbeat) return;
        const gap = Date.now() - slot.lastHeartbeat;
        if (gap > this.opts.heartbeatWarnGapMs && slot.unresponsiveSince === null) {
          slot.unresponsiveSince = Date.now();
          log.warn(`cpu worker ${i} unresponsive (last heartbeat ${Math.round(gap / 1000)}s ago)`);
        }
      }, this.opts.heartbeatIntervalMs);
      slot.heartbeatCheck.unref?.();

      this.slots.push(slot);
    }

    log.info(`starting ${this.concurrency} cpu worker(s)`);
    await this.readyPromise;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const shutdowns = this.slots.map((slot, i) => {
      if (slot.heartbeatCheck) clearInterval(slot.heartbeatCheck);
      const p = new Promise<void>((resolve) => {
        slot.shutdownResolve = resolve;
      });
      slot.worker.postMessage({ type: "shutdown" } satisfies MainToCpu);
      const fallback = setTimeout(() => {
        log.warn(`cpu worker ${i} shutdown timed out — terminating`);
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
    this.rejectAllInflight(new Error("cpu workers shut down"));
  }

  async exec<TArgs, TResult>(
    task: Task<TArgs, TResult>,
    args: TArgs,
    _ctx: TaskContext,
  ): Promise<TaskOutcome<TArgs, TResult>> {
    if (this.disposed) {
      throw new Error("cpu task runner disposed");
    }
    const id = this.nextId++;
    const slotIndex = id % this.slots.length;
    const slot = this.slots[slotIndex];
    const enqueueMs = Date.now();
    const argsArray = Array.isArray(args) ? (args as unknown[]) : [args];
    return new Promise<TaskOutcome<TArgs, TResult>>((resolve, reject) => {
      this.inflight.set(id, {
        resolve: resolve as (o: TaskOutcome<unknown, unknown>) => void,
        reject,
        taskName: task.name,
      });
      slot.worker.postMessage({
        type: "call",
        id,
        op: task.name,
        args: argsArray,
        enqueueMs,
      } satisfies MainToCpu);
    });
  }

  // ────────────────────────────────────────────────────────────────────

  private handleMessage(slot: WorkerSlot, msg: CpuToMain): void {
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
          log.info(
            `cpu worker ${this.slots.indexOf(slot)} recovered after ${Math.round(blockedMs / 1000)}s`,
          );
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
    const workerIndex = this.slots.indexOf(slot);
    for (const [id, p] of this.inflight) {
      if (id % this.slots.length === workerIndex) {
        p.reject(err);
        this.inflight.delete(id);
      }
    }
  }

  private rejectAllInflight(err: Error): void {
    for (const [, p] of this.inflight) p.reject(err);
    this.inflight.clear();
  }
}

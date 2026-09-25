// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * WriterTaskRunner — adapts the existing writer worker (one writable
 * better-sqlite3 handle, runs in a Node worker_thread) to the
 * TaskRunner interface.
 *
 * Differences from legacy `WriterWorkerProxy`:
 *
 *   - **No queueing or batching here.** The Scheduler owns priority
 *     queues, anti-starvation, caps, and (later, in Phase 1A) batching.
 *     This runner just executes one task at a time.
 *
 *   - **No WriteGate methods here.** The typed sugar surface is
 *     re-implemented as a thin wrapper that calls
 *     `scheduler.enqueue(WriteOps[op], args)` instead of
 *     `proxy.upsertDocuments(...)`.
 *
 *   - **Args convention:** the existing writer worker's op dispatch
 *     table calls `handler(db, ...args)` with positional args. This
 *     runner forwards the Task's `args` as an array. Tasks whose
 *     `args` is a single non-array value get auto-wrapped to a one-
 *     element array (e.g. `enqueue(t, docs)` → worker receives [docs]).
 *
 *   - **TaskOutcome:** worker handlers return raw values today. This
 *     runner wraps the value as `{kind:"done", value}`. When we land
 *     yieldable ops in Phase 3, the worker handler can directly return
 *     `{kind:"yield", resume}` and this runner will pass it through
 *     unchanged (we detect the discriminator).
 *
 *   - **No internal heartbeat/checkpoint logic** — both stay in the
 *     existing writer-worker.ts unchanged. The runner just spawns the
 *     worker and forwards messages.
 *
 *   - **Preempt** — the runner attaches a SharedArrayBuffer to the
 *     worker via init message (when Scheduler enables preemption).
 *     Worker-side preempt support is added incrementally with each
 *     yieldable op; until then, signalPreempt() is a no-op-with-a-flag-
 *     set: the atomic flips, but no current op polls it.
 */

import { Worker } from "node:worker_threads";
import { createLogger } from "@omnesis/core";
import { TaskExecutionError } from "../types.js";
import type { TaskRunner } from "../runner.js";
import type { Task, TaskContext, TaskOutcome } from "../types.js";
import type { PreemptBuffer } from "../preempt.js";
import type { MainToWriter, WriterToMain, WriterInit } from "../../workers/protocol.js";

const log = createLogger("gateway:scheduler:writer");

export interface WriterTaskRunnerOptions {
  gatewayDbPath: string;
  gatewayDbKeyHex?: string;
  /** SQLite journal mode. Defaults to WAL. */
  journalMode?: "WAL" | "TRUNCATE";
  heartbeatIntervalMs?: number;
  heartbeatWarnGapMs?: number;
  /** URL of the worker entry. Required because tsx-loader stub lives elsewhere. */
  workerUrl: URL;
  /** Worker execArgv (e.g. tsx loader registration). */
  workerExecArgv?: string[];
  /**
   * Optional preempt buffer. If provided, the runner does NOT yet wire
   * it into the worker (deferred to Phase 3 when yieldable ops arrive).
   * Stored so signalPreempt can flip the flag.
   */
  preemptBuffer?: PreemptBuffer;
}

interface PendingExec {
  resolve: (outcome: TaskOutcome<unknown, unknown>) => void;
  reject: (err: Error) => void;
  taskName: string;
  /** When this op was handed to the worker — the age the watchdog reports. */
  dispatchedAtMs: number;
}

/**
 * Detect whether a worker-handler return value is already a
 * TaskOutcome (yield/done discriminator). Yieldable ops in Phase 3
 * will return `{kind: "yield", resume: ...}` directly; legacy ops
 * return raw values which we wrap as `{kind: "done", value}`.
 */
function asOutcome<TArgs, TResult>(raw: unknown): TaskOutcome<TArgs, TResult> {
  if (raw !== null && typeof raw === "object" && "kind" in (raw as object)) {
    const k = (raw as { kind: unknown }).kind;
    if (k === "done" || k === "yield") {
      return raw as TaskOutcome<TArgs, TResult>;
    }
  }
  return { kind: "done", value: raw as TResult };
}

export class WriterTaskRunner implements TaskRunner {
  public readonly kind = "writer" as const;
  public readonly concurrency = 1;

  private worker: Worker | null = null;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private nextId = 1;
  private inflight = new Map<number, PendingExec>();
  private heartbeatCheck: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private unresponsiveSince: number | null = null;
  private disposed = false;
  private shutdownResolve: (() => void) | null = null;
  /**
   * Shared atomic flag for cooperative preemption. Set by Scheduler
   * (via `attachPreemptBuffer`) when this runner is registered; passed
   * to the worker on init so worker-side ops can poll a `PreemptToken`
   * over the same memory.
   */
  private preemptBuffer: SharedArrayBuffer | null = null;
  private readonly opts: Required<
    Omit<WriterTaskRunnerOptions, "gatewayDbKeyHex" | "preemptBuffer">
  > & {
    gatewayDbKeyHex: string | undefined;
    preemptBuffer?: PreemptBuffer;
  };

  constructor(opts: WriterTaskRunnerOptions) {
    this.opts = {
      gatewayDbPath: opts.gatewayDbPath,
      gatewayDbKeyHex: opts.gatewayDbKeyHex,
      journalMode: opts.journalMode ?? "WAL",
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 5_000,
      heartbeatWarnGapMs: opts.heartbeatWarnGapMs ?? 30_000,
      workerUrl: opts.workerUrl,
      workerExecArgv: opts.workerExecArgv ?? [],
      preemptBuffer: opts.preemptBuffer,
    };
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  async start(): Promise<void> {
    if (this.worker) return this.ready;
    this.worker = new Worker(this.opts.workerUrl, {
      execArgv: this.opts.workerExecArgv,
    });
    this.worker.on("message", (msg: WriterToMain) => this.handleMessage(msg));
    this.worker.on("error", (err) => {
      log.error(`writer worker error: ${err.message ?? err}`);
      this.rejectAllInflight(new Error(`writer worker error: ${err.message ?? err}`));
      this.rejectReady(err);
    });
    this.worker.on("exit", (code) => {
      if (!this.disposed) {
        log.error(`writer worker exited unexpectedly with code=${code}`);
      }
      this.rejectAllInflight(new Error(`writer worker exited code=${code}`));
      if (this.shutdownResolve) this.shutdownResolve();
    });

    const init: WriterInit = {
      type: "init",
      gatewayDbPath: this.opts.gatewayDbPath,
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
      journalMode: this.opts.journalMode,
      preemptBuffer: this.preemptBuffer ?? undefined,
      ...(this.opts.gatewayDbKeyHex ? { gatewayDbKeyHex: this.opts.gatewayDbKeyHex } : {}),
    };
    this.post(init);

    // Heartbeat watchdog.
    this.heartbeatCheck = setInterval(() => {
      if (!this.lastHeartbeat) return;
      const gap = Date.now() - this.lastHeartbeat;
      if (gap > this.opts.heartbeatWarnGapMs && this.unresponsiveSince === null) {
        this.unresponsiveSince = Date.now();
        // Name what is holding the writer, not just that something is. The
        // op holding the write lock is the one fact this warning exists to
        // convey, and it is knowable here and now — the op's own slow-op
        // line only arrives when it finally finishes, which may be minutes
        // later.
        log.warn(
          `writer worker unresponsive (last heartbeat ${Math.round(gap / 1000)}s ago); ${this.describeInflight()}`,
        );
      }
    }, this.opts.heartbeatIntervalMs);
    this.heartbeatCheck.unref?.();

    await this.ready;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatCheck) clearInterval(this.heartbeatCheck);
    if (!this.worker) return;
    const shutdownPromise = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve;
    });
    this.post({ type: "shutdown" });
    const fallback = setTimeout(() => {
      log.warn("writer worker shutdown timed out — terminating");
      try {
        this.worker?.terminate();
      } catch {
        /* best-effort */
      }
      this.shutdownResolve?.();
    }, 5_000);
    fallback.unref?.();
    await shutdownPromise;
    clearTimeout(fallback);
    this.rejectAllInflight(new Error("writer worker shut down"));
  }

  signalPreempt(): void {
    // The Scheduler already sets the atomic via `state.preempt.requestYield()`
    // (same memory as our `preemptBuffer`). This hook exists for runners
    // that need an extra side-channel signal — we don't.
  }

  attachPreemptBuffer(buffer: SharedArrayBuffer): void {
    // Stored for forwarding to the worker on init. Calling after
    // `start()` would be too late (init has already shipped) — Scheduler
    // calls this synchronously inside registerRunner, before start().
    this.preemptBuffer = buffer;
  }

  async exec<TArgs, TResult>(
    task: Task<TArgs, TResult>,
    args: TArgs,
    _ctx: TaskContext,
  ): Promise<TaskOutcome<TArgs, TResult>> {
    if (this.disposed) {
      throw new Error("writer task runner disposed");
    }
    const id = this.nextId++;
    const enqueueMs = Date.now();
    // The legacy worker's op handlers receive positional args via
    // `handler(db, ...args)`. We forward the task's args as an array;
    // single-value Task args get wrapped.
    const argsArray = Array.isArray(args) ? (args as unknown[]) : [args];
    return new Promise<TaskOutcome<TArgs, TResult>>((resolve, reject) => {
      this.inflight.set(id, {
        resolve: resolve as (o: TaskOutcome<unknown, unknown>) => void,
        reject,
        taskName: task.name,
        dispatchedAtMs: enqueueMs,
      });
      this.post({
        type: "call",
        id,
        op: task.name,
        args: argsArray,
        enqueueMs,
      });
    });
  }

  // ────────────────────────────────────────────────────────────────────

  /** What the worker is executing, for the watchdog warning. */
  private describeInflight(): string {
    if (this.inflight.size === 0) return "nothing dispatched";
    const now = Date.now();
    const held = [...this.inflight.values()]
      .sort((a, b) => a.dispatchedAtMs - b.dispatchedAtMs)
      .map((p) => `${p.taskName} for ${Math.round((now - p.dispatchedAtMs) / 1000)}s`);
    return `holding: ${held.join(", ")}`;
  }

  private post(msg: MainToWriter): void {
    this.worker?.postMessage(msg);
  }

  private handleMessage(msg: WriterToMain): void {
    switch (msg.type) {
      case "ready":
        this.lastHeartbeat = Date.now();
        this.resolveReady();
        break;
      case "initError":
        this.rejectReady(new Error(msg.error));
        break;
      case "heartbeat":
        if (this.unresponsiveSince !== null) {
          const blockedMs = Date.now() - this.unresponsiveSince;
          log.info(`writer worker recovered after ${Math.round(blockedMs / 1000)}s`);
          this.unresponsiveSince = null;
        }
        this.lastHeartbeat = msg.ts;
        break;
      case "log":
        // Forward worker logs to our logger so they show up uniformly.
        // (The worker proxies log to main via {type:"log"} messages.)
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
          const cause = new Error(msg.errorMessage ?? msg.error);
          cause.name = msg.errorName ?? cause.name;
          cause.stack = msg.error;
          if (msg.errorCode !== undefined) {
            Object.defineProperty(cause, "code", {
              value: msg.errorCode,
              enumerable: true,
            });
          }
          pending.reject(new TaskExecutionError(pending.taskName, cause));
        }
        break;
      }
      case "shutdownComplete":
        this.shutdownResolve?.();
        break;
    }
  }

  private rejectAllInflight(err: Error): void {
    for (const [, p] of this.inflight) p.reject(err);
    this.inflight.clear();
  }
}

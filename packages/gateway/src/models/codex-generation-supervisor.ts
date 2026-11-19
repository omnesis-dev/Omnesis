// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Graceful admission, leasing, and replacement for Codex process generations. */

import { AsyncLocalStorage } from "node:async_hooks";
import { CodexGenerationCleanupError } from "./codex-runtime-cleanup.js";

import type {
  CodexAppServerRuntime,
  CodexRuntimePool,
  CodexRuntimeTurnOptions,
  CodexTurnRunner,
} from "@omnesis/agent";
import type { AgentEvent } from "@omnesis/core";
export { CodexGenerationCleanupError } from "./codex-runtime-cleanup.js";

export type CodexGenerationLane = "interactive" | "background" | "inference";

export interface CodexRuntimeGeneration {
  runtime: CodexAppServerRuntime;
  interactivePool: CodexRuntimePool | null;
  inferencePool?: CodexRuntimePool;
  backgroundPool?: CodexRuntimePool;
  nestedPools?: Map<number, CodexRuntimePool>;
  nestedPool?: (depth: number) => CodexRuntimePool;
}

const generationDisposals = new WeakMap<CodexRuntimeGeneration, Promise<void>>();

interface TurnLease {
  generation: CodexRuntimeGeneration;
  depth: number;
  active: boolean;
  release: () => void;
}

export function disposeCodexGeneration(generation: CodexRuntimeGeneration): Promise<void> {
  const existing = generationDisposals.get(generation);
  if (existing) return existing;
  const members = new Set([
    generation.runtime,
    generation.interactivePool,
    generation.inferencePool,
    generation.backgroundPool,
    ...(generation.nestedPools?.values() ?? []),
  ]);
  const disposal = Promise.allSettled(
    [...members].map((member) => Promise.resolve().then(() => member?.dispose())),
  ).then((results) => {
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw new CodexGenerationCleanupError(failed.reason);
  });
  generationDisposals.set(generation, disposal);
  return disposal;
}

export function reassertCodexGenerationAuth(generation: CodexRuntimeGeneration): void {
  generation.interactivePool?.reassertAuth();
  generation.inferencePool?.reassertAuth();
  generation.backgroundPool?.reassertAuth();
  for (const pool of generation.nestedPools?.values() ?? []) pool.reassertAuth();
}

export class CodexGenerationSupervisor {
  private readonly turnContext = new AsyncLocalStorage<TurnLease>();
  private generation: CodexRuntimeGeneration;
  private admissionClosed = false;
  private disposed = false;
  private active = 0;
  private exclusiveRequests = 0;
  private exclusiveTail: Promise<void> = Promise.resolve();
  private admissionWaiters: Array<() => void> = [];
  private drainWaiters: Array<() => void> = [];
  private cleanupFailure: CodexGenerationCleanupError | null = null;

  constructor(initial: CodexRuntimeGeneration) {
    this.generation = initial;
  }

  get current(): CodexRuntimeGeneration {
    return this.generation;
  }

  get activeUses(): number {
    return this.active;
  }

  get cleanupError(): CodexGenerationCleanupError | null {
    return this.cleanupFailure;
  }

  holdCleanup(error: CodexGenerationCleanupError): CodexGenerationCleanupError {
    this.cleanupFailure ??= error;
    this.admissionClosed = true;
    for (const wake of this.admissionWaiters.splice(0)) wake();
    for (const wake of this.drainWaiters.splice(0)) wake();
    return this.cleanupFailure;
  }

  async retire(generation: CodexRuntimeGeneration): Promise<void> {
    try {
      await disposeCodexGeneration(generation);
    } catch (error) {
      throw this.holdCleanup(
        error instanceof CodexGenerationCleanupError
          ? error
          : new CodexGenerationCleanupError(error),
      );
    }
  }

  runner(lane: CodexGenerationLane): CodexTurnRunner {
    return { runTurn: (opts) => this.runTurn(lane, opts) };
  }

  async use<T>(fn: (generation: CodexRuntimeGeneration) => Promise<T>): Promise<T> {
    const lease = await this.acquire();
    try {
      this.assertAvailable();
      return await fn(lease.generation);
    } finally {
      lease.release();
    }
  }

  async exclusive<T>(
    fn: (
      generation: CodexRuntimeGeneration,
      replace: (next: CodexRuntimeGeneration) => void,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.exclusiveTail;
    let releaseQueue!: () => void;
    this.exclusiveTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    this.exclusiveRequests += 1;
    this.admissionClosed = true;
    try {
      await abortable(previous, signal);
      if (this.cleanupFailure) throw this.cleanupFailure;
      if (this.disposed) throw new Error("Codex runtime service disposed");
      await abortable(this.waitForDrain(), signal);
      signal?.throwIfAborted();
      if (this.cleanupFailure) throw this.cleanupFailure;
      if (this.disposed) throw new Error("Codex runtime service disposed");
      return await fn(this.generation, (next) => {
        this.assertAvailable();
        this.generation = next;
      });
    } finally {
      this.exclusiveRequests -= 1;
      // An aborted middle waiter must remain in the queue until its
      // predecessor finishes; otherwise releasing its link lets a later
      // switch overlap the still-running predecessor.
      await previous;
      releaseQueue();
      if (!this.disposed && !this.cleanupFailure && this.exclusiveRequests === 0)
        this.openAdmission();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.admissionClosed = true;
    for (const wake of this.admissionWaiters.splice(0)) wake();
    for (const wake of this.drainWaiters.splice(0)) wake();
    await this.retire(this.generation);
    if (this.cleanupFailure) throw this.cleanupFailure;
  }

  private async *runTurn(
    lane: CodexGenerationLane,
    opts: CodexRuntimeTurnOptions,
  ): AsyncIterable<AgentEvent> {
    const parent = this.turnContext.getStore();
    const lease = await this.acquire(opts.signal, parent);
    try {
      opts.signal?.throwIfAborted();
      this.assertAvailable();
      const runner =
        lease.depth > 0
          ? lease.generation.nestedPool?.(lease.depth)
          : lane === "inference"
            ? lease.generation.inferencePool
            : lane === "background"
              ? (lease.generation.backgroundPool ?? lease.generation.runtime)
              : (lease.generation.interactivePool ?? lease.generation.runtime);
      if (!runner)
        throw new Error("Codex runtime has no capacity configured for this execution lane");
      // JSON-RPC callbacks arrive outside the generator's async context. Bind
      // each tool explicitly so nested model work retains its parent's lease.
      const input = {
        ...opts.input,
        tools: opts.input.tools.map((tool) => ({
          ...tool,
          invoke: (...args: Parameters<typeof tool.invoke>) =>
            this.turnContext.run(lease, () => tool.invoke(...args)),
        })),
      };
      yield* runner.runTurn({ ...opts, input });
    } finally {
      lease.release();
    }
  }

  private assertAvailable(): void {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.disposed) throw new Error("Codex runtime service disposed");
  }

  private async acquire(signal?: AbortSignal, parent?: TurnLease): Promise<TurnLease> {
    // Only descendants of a still-active turn may enter during a drain. They
    // must finish before that turn can release the generation being replaced.
    const inherited = parent?.active && parent.generation === this.generation;
    while (this.admissionClosed && !this.disposed && !this.cleanupFailure && !inherited) {
      signal?.throwIfAborted();
      let wake!: () => void;
      const waiting = new Promise<void>((resolve) => {
        wake = resolve;
        this.admissionWaiters.push(wake);
      });
      try {
        await abortable(waiting, signal);
      } finally {
        const index = this.admissionWaiters.indexOf(wake);
        if (index >= 0) this.admissionWaiters.splice(index, 1);
      }
    }
    signal?.throwIfAborted();
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.disposed) throw new Error("Codex runtime service disposed");
    this.active += 1;
    const lease: TurnLease = {
      generation: this.generation,
      depth: parent ? parent.depth + 1 : 0,
      active: true,
      release: () => {
        if (!lease.active) return;
        lease.active = false;
        this.active -= 1;
        if (this.active === 0) {
          for (const wake of this.drainWaiters.splice(0)) wake();
        }
      },
    };
    return lease;
  }

  private async waitForDrain(): Promise<void> {
    if (this.active === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private openAdmission(): void {
    this.admissionClosed = false;
    for (const wake of this.admissionWaiters.splice(0)) wake();
  }
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

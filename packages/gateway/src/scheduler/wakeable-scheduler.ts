// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `WakeableScheduler` — registry of `WakeableTask`s. Owns debounce
 * timers, in-flight tracking, trailing-wake coalescing. Routes each
 * fire back through the supplied `enqueue` callback so the actual
 * dispatch goes through `SchedulerCore`.
 *
 * Pulled out of the original 878-line `Scheduler` class.
 */

import { createLogger } from "@omnesis/core";
import type { Priority, Task, WakeableTask } from "./types.js";
import type { WakeableState } from "./internals.js";

const log = createLogger("gateway:scheduler");

export type WakeableEnqueue = <TArgs, TResult>(
  task: Task<TArgs, TResult>,
  args: TArgs,
  options?: { priority?: Priority },
) => Promise<TResult>;

export class WakeableScheduler {
  private readonly wakeables = new Map<string, WakeableState>();

  constructor(private readonly enqueue: WakeableEnqueue) {}

  /** Register a wakeable task. Returns a wake handle + stop function. */
  registerWakeable<TArgs, TResult>(
    task: WakeableTask<TArgs, TResult>,
  ): { wake(): void; stop(): void } {
    const state: WakeableState = {
      task: task as WakeableTask<unknown, unknown>,
      debounceTimer: null,
      inFlight: false,
      pendingTrailing: false,
      stopped: false,
    };
    this.wakeables.set(task.name, state);
    return {
      wake: () => this.wakeOne(state),
      stop: () => {
        state.stopped = true;
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        this.wakeables.delete(task.name);
      },
    };
  }

  /**
   * Wake a wakeable by name. Warns on unknown — pre-fix this silently
   * no-op'd, so a typo in `scheduler.wake("indexer.wake")` (e.g.
   * "indexer-wake" or "indexerWake") surfaced only as "indexer never
   * wakes on doc upsert" — invisible to logs and impossible to spot
   * without grepping. The warn is one-shot; callers that legitimately
   * fire-and-forget against an unregistered name should pass through
   * the registered handle from `registerWakeable` instead.
   */
  wake(taskName: string): void {
    const state = this.wakeables.get(taskName);
    if (state) {
      this.wakeOne(state);
      return;
    }
    log.warn(
      `Scheduler.wake("${taskName}") — no wakeable registered with that name (registered: [${Array.from(this.wakeables.keys()).join(", ")}])`,
    );
  }

  /** Stop every registered wakeable. Idempotent. */
  stopAll(): void {
    for (const w of this.wakeables.values()) {
      w.stopped = true;
      if (w.debounceTimer) clearTimeout(w.debounceTimer);
    }
  }

  /** Find the task definition by name (used by the metrics snapshot). */
  findTaskDefinition(name: string): Task<unknown, unknown> | null {
    const w = this.wakeables.get(name);
    return w ? w.task : null;
  }

  private wakeOne(state: WakeableState): void {
    if (state.stopped) return;
    if (state.inFlight) {
      if (state.task.coalesceTrailingWake !== false) {
        state.pendingTrailing = true;
      }
      return;
    }
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      this.fireWakeable(state);
    }, state.task.debounceMs);
    state.debounceTimer.unref?.();
  }

  private fireWakeable(state: WakeableState): void {
    if (state.stopped) return;
    state.inFlight = true;
    this.enqueue(state.task, state.task.initialArgs).then(
      () => this.completeWakeable(state),
      (err) => {
        log.warn(`wakeable "${state.task.name}" rejected: ${err.message ?? err}`);
        this.completeWakeable(state);
      },
    );
  }

  private completeWakeable(state: WakeableState): void {
    state.inFlight = false;
    if (state.pendingTrailing && !state.stopped) {
      state.pendingTrailing = false;
      this.fireWakeable(state);
    }
  }
}

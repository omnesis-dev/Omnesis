// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `PeriodicScheduler` — registry of `PeriodicTask`s. Owns the timer
 * setup, the idle/active duty cycle, and the post-tick re-arm. Routes
 * each tick back through the supplied `enqueue` callback so the actual
 * dispatch goes through `SchedulerCore`.
 *
 * Pulled out of the original 878-line `Scheduler` class.
 */

import { createLogger } from "@omnesis/core";
import { runOutsidePriority } from "../priority.js";
import type { PeriodicTask, Priority, Task } from "./types.js";
import type { PeriodicState } from "./internals.js";

const log = createLogger("gateway:scheduler");

export type PeriodicEnqueue = <TArgs, TResult>(
  task: Task<TArgs, TResult>,
  args: TArgs,
  options?: { priority?: Priority },
) => Promise<TResult>;

export class PeriodicScheduler {
  private readonly periodics: PeriodicState[] = [];

  constructor(private readonly enqueue: PeriodicEnqueue) {}

  /**
   * Register a periodic task. Task names must be unique: `kick()`
   * routes by name to the first match, so a same-name re-registration
   * would be shadowed by the earlier entry. Warned, not supported.
   */
  schedule<TArgs, TResult>(
    task: PeriodicTask<TArgs, TResult>,
    schedulerStarted: boolean,
  ): { stop(): void } {
    if (this.periodics.some((p) => p.task.name === task.name && !p.stopped)) {
      log.warn(
        `periodic "${task.name}" registered more than once — kick() only reaches the first registration`,
      );
    }
    const state: PeriodicState = {
      task: task as PeriodicTask<unknown, unknown>,
      currentArgs: task.initialArgs,
      timer: null,
      inFlight: false,
      kickPending: false,
      completedTicks: 0,
      waiters: [],
      stopped: false,
    };
    this.periodics.push(state);
    if (schedulerStarted) {
      this.armPeriodic(state, task.startDelayMs ?? 0);
    }
    return {
      stop: () => {
        state.stopped = true;
        if (state.timer) clearTimeout(state.timer);
        this.rejectWaiters(state, new Error(`periodic "${state.task.name}" stopped`));
      },
    };
  }

  /**
   * Arm every registered periodic — called by the façade right after
   * the core's runners have started. Periodics registered before
   * `start()` are kicked off here; later registrations arm themselves
   * inline via `schedule()`.
   */
  startAll(): void {
    for (const p of this.periodics) {
      this.armPeriodic(p, p.task.startDelayMs ?? 0);
    }
  }

  /** Stop every registered periodic. Idempotent. */
  stopAll(): void {
    for (const p of this.periodics) {
      p.stopped = true;
      if (p.timer) clearTimeout(p.timer);
      this.rejectWaiters(p, new Error(`periodic "${p.task.name}" stopped`));
    }
  }

  /** Find the task definition by name (used by the metrics snapshot). */
  findTaskDefinition(name: string): Task<unknown, unknown> | null {
    for (const p of this.periodics) {
      if (p.task.name === name) return p.task;
    }
    return null;
  }

  /**
   * Fire a periodic's next tick now instead of waiting out its current
   * period (typically the idle backoff). If a tick is already in
   * flight, exactly one trailing tick fires when it completes — the
   * task never overlaps itself, so periodics that keep cross-tick
   * cursor state (sweepAccumulateTask) are safe to kick. After a
   * kicked tick the normal idle/active re-arm resumes.
   *
   * Kicks before the periodic is armed (pre-`start()`) are dropped:
   * the start-delay tick is about to run anyway.
   */
  kick(taskName: string): void {
    const state = this.periodics.find((p) => p.task.name === taskName && !p.stopped);
    if (!state) {
      log.warn(
        `Scheduler.kickPeriodic("${taskName}") — no live periodic registered with that name (registered: [${this.periodics.map((p) => p.task.name).join(", ")}])`,
      );
      return;
    }
    if (state.inFlight) {
      state.kickPending = true;
      return;
    }
    if (!state.timer) return;
    clearTimeout(state.timer);
    this.armPeriodic(state, 0);
  }

  /**
   * Kick a periodic and await the exact generation caused by this call.
   * When a tick is already running, the promise targets the guaranteed
   * coalesced trailing tick rather than accidentally accepting the old one.
   */
  kickAndWait(taskName: string, timeoutMs = 120_000): Promise<unknown> {
    const state = this.periodics.find((p) => p.task.name === taskName && !p.stopped);
    if (!state) return Promise.reject(new Error(`no live periodic registered as "${taskName}"`));
    if (!state.timer && !state.inFlight) {
      return Promise.reject(new Error(`periodic "${taskName}" is not armed`));
    }
    const targetGeneration = state.completedTicks + (state.inFlight ? 2 : 1);
    const promise = new Promise<unknown>((resolve, reject) => {
      const waiter = {
        targetGeneration,
        resolve,
        reject,
        timeout: setTimeout(() => {
          state.waiters = state.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`periodic "${taskName}" did not complete within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      waiter.timeout.unref?.();
      state.waiters.push(waiter);
    });
    this.kick(taskName);
    return promise;
  }

  private armPeriodic(state: PeriodicState, delayMs: number): void {
    if (state.stopped) return;
    // Arm from a clean priority context. A timer captures the ambient
    // context of whoever armed it, so arming inside a caller's scope — a
    // user request calling `kick()`, or the continuation of a tick that was
    // itself armed that way — hands that caller's priority to this task
    // forever, one re-arm at a time. Leaving the context here keeps a kick
    // meaning "run sooner" instead of "run as me, from now on".
    runOutsidePriority(() => {
      state.timer = setTimeout(() => this.tickPeriodic(state), delayMs);
      state.timer.unref?.();
    });
  }

  private tickPeriodic(state: PeriodicState): void {
    if (state.stopped) return;
    state.timer = null;
    state.inFlight = true;
    const rearm = (delayMs: number) => {
      state.inFlight = false;
      const kicked = state.kickPending;
      state.kickPending = false;
      this.armPeriodic(state, kicked ? 0 : delayMs);
    };
    // Say the priority out loud rather than letting it be inferred: a
    // periodic tick is the task's own cadence and always runs at the
    // priority the task declared. A caller that genuinely wants this work
    // done at its own priority enqueues the task directly with one.
    this.enqueue(state.task, state.currentArgs, { priority: state.task.priority }).then(
      (result) => {
        if (state.stopped) return;
        this.completeGeneration(state, { ok: true, result });
        const isIdle = state.task.isIdle?.(result) ?? false;
        const asked = state.task.nextDelayMs?.(result);
        rearm(
          asked ??
            (isIdle ? (state.task.idlePeriodMs ?? state.task.periodMs) : state.task.periodMs),
        );
      },
      (err) => {
        if (state.stopped) return;
        this.completeGeneration(state, { ok: false, error: err });
        log.warn(`periodic "${state.task.name}" rejected: ${err.message ?? err}`);
        // Back off on error using idlePeriodMs, defaulting to periodMs.
        rearm(state.task.idlePeriodMs ?? state.task.periodMs);
      },
    );
  }

  private completeGeneration(
    state: PeriodicState,
    outcome: { ok: true; result: unknown } | { ok: false; error: unknown },
  ): void {
    state.completedTicks += 1;
    const settled = state.waiters.filter((w) => w.targetGeneration <= state.completedTicks);
    state.waiters = state.waiters.filter((w) => w.targetGeneration > state.completedTicks);
    for (const waiter of settled) {
      clearTimeout(waiter.timeout);
      if (outcome.ok) waiter.resolve(outcome.result);
      else waiter.reject(outcome.error);
    }
  }

  private rejectWaiters(state: PeriodicState, error: Error): void {
    const waiters = state.waiters;
    state.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which scheduled task is currently executing, for the work it dispatches.
 *
 * One slow unit of work produces two log lines: the io or writer op that
 * was slow, and the task that was waiting on it. Read as independent
 * incidents they double every count, so a handful of sweeps reads as a
 * flood of warnings roughly twice their true number. Knowing which task
 * dispatched an op lets the line say so, and a reader can then tell a slow
 * root operation from its slow child.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

/** Run `fn` with `taskName` as the dispatching task for anything it enqueues. */
export function runAsTask<T>(taskName: string, fn: () => T): T {
  return store.run(taskName, fn);
}

/** The task that dispatched the current work, or null at the top level. */
export function getDispatchingTask(): string | null {
  return store.getStore() ?? null;
}

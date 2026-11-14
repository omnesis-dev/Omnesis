// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Orphan reaper for E2E-harness subprocesses.
 *
 * The harnesses spawn the gateway with `detached: true` so they can kill the
 * whole gateway subprocess tree with a single process-group signal
 * (`process.kill(-pid)`). That cleanup runs in the harness's `stop()`. But if
 * the test runner is terminated *before* `stop()` runs — e.g. `timeout`
 * wrapping `npm run test:e2e` sends SIGTERM to the runner, or the developer
 * hits Ctrl-C — the detached gateway has no one to kill it and **leaks**: it
 * keeps running (and holding ~1 GB + its DB) forever.
 *
 * This module installs process-level handlers (once per process) that reap
 * every still-registered process group when the runner exits or is signalled.
 * Node does NOT run `exit` handlers when the process dies from an unhandled
 * fatal signal, so the SIGTERM/SIGINT/SIGHUP handlers are load-bearing — the
 * `exit` handler alone would miss the `timeout` case the leak came from.
 */

import { requestChildShutdown, WindowsProcessTree } from "@omnesis/core";
import { waitForWindowsTreeExit } from "./windows-tree-drain.js";
import type { ChildProcess } from "node:child_process";

/** Process-group leader PIDs of detached children still expected to be alive. */
const liveGroups = new Set<number>();
const windowsGroups = new Map<
  number,
  { proc: ChildProcess; tree: WindowsProcessTree; timer?: NodeJS.Timeout }
>();
let installed = false;

/** Best-effort: SIGKILL every registered process group, then forget them. */
function reapAll(): void {
  for (const pid of liveGroups) {
    try {
      if (process.platform === "win32") {
        windowsGroups.get(pid)?.tree.killSync();
        continue;
      }
      // Negative pid → signal the whole process group (the detached tree).
      process.kill(-pid, "SIGKILL");
    } catch {
      /* group already gone */
    }
  }
  liveGroups.clear();
  for (const { timer } of windowsGroups.values()) clearTimeout(timer);
  windowsGroups.clear();
}

function installHandlers(): void {
  if (installed) return;
  installed = true;

  // Synchronous final sweep for normal exit / process.exit().
  process.on("exit", reapAll);

  // Fatal signals: reap, then re-raise with our handler removed so the
  // default action (or any other handler, e.g. vitest's) still terminates
  // the runner. Without this, a handled signal would leave the process
  // running and the reap pointless.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const handler = (): void => {
      reapAll();
      process.removeListener(sig, handler);
      process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
}

/**
 * Track a detached child's process group so it is reaped if the runner dies
 * before the harness kills it. Auto-untracks only when the leader's exit
 * leaves no surviving member of the process group.
 */
export function registerSubprocessGroup(proc: ChildProcess): Promise<void> {
  installHandlers();
  const pid = proc.pid;
  if (typeof pid !== "number") return Promise.resolve();
  liveGroups.add(pid);
  proc.once("exit", () => reapAfterLeaderExit(proc, pid));
  if (process.platform === "win32") {
    const record = {
      proc,
      tree: new WindowsProcessTree(pid, {
        rootIsAlive: () => proc.exitCode === null && proc.signalCode === null,
      }),
      timer: undefined as NodeJS.Timeout | undefined,
    };
    windowsGroups.set(pid, record);
    const watch = (): void => {
      if (windowsGroups.get(pid) !== record) return;
      record.timer = setTimeout(() => {
        const work =
          proc.exitCode !== null || proc.signalCode !== null
            ? record.tree.kill()
            : record.tree.refresh();
        void work
          .then(() => {
            if (!record.tree.alive && (proc.exitCode !== null || proc.signalCode !== null))
              unregisterSubprocessGroup(proc);
          })
          .catch(() => {})
          .finally(watch);
      }, 500);
      record.timer.unref();
    };
    const ready = record.tree.refresh();
    // Callers that await registration receive failures. An ignored registration
    // still retains ownership, and teardown retries the snapshot before acting.
    void ready.catch(() => {}).finally(watch);
    return ready;
  }
  return Promise.resolve();
}

/** Stop tracking a group the harness has already killed (idempotent). */
export function unregisterSubprocessGroup(proc: ChildProcess): void {
  if (typeof proc.pid !== "number") return;
  const record = windowsGroups.get(proc.pid);
  if (record && record.proc !== proc) return;
  if (record) {
    clearTimeout(record.timer);
    windowsGroups.delete(proc.pid);
  }
  liveGroups.delete(proc.pid);
}

/** Signal a detached child's whole tree, falling back to the group leader alone. */
function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (typeof proc.pid === "number") {
      // Negative pid → the whole detached gateway subprocess tree.
      process.kill(-proc.pid, signal);
    } else {
      proc.kill(signal);
    }
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Whether any member of the detached process group is still alive. */
function subprocessGroupAlive(proc: ChildProcess): boolean {
  if (process.platform === "win32" || typeof proc.pid !== "number") {
    return proc.exitCode === null && proc.signalCode === null;
  }
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A detached leader must never leave an unowned descendant behind. Reap any
 * survivor immediately, then keep a non-blocking watcher until the numeric
 * process-group id is definitely absent so it cannot go stale in liveGroups.
 */
function reapAfterLeaderExit(proc: ChildProcess, pid: number): void {
  if (process.platform === "win32") {
    const record = windowsGroups.get(pid);
    if (!record || record.proc !== proc) return;
    void record.tree
      .kill()
      .then(() => {
        if (!record.tree.alive) unregisterSubprocessGroup(proc);
      })
      .catch(() => {
        // Keep failed cleanup registered; normal teardown or the exit sweep retries.
      });
    return;
  }
  if (!subprocessGroupAlive(proc)) {
    liveGroups.delete(pid);
    return;
  }
  signalGroup(proc, "SIGKILL");
  const watch = (): void => {
    if (!subprocessGroupAlive(proc)) {
      liveGroups.delete(pid);
      return;
    }
    const timer = setTimeout(watch, 25);
    timer.unref();
  };
  watch();
}

/** Resolve true only when the whole process group disappears within `ms`. */
async function groupGoneWithin(proc: ChildProcess, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (subprocessGroupAlive(proc)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
  return true;
}

const terminations = new WeakMap<ChildProcess, Promise<void>>();

/**
 * Terminate a detached child's process group, escalating if it does not go.
 *
 * Two properties are load-bearing:
 *
 * 1. The group stays *registered* until every member is confirmed dead. A caller
 *    whose hook times out mid-teardown then still leaves a tracked group for
 *    the exit/signal reaper to sweep. Untracking first and awaiting an exit
 *    that never arrives would disarm the very net this module provides.
 * 2. The wait is bounded and escalates to SIGKILL. A child blocked in a long
 *    native call may never run the requested graceful-stop handler, so an
 *    unbounded wait would hang the hook until the runner's timeout killed it —
 *    stranding the child.
 * Concurrent lifecycle owners join the same cleanup and retain its ownership fence.
 */
export function killSubprocessGroup(
  proc: ChildProcess,
  opts: { initialSignal?: NodeJS.Signals; termGraceMs?: number; killGraceMs?: number } = {},
): Promise<void> {
  const existing = terminations.get(proc);
  if (existing) return existing;
  const pending = Promise.resolve().then(() => terminateSubprocessGroup(proc, opts));
  terminations.set(proc, pending);
  void pending
    .finally(() => {
      if (terminations.get(proc) === pending) terminations.delete(proc);
    })
    .catch(() => {});
  return pending;
}

async function terminateSubprocessGroup(
  proc: ChildProcess,
  opts: { initialSignal?: NodeJS.Signals; termGraceMs?: number; killGraceMs?: number } = {},
): Promise<void> {
  const initialSignal = opts.initialSignal ?? "SIGTERM";
  const termGraceMs = opts.termGraceMs ?? 5_000;
  const killGraceMs = opts.killGraceMs ?? 2_000;
  if (process.platform === "win32" && typeof proc.pid === "number") {
    if (
      !windowsGroups.has(proc.pid) &&
      !liveGroups.has(proc.pid) &&
      (proc.exitCode !== null || proc.signalCode !== null)
    )
      return;
    if (!windowsGroups.has(proc.pid)) await registerSubprocessGroup(proc);
    const record = windowsGroups.get(proc.pid)!;
    const goneWithin = (ms: number): Promise<boolean> =>
      waitForWindowsTreeExit(
        record.tree,
        () => proc.exitCode !== null || proc.signalCode !== null,
        ms,
      );
    if (
      initialSignal !== "SIGKILL" &&
      (await requestChildShutdown(proc)) &&
      (await goneWithin(termGraceMs))
    ) {
      unregisterSubprocessGroup(proc);
      return;
    }
    await record.tree.kill();
    if (await goneWithin(killGraceMs)) {
      unregisterSubprocessGroup(proc);
      return;
    }
    throw new Error(`subprocess group ${proc.pid} survived ${initialSignal} and SIGKILL`);
  }
  if (!subprocessGroupAlive(proc)) {
    unregisterSubprocessGroup(proc);
    return;
  }
  signalGroup(proc, initialSignal);
  if (await groupGoneWithin(proc, termGraceMs)) {
    unregisterSubprocessGroup(proc);
    return;
  }
  signalGroup(proc, "SIGKILL");
  if (await groupGoneWithin(proc, killGraceMs)) {
    unregisterSubprocessGroup(proc);
    return;
  }
  throw new Error(
    `subprocess group ${proc.pid ?? "with no pid"} survived ${initialSignal} and SIGKILL`,
  );
}

/** Test-only: force a reap of all registered groups. */
export function reapAllForTest(): void {
  reapAll();
}

/** Test-only: how many groups are currently tracked. */
export function liveGroupCountForTest(): number {
  return liveGroups.size;
}

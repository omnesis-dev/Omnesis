// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Exit when the process that spawned us disappears.
 *
 * A gateway spawned by a test harness or dev script must not outlive its
 * spawner. Orderly teardown covers the cases where somebody gets to send a
 * signal; this covers the case where nobody can. A runner killed with SIGKILL
 * (kernel OOM, CI job cancellation) runs no handler and sends nothing, and
 * because harnesses spawn the gateway detached — in its own process group, so
 * teardown can signal the whole `npx → tsx → node` tree at once — no
 * terminal or group signal reaches us either. We are reparented to the init
 * process (or a subreaper such as `systemd --user`) and live forever holding
 * ~1.5 GiB. SIGKILL cannot be caught on the parent's behalf, so the only
 * defence available to the child is to watch the parent and leave when it goes.
 *
 * The spawner passes its own pid explicitly rather than us reading
 * `process.ppid`: under the `npx → tsx → node` layering our direct parent is
 * tsx, not the runner whose death actually matters.
 */

export interface ParentWatchdogOptions {
  /** Pid to watch. Values <= 1 disable the watchdog (1 is init, never a spawner). */
  parentPid: number;
  /** Poll period. */
  intervalMs?: number;
  /** Called when the parent is gone. Defaults to exiting the process. */
  onParentGone?: () => void;
}

/** True iff `pid` is still alive. */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 probes liveness without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Start watching `parentPid`. Returns a stop function, or null when the
 * watchdog is not applicable (no/!invalid parent pid).
 */
export function startParentWatchdog(opts: ParentWatchdogOptions): (() => void) | null {
  const { parentPid, intervalMs = 2_000 } = opts;
  if (!Number.isInteger(parentPid) || parentPid <= 1) return null;
  const onParentGone = opts.onParentGone ?? ((): void => process.exit(0));

  const timer = setInterval(() => {
    if (isAlive(parentPid)) return;
    clearInterval(timer);
    onParentGone();
  }, intervalMs);
  // Never hold the event loop open on the watchdog's account.
  timer.unref?.();

  return () => clearInterval(timer);
}

/**
 * Wire the watchdog from the environment. Returns a stop function, or null if
 * `OMNESIS_PARENT_PID` is unset — i.e. for a normally-managed gateway, where
 * the service supervisor owns the lifecycle and this must stay inert.
 */
export function startParentWatchdogFromEnv(
  env: NodeJS.ProcessEnv,
  onParentGone?: () => void,
): (() => void) | null {
  const raw = env.OMNESIS_PARENT_PID;
  if (!raw) return null;
  const parentPid = Number(raw);
  if (!Number.isInteger(parentPid)) return null;
  return startParentWatchdog({ parentPid, onParentGone });
}

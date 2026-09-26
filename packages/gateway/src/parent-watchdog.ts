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

export interface LauncherWatchdogOptions {
  env: NodeJS.ProcessEnv;
  /** Our parent when we started: the launcher the service manager ran. */
  launcherPid: number;
  /** Our parent now. Injected by tests; defaults to `process.ppid`. */
  currentParentPid?: () => number;
  intervalMs?: number;
  /** Called once when the launcher is gone. */
  onLauncherGone: () => void;
}

/**
 * Leave when the launcher a service manager started us under goes away.
 *
 * A source install's service runs `tsx`, which runs the gateway as its child:
 * launchd tracks tsx, not us. Should tsx die while we live, launchd counts the
 * job as exited and starts a replacement, which waits on our config-dir lock,
 * gives up, and is restarted again, for as long as we run. Every restart the
 * operator or `omnesis update` asks for reaches only the replacement; this
 * process keeps the lock and keeps serving the old build. Reparented, we are no
 * longer the service's gateway, so we stop and let the replacement take over.
 *
 * Only for a service-managed gateway (the unit sets OMNESIS_SERVICE_MANAGER)
 * that did not start as the manager's own child: a gateway the manager runs
 * directly has pid 1 or the manager as its parent for life, and a gateway run
 * by hand has no service to hand over to.
 */
export function startLauncherWatchdog(opts: LauncherWatchdogOptions): (() => void) | null {
  const { env, launcherPid, intervalMs = 2_000, onLauncherGone } = opts;
  if (!env.OMNESIS_SERVICE_MANAGER) return null;
  if (!Number.isInteger(launcherPid) || launcherPid <= 1) return null;
  const currentParentPid = opts.currentParentPid ?? ((): number => process.ppid);

  const timer = setInterval(() => {
    if (currentParentPid() === launcherPid) return;
    clearInterval(timer);
    onLauncherGone();
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}

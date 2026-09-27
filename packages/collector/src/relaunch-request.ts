// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A request a dying collector leaves behind for its service manager to start
 * it again.
 *
 * A LaunchAgent's `KeepAlive { SuccessfulExit: false }` is not a promise that
 * launchd respawns the job. While the user's GUI domain is in launchd's
 * on-demand-only mode, launchd records the respawn of a job that failed
 * ("pending spawn, domain in on-demand-only mode") and performs it only when
 * something demands the job — which nothing does — so a collector that crashed
 * or was killed by its watchdog stays down until someone starts it by hand.
 * An explicit `launchctl kickstart` is such a demand and is honoured in every
 * mode.
 *
 * The request is a detached shell, in its own session so launchd's clean-up
 * of the dead job's process group leaves it alone, that waits out the
 * LaunchAgent's throttle interval and then runs `launchctl kickstart` without
 * `-k`. When launchd has already respawned the job by then, the kickstart
 * finds it running and does nothing; when a start fails again, the next
 * request is another throttle interval away, so a collector that cannot start
 * retries no faster than launchd itself would.
 *
 * systemd needs no request: `Restart=on-failure` restarts the unit on any
 * non-zero exit or fatal signal, and a request spawned from the unit would
 * sit in its control group and be killed with it anyway.
 *
 * Free of any Omnesis import so the watchdog's worker thread can load it.
 */

import { spawn } from "node:child_process";

/** A command that, once spawned, starts the collector's unit again later. */
export interface RelaunchRequest {
  command: string;
  args: string[];
  /** What the request will do, for the log line that records it. */
  description: string;
}

/**
 * Spawn the request so it outlives this process. Synchronous — the child has
 * been created when this returns — so it may run from a process `exit`
 * listener or right before the process kills itself. Returns the reason the
 * request could not be left, or null.
 */
export function leaveRelaunchRequest(request: RelaunchRequest): string | null {
  try {
    const child = spawn(request.command, request.args, { detached: true, stdio: "ignore" });
    // A failed spawn reports asynchronously; there may be no event loop left
    // to deliver it, and there is nothing further to do about it if there is.
    child.on("error", () => {});
    child.unref();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

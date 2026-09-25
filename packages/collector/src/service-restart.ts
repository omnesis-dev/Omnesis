// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How a collector that has just installed an update gets back onto the new
 * build.
 *
 * Exiting non-zero and leaving the respawn to the service manager is not
 * enough on its own: launchd can record the pending respawn of a `KeepAlive`
 * job and never perform it, which leaves the collector down with nothing to
 * say so. So when this process is the main process of an Omnesis collector
 * unit, it asks that unit's manager for a restart outright — the same request
 * `omnesis service restart collector` makes — and the manager stops this
 * process and starts the new build itself.
 *
 * The request has to outlive the process it restarts:
 *
 *   - launchd: `launchctl kickstart -k gui/<uid>/<label>` kills the running
 *     job and starts it again inside launchd, so there is no window between
 *     an exit and a respawn. `launchctl` is spawned in its own process group,
 *     because launchd kills whatever is left of the job's group when the job
 *     stops.
 *   - systemd: `systemctl --user --no-block restart <unit>` returns once the
 *     restart job is queued in the user manager, before the stop that job
 *     performs reaches this unit's control group — which the `systemctl`
 *     child belongs to whatever its process group.
 *
 * A restart is only requested for a unit this process demonstrably runs as.
 * The environment is a hint that is inherited by anything started from the
 * unit (and, for `INVOCATION_ID`, by a terminal launched as a user service),
 * so the manager is asked which process the unit runs and that must be this
 * one or its parent — the parent being the `tsx` runner a source install's
 * unit executes. A collector started by hand, in a container, or under a unit
 * whose name is not an Omnesis collector's is never turned into a service:
 * it exits non-zero as before, which is what `KeepAlive` and `Restart=` act
 * on wherever a supervisor exists.
 */

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createLogger, launchdLabelInstance, systemdUnitInstance } from "@omnesis/core";

const log = createLogger("collector").child("service-restart");

/** A service unit this process was proven to run as. */
export type CollectorServiceUnit =
  | { manager: "launchd"; label: string; target: string }
  | { manager: "systemd"; unit: string };

/** The host facts the decision reads, injectable for tests. */
export interface ServiceHost {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  pid: number;
  ppid: number;
  /** Absent where the platform has no uids. */
  uid: number | undefined;
  /** The contents of `/proc/self/cgroup`, or null when it cannot be read. */
  readCgroup(): string | null;
  /** Run a read-only query to completion. Never throws on a non-zero exit. */
  query(command: string, args: string[]): Promise<{ code: number; stdout: string }>;
  spawn: typeof spawn;
}

export function defaultServiceHost(): ServiceHost {
  return {
    env: process.env,
    platform: process.platform,
    pid: process.pid,
    ppid: process.ppid,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    readCgroup: () => {
      try {
        return readFileSync("/proc/self/cgroup", "utf8");
      } catch {
        return null;
      }
    },
    query: (command, args) =>
      new Promise((resolve) => {
        execFile(command, args, { encoding: "utf8", timeout: 10_000 }, (err, stdout) => {
          resolve({ code: err ? 1 : 0, stdout: stdout ?? "" });
        });
      }),
    spawn,
  };
}

/**
 * The collector unit this process runs as, or the reason it runs as none.
 */
export async function resolveCollectorUnit(
  host: ServiceHost,
): Promise<{ unit: CollectorServiceUnit } | { reason: string }> {
  const ours = (pid: number | null): boolean => pid === host.pid || pid === host.ppid;

  if (host.platform === "darwin") {
    const label = host.env.XPC_SERVICE_NAME ?? "";
    if (!launchdLabelInstance("collector", label)) {
      return { reason: "not started by launchd as an Omnesis collector" };
    }
    if (host.uid === undefined) return { reason: "no user id to address launchd's GUI domain" };
    const target = `gui/${host.uid}/${label}`;
    const printed = await host.query("launchctl", ["print", target]);
    if (printed.code !== 0) return { reason: `launchd does not list ${target}` };
    const pidLine = /^\s*pid = (\d+)$/m.exec(printed.stdout);
    const pid = pidLine ? Number.parseInt(pidLine[1], 10) : null;
    if (!ours(pid)) return { reason: `${target} is not running this process` };
    return { unit: { manager: "launchd", label, target } };
  }

  if (host.platform === "linux") {
    if (!host.env.INVOCATION_ID) return { reason: "not started by systemd" };
    const unit = cgroupUnit(host.readCgroup());
    if (!unit || !systemdUnitInstance("collector", unit)) {
      return { reason: "not running in an Omnesis collector unit" };
    }
    const shown = await host.query("systemctl", [
      "--user",
      "show",
      "--property=MainPID",
      "--value",
      unit,
    ]);
    const pid = shown.code === 0 ? Number.parseInt(shown.stdout.trim(), 10) : Number.NaN;
    if (!ours(Number.isNaN(pid) ? null : pid)) {
      return { reason: `the user manager's ${unit} is not running this process` };
    }
    return { unit: { manager: "systemd", unit } };
  }

  return { reason: `no service manager this collector restarts through on ${host.platform}` };
}

/**
 * The unit whose control group this process sits in: the last component of
 * the cgroup path, when it is a service. A process in a login session or a
 * container's root group has no such component.
 */
function cgroupUnit(cgroup: string | null): string | null {
  if (!cgroup) return null;
  for (const line of cgroup.split("\n")) {
    // `0::<path>` on the unified hierarchy; `N:name=systemd:<path>` on a hybrid one.
    const match = /^\d+:(?:name=systemd)?:(\/.*)$/.exec(line.trim());
    if (!match) continue;
    const last = match[1].split("/").pop() ?? "";
    if (last.endsWith(".service")) return last;
  }
  return null;
}

/** The request that restarts `unit`, and whether it must leave this process group. */
export function restartInvocation(unit: CollectorServiceUnit): {
  command: string;
  args: string[];
  detached: boolean;
} {
  if (unit.manager === "launchd") {
    return { command: "launchctl", args: ["kickstart", "-k", unit.target], detached: true };
  }
  return {
    command: "systemctl",
    args: ["--user", "--no-block", "restart", unit.unit],
    detached: false,
  };
}

/** Spawn the restart request and settle once the manager has accepted it. */
function requestRestart(unit: CollectorServiceUnit, host: ServiceHost): Promise<void> {
  const invocation = restartInvocation(unit);
  return new Promise<void>((resolve, reject) => {
    const child = host.spawn(invocation.command, invocation.args, {
      stdio: "ignore",
      detached: invocation.detached,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${invocation.command} exited ${code ?? signal ?? "with no code"}`));
    });
    if (invocation.detached) child.unref();
  });
}

/**
 * How long a collector that asked for its restart waits to be stopped before
 * it exits on its own. A manager that accepts the request stops the process
 * within moments; this only bounds a request that hangs, or is accepted and
 * never carried out, so the collector is not left running the old build.
 */
export const RESTART_REQUEST_GRACE_MS = 60_000;

export interface ServiceHandOverDeps {
  /** Leave the process for the service manager to bring back: flush, then exit non-zero. */
  exit(): void;
  /** Whether the process is already shutting down, e.g. on the manager's SIGTERM. */
  isShuttingDown(): boolean;
  host?: ServiceHost;
  graceMs?: number;
}

/**
 * The self-update hand-over: restart through the collector's own unit when
 * this process runs as one, otherwise exit for whatever supervises it.
 * Settles once the path is chosen and, on the restart path, the manager has
 * accepted the request or refused it.
 */
export async function handOverToServiceManager(deps: ServiceHandOverDeps): Promise<void> {
  const host = deps.host ?? defaultServiceHost();
  let resolved: Awaited<ReturnType<typeof resolveCollectorUnit>>;
  try {
    resolved = await resolveCollectorUnit(host);
  } catch (err) {
    resolved = { reason: err instanceof Error ? err.message : String(err) };
  }
  if ("reason" in resolved) {
    log.info(
      `Updated — ${resolved.reason}; exiting so the service manager restarts this collector`,
    );
    deps.exit();
    return;
  }
  const { unit } = resolved;
  const name = unit.manager === "launchd" ? unit.target : unit.unit;
  // Logged and armed before the request is awaited: `launchctl kickstart -k`
  // may not return before launchd has already stopped this process.
  log.info(`Updated — asking ${unit.manager} to restart ${name} on the new build`);
  const grace = setTimeout(() => {
    if (deps.isShuttingDown()) return;
    log.warn(`${unit.manager} has not restarted ${name}; exiting`);
    deps.exit();
  }, deps.graceMs ?? RESTART_REQUEST_GRACE_MS);
  // The restart stops this process; the timer must not keep a finished shutdown alive.
  grace.unref();
  try {
    await requestRestart(unit, host);
  } catch (err) {
    clearTimeout(grace);
    log.warn(
      `Could not ask ${unit.manager} to restart ${name} (${err instanceof Error ? err.message : String(err)}); exiting so the service manager restarts this collector`,
    );
    deps.exit();
  }
}

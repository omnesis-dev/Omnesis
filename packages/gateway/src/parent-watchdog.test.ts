// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  startLauncherWatchdog,
  startParentWatchdog,
  startParentWatchdogFromEnv,
} from "./parent-watchdog.js";

/** A real, killable process to stand in for a spawning runner. */
function spawnIdleProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

async function waitFor(pred: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

describe("parent-watchdog", () => {
  const stops: Array<() => void> = [];
  const procs: ChildProcess[] = [];

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    for (const proc of procs.splice(0)) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("fires once the watched process dies", async () => {
    const parent = spawnIdleProcess();
    procs.push(parent);
    let fired = false;
    const stop = startParentWatchdog({
      parentPid: parent.pid!,
      intervalMs: 20,
      onParentGone: () => {
        fired = true;
      },
    });
    expect(stop).not.toBeNull();
    stops.push(stop!);

    // Alive: must stay quiet. A watchdog that fires on a live parent would
    // kill every legitimately-running gateway.
    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBe(false);

    parent.kill("SIGKILL");
    expect(await waitFor(() => fired)).toBe(true);
  });

  it("does not fire while the parent is alive", async () => {
    const parent = spawnIdleProcess();
    procs.push(parent);
    let fired = false;
    const stop = startParentWatchdog({
      parentPid: parent.pid!,
      intervalMs: 10,
      onParentGone: () => {
        fired = true;
      },
    });
    stops.push(stop!);
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBe(false);
  });

  it("stops firing after the returned stop function is called", async () => {
    const parent = spawnIdleProcess();
    procs.push(parent);
    let fired = false;
    const stop = startParentWatchdog({
      parentPid: parent.pid!,
      intervalMs: 10,
      onParentGone: () => {
        fired = true;
      },
    });
    stop!();
    parent.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 150));
    expect(fired).toBe(false);
  });

  it.each([
    ["pid 1 (init is never a spawner)", 1],
    ["pid 0", 0],
    ["a negative pid", -5],
    ["a non-integer pid", 1.5],
  ])("declines to watch %s", (_label, pid) => {
    expect(startParentWatchdog({ parentPid: pid as number, intervalMs: 10 })).toBeNull();
  });

  describe("startParentWatchdogFromEnv", () => {
    it("stays inert when OMNESIS_PARENT_PID is unset", () => {
      // The service-managed gateway must never self-exit: its supervisor owns
      // the lifecycle and there is no spawner pid to watch.
      expect(startParentWatchdogFromEnv({})).toBeNull();
    });

    it("stays inert when OMNESIS_PARENT_PID is not a number", () => {
      expect(startParentWatchdogFromEnv({ OMNESIS_PARENT_PID: "nonsense" })).toBeNull();
    });

    it("watches the pid from the environment", async () => {
      const parent = spawnIdleProcess();
      procs.push(parent);
      let fired = false;
      const stop = startParentWatchdogFromEnv({ OMNESIS_PARENT_PID: String(parent.pid) }, () => {
        fired = true;
      });
      expect(stop).not.toBeNull();
      stops.push(stop!);
      parent.kill("SIGKILL");
      expect(await waitFor(() => fired, 5_000)).toBe(true);
    });
  });
});

describe("startLauncherWatchdog", () => {
  const SERVICE_ENV = { OMNESIS_SERVICE_MANAGER: "launchd-user" };

  it("fires once we are reparented away from the launcher", async () => {
    let parent = 4242;
    let fired = 0;
    const stop = startLauncherWatchdog({
      env: SERVICE_ENV,
      launcherPid: 4242,
      currentParentPid: () => parent,
      intervalMs: 10,
      onLauncherGone: () => {
        fired += 1;
      },
    });
    expect(stop).not.toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(0);
    // tsx died; the kernel handed us to launchd.
    parent = 1;
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(1);
    stop!();
  });

  it("stays inert for a gateway nobody supervises", () => {
    // Run by hand: there is no replacement to hand the config dir to.
    expect(
      startLauncherWatchdog({ env: {}, launcherPid: 4242, onLauncherGone: () => {} }),
    ).toBeNull();
  });

  it("stays inert for a gateway the service manager runs directly", () => {
    // A packaged install: launchd itself (pid 1) is the parent for life.
    expect(
      startLauncherWatchdog({ env: SERVICE_ENV, launcherPid: 1, onLauncherGone: () => {} }),
    ).toBeNull();
  });
});

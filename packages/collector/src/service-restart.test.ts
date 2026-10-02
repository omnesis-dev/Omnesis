// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  handOverToServiceManager,
  relaunchGuardFor,
  resolveCollectorUnit,
  restartInvocation,
  startRelaunchGuard,
  type ServiceHost,
} from "./service-restart.js";

interface SpawnCall {
  command: string;
  args: string[];
  options: { stdio?: unknown; detached?: boolean };
}

/** A spawn whose children exit with `code`, or fail to start when `code` is an Error. */
function fakeSpawn(outcome: number | Error | "hang" = 0): {
  spawn: typeof spawn;
  calls: SpawnCall[];
  unrefs: number;
} {
  const calls: SpawnCall[] = [];
  const state = { unrefs: 0 };
  const fn = ((command: string, args: string[], options: SpawnCall["options"]) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & { unref(): void };
    child.unref = () => {
      state.unrefs += 1;
    };
    if (outcome !== "hang") {
      queueMicrotask(() => {
        if (outcome instanceof Error) child.emit("error", outcome);
        else child.emit("exit", outcome, null);
      });
    }
    return child;
  }) as unknown as typeof spawn;
  return {
    spawn: fn,
    calls,
    get unrefs() {
      return state.unrefs;
    },
  };
}

const LAUNCHD_PRINT = (pid: number): string =>
  `gui/501/dev.omnesis.collector = {\n\tactive count = 1\n\tstate = running\n\tpid = ${pid}\n}\n`;

function launchdHost(overrides: Partial<ServiceHost> = {}): ServiceHost {
  return {
    env: { XPC_SERVICE_NAME: "dev.omnesis.collector" },
    platform: "darwin",
    pid: 4242,
    ppid: 4241,
    uid: 501,
    readCgroup: () => null,
    query: vi.fn(() => Promise.resolve({ code: 0, stdout: LAUNCHD_PRINT(4241) })),
    spawn: fakeSpawn().spawn,
    ...overrides,
  };
}

const COLLECTOR_CGROUP = "0::/user.slice/user-1000.slice/app.slice/omnesis-collector.service\n";

function systemdHost(overrides: Partial<ServiceHost> = {}): ServiceHost {
  return {
    env: { INVOCATION_ID: "0123456789abcdef" },
    platform: "linux",
    pid: 7000,
    ppid: 6999,
    uid: 1000,
    readCgroup: () => COLLECTOR_CGROUP,
    query: vi.fn(() => Promise.resolve({ code: 0, stdout: "7000\n" })),
    spawn: fakeSpawn().spawn,
    ...overrides,
  };
}

describe("resolveCollectorUnit", () => {
  test("a launchd collector job whose pid is this process's runner is that unit", async () => {
    const host = launchdHost();
    expect(await resolveCollectorUnit(host)).toEqual({
      unit: {
        manager: "launchd",
        label: "dev.omnesis.collector",
        target: "gui/501/dev.omnesis.collector",
        pid: 4241,
      },
    });
    expect(host.query).toHaveBeenCalledWith("launchctl", [
      "print",
      "gui/501/dev.omnesis.collector",
    ]);
  });

  test("a named launchd instance keeps its own label", async () => {
    const host = launchdHost({
      env: { XPC_SERVICE_NAME: "dev.omnesis.collector.staging" },
      query: vi.fn(() => Promise.resolve({ code: 0, stdout: LAUNCHD_PRINT(4242) })),
    });
    expect(await resolveCollectorUnit(host)).toMatchObject({
      unit: { target: "gui/501/dev.omnesis.collector.staging" },
    });
  });

  test("a terminal or another job's label never reaches launchctl", async () => {
    for (const env of [
      {},
      { XPC_SERVICE_NAME: "0" },
      { XPC_SERVICE_NAME: "dev.omnesis.gateway" },
    ]) {
      const host = launchdHost({ env });
      expect(await resolveCollectorUnit(host)).toHaveProperty("reason");
      expect(host.query).not.toHaveBeenCalled();
    }
  });

  test("an inherited launchd label is refused when the job runs another process", async () => {
    const host = launchdHost({
      query: vi.fn(() => Promise.resolve({ code: 0, stdout: LAUNCHD_PRINT(99) })),
    });
    expect(await resolveCollectorUnit(host)).toEqual({
      reason: "gui/501/dev.omnesis.collector is not running this process",
    });
  });

  test("a label launchd does not list is refused", async () => {
    const host = launchdHost({ query: vi.fn(() => Promise.resolve({ code: 113, stdout: "" })) });
    expect(await resolveCollectorUnit(host)).toHaveProperty("reason");
  });

  test("a systemd collector unit whose MainPID is this process is that unit", async () => {
    const host = systemdHost();
    expect(await resolveCollectorUnit(host)).toEqual({
      unit: { manager: "systemd", unit: "omnesis-collector.service" },
    });
    expect(host.query).toHaveBeenCalledWith("systemctl", [
      "--user",
      "show",
      "--property=MainPID",
      "--value",
      "omnesis-collector.service",
    ]);
  });

  test("a named systemd instance on a hybrid hierarchy is found from its cgroup", async () => {
    const host = systemdHost({
      readCgroup: () =>
        "12:cpuset:/\n1:name=systemd:/user.slice/user-1000.slice/app.slice/omnesis-collector-staging.service\n",
      query: vi.fn(() => Promise.resolve({ code: 0, stdout: "6999\n" })),
    });
    expect(await resolveCollectorUnit(host)).toEqual({
      unit: { manager: "systemd", unit: "omnesis-collector-staging.service" },
    });
  });

  test("an INVOCATION_ID leaked into a terminal is not a collector unit", async () => {
    const host = systemdHost({
      readCgroup: () => "0::/user.slice/user-1000.slice/app.slice/app-terminal-1234.scope\n",
    });
    expect(await resolveCollectorUnit(host)).toEqual({
      reason: "not running in an Omnesis collector unit",
    });
    expect(host.query).not.toHaveBeenCalled();
  });

  test("a container, a hand-started run and a system-manager unit are refused", async () => {
    expect(await resolveCollectorUnit(systemdHost({ readCgroup: () => "0::/\n" }))).toHaveProperty(
      "reason",
    );
    expect(await resolveCollectorUnit(systemdHost({ env: {} }))).toEqual({
      reason: "not started by systemd",
    });
    // The user manager reports no main process for a unit it does not run.
    const systemUnit = systemdHost({
      readCgroup: () => "0::/system.slice/omnesis-collector.service\n",
      query: vi.fn(() => Promise.resolve({ code: 0, stdout: "0\n" })),
    });
    expect(await resolveCollectorUnit(systemUnit)).toHaveProperty("reason");
  });

  test("a platform with no supported service manager is refused", async () => {
    expect(await resolveCollectorUnit(systemdHost({ platform: "win32" }))).toHaveProperty("reason");
  });
});

describe("restartInvocation", () => {
  test("launchd kickstarts the job from its own process group; systemd queues a restart", () => {
    expect(
      restartInvocation({
        manager: "launchd",
        label: "dev.omnesis.collector",
        target: "gui/501/dev.omnesis.collector",
        pid: 4241,
      }),
    ).toEqual({
      command: "launchctl",
      args: ["kickstart", "-k", "gui/501/dev.omnesis.collector"],
      detached: true,
    });
    expect(restartInvocation({ manager: "systemd", unit: "omnesis-collector.service" })).toEqual({
      command: "systemctl",
      args: ["--user", "--no-block", "restart", "omnesis-collector.service"],
      detached: false,
    });
  });
});

describe("handOverToServiceManager", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("under launchd it spawns a detached kickstart of its own label and does not exit", async () => {
    vi.useFakeTimers();
    const spawned = fakeSpawn(0);
    const exit = vi.fn();
    await handOverToServiceManager({
      host: launchdHost({ spawn: spawned.spawn }),
      exit,
      isShuttingDown: () => true,
    });
    expect(spawned.calls).toEqual([
      {
        command: "launchctl",
        args: ["kickstart", "-k", "gui/501/dev.omnesis.collector"],
        options: { stdio: "ignore", detached: true },
      },
    ]);
    expect(spawned.unrefs).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    // The manager's SIGTERM started the shutdown, so the grace timer stands down.
    await vi.runAllTimersAsync();
    expect(exit).not.toHaveBeenCalled();
  });

  test("under systemd it queues a restart of its own unit", async () => {
    const spawned = fakeSpawn(0);
    const exit = vi.fn();
    await handOverToServiceManager({
      host: systemdHost({ spawn: spawned.spawn }),
      exit,
      isShuttingDown: () => false,
    });
    expect(spawned.calls).toEqual([
      {
        command: "systemctl",
        args: ["--user", "--no-block", "restart", "omnesis-collector.service"],
        options: { stdio: "ignore", detached: false },
      },
    ]);
    expect(exit).not.toHaveBeenCalled();
  });

  test("a hand-started collector exits without spawning anything", async () => {
    const spawned = fakeSpawn(0);
    const exit = vi.fn();
    await handOverToServiceManager({
      host: launchdHost({ env: {}, spawn: spawned.spawn }),
      exit,
      isShuttingDown: () => false,
    });
    expect(spawned.calls).toEqual([]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test("a restart request that cannot start falls back to the exit", async () => {
    const exit = vi.fn();
    await handOverToServiceManager({
      host: launchdHost({ spawn: fakeSpawn(new Error("spawn launchctl ENOENT")).spawn }),
      exit,
      isShuttingDown: () => false,
    });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test("a refused restart request falls back to the exit", async () => {
    const exit = vi.fn();
    await handOverToServiceManager({
      host: systemdHost({ spawn: fakeSpawn(1).spawn }),
      exit,
      isShuttingDown: () => false,
    });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test("a failing unit query falls back to the exit", async () => {
    const exit = vi.fn();
    await handOverToServiceManager({
      host: systemdHost({
        query: vi.fn(() => Promise.reject(new Error("query failed"))),
      }),
      exit,
      isShuttingDown: () => false,
    });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test("a restart that never stops the collector ends in the exit after the grace period", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const handOver = handOverToServiceManager({
      host: launchdHost({ spawn: fakeSpawn("hang").spawn }),
      exit,
      isShuttingDown: () => false,
      graceMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    void handOver;
  });
});

describe("the relaunch guard", () => {
  let dir: string | null = null;
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const UNIT = {
    manager: "launchd" as const,
    label: "dev.omnesis.collector",
    target: "gui/501/dev.omnesis.collector",
    pid: 4241,
  };

  /** `launchctl print` output for a job that is not running, as launchd writes it. */
  const ENDED = (lastExit: string): string =>
    `gui/501/dev.omnesis.collector = {\n\tactive count = 0\n\tstate = not running\n\truns = 1\n\t${lastExit}\n\tendpoints = {\n\t\t"x" = {\n\t\t\tstate = running\n\t\t}\n\t}\n}\n`;

  /**
   * Run the real guard against a process that is then killed, with a
   * stand-in `launchctl` whose `print` answers `print` (or fails when null)
   * and that records every call. Resolves with the recorded calls and the
   * guard's stderr once the guard has exited.
   */
  async function guard(print: string | null): Promise<{ calls: string[]; stderr: string }> {
    dir = mkdtempSync(join(tmpdir(), "omnesis-relaunch-guard-test-"));
    const record = join(dir, "launchctl.calls");
    writeFileSync(join(dir, "print"), print ?? "");
    writeFileSync(
      join(dir, "launchctl"),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(record)}\n` +
        `if [ "$1" = print ]; then ${print === null ? "exit 113" : `cat ${JSON.stringify(join(dir, "print"))}`}; fi\n`,
    );
    chmodSync(join(dir, "launchctl"), 0o755);

    const job = spawnProcess("sleep", ["30"], { stdio: "ignore" });
    children.push(job);
    const spec = relaunchGuardFor({ ...UNIT, pid: job.pid ?? 0 }, 0);
    const run = spawnProcess(spec.command, spec.args, {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(run);
    let stderr = "";
    run.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<void>((resolve) => run.once("exit", () => resolve()));

    // The guard waits for as long as the job's process lives.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(run.exitCode).toBeNull();
    expect(existsSync(record)).toBe(false);

    job.kill("SIGKILL");
    await exited;
    const calls = existsSync(record) ? readFileSync(record, "utf8").trim().split("\n") : [];
    return { calls, stderr };
  }

  test("a job killed outright is started again, without -k, and the guard says why", async () => {
    const { calls, stderr } = await guard(ENDED("last terminating signal = Killed: 9"));
    expect(calls).toEqual([
      "print gui/501/dev.omnesis.collector",
      "kickstart gui/501/dev.omnesis.collector",
    ]);
    expect(stderr).toMatch(
      /INFO {2}\[collector:relaunch-guard\] gui\/501\/dev\.omnesis\.collector ended without a clean exit/,
    );
  }, 30_000);

  test("a job that exited non-zero is started again", async () => {
    const { calls } = await guard(ENDED("last exit code = 1"));
    expect(calls.at(-1)).toBe("kickstart gui/501/dev.omnesis.collector");
  }, 30_000);

  test("a clean exit is a deliberate stop and stays stopped", async () => {
    const { calls } = await guard(ENDED("last exit code = 0"));
    expect(calls).toEqual(["print gui/501/dev.omnesis.collector"]);
  }, 30_000);

  test("a job that was booted out stays unloaded", async () => {
    const { calls } = await guard(null);
    expect(calls).toEqual(["print gui/501/dev.omnesis.collector"]);
  }, 30_000);

  test("a job launchd or a restart already started again is left alone", async () => {
    const { calls } = await guard(LAUNCHD_PRINT(9999));
    expect(calls).toEqual(["print gui/501/dev.omnesis.collector"]);
  }, 30_000);

  test("waits out the throttle interval and watches the job's own process", () => {
    const spec = relaunchGuardFor(UNIT);
    expect(spec.command).toBe("/bin/sh");
    expect(spec.args.slice(3)).toEqual(["4241", "gui/501/dev.omnesis.collector", "10"]);
  });

  test("is started detached beside a launchd unit this process demonstrably runs as; systemd needs none", async () => {
    const spawned = fakeSpawn("hang");
    await startRelaunchGuard(launchdHost({ spawn: spawned.spawn }));
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0].args.slice(3)).toEqual(["4241", "gui/501/dev.omnesis.collector", "10"]);
    expect(spawned.calls[0].options).toMatchObject({ detached: true });
    expect(spawned.unrefs).toBe(1);

    for (const host of [
      launchdHost({ query: vi.fn(() => Promise.resolve({ code: 0, stdout: LAUNCHD_PRINT(9) })) }),
      launchdHost({ env: { XPC_SERVICE_NAME: "0" } }),
      launchdHost({ query: vi.fn(() => Promise.reject(new Error("launchctl vanished"))) }),
      systemdHost(),
    ]) {
      const none = fakeSpawn("hang");
      await startRelaunchGuard({ ...host, spawn: none.spawn });
      expect(none.calls).toEqual([]);
    }
  });
});

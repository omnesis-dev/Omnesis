// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn as spawnProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  handOverToServiceManager,
  relaunchRequestFor,
  resolveCollectorUnit,
  resolveRelaunchRequest,
  restartInvocation,
  type ServiceHost,
} from "./service-restart.js";
import type { spawn } from "node:child_process";

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

describe("relaunch requests", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });
  const tempDir = (): string => (dir = mkdtempSync(join(tmpdir(), "omnesis-relaunch-test-")));

  /** Poll for a file a detached process writes. */
  async function waitForFile(path: string, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(path)) {
      if (Date.now() > deadline) throw new Error(`${path} never appeared`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return readFileSync(path, "utf8");
  }

  test("under launchd the request kickstarts the job's own target, without -k, after the delay", () => {
    const request = relaunchRequestFor({
      manager: "launchd",
      label: "dev.omnesis.collector",
      target: "gui/501/dev.omnesis.collector",
    });
    expect(request?.args).toContain("10");

    // Run the real request against a stand-in `launchctl` that records its arguments.
    const bin = tempDir();
    const record = join(bin, "launchctl.args");
    writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "$@" > ${JSON.stringify(record)}\n`);
    chmodSync(join(bin, "launchctl"), 0o755);
    const quick = relaunchRequestFor(
      {
        manager: "launchd",
        label: "dev.omnesis.collector",
        target: "gui/501/dev.omnesis.collector",
      },
      0,
    );
    if (!quick) throw new Error("expected a launchd relaunch request");
    const run = spawnSync(quick.command, quick.args, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(run.status).toBe(0);
    expect(readFileSync(record, "utf8").trim()).toBe("kickstart gui/501/dev.omnesis.collector");
  });

  test("systemd restarts a failed unit itself, so it gets no request", () => {
    expect(
      relaunchRequestFor({ manager: "systemd", unit: "omnesis-collector.service" }),
    ).toBeNull();
  });

  test("the request is resolved from the unit this process demonstrably runs as", async () => {
    const request = await resolveRelaunchRequest(launchdHost());
    expect(request?.args.at(-1)).toBe("gui/501/dev.omnesis.collector");
    expect(
      await resolveRelaunchRequest(
        launchdHost({ query: vi.fn(() => Promise.resolve({ code: 0, stdout: LAUNCHD_PRINT(9) })) }),
      ),
    ).toBeNull();
    expect(
      await resolveRelaunchRequest(launchdHost({ env: { XPC_SERVICE_NAME: "0" } })),
    ).toBeNull();
    expect(
      await resolveRelaunchRequest(
        launchdHost({ query: vi.fn(() => Promise.reject(new Error("launchctl vanished"))) }),
      ),
    ).toBeNull();
  });

  /**
   * Run a real process that arms `relaunchOnFailedExit` with a request that
   * writes a marker after the process is gone, then exits with `code`.
   */
  async function exitWith(code: number): Promise<{ marker: string; exitedBefore: boolean }> {
    const work = tempDir();
    const marker = join(work, "relaunched");
    const module = fileURLToPath(new URL("./service-restart.ts", import.meta.url));
    const script = join(work, "child.ts");
    writeFileSync(
      script,
      `import { relaunchOnFailedExit } from ${JSON.stringify(module)};\n` +
        `relaunchOnFailedExit({ command: "/bin/sh", args: ["-c", 'sleep 0.5; echo relaunched > "$1"', "relaunch-test", ${JSON.stringify(marker)}], description: "test relaunch" });\n` +
        `setTimeout(() => process.exit(${code}), 100);\n`,
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawnProcess(process.execPath, ["--import", "tsx", script], {
        stdio: "ignore",
        env: { ...process.env, OMNESIS_LOG_FILE: "" },
      });
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    return { marker, exitedBefore: !existsSync(marker) };
  }

  test("a failed exit leaves the request behind, and it outlives the process", async () => {
    const { marker, exitedBefore } = await exitWith(1);
    expect(exitedBefore).toBe(true);
    expect((await waitForFile(marker)).trim()).toBe("relaunched");
  }, 30_000);

  test("a clean exit is a deliberate stop and leaves nothing", async () => {
    const { marker } = await exitWith(0);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});

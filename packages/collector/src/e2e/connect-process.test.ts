// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  spawnConnect,
  terminateConnect,
  waitForExit,
  type SpawnedConnect,
} from "./connect-process.js";

import * as reaper from "./subprocess-reaper.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture did not write ${path}`);
}

describe("spawned connect process cleanup", () => {
  const roots: string[] = [];
  const runningProcesses: SpawnedConnect[] = [];

  afterEach(async () => {
    const results = await Promise.allSettled(runningProcesses.splice(0).map(terminateConnect));
    vi.restoreAllMocks();
    if (results.some((result) => result.status === "rejected")) {
      // A failed ownership proof retains every fixture rather than deleting live inputs.
      await Promise.all(
        results.map(async (result) => {
          if (result.status === "rejected") return Promise.reject(result.reason);
        }),
      );
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(program: string): { root: string; running: SpawnedConnect } {
    const root = mkdtempSync(join(tmpdir(), "omnesis-connect literal-"));
    roots.push(root);
    const cliDir = join(root, "packages", "cli", "src");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, "index.ts"), program);
    const running = spawnConnect({
      repositoryRoot: root,
      args: ["literal space", "quote'\"", "&$;", "雪"],
      fakeBin: join(root, "bin"),
      cliConfigDir: join(root, "config"),
    });
    runningProcesses.push(running);
    return { root, running };
  }

  test("waits for registration and captures literal argv and final UTF-8 output", async () => {
    let registered!: () => void;
    const registration = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const original = reaper.registerSubprocessGroup;
    vi.spyOn(reaper, "registerSubprocessGroup").mockImplementationOnce((child) => {
      void original(child);
      return registration;
    });
    const { running } = fixture("process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    let settled = false;
    const result = waitForExit(running, 10_000).finally(() => {
      settled = true;
    });
    try {
      await expect
        .poll(() => running.output.join("").includes("雪"), { timeout: 10_000 })
        .toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      registered();
    }
    expect(await result).toEqual({
      code: 0,
      output: JSON.stringify(["connect", "literal space", "quote'\"", "&$;", "雪"]),
    });
  }, 20_000);

  test.each([undefined, new Error("fixed unconfirmed registration")])(
    "retains explicit registration uncertainty after physical cleanup (%s)",
    async (receipt) => {
      let rejectRegistration!: (error: unknown) => void;
      const registration = new Promise<void>((_resolve, reject) => {
        rejectRegistration = reject;
      });
      void registration.catch(() => {});
      const original = reaper.registerSubprocessGroup;
      vi.spyOn(reaper, "registerSubprocessGroup").mockImplementationOnce((child) => {
        void original(child);
        return registration;
      });
      const { running } = fixture('process.stdout.write("finished");');
      await new Promise<void>((resolve) => running.child.once("close", () => resolve()));
      await reaper.killSubprocessGroup(running.child);
      const error = Object.assign(new Error("fixed registration failure"), {
        cleanupFailure: receipt,
      });
      rejectRegistration(error);
      await expect(waitForExit(running, 10_000)).rejects.toHaveProperty("cleanupFailure");
      await expect(terminateConnect(running)).rejects.toHaveProperty("cleanupFailure");
      // The artificial marker is injected only after this real fixture was joined.
      runningProcesses.splice(runningProcesses.indexOf(running), 1);
    },
    20_000,
  );

  test("termination kills a harness installer left behind by the CLI leader", async () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-connect-process-"));
    roots.push(root);
    const cliDir = join(root, "packages", "cli", "src");
    const fakeBin = join(root, "bin");
    const configDir = join(root, "config");
    const descendantPidPath = join(root, "descendant.pid");
    for (const directory of [cliDir, fakeBin, configDir]) {
      mkdirSync(directory, { recursive: true });
    }
    const descendantProgram = [
      "process.on('SIGINT', () => {});",
      "process.on('SIGTERM', () => {});",
      "console.log('READY');",
      "setInterval(() => {}, 1000);",
    ].join("");
    writeFileSync(
      join(cliDir, "index.ts"),
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantProgram)}], { stdio: ["ignore", "pipe", "ignore"] });`,
        'child.stdout!.once("data", () => writeFileSync(process.env.DESCENDANT_PID_PATH!, String(child.pid)));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const running = spawnConnect({
      repositoryRoot: root,
      args: ["hermes"],
      fakeBin,
      cliConfigDir: configDir,
      env: {
        PATH: process.env.PATH,
        DESCENDANT_PID_PATH: descendantPidPath,
      },
      inheritEnv: false,
    });
    runningProcesses.push(running);
    await waitForFile(descendantPidPath, 10_000);
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    expect(isAlive(descendantPid)).toBe(true);

    await terminateConnect(running);

    expect(isAlive(running.child.pid!)).toBe(false);
    // Group teardown waits for signalable members. An orphan can momentarily
    // remain observable by PID while its exit is being reaped by the OS.
    // Require actual PID disappearance, with the same bounded observation
    // used by the subprocess-reaper descendant tests.
    await expect.poll(() => isAlive(descendantPid), { timeout: 3_000, interval: 25 }).toBe(false);
  }, 20_000);
});

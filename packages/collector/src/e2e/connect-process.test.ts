// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { spawnConnect, terminateConnect } from "./connect-process.js";

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
  const groups: number[] = [];

  afterEach(() => {
    for (const pid of groups.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

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
    groups.push(running.child.pid!);
    await waitForFile(descendantPidPath, 10_000);
    const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    expect(isAlive(descendantPid)).toBe(true);

    await terminateConnect(running);

    expect(isAlive(running.child.pid!)).toBe(false);
    expect(isAlive(descendantPid)).toBe(false);
  }, 20_000);
});

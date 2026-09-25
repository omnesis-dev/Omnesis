// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Driving `omnesis connect` as a real child process.
 *
 * Connect is a long interactive ceremony — it redeems a pairing code, then
 * blocks waiting for somebody to approve an OAuth request in the portal — so a
 * test has to start it, do the approving, and only then wait for it to finish.
 * That shape is shared by every suite that exercises the managed integration,
 * and so is the discipline around it: capture output so a failure can say what
 * the command printed, and never leave a child behind.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, join } from "node:path";

import { e2eTsxCommand } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";

export interface SpawnedConnect {
  child: ChildProcess;
  output: string[];
  spawnError: Error | null;
  exitResult: { code: number | null; signal: NodeJS.Signals | null } | null;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface SpawnConnectOptions {
  repositoryRoot: string;
  /** Command-line arguments after `connect`, e.g. the harness and its flags. */
  args: readonly string[];
  /** Prepended to PATH, so a fake `hermes` or `xdg-open` wins over a real one. */
  fakeBin: string;
  /** Isolated `OMNESIS_CONFIG_DIR` — never the operator's. */
  cliConfigDir: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  /**
   * Start from an empty environment instead of the test runner's. Real-host
   * conformance uses this so ambient harness profiles and model credentials
   * cannot influence the child. PATH and every required runtime value must be
   * supplied through `env` when this is false.
   */
  inheritEnv?: boolean;
}

export function spawnConnect(options: SpawnConnectOptions): SpawnedConnect {
  const command = e2eTsxCommand(join(options.repositoryRoot, "packages/cli/src/index.ts"));
  const inheritedPath = options.env?.PATH ?? process.env.PATH ?? "";
  const child = spawn(command.command, [...command.args, "connect", ...options.args], {
    cwd: options.repositoryRoot,
    env: {
      ...(options.inheritEnv === false ? {} : process.env),
      ...options.env,
      PATH: [
        options.fakeBin,
        join(options.repositoryRoot, "node_modules", ".bin"),
        inheritedPath,
      ].join(delimiter),
      OMNESIS_CONFIG_DIR: options.cliConfigDir,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  registerSubprocessGroup(child);
  let resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });
  const spawned: SpawnedConnect = { child, output: [], spawnError: null, exitResult: null, exit };
  const capture = (chunk: unknown) => {
    spawned.output.push(String(chunk));
    if (spawned.output.length > 200) spawned.output.splice(0, spawned.output.length - 200);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("error", (error) => {
    spawned.spawnError = error;
    const result = { code: null, signal: null };
    spawned.exitResult = result;
    resolveExit(result);
  });
  child.once("exit", (code, signal) => {
    const result = { code, signal };
    spawned.exitResult = result;
    resolveExit(result);
  });
  return spawned;
}

export async function waitForExit(
  running: SpawnedConnect,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  const { output } = running;
  if (running.spawnError) throw running.spawnError;
  const result = running.exitResult ?? (await waitForProcessExit(running, timeoutMs));
  if (!result) {
    await terminateConnect(running);
    throw new Error(`connect did not exit within ${timeoutMs}ms\n${output.join("")}`);
  }
  await killSubprocessGroup(running.child);
  return { code: result.code, output: output.join("") };
}

export async function terminateConnect(running: SpawnedConnect): Promise<void> {
  if (running.spawnError) return;
  await killSubprocessGroup(running.child);
}

async function waitForProcessExit(
  running: SpawnedConnect,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  if (running.exitResult) return running.exitResult;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      running.exit,
      new Promise<null>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

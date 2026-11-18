// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Driving managed-integration and account-enrollment CLIs as real child processes.
 *
 * Connect is a long interactive ceremony — it redeems a pairing code, then
 * blocks waiting for somebody to approve an OAuth request in the portal — so a
 * test has to start it, do the approving, and only then wait for it to finish.
 * Account enrollment has the same asynchronous ceremony. Both keep literal
 * arguments, separate UTF-8 streams and actual exit status, and join every
 * retained descendant before their shared fixture inputs may be removed.
 */

import { StringDecoder } from "node:string_decoder";
import { delimiter, join } from "node:path";
import { ownedProcessCleanupReceipt, spawnWindowsJob } from "@omnesis/core";
import { spawnE2ESubprocess, e2eApplicationStatus, e2eProcessOutput } from "./e2e-owned-process.js";

import { e2eTsxCommand } from "./gateway-env.js";
import { killSubprocessGroup, registerSubprocessGroup } from "./subprocess-reaper.js";
import type { ChildProcess } from "node:child_process";

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

export interface SpawnCliOptions extends Omit<SpawnConnectOptions, "fakeBin" | "cliConfigDir"> {
  /** Complete CLI arguments, including the command name. */
  args: readonly string[];
  fakeBin?: string;
  cliConfigDir?: string;
}

export interface SpawnedCli extends SpawnedConnect {
  stdout(): string;
  stderr(): string;
  closed(): boolean;
  stop(): Promise<void>;
}

export function spawnConnect(
  options: SpawnConnectOptions,
  dependencies: { registration?: (ready: Promise<void>) => Promise<void> } = {},
): SpawnedConnect {
  return spawnCliProcess({ ...options, args: ["connect", ...options.args] }, dependencies);
}

/** Finite CLI commands share the same actual exit and physical closure owner. */
export function spawnCliProcess(
  options: SpawnCliOptions,
  dependencies: { registration?: (ready: Promise<void>) => Promise<void> } = {},
): SpawnedCli {
  const command = e2eTsxCommand(join(options.repositoryRoot, "packages/cli/src/index.ts"));
  const inheritedPath = options.env?.PATH ?? process.env.PATH ?? "";
  const childOptions = {
    cwd: options.repositoryRoot,
    env: {
      ...(options.inheritEnv === false ? {} : process.env),
      ...options.env,
      PATH: [
        ...(options.fakeBin ? [options.fakeBin] : []),
        join(options.repositoryRoot, "node_modules", ".bin"),
        inheritedPath,
      ].join(delimiter),
      ...(options.cliConfigDir !== undefined ? { OMNESIS_CONFIG_DIR: options.cliConfigDir } : {}),
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
    },
    detached: process.platform !== "win32",
  };
  const args = [...command.args, ...options.args];
  // A finite command's actual Node root determines the status,
  // and the kernel joins remaining descendants before output is published.
  const native =
    process.platform === "win32"
      ? spawnWindowsJob(command.command, args, {
          cwd: childOptions.cwd,
          env: childOptions.env,
          completion: "root",
        })
      : undefined;
  const child =
    native ??
    spawnE2ESubprocess(command.command, args, {
      ...childOptions,
      stdio: ["ignore", "pipe", "pipe"],
    });
  native?.stdin.end();
  const output: string[] = [];
  const captured = { stdout: "", stderr: "" };
  const capture = (value: string, stream: "stdout" | "stderr"): void => {
    if (!value) return;
    output.push(value);
    if (output.length > 200) output.splice(0, output.length - 200);
    captured[stream] = `${captured[stream]}${value}`.slice(-8 * 1024 * 1024);
  };
  const streams = e2eProcessOutput(child);
  for (const name of ["stdout", "stderr"] as const) {
    const stream = streams[name];
    const decoder = new StringDecoder("utf8");
    stream?.on("data", (chunk: Buffer) => capture(decoder.write(chunk), name));
    stream?.once("end", () => capture(decoder.end(), name));
  }
  const failures: unknown[] = [];
  let stopping: Promise<void> | undefined;
  let physicallyClosed = false;
  let nativeStopped = false;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const application = new Promise<
    { code: number | null; signal: NodeJS.Signals | null } | undefined
  >((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve(undefined));
  });
  const stop = (): Promise<void> =>
    (stopping ??= (
      native
        ? (async () => {
            const errors: unknown[] = [];
            if (child.exitCode === null && child.signalCode === null) {
              nativeStopped = true;
              try {
                native.kill("SIGKILL");
              } catch (error) {
                errors.push(error);
              }
            }
            const results = await Promise.allSettled([closed, native.jobClosed]);
            if (results[1]!.status === "rejected")
              errors.push(
                Object.assign(
                  new Error("Connect Job cleanup was not confirmed", { cause: results[1]!.reason }),
                  { cleanupFailure: results[1]!.reason },
                ),
              );
            if (errors.length) throw connectFailure(errors);
          })()
        : killSubprocessGroup(child)
    ).then(() => {
      physicallyClosed = true;
    }));
  let registration: Promise<void>;
  try {
    const ready = native?.jobReady ?? registerSubprocessGroup(child);
    registration = dependencies.registration?.(ready) ?? ready;
  } catch (error) {
    registration = Promise.reject(error);
  }
  const spawned: SpawnedCli = {
    child,
    output,
    spawnError: null,
    exitResult: null,
    exit: Promise.resolve({ code: null, signal: null }),
    stdout: () => captured.stdout,
    stderr: () => captured.stderr,
    closed: () => physicallyClosed,
    stop: () => terminateConnect(spawned),
  };
  child.on("error", (error) => {
    spawned.spawnError ??= error;
    failures.push(error);
    void stop().catch(() => {});
  });
  // A failed registration must trigger cleanup without waiting for a child
  // whose startup or interactive ceremony may never complete.
  void registration.catch(() => {
    void stop().catch(() => {});
  });
  spawned.exit = (async () => {
    const settled = await Promise.allSettled([registration, application]);
    for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
    try {
      await stop();
    } catch (error) {
      failures.push(error);
    }
    await closed;
    if (failures.length) throw connectFailure(failures);
    const status = e2eApplicationStatus(child);
    const result = {
      code: nativeStopped ? null : status.exitCode,
      signal: nativeStopped ? null : (status.signalCode as NodeJS.Signals | null),
    };
    spawned.exitResult = result;
    return result;
  })();
  void spawned.exit.catch(() => {});
  owners.set(spawned, { stop });
  return spawned;
}

const owners = new WeakMap<SpawnedConnect, { stop(): Promise<void> }>();
function connectFailure(errors: unknown[]): unknown {
  const unique = [...new Set(errors)];
  if (unique.length === 1) return unique[0];
  const marked = unique.find((error) => ownedProcessCleanupReceipt(error) !== undefined);
  const receipt = ownedProcessCleanupReceipt(marked);
  return Object.assign(
    new AggregateError(unique, "Connect process cleanup failed", {
      cause: marked ?? unique[0],
    }),
    receipt === undefined ? {} : { cleanupFailure: receipt.failure },
  );
}

export async function waitForExit(
  running: SpawnedConnect,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  const result = await waitForProcessExit(running, timeoutMs);
  if (!result) {
    await terminateConnect(running);
    throw new Error(`connect did not exit within ${timeoutMs}ms\n${running.output.join("")}`);
  }
  return { code: result.code, output: running.output.join("") };
}

export async function terminateConnect(running: SpawnedConnect): Promise<void> {
  const owner = owners.get(running);
  if (!owner)
    throw Object.assign(new Error("Connect process owner is unavailable"), {
      cleanupFailure: undefined,
    });
  const stopping = owner.stop();
  const [physical, completion] = await Promise.allSettled([stopping, running.exit]);
  const errors = [physical, completion]
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (errors.some((error) => ownedProcessCleanupReceipt(error) !== undefined))
    throw connectFailure(errors);
  if (physical.status === "rejected") throw physical.reason;
  // An ordinary spawn/registration failure can still have positively joined
  // cleanup. waitForExit reports that operation error; teardown may retire it.
}

async function waitForProcessExit(
  running: SpawnedConnect,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
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

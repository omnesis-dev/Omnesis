// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  requestChildShutdown,
  installParentShutdownHandler,
} from "../../packages/core/src/parent-shutdown.ts";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { ownedProcessCleanupReceipt } from "../../packages/platform/src/owned-process-cleanup.ts";
import { resolveNpmInvocation } from "../../packages/core/src/node-command.ts";
import {
  waitForChild as waitForOwnedChild,
  signalChildTree as signalPosixChildTree,
} from "./check-process-runtime.mjs";
export { childGroupIsAlive } from "./check-process-runtime.mjs";
import { bootstrapWindowsPlatform } from "./bootstrap-platform.mjs";

let retainedLaneHold;
const retainedLaneError = Object.assign(new Error("Check lane cleanup requires review"), {
  cleanupFailure: undefined,
});
function retainUnconfirmedCheckLane() {
  retainedLaneHold ??= setInterval(() => {}, 60_000);
}
export function checkFailureMessage(error) {
  if (ownedProcessCleanupReceipt(error) !== undefined)
    return "Check process cleanup remains unconfirmed; review is required.";
  return error instanceof Error ? error.message : String(error);
}

/** The script a Node check runs, or the program itself, with its first argument. */
function checkCommandLabel(command, args) {
  const [first, second] = args;
  if (typeof first !== "string" || !/\.[cm]?[jt]s$/u.test(first)) return basename(command);
  return second === undefined ? basename(first) : `${basename(first)} ${second}`;
}

/** Finite check roots own their descendants before target admission on Windows. */
export async function runCheckCommand(
  command,
  args,
  {
    cwd,
    env = process.env,
    platform = process.platform,
    signalEmitter = process,
    runWindows,
    detached = true,
    retainUnconfirmed = retainUnconfirmedCheckLane,
    writeStderr = (text) => process.stderr.write(text),
  } = {},
) {
  if (retainedLaneHold) throw retainedLaneError;
  if (platform !== "win32")
    return waitForChild(spawn(command, args, { cwd, env, stdio: "inherit", detached }), {
      signalEmitter,
    });
  const controller = new AbortController();
  let retained = false;
  const hold = (failure) => {
    if (retained) return;
    retained = true;
    retainUnconfirmed(failure);
  };
  const stop = () => controller.abort(new Error("Check stopped by its owner"));
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const signal of signals) signalEmitter.on(signal, stop);
  const removeShutdown = installParentShutdownHandler(stop);
  try {
    if (command === "npm") {
      const invocation = await resolveNpmInvocation(args, { env, platform });
      command = invocation.command;
      args = invocation.args;
    }
    const run = runWindows ?? (await bootstrapWindowsPlatform()).runWindowsJob;
    controller.signal.throwIfAborted();
    const result = await run(command, args, {
      cwd,
      env,
      signal: controller.signal,
      completion: "root",
      stdout: "inherit",
      inputStream: process.stdin,
      onStderr: (bytes) => process.stderr.write(bytes),
    });
    const receipt = ownedProcessCleanupReceipt(result);
    if (receipt !== undefined) {
      hold(result);
      throw Object.assign(new Error("Check process cleanup was not confirmed"), {
        cleanupFailure: receipt.failure,
      });
    }
    if (result.failure !== undefined || controller.signal.aborted || result.signal !== null)
      throw new Error("Check process did not complete normally");
    const code = result.exitCode ?? 1;
    // Checks nest (a wrapper runs a check script that runs the check), and each
    // level passes a status up through its own Windows job. A non-zero status a
    // level never explained would otherwise reach CI as a bare exit code, so
    // each level names the command that returned it.
    if (code !== 0) writeStderr(`[check] ${checkCommandLabel(command, args)} exited ${code}\n`);
    return code;
  } catch (error) {
    if (ownedProcessCleanupReceipt(error) !== undefined) hold(error);
    throw error;
  } finally {
    removeShutdown();
    for (const signal of signals) signalEmitter.removeListener(signal, stop);
  }
}

let nativeProcessBackend;
let nativeProcessLoading;
function processBackend() {
  return (nativeProcessLoading ??= bootstrapWindowsPlatform("windows-process.ts")
    .then((backend) => {
      nativeProcessBackend = backend;
      return backend;
    })
    .catch((error) => {
      nativeProcessLoading = undefined;
      throw error;
    }));
}
function synchronousBackend() {
  if (!nativeProcessBackend) throw new Error("Owned process backend is not initialized");
  return nativeProcessBackend;
}
const windowsBackend = {
  snapshotWindowsProcesses: async (roots) =>
    (await processBackend()).snapshotWindowsProcesses(roots),
  snapshotWindowsProcessesSync: (roots) => synchronousBackend().snapshotWindowsProcessesSync(roots),
  killWindowsProcesses: async (targets) => (await processBackend()).killWindowsProcesses(targets),
  killWindowsProcessesSync: (targets) => synchronousBackend().killWindowsProcessesSync(targets),
};

async function signalChildTree(child, signal) {
  if (process.platform === "win32" && typeof child.pid === "number") {
    if (signal !== "SIGKILL" && (await requestChildShutdown(child))) return;
    const { killWindowsProcessTree } =
      await import("../../packages/core/src/windows-process-tree.ts");
    await killWindowsProcessTree(child.pid);
    return;
  }
  return signalPosixChildTree(child, signal);
}

/** Platform adapter; the generic runner can also load before dependencies exist. */
export function waitForChild(child, opts = {}) {
  let defaultWindowsTree = null;
  if (
    opts.windowsTree === undefined &&
    process.platform === "win32" &&
    child.spawnfile &&
    child.pid
  ) {
    let tree;
    const loading = import("../../packages/core/src/windows-process-tree.ts").then(
      ({ WindowsProcessTree }) => {
        tree = new WindowsProcessTree(child.pid, {
          backend: windowsBackend,
          rootIsAlive: () => child.exitCode === null && child.signalCode === null,
        });
        return tree;
      },
    );
    defaultWindowsTree = {
      get alive() {
        return tree?.alive ?? true;
      },
      async refresh() {
        return (await loading).refresh();
      },
      async kill() {
        return (await loading).kill();
      },
    };
  }
  const { signalFn = signalChildTree, windowsTree = defaultWindowsTree, ...rest } = opts;
  return waitForOwnedChild(child, { ...rest, signalFn, windowsTree });
}

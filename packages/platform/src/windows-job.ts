// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  killWindowsOwnedProcess,
  runWindowsOwnedProcess,
  runWindowsOwnedProcessSync,
  spawnWindowsOwnedProcess,
  type WindowsJobOptions,
  type WindowsJobProcess,
  type WindowsJobResult,
  type WindowsOwnedInvocation,
  type WindowsOwnedSyncOptions,
} from "./windows-owned-process.js";
import { windowsWorkerInvocation, type WindowsBootstrapRequest } from "./windows-worker-cache.js";
import { windowsPowerShellExecutable } from "./windows-powershell.js";
import { WINDOWS_JOB_POWERSHELL_SCRIPT } from "./native/windows-job-source.js";

export type {
  WindowsJobOptions,
  WindowsJobProcess,
  WindowsJobResult,
} from "./windows-owned-process.js";

function jobFrame(command: string, args: readonly string[]): Buffer {
  if ([command, ...args].some((value) => value.includes("\0")))
    throw new Error("Program and arguments must not contain null bytes");
  const payload = Buffer.from(JSON.stringify({ command, args, parentPid: process.pid }), "utf8");
  if (payload.length > 262144) throw new Error("Process configuration is too large (ENAMETOOLONG)");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(payload.length);
  return Buffer.concat([length, payload]);
}
/** Bootstrap verification itself never executes an unverified cache candidate. */
function bootstrapWindowsWorker(
  request: WindowsBootstrapRequest,
  timeoutMs = 30_000,
): WindowsJobResult {
  const invocation = {
    command: windowsPowerShellExecutable(),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_JOB_POWERSHELL_SCRIPT, "utf16le").toString("base64"),
    ],
  };
  return runWindowsOwnedProcessSync(
    invocation,
    jobFrame(request.invocation.command, request.invocation.args),
    {
      input: request.input,
      timeoutMs: Math.max(1, Math.min(timeoutMs, 30_000)),
      maxBuffer: 65_536,
    },
  );
}

export function windowsJobInvocation(timeoutMs?: number): WindowsOwnedInvocation {
  const start = Date.now();
  return windowsWorkerInvocation(
    "job",
    (request) =>
      bootstrapWindowsWorker(
        request,
        timeoutMs === undefined ? undefined : timeoutMs - (Date.now() - start),
      ),
    { timeoutMs },
  );
}
/** Shared filesystem workers self-contain in a Job before reading request input. */
export function windowsFilesystemInvocation(timeoutMs?: number): WindowsOwnedInvocation {
  const start = Date.now();
  return windowsWorkerInvocation(
    "filesystem",
    (request) =>
      bootstrapWindowsWorker(
        request,
        timeoutMs === undefined ? undefined : timeoutMs - (Date.now() - start),
      ),
    { timeoutMs },
  );
}
/** Stop only a retained helper handle; numeric PIDs never establish ownership. */
export function killWindowsJob(pid: number): void {
  killWindowsOwnedProcess(pid);
}

/** The helper remains alive until all descendants exit; stdio is raw binary. */
export function spawnWindowsJob(
  command: string,
  args: readonly string[],
  opts: Pick<WindowsJobOptions, "cwd" | "env"> & { startupTimeoutMs?: number } = {},
): WindowsJobProcess {
  const start = Date.now();
  const expired = () =>
    opts.startupTimeoutMs !== undefined && Date.now() - start >= opts.startupTimeoutMs;
  const timeout = () =>
    Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", killed: true });
  const frame = jobFrame(command, args);
  if (expired()) throw timeout();
  let invocation: WindowsOwnedInvocation;
  try {
    invocation = windowsJobInvocation(
      opts.startupTimeoutMs === undefined
        ? undefined
        : opts.startupTimeoutMs - (Date.now() - start),
    );
  } catch (error) {
    if (expired()) throw timeout();
    throw error;
  }
  if (expired()) throw timeout();
  return spawnWindowsOwnedProcess(invocation, frame, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: "capture",
  }) as WindowsJobProcess;
}
function deadlineFailure(reason: "timeout" | "aborted"): WindowsJobResult {
  return { exitCode: null, signal: null, stdout: Buffer.alloc(0), stderr: "", failure: reason };
}
function failedSpawn(error: unknown): WindowsJobResult {
  return {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: "",
    failure: "spawn",
    failureMessage: error instanceof Error ? error.message : String(error),
  };
}
/** Publish the helper PID before queuing target configuration or input bytes. */
export function runWindowsJob(
  command: string,
  args: readonly string[],
  opts: WindowsJobOptions,
  onSpawn?: (pid: number) => void,
): Promise<WindowsJobResult> {
  if (opts.signal?.aborted) return Promise.resolve(deadlineFailure("aborted"));
  const start = Date.now();
  if (opts.timeoutMs !== undefined && opts.timeoutMs <= 0)
    return Promise.resolve(deadlineFailure("timeout"));
  let frame: Buffer, invocation: WindowsOwnedInvocation;
  try {
    frame = jobFrame(command, args);
    invocation = windowsJobInvocation(opts.timeoutMs);
  } catch (error) {
    return Promise.resolve(
      opts.timeoutMs !== undefined && Date.now() - start >= opts.timeoutMs
        ? deadlineFailure("timeout")
        : failedSpawn(error),
    );
  }
  const timeoutMs =
    opts.timeoutMs === undefined ? undefined : opts.timeoutMs - (Date.now() - start);
  if (timeoutMs !== undefined && timeoutMs <= 0) return Promise.resolve(deadlineFailure("timeout"));
  return runWindowsOwnedProcess(invocation, frame, { ...opts, timeoutMs }, onSpawn);
}
/** Synchronous callers share the same verified helper and kernel containment. */
export function runWindowsJobSync(
  command: string,
  args: readonly string[],
  opts: WindowsOwnedSyncOptions = {},
): WindowsJobResult {
  const start = Date.now();
  if (opts.timeoutMs !== undefined && opts.timeoutMs <= 0) return deadlineFailure("timeout");
  let frame: Buffer, invocation: WindowsOwnedInvocation;
  try {
    frame = jobFrame(command, args);
    invocation = windowsJobInvocation(opts.timeoutMs);
  } catch (error) {
    return opts.timeoutMs !== undefined && Date.now() - start >= opts.timeoutMs
      ? deadlineFailure("timeout")
      : failedSpawn(error);
  }
  const timeoutMs =
    opts.timeoutMs === undefined ? undefined : opts.timeoutMs - (Date.now() - start);
  if (timeoutMs !== undefined && timeoutMs <= 0) return deadlineFailure("timeout");
  return runWindowsOwnedProcessSync(invocation, frame, { ...opts, timeoutMs });
}

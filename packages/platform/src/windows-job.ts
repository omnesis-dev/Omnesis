// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
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
import {
  prepareWindowsNativeWorker,
  windowsWorkerInvocation,
  type WindowsBootstrapRequest,
} from "./windows-worker-cache.js";

import { windowsPowerShellExecutable } from "./windows-powershell.js";
import { WindowsJobControl, type WindowsJobControlConfiguration } from "./windows-job-control.js";
import { WINDOWS_JOB_POWERSHELL_SCRIPT } from "./native/windows-job-source.js";

/** Async ABI includes authenticated cooperative cancellation and joined completion. */
export const WINDOWS_JOB_CONTROL_PROTOCOL = 1;

export type {
  WindowsJobOptions,
  WindowsJobProcess,
  WindowsJobResult,
} from "./windows-owned-process.js";

function jobFrame(
  command: string,
  args: readonly string[],
  completion?: WindowsJobOptions["completion"],
  control?: WindowsJobControlConfiguration,
  syncReceipt?: string,
): Buffer {
  if (completion !== undefined && completion !== "tree" && completion !== "root")
    throw new Error("Invalid Windows job completion policy");
  if ([command, ...args].some((value) => value.includes("\0")))
    throw new Error("Program and arguments must not contain null bytes");
  const payload = Buffer.from(
    JSON.stringify({
      command,
      args,
      parentPid: process.pid,
      ...(completion === undefined ? {} : { completion }),
      ...(control ? { control } : {}),
      ...(syncReceipt ? { syncReceipt } : {}),
    }),
    "utf8",
  );
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
  const started = performance.now();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return deadlineFailure("timeout");
  const budget = Math.min(timeoutMs, 30_000);
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
  const nonce = randomBytes(32).toString("hex");
  const frame = jobFrame(
    request.invocation.command,
    request.invocation.args,
    undefined,
    undefined,
    nonce,
  );
  const elapsed = performance.now() - started;
  const remaining = Math.floor(budget - elapsed);
  if (!Number.isFinite(remaining) || elapsed < 0 || remaining <= 0)
    return deadlineFailure("timeout");
  return runWindowsOwnedProcessSync(
    invocation,
    frame,
    {
      input: request.input,
      timeoutMs: remaining,
      maxBuffer: 65_536,
    },
    { nonce },
  );
}

export function windowsJobInvocation(timeoutMs?: number): WindowsOwnedInvocation {
  return windowsWorkerInvocation("job", bootstrapWindowsWorker, { timeoutMs });
}
/** Shared filesystem workers self-contain in a Job before reading request input. */
export function windowsFilesystemInvocation(timeoutMs?: number): WindowsOwnedInvocation {
  return windowsWorkerInvocation("filesystem", bootstrapWindowsWorker, { timeoutMs });
}
/** Stop only a retained helper handle; numeric PIDs never establish ownership. */
export function killWindowsJob(pid: number): void {
  killWindowsOwnedProcess(pid);
}

/** Tree lifetime is the default; root completion first terminates and joins remaining members. */
export function spawnWindowsJob(
  command: string,
  args: readonly string[],
  opts: Pick<WindowsJobOptions, "cwd" | "env" | "completion"> & { startupTimeoutMs?: number } = {},
): WindowsJobProcess {
  prepareWindowsNativeWorker();
  const start = performance.now();
  const remaining = () =>
    Math.floor(Math.min(30_000, opts.startupTimeoutMs ?? Infinity) - (performance.now() - start));
  const expired = () => !(remaining() > 0);
  const timeout = () =>
    Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", killed: true });
  jobFrame(command, args, opts.completion);
  if (expired()) throw timeout();
  let invocation: WindowsOwnedInvocation;
  try {
    invocation = windowsJobInvocation(remaining());
  } catch (error) {
    if (expired()) throw Object.assign(timeout(), cleanupFailureReceipt(error));
    throw error;
  }
  if (expired()) throw timeout();
  const startupMs = remaining();
  if (!(startupMs > 0)) throw timeout();
  const control = new WindowsJobControl(invocation.parentBirth ?? "", Date.now() + startupMs);
  try {
    const controlledFrame = jobFrame(command, args, opts.completion, control.configuration);
    if (expired()) throw timeout();
    return spawnWindowsOwnedProcess(
      invocation,
      controlledFrame,
      {
        cwd: opts.cwd,
        env: opts.env,
        stdout: "capture",
      },
      undefined,
      control,
    ) as WindowsJobProcess;
  } catch (error) {
    control.abandon();
    throw error;
  }
}
function cleanupFailureReceipt(error: unknown): { cleanupFailure?: unknown } {
  if (error !== null && typeof error === "object" && Object.hasOwn(error, "cleanupFailure"))
    return { cleanupFailure: (error as { cleanupFailure: unknown }).cleanupFailure };
  return {};
}
function deadlineFailure(reason: "timeout" | "aborted", error?: unknown): WindowsJobResult {
  return {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: "",
    failure: reason,
    ...cleanupFailureReceipt(error),
  };
}
function failedSpawn(error: unknown): WindowsJobResult {
  return {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: "",
    failure: "spawn",
    failureMessage: error instanceof Error ? error.message : String(error),
    ...cleanupFailureReceipt(error),
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
  prepareWindowsNativeWorker();
  const start = performance.now();
  const startupRemaining = () =>
    Math.floor(Math.min(30_000, opts.timeoutMs ?? Infinity) - (performance.now() - start));
  if (opts.timeoutMs !== undefined && opts.timeoutMs <= 0)
    return Promise.resolve(deadlineFailure("timeout"));
  let frame: Buffer, invocation: WindowsOwnedInvocation;
  try {
    frame = jobFrame(command, args, opts.completion);
    const remaining = startupRemaining();
    if (!(remaining > 0)) return Promise.resolve(deadlineFailure("timeout"));
    invocation = windowsJobInvocation(remaining);
  } catch (error) {
    return Promise.resolve(
      opts.timeoutMs !== undefined && performance.now() - start >= opts.timeoutMs
        ? deadlineFailure("timeout", error)
        : failedSpawn(error),
    );
  }
  const timeoutMs =
    opts.timeoutMs === undefined
      ? undefined
      : Math.floor(opts.timeoutMs - (performance.now() - start));
  if (timeoutMs !== undefined && timeoutMs <= 0) return Promise.resolve(deadlineFailure("timeout"));
  if (opts.input !== undefined && opts.inputStream !== undefined)
    return Promise.resolve(
      failedSpawn(new Error("Provide binary input or an input stream, not both")),
    );
  let control: WindowsJobControl | undefined;
  try {
    const startupMs = startupRemaining();
    if (!(startupMs > 0)) return Promise.resolve(deadlineFailure("timeout"));
    control = new WindowsJobControl(invocation.parentBirth ?? "", Date.now() + startupMs);
    frame = jobFrame(command, args, opts.completion, control.configuration);
    const remaining =
      opts.timeoutMs === undefined
        ? undefined
        : Math.floor(opts.timeoutMs - (performance.now() - start));
    if (!(startupRemaining() > 0) || (remaining !== undefined && remaining <= 0)) {
      control.abandon();
      return control.closed.catch(() => {}).then(() => deadlineFailure("timeout"));
    }
    return runWindowsOwnedProcess(
      invocation,
      frame,
      { ...opts, timeoutMs: remaining },
      onSpawn,
      control,
    );
  } catch (error) {
    control?.abandon();
    return (control?.closed.catch(() => {}) ?? Promise.resolve()).then(() => failedSpawn(error));
  }
}
/** Synchronous callers share the same verified helper and kernel containment. */
export function runWindowsJobSync(
  command: string,
  args: readonly string[],
  opts: WindowsOwnedSyncOptions = {},
): WindowsJobResult {
  prepareWindowsNativeWorker();
  const start = performance.now();
  if (opts.timeoutMs !== undefined && opts.timeoutMs <= 0) return deadlineFailure("timeout");
  const nonce = randomBytes(32).toString("hex");
  let frame: Buffer, invocation: WindowsOwnedInvocation;
  try {
    frame = jobFrame(command, args, opts.completion, undefined, nonce);
    const remaining =
      opts.timeoutMs === undefined
        ? undefined
        : Math.floor(opts.timeoutMs - (performance.now() - start));
    if (remaining !== undefined && remaining <= 0) return deadlineFailure("timeout");
    invocation = windowsJobInvocation(remaining);
  } catch (error) {
    return opts.timeoutMs !== undefined && performance.now() - start >= opts.timeoutMs
      ? deadlineFailure("timeout", error)
      : failedSpawn(error);
  }
  const timeoutMs =
    opts.timeoutMs === undefined
      ? undefined
      : Math.floor(opts.timeoutMs - (performance.now() - start));
  if (timeoutMs !== undefined && timeoutMs <= 0) return deadlineFailure("timeout");
  return runWindowsOwnedProcessSync(invocation, frame, { ...opts, timeoutMs }, { nonce });
}

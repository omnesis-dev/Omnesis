// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { PassThrough, type Readable, type Writable } from "node:stream";
import type { WindowsJobControl } from "./windows-job-control.js";

export interface WindowsJobOptions {
  /** Tree lifetime by default; finite build roots may terminate remaining members after root exit. */
  completion?: "tree" | "root";
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: Uint8Array;
  /** Forward raw input after the configuration frame; the target receives a pipe. */
  inputStream?: Readable;
  timeoutMs?: number;
  signal?: AbortSignal;
  captureStdout?: boolean;
  stdout?: "capture" | "inherit" | "ignore";
  onStderr?: (bytes: Uint8Array) => void;
}

export interface WindowsJobResult {
  exitCode: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: string;
  failure?: "spawn" | "timeout" | "aborted";
  failureMessage?: string;
  /** Present when owned-process join failed; a rejected promise may carry an undefined reason. */
  cleanupFailure?: unknown;
}

const STDERR_LIMIT = 4_000;
const helpers = new Map<number, ChildProcess>();

/** Request cooperative termination through a retained owner; join proof is asynchronous. */
export function killWindowsOwnedProcess(pid: number): void {
  const helper = helpers.get(pid);
  if (helper) helper.kill("SIGKILL");
  // Another process's helper watches its pinned parent handle. An unknown
  // numeric PID is never enough evidence to terminate a process here.
}

/** The helper stays alive until all job members exit; kill stops the whole job. */
export type WindowsJobProcess = ChildProcessWithoutNullStreams & {
  jobReady: Promise<void>;
  /** Native JOINED, helper close and all authenticated control/input cleanup. */
  jobClosed: Promise<void>;
};
type JobProcess = ChildProcess & { jobReady: Promise<void>; jobClosed: Promise<void> };
type SpawnOptions = Pick<WindowsJobOptions, "cwd" | "env" | "stdout" | "captureStdout">;

export interface WindowsOwnedInvocation {
  /** Exact FILETIME validated by native cache provenance; never supplied by target input. */
  parentBirth?: string;
  command: string;
  args: readonly string[];
}
function closeInput(stream: Writable): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stream.closed) resolve();
    else {
      stream.once("close", () => resolve());
      stream.destroy();
    }
  });
}

export function spawnWindowsOwnedProcess(
  invocation: WindowsOwnedInvocation,
  initialInput: Uint8Array,
  opts: SpawnOptions,
  onSpawn?: (pid: number) => void,
  control?: WindowsJobControl,
): JobProcess {
  control?.start();
  const output = opts.stdout ?? (opts.captureStdout === false ? "ignore" : "capture");
  let child: ChildProcess;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      stdio: ["pipe", output === "capture" ? "pipe" : output, "pipe"],
    });
  } catch (error) {
    control?.abandon();
    throw error;
  }
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const jobReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A consumer may rely on exit alone; readiness must never reject unobserved.
  void jobReady.catch(() => {});
  const jobClosed =
    control?.closed ?? new Promise<void>((resolve) => child.once("close", () => resolve()));
  void jobClosed.catch(() => {});
  const proc: JobProcess = Object.assign(child, { jobReady, jobClosed });
  void control?.failed.catch((error: unknown) => rejectReady(error));
  const rawInput = proc.stdin!;
  const gatedInput = control ? new PassThrough() : undefined;
  if (control && gatedInput) {
    proc.stdin = gatedInput;
    proc.stdio[0] = gatedInput;
    control.attach(proc, async () => {
      // ChildProcess sees the exposed gate on exit, so retain and explicitly
      // join its original pipe too, including sessions that never ended stdin.
      gatedInput.unpipe(rawInput);
      await Promise.all([closeInput(gatedInput), closeInput(rawInput)]);
    });
    rawInput.on("error", () => gatedInput.destroy());
  }
  const rawStderr = proc.stderr!;
  const stderr = new PassThrough();
  proc.stderr = stderr;
  proc.stdio[2] = stderr;
  let prefix = Buffer.alloc(0);
  let statusRead = false;
  rawStderr.on("data", (chunk: Buffer) => {
    if (statusRead) {
      if (!stderr.write(chunk)) rawStderr.pause();
      return;
    }
    prefix = Buffer.concat([prefix, chunk]);
    const end = prefix.indexOf(10);
    if (end < 0 && prefix.length < STDERR_LIMIT) return;
    statusRead = true;
    const first = prefix
      .subarray(0, end < 0 ? prefix.length : end)
      .toString("utf8")
      .replace(/\r$/u, "");
    const match = /^OMNESIS_JOB:(\d+)$/u.exec(first);
    if (match) {
      const code = Number(match[1]);
      if (code === 0) {
        try {
          control?.targetStarted();
          resolveReady();
        } catch (error) {
          rejectReady(error);
          proc.kill("SIGKILL");
        }
      } else {
        const name =
          code === 2 || code === 3
            ? "ENOENT"
            : code === 5
              ? "EACCES"
              : code === 193
                ? "ENOEXEC"
                : `Windows error ${code}`;
        rejectReady(
          Object.assign(new Error(`Cannot start program (${name}, Windows error ${code})`), {
            code: name,
          }),
        );
      }
      if (end >= 0 && !stderr.write(prefix.subarray(end + 1))) rawStderr.pause();
    } else {
      rejectReady(new Error(first || "Invalid Windows process helper status"));
      stderr.write(prefix);
      proc.kill("SIGKILL");
    }
    prefix = Buffer.alloc(0);
  });
  stderr.on("drain", () => rawStderr.resume());
  rawStderr.once("end", () => {
    if (!statusRead) {
      rejectReady(
        new Error(
          prefix.toString("utf8") || "Windows process helper exited before starting the program",
        ),
      );
      stderr.end(prefix);
    } else stderr.end();
  });
  rawStderr.once("error", (error) => rejectReady(error));
  proc.once("error", (error) => rejectReady(error));
  proc.once("close", () => {
    rejectReady(new Error("Windows process helper exited before starting the program"));
  });
  const forget = () => {
    if (proc.pid !== undefined && helpers.get(proc.pid) === proc) helpers.delete(proc.pid);
  };
  void jobClosed.then(forget, forget);
  proc.stdin!.on("error", () => {});
  if (proc.pid !== undefined) {
    helpers.set(proc.pid, proc);
    try {
      onSpawn?.(proc.pid);
    } catch (error) {
      rejectReady(error);
      proc.kill("SIGKILL");
      return proc;
    }
  }
  if (control && gatedInput) {
    void control.listening.then(
      () => {
        if (!control.inputAllowed) return;
        rawInput.write(initialInput, (error) => {
          if (error) {
            rejectReady(error);
            proc.kill("SIGKILL");
          } else if (control.inputAllowed) gatedInput.pipe(rawInput);
        });
      },
      (error: unknown) => {
        rejectReady(error);
        proc.kill("SIGKILL");
      },
    );
  } else rawInput.write(initialInput);
  return proc;
}

/** Run an owned job through completion, publishing its PID before target start. */
export function runWindowsOwnedProcess(
  invocation: WindowsOwnedInvocation,
  initialInput: Uint8Array,
  opts: WindowsJobOptions,
  onSpawn?: (pid: number) => void,
  control?: WindowsJobControl,
): Promise<WindowsJobResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    let stderr = "";
    let ready = false;
    let failure: WindowsJobResult["failure"];
    let failureMessage: string | undefined;
    let cleanupFailure: unknown;
    let cleanupFailed = false;
    let finished = false;
    let publicationError: unknown;
    let publicationFailed = false;
    let proc: JobProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let inputStopTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, signal: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(inputStopTimer);
      opts.inputStream?.removeListener("error", onInputError);
      opts.signal?.removeEventListener("abort", onAbort);
      if (proc?.stdin && opts.inputStream) opts.inputStream.unpipe(proc.stdin);
      if (publicationFailed) {
        reject(
          !cleanupFailed
            ? publicationError
            : Object.assign(
                new Error("Windows job cleanup was not confirmed", { cause: publicationError }),
                { cleanupFailure },
              ),
        );
        return;
      }
      if (!ready && !failure) {
        failure = "spawn";
        failureMessage = stderr || "Windows process helper exited before starting the program";
      }
      resolve({
        exitCode: failure ? null : code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr,
        ...(failure ? { failure } : {}),
        ...(failureMessage ? { failureMessage } : {}),
        ...(cleanupFailed ? { cleanupFailure } : {}),
      });
    };
    const stop = (reason: "timeout" | "aborted"): void => {
      failure ??= reason;
      proc?.kill("SIGKILL");
    };
    const onAbort = (): void => stop("aborted");
    const onInputError = (): void => {
      failure ??= "spawn";
      failureMessage ??= "Process input failed";
      // EOF lets a transactional target discard its held staging file. A
      // bounded backstop still owns targets that fail to finish cleanup.
      proc?.stdin?.destroy();
      inputStopTimer = setTimeout(() => proc?.kill("SIGKILL"), 1_000);
      inputStopTimer.unref();
    };
    const finishWithoutChild = (): void => {
      control?.abandon();
      void (control?.closed ?? Promise.resolve()).then(
        () => finish(null, null),
        (error: unknown) => {
          cleanupFailed = true;
          cleanupFailure = error;
          finish(null, null);
        },
      );
    };
    if (opts.timeoutMs !== undefined) timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
    if (opts.signal?.aborted) {
      failure = "aborted";
      finishWithoutChild();
      return;
    }
    if (opts.input !== undefined && opts.inputStream !== undefined) {
      failure = "spawn";
      failureMessage = "Provide binary input or an input stream, not both";
      finishWithoutChild();
      return;
    }
    try {
      proc = spawnWindowsOwnedProcess(
        invocation,
        initialInput,
        opts,
        (pid) => {
          try {
            onSpawn?.(pid);
          } catch (error) {
            publicationFailed = true;
            publicationError = error;
            throw error;
          }
        },
        control,
      );
    } catch (error) {
      control?.abandon();
      failure = "spawn";
      failureMessage = error instanceof Error ? error.message : String(error);
      finishWithoutChild();
      return;
    }
    void proc.jobReady.then(
      () => {
        ready = true;
      },
      (error: unknown) => {
        failure ??=
          error && typeof error === "object" && "code" in error && error.code === "ETIMEDOUT"
            ? "timeout"
            : "spawn";
        failureMessage = error instanceof Error ? error.message : String(error);
      },
    );
    proc.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr?.on("data", (bytes: Buffer) => {
      stderr += bytes.toString("utf8").slice(0, STDERR_LIMIT - stderr.length);
      opts.onStderr?.(bytes);
    });
    proc.on("error", (error) => {
      failure ??= "spawn";
      failureMessage = error.message;
    });
    proc.on("close", (code, signal) => {
      void proc!.jobClosed.then(
        () => finish(code, signal),
        (error: unknown) => {
          cleanupFailed = true;
          cleanupFailure = error;
          failure ??= "spawn";
          failureMessage = failureMessage
            ? `${failureMessage}; Windows job cleanup was not confirmed`
            : "Windows job cleanup was not confirmed";
          finish(code, signal);
        },
      );
    });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) {
      stop("aborted");
      return;
    }
    if (publicationFailed) return;
    if (opts.inputStream) {
      opts.inputStream.once("error", onInputError);
      opts.inputStream.pipe(proc.stdin!);
    } else proc.stdin!.end(opts.input);
  });
}

export type WindowsOwnedSyncOptions = Pick<
  WindowsJobOptions,
  "cwd" | "env" | "input" | "timeoutMs" | "stdout" | "captureStdout" | "completion"
> & { maxBuffer?: number };
export function runWindowsOwnedProcessSync(
  invocation: WindowsOwnedInvocation,
  initialInput: Uint8Array,
  opts: WindowsOwnedSyncOptions = {},
): WindowsJobResult {
  const output = opts.stdout ?? (opts.captureStdout === false ? "ignore" : "capture");
  const run = spawnSync(invocation.command, invocation.args, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    input: Buffer.concat([initialInput, Buffer.from(opts.input ?? [])]),
    stdio: ["pipe", output === "capture" ? "pipe" : output, "pipe"],
    timeout: opts.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
  });
  const raw = run.stderr?.toString("utf8") ?? "";
  const end = raw.indexOf("\n");
  const match = /^OMNESIS_JOB:(\d+)\r?$/u.exec(raw.slice(0, end < 0 ? raw.length : end));
  const nativeCode = match ? Number(match[1]) : undefined;
  const stderr = match && end >= 0 ? raw.slice(end + 1) : raw;
  let failure: WindowsJobResult["failure"];
  let failureMessage: string | undefined;
  if (run.error) {
    failure = "code" in run.error && run.error.code === "ETIMEDOUT" ? "timeout" : "spawn";
    failureMessage = run.error.message;
  } else if (nativeCode !== 0) {
    failure = "spawn";
    const name =
      nativeCode === 2 || nativeCode === 3
        ? "ENOENT"
        : nativeCode === 5
          ? "EACCES"
          : nativeCode === 193
            ? "ENOEXEC"
            : `Windows error ${nativeCode ?? "unknown"}`;
    failureMessage = match
      ? `Cannot start program (${name})`
      : stderr || "Windows process helper exited before starting the program";
  }
  return {
    exitCode: failure ? null : run.status,
    signal: run.signal,
    stdout: run.stdout ?? Buffer.alloc(0),
    stderr,
    ...(failure ? { failure } : {}),
    ...(failureMessage ? { failureMessage } : {}),
    // Synchronous APIs cannot service the asynchronous control pipe. A killed
    // helper remains kernel-contained, but raw close cannot prove descendants
    // joined; callers must not interpret that failure as a completed cleanup.
    ...((run.error || run.signal) && run.pid > 0
      ? {
          cleanupFailure: new Error("Synchronous Windows helper cleanup was not confirmed"),
        }
      : {}),
  };
}

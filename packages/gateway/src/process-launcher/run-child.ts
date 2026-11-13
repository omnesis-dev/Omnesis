// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile, spawn, type ChildProcess } from "node:child_process";

/** How to run one short-lived external program and what to collect from it. */
export interface RunProcessOptions {
  /** Written to the program's stdin, which is then closed. Absent: stdin is ignored. */
  input?: Uint8Array;
  /** The program, and every process it started, is killed with SIGKILL after this long. */
  timeoutMs: number;
  /** Aborting kills the program and every process it started with SIGKILL. */
  signal?: AbortSignal;
  /** Collect stdout (default). When false, stdout is discarded. */
  captureStdout?: boolean;
}

/** What a program did. `run` never rejects for the program's own failures. */
export interface ProcessResult {
  /** Exit code, or null when the program was killed by a signal or never started. */
  exitCode: number | null;
  /** The signal that ended the program, if one did. */
  signal: string | null;
  stdout: Uint8Array;
  /** The start of stderr, at most `STDERR_CAPTURE_CHARS` characters. */
  stderr: string;
  /**
   * Why the program did not run to its own exit: it could not be started, it
   * outlived `timeoutMs`, or the caller aborted it.
   */
  failure?: "spawn" | "timeout" | "aborted";
  /** The start error's message when `failure` is `"spawn"`. */
  failureMessage?: string;
}

/** Runs an external program to completion. */
export interface ProcessLauncher {
  run(command: string, args: readonly string[], opts: RunProcessOptions): Promise<ProcessResult>;
}

export const STDERR_CAPTURE_CHARS = 4_000;

/**
 * Kill a program and every process it started. Each program leads its own
 * process group, so a wrapper script's children or a compiler driver's
 * frontend, which hold the same pipes, end with it instead of keeping the run
 * open.
 */
export function killProcessGroup(pid: number): void {
  if (process.platform === "win32") {
    // Windows has no negative-PID process groups. Target this launcher's tree,
    // including descendants holding its output pipes open.
    execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has already exited.
  }
}

/**
 * Spawn `command` from the current process and collect what it produced. The
 * launcher host runs this for the gateway; the same function backs the direct
 * launcher, so both report a program's outcome identically. `onSpawn` receives
 * the program's pid, which is also its process group id.
 */
export function runChild(
  command: string,
  args: readonly string[],
  opts: RunProcessOptions,
  onSpawn?: (pid: number) => void,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const empty = (failure: ProcessResult["failure"], failureMessage?: string): ProcessResult => ({
      exitCode: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: "",
      ...(failure ? { failure } : {}),
      ...(failureMessage !== undefined ? { failureMessage } : {}),
    });
    if (opts.signal?.aborted) {
      resolve(empty("aborted"));
      return;
    }
    let proc: ChildProcess;
    try {
      proc = spawn(command, [...args], {
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: [
          opts.input ? "pipe" : "ignore",
          opts.captureStdout === false ? "ignore" : "pipe",
          "pipe",
        ],
      });
    } catch (err) {
      resolve(empty("spawn", err instanceof Error ? err.message : String(err)));
      return;
    }
    const stdout: Buffer[] = [];
    let stderr = "";
    let failure: ProcessResult["failure"];
    let failureMessage: string | undefined;
    let settled = false;
    const kill = (reason: "timeout" | "aborted"): void => {
      failure ??= reason;
      if (proc.pid !== undefined) killProcessGroup(proc.pid);
    };
    const timer = setTimeout(() => kill("timeout"), opts.timeoutMs);
    const onAbort = (): void => kill("aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr,
        ...(failure ? { failure } : {}),
        ...(failureMessage !== undefined ? { failureMessage } : {}),
      });
    };
    if (proc.pid !== undefined) onSpawn?.(proc.pid);
    proc.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAPTURE_CHARS)
        stderr += chunk.toString().slice(0, STDERR_CAPTURE_CHARS - stderr.length);
    });
    proc.on("error", (err) => {
      if (!failure) {
        failure = "spawn";
        failureMessage = err.message;
      }
      finish(null, null);
    });
    proc.on("close", (code, signal) => finish(code, signal));
    if (opts.input && proc.stdin) {
      // A program that rejects its input early closes stdin; its exit reports why.
      proc.stdin.on("error", () => {});
      proc.stdin.end(opts.input);
    }
  });
}

/** Runs each program from the calling process. */
export const directProcessLauncher: ProcessLauncher = {
  run: (command, args, opts) => runChild(command, args, opts),
};

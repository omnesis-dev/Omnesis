// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { commandTimeoutError } from "./command-timeout.js";
import { spawnWindowsJob, type WindowsJobProcess } from "./windows-job.js";
import { prepareWindowsNativeWorker } from "./windows-worker-cache.js";

/** UTF-8 execFile-style capture with kernel ownership through timeout and close. */
export async function execWindowsJob(
  command: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
    signal?: AbortSignal;
    windowsHide?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  if (opts.signal?.aborted) {
    throw Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" });
  }
  prepareWindowsNativeWorker();
  const started = performance.now();
  const timeout = opts.timeout !== undefined && opts.timeout > 0 ? opts.timeout : undefined;
  let proc: WindowsJobProcess;
  try {
    proc = spawnWindowsJob(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      startupTimeoutMs: timeout,
    });
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { stdout: "", stderr: "" });
    throw error;
  }
  const remaining =
    timeout === undefined ? undefined : Math.floor(timeout - (performance.now() - started));
  return new Promise((resolve, reject) => {
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let failure: unknown;
    let failed = false;
    const stop = (error: unknown): void => {
      if (!failed) {
        failure = error;
        failed = true;
      }
      proc.kill("SIGKILL");
    };
    const abort = (): void =>
      stop(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }));
    const timedOut = (limit: number): void =>
      stop(commandTimeoutError(command, args, limit, performance.now() - started));
    const timer =
      timeout !== undefined && remaining !== undefined && remaining > 0
        ? setTimeout(() => timedOut(timeout), remaining)
        : undefined;
    const limit = opts.maxBuffer ?? 1024 * 1024;
    const capture = (chunks: Buffer[], chunk: Buffer, count: number, stream: string): void => {
      const remaining = Math.max(0, limit - count);
      chunks.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining) {
        stop(
          Object.assign(new Error(`${stream} maxBuffer length exceeded`), {
            code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            killed: true,
          }),
        );
      }
    };
    proc.stdout.on("data", (chunk: Buffer) => {
      capture(output, chunk, outputBytes, "stdout");
      outputBytes += chunk.length;
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      capture(errors, chunk, errorBytes, "stderr");
      errorBytes += chunk.length;
    });
    void proc.jobReady.catch((error: unknown) => {
      if (!failed) {
        failure = error;
        failed = true;
      }
    });
    proc.once("error", (error) => {
      if (!failed) {
        failure = error;
        failed = true;
      }
    });
    const recordExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (!failed && (code !== 0 || signal !== null)) {
        failure = Object.assign(
          new Error(
            Buffer.concat(errors).toString("utf8") ||
              `Command exited with ${signal ?? code ?? "unknown status"}`,
          ),
          { code, signal },
        );
        failed = true;
      }
    };
    const complete = (cleanupFailed: boolean, cleanupError?: unknown): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      const stdout = Buffer.concat(output).toString("utf8");
      const stderr = Buffer.concat(errors).toString("utf8");
      if (cleanupFailed) {
        if (failed && failure instanceof Error && Object.isExtensible(failure))
          Object.assign(failure, {
            cause: new AggregateError(
              [failure.cause, cleanupError].filter(Boolean),
              "Windows job cleanup was not confirmed",
            ),
          });
        else {
          failure = failed
            ? new AggregateError([failure, cleanupError], "Command and Windows job cleanup failed")
            : new Error("Windows job cleanup was not confirmed", { cause: cleanupError });
          failed = true;
        }
      }
      if (failed) {
        if (failure instanceof Error && !Object.isExtensible(failure))
          failure = new Error(failure.message, { cause: failure });
        if (failure instanceof Error)
          Object.assign(failure, {
            stdout,
            stderr,
            ...(cleanupFailed ? { cleanupFailure: cleanupError } : {}),
          });
        reject(failure);
      } else resolve({ stdout, stderr });
    };
    proc.once("close", (code, signal) => {
      recordExit(code, signal);
      void proc.jobClosed.then(
        () => complete(false),
        (error: unknown) => complete(true, error),
      );
    });
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    if (timeout !== undefined && remaining !== undefined && remaining <= 0) timedOut(timeout);
    proc.stdin.end();
  });
}

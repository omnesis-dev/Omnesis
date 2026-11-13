// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnWindowsJob } from "./windows-job.js";

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
  const proc = spawnWindowsJob(command, args, opts);
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
    const timer =
      opts.timeout && opts.timeout > 0
        ? setTimeout(
            () =>
              stop(
                Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", killed: true }),
              ),
            opts.timeout,
          )
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
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      const stdout = Buffer.concat(output).toString("utf8");
      const stderr = Buffer.concat(errors).toString("utf8");
      if (!failed && (code !== 0 || signal !== null)) {
        failure = Object.assign(
          new Error(stderr || `Command exited with ${signal ?? code ?? "unknown status"}`),
          { code, signal },
        );
        failed = true;
      }
      if (failed) {
        if (failure instanceof Error) Object.assign(failure, { stdout, stderr });
        reject(failure);
      } else resolve({ stdout, stderr });
    });
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    proc.stdin.end();
  });
}

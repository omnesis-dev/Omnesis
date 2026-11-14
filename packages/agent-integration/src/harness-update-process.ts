// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { resolveHarnessCommand } from "./harness-command.js";
import { spawnWindowsIntegrationCommand, type SpawnWindowsCommand } from "./windows-commands.js";

interface UpdateProcessResult {
  code: number | null;
  output: string;
  errors: string;
  failure?: "timeout" | "cancelled" | "spawn";
  cause?: unknown;
}
const CAPTURED_OUTPUT_BYTES = 8_000;

/** Existing injected spawn replaces the transport; native defaults own a Windows Job. */
export function runHarnessUpdateProcess(
  command: string,
  args: readonly string[],
  opts: {
    deadlineMs: number;
    signal?: AbortSignal;
    spawnFn?: typeof spawn;
    spawnJobFn?: SpawnWindowsCommand;
  },
): Promise<UpdateProcessResult> {
  if (opts.signal?.aborted)
    return Promise.resolve({ code: null, output: "", errors: "", failure: "cancelled" });
  if (opts.deadlineMs <= 0)
    return Promise.resolve({ code: null, output: "", errors: "", failure: "timeout" });
  return new Promise((resolve) => {
    const started = Date.now();
    const owned =
      opts.spawnJobFn !== undefined || (process.platform === "win32" && opts.spawnFn === undefined);
    let child: ReturnType<typeof spawn>;
    let ready: Promise<void> | undefined;
    try {
      const env = { ...process.env, NO_COLOR: "1" };
      if (owned) {
        const invocation = resolveHarnessCommand(command, args);
        const job = (opts.spawnJobFn ?? spawnWindowsIntegrationCommand)(
          invocation.command,
          invocation.args,
          {
            env,
            completion: "root",
            startupTimeoutMs: opts.deadlineMs,
          },
        );
        child = job;
        ready = job.jobReady;
      } else
        child = (opts.spawnFn ?? spawn)(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (cause) {
      const expired =
        Date.now() - started >= opts.deadlineMs ||
        (cause && typeof cause === "object" && "code" in cause && cause.code === "ETIMEDOUT");
      resolve({
        code: null,
        output: "",
        errors: "",
        failure: expired ? "timeout" : "spawn",
        cause,
      });
      return;
    }
    let output = "",
      errors = "",
      settled = false;
    let failure: UpdateProcessResult["failure"], cause: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, output, errors, ...(failure ? { failure, cause } : {}) });
    };
    const stop = (reason: "timeout" | "cancelled"): void => {
      if (settled || failure) return;
      failure = reason;
      child.kill("SIGKILL");
      // The owned helper's close event is the completion boundary. Preserve
      // the historical standalone POSIX/injected transport timeout behavior.
      if (!owned) finish(null);
    };
    const onAbort = (): void => stop("cancelled");
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-CAPTURED_OUTPUT_BYTES);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", (chunk: Buffer) => {
      collect(chunk);
      errors = `${errors}${chunk.toString()}`.slice(-CAPTURED_OUTPUT_BYTES);
    });
    child.on("error", (error: Error) => {
      if (!failure) {
        failure = "spawn";
        cause = error;
      }
      if (!owned) finish(null);
    });
    child.on("close", finish);
    if (ready)
      void ready.catch((error: unknown) => {
        if (!failure) {
          failure = "spawn";
          cause = error;
        }
      });
    if (owned) {
      try {
        child.stdin!.end();
      } catch (error) {
        failure = "spawn";
        cause = error;
        child.kill("SIGKILL");
      }
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    else {
      timer = setTimeout(
        () => stop("timeout"),
        Math.max(0, opts.deadlineMs - (Date.now() - started)),
      );
      timer.unref?.();
    }
  });
}

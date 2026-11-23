// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandTimeoutError, execWindowsJob } from "@omnesis/core";

export interface E2EBufferedCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}
export type E2EBufferedExecutor = (
  command: string,
  args: readonly string[],
  options: E2EBufferedCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const execPosix: E2EBufferedExecutor = async (command, args, options) => {
  const started = performance.now();
  try {
    return await execFileAsync(command, [...args], options);
  } catch (error) {
    throw namedPosixTimeout(error, command, args, options.timeout, performance.now() - started);
  }
};

/**
 * Node reports a command it stopped at its time limit as a generic failure
 * with `killed` set and no error code. Name the command, its limit and how
 * long it ran, as the Windows job does, and keep the captured output. Node's
 * own message repeats every argument, so it is not carried along.
 */
export function namedPosixTimeout(
  error: unknown,
  command: string,
  args: readonly string[],
  limitMs: number,
  elapsedMs: number,
): unknown {
  if (
    !(error instanceof Error) ||
    !(error as { killed?: unknown }).killed ||
    typeof (error as { code?: unknown }).code === "string" ||
    !(limitMs > 0) ||
    elapsedMs < limitMs
  )
    return error;
  const { stdout, stderr, signal } = error as {
    stdout?: unknown;
    stderr?: unknown;
    signal?: unknown;
  };
  return Object.assign(commandTimeoutError(command, args, limitMs, elapsedMs), {
    stdout,
    stderr,
    signal,
  });
}

/** Buffered capture keeps Windows descendants owned through timeout and join. */
export async function execE2EBufferedCommand(
  command: string,
  args: readonly string[],
  options: E2EBufferedCommandOptions,
  dependencies: {
    platform?: NodeJS.Platform;
    windows?: E2EBufferedExecutor;
    posix?: E2EBufferedExecutor;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const execute =
    (dependencies.platform ?? process.platform) === "win32"
      ? (dependencies.windows ?? execWindowsJob)
      : (dependencies.posix ?? execPosix);
  return execute(command, args, options);
}

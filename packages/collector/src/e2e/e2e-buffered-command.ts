// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execWindowsJob } from "@omnesis/core";

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
const execPosix: E2EBufferedExecutor = (command, args, options) =>
  execFileAsync(command, [...args], options);

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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { loadWindowsPlatformRuntime } from "./windows-files.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type WindowsCommandProcess = ChildProcessWithoutNullStreams & { jobReady: Promise<void> };
export interface WindowsCommandOptions {
  env: NodeJS.ProcessEnv;
  completion: "root";
  startupTimeoutMs: number;
}
export type SpawnWindowsCommand = (
  command: string,
  args: readonly string[],
  options: WindowsCommandOptions,
) => WindowsCommandProcess;
let spawnCommand: SpawnWindowsCommand | undefined;
/** Canonical kernel Job containment, also in the standalone generated asset closure. */
export function spawnWindowsIntegrationCommand(
  command: string,
  args: readonly string[],
  options: WindowsCommandOptions,
): WindowsCommandProcess {
  if (!spawnCommand) {
    const candidate = loadWindowsPlatformRuntime("windows-job");
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("spawnWindowsJob" in candidate) ||
      typeof candidate.spawnWindowsJob !== "function"
    )
      throw new Error("This Windows integration archive has an invalid private process runtime");
    spawnCommand = candidate.spawnWindowsJob as SpawnWindowsCommand;
  }
  return spawnCommand(command, args, options);
}

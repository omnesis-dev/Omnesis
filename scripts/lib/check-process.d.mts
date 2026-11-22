// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { runWindowsJob } from "@omnesis/core";

type SignalEmitter = Pick<EventEmitter, "on" | "removeListener">;

export interface CheckCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signalEmitter?: SignalEmitter;
  runWindows?: typeof runWindowsJob;
  detached?: boolean;
  retainUnconfirmed?: (failure: unknown) => void;
  /** Where a non-zero Windows job status is reported; process.stderr by default. */
  writeStderr?: (text: string) => void;
}

/** Resolves with the application exit code only after owned process cleanup. */
export function runCheckCommand(
  command: string,
  args: readonly string[],
  options?: CheckCommandOptions,
): Promise<number>;

export function checkFailureMessage(error: unknown): string;
export function childGroupIsAlive(child: ChildProcess): boolean;

export interface ChildWaitOptions {
  signalEmitter?: SignalEmitter;
  signalFn?: (child: ChildProcess, signal: NodeJS.Signals) => void | Promise<void>;
  termGraceMs?: number;
  killGraceMs?: number;
  groupIsAlive?: (child: ChildProcess) => boolean;
  windowsTree?: {
    readonly alive: boolean;
    refresh(): Promise<unknown>;
    kill(): Promise<unknown>;
  } | null;
}

export function waitForChild(child: ChildProcess, options?: ChildWaitOptions): Promise<number>;

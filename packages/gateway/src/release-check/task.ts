// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { PeriodicTask, TaskOutcome } from "../scheduler/types.js";

export const DEFAULT_RELEASE_CHECK_PERIOD_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_RELEASE_CHECK_START_DELAY_MS = 60 * 1000;
export const DEFAULT_RELEASE_CHECK_TIMEOUT_MS = 30 * 1000;

export interface ReleaseCheckPort {
  check(signal: AbortSignal): Promise<boolean>;
}

interface ReleaseCheckResult {
  checked: boolean;
}

/** One silent, bounded, gateway-owned release check on a daily cadence. */
export function createReleaseCheckTask(
  service: ReleaseCheckPort,
  options: {
    periodMs?: number;
    startDelayMs?: number;
    timeoutMs?: number;
  } = {},
): PeriodicTask<undefined, ReleaseCheckResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RELEASE_CHECK_TIMEOUT_MS;
  return {
    name: "release.check",
    runner: "main",
    priority: "background",
    periodMs: options.periodMs ?? DEFAULT_RELEASE_CHECK_PERIOD_MS,
    startDelayMs: options.startDelayMs ?? DEFAULT_RELEASE_CHECK_START_DELAY_MS,
    initialArgs: undefined,
    async run(_args, ctx): Promise<TaskOutcome<undefined, ReleaseCheckResult>> {
      try {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
        return { kind: "done", value: { checked: await service.check(signal) } };
      } catch {
        return { kind: "done", value: { checked: false } };
      }
    },
  };
}

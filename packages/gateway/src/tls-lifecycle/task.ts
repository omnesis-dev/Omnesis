// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { PeriodicTask, TaskOutcome } from "../scheduler/types.js";
import type { TlsLifecycleService } from "./service.js";

export const DEFAULT_TLS_LIFECYCLE_PERIOD_MS = 60 * 60 * 1000;
export const DEFAULT_TLS_LIFECYCLE_START_DELAY_MS = 30 * 1000;
export const DEFAULT_TLS_LIFECYCLE_TIMEOUT_MS = 2 * 60 * 1000;

interface TlsLifecycleResult {
  state: string;
}

/**
 * One hourly pass over the served certificate: pick up material replaced on
 * disk, and renew what Omnesis owns once it is inside the renewal band. The
 * service never rejects, so a tick always completes.
 */
export function createTlsLifecycleTask(
  service: Pick<TlsLifecycleService, "refresh">,
  options: { periodMs?: number; startDelayMs?: number; timeoutMs?: number } = {},
): PeriodicTask<undefined, TlsLifecycleResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TLS_LIFECYCLE_TIMEOUT_MS;
  return {
    name: "tls.lifecycle",
    runner: "main",
    priority: "background",
    // A renewal shells out to an issuer; that is expected to take seconds.
    latencyBudgetMs: timeoutMs,
    periodMs: options.periodMs ?? DEFAULT_TLS_LIFECYCLE_PERIOD_MS,
    startDelayMs: options.startDelayMs ?? DEFAULT_TLS_LIFECYCLE_START_DELAY_MS,
    initialArgs: undefined,
    async run(_args, ctx): Promise<TaskOutcome<undefined, TlsLifecycleResult>> {
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
      const snapshot = await service.refresh(signal);
      return { kind: "done", value: { state: snapshot.served.state } };
    },
  };
}

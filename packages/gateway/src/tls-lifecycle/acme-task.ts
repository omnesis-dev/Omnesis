// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import type { PeriodicTask } from "../scheduler/types.js";

/** ACME owns its dedicated files; the ordinary TLS lifecycle activates validated replacements. */
export function createAcmeRenewalTask(controller: {
  renew(signal: AbortSignal): Promise<boolean>;
}): PeriodicTask<undefined, { renewed: boolean }> {
  return {
    name: "tls.acme",
    runner: "main",
    priority: "background",
    latencyBudgetMs: 120_000,
    periodMs: 3_600_000,
    startDelayMs: 1000,
    initialArgs: undefined,
    async run(_args, context) {
      try {
        const renewed = await controller.renew(
          AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]),
        );
        return { kind: "done", value: { renewed } };
      } catch {
        createLogger("gateway:tls").warn(
          "ACME renewal failed; the existing gateway certificate remains in service",
        );
        return { kind: "done", value: { renewed: false } };
      }
    },
  };
}

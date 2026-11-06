// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { runBackfillTick, isIdleResult, type IdleResult } from "./backfill-helpers.js";
import type { Logger } from "@omnesis/core";
import type { WriteGate } from "../../write-gate.js";
import type { PeriodicTask } from "../types.js";

/** Native metadata projection shares the bounded metadata-backfill cadence. */
export function scopeFactsBackfillTask(deps: {
  writeGate: Pick<WriteGate, "backfillDocumentScopes">;
  peopleBatchSize: number;
  peopleBatchIntervalMs: number;
  peopleIdleDelayMs: number;
  log: Logger;
}): PeriodicTask<unknown, IdleResult> {
  const name = "backfill.scopeFacts";
  return {
    name,
    runner: "main",
    priority: "background",
    periodMs: deps.peopleBatchIntervalMs,
    idlePeriodMs: deps.peopleIdleDelayMs,
    startDelayMs: 2000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(name, deps.log, async () => {
        const result = await deps.writeGate.backfillDocumentScopes(deps.peopleBatchSize);
        return {
          idle:
            result.processed === 0 &&
            result.sourcesCompleted === 0 &&
            result.subjectsResolved === 0 &&
            (result.factsRebuilt ?? 0) === 0 &&
            (result.membershipProcessed ?? 0) === 0 &&
            (result.hierarchyProcessed ?? 0) === 0 &&
            (result.nativeReprojected ?? 0) === 0,
        };
      });
    },
  };
}

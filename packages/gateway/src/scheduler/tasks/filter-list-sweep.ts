// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Collects the rows of published filter lists that no read can reach: the
 * versions a newer publication replaced, the versions abandoned before they
 * were published, and the items of lists whose source or device is gone.
 *
 * Those rows are invisible from the moment they stop being current, so the
 * sweep is housekeeping and takes its time: one bounded writer operation per
 * tick, carrying on from where the last one stopped, and a long rest once a
 * whole pass has found nothing.
 */

import { runBackfillTick, isIdleResult, type IdleResult } from "./backfill-helpers.js";
import type { Logger } from "@omnesis/core";
import type { FilterListKey } from "../../data/repositories/SourceFilterListRepository.js";
import type { WriteGate } from "../../write-gate.js";
import type { PeriodicTask } from "../types.js";

export interface FilterListSweepOpts {
  writeGate: Pick<WriteGate, "sweepFilterListRows">;
  log: Logger;
  /** Cadence while a pass is under way or the last one deleted something. Default 1s. */
  periodMs?: number;
  /** Cadence after a pass that deleted nothing. Default 10min. */
  idlePeriodMs?: number;
  /** Rows deleted by one writer operation. Default 500. */
  batchSize?: number;
}

export function createFilterListSweepTask(
  opts: FilterListSweepOpts,
): PeriodicTask<unknown, IdleResult> {
  const name = "filterLists.sweep.tick";
  const batchSize = opts.batchSize ?? 500;
  let cursor: FilterListKey | null = null;
  let deletedThisPass = 0;
  return {
    name,
    runner: "main",
    priority: "background",
    periodMs: opts.periodMs ?? 1_000,
    idlePeriodMs: opts.idlePeriodMs ?? 10 * 60 * 1000,
    startDelayMs: 60_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(name, opts.log, async () => {
        const result = await opts.writeGate.sweepFilterListRows(cursor, batchSize);
        cursor = result.cursor;
        deletedThisPass += result.deleted;
        if (cursor !== null) return { idle: false };
        // The pass reached the end. One that deleted rows is followed by
        // another at once, since a publication may have completed behind it.
        const deleted = deletedThisPass;
        deletedThisPass = 0;
        if (deleted > 0) {
          opts.log.info(
            `Filter list sweep deleted ${deleted} unreachable row${deleted === 1 ? "" : "s"}`,
          );
        }
        return { idle: deleted === 0 };
      });
    },
  };
}

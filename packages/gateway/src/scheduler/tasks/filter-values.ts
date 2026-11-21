// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Cuts the filter rows of the records waiting for them
 * (`access/filter-values.ts`): records changed by a write other than the one
 * that stores a sync page, and every record of an account whose rows were
 * never cut or were cut under another declaration, which is how the rows of
 * the records already stored are written after an upgrade.
 *
 * One bounded step per tick: when a level of postings is full, its merge into
 * the next; otherwise a batch of queued records read and cut on the io worker
 * and applied by the writer, or, once the queue is empty, the next batch of
 * an account's records put on it. Until an account's rows are done, readers
 * decide its records from the records themselves.
 */

import { runBackfillTick, isIdleResult, type IdleResult } from "./backfill-helpers.js";
import type { Logger } from "@omnesis/core";
import type { IoGate } from "../io-ops.js";
import type { WriteGate } from "../../write-gate.js";
import type { PeriodicTask } from "../types.js";

export interface FilterValuesTaskOpts {
  ioGate: Pick<IoGate, "filterValueWork" | "filterPostingLevelToMerge">;
  writeGate: Pick<
    WriteGate,
    "applyFilterValueWork" | "advanceFilterValuePasses" | "mergeFilterPostings"
  >;
  log: Logger;
  /** Cadence while there is work. Default 200ms. */
  periodMs?: number;
  /** Cadence once nothing is left. Default 30s. */
  idlePeriodMs?: number;
  /** Records per step. Default 500. */
  batchSize?: number;
}

export function createFilterValuesTask(
  opts: FilterValuesTaskOpts,
): PeriodicTask<unknown, IdleResult> {
  const name = "filterValues.tick";
  const batchSize = opts.batchSize ?? 500;
  let cut = 0;
  return {
    name,
    runner: "main",
    priority: "background",
    periodMs: opts.periodMs ?? 200,
    idlePeriodMs: opts.idlePeriodMs ?? 30_000,
    startDelayMs: 5_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(name, opts.log, async () => {
        const full = await opts.ioGate.filterPostingLevelToMerge();
        if (full !== null) {
          await opts.writeGate.mergeFilterPostings(full);
          return { idle: false };
        }
        const work = await opts.ioGate.filterValueWork(batchSize);
        if (work.length > 0) {
          cut += (await opts.writeGate.applyFilterValueWork(work)).applied;
          return { idle: false };
        }
        const pass = await opts.writeGate.advanceFilterValuePasses(batchSize);
        if (!pass.changed && cut > 0) {
          opts.log.info(`Filter rows cut for ${cut} record${cut === 1 ? "" : "s"}`);
          cut = 0;
        }
        return { idle: !pass.changed };
      });
    },
  };
}

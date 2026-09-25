// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The (experimental) date-enrichment background pass.
 *
 * A `background`-priority periodic drip that, each tick, discovers documents
 * still needing extraction (`dates_extracted_at IS NULL`), extracts their
 * dates, and persists them — using the io → cpu → writer split so no stage
 * ever runs on the main event loop or the writer's own thread:
 *
 *   io  fetch a bounded batch (read-only pool)
 *   cpu extract dates anchored to each doc's emission date (compute pool)
 *   writer persist rows + stamp the flag (single writer, background priority)
 *
 * User-initiated reads run on the main-thread read handle and the io/cpu pools
 * are never used to serve them, so this pass cannot occupy a user-serving
 * worker. The one cpu op per tick keeps the compute pool gently loaded (one
 * worker at a time) rather than fanning out and saturating it.
 *
 * Gating: the work is done only when `experimentalEnabled()` AND the
 * `enrichment.dates.enabled` config knob are both on. Both are re-checked every
 * tick, so toggling either takes effect live (the task idles otherwise).
 */

import { experimentalEnabled, experimentalVisible, type Logger } from "@omnesis/core";

import { runWithPriority } from "../../priority.js";
import {
  runBackfillTick,
  isIdleResult,
  type IdleResult,
} from "../../scheduler/tasks/backfill-helpers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import { QueueTracker } from "../../background-jobs/trackers.js";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { PeriodicTask, TaskOutcome } from "../../scheduler/types.js";
import type { IoGate } from "../../scheduler/io-ops.js";
import type { CpuGate } from "../../scheduler/cpu-ops.js";
import type { WriteGate } from "../../write-gate.js";
import type { BackgroundJobsRegistry } from "../../background-jobs/registry.js";
import type { DateExtractionDocRow } from "./extractor.js";
import type { ResolvedDateEnrichmentSettings } from "./config.js";

export const DATE_EXTRACTION_TASK_NAME = "enrichment.extractDates";

/**
 * Docs per parallel cpu op. The tick fans its batch out into chunks of this
 * size across the cpu pool, so effective parallelism ≈ batchSize / CPU_CHUNK
 * (bounded by the pool's concurrency). Kept modest so a burst doesn't claim the
 * whole pool.
 */
// Docs per cpu op. Each doc is entitled to its scan budget, so the op's
// worst case is CPU_CHUNK × scanBudgetMs of synchronous work — kept small
// so a hostile batch parks a worker for seconds, not minutes, and the
// batch spreads across the pool.
const CPU_CHUNK = 8;

/** Whether the date-enrichment engine may run / be surfaced. */
export function dateEnrichmentStatus(getEnabled: () => boolean): {
  visible: boolean;
  active: boolean;
} {
  return {
    visible: experimentalVisible(),
    active: experimentalEnabled() && getEnabled(),
  };
}

interface DateExtractionTaskDeps {
  ioGate: IoGate;
  cpuGate: CpuGate;
  writeGate: WriteGate;
  getSettings: () => ResolvedDateEnrichmentSettings;
  tracker: QueueTracker;
  log: Logger;
}

export function dateExtractionTask(
  deps: DateExtractionTaskDeps,
): PeriodicTask<unknown, IdleResult> {
  const { ioGate, cpuGate, writeGate, getSettings, tracker, log } = deps;
  // Cadence is read once at construction (a periodic reads periodMs once);
  // batchSize / maxCharsPerDoc / scanBudgetMs / enabled are read live per tick.
  const { periodMs, idlePeriodMs } = getSettings();
  let total = 0;
  return {
    name: DATE_EXTRACTION_TASK_NAME,
    runner: "main",
    priority: "background",
    periodMs,
    idlePeriodMs,
    startDelayMs: 5_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      // Force background priority for the io / cpu / writer sub-ops regardless
      // of how this tick was dispatched. A kick from the document-upsert seam
      // fires inside the collector's realtime ingest scope; without this, the
      // fetch/extract/persist would inherit realtime and compete with ingest
      // and user requests — the exact contention this pass must never cause.
      return runBackfillTick(DATE_EXTRACTION_TASK_NAME, log, async () =>
        runWithPriority("background", async () => {
          const settings = getSettings();
          // Live gate: idle out cleanly if experimental / enabled flipped off.
          if (!(experimentalEnabled() && settings.enabled)) return { idle: true };

          const rows = await ioGate.fetchDateExtractionBatch(
            settings.batchSize,
            settings.maxCharsPerDoc,
          );
          if (rows.length === 0) {
            if (total > 0) {
              log.info(`date extraction caught up: ${total} docs processed this run`);
              total = 0;
            }
            return { idle: true };
          }
          // Fan the batch out across the cpu pool — chunks of CPU_CHUNK docs
          // extract in parallel — so a full-corpus backfill isn't serialized on
          // a single cpu worker (the recognizer runs ~hundreds of ms on a large
          // date-heavy doc). Still background priority: user reads run on the
          // main thread and never touch the cpu pool, so this cannot stall
          // them; it only shares the pool with other background compute, and the
          // pool's concurrency cap leaves headroom for the latency-sensitive
          // main/indexer threads. Parallelism scales with batchSize.
          const chunks: DateExtractionDocRow[][] = [];
          for (let i = 0; i < rows.length; i += CPU_CHUNK) {
            chunks.push(rows.slice(i, i + CPU_CHUNK));
          }
          const results = (
            await Promise.all(
              chunks.map((c) =>
                cpuGate.extractDatesFromDocs(c, {
                  maxCharsPerDoc: settings.maxCharsPerDoc,
                  scanBudgetMs: settings.scanBudgetMs,
                }),
              ),
            )
          ).flat();
          const { applied, datesWritten } = await writeGate.applyExtractedDates(results);
          total += applied;
          tracker.recordTick(applied);
          const prev = total - applied;
          if (Math.floor(prev / 1000) !== Math.floor(total / 1000)) {
            log.info(`date extraction progress: ${total} docs (+${datesWritten} dates this tick)`);
          }
          return { idle: false };
        }),
      );
    },
  };
}

export interface BootDateEnrichmentDeps {
  scheduler: Scheduler;
  backgroundJobs: BackgroundJobsRegistry;
  ioGate: IoGate;
  cpuGate: CpuGate;
  writeGate: WriteGate;
  getSettings: () => ResolvedDateEnrichmentSettings;
  /** Cheap count of documents still needing extraction — seeds the tracker. */
  countPending: () => number;
  log: Logger;
}

/**
 * Register the date-enrichment periodic pass. The task is always scheduled but
 * self-gates each tick, so the `enrichment.dates.enabled` knob toggles the pass
 * live (and it is inert when experimental mode is off). The background-jobs
 * surface is registered only when experimental is visible, so nothing
 * experimental shows on the jobs page otherwise.
 *
 * Returns a `kick` that fires the next tick immediately — wired to the
 * document-upsert seam so freshly ingested documents are picked up promptly.
 */
export function bootDateEnrichment(deps: BootDateEnrichmentDeps): { kick: () => void } {
  const tracker = new QueueTracker({ initialRemaining: safeCount(deps.countPending, deps.log) });
  const task = dateExtractionTask({
    ioGate: deps.ioGate,
    cpuGate: deps.cpuGate,
    writeGate: deps.writeGate,
    getSettings: deps.getSettings,
    tracker,
    log: deps.log,
  });
  deps.scheduler.schedule(task);

  if (experimentalVisible()) {
    const job = periodicJob(task, {
      scheduler: deps.scheduler,
      displayName: "Date extraction",
      description:
        "Extracts dates from every document's text, resolved against its emission date (experimental).",
      category: "indexer",
      tracker,
      isDisabled: () => !(experimentalEnabled() && deps.getSettings().enabled),
    });
    deps.backgroundJobs.registerAll([job]);
  }

  // The kick re-arms the periodic timer; when it fires from inside the
  // realtime ingest scope (onDocumentsUpserted), force background so the tick
  // doesn't inherit realtime.
  return {
    kick: () =>
      void runWithPriority("background", () =>
        deps.scheduler.kickPeriodic(DATE_EXTRACTION_TASK_NAME),
      ),
  };
}

function safeCount(count: () => number, log: Logger): number {
  try {
    return count();
  } catch (err) {
    log.warn(
      `date extraction: pending-count seed failed: ${err instanceof Error ? err.message : err}`,
    );
    return 0;
  }
}

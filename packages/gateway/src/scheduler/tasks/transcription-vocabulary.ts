// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { runBackfillTick, isIdleResult, type IdleResult } from "./backfill-helpers.js";
import type { Logger } from "@omnesis/core";
import type { VocabularySettings } from "../../transcribe/vocabulary/types.js";
import type { IoGate } from "../io-ops.js";
import type { CpuGate } from "../cpu-ops.js";
import type { WriteGate } from "../../write-gate.js";
import type { PeriodicTask } from "../types.js";
import type { EventBus } from "../../events.js";

/** One bounded page per tick, never a drain-until-empty loop. */
export function createTranscriptionVocabularyTask(deps: {
  ioGate: Pick<IoGate, "fetchTranscriptionVocabularyBatch">;
  cpuGate: Pick<CpuGate, "extractTranscriptionVocabulary">;
  writeGate: Pick<
    WriteGate,
    "applyTranscriptionVocabularyBatch" | "advanceTranscriptionVocabularyRebuild"
  >;
  getSettings(): VocabularySettings;
  log: Logger;
}): PeriodicTask<unknown, IdleResult> {
  const settings = deps.getSettings();
  const name = "transcription.vocabularyBackfill";
  return {
    name,
    runner: "main",
    priority: "background",
    periodMs: settings.periodMs,
    idlePeriodMs: settings.idlePeriodMs,
    startDelayMs: 1000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(name, deps.log, async () => {
        const current = deps.getSettings();
        if (!current.enabled) return { idle: true };
        const reset = await deps.writeGate.advanceTranscriptionVocabularyRebuild(current);
        if (!deps.getSettings().enabled) return { idle: true };
        if (!reset.ready) return { idle: !reset.worked };
        const docs = await deps.ioGate.fetchTranscriptionVocabularyBatch(current);
        if (!docs.length || !deps.getSettings().enabled) return { idle: true };
        const batch = await deps.cpuGate.extractTranscriptionVocabulary(docs, current);
        if (!deps.getSettings().enabled) return { idle: true };
        await deps.writeGate.applyTranscriptionVocabularyBatch(batch);
        return { idle: false };
      });
    },
  };
}

/**
 * Register the vocabulary periodic and wake it when a document's content
 * arrives, in one step. Kicking a periodic the scheduler has not registered
 * yet logs a warning, and documents can arrive as soon as the HTTP server
 * listens, so the wake subscription must never exist before the periodic
 * does. While the feature is off a wake would only run a tick that returns
 * idle at once, so arrivals leave the periodic on its own cadence.
 */
export function scheduleTranscriptionVocabulary(deps: {
  scheduler: {
    schedule(task: PeriodicTask<unknown, IdleResult>): { stop(): void };
    kickPeriodic(taskName: string): void;
  };
  eventBus: Pick<EventBus, "on">;
  task: PeriodicTask<unknown, IdleResult>;
  enabled(): boolean;
}): { stop(): void } {
  const handle = deps.scheduler.schedule(deps.task);
  const unsubscribe = deps.eventBus.on("document.upserted", () => {
    if (deps.enabled()) deps.scheduler.kickPeriodic(deps.task.name);
  });
  return {
    stop: () => {
      unsubscribe();
      handle.stop();
    },
  };
}

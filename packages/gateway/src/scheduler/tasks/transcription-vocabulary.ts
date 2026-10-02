// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Logger } from "@omnesis/core";
import type { VocabularySettings } from "../../transcribe/vocabulary/types.js";
import type { IoGate } from "../io-ops.js";
import type { CpuGate } from "../cpu-ops.js";
import type { WriteGate } from "../../write-gate.js";
import type { PeriodicTask } from "../types.js";
import { runBackfillTick, isIdleResult, type IdleResult } from "./backfill-helpers.js";

/** One bounded page per tick, never a drain-until-empty loop. */
export function createTranscriptionVocabularyTask(deps: {
  ioGate: Pick<IoGate, "fetchTranscriptionVocabularyBatch">;
  cpuGate: Pick<CpuGate, "extractTranscriptionVocabulary">;
  writeGate: Pick<WriteGate, "applyTranscriptionVocabularyBatch">;
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

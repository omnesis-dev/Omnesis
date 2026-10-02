// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { TranscriptionContext, TranscriptionVocabulary } from "@omnesis/core";
import type { IoGate } from "../../scheduler/io-ops.js";
import { getActivePriority, runWithPriority } from "../../priority.js";
import type { VocabularySettings } from "./types.js";

/** Bounded dictionary reads use the caller's priority, independent of extraction. */
export class TranscriptionVocabularyService {
  constructor(
    private readonly deps: {
      ioGate: Pick<IoGate, "getTranscriptionVocabulary">;
      getSettings: () => VocabularySettings;
    },
  ) {}

  enabled(): boolean {
    return this.deps.getSettings().enabled;
  }

  maxPromptTokens(): number {
    return this.deps.getSettings().maxPromptTokens;
  }

  async getDictionary(context: TranscriptionContext): Promise<TranscriptionVocabulary> {
    const settings = this.deps.getSettings();
    if (!settings.enabled) return { entries: [] };
    const vocabulary = await runWithPriority(getActivePriority() ?? "user", () =>
      this.deps.ioGate.getTranscriptionVocabulary(context, settings),
    );
    return this.enabled() ? vocabulary : { entries: [] };
  }
}

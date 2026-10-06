// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { OmnesisConfig } from "@omnesis/config";
import type { VocabularySettings } from "./types.js";

/** Live configuration gates both background materialization and inference hints. */
export function resolveVocabularySettings(config: OmnesisConfig): VocabularySettings {
  const settings = config.inference?.transcriptionVocabulary;
  return {
    enabled: settings?.enabled === true,
    authoredWeight: settings?.authoredWeight ?? 4,
    machineEvidenceWeight: settings?.machineEvidenceWeight ?? 0.15,
    contextPriorDocuments: settings?.contextPriorDocuments ?? 10,
    rarityWeight: settings?.rarityWeight ?? 0.5,
    contextLiftWeight: settings?.contextLiftWeight ?? 0.25,
    maxTerms: settings?.maxTerms ?? 64,
    maxPromptTokens: settings?.maxPromptTokens ?? 96,
    batchSize: settings?.batchSize ?? 4,
    maxDocumentChars: settings?.maxDocumentChars ?? 32768,
    maxTermsPerDocument: settings?.maxTermsPerDocument ?? 64,
    periodMs: settings?.periodMs ?? 1000,
    idlePeriodMs: settings?.idlePeriodMs ?? 60000,
  };
}

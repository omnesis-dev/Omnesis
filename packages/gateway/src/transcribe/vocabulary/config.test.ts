// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { omnesisConfigSchema } from "@omnesis/config";
import { resolveVocabularySettings } from "./config.js";

describe("transcription vocabulary settings", () => {
  test.each([
    {},
    { inference: {} },
    { inference: { transcriptionVocabulary: {} } },
    { inference: { transcriptionVocabulary: { maxTerms: 8 } } },
    { inference: { transcriptionVocabulary: { enabled: false } } },
  ])("omitted or disabled opt-in does not activate vocabulary: %j", (config) => {
    expect(resolveVocabularySettings(omnesisConfigSchema.parse(config)).enabled).toBe(false);
  });

  test("explicit opt-in preserves bounded settings", () => {
    expect(
      resolveVocabularySettings(
        omnesisConfigSchema.parse({
          inference: { transcriptionVocabulary: { enabled: true, maxTerms: 8 } },
        }),
      ),
    ).toMatchObject({
      enabled: true,
      maxTerms: 8,
      batchSize: 4,
      maxPromptTokens: 96,
      authoredWeight: 4,
      machineEvidenceWeight: 0.15,
      contextPriorDocuments: 10,
      authoredRarityWeight: 0.5,
      authoredContextLiftWeight: 0.25,
    });
  });
  test("relevance blend weights have bounded overrides", () => {
    for (const settings of [
      { authoredRarityWeight: 0, authoredContextLiftWeight: 0 },
      { authoredRarityWeight: 1, authoredContextLiftWeight: 1 },
      { authoredRarityWeight: 0.4, authoredContextLiftWeight: 0.3 },
    ]) {
      expect(
        resolveVocabularySettings(
          omnesisConfigSchema.parse({
            inference: { transcriptionVocabulary: settings },
          }),
        ),
      ).toMatchObject(settings);
    }
    for (const settings of [
      { authoredRarityWeight: -0.1 },
      { authoredRarityWeight: 1.1 },
      { authoredContextLiftWeight: -0.1 },
      { authoredContextLiftWeight: 1.1 },
      { authoredRarityWeight: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        omnesisConfigSchema.safeParse({
          inference: { transcriptionVocabulary: settings },
        }).success,
      ).toBe(false);
    }
  });
  test("authored relevance weight is bounded and can disable the bonus", () => {
    for (const authoredWeight of [0, 2.5, 32]) {
      expect(
        resolveVocabularySettings(
          omnesisConfigSchema.parse({ inference: { transcriptionVocabulary: { authoredWeight } } }),
        ).authoredWeight,
      ).toBe(authoredWeight);
    }
    for (const authoredWeight of [-1, 33, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(
        omnesisConfigSchema.safeParse({
          inference: { transcriptionVocabulary: { authoredWeight } },
        }).success,
      ).toBe(false);
    }
  });
  test("machine evidence and cohort smoothing preserve defaults and bounded overrides", () => {
    expect(resolveVocabularySettings(omnesisConfigSchema.parse({}))).toMatchObject({
      machineEvidenceWeight: 0.15,
      contextPriorDocuments: 10,
    });
    for (const settings of [
      { machineEvidenceWeight: 0, contextPriorDocuments: 0.1 },
      { machineEvidenceWeight: 1, contextPriorDocuments: 10000 },
    ]) {
      expect(
        resolveVocabularySettings(
          omnesisConfigSchema.parse({ inference: { transcriptionVocabulary: settings } }),
        ),
      ).toMatchObject(settings);
    }
    for (const settings of [
      { machineEvidenceWeight: -0.1 },
      { machineEvidenceWeight: 1.1 },
      { contextPriorDocuments: 0 },
      { contextPriorDocuments: 10001 },
      { contextPriorDocuments: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        omnesisConfigSchema.safeParse({ inference: { transcriptionVocabulary: settings } }).success,
      ).toBe(false);
    }
  });
});

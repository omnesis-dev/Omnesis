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
    ).toMatchObject({ enabled: true, maxTerms: 8, batchSize: 4, maxPromptTokens: 224 });
  });
});

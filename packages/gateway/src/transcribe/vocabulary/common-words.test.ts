// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { isCommonVocabularyWord } from "./common-words.js";
import { commonWordsData } from "./common-words-data.js";

describe("bundled common-word evidence", () => {
  test("excludes ordinary lexical vocabulary beyond stopwords in seven languages", () => {
    for (const [language, word] of [
      ["en", "information"],
      ["fr", "travail"],
      ["es", "trabajo"],
      ["de", "arbeit"],
      ["it", "lavoro"],
      ["pt", "trabalho"],
      ["nl", "werken"],
    ]) {
      expect(isCommonVocabularyWord(word!, [language!])).toBe(true);
      expect(isCommonVocabularyWord(word!)).toBe(true);
    }
    expect(isCommonVocabularyWord("Zorvexal")).toBe(false);
  });

  test("uses BCP47 hints, mixed languages, and NFC without removing accents", () => {
    expect(isCommonVocabularyWord("TRAVAIL", ["fr-FR"])).toBe(true);
    expect(isCommonVocabularyWord("travail", ["en-US"])).toBe(false);
    expect(isCommonVocabularyWord("travail", ["en-US", "fr-CA"])).toBe(true);
    expect(isCommonVocabularyWord("e\u0301te\u0301", ["fr"])).toBe(true);
    expect(isCommonVocabularyWord("trabajo", ["ja"])).toBe(false);
    expect(isCommonVocabularyWord("two words", ["en"])).toBe(false);
  });

  test("ships bounded lexical lists and notices alongside the derived data", () => {
    expect(Object.keys(commonWordsData.languages)).toEqual([
      "en",
      "fr",
      "es",
      "de",
      "it",
      "pt",
      "nl",
    ]);
    for (const words of Object.values(commonWordsData.languages)) {
      const list = words.split(" ");
      expect(list).toHaveLength(5000);
      expect(new Set(list).size).toBe(5000);
      expect(list.every((word) => /^\p{L}[\p{L}\p{M}]*(?:['’.-][\p{L}\p{M}]+)*$/u.test(word))).toBe(
        true,
      );
    }
    expect(commonWordsData.version).toBe("3.1.1");
    expect(commonWordsData.license).toBe("CC-BY-SA-4.0");
    expect(commonWordsData.upstreamAttribution).toContain("SUBTLEX is freely available data");
    expect(commonWordsData.upstreamAttribution).toContain("Keuleers");
    expect(commonWordsData.dataLicenseText).toContain("Attribution-ShareAlike 4.0 International");
  });
});

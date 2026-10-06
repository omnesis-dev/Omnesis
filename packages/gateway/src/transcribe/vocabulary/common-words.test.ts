// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { isCommonVocabularyWord, normalizeVocabularyTerm } from "./common-words.js";
import { commonWordsData } from "./common-words-data.js";

describe("bundled common-word evidence", () => {
  test("loads lexical sets only on first use and reuses them", async () => {
    let reads = 0;
    vi.resetModules();
    vi.doMock("./common-words-data.js", () => ({
      commonWordsData: {
        get languages() {
          reads++;
          return { en: "ordinary a", fr: "travail été" };
        },
      },
    }));
    try {
      const lexical = await import("./common-words.js");
      expect(reads).toBe(0);
      expect(lexical.isCommonVocabularyWord("ordinary", ["en"])).toBe(true);
      expect(reads).toBe(1);
      expect(lexical.isCommonVocabularyWord("travail")).toBe(true);
      expect(lexical.isCommonVocabularyWord("ordinary", ["fr"])).toBe(false);
      // Independent components in different languages cannot manufacture a
      // frequent elision that no single lexical list supports.
      expect(lexical.isCommonVocabularyWord("a'été")).toBe(false);
      expect(lexical.isCommonVocabularyWord("ordinary-travail")).toBe(false);
      expect(reads).toBe(1);
    } finally {
      vi.doUnmock("./common-words-data.js");
      vi.resetModules();
    }
  });

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

  test("frequent contractions and elisions share quote normalization without losing rare names", () => {
    for (const word of ["don't", "don’t", "don‘t", "we're", "we’re", "I'm", "I’m"])
      expect(isCommonVocabularyWord(word, ["en"])).toBe(true);
    for (const word of [
      "c'est",
      "c’est",
      "c‘est",
      "j'ai",
      "j’ai",
      "l'été",
      "l’été",
      "l'heure",
      "qu'un",
      "aujourd’hui",
    ])
      expect(isCommonVocabularyWord(word, ["fr"])).toBe(true);
    for (const word of ["d'Orvelion", "d’Orvelion", "O'Zorvella", "O’Zorvella", "l'Élanor"])
      expect(isCommonVocabularyWord(word)).toBe(false);
    expect(isCommonVocabularyWord("c’est", ["ja"])).toBe(false);
    expect(isCommonVocabularyWord("l'été", ["fr"])).toBe(true);
    expect(isCommonVocabularyWord("l'Élanor", ["fr"])).toBe(false);
  });

  test("frequent inflected words and hyphen components retain same-language evidence", () => {
    for (const [word, language] of [
      ["working", "en"],
      ["travaux", "fr"],
      ["arbeiten", "de"],
      ["trabajos", "es"],
      ["lavori", "it"],
      ["trabalhos", "pt"],
      ["werken", "nl"],
    ])
      expect(isCommonVocabularyWord(word!, [language!])).toBe(true);
    expect(isCommonVocabularyWord("work-home", ["en"])).toBe(true);
    expect(isCommonVocabularyWord("l’été-travail", ["fr"])).toBe(true);
    expect(isCommonVocabularyWord("work‐home", ["en"])).toBe(true);
    expect(isCommonVocabularyWord("work-Zorvella", ["en"])).toBe(false);
    expect(isCommonVocabularyWord("Zorvella-Navrel")).toBe(false);
    expect(isCommonVocabularyWord("work--home", ["en"])).toBe(false);
  });

  test("canonical keys unify equivalent typography without erasing lexical identity", () => {
    expect(normalizeVocabularyTerm("O’Zorvella")).toBe("o'zorvella");
    expect(normalizeVocabularyTerm("Zorvella‐Navrel")).toBe("zorvella-navrel");
    expect(normalizeVocabularyTerm("Zorvella‑Navrel")).toBe("zorvella-navrel");
    expect(normalizeVocabularyTerm("Zorvella－Navrel")).toBe("zorvella-navrel");
    expect(normalizeVocabularyTerm("ZE\u0301LOR")).toBe("zélor");
    expect(normalizeVocabularyTerm("Zélor")).not.toBe(normalizeVocabularyTerm("Zelor"));
    expect(normalizeVocabularyTerm("Zorvella—Navrel")).toBe("zorvella—navrel");
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

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import {
  hasMixedVocabularyCase,
  observeVocabularySpelling,
  selectVocabularySpelling,
  vocabularySpellingBenefit,
  vocabularySpellingConfidence,
  type VocabularySpellingObservation,
} from "./spelling.js";

test("counts exact spellings and chooses evidence over capitalization benefit", () => {
  const variants = new Map<string, VocabularySpellingObservation>();
  for (const text of ["vElQuOrIn", "Velquorin", "Velquorin"])
    observeVocabularySpelling(variants, text);
  expect(selectVocabularySpelling(variants.values())).toEqual({
    text: "Velquorin",
    benefit: 2,
    count: 2,
  });
});

test("ties are independent of input order and capitalization benefit", () => {
  const variants = [
    { text: "Zilora", benefit: 2, count: 3 },
    { text: "ZiLora", benefit: 2.5, count: 3 },
  ];
  expect(selectVocabularySpelling(variants)).toEqual(
    selectVocabularySpelling([...variants].reverse()),
  );
  expect(selectVocabularySpelling([])).toBeUndefined();
});

test("the selected spelling retains its own benefit, including genuine mixed-case brands", () => {
  const variants = new Map<string, VocabularySpellingObservation>();
  observeVocabularySpelling(variants, "myOS", undefined, 2);
  observeVocabularySpelling(variants, "MYOS");
  expect(selectVocabularySpelling(variants.values())).toEqual({
    text: "myOS",
    benefit: 2.5,
    count: 2,
  });
  expect(vocabularySpellingBenefit("ZORVEL")).toBe(1);
  expect(vocabularySpellingBenefit("Zélor")).toBe(2);
  expect(vocabularySpellingBenefit("zélor")).toBe(1);
  expect(hasMixedVocabularyCase("myOS")).toBe(true);
  expect(hasMixedVocabularyCase("Zélor O'Vantix")).toBe(false);
});

test("frequent-word typos receive confidence penalties without becoming corrections", () => {
  for (const text of ["becausse", "Becausse", "becuase", "improtante", "infromation", "peoplse"])
    expect(vocabularySpellingConfidence(text)).toBeLessThan(1);
  expect(vocabularySpellingConfidence("becausse")).toBe(0.25);
  expect(vocabularySpellingConfidence("sequencex")).toBe(0.5);
  expect(vocabularySpellingConfidence("because")).toBe(1);
  expect(vocabularySpellingConfidence("x".repeat(10000))).toBe(1);
});

test("grounded names, short nicknames, accents, acronyms and deliberate casing avoid typo guesses", () => {
  for (const text of ["Zorvella", "becausse", "Becausse"])
    expect(vocabularySpellingConfidence(text, true)).toBe(1);
  for (const text of [
    "BECUASE",
    "BeCuase",
    "myOS",
    "Zélor",
    "Zorvexal",
    "Véllora",
    "bécausse",
    "Coco",
    "Lulu",
  ])
    expect(vocabularySpellingConfidence(text)).toBe(1);
});

test("typographic variants share a term key while evidence retains each original spelling", async () => {
  const { normalizeVocabularyTerm } = await import("./common-words.js");
  const byTerm = new Map<string, Map<string, VocabularySpellingObservation>>();
  for (const text of [
    "O’Zorvella",
    "O'Zorvella",
    "O’Zorvella",
    "Zorvella‑Navrel",
    "Zorvella-Navrel",
  ]) {
    const key = normalizeVocabularyTerm(text);
    const variants = byTerm.get(key) ?? new Map<string, VocabularySpellingObservation>();
    observeVocabularySpelling(variants, text);
    byTerm.set(key, variants);
  }
  expect(byTerm.size).toBe(2);
  expect(selectVocabularySpelling(byTerm.get("o'zorvella")!.values())?.text).toBe("O’Zorvella");
  expect(byTerm.get("zorvella-navrel")?.size).toBe(2);
  expect(normalizeVocabularyTerm("Zélor")).not.toBe(normalizeVocabularyTerm("Zelor"));
});

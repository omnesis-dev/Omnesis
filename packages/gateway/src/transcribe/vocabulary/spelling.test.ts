// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import {
  hasMixedVocabularyCase,
  observeVocabularySpelling,
  selectVocabularySpelling,
  vocabularySpellingBenefit,
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

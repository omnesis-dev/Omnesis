// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { contextualVocabularyLift } from "./ranking.js";

test("the same term support is more distinctive in a small relationship profile", () => {
  const background = { globalOccurrences: 10, globalDocuments: 1000, profileOccurrences: 2 };
  expect(contextualVocabularyLift({ ...background, profileDocuments: 5 })).toBeGreaterThan(2);
  expect(contextualVocabularyLift({ ...background, profileDocuments: 500 })).toBe(1);
});

test("broad boilerplate receives no additional contextual boost", () => {
  expect(
    contextualVocabularyLift({
      profileOccurrences: 70,
      profileDocuments: 100,
      globalOccurrences: 700,
      globalDocuments: 1000,
    }),
  ).toBeCloseTo(1, 3);
});

test("the prior shrinks sparse context while keeping lift bounded", () => {
  const evidence = {
    profileOccurrences: 2,
    profileDocuments: 2,
    globalOccurrences: 2,
    globalDocuments: 1000,
  };
  expect(contextualVocabularyLift(evidence, 1000)).toBeLessThan(
    contextualVocabularyLift(evidence, 10)!,
  );
  expect(contextualVocabularyLift(evidence, 0)).toBe(3);
});

test.each([
  { profileOccurrences: 1, profileDocuments: 5, globalOccurrences: 2, globalDocuments: 100 },
  { profileOccurrences: 2, profileDocuments: 5, globalOccurrences: 1, globalDocuments: 100 },
  { profileOccurrences: 6, profileDocuments: 5, globalOccurrences: 7, globalDocuments: 100 },
  { profileOccurrences: 3, profileDocuments: 5, globalOccurrences: 2, globalDocuments: 100 },
  { profileOccurrences: 2, profileDocuments: 5, globalOccurrences: 101, globalDocuments: 100 },
  { profileOccurrences: 2, profileDocuments: 105, globalOccurrences: 2, globalDocuments: 100 },
  {
    profileOccurrences: 2,
    profileDocuments: 5,
    globalOccurrences: Number.NaN,
    globalDocuments: 100,
  },
])("missing or incoherent cohort evidence leaves legacy ranking intact: %j", (evidence) => {
  expect(contextualVocabularyLift(evidence)).toBeUndefined();
});

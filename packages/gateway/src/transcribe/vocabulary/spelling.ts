// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { commonVocabularySpellingConfidence } from "./common-words.js";

/** Counts within one document choose a spelling; they never corroborate a term. */
export interface VocabularySpellingObservation {
  text: string;
  benefit: number;
  count: number;
}

export const hasMixedVocabularyCase = (text: string): boolean => /\p{Ll}\p{Lu}/u.test(text);

/** Recognition difficulty belongs to the selected spelling, not a discarded variant. */
export function vocabularySpellingBenefit(text: string): number {
  const uppercase = /\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text);
  return uppercase ? 1 : hasMixedVocabularyCase(text) ? 2.5 : /^\p{Lu}/u.test(text) ? 2 : 1;
}

export function observeVocabularySpelling(
  variants: Map<string, VocabularySpellingObservation>,
  text: string,
  benefit = vocabularySpellingBenefit(text),
  occurrences = 1,
): void {
  const prior = variants.get(text);
  variants.set(text, {
    text,
    benefit: Math.max(prior?.benefit ?? 0, benefit),
    count: (prior?.count ?? 0) + occurrences,
  });
}

/** Ties use code-point order, independent of locale and extraction order. */
export function selectVocabularySpelling(
  variants: Iterable<VocabularySpellingObservation>,
): VocabularySpellingObservation | undefined {
  let selected: VocabularySpellingObservation | undefined;
  for (const variant of variants)
    if (
      !selected ||
      variant.count > selected.count ||
      (variant.count === selected.count && variant.text < selected.text)
    )
      selected = variant;
  return selected;
}

/** Grounded names and deliberate mixed-case/acronym spellings keep full trust. */
export function vocabularySpellingConfidence(text: string, grounded = false): number {
  if (grounded || hasMixedVocabularyCase(text) || (/\p{Lu}/u.test(text) && !/\p{Ll}/u.test(text)))
    return 1;
  return commonVocabularySpellingConfidence(text);
}

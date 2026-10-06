// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isCommonVocabularyWord } from "./common-words.js";

/**
 * Structural chat noise is independent of a user's private vocabulary. Known
 * people/identity names bypass it. Short doubled nicknames retain their shape;
 * these checks do not blacklist particular words or rewrite candidate spelling.
 */
export function vocabularyLexicalQuality(
  text: string,
  options: { grounded?: boolean } = {},
): number {
  if (options.grounded) return 1;
  // Lowercase eyes and a repeated same-letter mouth form a typed expression.
  // All-uppercase tokens remain eligible as acronyms; no spelling is rewritten.
  if (/^x([dDpP])\1{1,7}$/u.test(text)) return 0;
  const word = text.normalize("NFC").toLocaleLowerCase("und");
  if (!/^[\p{L}\p{M}]{4,48}$/u.test(word)) return 1;
  if (/^(\p{L})\1{3,}$/u.test(word)) return 0;
  // Three repeated consonant/vowel syllables capture extended laughter or
  // chat stutters; two repeats remain eligible as ordinary short nicknames.
  if (
    /^([^aeiouy\W\d_][aeiouy])\1{2,}$/u.test(word) ||
    /^[aeiouy]([^aeiouy\W\d_][aeiouy])\1{2,}$/u.test(word)
  )
    return 0;
  if (/(\p{L})\1{2,}/u.test(word)) {
    // Deliberate uppercase acronyms must not collapse into a common word.
    if (/^[A-Z]+$/u.test(text)) return 1;
    const collapsed = word.replace(/(\p{L})\1{2,}/gu, "$1");
    const doubled = word.replace(/(\p{L})\1{2,}/gu, "$1$1");
    if (isCommonVocabularyWord(collapsed) || isCommonVocabularyWord(doubled)) return 0;
  }
  return 1;
}

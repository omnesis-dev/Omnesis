// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { commonWordsData } from "./common-words-data.js";

const lists = new Map<string, ReadonlySet<string>>(
  Object.entries(commonWordsData.languages).map(([language, words]) => [
    language,
    new Set(words.split(" ")),
  ]),
);
const allLanguages = [...lists.values()];

/**
 * High-frequency lexical membership, not dictionary validity or an estimate of
 * recognition accuracy. Accents remain significant. With no language hint the
 * supported-language union avoids mistaking ordinary foreign words for private
 * vocabulary; explicit unsupported languages have no frequency evidence.
 *
 * The bundled subset retains wordfreq's complete attribution and CC-BY-SA
 * license in its distributable data module. It is intentionally not a full
 * implementation of wordfreq's language-specific tokenization/frequency API.
 */
export function isCommonVocabularyWord(text: string, languageHints?: readonly string[]): boolean {
  const word = text.normalize("NFC").toLocaleLowerCase("und");
  if (!languageHints?.length) return allLanguages.some((list) => list.has(word));
  return languageHints.some((hint) => {
    const language = hint.toLowerCase().split(/[-_]/u)[0];
    return language ? (lists.get(language)?.has(word) ?? false) : false;
  });
}

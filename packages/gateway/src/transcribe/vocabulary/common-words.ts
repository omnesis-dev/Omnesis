// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { commonWordsData } from "./common-words-data.js";

let cachedLists:
  | { languages: Map<string, ReadonlySet<string>>; allLanguages: ReadonlySet<string>[] }
  | undefined;

/** Disabled vocabulary workers import the module without allocating lexical sets. */
function getLists(): NonNullable<typeof cachedLists> {
  if (!cachedLists) {
    const languages = new Map<string, ReadonlySet<string>>(
      Object.entries(commonWordsData.languages).map(([language, words]) => [
        language,
        new Set(words.split(" ")),
      ]),
    );
    cachedLists = { languages, allLanguages: [...languages.values()] };
  }
  return cachedLists;
}

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
  const lists = getLists();
  if (!languageHints?.length) return lists.allLanguages.some((list) => list.has(word));
  return languageHints.some((hint) => {
    const language = hint.toLowerCase().split(/[-_]/u)[0];
    return language ? (lists.languages.get(language)?.has(word) ?? false) : false;
  });
}

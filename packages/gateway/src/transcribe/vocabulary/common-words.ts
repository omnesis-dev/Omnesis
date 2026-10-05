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
 * Apostrophe elision follows the short-prefix/vowel boundary described by
 * Unicode UAX #29 WB5a and used by wordfreq's tokenizer. This bounded membership
 * check needs frequent components in the same language; it does not estimate
 * the compound frequency or split uncommon names into replacement candidates.
 * https://www.unicode.org/reports/tr29/#Apostrophe
 */
function hasCommonLexicalForm(word: string, list: ReadonlySet<string>): boolean {
  if (list.has(word)) return true;
  const elision = /^([\p{L}]{1,2})'([\p{L}][\p{L}\p{M}']*)$/u.exec(word);
  if (!elision) return false;
  const [, prefix, suffix] = elision;
  // Normalize only the first character for boundary classification. Lexical
  // membership still distinguishes accented words throughout the suffix.
  const initial = suffix![0]!.normalize("NFD")[0]!;
  return /^[aehiouyæœ]$/u.test(initial) && list.has(prefix!) && list.has(suffix!);
}

/**
 * High-frequency lexical membership, not dictionary validity or an estimate of
 * recognition accuracy. Accents remain significant. With no language hint the
 * supported-language union avoids mistaking ordinary foreign words for private
 * vocabulary; explicit unsupported languages have no frequency evidence.
 * Quote glyphs are canonicalized for lookup only. Short-prefix elisions require
 * every component to be frequent in one supported language; rare tails remain
 * candidates. This membership approximation does not assign compound frequency.
 *
 * The bundled subset retains wordfreq's complete attribution and CC-BY-SA
 * license in its distributable data module. It is intentionally not a full
 * implementation of wordfreq's language-specific tokenization/frequency API.
 */
export function isCommonVocabularyWord(text: string, languageHints?: readonly string[]): boolean {
  const word = text.normalize("NFC").toLocaleLowerCase("und").replace(/[‘’]/gu, "'");
  const lists = getLists();
  if (!languageHints?.length)
    return lists.allLanguages.some((list) => hasCommonLexicalForm(word, list));
  return languageHints.some((hint) => {
    const language = hint.toLowerCase().split(/[-_]/u)[0];
    const list = language ? lists.languages.get(language) : undefined;
    return list ? hasCommonLexicalForm(word, list) : false;
  });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { commonWordsData } from "./common-words-data.js";

/** Canonical term keys retain accents and spelling while unifying equivalent typography. */
export function normalizeVocabularyTerm(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("und")
    .replace(/[‘’]/gu, "'")
    .replace(/[‐‑﹣－]/gu, "-");
}

let cachedLists:
  | { languages: Map<string, ReadonlySet<string>>; allLanguages: ReadonlySet<string>[] }
  | undefined;

/** Standard calendar words come from locale data, never a private corpus. */
function calendarVocabularyForms(language: string): Set<string> {
  const words = new Set<string>();
  // A runtime without this locale must not add fallback English to its list.
  if (!Intl.DateTimeFormat.supportedLocalesOf([language]).length) return words;
  for (const width of ["long", "short"] as const) {
    const formatter = new Intl.DateTimeFormat(language, {
      weekday: width,
      month: width,
      timeZone: "UTC",
      calendar: "gregory",
    });
    // Seven consecutive days cover weekdays; twelve month starts cover months.
    for (let index = 0; index < 19; index++) {
      const date = new Date(Date.UTC(2020, index < 7 ? 0 : index - 7, index < 7 ? 6 + index : 1));
      for (const part of formatter.formatToParts(date)) {
        if (part.type !== "weekday" && part.type !== "month") continue;
        const word = normalizeVocabularyTerm(part.value).replace(/\p{P}+$/gu, "");
        if (word) words.add(word);
      }
    }
  }
  return words;
}

/** Disabled vocabulary workers import the module without allocating lexical sets. */
function getLists(): NonNullable<typeof cachedLists> {
  if (!cachedLists) {
    const languages = new Map<string, ReadonlySet<string>>(
      Object.entries(commonWordsData.languages).map(([language, words]) => [
        language,
        new Set([...words.split(" "), ...calendarVocabularyForms(language)]),
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
  const compound = word.split(/[-‐‑]/u);
  if (
    compound.length > 1 &&
    compound.length <= 4 &&
    compound.every((part) => part.length > 0 && hasCommonLexicalForm(part, list))
  )
    return true;
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
 * recognition accuracy. Standard Gregorian calendar names supplement the
 * frequency subset using runtime locale data. Accents remain significant. With
 * no language hint the
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
  const word = normalizeVocabularyTerm(text);
  const lists = getLists();
  if (!languageHints?.length)
    return lists.allLanguages.some((list) => hasCommonLexicalForm(word, list));
  return languageHints.some((hint) => {
    const language = hint.toLowerCase().split(/[-_]/u)[0];
    const list = language ? lists.languages.get(language) : undefined;
    return list ? hasCommonLexicalForm(word, list) : false;
  });
}

interface CommonSpellingIndex {
  exact: ReadonlyMap<string, number>;
  deletions: ReadonlyMap<string, readonly string[]>;
}
let spellingIndex: CommonSpellingIndex | undefined;
const normalizedLexicalWord = normalizeVocabularyTerm;

/** One bounded index is built only when typo confidence is first requested. */
function getSpellingIndex(): CommonSpellingIndex {
  if (spellingIndex) return spellingIndex;
  const exact = new Map<string, number>();
  for (const words of Object.values(commonWordsData.languages))
    words.split(" ").forEach((word, index) => {
      const normalized = normalizedLexicalWord(word);
      if (!/^[a-z]{5,16}$/u.test(normalized)) return;
      exact.set(normalized, Math.min(exact.get(normalized) ?? Infinity, index));
    });
  const deletions = new Map<string, string[]>();
  for (const word of exact.keys())
    for (let index = 0; index < word.length; index++) {
      const deleted = word.slice(0, index) + word.slice(index + 1);
      const bucket = deletions.get(deleted) ?? [];
      if (bucket.length < 16 && !bucket.includes(word)) bucket.push(word);
      deletions.set(deleted, bucket);
    }
  spellingIndex = { exact, deletions };
  return spellingIndex;
}

/**
 * A soft confidence penalty, not correction or dictionary invalidity. Compare
 * ASCII spellings only so accent differences never manufacture typo evidence.
 * Each query inspects at most 16 candidates per deletion signature, plus its
 * own one-letter deletions and adjacent transpositions; no lexical-list scan.
 */
export function commonVocabularySpellingConfidence(text: string): number {
  const word = normalizedLexicalWord(text);
  if (!/^[a-z]{6,16}$/u.test(word) || isCommonVocabularyWord(word)) return 1;
  const index = getSpellingIndex();
  let rank = Infinity;
  const consider = (candidate: string): void => {
    const candidateRank = index.exact.get(candidate);
    if (candidateRank !== undefined) rank = Math.min(rank, candidateRank);
  };
  // One inserted letter in the frequent word is a deletion of our candidate.
  for (const candidate of index.deletions.get(word) ?? []) consider(candidate);
  for (let position = 0; position < word.length; position++) {
    const deleted = word.slice(0, position) + word.slice(position + 1);
    consider(deleted);
    for (const candidate of index.deletions.get(deleted) ?? []) {
      // Same signature is substitution evidence only when the surviving
      // prefix and suffix establish one actual changed letter.
      if (candidate.length !== word.length) continue;
      let differences = 0;
      for (let offset = 0; offset < word.length && differences <= 1; offset++)
        if (candidate[offset] !== word[offset]) differences++;
      if (differences === 1) consider(candidate);
    }
    if (position + 1 < word.length)
      consider(
        word.slice(0, position) + word[position + 1] + word[position] + word.slice(position + 2),
      );
  }
  return rank < 1000 ? 0.25 : Number.isFinite(rank) ? 0.5 : 1;
}

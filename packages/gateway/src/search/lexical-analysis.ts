// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Text analysis for keyword search, applied identically to indexed text and to
 * queries before SQLite's tokenizer sees either.
 *
 * SQLite's `unicode61` tokenizer finds words by splitting on spaces and
 * punctuation. That is wrong for three kinds of text, which this module
 * rewrites into space-separated words the tokenizer then handles correctly:
 *
 * - Scripts written without spaces (Chinese, Japanese, Thai, Lao, Khmer,
 *   Burmese): a whole sentence would be one token. Each run is split with the
 *   runtime's dictionary word segmenter. Traditional Chinese characters are
 *   first replaced by their Simplified forms, so text in either matches a
 *   query in the other.
 * - Korean, which spaces phrases but attaches grammatical particles to the
 *   noun, so a noun and the same noun with a particle are different tokens. A
 *   Hangul run loses a trailing particle and is indexed as its overlapping
 *   syllable pairs, so any stretch of two or more syllables matches wherever
 *   it occurs.
 * - Marks that are optional in writing and would make a marked word differ
 *   from its plain spelling: Arabic and Hebrew vowel points, the stress accent
 *   Russian reference text puts on a word, and the Devanagari dot (nukta) and
 *   nasal sign variants. They are removed or unified. Full-width and
 *   half-width forms are replaced by the ordinary characters.
 *
 * It also reduces words to their stems, so a word matches its other
 * grammatical forms. The tokenizer's own stemmer knows English endings only
 * and leaves other scripts as written. The stemmer is chosen by script, with no
 * language detection, on both sides of a match: every Cyrillic word gets the
 * Russian Snowball rules and every Arabic-script word the Arabic ones, and
 * Devanagari, Bengali and Telugu words lose the longest of a short list of
 * Hindi, Bengali and Telugu case and number endings.
 *
 * Latin-script text is returned unchanged, so its search behaves exactly as
 * the tokenizer alone would.
 *
 * These rules are lexical version 1 (see lexical-versions.ts). Word splitting
 * depends on the runtime's ICU dictionaries; lexical-analysis.test.ts pins how
 * sample sentences split, so a runtime whose ICU splits them differently fails
 * that test, and changed rules ship as a new version rather than as an edit to
 * this one.
 */

import { Converter } from "opencc-js/t2cn";
import snowballStemmers from "snowball-stemmers";

/**
 * The tokenizer for analyzed text. `categories` adds combining marks to the
 * token characters: by default they separate tokens, which cuts Indic and Thai
 * words apart at every vowel sign.
 */
export const LEXICAL_TOKENIZE = "porter unicode61 remove_diacritics 2 categories 'L* N* Co Mn Mc'";

const UNSPACED =
  "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\u30FC\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}";
/** Arabic harakat, Quranic marks and tatweel; Hebrew cantillation and niqqud. */
const POINTS =
  "\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06ED\\u0640\\u0591-\\u05BD\\u05BF\\u05C1\\u05C2\\u05C4\\u05C5\\u05C7";

/** Full-width and half-width forms, which compatibility normalization replaces. */
const WIDTH_FORMS = /[\uFF00-\uFFEF]/;
const NEEDS_ANALYSIS = new RegExp(
  `[${UNSPACED}\\p{sc=Hangul}\\p{sc=Cyrillic}\\p{sc=Arabic}\\p{sc=Devanagari}\\p{sc=Bengali}` +
    `\\p{sc=Telugu}${POINTS}\\uFF00-\\uFFEF]`,
  "u",
);
/** A stress accent written on a Cyrillic vowel. */
const CYRILLIC_STRESS = /(?<=\p{sc=Cyrillic})[\u0300\u0301]/gu;
const HAS_DEVANAGARI = /\p{sc=Devanagari}/u;
const NUKTA = /\u093C/g;
const CHANDRABINDU = /\u0901/g;
const POINTS_RUN = new RegExp(`[${POINTS}]+`, "gu");
const UNSPACED_RUN = new RegExp(`[${UNSPACED}]+`, "gu");
const HANGUL_RUN = /\p{sc=Hangul}+/gu;
/** Case, topic and linking particles a Korean word ends with, longest first. */
const HANGUL_PARTICLE =
  /(?:에서는|에서도|으로는|으로도|에게서|이라는|에서|으로|에게|까지|부터|처럼|보다|이나|이란|이며|이다|은|는|이|가|을|를|의|에|와|과|도|로|만|나)$/u;
/** Persian plural and comparative endings written attached to the word. */
const PERSIAN_ENDING = /(?<=\p{sc=Arabic}{2})(?:هایی|های|ها|ترین|تر)(?!\p{sc=Arabic})/gu;
/** Joiners that shape an Indic conjunct without changing the word. */
const INDIC_JOINER =
  /(?<=[\p{sc=Devanagari}\p{sc=Bengali}\p{sc=Telugu}])[\u200C\u200D]+(?=[\p{sc=Devanagari}\p{sc=Bengali}\p{sc=Telugu}])/gu;

const segmenter = new Intl.Segmenter("en", { granularity: "word" });

const toSimplified = Converter({ from: "t", to: "cn" });

const STEM_CACHE_ENTRIES = 200_000;

/** Stems of one script's words, remembered: text repeats the same few thousand. */
class ScriptStemmer {
  private readonly cache = new Map<string, string>();

  constructor(
    readonly words: RegExp,
    private readonly rules: (word: string) => string,
  ) {}

  readonly stem = (word: string): string => {
    const lower = word.toLowerCase();
    let stem = this.cache.get(lower);
    if (stem === undefined) {
      stem = this.rules(lower) || lower;
      if (this.cache.size >= STEM_CACHE_ENTRIES) this.cache.clear();
      this.cache.set(lower, stem);
    }
    return stem;
  };
}

function snowball(algorithm: string): (word: string) => string {
  const stemmer = snowballStemmers.newStemmer(algorithm);
  return (word) => stemmer.stem(word);
}

/**
 * Removes the longest listed ending while at least two characters remain, and
 * again until none is left, so a stem is its own stem and a word carrying two
 * endings meets the word carrying one. The lists hold case, number and tense
 * endings only.
 */
function endings(list: readonly string[]): (word: string) => string {
  const byLength = [...list].sort((a, b) => b.length - a.length);
  const once = (word: string): string => {
    for (const ending of byLength) {
      if (word.endsWith(ending) && [...word].length - [...ending].length >= 2) {
        return word.slice(0, -ending.length);
      }
    }
    return word;
  };
  return (word) => {
    for (let stem = word; ;) {
      const next = once(stem);
      if (next === stem) return stem;
      stem = next;
    }
  };
}

// The Hindi list is the one of Ramanathan and Rao's lightweight stemmer.
const HINDI_ENDINGS = (
  "ाएंगी ाएंगे ाऊंगी ाऊंगा ाइयाँ ाइयों ाइयां ाएगी ाएगा ाओगी ाओगे एंगी ेंगी एंगे ेंगे ूंगी ूंगा ातीं " +
  "नाओं नाएं ताओं ताएं ियाँ ियों ियां ाकर ाइए ाईं ाया ेगी ेगा ोगी ोगे ाने ाना ाते ाती ाता तीं ाओं ाएं " +
  "ुओं ुएं ुआं कर ाओ िए ाई ाए ने नी ना ते ीं ती ता ाँ ां ों ें ो े ू ु ी ि ा"
).split(" ");
const BENGALI_ENDINGS =
  "গুলোর গুলির গুলোতে গুলিতে গুলোকে গুলিকে গুলো গুলি দের টির টিকে টার েরা ের কে তে টি টা রা য় ে র".split(
    " ",
  );
const TELUGU_ENDINGS = "లలో లకు లను లతో లోని లోకి నుండి నుంచి లో లు కు కి ను ని తో గా పై".split(
  " ",
);

const SCRIPT_STEMMERS: readonly ScriptStemmer[] = [
  new ScriptStemmer(/\p{sc=Cyrillic}+/gu, snowball("russian")),
  new ScriptStemmer(/\p{sc=Arabic}+/gu, snowball("arabic")),
  new ScriptStemmer(/\p{sc=Devanagari}+/gu, endings(HINDI_ENDINGS)),
  new ScriptStemmer(/\p{sc=Bengali}+/gu, endings(BENGALI_ENDINGS)),
  new ScriptStemmer(/\p{sc=Telugu}+/gu, endings(TELUGU_ENDINGS)),
];

function segmentRun(run: string): string {
  const words: string[] = [];
  for (const part of segmenter.segment(toSimplified(run))) {
    if (part.isWordLike) words.push(part.segment);
  }
  return ` ${words.join(" ")} `;
}

function syllablePairs(run: string): string {
  const word = run.normalize("NFC");
  // A particle is removed only from a word that keeps two syllables without it.
  const bare = word.replace(HANGUL_PARTICLE, "");
  const syllables = [...([...bare].length >= 2 ? bare : word)];
  if (syllables.length <= 2) return ` ${syllables.join("")} `;
  const terms: string[] = [];
  for (let i = 0; i < syllables.length - 1; i += 1) terms.push(syllables[i]! + syllables[i + 1]!);
  return ` ${terms.join(" ")} `;
}

/** `text` rewritten so the tokenizer finds its words; see the module comment. */
export function lexicalText(text: string): string {
  if (!NEEDS_ANALYSIS.test(text)) return text;
  let out = WIDTH_FORMS.test(text) ? text.normalize("NFKC") : text;
  if (HAS_DEVANAGARI.test(out)) {
    // Decomposed first: a dotted letter can be one code point or two.
    out = out.normalize("NFD").replace(NUKTA, "").replace(CHANDRABINDU, "\u0902").normalize("NFC");
  }
  out = out
    .replace(INDIC_JOINER, "")
    .replace(PERSIAN_ENDING, "")
    .replace(POINTS_RUN, "")
    .replace(CYRILLIC_STRESS, "")
    .replace(UNSPACED_RUN, segmentRun)
    .replace(HANGUL_RUN, syllablePairs);
  for (const script of SCRIPT_STEMMERS) out = out.replace(script.words, script.stem);
  return out;
}

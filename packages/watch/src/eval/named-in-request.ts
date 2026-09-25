// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a request says a thing.
 *
 * Deliberately literal. A request names three days if it contains a three and a
 * day, or a phrase this file lists as meaning that — "a week", "a fortnight".
 * It does not try to understand the sentence: an approximate matcher would let
 * an unnameable parameter pass on a coincidence, and the whole point of the
 * check is that it cannot be talked round.
 *
 * The synonym tables below are the only flexibility, and each entry is a fact
 * about English rather than a concession to a particular watch. Where a phrase
 * is genuinely vague — "a fortnight" is not exactly fourteen days — the watch
 * declares a tolerance in `free-parameters.ts` rather than the matcher
 * stretching to fit.
 */

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  sixty: 60,
  ninety: 90,
};

const DAY = 86_400_000;

/** Unit words, and what one of them is worth in milliseconds. */
const UNIT_MS: Record<string, number> = {
  second: 1000,
  seconds: 1000,
  minute: 60_000,
  minutes: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  day: DAY,
  days: DAY,
  week: 7 * DAY,
  weeks: 7 * DAY,
  month: 30 * DAY,
  months: 30 * DAY,
  year: 365 * DAY,
  years: 365 * DAY,
};

/** Phrases that name a span on their own. */
const PHRASE_MS: Record<string, number> = {
  fortnight: 14 * DAY,
  "a whole week": 7 * DAY,
  daily: DAY,
  weekly: 7 * DAY,
  monthly: 30 * DAY,
};

/**
 * Words that mean the working-day unit. `business_days` is a calendar unit
 * rather than a multiple of a day, so a request naming it has to say so.
 */
const BUSINESS_WORDS = ["working day", "business day", "weekday"];

/** Every span the request names, in milliseconds. */
export function spansNamedIn(request: string): number[] {
  const text = request.toLowerCase();
  const found: number[] = [];

  for (const [phrase, ms] of Object.entries(PHRASE_MS)) {
    if (text.includes(phrase)) found.push(ms);
  }

  // "<number> <unit>", with the number as a digit or a word.
  const units = Object.keys(UNIT_MS).join("|");
  const words = Object.keys(WORD_NUMBERS).join("|");
  const pattern = new RegExp(
    `\\b(\\d+|${words})[\\s-]+(?:working[\\s-]+|business[\\s-]+)?(${units})\\b`,
    "g",
  );
  for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
    const amount = /^\d+$/.test(m[1]!) ? Number(m[1]!) : WORD_NUMBERS[m[1]!]!;
    found.push(amount * UNIT_MS[m[2]!]!);
  }
  return found;
}

/**
 * Every date the request states, in ISO form.
 *
 * A watch may freeze a date as a constant, and a constant has no source in the
 * ontology at all — a compilation can only get it from the request. Both the
 * bare ISO form and the way a person more often writes it are read, because a
 * request is prose and "14 May 2031" is the same date as "2031-05-14".
 */
export function datesNamedIn(request: string): string[] {
  const found = new Set<string>();
  for (const [iso] of request.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) found.add(iso);

  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const written = new RegExp(`\\b(\\d{1,2})\\s+(${months.join("|")})\\s+(\\d{4})\\b`, "gi");
  for (const [, day, month, year] of request.matchAll(written)) {
    const index = months.indexOf(month!.toLowerCase()) + 1;
    found.add(`${year}-${String(index).padStart(2, "0")}-${day!.padStart(2, "0")}`);
  }
  return [...found];
}

/** Whether the request names a working-day span rather than a calendar one. */
export function namesBusinessDays(request: string): boolean {
  const text = request.toLowerCase();
  return BUSINESS_WORDS.some((word) => text.includes(word));
}

/**
 * Every bare count the request names, as a digit or a word.
 *
 * Duration phrases are removed first. "over the past two weeks" names a span
 * of fourteen days and does not name the count two, and reading it as one lets
 * a watch bind any 2 — a threshold, an instance ceiling — and call it named.
 */
export function countsNamedIn(request: string): number[] {
  const units = Object.keys(UNIT_MS).join("|");
  const words = Object.keys(WORD_NUMBERS).join("|");
  const text = request
    .toLowerCase()
    .replace(
      new RegExp(`\\b(?:\\d+|${words})\\s+(?:working\\s+|business\\s+)?(?:${units})\\b`, "g"),
      " ",
    );

  // A currency amount is not a count. A request saying £200 would otherwise
  // name any watch binding 200.
  const withoutMoney = text.replace(/[\u00a3$\u20ac]\s?\d[\d,.]*/g, " ");
  const found = [...withoutMoney.matchAll(/\b\d+\b/g)].map((m) => Number(m[0]));
  for (const [word, value] of Object.entries(WORD_NUMBERS)) {
    // `a`/`an`/`one` are too common as articles to read as counts.
    if (value > 1 && new RegExp(`\\b${word}\\b`).test(withoutMoney)) found.push(value);
  }
  return found;
}

/**
 * Whether the request asks to be told no more than so often.
 *
 * A cooldown is not named by any span the request happens to contain. "for a
 * whole week" names the window a query looks back over; reading it as licence
 * to bind a seven-day rate limit binds something nobody asked for — and then
 * *forbids* declaring that limit free, so a compilation choosing a different
 * one is graded as misreading a request that never mentioned one.
 */
export function namesARateLimit(request: string): boolean {
  return /\b(no more than|at most|once a|once per|only once|not more often)\b/i.test(request);
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "for",
  "and",
  "or",
  "is",
  "it",
  "me",
  "my",
  "i",
  "that",
  "this",
  "with",
  "from",
  "by",
  "at",
  "as",
  "be",
  "was",
  "has",
  "have",
  "not",
  "no",
  "when",
  "if",
  "any",
  "some",
  "she",
  "he",
  "her",
  "his",
  "they",
  "their",
  "them",
  "you",
  "your",
  "we",
  "us",
  "our",
  "about",
  "within",
  "over",
  "under",
  "into",
  "out",
  "up",
  "down",
  "tell",
  "let",
  "know",
  "warn",
  "alert",
  "ping",
  "remind",
  "wake",
  "give",
  "show",
  "say",
  "would",
  "will",
  "can",
  "could",
  "should",
  "there",
  "here",
  "then",
  "than",
  "so",
  "but",
  "given",
  "these",
  "those",
  "one",
  "two",
  "each",
  "other",
  "same",
  "still",
  "just",
  "only",
  "more",
  "most",
  "much",
  "many",
  "very",
  "really",
  "looks",
  "look",
  "like",
  "seems",
]);

/**
 * The distinctive stems of a phrase.
 *
 * A small stemmer rather than a real one: strip a common suffix, drop a
 * trailing silent `e`, fold a trailing `y` to `i`, then keep four characters.
 * That is enough to make "moving" meet "move" and "replied" meet "reply" —
 * which a plain prefix does not, and which is exactly the case that matters
 * when a request and a recall query say the same thing in different tenses.
 */
function stemsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word))
      .map(stem)
      .filter((word) => word.length > 0),
  );
}

const SUFFIXES = ["ings", "ing", "edly", "ely", "ment", "ers", "er", "ed", "es", "ly", "s"];

function stem(word: string): string {
  let base = word.replace(/'s$/, "");
  for (const suffix of SUFFIXES) {
    if (base.length > suffix.length + 2 && base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  if (base.endsWith("e")) base = base.slice(0, -1);
  if (base.endsWith("y")) base = `${base.slice(0, -1)}i`;
  return base.slice(0, 4);
}

/** How many distinct stems a phrase shares with a request. */
export function sharedStems(phrase: string, request: string): string[] {
  const inRequest = stemsOf(request);
  return [...stemsOf(phrase)].filter((stem) => inRequest.has(stem));
}

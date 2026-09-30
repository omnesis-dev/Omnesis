// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-document language routing for date extraction.
 *
 * Microsoft Recognizers-Text parses with exactly one culture at a time, and
 * running several cultures over the same text is a precision disaster (the
 * English article "an" parses as French "an" = one year), so every document
 * is routed to exactly ONE culture before extraction.
 *
 * Detection (tinyld) chooses only among the languages the recognizer has a
 * model for, over a sample stripped of URLs, addresses and long unbroken
 * tokens. Unrestricted detection reads the tracking links and markup of
 * ordinary English mail as Klingon, Berber, Tagalog or Latin — a large share
 * of a typical mailbox, which would then get no dates at all. The cost of
 * restricting is that a document in a language without a model is parsed with
 * the nearest supported one; a single culture over foreign text yields a few
 * stray numeric dates, far less than the dates that would otherwise be lost.
 * Uncertain or very short text defaults to English.
 *
 * Detection runs over a bounded slice of title + content and costs ~0.2ms per
 * document — cheap enough to sit inline with extraction on the cpu worker pool.
 */

import { detectAll } from "tinyld";

/**
 * The culture codes the JS build of `@microsoft/recognizers-text-date-time`
 * registers a real DateTimeModel for. The base `Culture` class also exports
 * German / Italian / Dutch / Portuguese / Japanese codes (the .NET port
 * supports them), but the JS DateTimeRecognizer does not — asking for them
 * throws. A drift test pins these literals to the library's constants.
 * `en-*` (EnglishOthers) is English with day-first numeric dates
 * ("10/07" is 10 July); `en-us` reads them month-first.
 */
export type DateCulture = "en-us" | "en-*" | "fr-fr" | "es-es" | "zh-cn";

/** How an all-numeric English date ("10/07/2026") is read. */
export type NumericDateOrder = "day-first" | "month-first";

/** The default culture — uncertain text, when numeric dates read month-first. */
export const ENGLISH_CULTURE: DateCulture = "en-us";

/** The English culture for a numeric date order. */
export function englishCulture(order: NumericDateOrder): DateCulture {
  return order === "day-first" ? "en-*" : "en-us";
}

/** ISO 639-1 code → date-time culture, for every non-English culture the JS build ships. */
const CULTURE_BY_LANG: Readonly<Record<string, DateCulture>> = {
  fr: "fr-fr",
  es: "es-es",
  zh: "zh-cn",
};

/** The languages detection may choose from: English plus every mapped culture. */
const SUPPORTED_LANGS = ["en", ...Object.keys(CULTURE_BY_LANG)];

/**
 * Characters of title + content fed to detection, after cleaning. Language is
 * decided in the first couple of paragraphs; a bounded slice keeps detection
 * O(1) per document regardless of body size.
 */
const DETECTION_MAX_CHARS = 2000;

/** Raw characters read before cleaning, so a link-heavy head still leaves prose. */
const DETECTION_RAW_CHARS = 8000;

/**
 * Below this many characters of sample, no detector is trustworthy (three
 * words match half the languages in the model) — default to English.
 */
const MIN_SAMPLE_CHARS = 24;

/**
 * Minimum tinyld confidence to act on a detection. Real multilingual prose
 * scores well above this (French/Spanish body text ≈ 0.35–1.0); sub-floor
 * tops are trigram noise on short or mixed text — default to English rather
 * than mis-route.
 */
const MIN_CONFIDENCE = 0.2;

/** What detection should not read: links, addresses, identifiers and markup. */
function detectionSample(title: string, content: string): string {
  return (
    `${title}\n${content}`
      .slice(0, DETECTION_RAW_CHARS)
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
      .replace(/\S+@\S+/g, " ")
      // Long unbroken ASCII runs are identifiers and encoded blobs; CJK prose
      // has no spaces and must survive.
      .replace(/[\x21-\x7e]{25,}/g, " ")
      .replace(/[<>()[\]{}|*#_=]+/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, DETECTION_MAX_CHARS)
      .trim()
  );
}

/**
 * Route a document to the single recognizers-text culture its language calls
 * for. English text reads numeric dates in `order`.
 */
export function routeDateCulture(
  title: string,
  content: string,
  order: NumericDateOrder = "month-first",
): DateCulture {
  const english = englishCulture(order);
  const sample = detectionSample(title, content);
  if (sample.length < MIN_SAMPLE_CHARS) return english;
  const [top] = detectAll(sample, { only: SUPPORTED_LANGS });
  if (!top || top.accuracy < MIN_CONFIDENCE) return english;
  return CULTURE_BY_LANG[top.lang] ?? english;
}

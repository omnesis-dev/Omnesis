// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-document language routing for date extraction.
 *
 * Microsoft Recognizers-Text parses with exactly one culture at a time, and
 * running several cultures over the same text is a precision disaster (the
 * English article "an" parses as French "an" = one year), so every document
 * is routed to exactly ONE culture before extraction:
 *
 *   - detected language with a recognizers-text culture → that culture
 *   - uncertain / ambiguous / very short text → English (most of the corpus;
 *     the English precision rules drop weak matches anyway)
 *   - confidently detected language with NO recognizers-text culture → null,
 *     meaning SKIP extraction for the document — parsing it with a wrong
 *     culture would produce noise. The pass still stamps
 *     `dates_extracted_at`, so a skipped document records zero dates and is
 *     never rescanned.
 *
 * Detection (tinyld) runs over a bounded slice of title + content and costs
 * ~0.2ms per document — cheap enough to sit inline with extraction on the
 * cpu worker pool.
 */

import { detectAll } from "tinyld";

/**
 * The culture codes the JS build of `@microsoft/recognizers-text-date-time`
 * registers a real DateTimeModel for. The base `Culture` class also exports
 * German / Italian / Dutch / Portuguese / Japanese codes (the .NET port
 * supports them), but the JS DateTimeRecognizer does not — asking for them
 * throws. A drift test pins these literals to the library's constants.
 * `en-*` (EnglishOthers) is also registered but unreachable here: language
 * detection cannot distinguish English variants, so English routes to
 * `en-us`.
 */
export type DateCulture = "en-us" | "fr-fr" | "es-es" | "zh-cn";

/** The default culture — uncertain or unroutable-but-probably-fine text. */
export const ENGLISH_CULTURE: DateCulture = "en-us";

/** ISO 639-1 code → date-time culture, for every culture the JS build ships. */
const CULTURE_BY_LANG: Readonly<Record<string, DateCulture>> = {
  en: "en-us",
  fr: "fr-fr",
  es: "es-es",
  zh: "zh-cn",
};

/**
 * Characters of title + content fed to detection. Language is decided in the
 * first couple of paragraphs; a bounded slice keeps detection O(1) per
 * document regardless of body size.
 */
const DETECTION_MAX_CHARS = 2000;

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

/**
 * Route a document to the single recognizers-text culture its language calls
 * for. Returns `null` when the text is confidently in a language the
 * date-time recognizer has no model for — the caller must then skip
 * extraction (recording zero dates) instead of parsing with a wrong culture.
 */
export function routeDateCulture(title: string, content: string): DateCulture | null {
  const sample = `${title}\n${content}`.slice(0, DETECTION_MAX_CHARS).trim();
  if (sample.length < MIN_SAMPLE_CHARS) return ENGLISH_CULTURE;
  const [top] = detectAll(sample);
  if (!top || top.accuracy < MIN_CONFIDENCE) return ENGLISH_CULTURE;
  return CULTURE_BY_LANG[top.lang] ?? null;
}

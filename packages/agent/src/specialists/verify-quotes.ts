// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Quote-verification helper for the `citation-verifier` specialist (#748).
 *
 * The trust feature, first cut: given a cited document's text and the quotes a
 * prior agent attributed to it, re-check by **string match** that each quoted
 * substring actually appears in the source. A quote that doesn't appear is
 * flagged as a mismatch (a possible fabrication / paraphrase passed off as a
 * quote). This is a pure, deterministic function — no model, no I/O — so the
 * specialist's claim of having "verified" a citation is grounded in an actual
 * check, not in the model's say-so.
 *
 * Matching uses @omnesis/core's `normalizeForQuoteMatch` — the one normalizer
 * shared with the gateway's evidence firewall — so it is whitespace-normalised,
 * case-insensitive, and typographic-punctuation-insensitive (curly vs straight
 * quotes, dashes, ellipsis): models routinely reflow whitespace, adjust
 * capitalisation, and straighten smart punctuation when quoting, and those are
 * not the fabrications we want to flag. Anything beyond that (reworded,
 * invented, or attributed-to-the-wrong-doc text) fails the match and is
 * reported.
 *
 * Later cuts may add fuzzier matching (token overlap, embedding similarity);
 * the registry/contract doesn't change when that lands.
 */

import { normalizeForQuoteMatch } from "@omnesis/core";

/** One quote's verification outcome. */
export interface QuoteVerification {
  /** The quote as the prior agent attributed it (verbatim). */
  quote: string;
  /** True iff the (normalised) quote appears in the (normalised) document text. */
  present: boolean;
}

/** Aggregate result of verifying a batch of quotes against one document. */
export interface QuoteVerificationReport {
  /** True iff every quote was found in the document text. */
  allPresent: boolean;
  /** Per-quote outcomes, in input order. */
  results: ReadonlyArray<QuoteVerification>;
  /** Just the quotes that did NOT appear — the mismatches to surface. */
  mismatches: ReadonlyArray<string>;
}

/**
 * Verify that each `quote` appears (per `normalizeForQuoteMatch`) in
 * `documentText`. Empty or whitespace-only quotes are treated as **not**
 * present — a citation must carry actual quoted text to be verifiable.
 */
export function verifyQuotes(
  documentText: string,
  quotes: ReadonlyArray<string>,
): QuoteVerificationReport {
  const haystack = normalizeForQuoteMatch(documentText);
  const results: QuoteVerification[] = quotes.map((quote) => {
    const needle = normalizeForQuoteMatch(quote);
    const present = needle.length > 0 && haystack.includes(needle);
    return { quote, present };
  });
  const mismatches = results.filter((r) => !r.present).map((r) => r.quote);
  return { allPresent: mismatches.length === 0, results, mismatches };
}

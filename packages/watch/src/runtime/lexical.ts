// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Matching a literal term against a document, the same way twice.
 *
 * The lexical arm nominates a document when one of its terms appears in the
 * text. "Appears" has to mean one thing everywhere, because three places ask
 * the question and a disagreement between them is a watch that validates,
 * backtests clean, and then behaves differently live: the validator asks how
 * often a term appears in the corpus, the runtime asks whether it appears in
 * this document, and the compiler is told what counts. They share this file.
 *
 * Normalization is deliberately shallow — case folded, punctuation reduced to
 * spaces, whitespace collapsed. No stemming and no synonyms: a term is a
 * literal the operator can read back in an approval prompt, and "I will also
 * nominate any document containing 'XR-4471'" stops being true the moment the
 * matcher starts being clever. An order number is exactly the case where
 * cleverness costs precision — `XR-4471` and `XR-4472` differ by a character.
 */

/** Composed, case folded, punctuation to spaces, whitespace collapsed, padded. */
export function normalizeForMatch(text: string): string {
  // Composed first. A combining mark is punctuation to the strip below, so a
  // decomposed "café" would lose its accent while a composed "café" keeps
  // it — two strings that render identically would stop matching each other,
  // and proper nouns are exactly what a lexical arm is recommended for.
  return ` ${text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

/**
 * Whether a normalized haystack contains a term.
 *
 * One test serves both kinds, and that is a property of the normalization
 * rather than an oversight. Both sides are padded with spaces, so a substring
 * search for a one-word needle is whole-word matching — `XR 4471` does not
 * match inside `XR 44710` — and a substring search for a multi-word needle is
 * adjacent-phrase matching, which rejects `date new` for `new date`.
 *
 * So `match` is not a branch here. It is a claim the author makes about the
 * term, and the validator is what holds them to it: a term with a space in it
 * declared as a `token` is a diagnostic, not a silent reinterpretation. A
 * runtime that quietly matched it anyway would make that diagnostic a lie, and
 * a runtime that refused it would enforce a rule the validator already owns.
 */
export function containsTerm(normalizedHaystack: string, term: string): boolean {
  const needle = normalizeForMatch(term);
  if (needle.trim().length === 0) return false;
  return normalizedHaystack.includes(needle);
}

/**
 * How many documents in a corpus a term appears in.
 *
 * An interface rather than a search: the compiler needs this at compile time to
 * refuse a term that would nominate half the corpus, and the PoC universe
 * answers it from its own journal. A live install would answer it from the
 * index. The number is a count, not a score — see the DSL's note on why a
 * frozen BM25 threshold drifts and a literal term does not.
 */
export interface DocumentFrequency {
  /** Documents containing this term, and the corpus size it was counted over. */
  frequency(term: string): { documents: number; corpus: number };
}

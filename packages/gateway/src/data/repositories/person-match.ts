// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Match quality for a people search.
 *
 * A person search matches a short human-typed string against canonical names,
 * nicknames, email addresses, and phone numbers. Substring containment alone
 * cannot rank those: a four-letter query is a substring of plenty of unrelated
 * long names, and the accidental hit is indistinguishable from the intended one
 * once both are in the candidate set. Ranking by interaction score alone then
 * lets a well-connected accident outrank the person actually being looked for.
 *
 * These tiers order the candidate set by *how* it matched, before any
 * popularity signal applies. Lower is better.
 */
export const MATCH_RANK = {
  /** The whole name or alias is the query. */
  EXACT: 0,
  /** A name or alias starts with the query. */
  PREFIX: 1,
  /** A word inside a name or alias starts with the query. */
  WORD: 2,
  /** The query appears somewhere inside, not at a word start. */
  INFIX: 3,
  /** No literal match; reached the result only through the fuzzy pass. */
  FUZZY: 4,
} as const;

/**
 * Best (lowest) literal tier a row can reach. Rows that match no tier are
 * excluded by the search's WHERE clause, so this sentinel only ever appears
 * mid-expression while taking a minimum.
 */
export const MATCH_RANK_NONE = 99;

/**
 * Characters that begin a new word inside a name or address. Space covers
 * ordinary names; the punctuation covers `first.last`, `jean-luc`,
 * `first_last`, and the local/domain and tag boundaries of an email, so a
 * query for a surname or a domain scores as a word start rather than an
 * accidental infix.
 */
const WORD_SEPARATORS = [" ", ".", "-", "_", "@", "+"] as const;

/** Escape character for the LIKE patterns below. */
const LIKE_ESCAPE = "\\";

/**
 * Neutralize LIKE's wildcards in a literal.
 *
 * `_` matches any single character and `%` matches any run, so an unescaped
 * literal containing either silently widens the pattern: the `_` separator
 * would make `%_bose%` match "ambosely", scoring an accidental infix as a word
 * start, and a query containing `_` or `%` would match far more than the user
 * typed.
 */
export function escapeLike(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE}${ch}`);
}

/**
 * SQL expression scoring how well `column` matches the query, as one of the
 * {@link MATCH_RANK} tiers.
 *
 * The query is bound as parameters named `<prefix>Exact` / `<prefix>Prefix` /
 * `<prefix>Word<n>` / `<prefix>Infix`, built by {@link matchRankParams}. LIKE
 * is used rather than string functions so the comparison keeps SQLite's
 * case-insensitive ASCII semantics, matching the filter that selected these
 * rows in the first place.
 */
export function matchRankExpr(column: string, prefix: string): string {
  // SQLite string literals take no backslash escapes, so a single backslash
  // between the quotes is exactly the one-character ESCAPE it requires.
  const like = (param: string): string => `LOWER(${column}) LIKE @${param} ESCAPE '${LIKE_ESCAPE}'`;
  const wordBranches = WORD_SEPARATORS.map(
    (_, i) => `WHEN ${like(`${prefix}Word${i}`)} THEN ${MATCH_RANK.WORD}`,
  ).join("\n         ");
  return `CASE
         WHEN LOWER(${column}) = @${prefix}Exact THEN ${MATCH_RANK.EXACT}
         WHEN ${like(`${prefix}Prefix`)} THEN ${MATCH_RANK.PREFIX}
         ${wordBranches}
         WHEN ${like(`${prefix}Infix`)} THEN ${MATCH_RANK.INFIX}
         ELSE ${MATCH_RANK_NONE}
       END`;
}

/**
 * Bound values for one {@link matchRankExpr} parameter group.
 *
 * `prefix` must match the one passed to `matchRankExpr`. Callers build two
 * groups — the query as typed and its canonical email form — and take the
 * better tier, so typing a dotted or `+tag` address scores against the
 * no-dot alias actually stored at ingestion rather than falling through to
 * no tier at all.
 */
export function matchRankParams(query: string, prefix: string): Record<string, string> {
  const q = query.toLowerCase();
  const escaped = escapeLike(q);
  const out: Record<string, string> = {
    [`${prefix}Exact`]: q,
    [`${prefix}Prefix`]: `${escaped}%`,
    [`${prefix}Infix`]: `%${escaped}%`,
  };
  WORD_SEPARATORS.forEach((sep, i) => {
    out[`${prefix}Word${i}`] = `%${escapeLike(sep)}${escaped}%`;
  });
  return out;
}

/**
 * Largest edit distance tolerated when the literal pass found nothing good.
 *
 * Scaled by query length because a fixed budget means different things at
 * different lengths: one edit on a three-letter string can reach a large share
 * of all three-letter strings, while one edit on a surname is an ordinary
 * typo. Short queries therefore get no fuzzy budget at all — for them the
 * literal substring pass is already generous.
 */
export function maxEditDistanceFor(query: string): number {
  const n = query.length;
  if (n <= 3) return 0;
  if (n <= 6) return 1;
  return 2;
}

/**
 * Levenshtein distance between `a` and `b`, abandoned as soon as it is known
 * to exceed `max` (returning `max + 1`).
 *
 * The cap is what makes a fuzzy sweep affordable: the row-wise minimum is
 * non-decreasing, so once an entire row exceeds the budget no later row can
 * come back under it and the remaining work can be skipped.
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length <= max ? b.length : max + 1;
  if (b.length === 0) return a.length <= max ? a.length : max + 1;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length] <= max ? prev[b.length] : max + 1;
}

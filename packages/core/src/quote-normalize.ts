// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The ONE normalizer for verbatim-evidence quote matching.
 *
 * Every gate that asks "does this quoted substring appear in that document"
 * (the gateway's evidence firewall + content-change invalidators, and the
 * agent's citation-verification tally) must run BOTH sides of the comparison
 * through this function, so write-time acceptance and later re-checks agree.
 * A quote accepted under a wider matcher but re-checked under a narrower one
 * would be wrongly broken by the next content change of its evidence doc.
 *
 * The canonical form is deliberately tolerant of the ways models and editors
 * reflow verbatim text without changing it: Unicode NFC, typographic
 * punctuation folded to ASCII (curly quotes → straight, en/em dash and minus
 * sign → hyphen, ellipsis → "...", no-break/thin spaces → space), lowercase,
 * runs of whitespace collapsed to one space, trimmed. Anything beyond that —
 * reworded, invented, or paraphrased text — still fails the match.
 *
 * NFC caveat: composition is not substring-homomorphic at boundaries. A quote
 * that ends exactly at the base character of a combining sequence (e.g.
 * "the cafe" against decomposed "café" content, where the haystack carries
 * e + U+0301) does not match, because NFC fuses the base character with its
 * combining mark in the haystack but the quote ends before the mark. NFC is
 * used rather than NFD + strip-combining-marks for fidelity — stripping marks
 * would equate genuinely different text ("résumé" vs "resume") — and the
 * boundary class is narrow: the quote must end mid-sequence, on the base
 * character itself.
 *
 * watch-v2's lexical term matching (packages/watch-v2 runtime) is a
 * deliberately different contract (punctuation → spaces, shallow and
 * operator-readable) — do not merge the two.
 */
export function normalizeForQuoteMatch(s: string): string {
  return (
    s
      .normalize("NFC")
      // U+2018/U+2019 curly single quotes, U+201A low quote, U+2032 prime.
      .replace(/[‘’‚′]/g, "'")
      // U+201C/U+201D curly double quotes, U+201E low quote, U+2033 double prime.
      .replace(/[“”„″]/g, '"')
      // U+2013 en dash, U+2014 em dash, U+2212 minus sign.
      .replace(/[–—−]/g, "-")
      // U+00A0 no-break space, U+202F narrow no-break space, U+2009 thin space.
      .replace(/[\u00A0\u202F\u2009]/g, " ")
      // U+2026 horizontal ellipsis.
      .replace(/…/g, "...")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
  );
}

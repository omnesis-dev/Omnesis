// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Normalize text for shingling: lowercase, collapse whitespace, strip
 * common email quote markers (lines beginning with `> `). The goal is
 * to make near-duplicate detection robust to mechanical reformatting
 * without erasing structural content.
 */
export function normalizeText(input: string, opts?: { stripQuotes?: boolean }): string {
  let s = input;
  if (opts?.stripQuotes !== false) {
    s = s.replace(/^[ \t]*>[ \t]?.*$/gm, " ");
  }
  s = s.toLowerCase();
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const isWord =
      (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c >= 0x80;
    if (isWord) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      tokens.push(text.slice(start, i));
      start = -1;
    }
  }
  if (start >= 0) tokens.push(text.slice(start));
  return tokens;
}

/**
 * Build the set of k-word shingles for a normalized text. Returns
 * unique shingle strings joined by a single space. For very short
 * texts (fewer than k tokens) the entire text is one shingle.
 */
export function shingles(normalized: string, k: number): Set<string> {
  const tokens = tokenize(normalized);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < k) {
    out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i <= tokens.length - k; i++) {
    out.add(tokens.slice(i, i + k).join(" "));
  }
  return out;
}

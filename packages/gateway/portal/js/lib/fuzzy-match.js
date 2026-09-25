// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fuzzy model-id matching for the capability model picker (portal copy).
 *
 * Same rule as `fuzzyMatchModelId` in `@omnesis/core` (which the plain-JS
 * portal tree can't import): split the query on whitespace and require every
 * token to appear somewhere in the id, case-insensitive. Single-token
 * queries behave exactly like the old substring filter, so this only ever
 * widens recall — "deepseek flash" finds
 * `deepseek-ai/DeepSeek-V4-Flash-0731`.
 */

/** True when every whitespace-separated token of `query` occurs in `id`. */
export function fuzzyMatchModelId(id, query) {
  const tokens = String(query ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  const haystack = String(id ?? "").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/**
 * True when every query token occurs in at least one of `fields` — tokens
 * may match different fields (e.g. "example 4o" matches a Codex model whose
 * name holds "Example" and whose id holds "4o"). Missing fields are skipped.
 */
export function fuzzyMatchFields(fields, query) {
  const tokens = String(query ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  const haystacks = (fields ?? []).map((f) => String(f ?? "").toLowerCase());
  return tokens.every((token) => haystacks.some((hay) => hay.includes(token)));
}

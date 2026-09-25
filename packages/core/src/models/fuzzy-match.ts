// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Fuzzy model-id matching for the capability model picker.
 *
 * The OpenAI-compatible `/v1/models` surface a probed HTTP backend speaks can
 * list hundreds of ids (`deepseek-ai/DeepSeek-V4-Flash-0731`, …) while the
 * operator remembers a short name ("deepseek flash"). A plain substring match
 * forces them to type the id verbatim; this matcher instead splits the query
 * on whitespace and requires every token to appear somewhere in the id
 * (case-insensitive). Single-token queries behave exactly like the old
 * substring filter, so this only ever widens recall.
 *
 * Lives in core so every picker shares one definition: the gateway and CLI
 * import it directly, and the portal / Android / iOS surfaces port the same
 * rule (each keeps paired unit tests over the same vectors). Unlike the
 * ports — which coerce missing values to "" — this takes `string` and has no
 * null guards: callers pass typed ids, never unknown JSON.
 */

/** True when every whitespace-separated token of `query` occurs in `id`. */
export function fuzzyMatchModelId(id: string, query: string): boolean {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  const haystack = id.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

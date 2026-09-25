// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeForQuoteMatch } from "@omnesis/core";

/**
 * The evidence firewall's quote test — one normalized-substring predicate
 * shared by every consumer that must agree on "does this quote still appear
 * in that document": the annotation tools' write/revise firewall
 * (`steward/tools.ts`) and the content-change invalidators' surgical
 * quote-survival check (`storage/annotations.ts` /
 * `storage/person-annotations.ts`). A leaf module (only @omnesis/core) so the
 * storage layer (imported by the writer worker) never pulls the agent-tools
 * graph. The canonical form itself is @omnesis/core's `normalizeForQuoteMatch`
 * (case, whitespace, and typographic punctuation — curly quotes, dashes,
 * ellipsis — insensitive), shared with the agent package's citation verifier
 * so write-time acceptance and every later re-check agree.
 */

/** Canonical form for substring matching — delegates to the shared normalizer. */
function normalizeForMatch(s: string): string {
  return normalizeForQuoteMatch(s);
}

/**
 * Case- and whitespace-insensitive substring test — the reground teeth.
 * Typographic variants (curly/straight quotes, dash forms, NBSP, ellipsis)
 * are folded; other punctuation must match the source exactly.
 */
export function containsNormalized(haystack: string, needle: string): boolean {
  const n = normalizeForMatch(needle);
  return n.length > 0 && normalizeForMatch(haystack).includes(n);
}

/**
 * Normalizing a whole document body is O(content) and allocates a full copy;
 * the firewall does it once per grounding quote, so the Cognition Steward re-normalizes
 * the same evidence doc many times across a run (its firewall, entailment, and
 * per-atom checks), synchronously on the main event loop. This bounded cache
 * collapses those to one normalization per distinct content, keyed on the
 * document's `content_hash` — a change of content is a change of hash, so a
 * stale entry can never mask edited text (which would let the firewall pass a
 * quote no longer present). Keep it small: entries are normalized copies of
 * document bodies.
 */
const NORMALIZED_CACHE_MAX = 16;
const normalizedByContentHash = new Map<string, string>();

function normalizedForHash(contentHash: string, content: string): string {
  const cached = normalizedByContentHash.get(contentHash);
  if (cached !== undefined) {
    // Refresh LRU recency.
    normalizedByContentHash.delete(contentHash);
    normalizedByContentHash.set(contentHash, cached);
    return cached;
  }
  const normalized = normalizeForMatch(content);
  normalizedByContentHash.set(contentHash, normalized);
  if (normalizedByContentHash.size > NORMALIZED_CACHE_MAX) {
    const oldest = normalizedByContentHash.keys().next().value;
    if (oldest !== undefined) normalizedByContentHash.delete(oldest);
  }
  return normalized;
}

/** Like {@link containsNormalized}, but memoizes the normalized haystack by the
 *  document's content hash so repeated quote checks against one doc normalize
 *  its body once. Use for the firewall/entailment path where the same evidence
 *  doc is checked many times per run. */
export function containsNormalizedForContent(
  contentHash: string,
  content: string,
  needle: string,
): boolean {
  const n = normalizeForMatch(needle);
  return n.length > 0 && normalizedForHash(contentHash, content).includes(n);
}

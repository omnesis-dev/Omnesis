// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Hidden-from-general-search sources — the RETRIEVAL policy over the
 * cognition-authored registry (`brain/cognition-authored.ts`).
 *
 * A gateway-internal system source may mirror its records into the
 * document corpus purely to reuse the search INDEX (chunking,
 * embeddings, FTS) while staying invisible to ordinary user-facing
 * retrieval — open loops are the canonical case: general search never
 * surfaces them (the product reads them through the dedicated `/loops`
 * routes instead), but the Cognition Steward's `open_loop_search` tool needs
 * them indexed.
 *
 * Each candidate choke point (the lexical/browse WHERE builder, the
 * vector post-filter, the LIKE document search, the /documents listing)
 * excludes them via {@link hiddenSourceIdsToExclude}.
 *
 * Bypass rule: a hidden source is NOT excluded when the caller's
 * explicit filters already name it — by source id, or by one of the
 * document types it emits. That is how `open_loop_search` (search
 * filtered to type `open-loop`) reaches the documents everything else
 * never sees. A query that names a hidden source gets exactly that
 * source's usual search behavior; only *unscoped* retrieval hides it.
 *
 * This list is a SUBSET of the cognition-authored registry: hiding is opt-in
 * per entry, whereas the reactive plane's `isCognitionAuthoredDocument` drops
 * every entry with no bypass at all. An agent transcript is unreactable but
 * fully findable — see that module for why the two axes are independent.
 */

import {
  COGNITION_AUTHORED_SOURCES,
  type CognitionAuthoredSource,
} from "../brain/cognition-authored.js";

/** A hidden source under the retrieval policy. */
export interface HiddenSearchSource {
  readonly sourceId: string;
  /**
   * The types that address this source without naming its id — the key a
   * caller's `documentTypes` filter bypasses hiding with. These are the
   * registry's *exclusive* types: a type shared with ordinary corpus sources
   * could not identify anything, so it is never carried here.
   */
  readonly documentTypes: readonly string[];
}

/**
 * The registry entries that opt into hiding, projected onto the shape this
 * policy reads. Derived rather than hand-listed, so a source registered as
 * cognition-authored cannot be hidden from search by accident, nor forgotten
 * when it should be.
 */
export const HIDDEN_SEARCH_SOURCES: readonly HiddenSearchSource[] = Object.freeze(
  COGNITION_AUTHORED_SOURCES.filter((s: CognitionAuthoredSource) => s.hiddenFromSearch).map((s) =>
    Object.freeze({ sourceId: s.sourceId, documentTypes: s.exclusiveDocumentTypes }),
  ),
);

/** The slice of search/listing filters the bypass rule reads. */
export interface HiddenSourceFilterContext {
  sourceIds?: readonly string[];
  documentTypes?: readonly string[];
  /**
   * Opt-in cognitive projection (experimental): when true, NOTHING is hidden —
   * the cognitive mirrors (open loops) surface in ordinary search. The single
   * logical flip that makes the understanding layer searchable; the gateway
   * only ever sets it under experimental mode, so a non-experimental gateway is
   * byte-identical to before this flag existed.
   */
  includeHidden?: boolean;
}

/**
 * Source ids to exclude from a candidate query, after applying the
 * bypass rule to the caller's explicit filters. Empty array = nothing
 * to exclude (the common case — callers can skip their clause entirely).
 */
export function hiddenSourceIdsToExclude(
  filters: HiddenSourceFilterContext = {},
  registry: readonly HiddenSearchSource[] = HIDDEN_SEARCH_SOURCES,
): string[] {
  if (filters.includeHidden) return [];
  const out: string[] = [];
  for (const hidden of registry) {
    if (filters.sourceIds?.includes(hidden.sourceId)) continue;
    if (filters.documentTypes?.some((t) => hidden.documentTypes.includes(t))) continue;
    out.push(hidden.sourceId);
  }
  return out;
}

/** The document types emitted by hidden cognitive mirrors — the down-weight key. */
const HIDDEN_SEARCH_TYPES: ReadonlySet<string> = new Set(
  HIDDEN_SEARCH_SOURCES.flatMap((s) => s.documentTypes),
);

/**
 * True for a document type that is a hidden cognitive mirror (e.g. `open-loop`).
 * The ranking layer down-weights these when cognitive projection surfaces them,
 * so a short, high-term-density mirror can't out-rank the real documents it
 * summarises.
 */
export function isHiddenSearchType(documentType: string | null | undefined): boolean {
  return documentType != null && HIDDEN_SEARCH_TYPES.has(documentType);
}

/**
 * Merge the hidden-source exclusions into an existing exclude list —
 * the `/documents` listing shape (`excludeSourceIds`/`includeSourceIds`).
 */
export function withHiddenSourcesExcluded(
  excludeSourceIds: readonly string[] | undefined,
  includeSourceIds: readonly string[] | undefined,
): string[] | undefined {
  const hidden = hiddenSourceIdsToExclude({ sourceIds: includeSourceIds });
  if (hidden.length === 0) return excludeSourceIds ? [...excludeSourceIds] : undefined;
  const merged = new Set([...(excludeSourceIds ?? []), ...hidden]);
  return [...merged];
}

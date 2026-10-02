// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one traversal policy behind graph context. Search graph context,
 * `fetch_many` neighbours and `trace_connections` follow the same document
 * links and skip the same documents, so a follow-up walk from a search fact
 * never reaches what the search deliberately left out.
 */
import { GRAPH_CONTEXT_LINK_TYPES, type GraphContextOptionalLinkType } from "@omnesis/core";
import { isCognitionAuthoredDocument } from "../brain/cognition-authored.js";
import { sourceMatchesAnyPrefix } from "../data/source-addressing.js";
import { hiddenSourceIdsToExclude } from "./hidden-sources.js";
import type { GraphTraversalPolicy } from "../domain/DocumentGraphService.js";

/**
 * The graph context policy, optionally widened by link types a caller names.
 * It leaves out hidden sources and Omnesis-generated documents, whose links
 * are not evidence of anything in the user's life.
 */
export function graphContextPolicy(
  extraLinkTypes: readonly GraphContextOptionalLinkType[] = [],
): GraphTraversalPolicy {
  const hidden = hiddenSourceIdsToExclude();
  return {
    linkTypes: new Set<string>([...GRAPH_CONTEXT_LINK_TYPES, ...extraLinkTypes]),
    excludes: (sourceId, documentType) =>
      sourceMatchesAnyPrefix(sourceId, hidden) ||
      isCognitionAuthoredDocument(sourceId, documentType),
  };
}

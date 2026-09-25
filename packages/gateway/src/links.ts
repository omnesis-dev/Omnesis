// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Forwarder shell — see `data/repositories/` and `domain/` for the
 * implementations. Kept so existing import paths (`./links.js`)
 * continue to work; new code should import from the canonical home.
 */

import { invalidateUrlIdPatternCache } from "./db.js";
import { markLinkStatsDirty } from "./data/DirtyMarks.js";
export { markLinkStatsDirty };
export {
  computeLinkStats,
  upsertLinkStats,
  getLinkStats,
} from "./data/repositories/LinkStatsRepository.js";
export type { LinkStats, LinkStatsAggregation } from "./data/repositories/LinkStatsRepository.js";

// Re-export extraction orchestration (moved to domain/LinkExtraction.ts).
export {
  extractLinksForBatch,
  resolveExtractedLinks,
  withResolvedTargets,
  upsertExtractedLinksBatch,
} from "./domain/LinkExtraction.js";
export type { ExtractedLinkBatchEntry } from "./domain/LinkExtraction.js";

// Re-export graph resolution heuristics (moved to domain/LinkGraphService.ts).
export {
  resolveInboundLinks,
  computeLinkResolutions,
  DIRECT_RESOLVABLE_SCAN_SQL,
  DIRECT_URL_OWNER_LOOKUP_SQL,
  OWNERSHIP_LINK_SCAN_SQL,
  OWNERSHIP_DOCUMENT_SCAN_SQL,
  PATTERN_OWNER_LOOKUP_SQL,
  upsertLinkResolutions,
  upsertLinkResolutionsYieldable,
  LINK_RECONCILE_APPLY_CHUNK_SIZE,
  reconcileUnresolvedLinks,
} from "./domain/LinkGraphService.js";
export type {
  LinkResolution,
  LinkReconcileBatch,
  LinkReconcileApplyState,
} from "./domain/LinkGraphService.js";

// Re-export per-document reference queries (moved to data/repositories/DocumentLinksRepository.ts).
export {
  getDocumentRefs,
  getDocumentRefsPage,
  getDocumentEdges,
  getInboundRefCounts,
} from "./data/repositories/DocumentLinksRepository.js";
export type {
  DocumentRefs,
  OutboundRef,
  InboundRef,
  DocumentEdge,
  PendingEdgeView,
  DocumentEdgesView,
} from "./data/repositories/DocumentLinksRepository.js";

/**
 * Re-export so existing callers (server.ts) keep their import path. The actual
 * cache lives in `db.ts` and is shared by URL resolution paths.
 */
export const invalidateUrlPatternCache = invalidateUrlIdPatternCache;

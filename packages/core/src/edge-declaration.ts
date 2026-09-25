// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The source-declared edge contract (#430).
 *
 * A source declares structural relationships between documents alongside the
 * documents themselves, as a first-class output of `sync()` (the `edges` field
 * on `SyncResult` / `StructuredSyncResult`). The gateway writer resolves each
 * endpoint to an internal `documentId`, persists the edge into `document_links`
 * with `source-declared` provenance, holds forward references in `pending_edges`
 * until both endpoints exist, and diffs-and-deletes within scope on re-sync.
 *
 * This is the EXPLICIT declaration path. The implicit one — the `metadata.extra`
 * conventions (`parentExternalId`, `threadId`, `links`) that `extractLinks`
 * reads — produces the same `source-declared` edges for sources that haven't
 * adopted the explicit contract. New / richer relationships a convention can't
 * express (`replies-to` from an `In-Reply-To` header, `succeeds` between
 * recurring instances, cross-source `accompanies`) ride this contract.
 */

import { normalizeUrl, urlToExternalId, type UrlCanonicalizerSpec } from "./url-utils.js";
import type { SourceEdgeType } from "./link-extractor.js";

/**
 * How an `EdgeDeclaration` names one of its endpoints. Sources don't know
 * Omnesis `documentId`s at emit time, so endpoints are named by source-native
 * id; the writer maps `(sourceId, sourceDocumentId) → documentId` at ingest.
 *
 *  - `internal` — a document THIS source emitted (now or in a previous sync).
 *    Resolved against the declaring source's own `sourceId`.
 *  - `external` — a document owned by ANOTHER source (a Chrome bookmark ↔ a
 *    browser-captured page). The trust model is fuzzier, so
 *    the writer logs cross-source claims; supported but used sparingly.
 */
export type DocumentRef =
  | { kind: "internal"; sourceDocumentId: string }
  | { kind: "external"; sourceId: string; sourceDocumentId: string };

/**
 * One structural edge a source declares between two documents. Emitted in the
 * same sync batch as the documents it relates, so the source asserts the
 * knowledge at the moment it has it.
 */
export interface EdgeDeclaration {
  /** The edge's source endpoint (the `from` of a directed edge). */
  from: DocumentRef;
  /** The edge's target endpoint (the `to` of a directed edge). */
  to: DocumentRef;
  /** The structural relationship — a member of the closed `SourceEdgeType` set. */
  type: SourceEdgeType;
  /**
   * Position in an ordered relationship — thread position, list order,
   * sequence index. Persisted into `metadata_json` so a renderer can order
   * `part-of-thread` members or `succeeds` chains. Optional.
   */
  ordering?: number;
  /**
   * Free-form per-edge details persisted to `document_links.metadata_json`
   * (e.g. `{ role: "attachment" }` for a containment flavour). Conventions for
   * the keys live in the source-author guide; the shape is not enforced.
   */
  metadata?: Record<string, unknown>;
}

/**
 * The `source_id` the unified Web Pages dataset (#895) stores every `webpage`
 * document under. A producer that knows a URL the user encountered — a Chrome
 * bookmark, a browser-history day — declares an `EdgeDeclaration` toward the
 * canonical web-page entity addressed by this source id, so the edge resolves
 * (now or via `pending_edges`) to the canonical browser-captured `webpage`.
 */
export const WEB_PAGE_SOURCE_ID = "web";

/**
 * Build the `EdgeDeclaration.to` ref for the canonical `webpage` entity a raw
 * URL resolves to. The target is `{ kind: "external", sourceId: "web",
 * sourceDocumentId: SHA256(normalizeUrl(url)) }`, so a declared edge from a
 * bookmark or history day joins the exact `web` row the browser extension
 * writes, resolving immediately if the page is already captured and deferring in
 * `pending_edges` otherwise.
 *
 * `canonicalizers`, when supplied, runs the URL through the per-host
 * canonicalizer registry so a producer matches the gateway's normalization; a
 * producer that can't bundle the registry (an MV3 extension) omits it and the
 * generic normalization still aligns on the steps that matter for these hosts.
 */
export function webPageEdgeTarget(
  url: string,
  canonicalizers?: ReadonlyMap<string, UrlCanonicalizerSpec>,
): DocumentRef {
  return {
    kind: "external",
    sourceId: WEB_PAGE_SOURCE_ID,
    sourceDocumentId: urlToExternalId(normalizeUrl(url, canonicalizers)),
  };
}

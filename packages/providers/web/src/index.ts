// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineStructuredSource, type SyncCursor } from "@omnesis/source-sdk";
import { allSchemas } from "./schemas.js";
import { webIcon } from "./icon.js";

/**
 * Web Pages is a push-based source populated by the browser extension.
 * `create()` is an inert stub present only to satisfy the structured-source
 * contract — the collector never invokes it for a push source.
 *
 * `gatewayHosted: true`: because no collector ever syncs `web`, the **gateway**
 * owns this descriptor — it advertises it (in `/admin/source-descriptors`) and
 * seeds its display identity (icon/label/colors) directly, so the source renders
 * as a single "Web Pages" tile across clients even with no collector connected.
 * Collectors still carry this package in their registry but deliberately exclude
 * `gatewayHosted` descriptors from what they advertise. See
 * `SourceDescriptor.gatewayHosted`.
 *
 * `urlHub: true`: the web-page entity is the graph hub — a dense bag of
 * referential URLs with no structural story — so the gateway skips `url`-typed
 * edges through these documents during subgraph walks.
 *
 * `urlTargetRole: "fallback"`: a captured page is retained, but when a
 * dedicated source later contributes a document with the same canonical URL,
 * inbound URL links prefer that structured document and the capture connects
 * to it through `same-resource`.
 *
 * Not experimental: the source is inert until an extension pairs, so it ships
 * registered without surprising an operator. It owns no
 * web domains (`ownedWebDomains` is for sources that already cover a site so the
 * extension skips it — `web` captures the long tail, it covers nothing), so the
 * field is intentionally omitted.
 */
export default defineStructuredSource<SyncCursor>({
  id: "web",
  name: "Web Pages",
  description: "Web pages captured by the Omnesis browser extension",
  provider: { id: "web", name: "Web" },
  authType: "local",
  unitName: "web pages",
  // Headline count = the document (page) total, not the small `page_visits`
  // analytics log. Without this, the generic count heuristic prefers the
  // analytics row count and the source reads as e.g. "19 visits" instead of
  // "1,095 web pages" (#993). Read generically by the portal/CLI Count column.
  primaryCount: "documents",
  // Hosted by the gateway, not a collector: documents arrive via the browser
  // extension's HTTP push, and no collector ever syncs `web`. So the gateway
  // owns and advertises this descriptor (and seeds
  // its display identity); collectors exclude it from what they advertise even
  // though they still carry this package in their registry. See
  // `SourceDescriptor.gatewayHosted`.
  gatewayHosted: true,
  singleInstance: true,
  execution: "external",
  // The web-page entity is the graph hub: a referential URL bag with no
  // structural story — skip `url` edges through it in subgraph walks.
  urlHub: true,
  urlTargetRole: "fallback",
  // Web pages are bulky and low-signal compared to personal docs; a small
  // additive downweight pushes a captured page below an email or note
  // matching the same query — unless BM25 finds a strong rare-token match, in
  // which case the bypass keeps the page visible.
  defaultSourcePrior: -0.04,
  icon: webIcon,
  analyticsSchemas: allSchemas,

  // Inert: never invoked for a push-based source. The collector skips sync
  // scheduling entirely (see `source-manager.ts` / `sync-engine.ts`); the
  // factory exists only to satisfy the structured-source contract.
});

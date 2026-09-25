// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Canonical identity of the Web Pages dataset.
 *
 * The gateway-hosted `web` source owns every `webpage` document produced by the
 * browser extension. Each captured page upserts the
 * `(provider_id="web", source_id="web", external_id=SHA256(normalizeUrl(url)))`
 * row.
 *
 * Consumers that render the source read it generically through the descriptor
 * registry. These constants keep gateway-side source metadata and URL graph
 * identity aligned with the extension.
 *
 * The descriptor that owns the dataset lives in `@omnesis/provider-web`.
 */

import { WEB_PAGE_SOURCE_ID } from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";

/**
 * The `source_id` every web-page document is stored under. Re-exported from the
 * canonical `@omnesis/core` constant so the gateway-internal write side and the
 * producer-facing edge target (`webPageEdgeTarget`) never drift.
 */
export const WEB_SOURCE_ID = WEB_PAGE_SOURCE_ID;

/** The `provider_id` every web-page document is stored under. */
export const WEB_PROVIDER_ID = "web";

/** The `documentType` every web-page document carries (`metadata.documentType`). */
export const WEB_DOCUMENT_TYPE = "webpage";

/** Branded `ProviderId` for the Web Pages dataset, for `DocumentInput.providerId`. */
export const WEB_PROVIDER = ProviderId(WEB_PROVIDER_ID);

/** Branded `SourceId` for the Web Pages dataset, for `DocumentInput.sourceId`. */
export const WEB_SOURCE = SourceId(WEB_SOURCE_ID);

/**
 * Default additive search-score prior for `web` documents.
 *
 * The `web` descriptor (`@omnesis/provider-web`) declares the same value as its
 * `defaultSourcePrior`, and the collector pushes it once `web` is configured.
 * The gateway seeds the value because `web` is gateway-hosted and has no
 * configured collector instance to push the prior. Web pages are bulky and
 * low-signal compared to personal docs; a small additive downweight keeps
 * them below an email or note matching the same query unless BM25 has a strong
 * rare-token hit. Kept in sync with the descriptor by `provider-web`'s
 * setup test.
 */
export const WEB_DEFAULT_SOURCE_PRIOR = -0.04;

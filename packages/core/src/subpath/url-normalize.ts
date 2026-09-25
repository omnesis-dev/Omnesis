// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/url-normalize` — the dependency-free URL normalizer.
 *
 * A browser-bundle-safe surface (imports no `node:crypto`, no zod) so the
 * Manifest V3 browser-capture extension can consume the canonical
 * `normalizeUrl`, rather than maintaining a divergent mirror.
 */

export {
  normalizeUrl,
  buildCanonicalizerRegistry,
  hostIsOwned,
  TRACKING_PARAMS,
  CREDENTIAL_PARAMS,
  type UrlCanonicalizerSpec,
} from "../url-normalize.js";

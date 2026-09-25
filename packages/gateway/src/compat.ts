// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * This gateway build's compatibility manifest. Combines the static
 * `@omnesis/core` facts (wire protocols, store policies, config generation,
 * HTTP-API policy) with the two runtime numbers the gateway owns — its
 * product version and the main-DB schema head. Surfaced on
 * `GET /admin/compat` (full) and a subset on `GET /health`.
 */

import { buildCompatManifest, type CompatManifest } from "@omnesis/core";
import { GATEWAY_VERSION } from "./version.js";
import { LATEST_SCHEMA_VERSION } from "./data/migrations.js";

export const GATEWAY_COMPAT: CompatManifest = buildCompatManifest({
  productVersion: GATEWAY_VERSION,
  mainDbSchemaVersion: LATEST_SCHEMA_VERSION,
});

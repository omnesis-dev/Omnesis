// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/client-version` — product-version parsing and ordering.
 *
 * Dependency-free (no `node:*`, no zod), so a browser bundle such as the
 * Manifest V3 extension can compare the gateway's advertised version against
 * its own floor with the same rules the gateway applies to its clients.
 */

export { compareProductVersions, parseProductVersion } from "../client-version.js";

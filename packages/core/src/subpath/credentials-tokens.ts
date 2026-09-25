// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `@omnesis/core/credentials-tokens` — the dependency-free `{gatewayOrigin}`
 * token expansion for credentials specs.
 *
 * A browser-bundle-safe surface (imports no `node:*`, no zod) so the portal's
 * vendored bundle can expand the SAME token the CLI wizard does, rather than
 * re-declaring the string logic in a portal-local copy that could drift. The
 * only `credentials.js` reference is a `import type`, which is erased at
 * compile time — the same approach as `@omnesis/core/url-normalize`.
 */

export {
  GATEWAY_ORIGIN_TOKEN,
  resolveGatewayOrigin,
  expandGatewayOriginToken,
  publicBaseUrlFromAdminConfig,
  expandSpecTokens,
} from "../credentials-tokens.js";

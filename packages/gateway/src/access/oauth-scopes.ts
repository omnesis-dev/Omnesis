// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { MCP_ACCESS_SCOPE } from "./types.js";

export const OAUTH_OFFLINE_ACCESS_SCOPE = "offline_access";

/**
 * MCP authorization-code requests require delegated access. `offline_access`
 * remains an accepted compatibility hint, but refresh-token issuance is based
 * on the client's registered grant types rather than this optional scope.
 */
export function normalizeInteractiveOAuthScope(scope: string): string | null {
  const values = scope.split(/\s+/).filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) return null;
  if (!values.includes(MCP_ACCESS_SCOPE)) return null;
  if (values.some((value) => value !== MCP_ACCESS_SCOPE && value !== OAUTH_OFFLINE_ACCESS_SCOPE)) {
    return null;
  }
  return values.join(" ");
}

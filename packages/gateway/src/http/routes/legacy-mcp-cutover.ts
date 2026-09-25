// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scope } from "../scope.js";
import { noStore } from "./oauth-access-shared.js";
import type { DeviceId, DeviceRecord, TokenId } from "@omnesis/types";
import type { RouteApp } from "./types.js";

/**
 * Revoke the exact legacy stdio-MCP bearer presented by the caller.
 *
 * Old MCP profiles did not retain their device/token ids, so the cutover CLI
 * proves possession of each secret instead. The route is deliberately unable
 * to name or revoke anything else and accepts only the old one-scope CLI shape.
 */
export function mountLegacyMcpCutoverRoute(
  app: RouteApp,
  deps: {
    getDevice: (deviceId: DeviceId) => DeviceRecord | null;
    revokeToken: (tokenId: TokenId) => Promise<boolean>;
  },
): void {
  app.post("/legacy-mcp/revoke", noStore, scope.legacyMcpSelfRevoke(), async (c) => {
    const auth = c.get("auth");
    if (auth.authMethod !== "bearer" || !auth.deviceId || !auth.tokenId) {
      return c.json({ error: "legacy MCP credential required" }, 401);
    }
    if (deps.getDevice(auth.deviceId)?.kind !== "cli") {
      return c.json({ error: "credential is not a legacy MCP CLI credential" }, 409);
    }
    return c.json({ revoked: await deps.revokeToken(auth.tokenId) });
  });
}

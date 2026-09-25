// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import {
  DeviceId,
  SCOPE_ANSWER,
  SCOPE_READ,
  TokenId,
  type DeviceRecord,
  type Scope,
} from "@omnesis/types";

import { strictRoute } from "../scope.js";
import { mountLegacyMcpCutoverRoute } from "./legacy-mcp-cutover.js";
import type { AppEnv } from "./types.js";

function fixture(scopes: Scope[], kind: DeviceRecord["kind"] = "cli") {
  const app = strictRoute(new Hono<AppEnv>());
  const deviceId = DeviceId("11111111-1111-4111-8111-111111111111");
  const tokenId = TokenId("22222222-2222-4222-8222-222222222222");
  const revokeToken = vi.fn(async () => true);
  app.use("*", async (c, next) => {
    c.set("auth", { authMethod: "bearer", deviceId, tokenId, scopes });
    await next();
  });
  mountLegacyMcpCutoverRoute(app, {
    getDevice: () => ({ id: deviceId, kind }) as DeviceRecord,
    revokeToken,
  });
  return { app, revokeToken, tokenId };
}

describe("legacy MCP credential cutover", () => {
  test.each([SCOPE_ANSWER, SCOPE_READ])("self-revokes one exact legacy %s token", async (scope) => {
    const { app, revokeToken, tokenId } = fixture([scope]);
    const response = await app.request("http://gateway.test/legacy-mcp/revoke", {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    expect(revokeToken).toHaveBeenCalledWith(tokenId);
  });

  test("refuses to classify an operational device as a legacy MCP profile", async () => {
    const { app, revokeToken } = fixture([SCOPE_READ], "collector");
    const response = await app.request("http://gateway.test/legacy-mcp/revoke", {
      method: "POST",
    });
    expect(response.status).toBe(409);
    expect(revokeToken).not.toHaveBeenCalled();
  });
});

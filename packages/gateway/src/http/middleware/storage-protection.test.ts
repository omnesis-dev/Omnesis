// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { DeviceId, TokenId } from "@omnesis/types";
import { errorResponse, HttpError } from "../errors.js";
import { storageProtectionMiddleware } from "./storage-protection.js";
import type { AppEnv } from "../routes/types.js";
import type { GatewayStorageProtection } from "../../storage-protection.js";

function fixture(strict: boolean, protection?: GatewayStorageProtection) {
  const app = new Hono<AppEnv>();
  const admitted = vi.fn();
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: DeviceId("11111111-1111-4111-8111-111111111111"),
      tokenId: TokenId("22222222-2222-4222-8222-222222222222"),
      scopes: [],
    });
    return next();
  });
  app.use(
    "*",
    storageProtectionMiddleware({ requiresEncryptedStorage: () => strict }, () => protection),
  );
  app.all("*", (c) => {
    admitted();
    return c.json({ ok: true });
  });
  return { app, admitted };
}

test.each([
  undefined,
  { version: 1, atRest: "unprotected" },
  { version: 1, atRest: "unavailable" },
] as const)(
  "a stored encryption requirement refuses reads and writes without positive startup evidence: %j",
  async (protection) => {
    const { app, admitted } = fixture(true, protection);
    for (const [path, method] of [
      ["/documents", "GET"],
      ["/ingest", "POST"],
      ["/device/ws", "GET"],
    ]) {
      const reply = await app.request(path!, { method });
      expect(reply.status).toBe(503);
      expect(reply.headers.get("retry-after")).toBe("5");
      expect(await reply.json()).toMatchObject({ code: "STORAGE_PROTECTION_REQUIRED" });
    }
    expect(admitted).not.toHaveBeenCalled();
    for (const path of ["/health", "/whoami"]) expect((await app.request(path)).status).toBe(200);
  },
);

test("protected desktop and existing headless clients retain their authorized surface", async () => {
  for (const target of [fixture(true, { version: 1, atRest: "encrypted" }), fixture(false)]) {
    expect((await target.app.request("/documents")).status).toBe(200);
    expect((await target.app.request("/ingest", { method: "POST" })).status).toBe(200);
    expect(target.admitted).toHaveBeenCalledTimes(2);
  }
});

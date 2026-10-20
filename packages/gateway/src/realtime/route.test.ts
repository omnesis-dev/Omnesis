// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { DeviceId, TokenId } from "@omnesis/types";
import { HttpError, errorResponse } from "../http/errors.js";
import { mountRealtimeRoutes } from "./route.js";
import type { Context } from "hono";
import type { NodeWebSocket } from "@hono/node-ws";
import type { AppEnv, AuthContext } from "../http/routes/types.js";
import type { RealtimeService } from "./service.js";

function fixture(auth: AuthContext | undefined, available = true) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    return next();
  });
  const upgrade = vi.fn(() =>
    vi.fn((c: Context<AppEnv>) => c.json({ upgraded: true })),
  ) as unknown as NodeWebSocket["upgradeWebSocket"];
  const service = {
    capability: () => ({ available }),
    open: vi.fn(),
  } as unknown as RealtimeService;
  mountRealtimeRoutes(app, service, upgrade);
  return app;
}
const owner: AuthContext = {
  authMethod: "bearer",
  deviceId: DeviceId("00000000-0000-4000-8000-000000000001"),
  tokenId: TokenId("00000000-0000-4000-8000-000000000002"),
  scopes: ["admin"],
};

describe("realtime route authority", () => {
  it("requires admin scope for discovery and upgrade", async () => {
    for (const auth of [undefined, { ...owner, scopes: ["read"] } as AuthContext]) {
      const app = fixture(auth);
      expect((await app.request("/agent/realtime")).status).toBe(auth ? 403 : 401);
      expect((await app.request("/agent/realtime/ws")).status).toBe(auth ? 403 : 401);
    }
  });
  it("advertises only capability and rejects unavailable upgrades", async () => {
    const app = fixture(owner, false);
    expect(await (await app.request("/agent/realtime")).json()).toEqual({ available: false });
    expect((await app.request("/agent/realtime/ws")).status).toBe(404);
  });
  it("requires a bearer credential and validates query before upgrade", async () => {
    const cookie: AuthContext = {
      ...owner,
      authMethod: "portal-session",
      deviceId: null,
      credentialDeviceId: null,
      csrfToken: "fictional-csrf",
    };
    expect((await fixture(cookie).request("/agent/realtime/ws")).status).toBe(403);
    expect((await fixture(owner).request("/agent/realtime/ws?conversationId=")).status).toBe(400);
    expect(
      (await fixture(owner).request("/agent/realtime/ws?conversationId=existing")).status,
    ).toBe(200);
  });
});

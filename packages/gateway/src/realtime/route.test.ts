// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineWebSocketHelper, WSContext, type WSEvents } from "hono/ws";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { DeviceId, Scope, TokenId } from "@omnesis/types";
import { AgentError } from "../agent/service.js";
import { HttpError, errorResponse } from "../http/errors.js";
import { RealtimeAdmissionError, callError } from "./call-error.js";
import { mountRealtimeRoutes } from "./route.js";
import type WebSocket from "ws";
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
  scopes: [Scope("admin")],
};

describe("realtime route authority", () => {
  it.each([
    [new RealtimeAdmissionError(callError("session_busy")), "session_busy", 1013],
    [new RealtimeAdmissionError(callError("pairing_rejected")), "pairing_rejected", 1008],
    [new RealtimeAdmissionError(callError("unavailable")), "unavailable", 1013],
    [new AgentError("session_not_found", "PRIVATE_SENTINEL"), "session_not_found", 1013],
    [new Error("PRIVATE_SENTINEL"), "connection_error", 1013],
  ] as const)(
    "projects safe upgrade admission errors before closing (%s)",
    async (failure, code, status) => {
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("auth", owner);
        await next();
      });
      let handlers: WSEvents<WebSocket> | undefined;
      const upgrade = defineWebSocketHelper<WebSocket>((c, events) => {
        handlers = events;
        return c.json({ upgraded: true });
      });
      const service = {
        capability: () => ({ available: true }),
        open: () => {
          throw failure;
        },
      } as unknown as RealtimeService;
      mountRealtimeRoutes(app, service, upgrade);
      await app.request("/agent/realtime/ws");
      const sent: string[] = [];
      const closed = vi.fn();
      const ws = new WSContext<WebSocket>({
        readyState: 1,
        send: (data) => sent.push(String(data)),
        close: closed,
      });
      handlers?.onOpen?.(new Event("open"), ws);
      expect(JSON.parse(sent[0]!)).toMatchObject({ type: "error", error: { code, fatal: true } });
      expect(sent.join(" ")).not.toContain("PRIVATE_SENTINEL");
      expect(closed).toHaveBeenCalledWith(status, `voice_error:${code}`);
    },
  );
  it("requires admin scope for discovery and upgrade", async () => {
    for (const auth of [undefined, { ...owner, scopes: [Scope("read")] }]) {
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
  it.each([undefined, "1", "2"])(
    "accepts supported media version %s including absent legacy version",
    async (version) => {
      const response = await fixture(owner).request("/agent/realtime/ws", {
        headers: version ? { "X-Omnesis-Realtime-Version": version } : {},
      });
      expect(response.status).toBe(200);
    },
  );
  it.each(["0", "3", "2.0", "future"])(
    "rejects unsupported media version %s before upgrade",
    async (version) => {
      const response = await fixture(owner).request("/agent/realtime/ws", {
        headers: { "X-Omnesis-Realtime-Version": version },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Unsupported realtime protocol version (supported: 1–2)",
      });
    },
  );
  it.each([undefined, "1", "0", "future"])(
    "validates optional recoverable-error opt-in %s",
    async (value) => {
      const response = await fixture(owner).request("/agent/realtime/ws", {
        headers: value ? { "X-Omnesis-Realtime-Recoverable-Errors": value } : {},
      });
      expect(response.status).toBe(value === undefined || value === "1" ? 200 : 400);
    },
  );
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

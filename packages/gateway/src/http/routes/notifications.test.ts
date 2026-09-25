// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";

import { DeviceId, SCOPE_PUSH_CLAIM, SCOPE_READ, TokenId, type Scope } from "@omnesis/types";
import { errorResponse, HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountNotificationRoutes } from "./notifications.js";
import type { AppEnv, AuthContext } from "./types.js";

const DEVICE_ID = DeviceId("11111111-1111-4111-8111-111111111111");
const TOKEN_ID = TokenId("22222222-2222-4222-8222-222222222222");
const LEASE_ID = "33333333-3333-4333-8333-333333333333";

function bearer(scopes: Scope[]): AuthContext {
  return { authMethod: "bearer", deviceId: DEVICE_ID, tokenId: TOKEN_ID, scopes };
}

function appWith(auth: AuthContext | null, deps?: Parameters<typeof mountNotificationRoutes>[1]) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    await next();
  });
  const routeDeps =
    deps ??
    ({
      claim: vi.fn(async () => null),
      confirm: vi.fn(async () => false),
    } satisfies Parameters<typeof mountNotificationRoutes>[1]);
  mountNotificationRoutes(strictRoute(app), routeDeps);
  return { app, deps: routeDeps };
}

describe("notification claim routes", () => {
  test("claim is bearer-device-bound and returns only that device's leased content", async () => {
    const claimed = {
      id: LEASE_ID,
      kind: "brief" as const,
      targetId: "brief-fictional",
      title: "Fictional brief",
      body: "An invented summary is ready.",
      collapseId: "brief:fictional",
      remaining: 2,
    };
    const claim = vi.fn(async () => claimed);
    const { app } = appWith(bearer([SCOPE_PUSH_CLAIM]), {
      claim,
      confirm: vi.fn(async () => false),
    });
    const response = await app.request("/notifications/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(claimed);
    expect(claim).toHaveBeenCalledWith(DEVICE_ID);
  });

  test("claim rejects missing and insufficient credentials before calling the service", async () => {
    for (const auth of [null, bearer([SCOPE_READ])]) {
      const claim = vi.fn(async () => null);
      const { app } = appWith(auth, { claim, confirm: vi.fn(async () => false) });
      const response = await app.request("/notifications/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(auth ? 403 : 401);
      expect(claim).not.toHaveBeenCalled();
    }
  });

  test("claim rejects portal sessions even when their scope set includes push:claim", async () => {
    const claim = vi.fn(async () => null);
    const portalAuth: AuthContext = {
      authMethod: "portal-session",
      deviceId: null,
      tokenId: TOKEN_ID,
      scopes: [SCOPE_PUSH_CLAIM],
      csrfToken: "a".repeat(64),
    };
    const { app } = appWith(portalAuth, { claim, confirm: vi.fn(async () => false) });
    const response = await app.request("/notifications/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(claim).not.toHaveBeenCalled();
  });

  test("claim rejects content-bearing bodies at the JSON boundary", async () => {
    const claim = vi.fn(async () => null);
    const { app } = appWith(bearer([SCOPE_PUSH_CLAIM]), {
      claim,
      confirm: vi.fn(async () => false),
    });
    const response = await app.request("/notifications/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "must stay local" }),
    });
    expect(response.status).toBe(400);
    expect(claim).not.toHaveBeenCalled();
  });

  test("confirm validates the lease id and maps absent device-owned leases to canonical 404", async () => {
    const confirm = vi.fn(async () => false);
    const { app } = appWith(bearer([SCOPE_PUSH_CLAIM]), {
      claim: vi.fn(async () => null),
      confirm,
    });
    const invalid = await app.request("/notifications/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "not-a-uuid" }),
    });
    expect(invalid.status).toBe(400);
    expect(confirm).not.toHaveBeenCalled();

    const missing = await app.request("/notifications/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: LEASE_ID }),
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
    expect(confirm).toHaveBeenCalledWith(DEVICE_ID, LEASE_ID);
  });
});

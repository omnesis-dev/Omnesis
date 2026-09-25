// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { SCOPE_ADMIN, type TokenId } from "@omnesis/types";
import { ConflictError, errorResponse, HttpError, ServiceUnavailableError } from "../../errors.js";
import { strictRoute } from "../../scope.js";
import { mountHostFleetUpdateRoutes } from "./host-fleet-update.js";
import type { AdminRoutesDeps } from "./internals.js";
import type { AppEnv, AuthContext } from "../types.js";

const CSRF = "a".repeat(64);

function appFor(auth: AuthContext | null) {
  const app = strictRoute(new Hono<AppEnv>());
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    await next();
  });
  const service = {
    snapshot: vi.fn(() => ({ plan: null, operation: null })),
    start: vi.fn(async () => ({
      id: "123e4567-e89b-42d3-a456-426614174000",
      currentVersion: "1.4.0",
      targetVersion: "1.5.0",
      releaseCheckedAt: "2026-09-16T12:00:00.000Z",
      state: "queued",
      startedAt: "2026-09-16T12:01:00.000Z",
      updatedAt: "2026-09-16T12:01:00.000Z",
    })),
  };
  mountHostFleetUpdateRoutes(app, {
    hostFleetUpdateService: service,
  } as unknown as AdminRoutesDeps);
  return { app, service };
}

function portalAuth(): AuthContext {
  return {
    authMethod: "portal-session",
    deviceId: null,
    credentialDeviceId: null,
    tokenId: "token_test" as TokenId,
    scopes: [SCOPE_ADMIN],
    csrfToken: CSRF,
  };
}

describe("portal host fleet update routes", () => {
  test("rejects ordinary bearer admin credentials", async () => {
    const { app } = appFor({
      authMethod: "bearer",
      deviceId: null,
      tokenId: "token_test" as TokenId,
      scopes: [SCOPE_ADMIN],
    });
    const response = await app.request("/admin/fleet/host-update", {
      headers: { "X-Omnesis-CSRF": CSRF },
    });
    expect(response.status).toBe(403);
  });

  test("requires the portal synchronizer token even for the plan/status read", async () => {
    const { app } = appFor(portalAuth());
    expect((await app.request("/admin/fleet/host-update")).status).toBe(403);
    expect(
      (
        await app.request("/admin/fleet/host-update", {
          headers: { "X-Omnesis-CSRF": CSRF },
        })
      ).status,
    ).toBe(200);
  });

  test("validates the opaque plan id and starts only through the service", async () => {
    const { app, service } = appFor(portalAuth());
    const malformed = await app.request("/admin/fleet/host-update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Omnesis-CSRF": CSRF },
      body: JSON.stringify({ planId: "1.5.0", command: "anything" }),
    });
    expect(malformed.status).toBe(400);
    expect(service.start).not.toHaveBeenCalled();

    const planId = "b".repeat(64);
    const started = await app.request("/admin/fleet/host-update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Omnesis-CSRF": CSRF },
      body: JSON.stringify({ planId }),
    });
    expect(started.status).toBe(202);
    expect(service.start).toHaveBeenCalledWith(planId);
  });

  test("reports a stale reviewed plan as a conflict", async () => {
    const { app, service } = appFor(portalAuth());
    service.start.mockRejectedValueOnce(
      new ConflictError("The release plan changed. Review the current transition and try again."),
    );

    const response = await app.request("/admin/fleet/host-update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Omnesis-CSRF": CSRF },
      body: JSON.stringify({ planId: "b".repeat(64) }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("release plan changed"),
    });
  });

  test("reports an unsupported gateway topology without launching an update", async () => {
    const { app, service } = appFor(portalAuth());
    service.start.mockRejectedValueOnce(
      new ServiceUnavailableError("This gateway is not managed by a supported user service."),
    );

    const response = await app.request("/admin/fleet/host-update", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Omnesis-CSRF": CSRF },
      body: JSON.stringify({ planId: "b".repeat(64) }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("not managed by a supported user service"),
    });
  });
});

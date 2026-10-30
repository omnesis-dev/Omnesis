// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { HttpError } from "../errors.js";
import { WatchRoutingService } from "../../dictation/watch-routing.js";
import { mountWatchCaptureRoutes } from "./watch-capture.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./types.js";

// The route uses the production scope middleware against a synthetic auth context.
function fixture(admin = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: null,
      tokenId: null,
      scopes: admin ? [SCOPE_ADMIN] : [SCOPE_READ],
    });
    await next();
  });
  app.onError((error, c) =>
    c.json(
      { message: error.message },
      error instanceof HttpError ? (error.status as ContentfulStatusCode) : 500,
    ),
  );
  const service = new WatchRoutingService({ getConfig: () => undefined, getDecision: () => null });
  const route = vi.spyOn(service, "route");
  mountWatchCaptureRoutes(app, service);
  return { app, route };
}

describe("Watch capture route boundary", () => {
  it("rejects non-admin clients before invoking the model", async () => {
    const { app, route } = fixture(false);
    const response = await app.request("/watch/capture/route", {
      method: "POST",
      body: '{"text":"hello"}',
    });
    expect(response.status).toBe(403);
    expect(route).not.toHaveBeenCalled();
  });
  it("sanitizes malformed JSON and rejects empty or oversized text", async () => {
    const { app, route } = fixture();
    for (const body of [
      '{"private words"',
      '{"text":" "}',
      JSON.stringify({ text: "x".repeat(16_001) }),
    ]) {
      const response = await app.request("/watch/capture/route", { method: "POST", body });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("private words");
    }
    expect(route).not.toHaveBeenCalled();
  });
  it("routes a validated utterance", async () => {
    const { app, route } = fixture();
    const response = await app.request("/watch/capture/route", {
      method: "POST",
      body: '{"text":"  Where is the bicycle?  "}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ route: "ask" });
    expect(route.mock.calls[0]?.[0]).toBe("Where is the bicycle?");
  });
});

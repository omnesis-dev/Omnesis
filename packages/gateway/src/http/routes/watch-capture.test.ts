// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { HttpError } from "../errors.js";
import { CaptureRoutingService } from "../../dictation/capture-routing.js";
import { mountCaptureRoutes, mountWatchCaptureRoutes } from "./watch-capture.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./types.js";

// The route uses the production scope middleware against a synthetic auth context.
function fixture(
  admin = true,
  availability: "active" | "disabled" | "missing" | "failed" = "active",
) {
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
      error instanceof HttpError || error instanceof HTTPException
        ? (error.status as ContentfulStatusCode)
        : 500,
    ),
  );
  const service = new CaptureRoutingService({
    getConfig: () => undefined,
    enabled: () => availability !== "disabled",
    getDecision: () =>
      availability === "missing"
        ? null
        : {
            modelId: "test",
            decide: () =>
              availability === "failed"
                ? Promise.reject(new Error("private backend diagnostics"))
                : Promise.resolve({
                    model: "test",
                    answers: { route: { type: "choice" as const, choice: "ask" } },
                  }),
            dispose() {},
          },
  });
  const route = vi.spyOn(service, "route");
  mountWatchCaptureRoutes(app, service);
  mountCaptureRoutes(app, service);
  return { app, route };
}

describe.each(["/watch/capture/route", "/capture/route"])("%s boundary", (path) => {
  it("rejects non-admin clients before invoking the model", async () => {
    const { app, route } = fixture(false);
    const response = await app.request(path, {
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
      const response = await app.request(path, { method: "POST", body });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("private words");
    }
    expect(route).not.toHaveBeenCalled();
  });
  it("rejects unknown fields and excessive request bodies before classification", async () => {
    const { app, route } = fixture();
    for (const [body, status] of [
      [JSON.stringify({ text: "Where is the plant guide?", route: "note" }), 400],
      [JSON.stringify({ text: "x".repeat(128 * 1024) }), 413],
    ] as const) {
      const response = await app.request(path, { method: "POST", body });
      expect(response.status).toBe(status);
    }
    expect(route).not.toHaveBeenCalled();
  });
  it("routes a validated utterance", async () => {
    const { app, route } = fixture();
    const response = await app.request(path, {
      method: "POST",
      body: '{"text":"  Where is the bicycle?  "}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ route: "ask" });
    expect(route.mock.calls[0]?.[0]).toBe("Where is the bicycle?");
  });
});

describe("phone capture manual fallback", () => {
  it.each(["disabled", "missing", "failed"] as const)(
    "returns 503 when routing is %s without exposing backend details",
    async (availability) => {
      const { app } = fixture(true, availability);
      const response = await app.request("/capture/route", {
        method: "POST",
        body: JSON.stringify({ text: "Remember to water the plants" }),
      });
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain("Choose an action manually");
      expect(body).not.toContain("private backend diagnostics");
    },
  );
});

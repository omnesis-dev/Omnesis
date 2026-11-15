// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { PortalSignals } from "../../portal-signals/hub.js";
import { errorResponse, HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountPortalSignalRoutes } from "./portal-signals.js";
import type { DeviceId, TokenId } from "@omnesis/types";
import type { AppEnv } from "./types.js";

function app(signals: PortalSignals, scopes = [SCOPE_ADMIN], heartbeatMs?: number) {
  const router = strictRoute(new Hono<AppEnv>());
  router.onError((e, c) => {
    if (e instanceof HttpError) return errorResponse(c, e);
    throw e;
  });
  router.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: "dev_fictional_portal" as DeviceId,
      tokenId: "tok_fictional" as TokenId,
      scopes,
    });
    await next();
  });
  mountPortalSignalRoutes(router, signals, heartbeatMs ? { heartbeatMs } : {});
  return router;
}

/** Reads frames until `count` have arrived. */
async function frames(body: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n\n").length - 1 < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  return text.split("\n\n").filter(Boolean);
}

describe("GET /portal/api/signals", () => {
  test("opens with ready, then names each topic that changed and nothing else", async () => {
    const signals = new PortalSignals();
    const controller = new AbortController();
    const res = await app(signals).request("/portal/api/signals", { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    const read = frames(res.body!, 3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    signals.publish("devices");
    signals.publish("answers");
    expect(await read).toEqual([
      "event: ready\ndata: {}",
      'event: changed\ndata: {"topic":"devices"}',
      'event: changed\ndata: {"topic":"answers"}',
    ]);
    controller.abort();
  });

  test("a closed stream stops listening", async () => {
    const signals = new PortalSignals({ maxListeners: 1 });
    const controller = new AbortController();
    const res = await app(signals).request("/portal/api/signals", { signal: controller.signal });
    await frames(res.body!, 1);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signals.hasRoom()).toBe(true);
  });

  test("keeps a quiet stream alive with comments", async () => {
    const signals = new PortalSignals();
    const controller = new AbortController();
    const res = await app(signals, [SCOPE_ADMIN], 10).request("/portal/api/signals", {
      signal: controller.signal,
    });
    expect((await frames(res.body!, 2))[1]).toBe(": hb");
    controller.abort();
  });

  test("a full gateway says so and asks to retry later", async () => {
    const signals = new PortalSignals({ maxListeners: 1 });
    signals.subscribe(() => {});
    const res = await app(signals).request("/portal/api/signals");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toMatchObject({ code: "too-many-streams" });
  });

  test("needs the admin scope, as every list it points at does", async () => {
    const res = await app(new PortalSignals(), [SCOPE_READ]).request("/portal/api/signals");
    expect(res.status).toBe(403);
  });
});

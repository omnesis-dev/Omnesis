// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_ADMIN } from "@omnesis/types";
import { errorResponse, HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountStepUp } from "../step-up.js";
import { mountTailscaleRoutes } from "./tailscale.js";
import type { GatewayEnrollment } from "@omnesis/cloud-relay";
import type { DeviceId, TokenId } from "@omnesis/types";
import type { TailscaleEmbedService } from "../../tailscale-embed/service.js";
import type { AppEnv } from "./types.js";

const RELAYED = { "x-omnesis-cloud-relay": "1" };

/** The owner's controls over a stand-in service, behind a gateway that requires step-up. */
function app() {
  const calls: string[] = [];
  const service = {
    state: () => ({ enabled: true }),
    setEnabled: (enabled: boolean) => (calls.push(`enable:${enabled}`), Promise.resolve({})),
    signIn: () => (calls.push("sign-in"), {}),
    signOut: () => (calls.push("sign-out"), {}),
    updateSettings: (patch: object) => (
      calls.push(`settings:${JSON.stringify(patch)}`),
      Promise.resolve({})
    ),
    joinPolicy: () => "ask",
    joins: {
      list: () => [],
      decide: (id: string, approve: boolean) => (calls.push(`decide:${id}:${approve}`), true),
    },
  } as unknown as TailscaleEmbedService;
  const router = strictRoute(new Hono<AppEnv>());
  router.onError((e, c) => {
    if (e instanceof HttpError) return errorResponse(c, e);
    if (e instanceof HTTPException) return e.getResponse();
    throw e;
  });
  router.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: "dev_fictional_phone" as DeviceId,
      tokenId: "tok_fictional" as TokenId,
      scopes: [SCOPE_ADMIN],
    });
    await next();
  });
  mountStepUp(router, {
    enrollment: () =>
      ({
        stepUpRequired: () => true,
        gatewayPasskey: () => ({ rpId: "relay.example.test", origin: "https://g.example.test" }),
      }) as unknown as GatewayEnrollment,
    enrollmentMethod: () => undefined,
  });
  mountTailscaleRoutes(router, service);
  const send = (method: string, path: string, body?: unknown) =>
    router.request(path, {
      method,
      headers: { ...RELAYED, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { send, calls };
}

beforeEach(() => {});
afterEach(() => vi.unstubAllEnvs());

describe("step-up on the owner's Tailscale controls", () => {
  test("anything that opens the gateway needs one, and does nothing without it", async () => {
    const { send, calls } = app();
    for (const [method, path, body] of [
      ["POST", "/admin/tailscale/enable", { enabled: true }],
      ["POST", "/admin/tailscale/sign-in", undefined],
      ["PATCH", "/admin/tailscale/settings", { publicAccess: true }],
      ["PATCH", "/admin/tailscale/settings", { joinPolicy: "automatic" }],
      ["PATCH", "/admin/tailscale/settings", { joinPolicy: "ask", publicAccess: true }],
      ["POST", "/admin/tailscale/join-requests/r1/decision", { approve: true }],
    ] as const) {
      const res = await send(method, path, body);
      expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(428);
      expect(await res.json()).toMatchObject({ code: "STEP_UP_REQUIRED" });
    }
    expect(calls).toEqual([]);
  });

  test("closing, asking first, switching joining off, renaming and denying never do", async () => {
    const { send, calls } = app();
    for (const [method, path, body] of [
      ["POST", "/admin/tailscale/enable", { enabled: false }],
      ["POST", "/admin/tailscale/sign-out", undefined],
      ["PATCH", "/admin/tailscale/settings", { publicAccess: false }],
      ["PATCH", "/admin/tailscale/settings", { joinPolicy: "ask" }],
      ["PATCH", "/admin/tailscale/settings", { joinPolicy: "off" }],
      ["PATCH", "/admin/tailscale/settings", { deviceName: "omnesis-home" }],
      ["POST", "/admin/tailscale/join-requests/r1/decision", { approve: false }],
      ["GET", "/admin/tailscale", undefined],
    ] as const) {
      const res = await send(method, path, body);
      expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(200);
    }
    expect(calls).toEqual([
      "enable:false",
      "sign-out",
      'settings:{"publicAccess":false}',
      'settings:{"joinPolicy":"ask"}',
      'settings:{"joinPolicy":"off"}',
      'settings:{"deviceName":"omnesis-home"}',
      "decide:r1:false",
    ]);
  });
});

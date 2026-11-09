// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { Hono } from "hono";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DeviceId } from "@omnesis/types";
import { devicePathObservation } from "./device-path-observation.js";
import type { AppEnv, AuthContext } from "./routes/types.js";
const id = DeviceId("00000000-0000-4000-8000-000000000001");
function app(auth: AuthContext | null, note?: Parameters<typeof devicePathObservation>[0]) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    await next();
  });
  app.use("*", devicePathObservation(note));
  app.get("/", (c) => c.json({ ok: true }));
  return app;
}
const bearer: AuthContext = { authMethod: "bearer", deviceId: id, tokenId: null, scopes: [] };
beforeEach(() => vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1"));
afterEach(() => vi.unstubAllEnvs());
test("without the cloud relay opt-in the header is ignored", async () => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "");
  const note = vi.fn();
  for (const path of ["local", "relay"]) {
    const response = await app(bearer, note).request("/", {
      headers: { "x-omnesis-connection-path": path },
    });
    expect(response.status).toBe(200);
  }
  expect(note).not.toHaveBeenCalled();
});
test("only authenticated device bearer telemetry is accepted, never forwarded identity claims", async () => {
  const note = vi.fn();
  for (const path of ["local", "relay"]) {
    const response = await app(bearer, note).request("/", {
      headers: { "x-omnesis-connection-path": path },
    });
    expect(response.status).toBe(200);
    expect(note).toHaveBeenLastCalledWith(id, path);
  }
  note.mockClear();
  for (const auth of [
    null,
    { ...bearer, deviceId: null },
    {
      authMethod: "portal-session",
      deviceId: null,
      tokenId: null,
      credentialDeviceId: id,
      scopes: [],
      csrfToken: "a",
    } as AuthContext,
  ])
    await app(auth, note).request("/", {
      headers: { "x-omnesis-connection-path": "local", "x-forwarded-for": "127.0.0.1" },
    });
  for (const value of [undefined, "local,relay", "reconnecting", "forged-path"]) {
    await app(bearer, note).request("/", {
      headers: value ? { "x-omnesis-connection-path": value } : {},
    });
  }
  expect(note).not.toHaveBeenCalled();
  expect(
    (await app(bearer).request("/", { headers: { "x-omnesis-connection-path": "local" } })).status,
  ).toBe(200);
});

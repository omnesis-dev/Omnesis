// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SCOPE_ADMIN, TokenId } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice, getDevice } from "../../data/repositories/DeviceRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { PushTransport } from "../../watch/push-transport.js";
import { errorResponse, HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { PushAdminService } from "../services/PushAdminService.js";
import { mountPushRoutes } from "./push.js";
import type { AppEnv } from "./types.js";

const databases: import("better-sqlite3").Database[] = [];

afterEach(() => databases.splice(0).forEach((db) => db.close()));

function appWithPhone(kind: "ios" | "android" = "ios", publish = vi.fn(() => Promise.resolve([]))) {
  const db = createDatabase(":memory:");
  databases.push(db);
  const phone = createDevice(db, { name: `${kind}-health-route`, kind });
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: phone.id,
      tokenId: TokenId("22222222-2222-4222-8222-222222222222"),
      scopes: [SCOPE_ADMIN],
    });
    await next();
  });
  mountPushRoutes(
    strictRoute(app),
    new PushAdminService({
      db,
      getSettings: () => undefined,
      pushTransport: new PushTransport({ publish }),
      writeGate: directWriteGate(db),
    }),
  );
  return { app, db, phone, publish };
}

describe("phone notification delivery-health route", () => {
  test("validates and stores a normalized report for the named phone", async () => {
    const { app, db, phone } = appWithPhone();
    const response = await app.request(`/admin/devices/${phone.id}/push-health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "scheduled-summary" }),
    });
    expect(response.status).toBe(200);
    expect(getDevice(db, phone.id)).toMatchObject({
      notificationDeliveryHealth: "scheduled-summary",
      notificationDeliveryHealthUpdatedAt: expect.any(Number),
    });
  });

  test("rejects unknown states and extra potentially sensitive fields", async () => {
    const { app, phone } = appWithPhone("android");
    for (const body of [
      { status: "unknown" },
      { status: "healthy", notificationTitle: "must not be stored" },
    ]) {
      const response = await app.request(`/admin/devices/${phone.id}/push-health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });

  test("binds a report to the authenticated phone rather than the path alone", async () => {
    const { app, db } = appWithPhone();
    const other = createDevice(db, { name: "other-health-route", kind: "ios" });
    const response = await app.request(`/admin/devices/${other.id}/push-health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "healthy" }),
    });
    expect(response.status).toBe(403);
    expect(getDevice(db, other.id)?.notificationDeliveryHealth).toBeNull();
  });

  test("rejects a valid admin token reporting health for another device", async () => {
    const { app, db } = appWithPhone();
    const other = createDevice(db, { name: "other-health-phone", kind: "ios" });
    const response = await app.request(`/admin/devices/${other.id}/push-health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "healthy" }),
    });
    expect(response.status).toBe(403);
    expect(getDevice(db, other.id)?.notificationDeliveryHealth).toBeNull();
  });
});

describe("push test route", () => {
  test("keeps the bodyless request as an all-phone broadcast", async () => {
    const { app, publish } = appWithPhone();
    const response = await app.request("/admin/push/test", { method: "POST" });
    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(expect.any(Object));
  });

  test("targets the requested phone id", async () => {
    const { app, phone, publish } = appWithPhone();
    const response = await app.request(`/admin/push/test?deviceId=${phone.id}`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(expect.any(Object), [phone.id]);
  });

  test("rejects malformed and unknown target ids", async () => {
    const { app } = appWithPhone();
    const malformed = await app.request("/admin/push/test?deviceId=not-an-id", {
      method: "POST",
    });
    expect(malformed.status).toBe(400);
    const unknown = await app.request(
      "/admin/push/test?deviceId=00000000-0000-4000-8000-000000000099",
      { method: "POST" },
    );
    expect(unknown.status).toBe(404);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, describe, expect, test } from "vitest";
import {
  AccountId,
  SCOPE_ADMIN,
  SourceType,
  TokenId,
  writeScope,
  type DeviceId,
} from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { addSourceMember, createSource } from "../../data/repositories/SourceRepository.js";
import { directWriteGate } from "../../write-gate.js";
import { errorResponse, HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { MobilePermissionHealthService } from "../services/MobilePermissionHealthService.js";
import { mountMobilePermissionHealthRoute } from "./mobile-permission-health.js";
import type { AppEnv } from "./types.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function fixture(
  identity: "owner" | "other" | "none",
  scopes: AppEnv["Variables"]["auth"]["scopes"],
  now = 1_000,
) {
  const db = createDatabase(":memory:");
  databases.push(db);
  const owner = createDevice(db, { name: "Fictional owner", kind: "ios" });
  const other = createDevice(db, { name: "Fictional other", kind: "android" });
  const source = createSource(db, {
    type: SourceType("fictional-mobile"),
    accountId: AccountId("local"),
    deviceId: owner.id,
  });
  const deviceId: DeviceId | null =
    identity === "owner" ? owner.id : identity === "other" ? other.id : null;
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof HttpError) return errorResponse(c, error);
    if (error instanceof HTTPException) {
      return c.json({ error: error.message }, error.status as ContentfulStatusCode);
    }
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId,
      tokenId: TokenId("22222222-2222-4222-8222-222222222222"),
      scopes,
    });
    await next();
  });
  mountMobilePermissionHealthRoute(
    strictRoute(app),
    new MobilePermissionHealthService({ writeGate: directWriteGate(db), now: () => now }),
  );
  return { app, db, owner, other, source };
}

const body = JSON.stringify({ checkedAt: 1_000, validForMs: 60_000, capabilities: [] });

describe("mobile permission-health route authorization", () => {
  test("fails closed for an admin token without a paired device", async () => {
    const { app, source } = fixture("none", [SCOPE_ADMIN]);
    const response = await app.request(`/admin/sources/${source.id}/permission-health`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(403);
  });

  test("rejects a different phone even when its write scope matches", async () => {
    const { app, source } = fixture("other", [writeScope(SourceType("fictional-mobile"))]);
    const response = await app.request(`/admin/sources/${source.id}/permission-health`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(403);
  });

  test("accepts every phone that is a member of a multi-device source", async () => {
    const { app, db, source, other } = fixture("other", [
      writeScope(SourceType("fictional-mobile")),
    ]);
    expect(addSourceMember(db, source.id, other.id)).toBe(true);
    const response = await app.request(`/admin/sources/${source.id}/permission-health`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
  });

  test("accepts the owning phone with the matching source write scope", async () => {
    const { app, source } = fixture("owner", [writeScope(SourceType("fictional-mobile"))]);
    const response = await app.request(`/admin/sources/${source.id}/permission-health`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
  });

  test("rejects an owning phone's expired snapshot at the HTTP boundary", async () => {
    const { app, source } = fixture("owner", [writeScope(SourceType("fictional-mobile"))], 100_000);
    const response = await app.request(`/admin/sources/${source.id}/permission-health`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkedAt: 1, validForMs: 60_000, capabilities: [] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/expired/),
    });
  });

  test("preserves the malformed JSON response while the observer reads the request body", async () => {
    const { app, source } = fixture("owner", [writeScope(SourceType("fictional-mobile"))]);
    const response = await app.request(`/admin/sources/${source.id}/permission-health`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '{"checkedAt":1000',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Malformed JSON in request body",
    });
  });

  test("rejects an oversized declared body before malformed-body observation", async () => {
    const { app, source } = fixture("owner", [writeScope(SourceType("fictional-mobile"))]);
    const response = await app.request(`/admin/sources/${source.id}/permission-health`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: `{"value":"${"x".repeat(65 * 1024)}"}`,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  test("rejects an oversized streamed body with no content length", async () => {
    const { app, source } = fixture("owner", [writeScope(SourceType("fictional-mobile"))]);
    const bytes = new TextEncoder().encode(`{"value":"${"x".repeat(65 * 1024)}"}`);
    const request = new Request(`http://localhost/admin/sources/${source.id}/permission-health`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await app.request(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });
});

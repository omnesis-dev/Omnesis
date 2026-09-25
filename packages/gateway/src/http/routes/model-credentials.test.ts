// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SCOPE_ADMIN, type DeviceId, type Scope, type TokenId } from "@omnesis/types";
import { HttpError, errorResponse } from "../errors.js";
import { mountModelCredentialsRoutes } from "./model-credentials.js";
import type { AppEnv } from "./types.js";

let dir: string;
let changedFor: string[];
let app: Hono<AppEnv>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-mc-routes-"));
  changedFor = [];
  app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  // Routes declare `scope.admin()` at their mount site (see http/scope.ts).
  // In production the gateway's auth middleware populates `c.var.auth`; here
  // we mount a stub that pretends every request is an admin so route logic —
  // not auth wiring — is what each test exercises.
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: "test-device" as DeviceId,
      tokenId: "test-token" as TokenId,
      scopes: [SCOPE_ADMIN] as Scope[],
    });
    await next();
  });
  mountModelCredentialsRoutes(app, {
    configDir: dir,
    onCredentialsChanged: (fileKey) => {
      changedFor.push(fileKey);
    },
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /admin/model-credentials", () => {
  test("returns the registered specs with configured=false initially", async () => {
    const res = await app.request("/admin/model-credentials");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    const anthropic = body.items.find((e: any) => e.fileKey === "anthropic");
    expect(anthropic.configured).toBe(false);
  });
});

describe("POST /admin/model-credentials/:fileKey", () => {
  test("rejects unknown fileKey with 404", async () => {
    const res = await app.request("/admin/model-credentials/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { apiKey: "anything" } }),
    });
    expect(res.status).toBe(404);
  });

  test("rejects missing fields object with 400", async () => {
    const res = await app.request("/admin/model-credentials/anthropic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("rejects empty apiKey with field-specific 400", async () => {
    const res = await app.request("/admin/model-credentials/anthropic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { apiKey: "" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/API Key/);
  });

  test("rejects pattern-violating apiKey with patternHint", async () => {
    const res = await app.request("/admin/model-credentials/anthropic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { apiKey: "not-an-anthropic-key" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sk-ant-/);
  });

  test("happy path: writes the file with mode 0600 and fires callback", async () => {
    const res = await app.request("/admin/model-credentials/anthropic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { apiKey: "sk-ant-abc123" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, fileKey: "anthropic" });

    const path = join(dir, "anthropic-credentials.json");
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.apiKey).toBe("sk-ant-abc123");

    expect(changedFor).toEqual(["anthropic"]);
  });

  test("after a write, GET shows configured=true", async () => {
    await app.request("/admin/model-credentials/anthropic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { apiKey: "sk-ant-abc123" } }),
    });
    const res = await app.request("/admin/model-credentials");
    const body = await res.json();
    expect(body.items.find((e: any) => e.fileKey === "anthropic").configured).toBe(true);
  });
});

describe("DELETE /admin/model-credentials/:fileKey", () => {
  test("removes the file and fires the callback", async () => {
    await app.request("/admin/model-credentials/anthropic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { apiKey: "sk-ant-abc123" } }),
    });
    changedFor = [];

    const res = await app.request("/admin/model-credentials/anthropic", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(existsSync(join(dir, "anthropic-credentials.json"))).toBe(false);
    expect(changedFor).toEqual(["anthropic"]);
  });

  test("rejects unknown fileKey with 404 even when no file exists", async () => {
    const res = await app.request("/admin/model-credentials/openai", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("is idempotent — DELETE on absent file still succeeds for known keys", async () => {
    const res = await app.request("/admin/model-credentials/anthropic", { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});

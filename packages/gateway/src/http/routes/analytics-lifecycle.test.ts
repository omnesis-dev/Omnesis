// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCOPE_ADMIN } from "@omnesis/types";
import { Hono } from "hono";
import { afterEach, expect, test, vi } from "vitest";
import { errorResponse, HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountAnalyticsRoutes, type AnalyticsRoutesDeps } from "./analytics.js";
import type { AppEnv } from "./types.js";

const roots: string[] = [];
const databases: Database.Database[] = [];
const mounts: ReturnType<typeof mountAnalyticsRoutes>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(mounts.splice(0).map((mount) => mount.close()));
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(readonly = false) {
  const root = mkdtempSync(join(tmpdir(), "analytics-lifecycle-"));
  roots.push(root);
  const path = join(root, "fixture.db");
  let db = new Database(path);
  db.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES ('invented row')");
  if (readonly) {
    db.close();
    db = new Database(path, { readonly: true });
  }
  databases.push(db);
  const app = strictRoute(new Hono<AppEnv>());
  app.use("*", async (c, next) => {
    c.set("auth", { authMethod: "bearer", scopes: [SCOPE_ADMIN], tokenId: null, deviceId: null });
    await next();
  });
  app.onError((error, c) =>
    error instanceof HttpError ? errorResponse(c, error) : c.json({ error: error.message }, 500),
  );
  const mount = mountAnalyticsRoutes(app, {
    db,
    analyticsService: null,
    sourceService: {} as AnalyticsRoutesDeps["sourceService"],
  });
  mounts.push(mount);
  const query = () =>
    app.request("/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "SELECT value FROM retained" }),
    });
  return { db, mount, query };
}

test("route disposal closes its actual SQLite fallback and keeps the caller database alive", async () => {
  const { db, mount, query } = fixture();
  const fallbacks: Database.Database[] = [];
  const exec = Database.prototype.exec;
  vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql) {
    if (this !== db && !fallbacks.includes(this)) fallbacks.push(this);
    return exec.call(this, sql);
  });
  expect((await query()).status).toBe(200);
  expect(fallbacks).toHaveLength(1);
  expect(fallbacks[0].open).toBe(true);
  await mount.close();
  await mount.close();
  expect(fallbacks[0].open).toBe(false);
  expect(db.prepare("SELECT value FROM retained").get()).toEqual({ value: "invented row" });
  expect((await query()).status).toBe(503);
  expect(fallbacks).toHaveLength(1);
});

test("route disposal never closes a caller-owned readonly connection", async () => {
  const { db, mount, query } = fixture(true);
  expect((await query()).status).toBe(200);
  await mount.close();
  expect(db.open).toBe(true);
  expect(db.prepare("SELECT value FROM retained").get()).toEqual({ value: "invented row" });
});

test("failed fallback configuration closes its handle and permits a clean retry", async () => {
  const { db, query } = fixture();
  const failed: Database.Database[] = [];
  const exec = Database.prototype.exec;
  const blocked = vi.spyOn(Database.prototype, "exec").mockImplementation(function (
    this: Database.Database,
    sql,
  ) {
    if (this !== db && sql.includes("mmap_size")) {
      failed.push(this);
      throw new Error("invented initialization failure");
    }
    return exec.call(this, sql);
  });
  expect((await query()).status).toBe(500);
  expect(failed).toHaveLength(1);
  expect(failed[0].open).toBe(false);
  expect(db.open).toBe(true);
  blocked.mockRestore();
  expect((await query()).status).toBe(200);
});

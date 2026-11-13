// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { mountLabRoutes } from "../http/routes/lab.js";
import { HttpError, errorResponse } from "../http/errors.js";
import { MIGRATIONS } from "../data/migrations.js";
import { createLabTable, initializeLabFlags, labFlags, labOptIns, setLabFlag } from "./store.js";
import { LabService } from "./service.js";
import type { AppEnv } from "../http/routes/types.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  createLabTable(db);
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  vi.stubEnv("OMNESIS_SYNTHETIC", "0");
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

describe("Omnesis Lab opt-ins", () => {
  test("experimental mode alone enables no feature", () => {
    expect(labFlags(db)).toEqual({ brain: false, tasks: false, watches: false });
  });
  test("feature choices persist independently; restart initialization preserves explicit opt-outs", () => {
    initializeLabFlags(db, { brain: true, tasks: true, watches: true });
    setLabFlag(db, "tasks", false);
    initializeLabFlags(db, { brain: false, tasks: true, watches: false });
    expect(labFlags(db)).toEqual({ brain: true, tasks: false, watches: true });
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    vi.stubEnv("OMNESIS_SYNTHETIC", "1");
    expect(labFlags(db)).toEqual({ brain: false, tasks: false, watches: false });
    expect(labOptIns(db)).toEqual({ brain: true, tasks: false, watches: true });
  });
  test.each([false, true])("upgrade recognizes task history: %s", (history) => {
    db.exec("CREATE TABLE open_loops (id TEXT); CREATE TABLE open_loop_ledger (id TEXT)");
    if (history) db.exec("INSERT INTO open_loop_ledger VALUES ('deleted-task-history')");
    MIGRATIONS.find((m) => m.version === 215)!.up(db);
    expect(labOptIns(db).tasks).toBe(history);
    setLabFlag(db, "tasks", false);
    MIGRATIONS.find((m) => m.version === 215)!.up(db);
    expect(labOptIns(db).tasks).toBe(false);
  });
  test("service updates exactly one flag and returns shared descriptions and artwork", async () => {
    const service = new LabService(db, {
      setLabFlag: async (id, enabled) => setLabFlag(db, id, enabled),
    });
    const state = await service.set("tasks", true);
    expect(state.features.map((f) => [f.id, f.enabled])).toEqual([
      ["brain", false],
      ["tasks", true],
      ["watches", false],
    ]);
    for (const feature of state.features) {
      expect(feature.description.length).toBeGreaterThan(30);
      expect(feature.iconSvg).toContain("<svg");
    }
  });
});

function appFor(admin = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: null,
      tokenId: null,
      scopes: [admin ? SCOPE_ADMIN : SCOPE_READ],
    });
    await next();
  });
  app.onError((error, c) =>
    error instanceof HttpError ? errorResponse(c, error) : c.json({ error: error.message }, 500),
  );
  mountLabRoutes(
    app,
    new LabService(db, { setLabFlag: async (id, enabled) => setLabFlag(db, id, enabled) }),
  );
  return app;
}

describe("Lab HTTP boundary", () => {
  test("only administrators can read or change experiments", async () => {
    expect((await appFor(false).request("/admin/lab")).status).toBe(403);
    expect(
      (
        await appFor(false).request("/admin/lab/tasks", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: '{"enabled":true}',
        })
      ).status,
    ).toBe(403);
    expect(labOptIns(db).tasks).toBe(false);
  });
  test("strict validation rejects malformed writes and unknown features", async () => {
    const app = appFor();
    for (const body of [{ enabled: "yes" }, { enabled: true, extra: 1 }, {}])
      expect(
        (
          await app.request("/admin/lab/tasks", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await app.request("/admin/lab/unknown", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: '{"enabled":true}',
        })
      ).status,
    ).toBe(404);
    const response = await app.request("/admin/lab/tasks", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '{"enabled":true}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(labFlags(db)).toEqual({ brain: false, tasks: true, watches: false });
  });
  test("experimental env gates the complete surface, including previously saved choices", async () => {
    setLabFlag(db, "tasks", true);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    for (const method of ["GET", "PUT"])
      expect(
        (await appFor().request(method === "GET" ? "/admin/lab" : "/admin/lab/tasks", { method }))
          .status,
      ).toBe(404);
  });
});

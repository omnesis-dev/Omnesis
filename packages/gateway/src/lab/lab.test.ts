// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { mountLabRoutes } from "../http/routes/lab.js";
import { HttpError, errorResponse } from "../http/errors.js";
import { MIGRATIONS } from "../data/migrations.js";
import {
  addRecordingsLabFeature,
  createLabTable,
  initializeLabFlags,
  labFlags,
  labOptIns,
  setLabFlag,
} from "./store.js";
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
    expect(labFlags(db)).toEqual({ brain: false, tasks: false, watches: false, recordings: false });
  });
  test("feature choices persist independently; restart initialization preserves explicit opt-outs", () => {
    initializeLabFlags(db, { brain: true, tasks: true, watches: true, recordings: true });
    setLabFlag(db, "tasks", false);
    setLabFlag(db, "recordings", false);
    initializeLabFlags(db, { brain: false, tasks: true, watches: false, recordings: true });
    expect(labFlags(db)).toEqual({ brain: true, tasks: false, watches: true, recordings: false });
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    vi.stubEnv("OMNESIS_SYNTHETIC", "1");
    expect(labFlags(db)).toEqual({ brain: false, tasks: false, watches: false, recordings: false });
    expect(labOptIns(db)).toEqual({ brain: true, tasks: false, watches: true, recordings: false });
  });
  test.each([false, true])(
    "upgrade admits Recordings, on where one was recorded: %s",
    (recorded) => {
      db.exec("DROP TABLE lab_features");
      db.exec(`CREATE TABLE lab_features (
      id TEXT PRIMARY KEY CHECK (id IN ('brain', 'tasks', 'watches')),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
    )`);
      db.exec("INSERT INTO lab_features VALUES ('tasks', 1), ('watches', 0)");
      db.exec("CREATE TABLE recording_sessions (id TEXT)");
      if (recorded) db.exec("INSERT INTO recording_sessions VALUES ('earlier-session')");
      const migration = MIGRATIONS.find((m) => m.version === 221)!;
      migration.up(db);
      migration.up(db);
      expect(labOptIns(db)).toEqual({
        brain: false,
        tasks: true,
        watches: false,
        recordings: recorded,
      });
      setLabFlag(db, "recordings", !recorded);
      expect(labOptIns(db).recordings).toBe(!recorded);
    },
  );
  test("an upgrade keeps an explicit Recordings opt-out", () => {
    db.exec("CREATE TABLE recording_sessions (id TEXT)");
    db.exec("INSERT INTO recording_sessions VALUES ('earlier-session')");
    setLabFlag(db, "recordings", false);
    addRecordingsLabFeature(db);
    expect(labOptIns(db).recordings).toBe(false);
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
      ["recordings", false],
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
    expect(labFlags(db)).toEqual({ brain: false, tasks: true, watches: false, recordings: false });
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

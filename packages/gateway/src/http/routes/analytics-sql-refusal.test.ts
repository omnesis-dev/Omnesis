// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a source is told when its SQL reaches outside its own tables.
 *
 * The gate carries the refused names per category, and this route is the only
 * place those become an HTTP answer. The unit tests either side of it prove
 * the gate refuses and prove the sentence reads well; this one proves the
 * route still hands both to the caller, which is the wiring that silently
 * regressed once already.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCOPE_READ } from "@omnesis/types";
import { Hono } from "hono";
import { afterAll, describe, expect, test } from "vitest";
import { ScopedSqlDeniedError } from "../../analytics/sandbox-tables.js";
import { errorResponse, HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountAnalyticsRoutes } from "./analytics.js";
import type { AnalyticsRoutesDeps } from "./analytics.js";
import type { AnalyticsService } from "../services/AnalyticsService.js";
import type { AppEnv } from "./types.js";

// The mount opens its own read-only handle onto the same file, so the block
// needs a database that exists on disk even though no route here reads it.
const dir = mkdtempSync(join(tmpdir(), "omnesis-analytics-refusal-"));
const db = new Database(join(dir, "omnesis.db"));
db.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)");

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The gateway's own envelope, so the body under test is the real one. */
function appRefusing(error: unknown): Hono<AppEnv> {
  const app = strictRoute(new Hono<AppEnv>());
  app.use("*", async (c, next) => {
    // Every route here declares `scope.read()`; the guard reads the parsed
    // token off the context, which the real auth middleware puts there.
    c.set("auth", {
      authMethod: "bearer",
      scopes: [SCOPE_READ],
      tokenId: null,
      deviceId: null,
    });
    await next();
  });
  mountAnalyticsRoutes(app, {
    db: db as unknown as AnalyticsRoutesDeps["db"],
    analyticsService: {
      sql: () => Promise.reject(error),
    } as unknown as AnalyticsService,
    sourceService: {} as AnalyticsRoutesDeps["sourceService"],
  });
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  return app;
}

async function refusal(error: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await appRefusing(error).request("/analytics/sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT 1", sourceId: "lunchflow:personal" }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /analytics/sql — a refused query", () => {
  test("names the refused table in the message and in the fields", async () => {
    const { status, body } = await refusal(
      new ScopedSqlDeniedError({
        tables: ["other_events"],
        tableFunctions: [],
        shows: [],
        macros: [],
      }),
    );
    expect(status).toBe(400);
    expect(String(body.error)).toContain("other_events");
    expect(body.detail).toMatchObject({ tables: ["other_events"] });
  });

  test("a refused table function is not reported as a table", async () => {
    // The categories stay apart: a flat list would claim a table was touched
    // when the only thing refused was a function the grant cannot call.
    const { body } = await refusal(
      new ScopedSqlDeniedError({
        tables: [],
        tableFunctions: ["generate_series"],
        shows: [],
        macros: [],
      }),
    );
    expect(String(body.error)).toContain("generate_series");
    expect(String(body.error)).not.toContain("tables outside this grant");
    expect(body.detail).toMatchObject({ tableFunctions: ["generate_series"] });
  });

  test("an ordinary query failure stays an ordinary message", async () => {
    const { status, body } = await refusal(new Error("no such column: total_spend"));
    expect(status).toBe(400);
    expect(body.error).toBe("no such column: total_spend");
    expect(body.detail).toBeUndefined();
  });
});

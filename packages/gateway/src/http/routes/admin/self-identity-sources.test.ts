// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The self-identity registry push is the self-detection pass's trigger, not
 * just its input — and the hooks travel with the trigger. The pass runs on the
 * writer worker, which never sees this thread's registry, so the route hands
 * it the merged list rather than expecting it to look one up.
 *
 * The gateway's boot pass runs before any collector has connected, so the
 * registry it reads is empty; the collector then POSTs the declared hooks on
 * its own boot AND on every mid-session source add. If the push doesn't
 * re-run the pass, a Strava/GitHub source added to a running gateway never
 * gets its self LID onto the self person, and every self-authored document it
 * syncs accrues under a duplicate person.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { SCOPE_ADMIN, type Scope } from "@omnesis/types";
type Db = Database.Database;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDatabase } from "../../../db.js";
import { detectSelfFromSourceIds } from "../../../domain/ContactCardBootstrap.js";
import {
  resetSelfIdentitySources,
  type SelfIdentitySource,
} from "../../../self-identity-sources.js";
import { getPersonById } from "../../../people.js";
import { mountSelfIdentitySourcesRoutes } from "./self-identity-sources.js";
import type Database from "better-sqlite3";
import type { AdminRoutesDeps } from "./internals.js";
import type { AppEnv } from "../types.js";

let tmpDir: string;
let db: Db;
let selfId: string;

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: null,
      tokenId: null,
      scopes: [SCOPE_ADMIN] as Scope[],
    });
    await next();
  });
  const deps = {
    // The real writer dispatches this op to the writer worker; here it runs
    // against the same handle, which is what the worker would do.
    writeGate: {
      detectSelfFromSourceIds: async (hooks: readonly SelfIdentitySource[]) =>
        detectSelfFromSourceIds(db, hooks),
    },
  } as unknown as AdminRoutesDeps;
  mountSelfIdentitySourcesRoutes(app, deps);
  return app;
}

function vouchersFor(alias: string): string[] {
  return db
    .prepare<[string], { source_id: string }>(
      `SELECT a.source_id FROM person_alias_assertions a
         JOIN person_aliases al ON al.id = a.alias_id
        WHERE al.alias = ? ORDER BY a.source_id`,
    )
    .all(alias)
    .map((r) => r.source_id);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-selfid-route-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
  selfId = "person-self";
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, 'Maya Reeves', 'contacts', TRUE, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(selfId);
  db.prepare(
    `INSERT INTO devices (id, name, kind, paired_at) VALUES ('dev_1', 'a-collector', 'collector', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
     VALUES ('strava-activities:43560449', 'strava-activities', '43560449', 'dev_1', '{}', 1, 0, 0)`,
  ).run();
});

afterEach(() => {
  resetSelfIdentitySources();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function selfHasLid(alias: string): boolean {
  return (getPersonById(db, selfId)?.aliases ?? []).some(
    (a) => a.aliasType === "lid" && a.alias === alias,
  );
}

describe("POST /admin/self-identity-sources", () => {
  test("re-runs the self-detection pass so the pushed hook is applied", async () => {
    expect(selfHasLid("strava-athlete:43560449")).toBe(false);

    const res = await buildApp().request("/admin/self-identity-sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          {
            sourceType: "strava-activities",
            aliasPrefix: "strava-athlete",
            accountPattern: "^\\d+$",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 1 });
    expect(selfHasLid("strava-athlete:43560449")).toBe(true);
    // And the source that supplied it is recorded as vouching for it. Without
    // that row the identifier is invisible to a removal's bookkeeping, so
    // removing any source that also asserts it takes the self's own alias.
    expect(vouchersFor("strava-athlete:43560449")).toEqual(["strava-activities:43560449"]);
  });

  test("a sibling collector's emptier push keeps the peer's hook and still pairs", async () => {
    const app = buildApp();
    const push = (entries: unknown[]) =>
      app.request("/admin/self-identity-sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries }),
      });
    await push([
      { sourceType: "strava-activities", aliasPrefix: "strava-athlete", accountPattern: "^\\d+$" },
    ]);

    // A second source appears, added through a collector whose code declares
    // no hooks. Its push is complete for itself and must not erase the peer's.
    db.prepare(
      `INSERT INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
       VALUES ('strava-activities:99', 'strava-activities', '99', 'dev_1', '{}', 1, 0, 0)`,
    ).run();
    const res = await push([]);
    expect(res.status).toBe(200);
    expect(selfHasLid("strava-athlete:43560449")).toBe(true);
    expect(selfHasLid("strava-athlete:99")).toBe(true);
  });

  test("a failing pass does not fail the push — the registry still lands", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        authMethod: "bearer",
        deviceId: null,
        tokenId: null,
        scopes: [SCOPE_ADMIN] as Scope[],
      });
      await next();
    });
    mountSelfIdentitySourcesRoutes(app, {
      writeGate: {
        detectSelfFromSourceIds: async () => {
          throw new Error("writer busy");
        },
      },
    } as unknown as AdminRoutesDeps);

    const res = await app.request("/admin/self-identity-sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [{ sourceType: "github", aliasPrefix: "github", accountPattern: "^([^@]+)" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 1 });
  });
});

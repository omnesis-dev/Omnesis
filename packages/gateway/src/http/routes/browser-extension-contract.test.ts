// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The browser extension's release contract (`extension/release-contract.json`)
 * names every gateway route the store build calls, whether each needs a token,
 * the device kind a pairing creates and the scopes its token carries. The
 * extension's own suite pins the file's content; this suite proves the file
 * against the live Hono app, so a route the gateway renames, re-guards or drops
 * reddens here rather than in a shipped extension.
 *
 * For every contract route: it is registered on the app under exactly the
 * contract's method and path pattern; a well-formed request from the browser's
 * own `write:web` token (or no token, for a public route) is served; an
 * authenticated route refuses a missing token with 401 while a public route
 * never does; and the recipe table below stays in lockstep with the contract.
 */

import { readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import webSource from "@omnesis/provider-web";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL, SourceType, writeScope } from "@omnesis/types";
import { AnalyticsDb } from "../../analytics-db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDatabase } from "../../db.js";
import { resetOwnedWebDomains } from "../../owned-web-domains.js";
import { createServer } from "../../server.js";
import type { Scope } from "@omnesis/types";
import type Database from "better-sqlite3";

type Db = Database.Database;

interface ContractRoute {
  method: string;
  path: string;
  authenticated: boolean;
}

interface ReleaseContract {
  deviceKind: string;
  tokenScopes: string[];
  gatewayRoutes: ContractRoute[];
}

const contract = JSON.parse(
  readFileSync(new URL("../../../../../extension/release-contract.json", import.meta.url), "utf8"),
) as ReleaseContract;

/** `"GET /health"` — the key both the contract and the recipe table are indexed by. */
type RouteKey = `${string} ${string}`;

function keyOf(route: ContractRoute): RouteKey {
  return `${route.method} ${route.path}`;
}

/**
 * A concrete request to a contract route, filled the way the extension fills
 * it. `build` may set up what the request needs (a pairing recipe mints its
 * code) and is called afresh for every send, so each send is well-formed on
 * its own. `expected` is the status the browser token — or no token, for a
 * public route — must receive.
 */
interface Recipe {
  build(): Promise<{ path: string; init: RequestInit }> | { path: string; init: RequestInit };
  expected: number;
}

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let analyticsPath: string;
let analyticsDb: AnalyticsDb;
let browserToken: string;
let adminToken: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(kind: "browser" | "cli", scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind });
  return createToken(db, dev.id, scopes).token;
}

function call(path: string, token: string | null, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

function json(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

/** A pairing code minted the way `omnesis devices pair --kind browser` mints one. */
async function mintBrowserPairingCode(): Promise<string> {
  const res = await call("/admin/devices/pair", adminToken, json("POST", { kind: "browser" }));
  expect(res.status, "POST /admin/devices/pair").toBe(200);
  const { pairingCode } = (await res.json()) as { pairingCode: string };
  return pairingCode;
}

/** The body the extension's `pair()` sends when redeeming a code. */
function pairingBody(pairingCode: string) {
  return {
    pairingCode,
    capabilities: {
      platform: "web",
      suggestedName: "invented browser profile",
      installId: `install-${randomUUID()}`,
    },
  };
}

const pageVisitsSchema = webSource.analyticsSchemas?.find((s) => s.tableName === "page_visits");

const recipes: Record<RouteKey, Recipe> = {
  "GET /health": {
    build: () => ({ path: "/health", init: { method: "GET" } }),
    expected: 200,
  },
  "POST /devices/pair": {
    build: async () => ({
      path: "/devices/pair",
      init: json("POST", pairingBody(await mintBrowserPairingCode())),
    }),
    expected: 200,
  },
  "GET /web-capture-policy": {
    build: () => ({ path: "/web-capture-policy", init: { method: "GET" } }),
    expected: 200,
  },
  "POST /web-capture-policy/excluded-domains": {
    build: () => ({
      path: "/web-capture-policy/excluded-domains",
      init: json("POST", { domain: "news.example.com", purge: false }),
    }),
    expected: 200,
  },
  "DELETE /web-capture-policy/excluded-domains/:domain": {
    build: () => ({
      path: "/web-capture-policy/excluded-domains/news.example.com",
      init: { method: "DELETE" },
    }),
    expected: 200,
  },
  "PUT /web-capture-policy/pause": {
    build: () => ({ path: "/web-capture-policy/pause", init: json("PUT", { until: null }) }),
    expected: 200,
  },
  "DELETE /web-capture-policy/pause": {
    build: () => ({ path: "/web-capture-policy/pause", init: { method: "DELETE" } }),
    expected: 200,
  },
  // An empty batch is the extension's own auth probe after pairing.
  "POST /documents": {
    build: () => ({ path: "/documents", init: json("POST", { documents: [] }) }),
    expected: 200,
  },
  // The visit push, with the schema the provider package publishes for the table.
  "POST /analytics/ingest": {
    build: () => ({
      path: "/analytics/ingest",
      init: json("POST", {
        tableName: "page_visits",
        sourceId: "web",
        records: [],
        schema: pageVisitsSchema,
      }),
    }),
    expected: 200,
  },
};

function recipeFor(route: ContractRoute): Recipe {
  const recipe = recipes[keyOf(route)];
  if (!recipe) throw new Error(`No request recipe for contract route ${keyOf(route)}`);
  return recipe;
}

beforeEach(async () => {
  dbPath = `/tmp/omnesis-extension-contract-${randomUUID()}.db`;
  analyticsPath = `/tmp/omnesis-extension-contract-${randomUUID()}.duckdb`;
  db = createDatabase(dbPath);
  analyticsDb = new AnalyticsDb(analyticsPath);
  await analyticsDb.open();
  app = createServer(db, undefined, { analyticsDb });
  resetOwnedWebDomains();
  browserToken = mintToken("browser", [writeScope(SourceType("web"))]);
  adminToken = mintToken("cli", [SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
});

afterEach(async () => {
  await analyticsDb.close();
  db.close();
  cleanupDb(dbPath);
  rmSync(analyticsPath, { force: true });
  rmSync(`${analyticsPath}.wal`, { force: true });
  resetOwnedWebDomains();
});

describe("the contract file", () => {
  test("names the browser device kind, its one scope, and at least the pairing route", () => {
    expect(contract.deviceKind).toBe("browser");
    expect(contract.tokenScopes).toEqual([writeScope(SourceType("web"))]);
    expect(contract.gatewayRoutes.length).toBeGreaterThan(0);
    expect(pageVisitsSchema, "the web provider publishes a page_visits schema").toBeDefined();
  });

  test("every contract route has a request recipe and every recipe is a contract route", () => {
    const contractKeys = contract.gatewayRoutes.map(keyOf).sort();
    expect(new Set(contractKeys).size, "contract routes are unique").toBe(contractKeys.length);
    expect(Object.keys(recipes).sort()).toEqual(contractKeys);
  });
});

describe("every contract route is mounted on the gateway app", () => {
  test.each(contract.gatewayRoutes)("$method $path", (route) => {
    // `strictRoute` wraps the registrars but hands the call on to Hono, so the
    // app's route table carries every mount under its method and pattern.
    const mounted = app.routes.some((r) => r.method === route.method && r.path === route.path);
    expect(mounted, `${keyOf(route)} is not registered on the gateway app`).toBe(true);
  });
});

describe("a well-formed request is served", () => {
  test.each(contract.gatewayRoutes)("$method $path", async (route) => {
    const recipe = recipeFor(route);
    const { path, init } = await recipe.build();
    const res = await call(path, route.authenticated ? browserToken : null, init);
    expect(res.status, `${keyOf(route)} answered ${res.status}: ${await res.text()}`).toBe(
      recipe.expected,
    );
  });
});

describe("the authenticated flag matches the route's guard", () => {
  const authenticated = contract.gatewayRoutes.filter((r) => r.authenticated);
  const open = contract.gatewayRoutes.filter((r) => !r.authenticated);

  test.each(authenticated)("$method $path refuses a missing token with 401", async (route) => {
    const { path, init } = await recipeFor(route).build();
    const res = await call(path, null, init);
    expect(res.status, keyOf(route)).toBe(401);
  });

  test.each(open)("$method $path serves a request with no token", async (route) => {
    const { path, init } = await recipeFor(route).build();
    const res = await call(path, null, init);
    expect([401, 403], `${keyOf(route)} answered ${res.status}`).not.toContain(res.status);
  });
});

describe("pairing", () => {
  test("a browser code redeems into the contract's device kind and token scopes", async () => {
    const res = await call(
      "/devices/pair",
      null,
      json("POST", pairingBody(await mintBrowserPairingCode())),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device: { id: string; name: string; kind: string };
      token: string;
      scopes: string[];
    };
    expect(body.device.kind).toBe(contract.deviceKind);
    expect(body.device.name).toBe("invented browser profile");
    expect(body.scopes).toEqual(contract.tokenScopes);

    // The token pairing hands out is the one the extension pushes with, so it
    // must open every authenticated contract route, not just the minted one.
    for (const route of contract.gatewayRoutes.filter((r) => r.authenticated)) {
      const recipe = recipeFor(route);
      const { path, init } = await recipe.build();
      const reply = await call(path, body.token, init);
      expect(reply.status, `${keyOf(route)} with the paired token`).toBe(recipe.expected);
    }
  });

  test("a read-only token is not enough for the browser's routes", async () => {
    const readOnly = mintToken("cli", [SCOPE_READ]);
    const res = await call("/web-capture-policy", readOnly, { method: "GET" });
    expect(res.status).toBe(403);
  });
});

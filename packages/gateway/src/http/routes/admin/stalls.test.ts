// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import { subscribeActivityNames } from "../../../observability/main-activity.js";
import type { StallReportPort, StallReportQuery } from "../../../observability/stall-monitor.js";
import type { StallReport } from "../../../observability/stall-report.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let dbPath: string;
let queries: StallReportQuery[];

const report: StallReport = {
  generatedAt: "2026-01-01T00:00:00.000Z",
  enabled: true,
  thresholdMs: 250,
  windowMinutes: 60,
  minMs: 0,
  summary: { count: 1, totalMs: 1_200, maxMs: 1_200 },
  ranking: [
    {
      culprit: "GET /search",
      count: 1,
      totalMs: 1_200,
      maxMs: 1_200,
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  recent: [],
  capturing: null,
  profiles: [],
};

const stalls: StallReportPort = {
  report: async (q) => {
    queries.push(q);
    return report;
  },
  totals: () => ({ summary: report.summary, ranking: report.ranking }),
  running: true,
};

beforeEach(() => {
  queries = [];
  dbPath = `/tmp/omnesis-stalls-route-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

function tokenWith(scope: typeof SCOPE_ADMIN): string {
  const device = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, device.id, [scope]).token;
}

describe("GET /admin/stalls", () => {
  test("serves the report for the parsed query, with defaults filled in", async () => {
    const app = createServer(db, dbPath, { stalls });
    const auth = { Authorization: `Bearer ${tokenWith(SCOPE_ADMIN)}` };

    const res = await app.request("/admin/stalls", { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(report);

    await app.request("/admin/stalls?windowMinutes=15&minMs=1000&limit=0", { headers: auth });
    expect(queries).toEqual([
      { windowMinutes: 60, minMs: 0, limit: 50 },
      { windowMinutes: 15, minMs: 1_000, limit: 0 },
    ]);
  });

  test("rejects a query outside its bounds before reaching the monitor", async () => {
    const app = createServer(db, dbPath, { stalls });
    const auth = { Authorization: `Bearer ${tokenWith(SCOPE_ADMIN)}` };
    for (const q of ["windowMinutes=0", "windowMinutes=99999", "limit=many", "minMs=-1"]) {
      const res = await app.request(`/admin/stalls?${q}`, { headers: auth });
      expect(res.status, q).toBe(400);
    }
    expect(queries).toEqual([]);
  });

  test("is for admin tokens only", async () => {
    const app = createServer(db, dbPath, { stalls });
    expect((await app.request("/admin/stalls")).status).toBe(401);
    const read = await app.request("/admin/stalls", {
      headers: { Authorization: `Bearer ${tokenWith(SCOPE_READ)}` },
    });
    expect(read.status).toBe(403);
    expect(queries).toEqual([]);
  });

  test("answers 503 in a composition without a stall monitor", async () => {
    const app = createServer(db, dbPath);
    const res = await app.request("/admin/stalls", {
      headers: { Authorization: `Bearer ${tokenWith(SCOPE_ADMIN)}` },
    });
    expect(res.status).toBe(503);
  });
});

describe("the activity a request runs under", () => {
  test("is its method and the pattern of the route that handles it, never its URL", async () => {
    const app = createServer(db, dbPath, { stalls });
    const auth = { Authorization: `Bearer ${tokenWith(SCOPE_ADMIN)}` };
    await app.request("/documents/doc-zq81x", { headers: auth });
    // Registered before the portal's `/portal/*` catch-all, which matches too.
    await app.request("/portal/api/session");
    await app.request("/no/such/route-zq81x", { headers: auth });

    const names = subscribeActivityNames(null).map(([, name]) => name);
    expect(names).toEqual(
      expect.arrayContaining(["GET /documents/:id", "GET /portal/api/session", "GET (unmatched)"]),
    );
    expect(names.filter((n) => n.includes("zq81x"))).toEqual([]);
  });
});

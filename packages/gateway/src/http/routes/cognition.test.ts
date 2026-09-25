// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for the /admin/cognition family — the per-mechanism
 * spend breakdown and the measurement-only calibration report. Unlike the
 * /admin/brain family both must answer even when the Briefs feature is
 * inactive (spend is passive accounting, calibration a pure read), so the
 * harness deliberately wires NO briefs status getter. All fixture data is
 * invented — never corpus-derived.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { recordCognitionSpend } from "../../brain/storage/spend.js";
import { createBrief, setBriefState } from "../../brain/storage/briefs.js";
import { createDocAnnotation } from "../../brain/storage/annotations.js";
import { recordConsumptionEdges } from "../../brain/storage/consumption-edges.js";
import type { FamilyCalibrationReport } from "../../brain/calibration.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let READ_TOKEN: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function get(path: string, token = ADMIN_TOKEN) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-cognition-http-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN]);
  READ_TOKEN = mintToken([SCOPE_READ]);
  // No getBriefsStatus wired: the briefs surfaces 404, this route must not.
  app = createServer(db, dbPath);
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("GET /admin/cognition/spend", () => {
  test("answers even with the Briefs feature inactive, newest day first", async () => {
    recordCognitionSpend(db, "2026-07-01", "datum-intake", "model-x", {
      promptTokens: 100,
      completionTokens: 10,
    });
    recordCognitionSpend(db, "2026-07-02", "collision-review", "model-y", {
      promptTokens: 50,
      completionTokens: 5,
      cacheReadTokens: 20,
    });

    // Sanity: the briefs-gated sibling is inert on this gateway…
    expect((await get("/admin/brain/spend")).status).toBe(404);
    // …while the cognition breakdown answers.
    const res = await get("/admin/cognition/spend");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [
        {
          day: "2026-07-02",
          mechanism: "collision-review",
          mechanismLabel: "Collision review",
          modelId: "model-y",
          runs: 1,
          promptTokens: 50,
          completionTokens: 5,
          cacheReadTokens: 20,
          cacheCreationTokens: 0,
        },
        {
          day: "2026-07-01",
          mechanism: "datum-intake",
          mechanismLabel: "Datum intake",
          modelId: "model-x",
          runs: 1,
          promptTokens: 100,
          completionTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    });
  });

  test("serves the wide-telemetry mechanisms data-driven — no allow-list anywhere", async () => {
    // The interactive/sub-agent/deep-research/token-identity lanes record under
    // labels that are not run kinds; the endpoint must serve them untouched.
    for (const mechanism of ["interactive", "subagent", "deep-research", "token-identity"]) {
      recordCognitionSpend(db, "2026-07-03", mechanism, "model-z", {
        promptTokens: 10,
        completionTokens: 1,
      });
    }
    const res = await get("/admin/cognition/spend");
    const { rows } = (await res.json()) as {
      rows: Array<{ mechanism: string; mechanismLabel: string }>;
    };
    expect(rows.map((r) => r.mechanism).sort()).toEqual([
      "deep-research",
      "interactive",
      "subagent",
      "token-identity",
    ]);
    // A mechanism the server has no name for is labelled as itself, so a cost
    // is never hidden just because this build cannot describe it.
    const labels = Object.fromEntries(rows.map((r) => [r.mechanism, r.mechanismLabel]));
    expect(labels["interactive"]).toBe("Interactive chat");
    expect(labels["token-identity"]).toBe("token-identity");
    expect(labels["deep-research"]).toBe("deep-research");
  });

  test("?days bounds distinct days", async () => {
    recordCognitionSpend(db, "2026-07-01", "data", "m", { promptTokens: 1, completionTokens: 1 });
    recordCognitionSpend(db, "2026-07-02", "data", "m", { promptTokens: 2, completionTokens: 2 });
    const res = await get("/admin/cognition/spend?days=1");
    const { rows } = (await res.json()) as { rows: Array<{ day: string }> };
    expect(rows.map((r) => r.day)).toEqual(["2026-07-02"]);
  });

  test("validates the days query param with limitParam-compatible semantics", async () => {
    // Junk and non-positive values reject; oversized values CLAMP and
    // fractional values FLOOR — the same forgiving behavior
    // /admin/brain/spend applies, so one CLI flag drives both endpoints.
    expect((await get("/admin/cognition/spend?days=0")).status).toBe(400);
    expect((await get("/admin/cognition/spend?days=ten")).status).toBe(400);
    expect((await get("/admin/cognition/spend?days=366")).status).toBe(200);
    expect((await get("/admin/cognition/spend?days=1.5")).status).toBe(200);
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    expect((await get("/admin/cognition/spend", READ_TOKEN)).status).toBe(403);
    const res = await app.request("/admin/cognition/spend");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/cognition/calibration", () => {
  interface CalibrationBody {
    generatedAt: number;
    sinceDays: number | null;
    families: FamilyCalibrationReport[];
  }

  test("answers ungated with all three families; labeled briefs show up binned", async () => {
    createBrief(
      db,
      {
        id: "b-1",
        createdByRun: "run-fixture",
        kind: "info",
        title: "Marathon entry form deadline approaching",
        confidence: 0.9,
        urgency: 0.5,
      },
      Date.now(),
    );
    setBriefState(db, "b-1", "dismissed_wrong", Date.now());

    const res = await get("/admin/cognition/calibration");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CalibrationBody;
    expect(body.sinceDays).toBeNull();
    expect(body.families.map((f) => f.family)).toEqual([
      "brief",
      "doc-annotation",
      "person-annotation",
    ]);
    const briefs = body.families[0]!;
    expect(briefs.labeled).toBe(1);
    expect(briefs.incorrect).toBe(1);
    expect(briefs.bins).toHaveLength(10);
    expect(briefs.bins[9]!.n).toBe(1);
    // Empty families report cleanly — no division by zero anywhere.
    expect(body.families[1]!.ece).toBeNull();
  });

  test("?family narrows to one family; ?sinceDays echoes into the report", async () => {
    const res = await get("/admin/cognition/calibration?family=doc-annotation&sinceDays=7");
    expect(res.status).toBe(200);
    const body = (await res.json()) as CalibrationBody;
    expect(body.families.map((f) => f.family)).toEqual(["doc-annotation"]);
    expect(body.sinceDays).toBe(7);
  });

  test("validates params: unknown family and non-positive sinceDays reject", async () => {
    expect((await get("/admin/cognition/calibration?family=weather")).status).toBe(400);
    expect((await get("/admin/cognition/calibration?sinceDays=0")).status).toBe(400);
    expect((await get("/admin/cognition/calibration?sinceDays=ten")).status).toBe(400);
    // Oversized clamps, fractional floors — the family's forgiving semantics.
    expect((await get("/admin/cognition/calibration?sinceDays=99999")).status).toBe(200);
    expect((await get("/admin/cognition/calibration?sinceDays=1.5")).status).toBe(200);
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    expect((await get("/admin/cognition/calibration", READ_TOKEN)).status).toBe(403);
    expect((await app.request("/admin/cognition/calibration")).status).toBe(401);
  });
});

describe("GET /admin/cognition/annotations/:store/:id/dependents", () => {
  function seedPriorWithDependents(): void {
    createDocAnnotation(
      db,
      {
        id: "anno_1",
        docId: "doc_subject",
        claimType: "topic",
        claimText: "about the practice schedule",
        evidenceDocId: "doc_ev",
        evidenceQuote: "practice moves to Tuesday evenings",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      1_000,
    );
    db.prepare(
      `INSERT INTO briefs (id, created_by_run, kind, title, confidence, urgency, created_at, updated_at)
       VALUES ('brief_1', 'run_seed', 'info', 'Practice day changed', 0.7, 0.4, 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO open_loops (id, created_by_run, state, confidence, importance, title, created_at, last_update)
       VALUES ('loop_1', 'run_seed', 'open', 0.7, 0.5, 'Confirm the new practice day', 1000, 1000)`,
    ).run();
    recordConsumptionEdges(
      db,
      [
        {
          priorStore: "doc",
          priorAnnotationId: "anno_1",
          dependentKind: "brief",
          dependentId: "brief_1",
          runId: "run_x",
        },
        {
          priorStore: "doc",
          priorAnnotationId: "anno_1",
          dependentKind: "loop",
          dependentId: "loop_1",
          runId: "run_x",
        },
        {
          priorStore: "doc",
          priorAnnotationId: "anno_1",
          dependentKind: "brief",
          dependentId: "brief_gone",
          runId: "run_x",
        },
      ],
      2_000,
    );
  }

  test("serves the LIVE dependents of a prior, title-enriched", async () => {
    seedPriorWithDependents();
    const res = await get("/admin/cognition/annotations/doc/anno_1/dependents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    // The dangling brief_gone edge is filtered; both live dependents surface.
    expect(body.items.map((i) => [i.kind, i.id, i.title])).toEqual([
      ["brief", "brief_1", "Practice day changed"],
      ["loop", "loop_1", "Confirm the new practice day"],
    ]);
    expect(body.items[0]).toMatchObject({
      runId: "run_x",
      createdAt: new Date(2000).toISOString(),
    });
  });

  test("keyset-pages dependents and binds the cursor to the prior", async () => {
    seedPriorWithDependents();
    createDocAnnotation(
      db,
      {
        id: "anno_2",
        docId: "doc_subject",
        claimType: "topic",
        claimText: "another synthetic prior",
        evidenceDocId: "doc_ev",
        evidenceQuote: "practice moves to Tuesday evenings",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_seed",
      },
      1_100,
    );
    const first = (await (
      await get("/admin/cognition/annotations/doc/anno_1/dependents?limit=1")
    ).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.items).toHaveLength(1);
    expect(first.pageInfo.hasMore).toBe(true);
    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);
    const second = (await (
      await get(`/admin/cognition/annotations/doc/anno_1/dependents?limit=1&cursor=${cursor}`)
    ).json()) as { items: Array<{ id: string }>; pageInfo: { hasMore: boolean } };
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set(["brief_1", "loop_1"]),
    );
    expect(second.pageInfo.hasMore).toBe(false);
    expect(
      (await get(`/admin/cognition/annotations/doc/anno_2/dependents?cursor=${cursor}`)).status,
    ).toBe(400);
  });

  test("404s an unknown annotation, 400s a junk store", async () => {
    expect((await get("/admin/cognition/annotations/doc/anno_nope/dependents")).status).toBe(404);
    expect((await get("/admin/cognition/annotations/junk/anno_1/dependents")).status).toBe(400);
  });

  test("requires admin scope", async () => {
    seedPriorWithDependents();
    expect(
      (await get("/admin/cognition/annotations/doc/anno_1/dependents", READ_TOKEN)).status,
    ).toBe(403);
  });
});

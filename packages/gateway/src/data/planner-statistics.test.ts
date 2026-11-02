// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Planner statistics: the writer analyzes what `PRAGMA optimize` would, one
 * index at a time, and the statistics it leaves are the ones SQLite's own
 * pragma would have left. The plan suites run the hot writer operations and
 * the read paths (keyset pages, person documents, people browse, merge
 * candidates, the SQLite side of search, the catalog's example queries) on an
 * invented corpus shaped like a large install, capture every statement they
 * prepare, and hold each one's plan after analysis to what it was before
 * (`planRegressions`): no statement may scan more, seek through fewer
 * constrained columns, sort more of its order, or split into a multi-index
 * OR because the planner now has statistics.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createDatabase, upsertWithCursor } from "../db.js";
import { setActiveAlgoVersion } from "../near-dupes/meta.js";
import { applyNearDupBatch, BUCKET_DELETE_FOR_DOC_SQL } from "../near-dupes/NearDupWriterOps.js";
import {
  advanceKnowledgeCascade,
  KNOWLEDGE_CASCADE_NEXT_JOB_SQL,
  KNOWLEDGE_CASCADE_NEXT_ROW_SQL,
} from "../brain/knowledge/storage-invalidation.js";
import { backfillManyPeople } from "../domain/PeopleResolutionService.js";
import {
  acceptCollapsedMergeCandidates,
  findCollapsedMergeCandidates,
  countMergeCandidates,
  listMergeCandidates,
} from "../merge-candidates.js";
import {
  PILOT_ALGO,
  pilotDocId,
  pilotEmail,
  pilotExternalId,
  pilotPersonId,
  seedPilotCorpus,
} from "../scheduler/__fixtures__/pilot-corpus.js";
import { resolvePersonDocIds } from "../search/person-filter.js";
import { likeSearchDocuments } from "../search/like-search.js";
import { getSqliteCatalog } from "../sqlite-catalog.js";
import { listAccessAuditEvents } from "../access/store-audit.js";
import { listLiveAnnotationsForDoc } from "../brain/storage/annotations.js";
import { listLiveDependentsForAnnotation } from "../brain/storage/consumption-edges.js";
import { listCognitionCoverage } from "../brain/storage/coverage.js";
import { listUnembeddedInterestSignals } from "../brain/storage/interest.js";
import { listMergeRules } from "../domain/merge/rule-crud.js";
import { listNoteEntriesHistory } from "../sources/omnesis-notes/storage.js";
import { getNearDupEdges } from "../near-dupes/NearDupGraphService.js";
import {
  getDocumentPeople,
  getDocumentsPeopleSummary,
  getPeopleStats,
  getPersonDocuments,
} from "./repositories/DocumentPeopleRepository.js";
import { getPersonById, searchPeople } from "./repositories/PersonRepository.js";
import { getRecentDocuments, listDocuments } from "./repositories/DocumentRepository.js";
import {
  analysisUnits,
  OPTIMIZE_PLAN_MASK,
  PLANNER_ANALYSIS_LIMIT,
  planPlannerStatistics,
  refreshPlannerStatistics,
} from "./planner-statistics.js";
import type { NearDupApplyBatch } from "../near-dupes/types.js";

type Db = Database.Database;

const CORPUS_DOCS = 8_000;
const LARGE_TABLES = [
  "documents",
  "document_people",
  "people",
  "person_aliases",
  "near_dup_lsh_buckets",
  "near_dup_signatures",
  "knowledge_cascade_jobs",
  "knowledge_cascade_frontier",
  "knowledge_source_revisions",
  "knowledge_changes",
];

const paths: string[] = [];

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
}

function seeded(docs = 2_000): { db: Db; path: string } {
  const path = `/tmp/omnesis-test-${randomUUID()}.db`;
  paths.push(path);
  const db = createDatabase(path) as unknown as Db;
  setActiveAlgoVersion(db as never, PILOT_ALGO);
  seedPilotCorpus(db, { docs, unresolvedDocs: 60, pendingCandidates: 120 });
  return { db, path };
}

/** Index statistics; an index-less table's row-count row is left out. */
function stat1(db: Db): string[] {
  return db
    .prepare<[], { tbl: string; idx: string | null; stat: string }>(
      "SELECT tbl, idx, stat FROM sqlite_stat1 WHERE idx IS NOT NULL ORDER BY tbl, idx",
    )
    .all()
    .map((r) => `${r.tbl}|${r.idx}|${r.stat}`);
}

function indexedTables(db: Db, tables: readonly string[]): string[] {
  return tables.filter(
    (t) =>
      db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM pragma_index_list(?)").get(t)!
        .n > 0,
  );
}

afterAll(() => {
  for (const path of paths) cleanupDb(path);
});

describe("refreshPlannerStatistics", () => {
  const open: Db[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
  });

  test("a never-analyzed database plans every indexed table, and none once analyzed", () => {
    const { db } = seeded();
    open.push(db);
    const planned = planPlannerStatistics(db);
    expect(planned).toEqual(expect.arrayContaining(LARGE_TABLES));
    const result = refreshPlannerStatistics(db, undefined);
    expect(result.remaining).toEqual([]);
    expect(result.analyzed).toEqual(planned.flatMap((t) => analysisUnits(db, t)));
    expect(indexedTables(db, planPlannerStatistics(db))).toEqual([]);
    expect(refreshPlannerStatistics(db, undefined).analyzed).toEqual(
      planPlannerStatistics(db).flatMap((t) => analysisUnits(db, t)),
    );
  });

  test("the invented corpus samples like a live install's scattered ids", () => {
    const { db } = seeded(6_000);
    open.push(db);
    refreshPlannerStatistics(db, undefined);
    const sampled = (idx: string) =>
      Number(
        db
          .prepare<[string], { stat: string }>("SELECT stat FROM sqlite_stat1 WHERE idx = ?")
          .get(idx)!
          .stat.split(" ")[1],
      );
    const exact = (sql: string) => db.prepare<[], { n: number }>(sql).get()!.n;
    const perPerson = exact(
      "SELECT COUNT(*) * 1.0 / COUNT(DISTINCT person_id) AS n FROM document_people",
    );
    expect(sampled("idx_document_people_person_source")).toBeLessThan(perPerson * 4);
    const perDoc = exact(
      "SELECT COUNT(*) * 1.0 / COUNT(DISTINCT document_id) AS n FROM document_people",
    );
    expect(sampled("idx_document_people_doc")).toBeLessThan(perDoc * 4);
  });

  test("index-at-a-time analysis leaves what SQLite's own PRAGMA optimize leaves", () => {
    const ours = seeded();
    const sqlites = seeded();
    open.push(ours.db, sqlites.db);
    refreshPlannerStatistics(ours.db, undefined);
    sqlites.db.pragma(`analysis_limit = ${PLANNER_ANALYSIS_LIMIT}`);
    sqlites.db.prepare(`PRAGMA optimize(${OPTIMIZE_PLAN_MASK & ~1})`).all();
    expect(stat1(ours.db)).toEqual(stat1(sqlites.db));
    expect(stat1(ours.db).length).toBeGreaterThan(50);
  });

  test("stops between units and resumes to the same statistics", () => {
    const sliced = seeded();
    const whole = seeded();
    open.push(sliced.db, whole.db);
    let units = 0;
    let progress = refreshPlannerStatistics(sliced.db, undefined, {
      shouldStop: () => ++units > 3,
    });
    expect(progress.analyzed.length).toBe(4);
    expect(progress.remaining.length).toBeGreaterThan(0);
    let calls = 1;
    while (progress.remaining.length > 0) {
      let budget = 0;
      progress = refreshPlannerStatistics(sliced.db, progress.remaining, {
        shouldStop: () => ++budget > 5,
      });
      calls += 1;
    }
    expect(calls).toBeGreaterThan(2);
    refreshPlannerStatistics(whole.db, undefined);
    expect(stat1(sliced.db)).toEqual(stat1(whole.db));
  });

  test("restores the connection's own analysis limit and skips a dropped unit", () => {
    const { db } = seeded(200);
    open.push(db);
    db.pragma("analysis_limit = 77");
    db.exec(
      "CREATE TABLE synth_scratch (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX synth_scratch_v ON synth_scratch(v)",
    );
    db.exec("INSERT INTO synth_scratch (v) VALUES ('a'), ('b')");
    const units = analysisUnits(db, "synth_scratch");
    expect(units).toEqual(["synth_scratch_v"]);
    db.exec("DROP TABLE synth_scratch");
    const result = refreshPlannerStatistics(db, [...units, "people"]);
    expect(result.analyzed).toEqual(["people"]);
    expect(db.pragma("analysis_limit", { simple: true })).toBe(77);
  });
});

interface Captured {
  op: string;
  sql: string;
  args: unknown[];
}

/** Every SELECT/INSERT/UPDATE/DELETE `run` prepares, with the arguments it first ran with. */
function captureStatements(db: Db, ops: Array<[string, () => unknown]>): Captured[] {
  const captured = new Map<string, Captured>();
  let op = "";
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => Database.Statement }).prepare = (sql: string) => {
    const stmt = prepare(sql);
    if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)/i.test(sql)) return stmt;
    const key = sql.replace(/\s+/g, " ").trim();
    for (const method of ["run", "get", "all", "iterate"] as const) {
      const original = stmt[method].bind(stmt) as (...a: unknown[]) => unknown;
      (stmt as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        if (!captured.has(`${op}\0${key}`)) captured.set(`${op}\0${key}`, { op, sql, args });
        return original(...args);
      };
    }
    return stmt;
  };
  try {
    for (const [name, run] of ops) {
      op = name;
      run();
    }
  } finally {
    (db as unknown as { prepare: typeof prepare }).prepare = prepare;
  }
  return [...captured.values()];
}

const planKey = (c: Captured): string => `${c.op}\0${c.sql}`;

function explain(db: Db, sql: string, args: unknown[] = []): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as Array<{
      detail: string;
    }>
  ).map((r) => r.detail);
}

interface PlanAccess {
  verb: "SEARCH" | "SCAN";
  alias: string;
  index: string;
  terms: number;
}

const ACCESS =
  /^(SEARCH|SCAN) (\S+)(?: USING (?:COVERING )?(?:INDEX (\S+)|(INTEGER PRIMARY KEY|PRIMARY KEY)))?(?: \(([^)]*)\))?/;

function planAccesses(plan: readonly string[]): PlanAccess[] {
  return plan.flatMap((detail) => {
    const m = ACCESS.exec(detail);
    if (!m || m[2] === "CONSTANT") return [];
    return [
      {
        verb: m[1] as "SEARCH" | "SCAN",
        alias: m[2],
        index: m[3] ?? m[4] ?? "",
        terms: m[5] ? m[5].split(" AND ").length : 0,
      },
    ];
  });
}

const count = (plan: readonly string[], test: (detail: string) => boolean): number =>
  plan.filter(test).length;

/**
 * Why `now` is a worse plan than `was`, or nothing when it is not: more table
 * or index scans, a large table scanned that was not, a seek constrained on
 * fewer columns than before (a worse index), more of the ORDER BY sorted (a
 * full sort where only the last term was, or none), a new GROUP BY or
 * DISTINCT sort, or a new multi-index OR.
 */
function planRegressions(was: readonly string[], now: readonly string[]): string[] {
  const reasons: string[] = [];
  const before = planAccesses(was);
  const after = planAccesses(now);
  const scans = (a: PlanAccess[]) => a.filter((x) => x.verb === "SCAN").length;
  if (scans(after) > scans(before)) reasons.push("more scans");
  for (const table of LARGE_TABLES) {
    const scanned = (a: PlanAccess[]) => a.some((x) => x.verb === "SCAN" && x.alias === table);
    if (scanned(after) && !scanned(before)) reasons.push(`scans ${table}`);
  }
  const occurrences = (a: PlanAccess[], alias: string) => a.filter((x) => x.alias === alias);
  for (const alias of new Set(after.map((x) => x.alias))) {
    const prior = occurrences(before, alias);
    occurrences(after, alias).forEach((seek, k) => {
      const was = prior[k];
      if (seek.verb === "SEARCH" && was?.verb === "SEARCH" && seek.terms < was.terms)
        reasons.push(`${alias}: ${was.index} on ${was.terms} → ${seek.index} on ${seek.terms}`);
    });
  }
  const fullSort = (d: string) => d === "USE TEMP B-TREE FOR ORDER BY";
  const anySort = (d: string) => d.startsWith("USE TEMP B-TREE FOR") && d.includes("ORDER BY");
  if (count(now, fullSort) > count(was, fullSort)) reasons.push("full ORDER BY sort");
  if (count(now, anySort) > count(was, anySort)) reasons.push("new ORDER BY sort");
  for (const kind of ["GROUP BY", "DISTINCT"])
    if (
      count(now, (d) => d === `USE TEMP B-TREE FOR ${kind}`) >
      count(was, (d) => d === `USE TEMP B-TREE FOR ${kind}`)
    )
      reasons.push(`new ${kind} sort`);
  if (count(now, (d) => d === "MULTI-INDEX OR") > count(was, (d) => d === "MULTI-INDEX OR"))
    reasons.push("multi-index OR");
  return reasons;
}

describe("planRegressions", () => {
  test("flags each way a plan gets worse, and not a join that only reorders", () => {
    const seek =
      "SEARCH d USING INDEX idx_documents_source_id_created_at (source_id=? AND source_created_at<?)";
    expect(planRegressions([seek], [seek])).toEqual([]);
    expect(
      planRegressions([seek], ["SEARCH d USING INDEX idx_documents_source_id (source_id=?)"]),
    ).toEqual(["d: idx_documents_source_id_created_at on 2 → idx_documents_source_id on 1"]);
    expect(
      planRegressions(
        [seek, "USE TEMP B-TREE FOR LAST TERM OF ORDER BY"],
        [seek, "USE TEMP B-TREE FOR ORDER BY"],
      ),
    ).toEqual(["full ORDER BY sort"]);
    expect(planRegressions([seek], ["MULTI-INDEX OR", seek, seek])).toEqual(["multi-index OR"]);
    expect(planRegressions([seek], ["SCAN documents"])).toEqual(["more scans", "scans documents"]);
    expect(
      planRegressions(
        [
          "SEARCH j USING INTEGER PRIMARY KEY (rowid=?)",
          "SEARCH f USING INDEX w (job_id=? AND done=?)",
        ],
        [
          "SEARCH f USING INDEX w (job_id=? AND done=?)",
          "SEARCH j USING INTEGER PRIMARY KEY (rowid=?)",
        ],
      ),
    ).toEqual([]);
  });
});

function hotWriterOps(db: Db): Array<[string, () => unknown]> {
  const mailPage = (n: number, offset: number, update: boolean) =>
    Array.from({ length: n }, (_, k) => {
      const i = offset + k;
      return {
        providerId: "synth-mail",
        sourceId: "synth-mail-work",
        externalId: update ? pilotExternalId(i) : `ext-new-${i}`,
        title: `Weekly sync ${i}`,
        content: `Status update ${i}`,
        contentHash: `hash-v2-${i}`,
        metadata: {
          documentType: "email",
          people: [{ role: "sender" as const, emails: [pilotEmail(1 + (i % 40))] }],
          extra: { threadId: `thread-${i}` },
        },
        sourceCreatedAt: "2026-10-20T10:00:00Z",
        sourceUpdatedAt: "2026-10-20T10:00:00Z",
      };
    });
  const nearDupDoc = pilotDocId(42);
  const nearDupBatch: NearDupApplyBatch = {
    algoVersion: PILOT_ALGO,
    processedInboxIds: [],
    signatureDeletes: [nearDupDoc],
    signatures: [
      {
        docId: nearDupDoc,
        algoVersion: PILOT_ALGO,
        signature: Buffer.alloc(64, 3),
        shingleCount: 40,
      },
    ],
    bucketRows: Array.from({ length: 16 }, (_, b) => ({
      algoVersion: PILOT_ALGO,
      bandIdx: b,
      bucketHash: b * 7,
      docId: nearDupDoc,
    })),
    edgeUpserts: [
      {
        docA: pilotDocId(0),
        docB: nearDupDoc,
        algoVersion: PILOT_ALGO,
        jaccard: 0.9,
        pairUniqueDf2: 3,
        pairUniqueDf5: 6,
        containmentMin: 0.95,
        gateFamily: "file-like",
      },
    ],
    edgeDeletes: [],
  };
  return [
    [
      "db.upsertWithCursor",
      () =>
        upsertWithCursor(
          db as never,
          {
            providerId: "synth-mail",
            sourceId: "synth-mail-work",
            documents: [...mailPage(40, 0, false), ...mailPage(40, 10, true)],
            deletedExternalIds: [pilotExternalId(20), pilotExternalId(21)],
            hasMore: true,
            cursor: { page: 2 },
          } as unknown as Parameters<typeof upsertWithCursor>[1],
        ),
    ],
    [
      "people.backfillManyPeople",
      () => backfillManyPeople(db as never, 20, { shouldStop: () => false }),
    ],
    ["knowledge.advanceCascade", () => advanceKnowledgeCascade(db as never, 100, Date.now())],
    ["nearDup.applyBatch", () => applyNearDupBatch(db as never, nearDupBatch)],
    [
      "people.acceptCollapsedMergeCandidates",
      () => acceptCollapsedMergeCandidates(db as never, findCollapsedMergeCandidates(db as never)),
    ],
  ];
}

describe("hot writer query plans on an analyzed corpus", () => {
  let db: Db;
  let path: string;
  let captured: Captured[];
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let fresh: Db;

  beforeAll(() => {
    ({ db, path } = seeded(CORPUS_DOCS));
    captured = captureStatements(db, hotWriterOps(db));
    before = new Map(captured.map((c) => [planKey(c), explain(db, c.sql, c.args)]));
    refreshPlannerStatistics(db, undefined);
    fresh = new Database(path, { readonly: true });
    after = new Map(captured.map((c) => [planKey(c), explain(fresh, c.sql, c.args)]));
  }, 120_000);

  afterAll(() => {
    fresh?.close();
    db?.close();
  });

  test("captures the statements of every hot writer op", () => {
    const ops = new Set(captured.map((c) => c.op));
    expect([...ops].sort()).toEqual(
      [
        "db.upsertWithCursor",
        "knowledge.advanceCascade",
        "nearDup.applyBatch",
        "people.acceptCollapsedMergeCandidates",
        "people.backfillManyPeople",
      ].sort(),
    );
    expect(captured.length).toBeGreaterThan(40);
  });

  test("no statement's plan gets worse once statistics exist", () => {
    const regressions = captured.flatMap((c) => {
      const was = before.get(planKey(c))!;
      const now = after.get(planKey(c))!;
      const reasons = planRegressions(was, now);
      return reasons.length > 0 ? [{ op: c.op, sql: c.sql, reasons, was, now }] : [];
    });
    expect(regressions).toEqual([]);
  });

  test("the cascade picks stay index seeks", () => {
    const jobPlan = explain(fresh, KNOWLEDGE_CASCADE_NEXT_JOB_SQL, ["invalidate"]).join("\n");
    expect(jobPlan).toMatch(/SEARCH j USING (COVERING )?INDEX knowledge_cascade_jobs_kind/);
    const rowPlan = explain(fresh, KNOWLEDGE_CASCADE_NEXT_ROW_SQL, [1]).join("\n");
    expect(rowPlan).toMatch(/SEARCH f USING (COVERING )?INDEX knowledge_cascade_work/);
    expect(rowPlan).not.toMatch(/TEMP B-TREE/);
  });

  test("statistics alone send the unpinned bucket delete to the doc index", () => {
    const unpinned = BUCKET_DELETE_FOR_DOC_SQL.replace(" INDEXED BY idx_near_dup_lsh_doc", "");
    const unanalyzedPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    paths.push(unanalyzedPath);
    const unanalyzed = createDatabase(unanalyzedPath) as unknown as Db;
    try {
      seedPilotCorpus(unanalyzed, { docs: 600 });
      expect(explain(unanalyzed, unpinned, [pilotDocId(6), PILOT_ALGO]).join("\n")).not.toMatch(
        /idx_near_dup_lsh_doc/,
      );
    } finally {
      unanalyzed.close();
    }
    expect(explain(fresh, unpinned, [pilotDocId(6), PILOT_ALGO]).join("\n")).toMatch(
      /SEARCH near_dup_lsh_buckets USING INDEX idx_near_dup_lsh_doc \(doc_id=\?\)/,
    );
    expect(
      explain(fresh, BUCKET_DELETE_FOR_DOC_SQL, [pilotDocId(6), PILOT_ALGO]).join("\n"),
    ).toMatch(/idx_near_dup_lsh_doc/);
  });
});

/** The read paths a statistics change could slow: pages, person views, browse, search, lists. */
function readPathOps(db: Db): Array<[string, () => unknown]> {
  const pageBoundary = db
    .prepare<[], { source_created_at: string; id: string }>(
      `SELECT source_created_at, id FROM documents WHERE source_id = 'synth-mail-work'
        ORDER BY source_created_at DESC, id DESC LIMIT 1 OFFSET 20`,
    )
    .get()!;
  const auditBoundary = db
    .prepare<[], { occurred_at: number; id: string }>(
      "SELECT occurred_at, id FROM access_audit_events ORDER BY occurred_at DESC, id DESC LIMIT 1 OFFSET 31",
    )
    .get()!;
  const edge = db
    .prepare<[], { doc_a: string; doc_b: string; jaccard: number }>(
      "SELECT doc_a, doc_b, jaccard FROM near_dup_edges LIMIT 1",
    )
    .get()!;
  return [
    [
      "recent page",
      () =>
        getRecentDocuments(db, "synth-mail-work", 20, {
          sourceCreatedAt: pageBoundary.source_created_at,
          id: pageBoundary.id,
        }),
    ],
    ["recent rare", () => getRecentDocuments(db, "synth-code", 20)],
    [
      "recent rare page",
      () =>
        getRecentDocuments(db, "synth-health", 20, {
          sourceCreatedAt: "2026-09-30T00:00:00Z",
          id: "synth-doc-zz",
        }),
    ],
    [
      "list include+since",
      () =>
        listDocuments(db, {
          includeSourceIds: ["synth-code"],
          updatedSince: "2016-02-01T00:00:00Z",
          limit: 50,
        }),
    ],
    ["list exclude", () => listDocuments(db, { excludeSourceIds: ["synth-mail-work"], limit: 50 })],
    ["list after", () => listDocuments(db, { afterId: pilotDocId(100), limit: 50 })],
    ["people browse", () => searchPeople(db, "", 50)],
    ["people browse docs", () => searchPeople(db, "", 50, { sortBy: "documents" })],
    ["people query", () => searchPeople(db, "synth contact 1", 50)],
    ["person", () => getPersonById(db, pilotPersonId(5))],
    ["person docs self", () => getPersonDocuments(db, pilotPersonId(0), { limit: 50 })],
    ["person docs canonical", () => getPersonDocuments(db, pilotPersonId(19), { limit: 50 })],
    ["person docs rare", () => getPersonDocuments(db, pilotPersonId(250), { limit: 50 })],
    [
      "person docs role",
      () => getPersonDocuments(db, pilotPersonId(0), { role: "sender", limit: 50 }),
    ],
    ["doc people", () => getDocumentPeople(db, pilotDocId(42))],
    ["docs people summary", () => getDocumentsPeopleSummary(db, [pilotDocId(42), pilotDocId(43)])],
    ["people stats", () => getPeopleStats(db)],
    ["person filter", () => resolvePersonDocIds(db, [pilotPersonId(19)], ["recipient"])],
    [
      "like search",
      () =>
        likeSearchDocuments(db, { query: "planning", hiddenSourceIds: ["synth-web"], limit: 20 }),
    ],
    ["merge candidates", () => listMergeCandidates(db, {})],
    ["merge candidate count", () => countMergeCandidates(db, "pending")],
    ["catalog", () => getSqliteCatalog(db)],
    [
      "access audit page",
      () =>
        listAccessAuditEvents(db, {
          limit: 30,
          after: { occurredAt: auditBoundary.occurred_at, id: auditBoundary.id },
        }),
    ],
    [
      "access audit principal page",
      () =>
        listAccessAuditEvents(db, {
          limit: 30,
          principalId: "synth-principal-2",
          after: { occurredAt: auditBoundary.occurred_at, id: auditBoundary.id },
        }),
    ],
    [
      "annotations page",
      () => listLiveAnnotationsForDoc(db, pilotDocId(42), { before: { createdAt: 9e12, id: "z" } }),
    ],
    [
      "dependents page",
      () =>
        listLiveDependentsForAnnotation(db, "doc", "synth-annotation", {
          limit: 20,
          before: { createdAt: 9e12, kind: "loop", id: "z" },
        }),
    ],
    [
      "coverage page",
      () =>
        listCognitionCoverage(db, {
          before: { lastProgressAt: 9e12, sourceId: "a", workflowId: "b", workflowVersion: 1 },
        }),
    ],
    [
      "interest signals page",
      () =>
        listUnembeddedInterestSignals(db, {
          limit: 20,
          now: 9e12,
          after: { createdAt: 1, id: "a" },
        }),
    ],
    [
      "merge rules page",
      () => listMergeRules(db, { limit: 20, beforeCreated: { createdAt: "2027-01-01", id: "z" } }),
    ],
    [
      "notes page",
      () => listNoteEntriesHistory(db, 20, { capturedAt: "2027-01-01T00:00:00Z", id: "a" }),
    ],
    [
      "near-dup page",
      () =>
        getNearDupEdges(db, edge.doc_a, {
          limit: 5,
          cursor: `${edge.doc_b}|${edge.jaccard}`,
        }),
    ],
  ];
}

describe("read-path query plans on an analyzed corpus", () => {
  let db: Db;
  let path: string;
  let captured: Captured[];
  let before: Map<string, string[]>;
  let after: Map<string, string[]>;
  let fresh: Db;

  beforeAll(() => {
    ({ db, path } = seeded(CORPUS_DOCS));
    setActiveAlgoVersion(db as never, PILOT_ALGO);
    captured = captureStatements(db, readPathOps(db));
    for (const entry of getSqliteCatalog(db))
      for (const sql of entry.exampleQueries ?? [])
        captured.push({ op: `catalog example: ${entry.tableName}`, sql, args: [] });
    before = new Map(captured.map((c) => [planKey(c), explain(db, c.sql, c.args)]));
    refreshPlannerStatistics(db, undefined);
    fresh = new Database(path, { readonly: true });
    after = new Map(captured.map((c) => [planKey(c), explain(fresh, c.sql, c.args)]));
  }, 120_000);

  afterAll(() => {
    fresh?.close();
    db?.close();
  });

  test("captures the statements of every read path", () => {
    const ops = new Set(captured.map((c) => c.op));
    for (const [name] of readPathOps(db)) expect(ops).toContain(name);
    expect(captured.length).toBeGreaterThan(50);
  });

  test("no read statement's plan gets worse once statistics exist", () => {
    const regressions = captured.flatMap((c) => {
      const was = before.get(planKey(c))!;
      const now = after.get(planKey(c))!;
      const reasons = planRegressions(was, now);
      return reasons.length > 0 ? [{ op: c.op, sql: c.sql, reasons, was, now }] : [];
    });
    expect(regressions).toEqual([]);
  });

  test("keyset pages seek their order and split into no multi-index OR, with or without statistics", () => {
    for (const op of ["recent page", "access audit page", "access audit principal page"]) {
      const statements = captured.filter(
        (c) => c.op === op && /\(\w+\.?\w*, \w+\.?\w*\) [<>] \(\?, \?\)/.test(c.sql),
      );
      expect(statements.length, op).toBeGreaterThan(0);
      for (const c of statements)
        for (const plan of [before.get(planKey(c))!, after.get(planKey(c))!]) {
          expect(plan, `${op}: ${plan.join(" | ")}`).not.toContain("MULTI-INDEX OR");
          expect(plan, `${op}: ${plan.join(" | ")}`).not.toContain("USE TEMP B-TREE FOR ORDER BY");
        }
    }
  });
});

describe("long-lived readers and a pass in slices", () => {
  test("a reader open across a sliced pass ends on the finished statistics", () => {
    const { db, path } = seeded(3_000);
    setActiveAlgoVersion(db as never, PILOT_ALGO);
    const reader = new Database(path, { readonly: true });
    try {
      const unpinned = BUCKET_DELETE_FOR_DOC_SQL.replace(
        "DELETE FROM near_dup_lsh_buckets INDEXED BY idx_near_dup_lsh_doc",
        "SELECT 1 FROM near_dup_lsh_buckets",
      );
      const probe = () => explain(reader, unpinned, [pilotDocId(6), PILOT_ALGO]).join(" | ");
      const loaded = () =>
        reader.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM people").get()!.n;
      loaded();
      let progress = refreshPlannerStatistics(db, undefined, { shouldStop: () => true });
      while (progress.remaining.length > 0) {
        loaded();
        progress = refreshPlannerStatistics(db, progress.remaining, { shouldStop: () => true });
      }
      loaded();
      const restarted = new Database(path, { readonly: true });
      try {
        expect(probe()).toBe(explain(restarted, unpinned, [pilotDocId(6), PILOT_ALGO]).join(" | "));
        expect(probe()).toMatch(/idx_near_dup_lsh_doc/);
      } finally {
        restarted.close();
      }
    } finally {
      reader.close();
      db.close();
    }
  });

  test("a caught-up pass analyzes nothing and leaves the schema alone", () => {
    const { db } = seeded(1_500);
    try {
      refreshPlannerStatistics(db, undefined);
      const cookie = db.pragma("schema_version", { simple: true });
      const again = refreshPlannerStatistics(db, undefined);
      expect(again).toEqual({ analyzed: [], tables: [], remaining: [] });
      expect(db.pragma("schema_version", { simple: true })).toBe(cookie);
    } finally {
      db.close();
    }
  });
});

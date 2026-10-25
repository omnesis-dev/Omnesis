// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createKnowledgeTables } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { KNOWLEDGE_DISCOVERY_POLICY, recordKnowledgeCoverage } from "./discovery.js";
import { directKnowledgeGate } from "./writer.js";
import { KnowledgeOrganization } from "./engine-organization.js";
import { narrowOrganizationSelection } from "./organization-cohorts.js";
import { createKnowledgeDecisionTable, recordKnowledgeDecision } from "./decision-storage.js";
import type { DecisionCapability, Logger } from "@omnesis/core";
import type { KnowledgeEngineDeps } from "./engine.js";

const DAY = 86_400_000;
const settings = resolveBrainSettings({
  bootstrap: { enabled: false },
  knowledge: { soonDelay: "5m", routineDelay: "6h" },
});
let db: Database.Database;
let now: number;
let serial: number;
let info: ReturnType<typeof vi.fn>;
/** Dependents of each source, standing in for its maintenance region. */
let dependents: Map<string, string[]>;
let organization: KnowledgeOrganization;
/** Discovery worth levels (0–2) the scripted decision model gives by source title; 2 otherwise. */
let worth: Map<string, number>;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,content_hash TEXT,metadata TEXT)",
  );
  db.exec("CREATE TABLE people(id TEXT PRIMARY KEY,is_self BOOLEAN DEFAULT FALSE)");
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  createKnowledgeDecisionTable(db);
  worth = new Map();
  now = 200 * DAY;
  serial = 0;
  dependents = new Map();
  info = vi.fn();
  const log = { info, warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
  const decision = {
    modelId: "scripted",
    dispose() {},
    decide: async (request: { state: { source: { title: string } } }) => ({
      model: "scripted",
      answers: {
        discovery: { type: "score", score: worth.get(request.state.source.title) ?? 2 },
      },
    }),
  } as unknown as DecisionCapability;
  const deps = {
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => settings,
    clock: () => now,
    log,
    decisions: {
      getDecision: () => decision,
      log,
      recordSpend: async () => {},
      record: async (entry: Parameters<typeof recordKnowledgeDecision>[1]) =>
        recordKnowledgeDecision(db, { ...entry, id: `kd_${++serial}` }, now),
    },
  } as unknown as KnowledgeEngineDeps;
  organization = new KnowledgeOrganization({
    deps,
    id: (prefix) => `${prefix}_${++serial}`,
    frontier: (id, depth) => ({
      nodeId: id,
      depth,
      inputFingerprint: `fingerprint-${id}`,
      inputVersions: { [id]: "v1" },
    }),
    arcs: (id) => (dependents.get(id) ?? []).map((dependent) => ({ input: id, dependent })),
    roots: () => new Set(),
    source: (id) => ({
      title: id,
      content: `Body of ${id}.`,
      sourceRevision: "v1",
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
    }),
  });
});
afterEach(() => db.close());

function outcome(id: string, importance: number, docs: string[], considered = true) {
  db.prepare(
    `INSERT INTO open_loops(id,created_by_run,state,confidence,importance,title,created_at,last_update)
    VALUES(?,'fixture','open',0.9,?,?,?,?)`,
  ).run(id, importance, `Outcome ${id}`, now - DAY, now - DAY);
  for (const doc of docs) {
    db.prepare("INSERT INTO documents VALUES(?,?,?,'{}')").run(doc, `source-${doc}`, "v1");
    if (considered)
      recordKnowledgeCoverage(
        db,
        {
          subjectId: doc,
          inputRevision: "v1",
          phase: "organization",
          policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
          status: "considered",
        },
        1,
      );
    db.prepare("INSERT INTO open_loop_docs VALUES(?,?)").run(id, doc);
  }
}
function region(source: string, size: number) {
  dependents.set(
    `source:${source}`,
    Array.from({ length: size }, (_, i) => `wiki_${source}_${i}`),
  );
}
function cohorts() {
  return db
    .prepare<[], { subject: string | null; members: string }>(
      `SELECT c.subject_loop_id AS subject,group_concat(m.source_id) AS members
      FROM knowledge_organization_cohorts c JOIN knowledge_organization_members m ON m.cohort_id=c.id
      GROUP BY c.id ORDER BY c.created_at`,
    )
    .all()
    .map((row) => ({ subject: row.subject, members: row.members.split(",").sort() }));
}
function logged(): string[] {
  return info.mock.calls.map((call) => String(call[0]));
}

describe("starting subject organization cohorts", () => {
  it("sheds a source whose maintenance region does not fit and starts the subject with the rest", async () => {
    outcome("matter", 0.9, ["matter-a", "matter-b", "matter-c"]);
    region("matter-c", settings.knowledge.maxVisitedPerSeed + 1);
    expect(await organization.plan()).toBe(1);
    expect(cohorts()).toEqual([{ subject: "matter", members: ["matter-a", "matter-b"] }]);
    expect(logged()).toContainEqual(
      "Organization cohort started: subject anchored on loop matter, 2 source(s), 1 shed",
    );
  });

  it("sheds sources until the joint region fits within the bound", async () => {
    outcome("matter", 0.9, ["matter-a", "matter-b", "matter-c"]);
    // Each region is its source plus its dependents; two fit the bound, three do not.
    const half = settings.knowledge.maxVisitedPerSeed / 2 - 2;
    for (const doc of ["matter-a", "matter-b", "matter-c"]) region(doc, half);
    expect(await organization.plan()).toBe(1);
    expect(cohorts()).toEqual([expect.objectContaining({ subject: "matter" })]);
    expect(cohorts()[0]!.members).toHaveLength(2);
  });

  it("passes over a subject that cannot fit so the next subject starts on the same tick", async () => {
    outcome("oversized", 0.95, ["oversized-a", "oversized-b"]);
    region("oversized-a", settings.knowledge.maxVisitedPerSeed + 1);
    region("oversized-b", settings.knowledge.maxVisitedPerSeed + 1);
    outcome("next", 0.7, ["next-a", "next-b"]);
    expect(await organization.plan()).toBe(1);
    expect(logged()).toContainEqual(
      "Organization cohort not started: subject anchored on loop oversized, 2 source(s), reason region_limit; passing over it for 21600000ms",
    );
    expect(cohorts()).toEqual([{ subject: "next", members: ["next-a", "next-b"] }]);
  });

  it("says why no subject started, once per state rather than on every tick", async () => {
    outcome("unread", 0.9, ["unread-a", "unread-b"], false);
    await organization.plan();
    const report =
      "Subject organization cohorts: none started; 1 important outcome(s), 1 without a page, in 1 subject(s); 0 waiting their retry, 0 passed over after a failed start, 1 with fewer than two considered documents (0 of their 2 considered)";
    expect(logged()).toEqual([report]);
    now += 60_000;
    await organization.plan();
    expect(logged()).toEqual([report]);
    now += 6 * 3_600_000;
    await organization.plan();
    expect(logged()).toEqual([report, report]);
  });

  it("passes over a publication retry that conflicts, so a subject starts on the same tick", async () => {
    // A completed cohort reopened by a published search gap.
    const docs = ["retry-a", "retry-b"];
    for (const doc of docs) {
      db.prepare("INSERT INTO documents VALUES(?,?,?,'{}')").run(doc, `source-${doc}`, "v1");
      recordKnowledgeCoverage(
        db,
        {
          subjectId: doc,
          inputRevision: "v1",
          phase: "organization",
          policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
          status: "considered",
        },
        1,
      );
    }
    const { inputFingerprint } = narrowOrganizationSelection(
      { sourceVersions: { "retry-a": "v1", "retry-b": "v1" }, inputFingerprint: "" },
      docs,
    );
    db.prepare(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('kb-old','cog-old','f','routine','completed',1,1)",
    ).run();
    db.prepare(
      `INSERT INTO knowledge_organization_cohorts(id,batch_id,input_fingerprint,policy_version,status,retry_at,created_at,updated_at,retrieval_reconsider_at)
      VALUES('ko-old','kb-old',?,?,'completed',?,1,1,1)`,
    ).run(inputFingerprint, KNOWLEDGE_DISCOVERY_POLICY, now + 30 * DAY);
    for (const doc of docs)
      db.prepare("INSERT INTO knowledge_organization_members VALUES('ko-old',?,'v1')").run(doc);
    // Another active batch holds part of the retry's region.
    db.prepare(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('kb-busy','cog-busy','f','routine','running',1,1)",
    ).run();
    db.prepare("INSERT INTO knowledge_batch_regions VALUES('kb-busy','source:retry-a')").run();
    outcome("matter", 0.9, ["matter-a", "matter-b"]);

    expect(await organization.plan()).toBe(1);
    expect(logged()).toContainEqual(
      "Organization cohort not started: retry, 2 source(s), reason revision_conflict (Maintenance region overlaps an active batch); passing over it for 300000ms",
    );
    expect(cohorts()).toEqual([
      { subject: null, members: docs },
      { subject: "matter", members: ["matter-a", "matter-b"] },
    ]);
  });
});

describe("screening organization cohorts by current discovery worth", () => {
  function evidence(ids: string[]) {
    for (const id of ids) {
      db.prepare("INSERT INTO documents VALUES(?,?,?,'{}')").run(id, `source-${id}`, "v1");
      recordKnowledgeCoverage(
        db,
        {
          subjectId: id,
          inputRevision: "v1",
          phase: "organization",
          policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
          status: "considered",
        },
        1,
      );
    }
  }
  const coverage = () =>
    Object.fromEntries(
      db
        .prepare<[], { id: string; status: string }>(
          "SELECT subject_id AS id,status FROM knowledge_discovery_coverage WHERE phase='organization'",
        )
        .all()
        .map((row) => [row.id, row.status]),
    );

  it("withdraws low-worth members and starts the cohort with the rest, judging each once", async () => {
    // Invented routine status notifications across streams, and two sources worth organizing.
    const routine = ["parcel-scan", "uptime-recovered", "card-purchase"];
    evidence([...routine, "lease-signed", "lease-terms"]);
    for (const id of routine) worth.set(id, 0);
    expect(await organization.plan()).toBe(1);
    expect(cohorts()).toEqual([{ subject: null, members: ["lease-signed", "lease-terms"] }]);
    expect(coverage()).toMatchObject({
      "parcel-scan": "gated",
      "uptime-recovered": "gated",
      "card-purchase": "gated",
    });
    expect(logged()).toContainEqual(
      "Organization cohort screened: chronological, 3 of 5 source(s) withdrawn as low worth",
    );
    // Each judgement is in the ledger, once per member.
    expect(
      db
        .prepare(
          "SELECT node_id AS id,score FROM knowledge_decisions WHERE purpose='discovery' ORDER BY node_id",
        )
        .all(),
    ).toEqual(
      ["card-purchase", "lease-signed", "lease-terms", "parcel-scan", "uptime-recovered"].map(
        (id) => ({ id: `source:${id}`, score: routine.includes(id) ? 0 : 1 }),
      ),
    );
  });

  it("starts nothing when every selected member is low worth, and never selects them again", async () => {
    const routine = ["build-101", "build-102", "build-103"];
    evidence(routine);
    for (const id of routine) worth.set(id, 0);
    expect(await organization.plan()).toBe(0);
    expect(cohorts()).toEqual([]);
    expect(Object.values(coverage())).toEqual(["gated", "gated", "gated"]);
    now += DAY;
    expect(await organization.plan()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_decisions").get()).toEqual({ n: 3 });
  });
});

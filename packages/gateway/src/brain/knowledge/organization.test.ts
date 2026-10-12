// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKnowledgeTables } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import {
  getKnowledgeCandidate,
  proposeKnowledgeCandidate,
  recordKnowledgeCoverage,
  settleKnowledgeCandidate,
  KNOWLEDGE_DISCOVERY_POLICY,
} from "./discovery.js";
import {
  admitKnowledgeOrganization,
  listOrganizationAdmissions,
  organizationCandidatesForSource,
} from "./organization.js";

import { pendingCandidateDecisions } from "./candidate-decision.js";
import { enqueueKnowledgeWork } from "./work.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,content TEXT,content_hash TEXT,source_created_at TEXT,source_updated_at TEXT)",
  );
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  db.exec(
    "INSERT INTO documents VALUES('evidence','fictional-source','Workshop','The workshop is planned.','v1','2026-01-01','2026-01-01')",
  );
});
afterEach(() => db.close());
const pending = (now = 101) => listOrganizationAdmissions(db, { now, limit: 5, retryMs: 100 });
function candidate() {
  return proposeKnowledgeCandidate(
    db,
    {
      id: "candidate-workshop",
      identityKey: "project:workshop",
      title: "Workshop",
      scope: "Workshop planning",
      evidenceVersions: { evidence: "v1" },
    },
    1,
  );
}
function gated() {
  recordKnowledgeCoverage(
    db,
    {
      subjectId: "evidence",
      inputRevision: "v1",
      phase: "organization",
      policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
      status: "gated",
    },
    1,
  );
}
describe("bounded organization reconsideration", () => {
  it("revisits deferred candidates without repeatedly admitting the same revision", () => {
    const first = candidate();
    settleKnowledgeCandidate(
      db,
      { id: first.id, expectedRevision: first.revision, status: "deferred", reconsiderAt: 101 },
      2,
    );
    expect(pending(100)).toEqual([]);
    const admission = pending()[0]!;
    expect(
      admitKnowledgeOrganization(db, { admission, workPrefix: "work", retryAt: 201 }, 101),
    ).toBe(true);
    expect(
      admitKnowledgeOrganization(db, { admission, workPrefix: "duplicate", retryAt: 201 }, 101),
    ).toBe(false);
    expect(pending()).toEqual([]);
    expect(db.prepare("SELECT subject_id,reason FROM knowledge_work").all()).toEqual([
      { subject_id: "evidence", reason: "review" },
    ]);
    expect(organizationCandidatesForSource(db, "evidence")[0]?.status).toBe("deferred");
  });
  it("does not revive a candidate dismissed after the scheduler read it", () => {
    const first = candidate();
    const admission = pending()[0]!;
    settleKnowledgeCandidate(
      db,
      { id: first.id, expectedRevision: first.revision, status: "dismissed" },
      100,
    );
    expect(
      admitKnowledgeOrganization(db, { admission, workPrefix: "work", retryAt: 201 }, 101),
    ).toBe(false);
    expect(db.prepare("SELECT * FROM knowledge_work").all()).toEqual([]);
  });
  it("explores gated evidence on a bounded retry without pretending it was reviewed again", () => {
    gated();
    const admission = pending()[0]!;
    expect(
      admitKnowledgeOrganization(db, { admission, workPrefix: "work", retryAt: 201 }, 101),
    ).toBe(true);
    expect(
      admitKnowledgeOrganization(db, { admission, workPrefix: "duplicate", retryAt: 201 }, 101),
    ).toBe(false);
    expect(
      db.prepare("SELECT reviewed_at,reconsider_at,status FROM knowledge_discovery_coverage").get(),
    ).toEqual({ reviewed_at: 1, reconsider_at: 201, status: "gated" });
    expect(pending(200)).toEqual([]);
    expect(pending(201)).toHaveLength(1);
  });
  it("does not scan unseen history or reinterpret coverage for an obsolete revision", () => {
    expect(pending()).toEqual([]);
    gated();
    const admission = pending()[0]!;
    db.exec("UPDATE documents SET content_hash='v2'");
    expect(pending()).toEqual([]);
    expect(
      admitKnowledgeOrganization(db, { admission, workPrefix: "work", retryAt: 201 }, 101),
    ).toBe(false);
  });
  it("does not let privacy-hidden candidates starve a bounded valid admission", () => {
    candidate();
    gated();
    db.exec(
      "CREATE TABLE removed_sources(id TEXT PRIMARY KEY); INSERT INTO removed_sources VALUES('fictional-source')",
    );
    db.exec(
      "INSERT INTO documents VALUES('other','readable-source','Later workshop','Another workshop.','v1','2026-01-02','2026-01-02')",
    );
    proposeKnowledgeCandidate(
      db,
      {
        id: "visible",
        identityKey: "project:other",
        title: "Other workshop",
        scope: "Separate planning",
        evidenceVersions: { other: "v1" },
      },
      2,
    );
    expect(listOrganizationAdmissions(db, { now: 102, limit: 1, retryMs: 100 })).toEqual([
      { kind: "candidate", id: "visible", revision: 1 },
    ]);
  });
  it("privacy-fences candidates and stale queued admissions before background cleanup", () => {
    candidate();
    gated();
    const admissions = pending();
    db.exec(
      "CREATE TABLE removed_sources(id TEXT PRIMARY KEY); INSERT INTO removed_sources VALUES('fictional-source')",
    );
    expect(pending()).toEqual([]);
    expect(organizationCandidatesForSource(db, "evidence")).toEqual([]);
    for (const admission of admissions)
      expect(
        admitKnowledgeOrganization(db, { admission, workPrefix: "work", retryAt: 201 }, 101),
      ).toBe(false);
    expect(db.prepare("SELECT * FROM knowledge_work").all()).toEqual([]);
  });
});

describe("candidate decision debt", () => {
  it("offers unresolved curation soon, respects explicit deferral, and does not readmit active work", () => {
    const first = candidate();
    const options = { now: 11, limit: 5, retryMs: 1000, initialDelayMs: 10 };
    expect(listOrganizationAdmissions(db, { ...options, now: 10 })).toEqual([]);
    const [admission] = listOrganizationAdmissions(db, options);
    expect(admission).toEqual({ kind: "candidate", id: first.id, revision: 1 });
    expect(
      admitKnowledgeOrganization(
        db,
        { admission: admission!, workPrefix: "decision", retryAt: 1011 },
        11,
      ),
    ).toBe(true);
    createKnowledgeWorkTables(db); // Restart does not erase admitted decision debt.
    expect(listOrganizationAdmissions(db, { ...options, now: 2011 })).toEqual([]);
    const current = getKnowledgeCandidate(db, first.id)!;
    settleKnowledgeCandidate(
      db,
      { id: first.id, expectedRevision: current.revision, status: "deferred", reconsiderAt: 5011 },
      12,
    );
    expect(listOrganizationAdmissions(db, { ...options, now: 5010 })).toEqual([]);
    expect(listOrganizationAdmissions(db, { ...options, now: 5011 })).toHaveLength(1);
  });

  it("binds only admitted work and carries that obligation through a retry", () => {
    const first = candidate();
    const admission = pending()[0]!;
    admitKnowledgeOrganization(db, { admission, workPrefix: "decision", retryAt: 201 }, 101);
    db.exec(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','test-fingerprint','routine','running',101,101)",
    );
    db.exec("UPDATE knowledge_work SET batch_id='batch',status='batched' WHERE id='decision_0'");
    db.exec(
      "INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES('batch','source:evidence','v1','{}',0,'unchanged')",
    );
    const current = getKnowledgeCandidate(db, first.id)!;
    expect(pendingCandidateDecisions(db, "unrelated")).toEqual([]);
    expect(pendingCandidateDecisions(db, "batch")).toEqual([
      { id: first.id, revision: current.revision },
    ]);
    settleKnowledgeCandidate(
      db,
      { id: first.id, expectedRevision: current.revision, status: "proposed" },
      102,
    );
    expect(pendingCandidateDecisions(db, "batch")).toHaveLength(1);
    db.exec("UPDATE knowledge_work SET status='deferred' WHERE id='decision_0'");
    const retry = enqueueKnowledgeWork(
      db,
      {
        id: "retry",
        subjectId: "evidence",
        subjectKind: "source",
        reason: "review",
        inputRevision: "v1",
        tier: "routine",
        dueAt: 110,
      },
      103,
      "decision_0",
    );
    expect(
      db
        .prepare("SELECT candidate_id FROM knowledge_candidate_decision_work WHERE work_id=?")
        .get(retry.id),
    ).toEqual({ candidate_id: first.id });
    const reopened = getKnowledgeCandidate(db, first.id)!;
    expect(() =>
      settleKnowledgeCandidate(
        db,
        { id: first.id, expectedRevision: current.revision, status: "dismissed" },
        104,
      ),
    ).toThrow("Candidate changed");
    settleKnowledgeCandidate(
      db,
      { id: first.id, expectedRevision: reopened.revision, status: "proposed", reconsiderAt: 301 },
      104,
    );
    expect(pendingCandidateDecisions(db, "batch")).toEqual([]);
    const retained = getKnowledgeCandidate(db, first.id)!;
    settleKnowledgeCandidate(
      db,
      { id: first.id, expectedRevision: retained.revision, status: "proposed" },
      105,
    );
    // Explicit reopening creates new debt, without reviving the old batch obligation.
    expect(pendingCandidateDecisions(db, "batch")).toEqual([]);
    expect(
      listOrganizationAdmissions(db, { now: 115, limit: 5, retryMs: 1000, initialDelayMs: 10 }),
    ).toHaveLength(1);
  });
});

it("conservatively upgrades proposed decision state while retaining explicit deadlines", () => {
  const first = candidate();
  settleKnowledgeCandidate(
    db,
    { id: first.id, expectedRevision: 1, status: "proposed", reconsiderAt: 500 },
    2,
  );
  db.exec(
    "ALTER TABLE knowledge_candidates DROP COLUMN decision_pending; ALTER TABLE knowledge_candidates DROP COLUMN decision_generation",
  );
  createKnowledgeWorkTables(db);
  expect(
    db.prepare("SELECT decision_pending,reconsider_at FROM knowledge_candidates").get(),
  ).toEqual({ decision_pending: 1, reconsider_at: 500 });
  expect(
    listOrganizationAdmissions(db, { now: 499, limit: 5, retryMs: 1000, initialDelayMs: 10 }),
  ).toEqual([]);
  expect(
    listOrganizationAdmissions(db, { now: 500, limit: 5, retryMs: 1000, initialDelayMs: 10 }),
  ).toHaveLength(1);
});

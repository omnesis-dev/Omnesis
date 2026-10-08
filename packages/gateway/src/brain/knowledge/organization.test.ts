// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKnowledgeTables } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import {
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

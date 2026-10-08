// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKnowledgeTables, getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import {
  listKnowledgeDiscoveryBacklog,
  recordKnowledgeCoverage,
  proposeKnowledgeCandidate,
  publishKnowledgeCandidate,
  getKnowledgeCandidate,
  listKnowledgeCandidates,
  settleKnowledgeCandidate,
  KNOWLEDGE_DISCOVERY_POLICY,
} from "./discovery.js";
import { KNOWLEDGE_SOURCE_ID } from "./source-meta.js";
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,content TEXT,content_hash TEXT,source_created_at TEXT,source_updated_at TEXT)",
  );
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());
function source(id: string, date: string, sourceId = "fictional-source") {
  db.prepare("INSERT INTO documents VALUES(?,?,?,'The workshop is planned.','v1',?,?)").run(
    id,
    sourceId,
    id,
    date,
    date,
  );
}
function candidate() {
  return proposeKnowledgeCandidate(
    db,
    {
      id: "candidate-workshop",
      identityKey: "project:workshop",
      title: "Workshop",
      scope: "Workshop planning and decisions",
      evidenceVersions: { evidence: "v1" },
    },
    1,
  );
}
const node = {
  id: "wiki-workshop",
  kind: "wiki" as const,
  title: "Workshop",
  markdown: '<claim id="plan" refs="source:evidence">The workshop is planned.</claim>',
  expectedRevision: 0,
  inputVersions: { "source:evidence": "v1" },
};
describe("progressive knowledge discovery", () => {
  it("hides candidate prose immediately when its source is withdrawn", () => {
    source("evidence", "2026-01-01T00:00:00Z");
    candidate();
    db.exec(
      "CREATE TABLE removed_sources(id TEXT PRIMARY KEY); INSERT INTO removed_sources VALUES('fictional-source')",
    );
    expect(getKnowledgeCandidate(db, "candidate-workshop")).toBeNull();
    expect(listKnowledgeCandidates(db, { limit: 1 })).toEqual({
      items: [],
      nextCursor: "candidate-workshop",
    });
    expect(
      listKnowledgeDiscoveryBacklog(db, { phase: "organization", limit: 10, now: 20 }),
    ).toEqual([]);
    expect(() =>
      recordKnowledgeCoverage(
        db,
        {
          subjectId: "evidence",
          inputRevision: "v1",
          phase: "organization",
          policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
          status: "considered",
        },
        20,
      ),
    ).toThrow();
  });
  it("does not borrow candidate grounding from an uncited sibling claim", () => {
    source("evidence", "2026-01-01T00:00:00Z");
    source("unrelated", "2026-01-01T00:00:00Z");
    candidate();
    saveKnowledgeNode(
      db,
      {
        ...node,
        id: "prior",
        markdown:
          '<claim id="a" refs="source:unrelated">Unrelated context.</claim><claim id="b" refs="source:evidence">Workshop context.</claim>',
        inputVersions: { "source:evidence": "v1", "source:unrelated": "v1" },
      },
      2,
    );
    expect(() =>
      publishKnowledgeCandidate(
        db,
        {
          candidateId: "candidate-workshop",
          expectedCandidateRevision: 1,
          node: {
            ...node,
            markdown: '<claim id="fact" refs="wiki:prior#claim:a">Unrelated context.</claim>',
            inputVersions: { "wiki:prior#claim:a": 1 },
          },
        },
        3,
      ),
    ).toThrow("declared evidence");
    expect(getKnowledgeNode(db, node.id)).toBeNull();
  });
  it("supports deferred organization and preserves a published identity", () => {
    source("evidence", "2026-01-01T00:00:00Z");
    candidate();
    const deferred = settleKnowledgeCandidate(
      db,
      { id: "candidate-workshop", expectedRevision: 1, status: "deferred", reconsiderAt: 100 },
      2,
    );
    const reopened = settleKnowledgeCandidate(
      db,
      { id: deferred.id, expectedRevision: deferred.revision, status: "proposed" },
      100,
    );
    publishKnowledgeCandidate(
      db,
      { candidateId: reopened.id, expectedCandidateRevision: reopened.revision, node },
      101,
    );
    const published = getKnowledgeCandidate(db, reopened.id)!;
    expect(() =>
      settleKnowledgeCandidate(
        db,
        { id: published.id, expectedRevision: published.revision, status: "proposed" },
        102,
      ),
    ).toThrow("canonical page");
  });
  it("treats interpretation and organization as independent revision/policy coverage", () => {
    source("old", "2020-01-01T00:00:00Z");
    source("new", "2026-01-01T00:00:00Z");
    const list = (phase: "interpretation" | "organization") =>
      listKnowledgeDiscoveryBacklog(db, { phase, limit: 20, now: 20 }).map((row) => row.id);
    recordKnowledgeCoverage(
      db,
      {
        subjectId: "new",
        inputRevision: "v1",
        phase: "interpretation",
        policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
        status: "considered",
      },
      2,
    );
    expect(list("interpretation")).toEqual(["old"]);
    expect(list("organization")).toEqual(["new", "old"]);
    db.prepare("UPDATE documents SET content_hash='v2' WHERE id='new'").run();
    expect(list("interpretation")).toEqual(["new", "old"]);
    expect(() =>
      recordKnowledgeCoverage(
        db,
        {
          subjectId: "new",
          inputRevision: "v1",
          phase: "organization",
          policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
          status: "considered",
        },
        3,
      ),
    ).toThrow("changed");
  });
  it("admits late historical sources while excluding derived mirrors", () => {
    source("recent", "2026-01-01T00:00:00Z");
    source("mirror", "2026-02-01T00:00:00Z", KNOWLEDGE_SOURCE_ID);
    recordKnowledgeCoverage(
      db,
      {
        subjectId: "recent",
        inputRevision: "v1",
        phase: "organization",
        policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
        status: "considered",
      },
      2,
    );
    source("late", "2019-01-01T00:00:00Z");
    expect(
      listKnowledgeDiscoveryBacklog(db, { phase: "organization", limit: 20, now: 20 }).map(
        (row) => row.id,
      ),
    ).toEqual(["late"]);
  });
  it("requires actual wiki provenance and atomically claims a reconciled candidate", () => {
    source("evidence", "2026-01-01T00:00:00Z");
    source("unrelated", "2026-01-02T00:00:00Z");
    candidate();
    expect(() =>
      publishKnowledgeCandidate(
        db,
        {
          candidateId: "candidate-workshop",
          expectedCandidateRevision: 1,
          node: {
            ...node,
            markdown: '<claim id="x" refs="source:unrelated">An unrelated source</claim>',
            inputVersions: { "source:unrelated": "v1" },
          },
        },
        2,
      ),
    ).toThrow("declared evidence");
    expect(getKnowledgeNode(db, node.id)).toBeNull();
    expect(getKnowledgeCandidate(db, "candidate-workshop")?.status).toBe("proposed");
    publishKnowledgeCandidate(
      db,
      { candidateId: "candidate-workshop", expectedCandidateRevision: 1, node },
      3,
    );
    expect(getKnowledgeCandidate(db, "candidate-workshop")?.nodeId).toBe(node.id);
    expect(() =>
      publishKnowledgeCandidate(
        db,
        {
          candidateId: "candidate-workshop",
          expectedCandidateRevision: 1,
          node: { ...node, id: "orphan" },
        },
        4,
      ),
    ).toThrow("changed");
    expect(getKnowledgeNode(db, "orphan")).toBeNull();
  });
  it("reuses exact reconciled identity without making a second proposed page", () => {
    source("evidence", "2026-01-01T00:00:00Z");
    const first = candidate();
    const second = proposeKnowledgeCandidate(
      db,
      {
        id: "second-proposal",
        identityKey: "project:workshop",
        title: "Renamed workshop",
        scope: "Same project",
        evidenceVersions: { evidence: "v1" },
      },
      3,
    );
    expect(second.id).toBe(first.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_candidates").get()).toEqual({
      count: 1,
    });
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listOrganizationAdmissions, admitKnowledgeOrganization } from "./organization.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import {
  recordKnowledgeCoverage,
  KNOWLEDGE_DISCOVERY_POLICY,
  listKnowledgeDiscoveryBacklog,
} from "./discovery.js";
import {
  reconsiderPublishedRetrieval,
  readRetrievalReconsiderationStatus,
} from "./retrieval-reconsideration.js";

let db: Database.Database;
const boundary = "2027-01-04T10:00:00.000Z";
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,content_hash TEXT,title TEXT,source_created_at TEXT,source_updated_at TEXT); INSERT INTO documents VALUES('source','fictional','v1','Workshop','2027-01-04','2027-01-04')",
  );
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());
function cover(status: "considered" | "gated" = "considered", revision = "v1") {
  recordKnowledgeCoverage(
    db,
    {
      subjectId: "source",
      inputRevision: revision,
      phase: "organization",
      policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
      status,
      retrievalBoundary: boundary,
    },
    1,
  );
}

it("preserves considered facts and schedules one reconsideration only after publication reaches the observed boundary", () => {
  cover();
  expect(readRetrievalReconsiderationStatus(db)).toEqual({
    awaitingPublication: 1,
    reconsiderationDue: 0,
  });
  expect(
    reconsiderPublishedRetrieval(db, { publishedThrough: "2027-01-04T09:00:00.000Z", limit: 5 }, 2),
  ).toBe(0);
  expect(listKnowledgeDiscoveryBacklog(db, { phase: "organization", limit: 5, now: 2 })).toEqual(
    [],
  );
  expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 5 }, 3)).toBe(1);
  expect(readRetrievalReconsiderationStatus(db)).toEqual({
    awaitingPublication: 0,
    reconsiderationDue: 1,
  });
  expect(
    listKnowledgeDiscoveryBacklog(db, { phase: "organization", limit: 5, now: 3 }),
  ).toHaveLength(0); // Catch-up uses the review lane, not historical admission budget.
  const admissions = listOrganizationAdmissions(db, { now: 3, limit: 5, retryMs: 100 });
  expect(admissions).toHaveLength(1);
  expect(
    admitKnowledgeOrganization(
      db,
      { admission: admissions[0]!, workPrefix: "catchup", retryAt: 103 },
      3,
    ),
  ).toBe(true);
  expect(db.prepare("SELECT reason FROM knowledge_work").all()).toEqual([{ reason: "review" }]);
  expect(listOrganizationAdmissions(db, { now: 103, limit: 5, retryMs: 100 })).toEqual([]);
  expect(
    admitKnowledgeOrganization(
      db,
      { admission: admissions[0]!, workPrefix: "again", retryAt: 103 },
      3,
    ),
  ).toBe(false);
  // A restart/migration and another incomplete search do not arm an endless paid loop.
  createKnowledgeWorkTables(db);
  cover();
  expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 5 }, 4)).toBe(0);
  expect(listKnowledgeDiscoveryBacklog(db, { phase: "organization", limit: 5, now: 4 })).toEqual(
    [],
  );
});

it("leaves cheap gate skips alone and gives a changed source revision its own allowance", () => {
  cover("gated");
  expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 5 }, 2)).toBe(0);
  db.exec("UPDATE documents SET content_hash='v2'");
  cover("considered", "v2");
  expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 5 }, 3)).toBe(1);
});

it("does not resurrect deleted or superseded source revisions", () => {
  cover();
  db.exec("DELETE FROM documents");
  expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 5 }, 2)).toBe(0);
});

it("bounds the release batch and preserves remaining obligations", () => {
  cover();
  db.exec(
    "INSERT INTO documents VALUES('second','fictional','v1','Workshop materials','2027-01-04','2027-01-04')",
  );
  recordKnowledgeCoverage(
    db,
    {
      subjectId: "second",
      inputRevision: "v1",
      phase: "organization",
      policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
      status: "considered",
      retrievalBoundary: boundary,
    },
    1,
  );
  expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 1 }, 2)).toBe(1);
  expect(readRetrievalReconsiderationStatus(db)).toEqual({
    awaitingPublication: 1,
    reconsiderationDue: 1,
  });
  expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 1 }, 3)).toBe(1);
  expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 1 }, 4)).toBe(0);
});

it("excludes removed sources before the bounded release window and health counts", () => {
  cover();
  db.exec(
    "CREATE TABLE removed_sources(id TEXT PRIMARY KEY); INSERT INTO removed_sources VALUES('fictional')",
  );
  expect(reconsiderPublishedRetrieval(db, { publishedThrough: boundary, limit: 1 }, 2)).toBe(0);
  expect(readRetrievalReconsiderationStatus(db)).toEqual({
    awaitingPublication: 0,
    reconsiderationDue: 0,
  });
});

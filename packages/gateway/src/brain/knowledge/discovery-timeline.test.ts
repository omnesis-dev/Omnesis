// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { COGNITION_AUTHORED_SOURCES } from "../cognition-authored.js";
import { createKnowledgeTables } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { knowledgeDiscoveryByMonth } from "./discovery-timeline.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,content TEXT,content_hash TEXT,source_created_at TEXT,metadata TEXT); CREATE TABLE removed_sources(id TEXT PRIMARY KEY)",
  );
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());
function source(
  id: string,
  date: string | null = "2025-06-15T10:00:00Z",
  sourceId = "fixture",
  type = "text",
) {
  db.prepare("INSERT INTO documents VALUES(?,?,?,'content','v2',?,?)").run(
    id,
    sourceId,
    id,
    date,
    JSON.stringify({ documentType: type }),
  );
}
function coverage(
  id: string,
  phase: string,
  status: string,
  revision = "v2",
  policy = KNOWLEDGE_DISCOVERY_POLICY,
) {
  db.prepare(
    "INSERT INTO knowledge_discovery_coverage(subject_id,input_revision,phase,policy_version,status,reviewed_at) VALUES(?,?,?,?,?,1)",
  ).run(id, revision, phase, policy, status);
}
it("counts both phases exhaustively by current content generation and policy, retaining undated input", () => {
  for (const id of ["one", "two", "three", "old", "policy"]) source(id);
  source("undated", null);
  coverage("one", "interpretation", "considered");
  coverage("one", "organization", "deferred");
  coverage("two", "interpretation", "gated");
  coverage("two", "organization", "failed");
  coverage("three", "organization", "considered");
  coverage("old", "interpretation", "considered", "v1");
  coverage("policy", "interpretation", "considered", "v2", "older-policy");
  expect(knowledgeDiscoveryByMonth(db)).toEqual([
    {
      month: "2025-06",
      interpretation: { considered: 1, gated: 1, deferred: 0, failed: 0, pending: 3 },
      organization: { considered: 1, gated: 0, deferred: 1, failed: 1, pending: 2 },
    },
    {
      month: null,
      interpretation: { considered: 0, gated: 0, deferred: 0, failed: 0, pending: 1 },
      organization: { considered: 0, gated: 0, deferred: 0, failed: 0, pending: 1 },
    },
  ]);
});
it("excludes unreadable/deleted source generations and cognition-authored sources or projection types", () => {
  source("visible");
  source("deleted");
  source("removed", null, "withdrawn");
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('deleted','v2',1,1)",
  ).run();
  db.prepare("INSERT INTO removed_sources VALUES('withdrawn')").run();
  for (const [index, entry] of COGNITION_AUTHORED_SOURCES.entries()) {
    source(`authored-${index}`, null, entry.sourceId);
    for (const type of entry.exclusiveDocumentTypes) source(`type-${type}`, null, "fixture", type);
  }
  const months = knowledgeDiscoveryByMonth(db);
  expect(months).toHaveLength(1);
  expect(months[0]!.interpretation.pending).toBe(1);
  db.prepare("DELETE FROM documents WHERE id='visible'").run();
  expect(knowledgeDiscoveryByMonth(db)).toEqual([]);
});

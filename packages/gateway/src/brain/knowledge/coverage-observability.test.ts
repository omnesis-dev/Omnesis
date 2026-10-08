// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it } from "vitest";
import { createBriefsStorageTables } from "../storage/schema.js";
import { listCognitionCoverage } from "../storage/coverage.js";
import { installMutableListRevisions, mutableListRevision } from "../../data/list-revisions.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { enqueueKnowledgeWork } from "./work.js";
import { recordKnowledgeCoverage, KNOWLEDGE_DISCOVERY_POLICY } from "./discovery.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,content_hash TEXT,content TEXT)",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  installMutableListRevisions(db);
});
afterEach(() => db.close());

it("projects distinct source revisions and separate organizational outcomes across repeated phases", () => {
  for (const id of ["a", "b"]) {
    db.prepare("INSERT INTO documents VALUES(?,'fictional:archive','v1','A workshop note.')").run(
      id,
    );
    enqueueKnowledgeWork(
      db,
      {
        id,
        subjectId: id,
        subjectKind: "source",
        reason: "change",
        inputRevision: "v1",
        tier: "routine",
        dueAt: 10,
      },
      1,
    );
  }
  const coverage = {
    subjectId: "a",
    inputRevision: "v1",
    phase: "interpretation" as const,
    policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
    status: "considered" as const,
  };
  recordKnowledgeCoverage(db, coverage, 2);
  expect(listCognitionCoverage(db)[0]).toMatchObject({
    eligible: 2,
    processed: 0,
    skipped: 0,
    status: "in-progress",
  });
  const before = mutableListRevision(db, "cognition-coverage");
  recordKnowledgeCoverage(db, { ...coverage, phase: "organization" }, 3);
  recordKnowledgeCoverage(db, { ...coverage, phase: "organization" }, 4);
  recordKnowledgeCoverage(
    db,
    { ...coverage, subjectId: "b", phase: "organization", status: "gated" },
    5,
  );
  expect(mutableListRevision(db, "cognition-coverage")).toBeGreaterThan(before);
  expect(listCognitionCoverage(db)[0]).toMatchObject({
    sourceId: "fictional:archive",
    workflowId: "knowledge-maintenance",
    eligible: 2,
    processed: 1,
    skipped: 1,
    status: "settled",
    unit: "source-revisions",
    promptTokens: null,
    completionTokens: null,
    costAttribution: "shared-run-ledger",
  });
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='a'").run();
  enqueueKnowledgeWork(
    db,
    {
      id: "a-new",
      subjectId: "a",
      subjectKind: "source",
      reason: "change",
      inputRevision: "v2",
      tier: "routine",
      dueAt: 10,
    },
    6,
  );
  expect(listCognitionCoverage(db)[0]).toMatchObject({
    eligible: 3,
    processed: 1,
    skipped: 1,
    status: "in-progress",
  });
});

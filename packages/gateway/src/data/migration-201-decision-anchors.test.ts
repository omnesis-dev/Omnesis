// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { relaxDecisionAnchors } from "./migration-201-decision-anchors.js";

let db: Database.Database;

/** The ledger as it stood before migration 201. */
const LEGACY_DDL = `
  CREATE TABLE documents (id TEXT PRIMARY KEY);
  CREATE TABLE cognition_decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    subject_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL, lane TEXT NOT NULL, rubric_version TEXT NOT NULL,
    content_hash TEXT, requested_model_id TEXT NOT NULL, model_id TEXT, score REAL,
    threshold REAL NOT NULL, verdict TEXT NOT NULL, error TEXT, reused_from TEXT,
    record_id TEXT, enforced INTEGER NOT NULL DEFAULT 1, latency_ms INTEGER,
    input_tokens INTEGER, created_at INTEGER NOT NULL, request_json TEXT, response_json TEXT
  );
  CREATE TABLE knowledge_decision_inputs (decision_id TEXT PRIMARY KEY, source_id TEXT, input_revision TEXT,
    request_json TEXT, response_json TEXT, availability TEXT NOT NULL, created_at INTEGER NOT NULL, error_json TEXT);
`;

const notNull = (column: string) =>
  db
    .prepare<
      [string],
      { notnull: number }
    >("SELECT \"notnull\" FROM pragma_table_info('cognition_decisions') WHERE name=?")
    .get(column)!.notnull;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(LEGACY_DDL);
  db.exec(`INSERT INTO documents VALUES ('doc_mail');
    INSERT INTO cognition_decisions VALUES ('dec_old','run_old','doc_mail','doc_mail','worth-gate','live',
      'email-worth-v1','h','jev','jev',2.1,1.08,'pass',NULL,NULL,NULL,1,40,90,1000,'{"state":{}}','{"answers":{}}')`);
});
afterEach(() => db.close());

it("lets a decision name no run and no document, keeping every row", () => {
  db.transaction(() => relaxDecisionAnchors(db))();
  expect([notNull("run_id"), notNull("document_id"), notNull("subject_document_id")]).toEqual([
    0, 0, 0,
  ]);
  expect(db.prepare("SELECT * FROM cognition_decisions").all()).toEqual([
    expect.objectContaining({
      id: "dec_old",
      run_id: "run_old",
      score: 2.1,
      request_json: '{"state":{}}',
    }),
  ]);
  db.prepare(
    `INSERT INTO cognition_decisions (id, run_id, document_id, subject_document_id, purpose, lane,
      rubric_version, requested_model_id, threshold, verdict, created_at)
     VALUES ('dec_new', NULL, NULL, NULL, 'find-route', 'direct', 'find-route-v1', 'jev', 0, 'pass', 2000)`,
  ).run();
  expect(db.prepare("SELECT COUNT(*) AS n FROM cognition_decisions").get()).toEqual({ n: 2 });
});

it("keeps documents cascading, its indexes and its payload erasure", () => {
  db.transaction(() => relaxDecisionAnchors(db))();
  const indexes = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_index_list('cognition_decisions')")
    .all()
    .map((row) => row.name);
  expect(indexes).toEqual(
    expect.arrayContaining(["idx_cognition_decisions_run", "idx_cognition_decisions_record"]),
  );
  db.prepare(
    "INSERT INTO knowledge_decision_inputs VALUES ('dec_old',NULL,NULL,'{}',NULL,'available',1,NULL)",
  ).run();
  db.prepare("DELETE FROM documents WHERE id='doc_mail'").run();
  expect(db.prepare("SELECT COUNT(*) AS n FROM cognition_decisions").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_decision_inputs").get()).toEqual({ n: 0 });
});

it("is a no-op once the anchors are nullable", () => {
  db.transaction(() => relaxDecisionAnchors(db))();
  db.prepare(
    "INSERT INTO cognition_decisions (id, purpose, lane, rubric_version, requested_model_id, threshold, verdict, created_at) VALUES ('dec_x','find-route','direct','v','jev',0,'pass',1)",
  ).run();
  db.transaction(() => relaxDecisionAnchors(db))();
  expect(db.prepare("SELECT COUNT(*) AS n FROM cognition_decisions").get()).toEqual({ n: 2 });
});

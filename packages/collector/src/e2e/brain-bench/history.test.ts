// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, expect, it, test } from "vitest";
import { checkpointInitialInventory, historicalAdmissions, seedHistory } from "./history.js";
import type { BrainBench } from "./bench.js";

const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  for (const table of [
    "documents",
    "knowledge_work",
    "knowledge_batches",
    "knowledge_nodes",
    "knowledge_discovery_coverage",
    "knowledge_candidates",
    "cognition_runs",
    "knowledge_cascade_jobs",
    "knowledge_evidence",
    "knowledge_source_revisions",
    "source_inventory_documents",
    "source_inventories",
  ])
    db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY)`);
  db.exec(`CREATE TABLE knowledge_changes(seq INTEGER PRIMARY KEY,kind TEXT);
    CREATE TABLE knowledge_checkpoints(id TEXT PRIMARY KEY,value_json TEXT,revision INTEGER,updated_at INTEGER);
    INSERT INTO documents VALUES('initial');
    INSERT INTO knowledge_changes VALUES(10,'source_changed'),(12,'source_changed');
    INSERT INTO knowledge_cascade_jobs VALUES('pending');
    INSERT INTO knowledge_evidence VALUES('grounding');
    INSERT INTO knowledge_source_revisions VALUES('initial');
    INSERT INTO source_inventory_documents VALUES('initial');
    INSERT INTO source_inventories VALUES('import');`);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

test("historical observations preserve admission order when a frozen clock ties random work IDs", () => {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE knowledge_work(id TEXT PRIMARY KEY,subject_id TEXT,input_revision TEXT,status TEXT,created_at INTEGER,reason TEXT);
    INSERT INTO knowledge_work VALUES('kw_ffffffff-ffff-4fff-8fff-ffffffffffff','newest','v1','completed',100,'discovery');
    INSERT INTO knowledge_work VALUES('kw_00000000-0000-4000-8000-000000000000','older','v1','completed',100,'discovery');
    INSERT INTO knowledge_work VALUES('kw_middle','previous-day','v1','completed',99,'discovery');`);
  const bench = { sql: db } as BrainBench;
  expect(historicalAdmissions(bench).map((row) => row.subject_id)).toEqual([
    "previous-day",
    "newest",
    "older",
  ]);
});

it("records an explicit inventory boundary without changing evidence or pending cleanup", () => {
  const db = fixture();
  const report = checkpointInitialInventory(db);
  expect(report).toEqual({ documentCount: 1, sourceChangeCount: 2, sourceChangeHighWater: 12 });
  expect(db.prepare("SELECT * FROM knowledge_changes").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM source_inventory_documents").all()).toEqual([]);
  expect(db.prepare("SELECT * FROM source_inventories").all()).toEqual([]);
  for (const table of [
    "documents",
    "knowledge_cascade_jobs",
    "knowledge_evidence",
    "knowledge_source_revisions",
  ])
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
  expect(db.prepare("SELECT * FROM knowledge_discovery_coverage").all()).toEqual([]);
  expect(db.prepare("SELECT value_json FROM knowledge_checkpoints").get()).toEqual({
    value_json: JSON.stringify(report),
  });
  db.exec("INSERT INTO knowledge_changes VALUES(13,'source_changed')");
  expect(() => checkpointInitialInventory(db)).toThrow();
  expect(db.prepare("SELECT seq FROM knowledge_changes").all()).toEqual([{ seq: 13 }]);
});

it.each([
  "knowledge_work",
  "knowledge_batches",
  "knowledge_nodes",
  "knowledge_discovery_coverage",
  "knowledge_candidates",
  "cognition_runs",
])("refuses to discard a brain with existing %s state", (table) => {
  const db = fixture();
  db.prepare(`INSERT INTO ${table} VALUES('started')`).run();
  expect(() => checkpointInitialInventory(db)).toThrow("untouched brain");
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_changes").get()).toEqual({ count: 2 });
  expect(db.prepare("SELECT COUNT(*) AS count FROM source_inventories").get()).toEqual({
    count: 1,
  });
});

it("refuses non-arrival events without partially clearing the journal", () => {
  const db = fixture();
  db.exec("INSERT INTO knowledge_changes VALUES(13,'source_deleted')");
  expect(() => checkpointInitialInventory(db)).toThrow("other than source arrivals");
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_changes").get()).toEqual({ count: 3 });
});

test("persisted history fixture removes only its own arrival journal and keeps real evidence", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY, provider_id TEXT, source_id TEXT,
      external_id TEXT, title TEXT, content TEXT, content_hash TEXT, metadata TEXT,
      source_created_at TEXT, source_updated_at TEXT, ingested_at TEXT, updated_at TEXT,
      links_extracted_at TEXT, people_resolved_at TEXT, dates_extracted_at TEXT);
      CREATE TABLE knowledge_changes(kind TEXT, entity_id TEXT);
      CREATE TRIGGER arrivals AFTER INSERT ON documents BEGIN
        INSERT INTO knowledge_changes VALUES('source_changed',NEW.id); END;
      INSERT INTO knowledge_changes VALUES('source_changed','live-unacknowledged');
      INSERT INTO knowledge_changes VALUES('node_changed','owner-unacknowledged');`);
    seedHistory(
      { withWriteHandle: (fn) => fn(db) },
      {
        id: "archive-fixture",
        sourceId: "synthetic:archive@example.com",
        title: "Archived workshop",
        content: "The workshop was planned for Friday.",
        at: 1_700_000_000_000,
      },
    );
    expect(db.prepare("SELECT * FROM knowledge_changes ORDER BY entity_id").all()).toEqual([
      { kind: "source_changed", entity_id: "live-unacknowledged" },
      { kind: "node_changed", entity_id: "owner-unacknowledged" },
    ]);
    expect(
      db
        .prepare("SELECT content,content_hash,source_created_at FROM documents WHERE id=?")
        .get("archive-fixture"),
    ).toEqual({
      content: "The workshop was planned for Friday.",
      content_hash: createHash("sha256")
        .update("The workshop was planned for Friday.")
        .digest("hex"),
      source_created_at: new Date(1_700_000_000_000).toISOString(),
    });
  } finally {
    db.close();
  }
});

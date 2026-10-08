// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { readMaintenanceProgress } from "./maintenance-progress.js";

const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE knowledge_work(id TEXT,input_revision TEXT,generation INTEGER,status TEXT,tier TEXT,
      last_error TEXT,due_at INTEGER,updated_at INTEGER);
    CREATE TABLE knowledge_changes(seq INTEGER,kind TEXT,entity_id TEXT,revision TEXT);
    CREATE TABLE knowledge_owner_changes(seq INTEGER,kind TEXT,owner_id TEXT,operation TEXT,changed_at INTEGER);
    CREATE TABLE knowledge_cascade_jobs(id INTEGER,kind TEXT,target_kind TEXT,target_id TEXT,revision TEXT);
    CREATE TABLE knowledge_projection_cleanup(document_id TEXT,node_id TEXT);
    CREATE TABLE knowledge_cascade_frontier(job_id INTEGER,target_kind TEXT,target_id TEXT,after_node_id TEXT,done INTEGER);
    CREATE TABLE knowledge_batches(id TEXT,status TEXT,revision INTEGER);
  `);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

test("journal intake advances progress even when the total pending count remains one", () => {
  const db = fixture();
  db.exec("INSERT INTO knowledge_changes VALUES(1,'source_changed','source','revision-a')");
  const before = readMaintenanceProgress(db, 100);
  db.exec(`DELETE FROM knowledge_changes;
    INSERT INTO knowledge_work VALUES('work','revision-a',1,'pending','soon',NULL,10,10)`);
  const after = readMaintenanceProgress(db, 100);
  expect(before.pending).toBe(1);
  expect(after.pending).toBe(1);
  expect(after.signature).not.toBe(before.signature);
});

test("stable pending work and no-op timestamps cannot reset a stall timer", () => {
  const db = fixture();
  db.exec(`INSERT INTO knowledge_work VALUES('work','revision-a',1,'pending','soon',NULL,10,10);
    INSERT INTO knowledge_owner_changes VALUES(1,'loop','loop','update',10)`);
  const before = readMaintenanceProgress(db, 100);
  db.exec(`UPDATE knowledge_work SET updated_at=99;
    UPDATE knowledge_owner_changes SET seq=2,changed_at=99`);
  expect(readMaintenanceProgress(db, 200)).toEqual(before);
});

test("new input generations and bounded cascade cursor movement are durable progress", () => {
  const db = fixture();
  db.exec(`INSERT INTO knowledge_work VALUES('work','revision-a',1,'pending','soon',NULL,10,10);
    INSERT INTO knowledge_cascade_jobs VALUES(1,'invalidate','source','source','revision-a');
    INSERT INTO knowledge_cascade_frontier VALUES(1,'source','source','',0)`);
  const before = readMaintenanceProgress(db, 100);
  db.exec("UPDATE knowledge_work SET generation=2,input_revision='revision-b'");
  const revised = readMaintenanceProgress(db, 100);
  expect(revised.pending).toBe(before.pending);
  expect(revised.signature).not.toBe(before.signature);
  db.exec("UPDATE knowledge_cascade_frontier SET after_node_id='node-1'");
  const advanced = readMaintenanceProgress(db, 100);
  expect(advanced.pending).toBe(revised.pending);
  expect(advanced.signature).not.toBe(revised.signature);
});

test("future work stays outside the unchanged quiet horizon", () => {
  const db = fixture();
  const before = readMaintenanceProgress(db, 100);
  db.exec(
    "INSERT INTO knowledge_work VALUES('later','revision-a',1,'pending','routine',NULL,101,10)",
  );
  expect(readMaintenanceProgress(db, 100)).toEqual(before);
  expect(readMaintenanceProgress(db, 101).pending).toBe(1);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createKnowledgeTables } from "./storage.js";
import { isKnowledgeNodeReadable, knowledgeNodeFence } from "./storage-fence.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,content_hash TEXT)");
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  db.exec("PRAGMA foreign_keys=OFF");
  const node = db.prepare(
    `INSERT INTO knowledge_nodes(id,kind,owner_id,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at)
     VALUES(?,?,?,?,'','',1,1,'h',?,'{}','{}',1,1)`,
  );
  node.run("page", "wiki", null, "Page", "current");
  node.run("stale_page", "wiki", null, "Stale page", "stale");
  node.run("tombstoned", "wiki", null, "Tombstoned", "current");
  node.run("purging", "wiki", null, "Purging", "current");
  node.run("obs_live", "observation", "obs_live", "Live", "current");
  node.run("obs_orphan", "observation", "obs_orphan", "Orphan", "current");
  node.run("loop_live", "loop", "loop_live", "Live loop", "current");
  db.exec(`
    INSERT INTO knowledge_node_tombstones VALUES('tombstoned',1),('loop_gone',1);
    INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','node','purging','1',1);
    INSERT INTO observation_related_loops VALUES('obs_live','loop_live'),('obs_orphan','loop_gone');
  `);
});
afterEach(() => db.close());

it("judges readability exactly as the full fence's hidden verdict", () => {
  const verdicts = Object.fromEntries(
    ["page", "stale_page", "tombstoned", "purging", "obs_live", "obs_orphan", "missing"].map(
      (id) => [id, isKnowledgeNodeReadable(db, id)],
    ),
  );
  expect(verdicts).toEqual({
    page: true,
    stale_page: true,
    tombstoned: false,
    purging: false,
    obs_live: true,
    // An observation attached to a deleted loop is hidden with it.
    obs_orphan: false,
    missing: false,
  });
  for (const [id, readable] of Object.entries(verdicts))
    expect(knowledgeNodeFence(db, id).hidden).toBe(!readable);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createOpenLoop, getOpenLoop } from "../brain/storage/open-loops.js";
import { createDocAnnotation, getDocAnnotation } from "../brain/storage/annotations.js";
import { convertKnowledgeOwner } from "../brain/knowledge/owner-adapters.js";
import {
  advanceKnowledgeCascade,
  getKnowledgeClaims,
  getKnowledgeNode,
  saveKnowledgeNode,
} from "../brain/knowledge/storage.js";
import { runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";

let directory: string;
let path: string;
let db: Database.Database;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-knowledge-migration-"));
  path = join(directory, "store.db");
  db = new Database(path);
  runSchemaSetup(db);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});
function reopen() {
  db.close();
  db = new Database(path);
  db.pragma("foreign_keys=ON");
}
function seedDocument() {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES('evidence','fixture','fixture-notes','workshop','Workshop','Workshop Friday.','v1','2025-01-01','2025-01-01','2025-01-01','2025-01-01')`,
  ).run();
}
function removeKnowledgeSchema() {
  db.pragma("foreign_keys=OFF");
  for (const type of ["trigger", "table"] as const) {
    const names = db
      .prepare<
        [string],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type=? AND name GLOB 'knowledge_*'")
      .all(type);
    for (const { name } of names)
      db.exec(`DROP ${type.toUpperCase()} "${name.replaceAll('"', '""')}"`);
  }
  db.exec("DELETE FROM schema_migrations WHERE version>=193; PRAGMA user_version=192");
  db.pragma("foreign_keys=ON");
}
it("fresh setup creates durable knowledge tables and source intake triggers idempotently", () => {
  runSchemaSetup(db);
  seedDocument();
  expect(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_candidate_sources'",
      )
      .get(),
  ).toBeDefined();
  expect(
    db.prepare("SELECT entity_id FROM knowledge_changes WHERE kind='source_changed'").get(),
  ).toEqual({ entity_id: "evidence" });
  reopen();
  expect(
    db
      .prepare("SELECT content_hash FROM knowledge_source_revisions WHERE document_id='evidence'")
      .get(),
  ).toEqual({ content_hash: "v1" });
  expect(db.pragma("foreign_key_check")).toEqual([]);
});
it("upgrades a populated schema 192 file without rewriting legacy owners, then invalidates durable synthesis after restart", () => {
  removeKnowledgeSchema();
  seedDocument();
  createOpenLoop(
    db,
    {
      id: "closed-task",
      createdByRun: "fixture-run",
      title: "Prepare workshop",
      description: "Workshop Friday.",
      state: "done",
      confidence: 0.7,
      importance: 0.5,
      docs: ["evidence"],
    },
    1,
  );
  createDocAnnotation(
    db,
    {
      id: "observation",
      docId: "evidence",
      claimType: "schedule",
      claimText: "Workshop Friday.",
      evidenceDocId: "evidence",
      evidenceQuote: "Workshop Friday.",
      confidence: 0.7,
      claimBasis: "quoted",
      createdByRun: "fixture-run",
    },
    1,
  );
  const beforeLoop = getOpenLoop(db, "closed-task");
  const beforeAnnotation = getDocAnnotation(db, "observation");
  reopen();
  runMigrations(db);
  expect(db.pragma("user_version", { simple: true })).toBe(193);
  expect(getOpenLoop(db, "closed-task")).toEqual(beforeLoop);
  expect(getDocAnnotation(db, "observation")).toEqual(beforeAnnotation);
  convertKnowledgeOwner(db, "loop", "closed-task", 2);
  convertKnowledgeOwner(db, "doc_annotation", "observation", 2);
  expect(getKnowledgeNode(db, "closed-task")?.canonicalFields.state).toBe("done");
  expect(getKnowledgeClaims(db, "observation")[0]?.verification).toBe("unverified");
  saveKnowledgeNode(
    db,
    {
      id: "project",
      kind: "wiki",
      title: "Workshop",
      markdown: '<claim id="date" refs="source:evidence">Workshop Friday.</claim>',
      expectedRevision: 0,
      inputVersions: { "source:evidence": "v1" },
    },
    3,
  );
  reopen();
  db.prepare(
    "UPDATE documents SET content='Workshop Saturday.',content_hash='v2' WHERE id='evidence'",
  ).run();
  expect(getKnowledgeNode(db, "project")?.validity).toBe("stale");
  reopen();
  while (advanceKnowledgeCascade(db, 10, 4).pending) {
    /* bounded durable queue drain */
  }
  expect(getKnowledgeNode(db, "project")?.validity).toBe("stale");
  expect(getOpenLoop(db, "closed-task")?.state).toBe("done");
  expect(getKnowledgeClaims(db, "observation")[0]?.verification).toBe("unverified");
  runMigrations(db);
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=193").get(),
  ).toEqual({ count: 1 });
  expect(db.pragma("foreign_key_check")).toEqual([]);
});

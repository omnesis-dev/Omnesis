// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 197: briefs become observations.
 *
 * The fixture opens a database at head, then restores the shape an install at
 * v196 holds — the brief tables, and a `knowledge_nodes` whose kind constraint
 * names briefs — and plants brief rows, brief knowledge nodes with claims,
 * brief owner bookkeeping, brief consumption edges, a pending brief feedback
 * run and a queued brief notification next to rows of other kinds. Upgrading
 * must remove every brief artefact, keep everything else, leave a
 * `knowledge_nodes` that accepts observations with clean foreign keys, and be
 * a no-op when it runs again.
 *
 * All fixture data is invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { saveKnowledgeNode } from "../brain/knowledge/storage.js";
import { createDatabase } from "../db.js";
import { createLegacyBriefClaimsTables, createLegacyBriefTables } from "./legacy-brief-tables.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import type { KnowledgeNodeKind } from "../brain/knowledge/types.js";

const NOW = Date.parse("2026-09-01T09:00:00.000Z");

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-migration-197-"));
  path = join(directory, "store.db");
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function open(): Database.Database {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  return db;
}

function tableNames(db: Database.Database, names: readonly string[]): string[] {
  return db
    .prepare<string[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${names.map(() => "?").join(",")}) ORDER BY name`,
    )
    .all(...names)
    .map((row) => row.name);
}

/** Rebuild `knowledge_nodes` with the v196 kind constraint, which names briefs. */
function restoreBriefKindConstraint(db: Database.Database): void {
  const current = db
    .prepare<
      [],
      { sql: string }
    >("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'")
    .get()!;
  const dependents = db
    .prepare<[], { sql: string }>(
      "SELECT sql FROM sqlite_master WHERE tbl_name='knowledge_nodes' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all()
    .map((row) => row.sql);
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  db.exec("BEGIN");
  db.exec("ALTER TABLE knowledge_nodes RENAME TO knowledge_nodes_head");
  db.exec(current.sql.replace("'observation'", "'brief'"));
  db.exec("INSERT INTO knowledge_nodes SELECT * FROM knowledge_nodes_head");
  db.exec("DROP TABLE knowledge_nodes_head");
  for (const sql of dependents) db.exec(sql);
  db.exec("COMMIT");
  db.pragma("legacy_alter_table = OFF");
  db.pragma("foreign_keys = ON");
}

function saveNode(db: Database.Database, id: string, kind: string, ownerId: string): void {
  saveKnowledgeNode(
    db,
    {
      id,
      kind: kind as KnowledgeNodeKind,
      ownerId,
      title: `Node ${id}`,
      markdown: '<claim id="c1" refs="source:evidence">The workshop moved to Friday.</claim>',
      expectedRevision: 0,
      inputVersions: { "source:evidence": "v1" },
    },
    NOW,
  );
}

/** A database at v196 holding brief artefacts beside rows of other kinds. */
function seedV196(): void {
  createDatabase(path).close();
  const db = open();
  try {
    createLegacyBriefTables(db);
    createLegacyBriefClaimsTables(db);
    restoreBriefKindConstraint(db);
    db.prepare(
      `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
       VALUES('evidence','fixture','fixture-notes','workshop','Workshop','The workshop moved to Friday.','v1','2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO briefs (id, created_by_run, kind, title, confidence, urgency, created_at, updated_at)
       VALUES ('brief_1', 'run_seed', 'update', 'Workshop moved', 0.8, 0.5, ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO brief_citations (brief_id, position, doc_id) VALUES ('brief_1', 0, 'evidence')",
    ).run();
    db.prepare(
      `INSERT INTO open_loops (id, created_by_run, confidence, importance, title, created_at, last_update)
       VALUES ('loop_1', 'run_seed', 0.8, 0.6, 'Confirm the workshop room', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      "INSERT INTO brief_related_loops (brief_id, loop_id) VALUES ('brief_1', 'loop_1')",
    ).run();
    saveNode(db, "brief-node", "brief", "brief_1");
    saveNode(db, "loop-node", "loop", "loop_1");
    db.prepare(
      `INSERT OR REPLACE INTO knowledge_owner_changes (kind, owner_id, operation, changed_at)
       VALUES ('brief', 'brief_1', 'upsert', ?)`,
    ).run(NOW);
    db.prepare(
      "INSERT OR IGNORE INTO knowledge_owner_write_guard (kind, owner_id) VALUES ('brief', 'brief_1')",
    ).run();
    db.prepare(
      `INSERT INTO cognition_consumption_edges (prior_store, prior_annotation_id, dependent_kind, dependent_id, run_id, created_at)
       VALUES ('doc', 'anno_1', 'brief', 'brief_1', 'run_seed', ?),
              ('doc', 'anno_1', 'loop', 'loop_1', 'run_seed', ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `INSERT INTO cognition_runs (id, kind, status, payload_json, next_attempt_at, enqueued_at)
       VALUES ('run_brief_feedback', 'feedback', 'pending', '{"briefId":"brief_1"}', ?, ?),
              ('run_loop_feedback', 'feedback', 'pending', '{"recheckDependentKind":"loop","recheckDependentId":"loop_1","recheckGeneration":"g1"}', ?, ?)`,
    ).run(NOW, NOW, NOW, NOW);
    db.prepare(
      `INSERT INTO notifications (id, kind, target_id, title, body, collapse_id, created_at, expires_at)
       VALUES ('note_brief', 'brief', 'brief_1', 'Workshop moved', 'Friday now.', 'brief:brief_1', ?, ?),
              ('note_conversation', 'conversation', 'conv_1', 'New reply', 'Ready.', 'conversation:conv_1', ?, ?)`,
    ).run(NOW, NOW + 86_400_000, NOW, NOW + 86_400_000);
    db.exec("DELETE FROM schema_migrations WHERE version >= 197");
    db.pragma("user_version = 196");
  } finally {
    db.close();
  }
}

describe("migration 197 — briefs become observations", () => {
  test("the v196 fixture holds the brief artefacts the migration retires", () => {
    seedV196();
    const db = open();
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(196);
      expect(
        tableNames(db, ["briefs", "brief_citations", "brief_related_loops", "brief_claims"]),
      ).toEqual(["brief_citations", "brief_claims", "brief_related_loops", "briefs"]);
      expect(db.prepare("SELECT kind FROM knowledge_nodes WHERE id = 'brief-node'").get()).toEqual({
        kind: "brief",
      });
      expect(
        db
          .prepare<
            [],
            { n: number }
          >("SELECT COUNT(*) n FROM knowledge_claims WHERE node_id = 'brief-node'")
          .get()!.n,
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("upgrading removes every brief artefact and keeps everything else", () => {
    seedV196();
    const db = open();
    try {
      runMigrations(db);
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(
        tableNames(db, ["briefs", "brief_citations", "brief_related_loops", "brief_claims"]),
      ).toEqual([]);
      expect(db.prepare("SELECT id FROM knowledge_nodes ORDER BY id").all()).not.toContainEqual({
        id: "brief-node",
      });
      expect(db.prepare("SELECT kind FROM knowledge_nodes WHERE id = 'loop-node'").get()).toEqual({
        kind: "loop",
      });
      expect(
        db.prepare("SELECT COUNT(*) n FROM knowledge_claims WHERE node_id = 'brief-node'").get(),
      ).toEqual({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) n FROM knowledge_claims WHERE node_id = 'loop-node'").get(),
      ).not.toEqual({ n: 0 });
      expect(
        db.prepare("SELECT kind FROM knowledge_owner_changes WHERE kind = 'brief'").all(),
      ).toEqual([]);
      expect(
        db.prepare("SELECT kind FROM knowledge_owner_write_guard WHERE kind = 'brief'").all(),
      ).toEqual([]);
      expect(
        db
          .prepare(
            "SELECT dependent_kind, dependent_id FROM cognition_consumption_edges ORDER BY dependent_kind",
          )
          .all(),
      ).toEqual([{ dependent_kind: "loop", dependent_id: "loop_1" }]);
      expect(db.prepare("SELECT id FROM cognition_runs ORDER BY id").all()).toEqual([
        { id: "run_loop_feedback" },
      ]);
      expect(db.prepare("SELECT id FROM notifications ORDER BY id").all()).toEqual([
        { id: "note_conversation" },
      ]);
      expect(db.prepare("SELECT id FROM open_loops").all()).toEqual([{ id: "loop_1" }]);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'knowledge_owner_brief_*'",
          )
          .all(),
      ).toEqual([]);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("knowledge_nodes accepts observations after the rebuild, and no longer accepts briefs", () => {
    seedV196();
    const db = open();
    try {
      runMigrations(db);
      const sql = db
        .prepare<
          [],
          { sql: string }
        >("SELECT sql FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'")
        .get()!.sql;
      expect(sql).toContain("'observation'");
      expect(sql).not.toContain("'brief'");
      saveNode(db, "observation-node", "observation", "obs_1");
      expect(
        db.prepare("SELECT kind FROM knowledge_nodes WHERE id = 'observation-node'").get(),
      ).toEqual({ kind: "observation" });
      expect(() =>
        db
          .prepare(
            `INSERT INTO knowledge_nodes (id, kind, owner_id, title, markdown, plain_text, revision, meaning_revision, meaning_hash, validity, metadata_json, fields_json, created_at, updated_at)
             SELECT 'late-brief-node', 'brief', 'brief_2', title, markdown, plain_text, 1, 1, meaning_hash, validity, metadata_json, fields_json, created_at, updated_at
               FROM knowledge_nodes WHERE id = 'observation-node'`,
          )
          .run(),
      ).toThrow(/CHECK constraint failed/);
      const indexes = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='knowledge_nodes' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual(expect.arrayContaining(["knowledge_owner", "knowledge_single_root"]));
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("running the migration again is a no-op", () => {
    seedV196();
    const db = open();
    try {
      runMigrations(db);
      const snapshot = () => ({
        schema: db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
        nodes: db.prepare("SELECT id, kind, revision FROM knowledge_nodes ORDER BY id").all(),
        claims: db.prepare("SELECT COUNT(*) n FROM knowledge_claims").get(),
        notifications: db.prepare("SELECT id FROM notifications ORDER BY id").all(),
        migrations: db.prepare("SELECT COUNT(*) n FROM schema_migrations").get(),
      });
      const before = snapshot();
      MIGRATIONS.find((m) => m.version === 197)!.up(db);
      runMigrations(db);
      expect(snapshot()).toEqual(before);
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

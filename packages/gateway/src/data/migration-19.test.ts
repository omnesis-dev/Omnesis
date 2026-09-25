// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 19: provenance columns + edge-vocabulary migration on an
 * EXISTING install. Simulates an older install by seeding old-vocabulary
 * rows with NULL provenance, resetting `user_version` below 19, then running
 * the migration and asserting the data transformation.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "./schema.js";
import { runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

const NOW = "2026-01-01T00:00:00Z";

function seedDoc(id: string, sourceId = "gmail:me"): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'google', ?, ?, '', '', ?, '{}', ?, ?, ?, ?)`,
  ).run(id, sourceId, id, `h-${id}`, NOW, NOW, NOW, NOW);
}

/** Insert an old-vocabulary link row with NULL provenance (older shape). */
function seedOldLink(sourceDocId: string, linkType: string, targetDocId: string | null): void {
  db.prepare(
    `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sourceDocId, linkType, targetDocId ?? "t", targetDocId ?? "t", targetDocId, NOW);
}

describe("migration 19 — provenance + edge vocabulary", () => {
  test("renames the structural vocabulary and backfills provenance from type", () => {
    seedDoc("email");
    seedDoc("att");
    seedDoc("msg2");
    seedDoc("note1");
    seedDoc("page");
    seedOldLink("att", "attachment", "email");
    seedOldLink("email", "email-thread", "msg2");
    seedOldLink("note1", "intra-source", "page");
    seedOldLink("email", "url", "page");
    seedOldLink("att", "duplicate-content", "page");

    // Pretend this DB is a pre-19 install: clear provenance + reset version.
    db.exec("UPDATE document_links SET provenance_kind = NULL, provenance_origin = NULL");
    db.exec("PRAGMA user_version = 18");

    runMigrations(db);

    const byType = (t: string) =>
      db
        .prepare<
          [string],
          Record<string, unknown>
        >("SELECT * FROM document_links WHERE link_type = ?")
        .get(t);

    // attachment → contains with metadata{role:attachment}
    expect(byType("attachment")).toBeUndefined();
    const contains = byType("contains")!;
    expect(contains).toMatchObject({
      provenance_kind: "source-declared",
      provenance_origin: "gmail:me",
    });
    expect(JSON.parse(contains.metadata_json as string)).toEqual({ role: "attachment" });
    expect(contains.declared_at).toBe(NOW);

    // email-thread → part-of-thread (source-declared)
    expect(byType("email-thread")).toBeUndefined();
    expect(byType("part-of-thread")).toMatchObject({ provenance_kind: "source-declared" });

    // intra-source → references (source-declared)
    expect(byType("intra-source")).toBeUndefined();
    expect(byType("references")).toMatchObject({ provenance_kind: "source-declared" });

    // url stays content-derived; duplicate-content stays cross-source-derived
    expect(byType("url")).toMatchObject({ provenance_kind: "content-derived" });
    expect(byType("duplicate-content")).toMatchObject({
      provenance_kind: "cross-source-derived",
    });
  });

  test("re-seeds link_stats_counters under the renamed keys", () => {
    seedDoc("att");
    seedDoc("email");
    seedOldLink("att", "attachment", "email");
    db.exec("UPDATE document_links SET provenance_kind = NULL");
    db.exec("PRAGMA user_version = 18");

    runMigrations(db);

    const counters = db
      .prepare<
        [],
        { link_type: string; total: number }
      >("SELECT link_type, total FROM link_stats_counters")
      .all();
    const byType = new Map(counters.map((c) => [c.link_type, c.total]));
    expect(byType.get("contains")).toBe(1);
    expect(byType.has("attachment")).toBe(false);
  });

  test("creates the pending_edges table and provenance indexes", () => {
    db.exec("PRAGMA user_version = 18");
    runMigrations(db);
    const pending = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_edges'")
      .get();
    expect(pending).toBeDefined();
    const idx = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_document_links_provenance'")
      .get();
    expect(idx).toBeDefined();
  });

  test("is idempotent — a second runMigrations is a no-op", () => {
    seedDoc("att");
    seedDoc("email");
    seedOldLink("att", "attachment", "email");
    db.exec("UPDATE document_links SET provenance_kind = NULL");
    db.exec("PRAGMA user_version = 18");

    runMigrations(db);
    const after = db
      .prepare<
        [],
        Record<string, unknown>
      >("SELECT * FROM document_links WHERE link_type = 'contains'")
      .get()!;
    // Re-run: version is already 19 so migration 19 must not execute again.
    runMigrations(db);
    const again = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM document_links").get()!;
    expect(again.c).toBe(1);
    const stillContains = db
      .prepare<
        [],
        Record<string, unknown>
      >("SELECT * FROM document_links WHERE link_type = 'contains'")
      .get()!;
    expect(stillContains).toMatchObject({
      id: after.id,
      provenance_kind: "source-declared",
      declared_at: after.declared_at,
    });
  });

  test("leaves already-new-vocabulary rows untouched (forward-compatible)", () => {
    seedDoc("a");
    seedDoc("b");
    // A row already in the new vocabulary with provenance set — must survive.
    db.prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, created_at, provenance_kind, provenance_origin, declared_at)
       VALUES ('a', 'replies-to', 'b', 'b', 'b', ?, 'source-declared', 'gmail:me', ?)`,
    ).run(NOW, NOW);
    db.exec("PRAGMA user_version = 18");

    runMigrations(db);

    const row = db
      .prepare<
        [],
        Record<string, unknown>
      >("SELECT * FROM document_links WHERE link_type = 'replies-to'")
      .get()!;
    expect(row).toMatchObject({
      provenance_kind: "source-declared",
      provenance_origin: "gmail:me",
    });
  });
});

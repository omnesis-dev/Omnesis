// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";

describe("migration 68 — firing evidence and Answer egress binding", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    runSchemaSetup(db);
  });

  afterEach(() => db.close());

  test("normalizes surviving evidence, counts missing evidence, adds bindings, and is idempotent", () => {
    // Reconstruct the three v67 table shapes that migration 68 changes.
    db.exec(`
      ALTER TABLE answer_tasks DROP COLUMN subscription_firing_id;
      ALTER TABLE answer_egress_events DROP COLUMN subscription_firing_id;
      ALTER TABLE subscription_firings DROP COLUMN evidence_count;

      INSERT INTO documents
        (id, provider_id, source_id, external_id, title, content, content_hash,
         source_created_at, source_updated_at, ingested_at, updated_at)
      VALUES
        ('doc_m68_survives', 'fictional', 'fictional:source', 'external-m68-survives',
         'Fictional surviving evidence', 'Wholly invented evidence.', 'hash-m68-survives',
         '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z',
         '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z');

      INSERT INTO subscription_firings
        (id, subscription_id, revision, workflow_id, index_event_key, status,
         evidence_json, fired_at)
      VALUES
        ('sfiring_m68', 'sub_fictional_missing', 1, 'wf_fictional_missing',
         'fictional-m68-event', 'pending',
         '["doc_m68_survives","doc_m68_deleted"]', 100);

      PRAGMA user_version = 67;
    `);

    const migration = MIGRATIONS.find((candidate) => candidate.version === 68);
    if (!migration) throw new Error("migration 68 not found");
    runMigrations(db, { migrations: [migration] });
    runMigrations(db, { migrations: [migration] });
    migration.up(db);

    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('answer_tasks')")
        .all()
        .map((row) => row.name),
    ).toContain("subscription_firing_id");
    expect(
      db
        .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('answer_egress_events')")
        .all()
        .map((row) => row.name),
    ).toContain("subscription_firing_id");
    expect(
      db
        .prepare<
          [],
          { evidence_json: string; evidence_count: number }
        >("SELECT evidence_json, evidence_count FROM subscription_firings WHERE id = 'sfiring_m68'")
        .get(),
    ).toEqual({
      evidence_json: "[]",
      // The count records the immutable firing-time scope, including evidence
      // that privacy deletion removed before this migration ran.
      evidence_count: 2,
    });
    expect(
      db
        .prepare<
          [],
          { firing_id: string; document_id: string }
        >("SELECT firing_id, document_id FROM subscription_firing_evidence")
        .all(),
    ).toEqual([{ firing_id: "sfiring_m68", document_id: "doc_m68_survives" }]);
  });
});

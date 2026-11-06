// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";

test("migration 214 adds durable publication state without rewriting existing facts", () => {
  const db = new Database(":memory:");
  try {
    runSchemaSetup(db);
    db.exec(
      "INSERT INTO document_scope_facts VALUES('fictional-document','label','stable-label'); INSERT INTO document_scope_completeness VALUES('fictional-document','label',1)",
    );
    db.exec(
      "DROP TABLE scope_fact_rebuilds; DROP TABLE scope_fact_rebuild_cursor; DROP TABLE scope_conversation_rebuilds; DROP TABLE scope_conversation_identifier_counts",
    );
    db.pragma("user_version=213");
    runMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT * FROM scope_fact_rebuilds").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM scope_conversation_rebuilds").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM document_scope_facts").all()).toEqual([
      { document_id: "fictional-document", kind: "label", entity_id: "stable-label" },
    ]);
    expect(db.prepare("SELECT * FROM document_scope_completeness").all()).toEqual([
      { document_id: "fictional-document", kind: "label", complete: 1 },
    ]);
    runMigrations(db);
    expect(db.prepare("SELECT * FROM scope_fact_rebuild_cursor").all()).toEqual([
      { id: 1, document_id: "" },
    ]);
  } finally {
    db.close();
  }
});

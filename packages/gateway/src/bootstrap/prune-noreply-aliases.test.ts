// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabase } from "../db.js";
import { pruneNoreplyAliases } from "./prune-noreply-aliases.js";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-prune-noreply-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makePerson(canonicalName: string, mergedInto: string | null = null): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at, merged_into)
     VALUES (?, ?, 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', ?)`,
  ).run(id, canonicalName, mergedInto);
  return id;
}

function addAlias(personId: string, aliasType: string, alias: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
     VALUES (?, ?, ?, ?, 'gmail:test', '2026-01-01')`,
  ).run(id, personId, alias, aliasType);
  return id;
}

function insertDoc(id: string, peopleResolvedAt: string | null = "2026-01-02T00:00:00Z") {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, people_resolved_at)
     VALUES (?, 'google', 'gmail:test', ?, 'T', 'c', 'h-' || ?, '{}', '2026-01-01', '2026-01-01', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`,
  ).run(id, id, id, peopleResolvedAt);
}

function linkDoc(docId: string, personId: string, role = "sender") {
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, 'gmail:test')`,
  ).run(docId, personId, role);
}

describe("pruneNoreplyAliases", () => {
  test("no-op on a clean database", () => {
    const result = pruneNoreplyAliases(db);
    expect(result).toEqual({ aliasesRemoved: 0, documentsToRebackfill: 0 });
  });

  test("removes a single noreply email alias and clears affected docs", () => {
    const bucket = makePerson("Tomas Vidal (Google Docs)");
    addAlias(bucket, "email", "comments-noreply@docs.google.com");
    addAlias(bucket, "name", "Carla Vance (Google Docs)");

    insertDoc("doc-1");
    linkDoc("doc-1", bucket);

    const result = pruneNoreplyAliases(db);
    expect(result.aliasesRemoved).toBe(1);
    expect(result.documentsToRebackfill).toBe(1);

    const aliasGone = db
      .prepare("SELECT 1 FROM person_aliases WHERE alias = 'comments-noreply@docs.google.com'")
      .get();
    expect(aliasGone).toBeUndefined();

    // Name alias preserved — only `email` aliases are pruned.
    const nameSurvives = db
      .prepare("SELECT 1 FROM person_aliases WHERE alias = 'Carla Vance (Google Docs)'")
      .get();
    expect(nameSurvives).toBeDefined();

    const docRow = db
      .prepare<
        [],
        { people_resolved_at: string | null }
      >("SELECT people_resolved_at FROM documents WHERE id = 'doc-1'")
      .get();
    expect(docRow?.people_resolved_at).toBeNull();
  });

  test("clears docs linked to the canonical when the bucket has merged_into it", () => {
    const real = makePerson("tomas.vidal@example.com");
    const bucket = makePerson("Tomas Vidal (Google Docs)", real);
    addAlias(real, "email", "tomas.vidal@example.com");
    addAlias(bucket, "email", "comments-noreply@docs.google.com");

    // Docs are attributed to the canonical (`real`) per the merge model.
    insertDoc("doc-on-canonical");
    linkDoc("doc-on-canonical", real);

    const result = pruneNoreplyAliases(db);
    expect(result.aliasesRemoved).toBe(1);
    expect(result.documentsToRebackfill).toBe(1);

    const docRow = db
      .prepare<
        [],
        { people_resolved_at: string | null }
      >("SELECT people_resolved_at FROM documents WHERE id = 'doc-on-canonical'")
      .get();
    expect(docRow?.people_resolved_at).toBeNull();

    // The real person's identifying email is untouched.
    const real_email = db
      .prepare("SELECT 1 FROM person_aliases WHERE alias = 'tomas.vidal@example.com'")
      .get();
    expect(real_email).toBeDefined();
  });

  test("clears docs linked to ANY bucket merged into the same canonical (sibling reach)", () => {
    const canonical = makePerson("Real Person");
    const bucketA = makePerson("Bucket A", canonical);
    const bucketB = makePerson("Bucket B", canonical);
    addAlias(canonical, "email", "real@example.com");
    addAlias(bucketA, "email", "calendar-noreply@google.com");
    // bucketB has no noreply alias but is in the same equivalence class.
    addAlias(bucketB, "name", "Bucket B");

    insertDoc("doc-via-sibling");
    linkDoc("doc-via-sibling", bucketB);

    const result = pruneNoreplyAliases(db);
    expect(result.aliasesRemoved).toBe(1);
    expect(result.documentsToRebackfill).toBe(1);

    const docRow = db
      .prepare<
        [],
        { people_resolved_at: string | null }
      >("SELECT people_resolved_at FROM documents WHERE id = 'doc-via-sibling'")
      .get();
    expect(docRow?.people_resolved_at).toBeNull();
  });

  test("does not touch identifying email aliases", () => {
    const real = makePerson("Real Sender");
    addAlias(real, "email", "real.sender@example.com");
    addAlias(real, "email", "no-reply@docs.google.com");

    const result = pruneNoreplyAliases(db);
    expect(result.aliasesRemoved).toBe(1);

    const stillThere = db
      .prepare("SELECT 1 FROM person_aliases WHERE alias = 'real.sender@example.com'")
      .get();
    expect(stillThere).toBeDefined();
  });

  test("prunes an alias that is only in the learned blocklist (not the static heuristic)", () => {
    // `helpdesk@example.com` is NOT matched by isNonIdentifyingEmail — only
    // the learned blocklist marks it non-identifying.
    db.prepare(
      `INSERT INTO non_identifying_emails (email, reason, name_count, detected_at)
       VALUES ('helpdesk@example.com', 'shared_address_cardinality', 30, '2026-01-01')`,
    ).run();
    const bucket = makePerson("Bucket");
    addAlias(bucket, "email", "helpdesk@example.com");
    insertDoc("doc-1");
    linkDoc("doc-1", bucket);

    const result = pruneNoreplyAliases(db);
    expect(result.aliasesRemoved).toBe(1);
    expect(result.documentsToRebackfill).toBe(1);
    expect(
      db.prepare("SELECT 1 FROM person_aliases WHERE alias = 'helpdesk@example.com'").get(),
    ).toBeUndefined();
  });

  test("idempotent on a second run", () => {
    const p = makePerson("Bucket");
    addAlias(p, "email", "comments-noreply@docs.google.com");
    insertDoc("doc-1");
    linkDoc("doc-1", p);

    const first = pruneNoreplyAliases(db);
    expect(first.aliasesRemoved).toBe(1);

    const second = pruneNoreplyAliases(db);
    expect(second).toEqual({ aliasesRemoved: 0, documentsToRebackfill: 0 });
  });
});

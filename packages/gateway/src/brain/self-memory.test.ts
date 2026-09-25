// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Wiring test for `resolveSelfMemory` — the DB→prompt path both agents use:
 * the feature gate, self-person resolution, the merge-expanding annotation
 * query, and the rendered injection block. Fixture data is invented.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import { createPersonAnnotation } from "./storage/person-annotations.js";
import { resolveSelfMemory } from "./self-memory.js";
import type Database from "better-sqlite3";

type Db = Database.Database;
const NOW = Date.parse("2026-07-02T10:00:00.000Z");

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const s of ["", "-wal", "-shm", "-journal"]) if (existsSync(path + s)) unlinkSync(path + s);
}
function insertDoc(db: Db, externalId: string, content: string): string {
  const doc: DocumentInput = {
    providerId: ProviderId("google"),
    sourceId: SourceId("gmail-test"),
    externalId,
    title: `Message ${externalId}`,
    content,
    contentHash: `hash-${externalId}-${content.length}`,
    metadata: {},
    sourceCreatedAt: "2026-01-01T10:00:00.000Z",
    sourceUpdatedAt: "2026-01-01T10:00:00.000Z",
  };
  upsertDocuments(db, [doc]);
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
}
function insertPerson(db: Db, id: string, name: string, isSelf: number): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'test', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name, isSelf);
}
function selfFact(
  db: Db,
  id: string,
  claimType: string,
  claimText: string,
  evidenceDocId: string,
  now: number,
): void {
  createPersonAnnotation(
    db,
    {
      id,
      personId: "per_self",
      claimType,
      claimText,
      evidenceDocId,
      evidenceQuote: "a verbatim grounding quote",
      confidence: 0.8,
      claimBasis: "quoted",
      createdByRun: "r",
    },
    now,
  );
}

describe("resolveSelfMemory", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("returns empty (and never touches the store) when the feature is off", () => {
    insertPerson(db, "per_self", "TestSelf", 1);
    const docId = insertDoc(db, "d1", "the user founded Acme");
    selfFact(db, "pa1", "role", "Founder of Acme", docId, NOW);
    expect(resolveSelfMemory(db, false)).toEqual({
      selfPersonId: null,
      selfMemory: "",
      annotationIds: [],
    });
  });

  test("returns empty when self is not yet identified (no is_self person)", () => {
    insertPerson(db, "per_other", "TestOther", 0);
    expect(resolveSelfMemory(db, true)).toEqual({
      selfPersonId: null,
      selfMemory: "",
      annotationIds: [],
    });
  });

  test("resolves the self id but an empty block when self has no annotations", () => {
    insertPerson(db, "per_self", "TestSelf", 1);
    const res = resolveSelfMemory(db, true);
    expect(res.selfPersonId).toBe("per_self");
    expect(res.selfMemory).toBe("");
  });

  test("renders the self person's live annotations into the injected block", () => {
    insertPerson(db, "per_self", "TestSelf", 1);
    const docId = insertDoc(db, "d1", "the user founded Acme and prefers mornings");
    selfFact(db, "pa1", "role", "Founder of Acme", docId, NOW);
    selfFact(db, "pa2", "preference", "Prefers morning workouts", docId, NOW + 1000);
    const res = resolveSelfMemory(db, true);
    expect(res.selfPersonId).toBe("per_self");
    expect(res.selfMemory).toContain("(role, conf");
    expect(res.selfMemory).toContain("Founder of Acme");
    expect(res.selfMemory).toContain("Prefers morning workouts");
    // Every injected line carries the reground pointer to its evidence doc.
    expect(res.selfMemory).toContain("[annotation person:pa1; reground: doc ");
  });
});

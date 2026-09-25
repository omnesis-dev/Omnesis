// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import { createOpenLoop } from "../../brain/storage/open-loops.js";
import { createBrief } from "../../brain/storage/briefs.js";
import { createPersonAnnotation } from "../../brain/storage/person-annotations.js";
import { insertTemporalAnnotation } from "../../enrichment/temporal-annotations/storage.js";
import { reapEntityContext } from "./CognitiveGraphService.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanup(p: string): void {
  for (const s of ["", "-wal", "-shm", "-journal"]) if (existsSync(p + s)) unlinkSync(p + s);
}
function insertPerson(db: Db, id: string, name: string, mergedInto?: string): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at, merged_into)
     VALUES (?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', ?)`,
  ).run(id, name, mergedInto ?? null);
}
function insertDoc(db: Db, id: string, title: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', 'gmail:self', ?, ?, 'body', 'h-' || ?, '{}', '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01')`,
  ).run(id, id, title, id);
}
const NOW = Date.parse("2026-07-10T10:00:00.000Z");

describe("reapEntityContext", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
    // People
    insertPerson(db, "per_maya", "Maya Reeves");
    insertPerson(db, "per_david", "David Lin");
    // Docs
    insertDoc(db, "doc_lease", "Signed lease");
    insertDoc(db, "doc_other", "Unrelated memo");
    // loop_a: Maya is an actor, grounded in doc_lease
    createOpenLoop(
      db,
      {
        id: "loop_a",
        createdByRun: "r",
        title: "Send the signed lease",
        confidence: 0.9,
        importance: 0.7,
        actors: ["per_maya"],
        docs: ["doc_lease"],
      },
      NOW,
    );
    // loop_b: grouped with loop_a on a live brief -> related-to
    createOpenLoop(
      db,
      {
        id: "loop_b",
        createdByRun: "r",
        title: "Book the venue",
        confidence: 0.8,
        importance: 0.6,
      },
      NOW - 1000,
    );
    createBrief(
      db,
      {
        id: "brf_1",
        createdByRun: "r",
        kind: "loop",
        title: "grouped",
        confidence: 0.8,
        urgency: 0.4,
        relatedLoopIds: ["loop_a", "loop_b"],
      },
      NOW,
    );
    // loop_x: ONLY Maya is on it (no docs / relations) — used to prove people are terminal
    createOpenLoop(
      db,
      {
        id: "loop_x",
        createdByRun: "r",
        title: "Maya-only chore",
        confidence: 0.8,
        importance: 0.4,
        actors: ["per_maya"],
      },
      NOW - 2000,
    );
    // Time entries: entry_1 concerns Maya + cites doc_lease; entry_2 backlinks loop_a
    insertTemporalAnnotation(
      db,
      {
        id: "tix_1",
        intervalStartMs: NOW,
        intervalEndMs: NOW,
        precision: "day",
        canonical: "2026-07-15",
        sentence: "Lease deadline",
        kind: "deadline",
        documentIds: ["doc_lease"],
        personIds: ["per_maya"],
        createdByRun: "r",
      },
      NOW,
    );
    insertTemporalAnnotation(
      db,
      {
        id: "tix_2",
        intervalStartMs: NOW,
        intervalEndMs: NOW,
        precision: "day",
        canonical: "2026-07-20",
        sentence: "Venue follow-up",
        kind: "deadline",
        documentIds: [],
        loopIds: ["loop_a"],
        createdByRun: "r",
      },
      NOW,
    );
    // Annotation about Maya (decoration)
    createPersonAnnotation(
      db,
      {
        id: "pa_1",
        personId: "per_maya",
        claimType: "role",
        claimText: "Property manager",
        evidenceDocId: "doc_lease",
        evidenceQuote: "…",
        confidence: 0.9,
        claimBasis: "quoted",
        createdByRun: "r",
      },
      NOW,
    );
  });
  afterEach(() => {
    db.close();
    cleanup(path);
  });

  test("person seed reaps their loops + time-entries, and (depth 2) the loops' docs/people/related-loops", () => {
    const n = reapEntityContext(db, { kind: "person", id: "per_maya" }, { depth: 2 });
    expect(n.seed).toEqual({ kind: "person", id: "per_maya", label: "Maya Reeves" });
    // depth 1: Maya's active loops (loop_a, loop_x) + her temporal annotation
    expect(n.loops.map((l) => l.loopId).sort()).toContain("loop_a");
    expect(n.loops.map((l) => l.loopId)).toContain("loop_x");
    expect(n.temporalAnnotations.map((t) => t.annotationId)).toContain("tix_1");
    // depth 2: loop_a grounds in doc_lease, relates to loop_b
    expect(n.documents.map((d) => d.documentId)).toContain("doc_lease");
    expect(n.loops.map((l) => l.loopId)).toContain("loop_b");
  });

  test("loop seed reaps docs, people (with annotations), related loops, and dated entries", () => {
    const n = reapEntityContext(db, { kind: "loop", id: "loop_a" }, { depth: 2 });
    expect(n.seed?.kind).toBe("loop");
    expect(n.documents.map((d) => d.documentId)).toContain("doc_lease");
    expect(n.loops.map((l) => l.loopId)).toContain("loop_b"); // related-to
    expect(n.temporalAnnotations.map((t) => t.annotationId)).toContain("tix_2"); // backlinked
    const maya = n.people.find((p) => p.personId === "per_maya");
    expect(maya).toBeDefined();
    expect(maya!.notes).toEqual(["Property manager"]); // annotation decoration
  });

  test("people are terminal: reaping loop_a reaches Maya but NOT her unrelated loop_x", () => {
    const n = reapEntityContext(db, { kind: "loop", id: "loop_a" }, { depth: 3 });
    // Maya is reached (she's on loop_a) but the walk never expands out of her,
    // so her Maya-only chore is not dragged in.
    expect(n.people.map((p) => p.personId)).toContain("per_maya");
    expect(n.loops.map((l) => l.loopId)).not.toContain("loop_x");
  });

  test("document seed reaps the loops + entries it grounds", () => {
    const n = reapEntityContext(db, { kind: "document", id: "doc_lease" }, { depth: 1 });
    expect(n.seed?.kind).toBe("document");
    expect(n.loops.map((l) => l.loopId)).toContain("loop_a");
    expect(n.temporalAnnotations.map((t) => t.annotationId)).toContain("tix_1");
  });

  test("merge-equivalence: a loop authored against a merged-away id surfaces on the canonical", () => {
    // per_maya_alt merges INTO per_maya; loop_merged names the loser as actor.
    insertPerson(db, "per_maya_alt", "Maya R.", "per_maya");
    createOpenLoop(
      db,
      {
        id: "loop_merged",
        createdByRun: "r",
        title: "Chase deposit",
        confidence: 0.8,
        importance: 0.5,
        actors: ["per_maya_alt"],
      },
      NOW,
    );
    const n = reapEntityContext(db, { kind: "person", id: "per_maya" }, { depth: 1 });
    expect(n.loops.map((l) => l.loopId)).toContain("loop_merged");
  });

  test("missing / non-existent seed yields an empty neighbourhood with seed:null (never throws)", () => {
    const n = reapEntityContext(db, { kind: "loop", id: "loop_does_not_exist" });
    expect(n.seed).toBeNull();
    expect(n.loops).toEqual([]);
    expect(n.counts).toEqual({
      loops: 0,
      documents: 0,
      people: 0,
      temporalAnnotations: 0,
    });
  });

  test("a hub person's loops are capped per kind and the reap is marked truncated", () => {
    insertPerson(db, "per_hub", "Hub");
    for (let i = 0; i < 15; i++) {
      createOpenLoop(
        db,
        {
          id: `hub_loop_${i}`,
          createdByRun: "r",
          title: `chore ${i}`,
          confidence: 0.8,
          importance: 0.5,
          actors: ["per_hub"],
        },
        NOW - i,
      );
    }
    const n = reapEntityContext(db, { kind: "person", id: "per_hub" }, { depth: 1 });
    // PER_KIND_CAP = 12: the 15 loops are capped to 12 and truncation is signalled.
    expect(n.loops).toHaveLength(12);
    expect(n.counts.loops).toBe(12);
    expect(n.truncated).toBe(true);
  });

  test("temporal-annotation expander reaches a document linked only through annotation joins", () => {
    insertDoc(db, "doc_only_via_entry", "Only reachable via a dated fact");
    // tix_only concerns Maya and cites doc_only_via_entry — but no loop links it.
    insertTemporalAnnotation(
      db,
      {
        id: "tix_only",
        intervalStartMs: NOW,
        intervalEndMs: NOW,
        precision: "day",
        canonical: "2026-08-01",
        sentence: "Standalone dated fact",
        kind: "event",
        documentIds: ["doc_only_via_entry"],
        personIds: ["per_maya"],
        createdByRun: "r",
      },
      NOW,
    );
    // person → tix_only (depth 1) → doc_only_via_entry (depth 2, via annotation joins).
    const n = reapEntityContext(db, { kind: "person", id: "per_maya" }, { depth: 2 });
    expect(n.temporalAnnotations.map((t) => t.annotationId)).toContain("tix_only");
    expect(n.documents.map((d) => d.documentId)).toContain("doc_only_via_entry");
  });
});

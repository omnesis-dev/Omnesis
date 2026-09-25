// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for `searchOpenLoopsByIdentity` — the graph-based reconcile
 * candidate generator. Each of the three identity signals (shared people,
 * shared thread/linked docs, nearby deadline) is exercised in isolation over
 * a real SQLite store, plus the exclusions (self, resolved loops) and the
 * ranking invariant (a link match outranks a lone low-signal shared person).
 *
 * All fixture data is invented — never corpus-derived.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { createDatabase } from "../../db.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { searchOpenLoopsByIdentity } from "./identity-candidates.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

const DAY = 24 * 60 * 60 * 1000;

describe("searchOpenLoopsByIdentity", () => {
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

  function seedDoc(id: string, sourceCreatedAt = "2026-07-01T00:00:00.000Z"): void {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
          content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'p', ?, ?, ?, 'body', ?, '{}', ?, ?, ?, ?)`,
    ).run(
      id,
      `src:${id}`,
      id,
      `title-${id}`,
      `ch-${id}`,
      sourceCreatedAt,
      sourceCreatedAt,
      sourceCreatedAt,
      sourceCreatedAt,
    );
  }

  function seedPerson(id: string, opts: { score?: number; isSelf?: boolean } = {}): void {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen,
          created_at, updated_at, interaction_score_recent)
       VALUES (?, ?, 'test', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', ?)`,
    ).run(id, id, opts.isSelf ? 1 : 0, opts.score ?? 0);
  }

  function seedDocPerson(docId: string, personId: string, role = "from"): void {
    db.prepare("INSERT INTO document_people (document_id, person_id, role) VALUES (?, ?, ?)").run(
      docId,
      personId,
      role,
    );
  }

  function seedThreadEdge(sourceDocId: string, targetDocId: string): void {
    db.prepare(
      `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target,
          target_doc_id, resolved_at, created_at)
       VALUES (?, 'part-of-thread', ?, ?, ?, '2026-01-01', '2026-01-01')`,
    ).run(sourceDocId, targetDocId, targetDocId, targetDocId);
  }

  test("matches a loop by a shared person even with zero word overlap", () => {
    seedPerson("per_self", { isSelf: true });
    seedPerson("per_maya", { score: 0.5 });
    seedDoc("doc_seed");
    seedDocPerson("doc_seed", "per_maya");
    seedDocPerson("doc_seed", "per_self");
    // Title shares no words with anything on the seed doc — only the person
    // links them.
    createOpenLoop(
      db,
      {
        id: "olp_booking",
        createdByRun: "run_1",
        title: "Zzyzx quorum widget",
        confidence: 0.8,
        importance: 0.6,
        actors: ["per_maya"],
      },
      1000,
    );

    const hits = searchOpenLoopsByIdentity(db, {
      seedDocIds: ["doc_seed"],
      now: 2000,
      limit: 8,
      deadlineWindowMs: 0,
      selfPersonId: "per_self",
    });
    expect(hits.map((h) => h.loop.id)).toEqual(["olp_booking"]);
    expect(hits[0]!.matchedBy).toContain("person:per_maya");
  });

  test("matches a loop that shares a thread sibling (part-of-thread neighbour)", () => {
    seedDoc("doc_open"); // the loop's document
    seedDoc("doc_reply"); // the arriving datum, a reply in the same thread
    seedThreadEdge("doc_reply", "doc_open");
    createOpenLoop(
      db,
      {
        id: "olp_thread",
        createdByRun: "run_1",
        title: "Original booking request",
        confidence: 0.8,
        importance: 0.6,
        docs: ["doc_open"],
      },
      1000,
    );

    const hits = searchOpenLoopsByIdentity(db, {
      seedDocIds: ["doc_reply"],
      now: 2000,
      limit: 8,
      deadlineWindowMs: 0,
      selfPersonId: null,
    });
    expect(hits.map((h) => h.loop.id)).toEqual(["olp_thread"]);
    expect(hits[0]!.matchedBy).toContain("linked-doc:doc_open");
  });

  test("matches a loop whose deadline is inside the window, not one 60 days out", () => {
    seedDoc("doc_seed", "2026-08-01T00:00:00.000Z");
    createOpenLoop(
      db,
      {
        id: "olp_near",
        createdByRun: "run_1",
        title: "Near deadline",
        confidence: 0.8,
        importance: 0.6,
        deadline: { kind: "by", date: "2026-08-05" },
      },
      1000,
    );
    createOpenLoop(
      db,
      {
        id: "olp_far",
        createdByRun: "run_1",
        title: "Far deadline",
        confidence: 0.8,
        importance: 0.6,
        deadline: { kind: "by", date: "2026-10-01" },
      },
      1000,
    );

    const hits = searchOpenLoopsByIdentity(db, {
      seedDocIds: ["doc_seed"],
      now: 2000,
      limit: 8,
      deadlineWindowMs: 14 * DAY,
      selfPersonId: null,
    });
    expect(hits.map((h) => h.loop.id)).toEqual(["olp_near"]);
    expect(hits[0]!.matchedBy).toContain("deadline-proximity");
  });

  test("excludes the self person (self is on everything)", () => {
    seedPerson("per_self", { isSelf: true, score: 0.9 });
    seedDoc("doc_seed");
    seedDocPerson("doc_seed", "per_self");
    createOpenLoop(
      db,
      {
        id: "olp_self",
        createdByRun: "run_1",
        title: "A loop involving me",
        confidence: 0.8,
        importance: 0.6,
        actors: ["per_self"],
      },
      1000,
    );

    const hits = searchOpenLoopsByIdentity(db, {
      seedDocIds: ["doc_seed"],
      now: 2000,
      limit: 8,
      deadlineWindowMs: 0,
      selfPersonId: "per_self",
    });
    expect(hits).toEqual([]);
  });

  test("never resurfaces a done or dismissed loop", () => {
    seedPerson("per_maya", { score: 0.5 });
    seedDoc("doc_seed");
    seedDocPerson("doc_seed", "per_maya");
    for (const [id, state] of [
      ["olp_open", "open"],
      ["olp_snoozed", "snoozed"],
      ["olp_done", "done"],
      ["olp_dismissed", "dismissed"],
    ] as const) {
      createOpenLoop(
        db,
        {
          id,
          createdByRun: "run_1",
          title: `Loop ${id}`,
          confidence: 0.8,
          importance: 0.6,
          state,
          actors: ["per_maya"],
        },
        1000,
      );
    }

    const hits = searchOpenLoopsByIdentity(db, {
      seedDocIds: ["doc_seed"],
      now: 2000,
      limit: 8,
      deadlineWindowMs: 0,
      selfPersonId: null,
    });
    expect(hits.map((h) => h.loop.id).sort()).toEqual(["olp_open", "olp_snoozed"]);
  });

  test("a thread/link match outranks a lone low-interaction shared person", () => {
    // The seed datum shares a thread sibling with olp_link AND a low-signal
    // person with olp_person. The link signal (weight 3) must win.
    seedPerson("per_low", { score: 0.01 });
    seedDoc("doc_seed");
    seedDoc("doc_sibling");
    seedThreadEdge("doc_seed", "doc_sibling");
    seedDocPerson("doc_seed", "per_low");
    createOpenLoop(
      db,
      {
        id: "olp_link",
        createdByRun: "run_1",
        title: "Thread-matched loop",
        confidence: 0.8,
        importance: 0.6,
        docs: ["doc_sibling"],
      },
      1000,
    );
    createOpenLoop(
      db,
      {
        id: "olp_person",
        createdByRun: "run_1",
        title: "Person-matched loop",
        confidence: 0.8,
        importance: 0.6,
        actors: ["per_low"],
      },
      1000,
    );

    const hits = searchOpenLoopsByIdentity(db, {
      seedDocIds: ["doc_seed"],
      now: 2000,
      limit: 8,
      deadlineWindowMs: 0,
      selfPersonId: null,
    });
    expect(hits.map((h) => h.loop.id)).toEqual(["olp_link", "olp_person"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  test("empty seed set returns nothing", () => {
    expect(
      searchOpenLoopsByIdentity(db, {
        seedDocIds: [],
        now: 2000,
        limit: 8,
        deadlineWindowMs: 14 * DAY,
        selfPersonId: null,
      }),
    ).toEqual([]);
  });
});

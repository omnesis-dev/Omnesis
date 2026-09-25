// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import {
  countNearDupInbox,
  enqueueAllEligibleForAlgoBump,
  enqueueNearDupInbox,
  peekNearDupInbox,
  removeNearDupInboxRows,
} from "./inbox.js";
import type { Db } from "../data/types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-near-dup-inbox-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  // Match the gateway journal while retaining fully synchronized commits.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedDoc(id: string, documentType: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "p",
    "s",
    id,
    "t",
    "content body content body content body content body content body content body",
    "ch-" + id,
    JSON.stringify({ documentType }),
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
  );
}

describe("enqueueNearDupInbox", () => {
  test("enqueues new docs", () => {
    const { enqueued } = enqueueNearDupInbox(db, ["a", "b", "c"], "insert", 100);
    expect(enqueued).toBe(3);
    expect(countNearDupInbox(db)).toBe(3);
  });

  test("coalesces re-enqueues under the same reason", () => {
    enqueueNearDupInbox(db, ["a"], "insert", 100);
    enqueueNearDupInbox(db, ["a"], "insert", 200);
    expect(countNearDupInbox(db)).toBe(1);
  });

  test("a re-enqueue replaces the pending row rather than leaving it in place", () => {
    // Row identity is the queue token the writer drains by, so a
    // re-enqueue has to mint a new one: an update that lands while the
    // compute pass holds the old row must not be drained away with it.
    enqueueNearDupInbox(db, ["a"], "update", 100);
    const before = peekNearDupInbox(db, 10)[0];
    enqueueNearDupInbox(db, ["a"], "update", 200);
    const after = peekNearDupInbox(db, 10);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBeGreaterThan(before.id);
    expect(after[0].enqueuedAt).toBe(200);
  });

  test("a re-enqueue after the compute pass peeked survives the writer's drain", () => {
    // The peeked row is a pending marker, not a claim — the writer deletes
    // it by id once the batch built from it is applied. A second content
    // update landing in that window must leave work behind, or the document
    // keeps a signature, LSH buckets and edges describing the body the
    // compute pass read, with nothing queued to correct them.
    enqueueNearDupInbox(db, ["a"], "update", 100);
    const peeked = peekNearDupInbox(db, 10);
    expect(peeked).toHaveLength(1);

    // The document changes again while the batch is in flight.
    enqueueNearDupInbox(db, ["a"], "update", 200);

    // The writer drains exactly what the compute pass consumed.
    removeNearDupInboxRows(
      db,
      peeked.map((r) => r.id),
    );

    expect(peekNearDupInbox(db, 10).map((r) => r.docId)).toEqual(["a"]);
  });

  test("does not coalesce across reasons (insert vs delete)", () => {
    enqueueNearDupInbox(db, ["a"], "insert", 100);
    const { enqueued } = enqueueNearDupInbox(db, ["a"], "delete", 200);
    expect(enqueued).toBe(1);
    expect(countNearDupInbox(db)).toBe(2);
  });

  test("returns 0 for empty input", () => {
    const { enqueued } = enqueueNearDupInbox(db, [], "insert");
    expect(enqueued).toBe(0);
  });
});

describe("peekNearDupInbox", () => {
  test("returns oldest rows first", () => {
    enqueueNearDupInbox(db, ["a"], "insert", 100);
    enqueueNearDupInbox(db, ["b"], "insert", 200);
    enqueueNearDupInbox(db, ["c"], "insert", 150);
    const rows = peekNearDupInbox(db, 10);
    expect(rows.map((r) => r.docId)).toEqual(["a", "b", "c"]);
  });

  test("limit caps the read", () => {
    for (let i = 0; i < 5; i++) enqueueNearDupInbox(db, [`d-${i}`], "insert");
    expect(peekNearDupInbox(db, 3)).toHaveLength(3);
  });

  test("returns the reason verbatim", () => {
    enqueueNearDupInbox(db, ["x"], "delete");
    expect(peekNearDupInbox(db, 1)[0].reason).toBe("delete");
  });
});

describe("removeNearDupInboxRows", () => {
  test("removes by row id", () => {
    enqueueNearDupInbox(db, ["a", "b", "c"], "insert");
    const rows = peekNearDupInbox(db, 10);
    const removeIds = rows.slice(0, 2).map((r) => r.id);
    const { removed } = removeNearDupInboxRows(db, removeIds);
    expect(removed).toBe(2);
    expect(countNearDupInbox(db)).toBe(1);
  });

  test("no-op on empty input", () => {
    expect(removeNearDupInboxRows(db, []).removed).toBe(0);
  });
});

describe("enqueueAllEligibleForAlgoBump", () => {
  test("enqueues every doc whose type is in the eligible set", () => {
    seedDoc("d1", "email");
    seedDoc("d2", "attachment");
    seedDoc("d3", "web-page"); // ineligible
    seedDoc("d4", "note");
    const eligible = new Set(["email", "attachment", "note"]);
    const { enqueued } = enqueueAllEligibleForAlgoBump(db, eligible);
    expect(enqueued).toBe(3);
    const docs = peekNearDupInbox(db, 10)
      .map((r) => r.docId)
      .sort();
    expect(docs).toEqual(["d1", "d2", "d4"]);
  });

  test("is idempotent (re-running coalesces via the dedup index)", () => {
    seedDoc("d1", "email");
    seedDoc("d2", "email");
    const eligible = new Set(["email"]);
    enqueueAllEligibleForAlgoBump(db, eligible);
    const { enqueued } = enqueueAllEligibleForAlgoBump(db, eligible);
    expect(enqueued).toBe(0);
    expect(countNearDupInbox(db)).toBe(2);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How `upsertDocuments` groups a page into yieldable chunks. The writer is one
 * thread, so each extra chunk costs an fsync'd commit plus the per-chunk stats
 * maintenance (a COUNT(*) over the source and a latest-activity refresh); a
 * page must not pay that per document because one document in it is large.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../schema.js";
import { runMigrations } from "../migrations.js";
import { upsertDocuments } from "./DocumentRepository.js";
import type { DocumentInput } from "@omnesis/types";

type Db = Database.Database;

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => db.close());

const SOURCE = "drive:maya@example.com";
const T = "2026-01-01T10:00:00Z";

function doc(externalId: string, contentBytes: number): DocumentInput {
  return {
    providerId: "google" as DocumentInput["providerId"],
    sourceId: SOURCE as DocumentInput["sourceId"],
    externalId,
    title: `Doc ${externalId}`,
    content: "x".repeat(contentBytes),
    contentHash: `ch-${externalId}`,
    metadata: { documentType: "file" },
    sourceCreatedAt: T,
    sourceUpdatedAt: T,
  };
}

const HUGE = 1_000_000;

describe("upsertDocuments yieldable chunking", () => {
  test("isolates a huge document without collapsing its siblings to one per chunk", () => {
    // Four ordinary documents, then one over the huge threshold, then two more.
    // A token that yields at the first opportunity reveals how big the first
    // chunk was: with chunkSize 5 the four ordinary leading documents belong in
    // it, and only the huge row deserves a chunk of its own.
    const documents = [
      doc("a", 100),
      doc("b", 100),
      doc("c", 100),
      doc("d", 100),
      doc("huge", HUGE),
      doc("e", 100),
      doc("f", 100),
    ];

    const first = upsertDocuments(db, documents, {
      token: { requested: () => true },
      chunkSize: 5,
    });
    expect(first.remaining.map((d) => d.externalId)).toEqual(["huge", "e", "f"]);

    // The huge row is the whole of the next chunk.
    const second = upsertDocuments(db, first.remaining, {
      token: { requested: () => true },
      chunkSize: 5,
    });
    expect(second.remaining.map((d) => d.externalId)).toEqual(["e", "f"]);

    // The tail batches again.
    const third = upsertDocuments(db, second.remaining, {
      token: { requested: () => true },
      chunkSize: 5,
    });
    expect(third.remaining).toEqual([]);

    const stored = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM documents").get();
    expect(stored?.c).toBe(documents.length);
  });

  test("a page of ordinary documents still chunks by chunkSize", () => {
    const documents = Array.from({ length: 7 }, (_, i) => doc(`n-${i}`, 100));
    const out = upsertDocuments(db, documents, {
      token: { requested: () => true },
      chunkSize: 5,
    });
    expect(out.remaining.map((d) => d.externalId)).toEqual(["n-5", "n-6"]);
  });
});

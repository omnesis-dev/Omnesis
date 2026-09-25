// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for the recency-browse path that answers restrictor-only
 * queries (`with:Maya`, `source:whatsapp-messages`, …) — the queries BM25
 * and the vector stage can't generate candidates for because they carry no
 * free-text terms.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { browseByRecency, shouldBrowse } from "./browse.js";
import type { SearchFilters } from "./types.js";

let db: Db;
let dbPath: string;
let rowid = 0;

// Minimal index DB: just the `chunks` columns browseByRecency reads.
beforeEach(() => {
  dbPath = `/tmp/omnesis-browse-${randomUUID()}.db`;
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE chunks (
      rowid INTEGER PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      document_type TEXT,
      title TEXT NOT NULL,
      source_url TEXT,
      source_created_at TEXT NOT NULL,
      author TEXT,
      tags TEXT,
      relevance_score REAL
    );
    CREATE TABLE pending_document_index_purges (
      document_id TEXT PRIMARY KEY,
      source_deleted INTEGER NOT NULL,
      queued_at INTEGER NOT NULL
    );
  `);
  rowid = 0;
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(dbPath + suffix, { force: true });
  }
});

function addChunk(opts: {
  documentId: string;
  chunkIndex?: number;
  sourceId?: string;
  documentType?: string;
  title?: string;
  createdAt: string;
  tags?: string;
}): void {
  db.prepare(
    `INSERT INTO chunks (rowid, document_id, chunk_index, source_id, document_type, title, source_url, source_created_at, author, tags, relevance_score)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL)`,
  ).run(
    ++rowid,
    opts.documentId,
    opts.chunkIndex ?? 0,
    opts.sourceId ?? "whatsapp-messages:test",
    opts.documentType ?? "conversation",
    opts.title ?? opts.documentId,
    opts.createdAt,
    opts.tags ?? null,
  );
}

describe("shouldBrowse", () => {
  const noFilters: SearchFilters = {};

  test("free text present → not a browse", () => {
    expect(shouldBrowse("hello", ["doc-1"], noFilters)).toBe(false);
  });

  test("blank text + person filter → browse", () => {
    expect(shouldBrowse("", ["doc-1"], noFilters)).toBe(true);
    expect(shouldBrowse("   ", ["doc-1"], noFilters)).toBe(true);
  });

  test("blank text + source filter (no person filter) → browse", () => {
    expect(shouldBrowse("", undefined, { sourceIds: ["whatsapp-messages:test"] })).toBe(true);
  });

  test("blank text + documentType filter → browse", () => {
    expect(shouldBrowse("", undefined, { documentTypes: ["conversation"] })).toBe(true);
  });

  test("blank text + date filter → browse", () => {
    expect(shouldBrowse("", undefined, { dateFrom: "2026-01-01" })).toBe(true);
  });

  test("blank text + tag filter → browse", () => {
    expect(shouldBrowse("", undefined, { tags: ["finance"] })).toBe(true);
  });

  test("blank text + NO restrictor → not a browse (don't dump the corpus)", () => {
    expect(shouldBrowse("", undefined, noFilters)).toBe(false);
  });

  test("person filter that resolved to zero docs (empty array) still counts as active", () => {
    // allowedDocumentIds=[] means the person filter resolved to no docs;
    // browseByRecency then returns [] — but the query IS a browse.
    expect(shouldBrowse("", [], noFilters)).toBe(true);
  });
});

describe("browseByRecency", () => {
  test("hides source-deleted documents while their bounded index purge is pending", () => {
    addChunk({ documentId: "pending", createdAt: "2026-06-02T00:00:00.000Z" });
    addChunk({ documentId: "visible", createdAt: "2026-06-01T00:00:00.000Z" });
    db.prepare(
      `INSERT INTO pending_document_index_purges (document_id, source_deleted, queued_at)
       VALUES (?, 1, ?)`,
    ).run("pending", Date.now());

    const out = browseByRecency(db, {}, ["pending", "visible"], 10);

    expect(out.map((candidate) => candidate.documentId)).toEqual(["visible"]);
  });

  test("lists documents newest-first within the allowed set", () => {
    addChunk({ documentId: "old", createdAt: "2026-01-01T00:00:00.000Z" });
    addChunk({ documentId: "new", createdAt: "2026-06-01T00:00:00.000Z" });
    addChunk({ documentId: "mid", createdAt: "2026-03-01T00:00:00.000Z" });

    const out = browseByRecency(db, {}, ["old", "new", "mid"], 10);
    expect(out.map((c) => c.documentId)).toEqual(["new", "mid", "old"]);
    // Score descends so a single-stage projection keeps the order.
    expect(out[0].score).toBeGreaterThan(out[1].score);
    expect(out[1].score).toBeGreaterThan(out[2].score);
  });

  test("emits exactly one representative (lowest chunk_index) per document", () => {
    addChunk({ documentId: "doc", chunkIndex: 2, createdAt: "2026-06-01T00:00:00.000Z" });
    addChunk({ documentId: "doc", chunkIndex: 0, createdAt: "2026-06-01T00:00:00.000Z" });
    addChunk({ documentId: "doc", chunkIndex: 1, createdAt: "2026-06-01T00:00:00.000Z" });

    const out = browseByRecency(db, {}, ["doc"], 10);
    expect(out).toHaveLength(1);
    expect(out[0].chunkRowid).toBe(2); // rowid of the chunk_index=0 row (inserted 2nd)
  });

  test("restricts to the allowed document set", () => {
    addChunk({ documentId: "in", createdAt: "2026-06-01T00:00:00.000Z" });
    addChunk({ documentId: "out", createdAt: "2026-06-02T00:00:00.000Z" });

    const out = browseByRecency(db, {}, ["in"], 10);
    expect(out.map((c) => c.documentId)).toEqual(["in"]);
  });

  test("empty allowed set → no results (person filter resolved to zero docs)", () => {
    addChunk({ documentId: "in", createdAt: "2026-06-01T00:00:00.000Z" });
    expect(browseByRecency(db, {}, [], 10)).toEqual([]);
  });

  test("undefined allowed set + source filter lists by source", () => {
    addChunk({
      documentId: "wa",
      sourceId: "whatsapp-messages:test",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    addChunk({ documentId: "mail", sourceId: "gmail:test", createdAt: "2026-06-02T00:00:00.000Z" });

    const out = browseByRecency(db, { sourceIds: ["whatsapp-messages:test"] }, undefined, 10);
    expect(out.map((c) => c.documentId)).toEqual(["wa"]);
  });

  test("documentType filter is honored", () => {
    addChunk({
      documentId: "conv",
      documentType: "conversation",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    addChunk({ documentId: "mail", documentType: "email", createdAt: "2026-06-02T00:00:00.000Z" });

    const out = browseByRecency(db, { documentTypes: ["conversation"] }, undefined, 10);
    expect(out.map((c) => c.documentId)).toEqual(["conv"]);
  });

  test("date range filter is honored (newest-first within range)", () => {
    addChunk({ documentId: "before", createdAt: "2025-12-15T00:00:00.000Z" });
    addChunk({ documentId: "early", createdAt: "2026-02-01T00:00:00.000Z" });
    addChunk({ documentId: "late", createdAt: "2026-05-01T00:00:00.000Z" });
    addChunk({ documentId: "after", createdAt: "2026-09-01T00:00:00.000Z" });

    const out = browseByRecency(
      db,
      { dateFrom: "2026-01-01", dateTo: "2026-06-30" },
      undefined,
      10,
    );
    expect(out.map((c) => c.documentId)).toEqual(["late", "early"]);
  });

  test("tag filter is honored (case-insensitive)", () => {
    addChunk({
      documentId: "tagged",
      createdAt: "2026-06-01T00:00:00.000Z",
      tags: '["Finance","Q3"]',
    });
    addChunk({
      documentId: "untagged",
      createdAt: "2026-06-02T00:00:00.000Z",
      tags: '["personal"]',
    });

    const out = browseByRecency(db, { tags: ["finance"] }, undefined, 10);
    expect(out.map((c) => c.documentId)).toEqual(["tagged"]);
  });

  test("respects the limit, keeping the newest", () => {
    addChunk({ documentId: "d1", createdAt: "2026-01-01T00:00:00.000Z" });
    addChunk({ documentId: "d2", createdAt: "2026-02-01T00:00:00.000Z" });
    addChunk({ documentId: "d3", createdAt: "2026-03-01T00:00:00.000Z" });

    const out = browseByRecency(db, {}, ["d1", "d2", "d3"], 2);
    expect(out.map((c) => c.documentId)).toEqual(["d3", "d2"]);
  });

  test("an allowed set far above SQLite's variable cap does not 500", () => {
    // A `with:`/`source:` browse on a very high-volume entity resolves to more
    // doc ids than SQLite's 32766 bound-variable limit. An inline IN-list
    // throws "too many SQL variables"; the temp-table path must absorb it.
    addChunk({ documentId: "real-new", createdAt: "2026-06-01T00:00:00.000Z" });
    addChunk({ documentId: "real-old", createdAt: "2026-01-01T00:00:00.000Z" });
    addChunk({ documentId: "noise", createdAt: "2026-03-01T00:00:00.000Z" });

    // 40000 ids (> 32766 cap, > INLINE_DOCID_LIMIT) — two real, the rest absent.
    const documentIds = ["real-new", "real-old"];
    for (let i = 0; i < 40000; i++) documentIds.push(`absent-${i}`);

    const out = browseByRecency(db, {}, documentIds, 10);
    expect(out.map((c) => c.documentId)).toEqual(["real-new", "real-old"]);
  });
});

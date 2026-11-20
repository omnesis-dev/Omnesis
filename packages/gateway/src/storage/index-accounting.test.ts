// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createIndexDatabase } from "../indexer/db.js";
import { directReadPort } from "../scheduler/read-port.js";
import {
  measureIndexStorageAccounting,
  storageIndexAccountingMetadata,
  storageIndexAccountingPage,
} from "./index-accounting.js";
const readIndexStorageAccounting = (db: Database.Database) =>
  measureIndexStorageAccounting(
    directReadPort({ storageIndexAccountingMetadata, storageIndexAccountingPage }, db),
  );

describe("index storage accounting", () => {
  it("attributes UTF-8 and vector payload by source and month independently from physical scans", async () => {
    const db = createIndexDatabase(":memory:");
    try {
      const insert = db.prepare(
        `INSERT INTO chunks(id,document_id,chunk_index,content,source_id,title,source_created_at,embedding) VALUES(?,?,?,?,?,?,?,?)`,
      );
      insert.run(
        "a",
        "doc-a",
        0,
        "café",
        "source:a",
        "A",
        "2031-01-12T00:00:00Z",
        Buffer.alloc(16),
      );
      insert.run(
        "b",
        "doc-b",
        0,
        "second",
        "source:a",
        "B",
        "2031-02-12T00:00:00Z",
        Buffer.alloc(32),
      );
      insert.run("c", "doc-c", 0, "third", "source:b", "C", "unknown", null);
      const measured = await readIndexStorageAccounting(db);
      expect(measured.embeddingBytes).toBe(48);
      expect(measured.sources).toEqual([
        { sourceId: "source:a", month: "2031-01", chunkCount: 1, textBytes: 6, embeddingBytes: 16 },
        { sourceId: "source:a", month: "2031-02", chunkCount: 1, textBytes: 7, embeddingBytes: 32 },
        { sourceId: "source:b", month: "unknown", chunkCount: 1, textBytes: 6, embeddingBytes: 0 },
      ]);
      expect(measured.tables).toBeNull();
      expect(measured.lexicalBytes).toBeNull();
      db.prepare("DELETE FROM chunks WHERE source_id=?").run("source:a");
      const after = await readIndexStorageAccounting(db);
      expect(after.embeddingBytes).toBe(0);
      expect(after.sources).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("scans beyond one page without dropping source or month attribution", async () => {
    const db = createIndexDatabase(":memory:");
    try {
      const insert = db.prepare(
        `INSERT INTO chunks(id,document_id,chunk_index,content,source_id,title,source_created_at,embedding) VALUES(?,?,0,'body','source:a','title','2031-01-12',?)`,
      );
      db.transaction(() => {
        for (let index = 0; index < 2100; index++)
          insert.run(`chunk-${index}`, `document-${index}`, Buffer.alloc(8));
      })();
      const measured = await readIndexStorageAccounting(db);
      expect(measured.sources).toEqual([
        {
          sourceId: "source:a",
          month: "2031-01",
          chunkCount: 2100,
          textBytes: 18900,
          embeddingBytes: 16800,
        },
      ]);
      expect(measured.embeddingBytes).toBe(16800);
    } finally {
      db.close();
    }
  });

  it("does not hide actual database failures as unsupported measurements", async () => {
    const db = new Database(":memory:");
    db.close();
    await expect(readIndexStorageAccounting(db)).rejects.toThrow();
  });
});

it("index pages seek under the initial ceiling and never run physical allocation", async () => {
  const db = createIndexDatabase(":memory:");
  try {
    const insert = db.prepare(
      "INSERT INTO chunks(id,document_id,chunk_index,content,source_id,title,embedding,source_created_at) VALUES(?,?,0,'café','invented-source','Entry',zeroblob(16),'2031-01-01T00:00:00Z')",
    );
    db.transaction(() => {
      for (let i = 0; i < 1001; i++) insert.run("c" + i, "d" + i);
    })();
    const queries = vi.spyOn(db, "prepare");
    const metadata = storageIndexAccountingMetadata(db);
    storageIndexAccountingPage(db, 0, metadata.upperRowid);
    const sql = queries.mock.calls
      .map((args) => args[0])
      .find((sql) => sql.includes("FROM chunks WHERE rowid"))!;
    expect(queries.mock.calls.map((args) => args[0]).join(" ")).not.toMatch(/dbstat/);
    queries.mockRestore();
    const plans = db.prepare("EXPLAIN QUERY PLAN " + sql).all(0, metadata.upperRowid) as Array<{
      detail: string;
    }>;
    expect(plans.map((p) => p.detail).join(" ")).toMatch(
      /SEARCH chunks USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/i,
    );
    expect(plans.map((p) => p.detail).join(" ")).not.toMatch(/TEMP B-TREE/);
    let pages = 0;
    const result = await measureIndexStorageAccounting({
      storageIndexAccountingMetadata: async () => metadata,
      storageIndexAccountingPage: async (after, upper) => {
        expect(db.inTransaction).toBe(false);
        const page = storageIndexAccountingPage(db, after, upper);
        insert.run("added" + pages, "added-doc" + pages);
        pages++;
        return page;
      },
    });
    expect(pages).toBe(2);
    expect(result.sources[0]!.chunkCount).toBe(1001);
    expect(result.embeddingBytes).toBe(1001 * 16);
  } finally {
    db.close();
  }
});

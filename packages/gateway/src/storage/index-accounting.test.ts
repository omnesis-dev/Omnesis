// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createIndexDatabase } from "../indexer/db.js";
import { readIndexStorageAccounting } from "./index-accounting.js";

describe("index storage accounting", () => {
  it("measures lexical allocation separately from vectors and attributes UTF-8 payload by source and month", async () => {
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
      if (measured.tables !== null) {
        expect(measured.lexicalBytes).toBeGreaterThan(0);
        expect(measured.tables.some((table) => table.name === "chunks")).toBe(true);
      } else expect(measured.lexicalBytes).toBeNull();
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

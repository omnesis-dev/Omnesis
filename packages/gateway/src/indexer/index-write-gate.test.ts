// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createIndexDatabase, EMBEDDING_DIM, upsertChunks } from "./db.js";
import {
  directIndexWriteGate,
  withFreshIndexWriteGate,
  workerCoordinatedIndexWriteGate,
} from "./index-write-gate.js";

function tmpPath(): string {
  return `/tmp/omnesis-index-gate-${randomUUID()}.db`;
}

function dummyChunk(id: string, documentId: string, sourceId = "test:1") {
  return {
    id,
    documentId,
    chunkIndex: 0,
    content: `content for ${id}`,
    embedding: new Float32Array(EMBEDDING_DIM).fill(0.01),
    sourceId,
    documentType: "email" as const,
    title: `title ${id}`,
    sourceCreatedAt: "2026-05-01T10:00:00Z",
  };
}

describe("directIndexWriteGate", () => {
  let path: string;
  beforeEach(() => {
    path = tmpPath();
  });
  afterEach(() => {
    try {
      rmSync(path);
    } catch {
      /* may not exist */
    }
    try {
      rmSync(`${path}-wal`);
    } catch {
      /* */
    }
    try {
      rmSync(`${path}-shm`);
    } catch {
      /* */
    }
  });

  test("upsertChunks writes through the gate", async () => {
    const db = createIndexDatabase(path);
    const gate = directIndexWriteGate(db);
    await gate.upsertChunks([dummyChunk("c-1", "doc-1")]);
    const row = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunks").get();
    expect(row?.c).toBe(1);
    db.close();
  });

  test("setIndexedDocument + setWatermark roundtrip", async () => {
    const db = createIndexDatabase(path);
    const gate = directIndexWriteGate(db);
    await gate.setIndexedDocument("doc-1", "hash-1", 3);
    await gate.setWatermark("test:1", "2026-05-01T10:00:00Z");
    expect(
      db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM indexed_documents").get()?.c,
    ).toBe(1);
    expect(
      db.prepare<[], { value: string }>("SELECT value FROM watermark WHERE key = 'test:1'").get()
        ?.value,
    ).toBe("2026-05-01T10:00:00Z");
    db.close();
  });

  test("deleteChunksByDocument returns the row count", async () => {
    const db = createIndexDatabase(path);
    upsertChunks(db, [dummyChunk("c-1", "doc-1")]);
    const gate = directIndexWriteGate(db);
    expect(await gate.deleteChunksByDocument("doc-1")).toBe(1);
    expect(await gate.deleteChunksByDocument("doc-2")).toBe(0); // already gone
    db.close();
  });

  test("deleteChunksByDocuments aggregates the totals", async () => {
    const db = createIndexDatabase(path);
    upsertChunks(db, [
      dummyChunk("c-1", "doc-1"),
      dummyChunk("c-2", "doc-2"),
      dummyChunk("c-3", "doc-3"),
    ]);
    const gate = directIndexWriteGate(db);
    expect(await gate.deleteChunksByDocuments(["doc-1", "doc-2", "missing"])).toBe(2);
    db.close();
  });

  test("deleteIndexBySource returns the indexed-document count it cleared", async () => {
    const db = createIndexDatabase(path);
    upsertChunks(db, [
      dummyChunk("c-1", "doc-1", "src:a"),
      dummyChunk("c-2", "doc-2", "src:a"),
      dummyChunk("c-3", "doc-3", "src:b"),
    ]);
    const gate = directIndexWriteGate(db);
    expect(await gate.deleteIndexBySource("src:a")).toBe(2);
    expect(await gate.deleteIndexBySource("src:c")).toBe(0); // never had any
    // src:b's row survives
    expect(
      db
        .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?")
        .get("src:b")?.c,
    ).toBe(1);
    db.close();
  });

  test("wipeAndRecreateVectorIndex clears vectors but preserves chunk text and the document event clock", async () => {
    const db = createIndexDatabase(path);
    upsertChunks(db, [dummyChunk("c-1", "doc-1")]);
    const gate = directIndexWriteGate(db);
    await gate.setIndexedDocument("doc-1", "hash-1", 1);
    const before = db
      .prepare<
        [],
        { source_event_at: string; event_indexed_at: string }
      >("SELECT source_event_at, event_indexed_at FROM indexed_documents WHERE document_id = 'doc-1'")
      .get();
    await gate.wipeAndRecreateVectorIndex(EMBEDDING_DIM, "test-model");
    // Chunk text stays so BM25 keeps answering during the rebuild; only the
    // derived vector goes.
    expect(db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunks").get()?.c).toBe(1);
    expect(
      db
        .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NOT NULL")
        .get()?.c,
    ).toBe(0);
    expect(
      db
        .prepare<
          [],
          {
            content_hash: string;
            chunk_count: number;
            source_event_at: string;
            event_indexed_at: string;
          }
        >(
          `SELECT content_hash, chunk_count, source_event_at, event_indexed_at
             FROM indexed_documents
            WHERE document_id = 'doc-1'`,
        )
        .get(),
    ).toEqual({
      content_hash: "",
      chunk_count: 1,
      source_event_at: before?.source_event_at,
      event_indexed_at: before?.event_indexed_at,
    });
    db.close();
  });
});

describe("workerCoordinatedIndexWriteGate", () => {
  let path: string;
  beforeEach(() => {
    path = tmpPath();
  });
  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(`${path}${suffix}`);
      } catch {
        /* may not exist */
      }
    }
  });

  test("routes deleteIndexBySource through the worker when one is running", async () => {
    const db = createIndexDatabase(path);
    upsertChunks(db, [dummyChunk("c-1", "doc-1", "src:a")]);
    let workerCalledWith: string | null = null;
    const gate = workerCoordinatedIndexWriteGate(db, (sourceId) => {
      workerCalledWith = sourceId;
      return Promise.resolve(42);
    });

    // The worker owns the deletion; the direct path must NOT run (chunks stay,
    // since the fake worker doesn't touch the DB).
    expect(await gate.deleteIndexBySource("src:a")).toBe(42);
    expect(workerCalledWith).toBe("src:a");
    expect(
      db
        .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?")
        .get("src:a")?.c,
    ).toBe(1);
    db.close();
  });

  test("falls back to the direct path when no worker is running", async () => {
    const db = createIndexDatabase(path);
    upsertChunks(db, [dummyChunk("c-1", "doc-1", "src:a"), dummyChunk("c-2", "doc-2", "src:a")]);
    // deleteViaWorker returns undefined → no worker → direct delete runs.
    const gate = workerCoordinatedIndexWriteGate(db, () => undefined);

    expect(await gate.deleteIndexBySource("src:a")).toBe(2);
    expect(
      db
        .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?")
        .get("src:a")?.c,
    ).toBe(0);
    db.close();
  });

  test("non-delete ops always use the direct in-process path", async () => {
    const db = createIndexDatabase(path);
    const gate = workerCoordinatedIndexWriteGate(db, () => {
      throw new Error("worker must not be consulted for non-delete ops");
    });
    await gate.upsertChunks([dummyChunk("c-1", "doc-1")]);
    expect(db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunks").get()?.c).toBe(1);
    db.close();
  });
});

describe("withFreshIndexWriteGate", () => {
  let path: string;
  beforeEach(() => {
    path = tmpPath();
  });
  afterEach(() => {
    try {
      rmSync(path);
    } catch {
      /* */
    }
    try {
      rmSync(`${path}-wal`);
    } catch {
      /* */
    }
    try {
      rmSync(`${path}-shm`);
    } catch {
      /* */
    }
  });

  test("opens, runs the op, closes — handle is gone after the call", async () => {
    // Ensure the schema exists first so the with-helper isn't the
    // first to create it (matches the model-swap shape: the file
    // already has the schema from boot's createIndexDatabase).
    const boot = createIndexDatabase(path);
    upsertChunks(boot, [dummyChunk("c-1", "doc-1")]);
    boot.close();

    let opRan = 0;
    await withFreshIndexWriteGate(path, async (gate) => {
      opRan += 1;
      await gate.wipeAndRecreateVectorIndex(EMBEDDING_DIM, "swapped-model");
    });
    expect(opRan).toBe(1);

    // Reopen and verify the op happened (vectors gone, model name set).
    const after = createIndexDatabase(path);
    expect(
      after
        .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE embedding IS NOT NULL")
        .get()?.c,
    ).toBe(0);
    expect(
      after
        .prepare<
          [],
          { value: string }
        >("SELECT value FROM index_meta WHERE key = 'embed_model_name'")
        .get()?.value,
    ).toBe("swapped-model");
    after.close();
  });

  test("propagates the op's return value", async () => {
    const boot = createIndexDatabase(path);
    upsertChunks(boot, [dummyChunk("c-1", "doc-1")]);
    boot.close();
    const removed = await withFreshIndexWriteGate(path, (gate) =>
      gate.deleteChunksByDocument("doc-1"),
    );
    expect(removed).toBe(1);
  });

  test("closes the handle even when the op throws", async () => {
    // If the helper leaked a handle on throw, a subsequent
    // createIndexDatabase + close cycle would still work but later
    // tests' WAL cleanup could fail. Assert the throw bubbles up.
    const boot = createIndexDatabase(path);
    boot.close();
    await expect(
      withFreshIndexWriteGate(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Subsequent open works, proving the file isn't locked by a leak.
    const after = createIndexDatabase(path);
    after.close();
  });
});

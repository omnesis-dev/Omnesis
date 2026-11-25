// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A document delete whose search cleanup cannot finish in the same request.
 *
 * The index writer removes a deleted document's chunks in bounded batches and
 * records the purge durably first: search hides the chunks from then on, and
 * the writer finishes the purge once its in-flight indexing cycle ends or over
 * later batches. Each delete route therefore succeeds while that cleanup is
 * still pending, rather than reporting a failure for a delete that committed.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join as fixtureJoin } from "node:path";
import { tmpdir as fixtureTmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL } from "@omnesis/types";
import { createFreshTestDatabase } from "../../testing/fresh-database.js";
import { createServer } from "../../server.js";
import { createIndexDatabase, EMBEDDING_DIM, upsertChunks } from "../../indexer/db.js";
import { purgeDocumentIndexBatch } from "../../indexer/document-index-purge.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const PROVIDER = "google";
const SOURCE = "gmail";

let db: Db;
let indexDb: Db;
let dbPath: string;
let indexDbPath: string;
let token: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

/**
 * A server whose index writer answers the way the indexer worker does while an
 * indexing cycle holds its latch: the batch is applied and durably queued, but
 * reported incomplete until the cycle ends and the queued purge is re-applied.
 */
function serverWithIndexCycle(cycleInFlight: () => boolean) {
  return createServer(db, dbPath, {
    indexDb,
    indexerControl: {
      reindexMissing: async () => ({ indexed: 0, errors: 0 }),
      deleteDocumentsIndexBatch: async (ids, limit, sourceDeleted) =>
        purgeDocumentIndexBatch({ indexDb }, ids, limit, sourceDeleted, cycleInFlight()),
    },
  });
}

function request(app: ReturnType<typeof createServer>, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
}

function doc(externalId: string) {
  return {
    providerId: PROVIDER,
    sourceId: SOURCE,
    externalId,
    title: `Doc ${externalId}`,
    content: `# ${externalId}`,
    contentHash: `hash-${externalId}`,
    metadata: {},
    sourceCreatedAt: "2026-03-02T10:00:00Z",
    sourceUpdatedAt: "2026-03-02T10:00:00Z",
  };
}

async function ingest(app: ReturnType<typeof createServer>, externalId: string, chunks = 1) {
  const res = await request(app, "/documents", {
    method: "POST",
    body: JSON.stringify({ documents: [doc(externalId)] }),
  });
  expect(res.status).toBe(200);
  const id = db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
  upsertChunks(
    indexDb,
    Array.from({ length: chunks }, (_, index) => ({
      id: `${externalId}-chunk-${index}`,
      documentId: id,
      chunkIndex: index,
      content: `content ${index}`,
      embedding: new Float32Array(EMBEDDING_DIM).fill(0.01),
      sourceId: SOURCE,
      documentType: "email" as const,
      title: `Doc ${externalId}`,
      sourceCreatedAt: "2026-03-02T10:00:00Z",
    })),
  );
  return id;
}

function chunkCount(documentId: string): number {
  return indexDb
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM chunks WHERE document_id = ?",
    )
    .get(documentId)!.count;
}

function pendingPurge(documentId: string): { source_deleted: number } | undefined {
  return indexDb
    .prepare<[string], { source_deleted: number }>(
      "SELECT source_deleted FROM pending_document_index_purges WHERE document_id = ?",
    )
    .get(documentId);
}

function documentExists(documentId: string): boolean {
  return db.prepare("SELECT 1 FROM documents WHERE id = ?").get(documentId) !== undefined;
}

beforeEach(() => {
  dbPath = fixtureJoin(fixtureTmpdir(), `omnesis-delete-pending-${randomUUID()}.db`);
  indexDbPath = fixtureJoin(fixtureTmpdir(), `omnesis-delete-pending-index-${randomUUID()}.db`);
  db = createFreshTestDatabase(dbPath);
  indexDb = createIndexDatabase(indexDbPath);
  const device = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  token = createToken(db, device.id, [SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]).token;
});

afterEach(() => {
  db.close();
  indexDb.close();
  cleanupDb(dbPath);
  cleanupDb(indexDbPath);
});

describe("DELETE /documents/:id with search cleanup still pending", () => {
  test("succeeds while an indexing cycle is in flight, and the queued purge finishes after it", async () => {
    let cycleInFlight = false;
    const app = serverWithIndexCycle(() => cycleInFlight);
    const id = await ingest(app, "msg-1");
    cycleInFlight = true;

    const res = await request(app, `/documents/${id}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
    expect(documentExists(id)).toBe(false);
    expect(
      db.prepare("SELECT 1 FROM removed_documents WHERE external_id = 'msg-1'").get(),
    ).toBeDefined();
    // The purge is durable and hides the document from search until it is done.
    expect(pendingPurge(id)).toEqual({ source_deleted: 1 });

    // The cycle ends; the writer re-applies its queued purges.
    cycleInFlight = false;
    purgeDocumentIndexBatch({ indexDb }, [id], 64, true, false);
    expect(pendingPurge(id)).toBeUndefined();
    expect(chunkCount(id)).toBe(0);
  });

  test("succeeds for a document with more chunks than one purge batch removes", async () => {
    const app = serverWithIndexCycle(() => false);
    const id = await ingest(app, "long-1", 65);

    const res = await request(app, `/documents/${id}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 1 });
    expect(documentExists(id)).toBe(false);
    expect(chunkCount(id)).toBe(1);
    expect(pendingPurge(id)).toEqual({ source_deleted: 1 });
  });
});

describe("sync tombstones with search cleanup still pending", () => {
  test("POST /documents/delete succeeds while an indexing cycle is in flight", async () => {
    let cycleInFlight = false;
    const app = serverWithIndexCycle(() => cycleInFlight);
    const id = await ingest(app, "msg-1");
    cycleInFlight = true;

    const res = await request(app, "/documents/delete", {
      method: "POST",
      body: JSON.stringify({ providerId: PROVIDER, sourceId: SOURCE, externalIds: ["msg-1"] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 1 });
    expect(documentExists(id)).toBe(false);
    expect(pendingPurge(id)).toEqual({ source_deleted: 1 });
  });

  test("a cursor page's tombstones commit and leave the index cleanup for the sweep", async () => {
    let cycleInFlight = false;
    const app = serverWithIndexCycle(() => cycleInFlight);
    const id = await ingest(app, "msg-1");
    cycleInFlight = true;

    const res = await request(app, "/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: PROVIDER,
        sourceId: SOURCE,
        deletedExternalIds: ["msg-1"],
        hasMore: true,
        cursor: { page: 2 },
      }),
    });

    expect(res.status).toBe(200);
    expect(documentExists(id)).toBe(false);
    expect(pendingPurge(id)).toEqual({ source_deleted: 1 });
    // The page's cascade outbox keeps its index half for the absence sweep.
    expect(
      db
        .prepare<[], { index_done: number; cognition_done: number }>(
          "SELECT index_done, cognition_done FROM snapshot_absence_cascade_outbox",
        )
        .all(),
    ).toEqual([{ index_done: 0, cognition_done: 1 }]);
  });
});

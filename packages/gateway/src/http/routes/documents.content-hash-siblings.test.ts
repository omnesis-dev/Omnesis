// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createIndexDatabase, setIndexedDocument } from "../../indexer/db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let indexDb: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let indexDbPath: string;
let token: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function req(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
}

async function ingest(externalId: string, contentHash: string): Promise<string> {
  const res = await req("/documents", {
    method: "POST",
    body: JSON.stringify({
      documents: [
        {
          providerId: "google",
          sourceId: "gmail",
          externalId,
          title: `Doc ${externalId}`,
          content: `# ${externalId}`,
          contentHash,
          metadata: {},
          sourceCreatedAt: "2024-01-15T10:00:00Z",
          sourceUpdatedAt: "2024-01-15T10:00:00Z",
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId);
  expect(row).toBeTruthy();
  return row!.id;
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-content-hash-test-${randomUUID()}.db`;
  indexDbPath = `/tmp/omnesis-content-hash-index-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  indexDb = createIndexDatabase(indexDbPath);
  token = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
  app = createServer(db, dbPath, { indexDb });
});

afterEach(() => {
  db.close();
  indexDb.close();
  cleanupDb(dbPath);
  cleanupDb(indexDbPath);
});

describe("POST /documents/content-hash-siblings", () => {
  test("rejects empty documentIds array (400)", async () => {
    const res = await req("/documents/content-hash-siblings", {
      method: "POST",
      body: JSON.stringify({ documentIds: [] }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects missing documentIds (400)", async () => {
    const res = await req("/documents/content-hash-siblings", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("requires read scope", async () => {
    const res = await app.request("/documents/content-hash-siblings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentIds: ["x"] }),
    });
    expect(res.status).toBe(401);
  });

  test("single indexed doc with no siblings returns [self]", async () => {
    const id = await ingest("alone", "hash-alone");
    setIndexedDocument(indexDb, id, "hash-alone", 1);

    const res = await req("/documents/content-hash-siblings", {
      method: "POST",
      body: JSON.stringify({ documentIds: [id] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { siblings: Record<string, string[]> };
    expect(data.siblings[id]).toEqual([id]);
  });

  test("two docs sharing content_hash both list each other", async () => {
    const idA = await ingest("a", "hash-shared");
    const idB = await ingest("b", "hash-shared");
    setIndexedDocument(indexDb, idA, "hash-shared", 1);
    setIndexedDocument(indexDb, idB, "hash-shared", 1);

    const res = await req("/documents/content-hash-siblings", {
      method: "POST",
      body: JSON.stringify({ documentIds: [idA, idB] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { siblings: Record<string, string[]> };
    expect(new Set(data.siblings[idA])).toEqual(new Set([idA, idB]));
    expect(new Set(data.siblings[idB])).toEqual(new Set([idA, idB]));
    // "Self first" ordering — input docId is index 0 in its own list.
    expect(data.siblings[idA]![0]).toBe(idA);
    expect(data.siblings[idB]![0]).toBe(idB);
  });

  test("input docId sharing a hash with a non-input docId pulls in the third", async () => {
    // Input asks for idA; idC also shares its hash but wasn't in the
    // input — it should still surface in idA's sibling list.
    const idA = await ingest("a", "hash-shared");
    const idC = await ingest("c", "hash-shared");
    setIndexedDocument(indexDb, idA, "hash-shared", 1);
    setIndexedDocument(indexDb, idC, "hash-shared", 1);

    const res = await req("/documents/content-hash-siblings", {
      method: "POST",
      body: JSON.stringify({ documentIds: [idA] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { siblings: Record<string, string[]> };
    expect(new Set(data.siblings[idA])).toEqual(new Set([idA, idC]));
  });

  test("docs with different hashes do not bleed into each other's groups", async () => {
    const idA = await ingest("a", "hash-1");
    const idB = await ingest("b", "hash-2");
    setIndexedDocument(indexDb, idA, "hash-1", 1);
    setIndexedDocument(indexDb, idB, "hash-2", 1);

    const res = await req("/documents/content-hash-siblings", {
      method: "POST",
      body: JSON.stringify({ documentIds: [idA, idB] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { siblings: Record<string, string[]> };
    expect(data.siblings[idA]).toEqual([idA]);
    expect(data.siblings[idB]).toEqual([idB]);
  });

  test("unindexed doc returns [self] (degrades gracefully)", async () => {
    const id = await ingest("not-indexed", "h-x");
    // Deliberately do NOT call setIndexedDocument — indexer hasn't run.

    const res = await req("/documents/content-hash-siblings", {
      method: "POST",
      body: JSON.stringify({ documentIds: [id] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { siblings: Record<string, string[]> };
    expect(data.siblings[id]).toEqual([id]);
  });

  test("mix of indexed-with-siblings, indexed-alone, unindexed inputs", async () => {
    const idA = await ingest("a", "shared");
    const idB = await ingest("b", "shared");
    const idC = await ingest("c", "alone");
    const idD = await ingest("d", "no-index");
    setIndexedDocument(indexDb, idA, "shared", 1);
    setIndexedDocument(indexDb, idB, "shared", 1);
    setIndexedDocument(indexDb, idC, "alone", 1);
    // idD intentionally left unindexed.

    const res = await req("/documents/content-hash-siblings", {
      method: "POST",
      body: JSON.stringify({ documentIds: [idA, idC, idD] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { siblings: Record<string, string[]> };
    expect(new Set(data.siblings[idA])).toEqual(new Set([idA, idB]));
    expect(data.siblings[idC]).toEqual([idC]);
    expect(data.siblings[idD]).toEqual([idD]);
  });

  test("duplicate input docIds are deduped in the response", async () => {
    const idA = await ingest("a", "shared");
    setIndexedDocument(indexDb, idA, "shared", 1);

    const res = await req("/documents/content-hash-siblings", {
      method: "POST",
      body: JSON.stringify({ documentIds: [idA, idA, idA] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { siblings: Record<string, string[]> };
    expect(Object.keys(data.siblings)).toEqual([idA]);
    expect(data.siblings[idA]).toEqual([idA]);
  });

  test("over-cap input is rejected at the schema boundary", async () => {
    // Schema caps at 500.
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const res = await req("/documents/content-hash-siblings", {
      method: "POST",
      body: JSON.stringify({ documentIds: ids }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /documents/content-hash-siblings without an index DB", () => {
  let dbPath2: string;
  let db2: Db;
  let app2: ReturnType<typeof createServer>;
  let token2: string;

  beforeEach(() => {
    dbPath2 = `/tmp/omnesis-content-hash-noindex-${randomUUID()}.db`;
    db2 = createDatabase(dbPath2);
    const dev = createDevice(db2, { name: "x", kind: "cli" });
    token2 = createToken(db2, dev.id, [SCOPE_READ, SCOPE_WRITE_ALL]).token;
    // No indexDb passed — exercises the early-return path.
    app2 = createServer(db2, dbPath2);
  });

  afterEach(() => {
    db2.close();
    cleanupDb(dbPath2);
  });

  test("degrades to identity (each input maps to [self])", async () => {
    const res = await app2.request("/documents/content-hash-siblings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token2}`,
      },
      body: JSON.stringify({ documentIds: ["x", "y"] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { siblings: Record<string, string[]> };
    expect(data.siblings).toEqual({ x: ["x"], y: ["y"] });
  });
});

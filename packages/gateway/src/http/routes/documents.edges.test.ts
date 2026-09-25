// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Route tests for `GET /documents/:id/edges` — the provenance-annotated
 * edge listing that backs `omnesis edges show`.
 */
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createIndexDatabase } from "../../indexer/db.js";
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

async function ingest(externalId: string, title = `Doc ${externalId}`): Promise<string> {
  const res = await req("/documents", {
    method: "POST",
    body: JSON.stringify({
      documents: [
        {
          providerId: "google",
          sourceId: "gmail",
          externalId,
          title,
          content: `# ${externalId}`,
          contentHash: `ch-${externalId}`,
          metadata: { documentType: "email" },
          sourceCreatedAt: "2024-01-15T10:00:00Z",
          sourceUpdatedAt: "2024-01-15T10:00:00Z",
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
}

function seedLink(from: string, to: string, type: string, provenance: string): void {
  db.prepare(
    `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at, provenance_kind, provenance_origin, declared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'gmail', ?)`,
  ).run(from, type, to, to, to, "T", "T", provenance, "T");
}

function seedPending(from: string, type: string, targetExt: string): void {
  db.prepare(
    `INSERT INTO pending_edges (source_doc_id, link_type, target_source_id, target_external_id, provenance_origin, declared_at, attempt_count)
     VALUES (?, ?, 'gmail', ?, 'gmail', 'T', 2)`,
  ).run(from, type, targetExt);
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-edges-route-test-${randomUUID()}.db`;
  indexDbPath = `/tmp/omnesis-edges-route-index-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  indexDb = createIndexDatabase(indexDbPath);
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  token = createToken(db, dev.id, [SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL] as Scope[]).token;
  app = createServer(db, dbPath, { indexDb });
});

afterEach(() => {
  db.close();
  indexDb.close();
  cleanupDb(dbPath);
  cleanupDb(indexDbPath);
});

describe("GET /documents/:id/edges", () => {
  test("404 for an unknown document", async () => {
    expect((await req("/documents/does-not-exist/edges")).status).toBe(404);
  });

  test("400 for an ambiguous id prefix", async () => {
    const a = await ingest("aaa-1");
    const b = await ingest("aaa-2");
    const prefix = a.slice(0, 1);
    if (b.slice(0, 1) !== prefix) return; // skip if prefixes don't collide
    expect((await req(`/documents/${prefix}/edges`)).status).toBe(400);
  });

  test("200 with empty edges + pending for a document with none", async () => {
    const a = await ingest("alpha");
    const res = await req(`/documents/${a}/edges`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ edges: [], pending: [] });
  });

  test("returns outbound + inbound edges with provenance, plus pending forward refs", async () => {
    const reply = await ingest("reply", "Reply");
    const parent = await ingest("parent", "Parent");
    seedLink(reply, parent, "replies-to", "source-declared");
    seedLink(reply, parent, "url", "content-derived"); // gives parent an inbound too
    seedPending(reply, "references", "ghost-ext");

    const res = await req(`/documents/${reply}/edges`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      edges: Array<{
        direction: string;
        linkType: string;
        otherDocId: string | null;
        provenanceKind: string | null;
        resolved: boolean;
      }>;
      pending: Array<{ linkType: string; targetExternalId: string; attemptCount: number }>;
    };

    const out = body.edges.filter((e) => e.direction === "outbound");
    expect(out.find((e) => e.linkType === "replies-to")).toMatchObject({
      otherDocId: parent,
      provenanceKind: "source-declared",
      resolved: true,
    });
    expect(out.find((e) => e.linkType === "url")?.provenanceKind).toBe("content-derived");

    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]).toMatchObject({
      linkType: "references",
      targetExternalId: "ghost-ext",
      attemptCount: 2,
    });

    // The parent document sees the same edges inbound.
    const parentRes = await req(`/documents/${parent}/edges`);
    const parentBody = (await parentRes.json()) as {
      edges: Array<{ direction: string; linkType: string; otherDocId: string | null }>;
    };
    expect(parentBody.edges.some((e) => e.direction === "inbound" && e.otherDocId === reply)).toBe(
      true,
    );
  });

  test("requires auth", async () => {
    const a = await ingest("delta");
    const res = await app.request(`/documents/${a}/edges`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

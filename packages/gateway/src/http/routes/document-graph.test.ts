// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let token: string;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function req(path: string, init: RequestInit = {}): Promise<Response> {
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
          content: `body ${externalId}`,
          contentHash: `ch-${externalId}`,
          metadata: { documentType: "email" },
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

function seedLink(sourceDocId: string, linkType: string, targetDocId: string): void {
  db.prepare(
    `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target,
        target_doc_id, resolved_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourceDocId,
    linkType,
    targetDocId,
    targetDocId,
    targetDocId,
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
  );
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-doc-graph-route-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  token = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
  app = createServer(db, dbPath);
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("GET /documents/:id/graph", () => {
  test("returns 404 for an unknown document", async () => {
    const res = await req("/documents/does-not-exist/graph");
    expect(res.status).toBe(404);
  });

  test("returns the seed and no edges for an isolated document", async () => {
    const a = await ingest("iso-1");
    const res = await req(`/documents/${a}/graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seeds: string[];
      vertices: Array<{ id: string; kind: string; depth: number }>;
      edges: unknown[];
      truncated: boolean;
    };
    expect(body.seeds).toEqual([`doc:${a}`]);
    expect(body.vertices).toHaveLength(1);
    expect(body.vertices[0]!.kind).toBe("document");
    expect(body.vertices[0]!.depth).toBe(0);
    expect(body.edges).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  test("multi-seed: ?seeds=… adds extra seeds beyond the path id", async () => {
    const a = await ingest("multi-a");
    const b = await ingest("multi-b");
    const res = await req(`/documents/${a}/graph?seeds=${b}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seeds: string[];
      vertices: Array<{ id: string; depth: number }>;
    };
    expect(body.seeds).toEqual([`doc:${a}`, `doc:${b}`]);
    expect(body.vertices.map((v) => v.id).sort()).toEqual([`doc:${a}`, `doc:${b}`].sort());
    // Both seeds at depth 0.
    for (const v of body.vertices) expect(v.depth).toBe(0);
  });

  test("multi-seed: disjoint seeds produce a graph with two clusters", async () => {
    const a = await ingest("disjoint-a");
    const b = await ingest("disjoint-b");
    const c = await ingest("disjoint-c");
    // Only b—att—c is linked. Seeding a + b should still surface a as
    // its own singleton.
    seedLink(b, "contains", c);
    const res = await req(`/documents/${a}/graph?seeds=${b}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seeds: string[];
      vertices: Array<{ id: string }>;
      edges: Array<{ from: string; to: string }>;
    };
    expect(body.seeds).toEqual([`doc:${a}`, `doc:${b}`]);
    expect(body.vertices.map((v) => v.id).sort()).toEqual(
      [`doc:${a}`, `doc:${b}`, `doc:${c}`].sort(),
    );
    expect(body.edges).toHaveLength(1);
  });

  test("multi-seed: 404 if any seed is missing", async () => {
    const a = await ingest("missing-one-a");
    const res = await req(`/documents/${a}/graph?seeds=does-not-exist`);
    expect(res.status).toBe(404);
  });

  test("multi-seed: tolerates blank entries in the seeds list", async () => {
    const a = await ingest("blank-a");
    const b = await ingest("blank-b");
    const res = await req(`/documents/${a}/graph?seeds=${b},,`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { seeds: string[] };
    expect(body.seeds).toEqual([`doc:${a}`, `doc:${b}`]);
  });

  test("walks document_links and emits typed directed edges", async () => {
    const a = await ingest("link-a");
    const b = await ingest("link-b");
    seedLink(a, "contains", b);
    const res = await req(`/documents/${a}/graph?depth=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      vertices: Array<{ id: string }>;
      edges: Array<{ from: string; to: string; type: string; directed: boolean }>;
    };
    expect(body.vertices.map((v) => v.id).sort()).toEqual([`doc:${a}`, `doc:${b}`].sort());
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0]).toMatchObject({
      from: `doc:${a}`,
      to: `doc:${b}`,
      type: "contains",
      directed: true,
    });
  });

  test("clamps the depth query param into [1, 15]", async () => {
    const a = await ingest("clamp-a");
    const b = await ingest("clamp-b");
    seedLink(a, "contains", b);
    const res = await req(`/documents/${a}/graph?depth=9999`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vertices: unknown[] };
    expect((body.vertices as Array<unknown>).length).toBeGreaterThanOrEqual(2);
  });

  test("requires auth", async () => {
    const a = await ingest("auth-a");
    const res = await app.request(`/documents/${a}/graph`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /documents/:id/refs/:direction", () => {
  test("keyset-pages inbound and outbound refs with a document/direction-bound cursor", async () => {
    const center = await ingest("refs-center");
    const targets = await Promise.all(
      ["refs-target-a", "refs-target-b", "refs-target-c"].map((id) => ingest(id)),
    );
    for (const target of targets) seedLink(center, "references", target);

    const firstOutbound = (await (
      await req(`/documents/${center}/refs/outbound?limit=2`)
    ).json()) as {
      items: Array<{ targetDocId: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(firstOutbound.items.map((ref) => ref.targetDocId)).toEqual(targets.slice(0, 2));
    expect(firstOutbound.pageInfo.hasMore).toBe(true);
    const outboundCursor = encodeURIComponent(firstOutbound.pageInfo.nextCursor!);
    const secondOutbound = (await (
      await req(`/documents/${center}/refs/outbound?limit=2&cursor=${outboundCursor}`)
    ).json()) as { items: Array<{ targetDocId: string }>; pageInfo: { hasMore: boolean } };
    expect(secondOutbound.items.map((ref) => ref.targetDocId)).toEqual(targets.slice(2));
    expect(secondOutbound.pageInfo.hasMore).toBe(false);
    expect((await req(`/documents/${center}/refs/inbound?cursor=${outboundCursor}`)).status).toBe(
      400,
    );
    expect(
      (await req(`/documents/${targets[0]}/refs/outbound?cursor=${outboundCursor}`)).status,
    ).toBe(400);

    const inboundCenter = await ingest("refs-inbound-center");
    const sources = await Promise.all(
      ["refs-source-a", "refs-source-b", "refs-source-c"].map((id) => ingest(id)),
    );
    for (const source of sources) seedLink(source, "references", inboundCenter);
    const firstInbound = (await (
      await req(`/documents/${inboundCenter}/refs/inbound?limit=2`)
    ).json()) as {
      items: Array<{ sourceDocId: string }>;
      pageInfo: { nextCursor?: string };
    };
    const secondInbound = (await (
      await req(
        `/documents/${inboundCenter}/refs/inbound?limit=2&cursor=${encodeURIComponent(firstInbound.pageInfo.nextCursor!)}`,
      )
    ).json()) as { items: Array<{ sourceDocId: string }> };
    expect(
      new Set([...firstInbound.items, ...secondInbound.items].map((ref) => ref.sourceDocId)),
    ).toEqual(new Set(sources));
  });
});

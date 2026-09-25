// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createIndexDatabase } from "../../indexer/db.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { setActiveAlgoVersion } from "../../near-dupes/meta.js";
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
          content: `# ${externalId}\n${"body content ".repeat(40)}`,
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

function seedEdge(
  docA: string,
  docB: string,
  algo: string,
  opts: { jaccard?: number; df2?: number; df5?: number; cm?: number; family?: string } = {},
): void {
  const [a, b] = docA < docB ? [docA, docB] : [docB, docA];
  db.prepare(
    `INSERT INTO near_dup_edges (doc_a, doc_b, algo_version, jaccard,
       pair_unique_df2, pair_unique_df5, containment_min, gate_family, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a,
    b,
    algo,
    opts.jaccard ?? 0.9,
    opts.df2 ?? 5,
    opts.df5 ?? 10,
    opts.cm ?? 0.95,
    opts.family ?? "email",
    0,
  );
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-near-dupes-test-${randomUUID()}.db`;
  indexDbPath = `/tmp/omnesis-near-dupes-index-${randomUUID()}.db`;
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

describe("GET /documents/:id/near-dupes", () => {
  test("returns 404 for an unknown document", async () => {
    const res = await req("/documents/does-not-exist/near-dupes");
    expect(res.status).toBe(404);
  });

  test("returns 400 for an ambiguous id prefix", async () => {
    const a = await ingest("aaa-1");
    const b = await ingest("aaa-2");
    const sharedPrefix = a.slice(0, 1);
    if (b.slice(0, 1) !== sharedPrefix) return; // skip if prefixes don't collide
    const res = await req(`/documents/${sharedPrefix}/near-dupes`);
    expect(res.status).toBe(400);
  });

  test("returns empty list + null cursor when no near-dups exist", async () => {
    const a = await ingest("alpha-1");
    const res = await req(`/documents/${a}/near-dupes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: unknown[]; nextCursor: string | null };
    expect(body).toEqual({ edges: [], nextCursor: null });
  });

  test("returns edges joined with the other doc's title + source", async () => {
    const a = await ingest("beta-1");
    const b = await ingest("beta-2", "Other title");
    setActiveAlgoVersion(db, "v1");
    seedEdge(a, b, "v1");
    const res = await req(`/documents/${a}/near-dupes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      edges: Array<{
        otherDocId: string;
        otherTitle: string;
        otherSourceId: string;
        otherDocType: string;
        jaccard: number;
        pairUniqueDf2: number;
        pairUniqueDf5: number;
        containmentMin: number;
        gateFamily: string;
      }>;
      nextCursor: string | null;
    };
    expect(body.edges).toHaveLength(1);
    expect(body.edges[0]).toMatchObject({
      otherDocId: b,
      otherTitle: "Other title",
      otherSourceId: "gmail",
      otherDocType: "email",
      jaccard: 0.9,
      pairUniqueDf2: 5,
      gateFamily: "email",
    });
    expect(body.nextCursor).toBeNull();
  });

  test("paginates via ?limit and ?after", async () => {
    setActiveAlgoVersion(db, "v1");
    const a = await ingest("gamma-1");
    for (const tag of ["x", "y", "z"]) {
      const other = await ingest(`gamma-${tag}`);
      seedEdge(a, other, "v1", { jaccard: 0.9 - tag.charCodeAt(0) * 0.01 });
    }
    const p1 = await (await req(`/documents/${a}/near-dupes?limit=2`)).json();
    expect((p1 as { edges: unknown[] }).edges).toHaveLength(2);
    expect((p1 as { nextCursor: string | null }).nextCursor).not.toBeNull();
    const next = (p1 as { nextCursor: string }).nextCursor;
    const p2 = await (
      await req(`/documents/${a}/near-dupes?limit=2&after=${encodeURIComponent(next)}`)
    ).json();
    expect((p2 as { edges: unknown[] }).edges).toHaveLength(1);
    expect((p2 as { nextCursor: string | null }).nextCursor).toBeNull();
  });

  test("requires auth", async () => {
    const a = await ingest("delta-1");
    const res = await app.request(`/documents/${a}/near-dupes`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

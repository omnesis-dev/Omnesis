// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `GET /people/:id/annotations` — the agent's durable LLM-derived
 * observations ABOUT a person (the person-keyed sibling of the doc-annotation
 * route). Live priors only. The queried id is resolved to
 * its canonical root, so a merge-loser id surfaces the canonical person's
 * annotations. All fixture content is invented.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import {
  createPersonAnnotation,
  invalidatePersonAnnotationsForDoc,
} from "../../brain/storage/person-annotations.js";
import { createBrief } from "../../brain/storage/briefs.js";
import { recordConsumptionEdges } from "../../brain/storage/consumption-edges.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let token: string;
let sourceRuntimes: Array<{ flushAll(): Promise<void>; dispose(): void }>;
const originalExperimental = process.env.OMNESIS_EXPERIMENTAL;

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
function insertPerson(id: string, opts: { mergedInto?: string } = {}): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at, merged_into)
     VALUES (?, 'Contact', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', ?)`,
  ).run(id, opts.mergedInto ?? null);
}
function insertDoc(id: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', 'test', ?, 'Doc', 'c', ?, '{}', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, id, `hash-${id}`);
}

beforeEach(() => {
  process.env.OMNESIS_EXPERIMENTAL = "0";
  dbPath = `/tmp/omnesis-people-annotations-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  token = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
  sourceRuntimes = [];
  app = createServer(db, dbPath, {
    onOmnesisNotesRuntime: (runtime) => sourceRuntimes.push(runtime),
    onAgentConversationsRuntime: (runtime) => sourceRuntimes.push(runtime),
  });
});
afterEach(async () => {
  // createServer boots experimental built-in sources in the background.
  // Quiesce their seed/reconciliation promises before closing SQLite so a
  // late warning cannot outlive Vitest's console interceptor.
  for (const runtime of sourceRuntimes) {
    await runtime.flushAll();
    runtime.dispose();
  }
  if (originalExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
  else process.env.OMNESIS_EXPERIMENTAL = originalExperimental;
  db.close();
  cleanupDb(dbPath);
});

describe("GET /people/:id/annotations", () => {
  test("serves annotations when experimental mode is unset", async () => {
    insertPerson("per_a");
    delete process.env.OMNESIS_EXPERIMENTAL;
    const res = await req("/people/per_a/annotations");
    expect(res.status).toBe(200);
  });

  test("returns 404 for an unknown person", async () => {
    const res = await req("/people/per_nope/annotations");
    expect(res.status).toBe(404);
  });

  test("returns an empty list for a person with no annotations", async () => {
    insertPerson("per_a");
    const res = await req("/people/per_a/annotations");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      annotations: [],
      pageInfo: { hasMore: false, limit: 20 },
    });
  });

  test("serves live annotations newest first, in the slim client shape", async () => {
    insertPerson("per_a");
    insertDoc("doc_1");
    createPersonAnnotation(
      db,
      {
        id: "panno_old",
        personId: "per_a",
        claimType: "role",
        claimText: "runs the weekly sync",
        evidenceDocId: "doc_1",
        evidenceQuote: "runs the weekly sync",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run_1",
      },
      1000,
    );
    createPersonAnnotation(
      db,
      {
        id: "panno_new",
        personId: "per_a",
        claimType: "preference",
        claimText: "prefers async updates",
        evidenceDocId: "doc_1",
        evidenceQuote: "prefers async updates",
        confidence: 0.6,
        claimBasis: "synthesized",
        createdByRun: "run_2",
      },
      2000,
    );
    const res = await req("/people/per_a/annotations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { annotations: Array<Record<string, unknown>> };
    expect(body.annotations).toEqual([
      {
        id: "panno_new",
        claimType: "preference",
        claimText: "prefers async updates",
        evidenceDocId: "doc_1",
        evidenceQuote: "prefers async updates",
        confidence: 0.6,
        claimBasis: "synthesized",
        createdAt: new Date(2000).toISOString(),
        verificationState: null,
        lastVerifiedAt: null,
        dependentCount: 0,
        dependents: [],
      },
      {
        id: "panno_old",
        claimType: "role",
        claimText: "runs the weekly sync",
        evidenceDocId: "doc_1",
        evidenceQuote: "runs the weekly sync",
        confidence: 0.8,
        claimBasis: "quoted",
        createdAt: new Date(1000).toISOString(),
        verificationState: null,
        lastVerifiedAt: null,
        dependentCount: 0,
        dependents: [],
      },
    ]);
    expect(body.annotations[0]).not.toHaveProperty("createdByRun");
    expect(body.annotations[0]).not.toHaveProperty("invalidatedAt");
  });

  test("keyset-pages annotations and binds the cursor to the canonical person", async () => {
    insertPerson("per_page");
    insertPerson("per_other");
    insertDoc("doc_page");
    for (const [id, createdAt] of [
      ["panno_page_1", 1000],
      ["panno_page_2", 2000],
      ["panno_page_3", 3000],
    ] as const) {
      createPersonAnnotation(
        db,
        {
          id,
          personId: "per_page",
          claimType: "role",
          claimText: `Synthetic role ${id}`,
          evidenceDocId: "doc_page",
          evidenceQuote: "coordinates the fictional review",
          confidence: 0.7,
          claimBasis: "quoted",
          createdByRun: "run_pagination",
        },
        createdAt,
      );
    }
    const first = (await (await req("/people/per_page/annotations?limit=2")).json()) as {
      annotations: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.annotations.map((annotation) => annotation.id)).toEqual([
      "panno_page_3",
      "panno_page_2",
    ]);
    expect(first.pageInfo.hasMore).toBe(true);
    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);
    const second = (await (
      await req(`/people/per_page/annotations?limit=2&cursor=${cursor}`)
    ).json()) as { annotations: Array<{ id: string }>; pageInfo: { hasMore: boolean } };
    expect(second.annotations.map((annotation) => annotation.id)).toEqual(["panno_page_1"]);
    expect(second.pageInfo.hasMore).toBe(false);
    expect((await req(`/people/per_other/annotations?cursor=${cursor}`)).status).toBe(400);
  });

  test("a merge-loser id resolves to the canonical person's annotations", async () => {
    insertPerson("per_canonical");
    insertPerson("per_loser", { mergedInto: "per_canonical" });
    insertDoc("doc_1");
    createPersonAnnotation(
      db,
      {
        id: "panno_1",
        personId: "per_canonical",
        claimType: "role",
        claimText: "chairs the board",
        evidenceDocId: "doc_1",
        evidenceQuote: "chairs the board",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_1",
      },
      1000,
    );
    // Querying the LOSER id surfaces the canonical's annotation (resolvePersonId).
    const res = await req("/people/per_loser/annotations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { annotations: Array<{ id: string }> };
    expect(body.annotations.map((a) => a.id)).toEqual(["panno_1"]);
  });

  test("serves the entailment verification stamp with an ISO lastVerifiedAt", async () => {
    insertPerson("per_a");
    insertDoc("doc_1");
    createPersonAnnotation(
      db,
      {
        id: "panno_stamped",
        personId: "per_a",
        claimType: "role",
        claimText: "coordinates the vendor reviews",
        evidenceDocId: "doc_1",
        evidenceQuote: "coordinates the vendor reviews",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_1",
        verificationState: "verified",
        lastVerifiedAt: 5000,
      },
      1000,
    );
    const res = await req("/people/per_a/annotations");
    const body = (await res.json()) as { annotations: Array<Record<string, unknown>> };
    expect(body.annotations[0]).toMatchObject({
      id: "panno_stamped",
      verificationState: "verified",
      lastVerifiedAt: new Date(5000).toISOString(),
    });
  });

  test("excludes invalidated annotations", async () => {
    insertPerson("per_a");
    insertDoc("doc_1");
    createPersonAnnotation(
      db,
      {
        id: "panno_stale",
        personId: "per_a",
        claimType: "role",
        claimText: "x",
        evidenceDocId: "doc_1",
        evidenceQuote: "x",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_1",
      },
      1000,
    );
    invalidatePersonAnnotationsForDoc(db, "doc_1", 2000);
    const res = await req("/people/per_a/annotations");
    expect(await res.json()).toEqual({
      annotations: [],
      pageInfo: { hasMore: false, limit: 20 },
    });
  });

  test("keeps experimental dependents hidden on a stable gateway", async () => {
    insertPerson("per_a");
    insertDoc("doc_1");
    createPersonAnnotation(
      db,
      {
        id: "panno_dep",
        personId: "per_a",
        claimType: "preference",
        claimText: "prefers async updates",
        evidenceDocId: "doc_1",
        evidenceQuote: "prefers async updates",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run_1",
      },
      1000,
    );
    createBrief(
      db,
      {
        id: "brief_dep",
        createdByRun: "run_2",
        kind: "info",
        title: "Fictional follow-up",
        description: "An invented briefing.",
        confidence: 0.7,
        urgency: 0.4,
      },
      2000,
    );
    recordConsumptionEdges(
      db,
      [
        {
          priorStore: "person",
          priorAnnotationId: "panno_dep",
          dependentKind: "brief",
          dependentId: "brief_dep",
          runId: "run_2",
        },
      ],
      2000,
    );
    const stable = await (await req("/people/per_a/annotations")).json();
    expect(stable.annotations[0]).toMatchObject({ dependentCount: 0, dependents: [] });
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const experimental = await (await req("/people/per_a/annotations")).json();
    expect(experimental.annotations[0].dependentCount).toBe(1);
    expect(experimental.annotations[0].dependents).toEqual([
      expect.objectContaining({ id: "brief_dep" }),
    ]);
  });

  test("requires auth", async () => {
    insertPerson("per_a");
    const res = await app.request("/people/per_a/annotations", {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

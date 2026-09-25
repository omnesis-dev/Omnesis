// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `GET /documents/:id/annotations` — the agent's durable
 * LLM-derived observations about a document, served to the doc-detail
 * "enriched by Omnesis" section. Live priors only: invalidated rows never
 * appear. All fixture content is invented.
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
  createDocAnnotation,
  invalidateAnnotationsForDoc,
} from "../../brain/storage/annotations.js";
import { createBrief } from "../../brain/storage/briefs.js";
import { recordConsumptionEdges } from "../../brain/storage/consumption-edges.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let token: string;
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
          content: `# ${externalId}\nThe studio deposit is due on Friday.`,
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

beforeEach(() => {
  process.env.OMNESIS_EXPERIMENTAL = "0";
  dbPath = `/tmp/omnesis-doc-annotations-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  token = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
  app = createServer(db, dbPath, {});
});

afterEach(() => {
  if (originalExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
  else process.env.OMNESIS_EXPERIMENTAL = originalExperimental;
  db.close();
  cleanupDb(dbPath);
});

describe("GET /documents/:id/annotations", () => {
  test("serves annotations when experimental mode is unset", async () => {
    const id = await ingest("gated-1");
    delete process.env.OMNESIS_EXPERIMENTAL;

    const res = await req(`/documents/${id}/annotations`);
    expect(res.status).toBe(200);
  });

  test("returns 404 for an unknown document", async () => {
    const res = await req("/documents/does-not-exist/annotations");
    expect(res.status).toBe(404);
  });

  test("returns 400 for an ambiguous id prefix", async () => {
    const a = await ingest("amb-1");
    const b = await ingest("amb-2");
    const sharedPrefix = a.slice(0, 1);
    if (b.slice(0, 1) !== sharedPrefix) return; // skip if prefixes don't collide
    const res = await req(`/documents/${sharedPrefix}/annotations`);
    expect(res.status).toBe(400);
  });

  test("returns an empty list for an unannotated document", async () => {
    const id = await ingest("plain-1");
    const res = await req(`/documents/${id}/annotations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      annotations: [],
      pageInfo: { hasMore: false, limit: 20 },
    });
  });

  test("serves live annotations newest first, in the slim client shape", async () => {
    const subject = await ingest("subject-1");
    const evidence = await ingest("evidence-1");
    createDocAnnotation(
      db,
      {
        id: "ann_old",
        docId: subject,
        claimType: "topic",
        claimText: "This thread is about booking a recording studio",
        evidenceDocId: evidence,
        evidenceQuote: "The studio deposit is due on Friday.",
        confidence: 0.8,
        claimBasis: "quoted",
        createdByRun: "run_1",
      },
      1000,
    );
    createDocAnnotation(
      db,
      {
        id: "ann_new",
        docId: subject,
        claimType: "commitment-status",
        claimText: "The deposit has not been paid yet",
        evidenceDocId: evidence,
        evidenceQuote: "The studio deposit is due on Friday.",
        confidence: 0.6,
        claimBasis: "inferred",
        createdByRun: "run_2",
      },
      2000,
    );
    const res = await req(`/documents/${subject}/annotations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { annotations: Array<Record<string, unknown>> };
    expect(body.annotations).toEqual([
      {
        id: "ann_new",
        claimType: "commitment-status",
        claimText: "The deposit has not been paid yet",
        evidenceDocId: evidence,
        evidenceQuote: "The studio deposit is due on Friday.",
        confidence: 0.6,
        claimBasis: "inferred",
        createdAt: new Date(2000).toISOString(),
        verificationState: null,
        lastVerifiedAt: null,
        dependentCount: 0,
        dependents: [],
      },
      {
        id: "ann_old",
        claimType: "topic",
        claimText: "This thread is about booking a recording studio",
        evidenceDocId: evidence,
        evidenceQuote: "The studio deposit is due on Friday.",
        confidence: 0.8,
        claimBasis: "quoted",
        createdAt: new Date(1000).toISOString(),
        verificationState: null,
        lastVerifiedAt: null,
        dependentCount: 0,
        dependents: [],
      },
    ]);
    // Internal fields never leak to the client shape.
    expect(body.annotations[0]).not.toHaveProperty("createdByRun");
    expect(body.annotations[0]).not.toHaveProperty("invalidatedAt");
  });

  test("keyset-pages annotations and binds the cursor to the document", async () => {
    const subject = await ingest("paged-subject");
    const other = await ingest("paged-other");
    for (const [id, createdAt] of [
      ["ann_page_1", 1000],
      ["ann_page_2", 2000],
      ["ann_page_3", 3000],
    ] as const) {
      createDocAnnotation(
        db,
        {
          id,
          docId: subject,
          claimType: "topic",
          claimText: `Synthetic claim ${id}`,
          evidenceDocId: subject,
          evidenceQuote: "The studio deposit is due on Friday.",
          confidence: 0.7,
          claimBasis: "quoted",
          createdByRun: "run_pagination",
        },
        createdAt,
      );
    }
    const first = (await (await req(`/documents/${subject}/annotations?limit=2`)).json()) as {
      annotations: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.annotations.map((annotation) => annotation.id)).toEqual([
      "ann_page_3",
      "ann_page_2",
    ]);
    expect(first.pageInfo.hasMore).toBe(true);
    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);
    const second = (await (
      await req(`/documents/${subject}/annotations?limit=2&cursor=${cursor}`)
    ).json()) as { annotations: Array<{ id: string }>; pageInfo: { hasMore: boolean } };
    expect(second.annotations.map((annotation) => annotation.id)).toEqual(["ann_page_1"]);
    expect(second.pageInfo.hasMore).toBe(false);
    expect((await req(`/documents/${other}/annotations?cursor=${cursor}`)).status).toBe(400);
  });

  test("can omit dependent rows while retaining their additive count", async () => {
    const subject = await ingest("dependent-subject");
    createDocAnnotation(
      db,
      {
        id: "ann_dep",
        docId: subject,
        claimType: "topic",
        claimText: "The thread concerns a studio booking",
        evidenceDocId: subject,
        evidenceQuote: "The studio deposit is due on Friday.",
        confidence: 0.7,
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
        title: "Studio booking follow-up",
        description: "A fictional follow-up.",
        confidence: 0.7,
        urgency: 0.4,
      },
      2000,
    );
    recordConsumptionEdges(
      db,
      [
        {
          priorStore: "doc",
          priorAnnotationId: "ann_dep",
          dependentKind: "brief",
          dependentId: "brief_dep",
          runId: "run_2",
        },
      ],
      2000,
    );

    const body = (await (
      await req(`/documents/${subject}/annotations?includeDependents=0`)
    ).json()) as { annotations: Array<Record<string, unknown>> };
    expect(body.annotations[0]).toMatchObject({ id: "ann_dep", dependentCount: 0, dependents: [] });
    process.env.OMNESIS_EXPERIMENTAL = "1";
    const experimentalBody = (await (
      await req(`/documents/${subject}/annotations?includeDependents=0`)
    ).json()) as { annotations: Array<Record<string, unknown>> };
    expect(experimentalBody.annotations[0]).toMatchObject({ id: "ann_dep", dependentCount: 1 });
    expect(experimentalBody.annotations[0]).not.toHaveProperty("dependents");
  });

  test("serves the entailment verification stamp with an ISO lastVerifiedAt", async () => {
    const subject = await ingest("stamped-1");
    createDocAnnotation(
      db,
      {
        id: "ann_stamped",
        docId: subject,
        claimType: "commitment-status",
        claimText: "The deposit is due on Friday",
        evidenceDocId: subject,
        evidenceQuote: "The studio deposit is due on Friday.",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_1",
        verificationState: "verified",
        lastVerifiedAt: 5000,
      },
      1000,
    );
    const res = await req(`/documents/${subject}/annotations`);
    const body = (await res.json()) as { annotations: Array<Record<string, unknown>> };
    expect(body.annotations[0]).toMatchObject({
      id: "ann_stamped",
      verificationState: "verified",
      lastVerifiedAt: new Date(5000).toISOString(),
    });
  });

  test("excludes invalidated annotations", async () => {
    const subject = await ingest("subject-2");
    createDocAnnotation(
      db,
      {
        id: "ann_stale",
        docId: subject,
        claimType: "topic",
        claimText: "An observation whose subject has since changed",
        // A quote the document no longer contains — the surgical
        // invalidation drops exactly such broken-grounding rows.
        evidenceDocId: subject,
        evidenceQuote: "An older sentence that was since edited away.",
        confidence: 0.7,
        claimBasis: "quoted",
        createdByRun: "run_1",
      },
      1000,
    );
    invalidateAnnotationsForDoc(db, subject, 2000);
    const res = await req(`/documents/${subject}/annotations`);
    expect(await res.json()).toEqual({
      annotations: [],
      pageInfo: { hasMore: false, limit: 20 },
    });
  });

  test("requires auth", async () => {
    const id = await ingest("auth-1");
    const res = await app.request(`/documents/${id}/annotations`, {
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

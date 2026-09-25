// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { describe, test, expect, afterAll, beforeAll } from "vitest";
import Database from "better-sqlite3";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  setIndexedDocument,
  upsertChunks,
} from "../indexer/db.js";
import { SearchPipeline } from "./pipeline.js";
import { DEFAULT_SEARCH_PARAMS } from "./search-config.js";
import { closeTempDb } from "./test-utils.js";

interface TestSourceRuntime {
  flushAll(): Promise<void>;
  dispose(): void;
}

function sourceRuntimeHooks(runtimes: TestSourceRuntime[]) {
  return {
    onOmnesisNotesRuntime: (runtime: TestSourceRuntime) => runtimes.push(runtime),
    onAgentConversationsRuntime: (runtime: TestSourceRuntime) => runtimes.push(runtime),
  };
}

async function closeHttpTestResources(
  runtimes: TestSourceRuntime[],
  ...databases: Database.Database[]
): Promise<void> {
  const failures: unknown[] = [];
  for (const runtime of runtimes) {
    try {
      await runtime.flushAll();
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        runtime.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  for (const database of databases) {
    try {
      closeTempDb(database);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to close HTTP search test resources");
  }
}

// Some of these tests exercise experimental-gated pipeline behaviour (the
// opt-in cognitive projection), so experimental mode is enabled for the whole
// file — the same way the synthetic E2E lane unlocks experimental surfaces.
// Restored afterward so the env doesn't leak to other files.
let priorExperimental: string | undefined;
beforeAll(() => {
  priorExperimental = process.env.OMNESIS_EXPERIMENTAL;
  process.env.OMNESIS_EXPERIMENTAL = "1";
});
afterAll(() => {
  if (priorExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
  else process.env.OMNESIS_EXPERIMENTAL = priorExperimental;
});

/** Minimal gateway DB with people + document_people tables for person-filter tests. */
function createGatewayTestDb() {
  const db = new Database(`/tmp/omnesis-gw-test-${randomUUID()}.db`);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      merged_into TEXT,
      source TEXT NOT NULL,
      is_self BOOLEAN DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS document_people (
      document_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      role TEXT NOT NULL,
      source_id TEXT,
      PRIMARY KEY (document_id, person_id, role)
    );
    -- hydrateMetadataFields reads documents.metadata for links/mimeType
    -- on the final result set; present (empty is fine) so a results-bearing
    -- search doesn't trip over a missing table.
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      metadata TEXT
    );
  `);
  return db;
}

// Create a test index DB with known documents
function createTestDb() {
  const dbPath = `/tmp/omnesis-search-test-${randomUUID()}.db`;
  const db = createIndexDatabase(dbPath);

  // Insert test chunks (no real embeddings — BM25-only tests)
  const dummyEmbedding = new Float32Array(EMBEDDING_DIM).fill(0);

  upsertChunks(db, [
    {
      id: "chunk-1",
      documentId: "doc-email-1",
      chunkIndex: 0,
      content: "Q3 budget review meeting notes with finance team",
      embedding: dummyEmbedding,
      sourceId: "gmail:user@test.com",
      documentType: "email",
      title: "Q3 Budget Review",
      sourceUrl: "https://mail.google.com/1",
      sourceCreatedAt: "2026-03-01T10:00:00Z",
      author: "John Smith",
      tags: ["finance", "quarterly"],
    },
    {
      id: "chunk-2",
      documentId: "doc-email-2",
      chunkIndex: 0,
      content: "Project kickoff meeting agenda and action items",
      embedding: dummyEmbedding,
      sourceId: "gmail:user@test.com",
      documentType: "email",
      title: "Project Kickoff",
      sourceUrl: "https://mail.google.com/2",
      sourceCreatedAt: "2026-02-15T14:00:00Z",
      author: "Jane Doe",
      tags: ["project"],
    },
    {
      id: "chunk-3",
      documentId: "doc-chat-1",
      chunkIndex: 0,
      content: "Hey, did you see the budget numbers? They look great",
      embedding: dummyEmbedding,
      sourceId: "whatsapp:local",
      documentType: "conversation",
      title: "Chat with Finance Team",
      sourceCreatedAt: "2026-03-10T09:00:00Z",
      author: "John Smith",
    },
    {
      id: "chunk-4",
      documentId: "doc-note-1",
      chunkIndex: 0,
      content: "Personal notes on the quarterly budget allocation strategy",
      embedding: dummyEmbedding,
      sourceId: "apple-notes:local",
      documentType: "note",
      title: "Budget Strategy Notes",
      sourceCreatedAt: "2026-01-20T08:00:00Z",
    },
    {
      id: "chunk-5",
      documentId: "doc-email-1",
      chunkIndex: 1,
      content: "Follow-up: the budget has been approved by management",
      embedding: dummyEmbedding,
      sourceId: "gmail:user@test.com",
      documentType: "email",
      title: "Q3 Budget Review",
      sourceUrl: "https://mail.google.com/1",
      sourceCreatedAt: "2026-03-01T10:00:00Z",
      author: "John Smith",
      tags: ["finance", "quarterly"],
    },
  ]);

  return { db, dbPath };
}

describe("SearchPipeline (no embedder — BM25 only)", () => {
  // Create DB eagerly at module scope (all SQLite ops are synchronous)
  const { db } = createTestDb();
  const pipeline = new SearchPipeline({ indexDb: db });

  afterAll(() => {
    closeTempDb(db);
  });

  test("basic keyword search", async () => {
    const response = await pipeline.search({ text: "budget" });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.timing.totalMs).toBeGreaterThanOrEqual(0);
    // All results should mention budget
    for (const r of response.results) {
      const text = (r.title + " " + r.chunkText).toLowerCase();
      expect(text).toContain("budget");
    }
  });

  test("deduplicates by document", async () => {
    // doc-email-1 has two chunks, both matching "budget"
    const response = await pipeline.search({ text: "budget" });
    const docIds = response.results.map((r) => r.documentId);
    const uniqueDocIds = new Set(docIds);
    expect(docIds.length).toBe(uniqueDocIds.size);
  });

  test("returns score breakdown", async () => {
    const response = await pipeline.search({ text: "budget" });
    expect(response.results[0].scoreBreakdown).toBeDefined();
  });

  test("returns timing info", async () => {
    const response = await pipeline.search({ text: "meeting" });
    expect(response.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(response.timing.bm25Ms).toBeDefined();
  });

  test("returns facets", async () => {
    const response = await pipeline.search({ text: "budget" });
    expect(response.facets).toBeDefined();
    expect(response.facets!.byType).toBeDefined();
    expect(response.facets!.bySource).toBeDefined();
  });

  test("query parser extracts filters", async () => {
    const response = await pipeline.search({
      text: "type:email budget",
    });
    expect(response.query.parsedFilters).toBeDefined();
    expect(response.query.parsedFilters!.documentTypes).toEqual(["email"]);
    // Should only return email results
    for (const r of response.results) {
      expect(r.documentType).toBe("email");
    }
  });

  test("filters by source ID", async () => {
    const response = await pipeline.search({
      text: "budget",
      filters: { sourceIds: ["whatsapp:local"] },
    });
    for (const r of response.results) {
      expect(r.sourceId).toBe("whatsapp:local");
    }
  });

  test("hard source authorization intersects configured defaults before ranking", async () => {
    const { db: scopedDb } = createTestDb();
    const scoped = new SearchPipeline({
      indexDb: scopedDb,
      searchConfig: { defaultFilters: { sourceIds: ["whatsapp:local"] } },
    });
    try {
      const blocked = await scoped.search(
        { text: "budget" },
        { sourceIds: ["gmail:user@test.com"] },
      );
      expect(blocked.results).toEqual([]);

      const explicitlyDenied = await scoped.search(
        { text: "budget", filters: { sourceIds: ["whatsapp:local"] } },
        { sourceIds: ["gmail:user@test.com"] },
      );
      expect(explicitlyDenied.results).toEqual([]);
    } finally {
      closeTempDb(scopedDb);
    }
  });

  test("filters by document type", async () => {
    const response = await pipeline.search({
      text: "budget",
      filters: { documentTypes: ["note"] },
    });
    for (const r of response.results) {
      expect(r.documentType).toBe("note");
    }
  });

  test("filters by date range", async () => {
    const response = await pipeline.search({
      text: "budget",
      filters: { dateFrom: "2026-03-01" },
    });
    for (const r of response.results) {
      expect(r.sourceCreatedAt >= "2026-03-01").toBe(true);
    }
  });

  test("respects limit", async () => {
    const response = await pipeline.search({
      text: "budget",
      limit: 1,
    });
    expect(response.results.length).toBe(1);
  });

  test("returns empty results for non-matching query", async () => {
    const response = await pipeline.search({
      text: "xyznonexistent",
    });
    expect(response.results.length).toBe(0);
  });

  test("inline filters from query text", async () => {
    const response = await pipeline.search({
      text: "from:John budget",
    });
    expect(response.query.parsedFilters?.personFilters).toEqual([
      { refs: ["John"], roles: ["sender", "author", "owner"] },
    ]);
  });

  test("no embedder — search still answers off BM25 alone", async () => {
    const response = await pipeline.search({ text: "meeting" });
    // The vector lane degrades automatically; BM25 alone still returns results.
    expect(response.results.length).toBeGreaterThan(0);
  });

  test("stages report: no embedder — bm25 ran, vector skipped with a reason, fusion bm25-only", async () => {
    // Same pipeline as the suite default: no embedder attached. The vector
    // lane must still emit a report — the debug panel surfaces the reason it
    // did not contribute, so an absent report would read as "never wired up".
    const response = await pipeline.search({ text: "budget" });
    expect(response.stages).toBeDefined();
    expect(response.stages!.bm25?.status).toBe("ran");
    expect(response.stages!.bm25?.candidates).toBeGreaterThan(0);
    expect(response.stages!.vector?.status).toBe("skipped");
    expect(response.stages!.vector?.reason).toContain("embedder");
    expect(response.stages!.fusion?.status).toBe("ran");
    expect(response.stages!.fusion?.method).toBe("bm25-only");
  });

  test("no embedder — results still carry RRF-shaped scores, not raw BM25", async () => {
    // Guards the fusion invariant: an empty vector list must NOT switch the
    // pipeline to a raw-BM25 pass-through. Everything downstream of fusion is
    // calibrated to the RRF score family — source priors are additive and
    // scaled to 1/(rrfK+1), and topRankBonus/nearTopRankBonus are absolute
    // additions on the same scale — so handing back raw BM25 scores (single
    // digits to tens, three orders of magnitude larger) would leave both
    // mechanisms present in the code and inert in effect. Only the *reported*
    // `fusion.method` distinguishes the two lanes; the scoring does not.
    const response = await pipeline.search({ text: "budget" });
    expect(response.results.length).toBeGreaterThan(1);

    const { rrfK, bm25Weight, candidateLimit, topRankBonus } = DEFAULT_SEARCH_PARAMS;
    // A fused score is a function of RANK alone, so it lives in a narrow band:
    // [w/(k + candidateLimit), w/(k + 1)] ≈ [0.0091, 0.0164] at the defaults —
    // whatever the BM25 magnitudes were. On this fixture the raw BM25 score is
    // ~1.6e-6, three orders of magnitude below the band's floor.
    const maxRrf = bm25Weight / (rrfK + 1);
    const minRrf = bm25Weight / (rrfK + candidateLimit);

    for (const r of response.results) {
      const breakdown = r.scoreBreakdown;
      // `rrfScore` is written only by the RRF fusion path; the single-stage
      // pass-through leaves it undefined and copies the raw BM25 score
      // straight into `score`.
      expect(breakdown?.rrfScore).toBeDefined();
      expect(breakdown!.rrfScore!).toBeGreaterThanOrEqual(minRrf);
      expect(breakdown!.rrfScore!).toBeLessThanOrEqual(maxRrf);
      // Nothing rescaled the result on the way out: the returned score is
      // exactly the fused value plus its rank bonus, still in the RRF family.
      expect(r.score).toBeCloseTo(breakdown!.rrfScore! + (breakdown!.rankBonus ?? 0), 12);
      expect(r.score).toBeGreaterThanOrEqual(minRrf);
    }

    // The head of the ranking carries the top-rank bonus, which only fusion
    // applies — and only to RRF-shaped scores.
    const bonuses = response.results.map((r) => r.scoreBreakdown?.rankBonus);
    expect(bonuses).toContain(topRankBonus);
  });
});

describe("SearchPipeline (injection ports)", () => {
  test("queryEnricher.resolvePersonIds drives `from:` author filter", async () => {
    const { db } = createTestDb();
    const seen: string[] = [];
    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        // Return [] so the pipeline short-circuits — this test
        // pins the parser → enricher contract, not the downstream
        // SQL filter (which needs the gateway DB schema).
        resolvePersonIds: (text) => {
          seen.push(text);
          return [];
        },
        getSelfPersonId: () => null,
      },
    });
    await pipeline.search({
      text: "from:John budget",
    });
    expect(seen).toEqual(["John"]);
    closeTempDb(db);
  });

  test("queryEnricher.getSelfPersonId resolves `me`", async () => {
    const { db } = createTestDb();
    let selfCalled = 0;
    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: () => [],
        // Return null so the filter stays empty and downstream stages
        // don't try to JOIN against the gateway people tables (this
        // test exercises the enricher contract, not the SQL filter).
        getSelfPersonId: () => {
          selfCalled += 1;
          return null;
        },
      },
    });
    await pipeline.search({
      text: "from:me budget",
    });
    expect(selfCalled).toBe(1);
    closeTempDb(db);
  });

  test("with: filter doesn't crash without a gateway DB", async () => {
    // Regression for the with: bug — the pipeline used to default
    // empty `personRoles` back onto sender/author/owner, so a
    // `with:alice` query silently degraded into a `from:alice`
    // filter. The PersonFilter contract makes the any-role intent
    // explicit; this test pins that the enricher is invoked for
    // the with: ref and the search runs cleanly even when the
    // gateway DB isn't wired (deeper role-JOIN coverage lives in
    // `resolvePersonDocIds` and the live integration suite).
    const { db } = createTestDb();
    const seen: string[] = [];
    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: (ref) => {
          seen.push(ref);
          return [];
        },
        getSelfPersonId: () => null,
      },
    });
    await pipeline.search({ text: "with:alice budget" });
    expect(seen).toEqual(["alice"]);
    closeTempDb(db);
  });

  test("from:X to:Y resolves both refs independently", async () => {
    // Regression for the mixed-roles bug — the old parser put
    // every ref into a flat `authors` array and assigned a single
    // shared `personRoles=['recipient']`, so `from:alice to:bob`
    // collapsed alice into a recipient too. With PersonFilter[]
    // the enricher resolves alice and bob in separate buckets so
    // the pipeline can AND-intersect alice-as-sender with
    // bob-as-recipient.
    const { db } = createTestDb();
    const seen: string[] = [];
    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: (ref) => {
          seen.push(ref);
          return [];
        },
        getSelfPersonId: () => null,
      },
    });
    await pipeline.search({ text: "from:alice to:bob report" });
    expect(seen).toEqual(["alice", "bob"]);
    closeTempDb(db);
  });

  test("unresolved person ref emits a `person` notice", async () => {
    // Live-corpus regression: when a `from:typo` ref resolves to no
    // canonical person the response previously came back with zero
    // hits and no explanation. Now the pipeline pushes a
    // `level: "error"` notice so the caller can render an inline hint
    // ("no person matches Sid") instead of guessing.
    const { db } = createTestDb();
    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: () => [],
        getSelfPersonId: () => null,
      },
    });
    const response = await pipeline.search({ text: "from:typo budget" });
    expect(response.notices).toBeDefined();
    const personNotices = response.notices!.filter((n) => n.filter === "person");
    expect(personNotices).toHaveLength(1);
    expect(personNotices[0]).toMatchObject({
      filter: "person",
      level: "error",
      token: "from:typo",
    });
    expect(personNotices[0].message).toContain("typo");
    closeTempDb(db);
  });

  test("unresolved `to:` ref emits a notice tokenized as `to:`", async () => {
    // Pins the reverse role-set→token map (pillTokenForRoles) for the
    // recipient bucket: a `to:typo` ref that resolves to no person must
    // surface its notice token as `to:typo`, not the generic `person:`.
    // Complements the `from:typo` case above so both arms of the bijection
    // are characterized.
    const { db } = createTestDb();
    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: () => [],
        getSelfPersonId: () => null,
      },
    });
    const response = await pipeline.search({ text: "to:typo budget" });
    const personNotices = (response.notices ?? []).filter((n) => n.filter === "person");
    expect(personNotices).toHaveLength(1);
    expect(personNotices[0]).toMatchObject({
      filter: "person",
      level: "error",
      token: "to:typo",
    });
    closeTempDb(db);
  });

  test("an unresolved ref beside a resolved one warns instead of claiming zero docs", async () => {
    // Same-intent refs OR into one bucket (`from:maya from:typo` means
    // either), so a ref that resolves to nobody does not empty the filter
    // while a sibling still does. Saying "Filter resolves to zero docs." in
    // the same body as Maya's documents is a response that contradicts
    // itself, and `--json` / the raw `POST /search` are where it is read.
    const { db } = createTestDb();
    const gatewayDb = createGatewayTestDb();
    const mayaId = "maya-person-1";
    gatewayDb.exec(
      `INSERT INTO people (id, canonical_name, source) VALUES ('${mayaId}', 'Maya', 'extracted')`,
    );
    gatewayDb.exec(
      `INSERT INTO document_people (document_id, person_id, role) VALUES ('doc-email-1', '${mayaId}', 'sender')`,
    );

    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: (ref) => (ref === "maya" ? [mayaId] : []),
        getSelfPersonId: () => null,
      },
    });
    pipeline.setGatewayDb(gatewayDb);
    const response = await pipeline.search({ text: "from:maya from:typo budget" });

    expect(
      response.results.map((r) => r.documentId),
      "the surviving ref's documents were dropped",
    ).toEqual(["doc-email-1"]);
    const personNotices = (response.notices ?? []).filter((n) => n.filter === "person");
    expect(personNotices).toHaveLength(1);
    expect(personNotices[0]).toMatchObject({ token: "from:typo", level: "warning" });
    expect(
      personNotices[0].message,
      "the notice claimed zero docs beside the documents it returned",
    ).not.toContain("zero docs");
    expect(personNotices[0].message).toContain("typo");

    closeTempDb(db);
    gatewayDb.close();
  });

  test("every ref in a bucket failing still raises an error notice each", async () => {
    // The other arm: nothing in the bucket resolved, so this filter really is
    // what empties the result set and both refs say so at `error`.
    const { db } = createTestDb();
    const gatewayDb = createGatewayTestDb();
    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: () => [],
        getSelfPersonId: () => null,
      },
    });
    pipeline.setGatewayDb(gatewayDb);
    const response = await pipeline.search({ text: "from:typo from:alsotypo budget" });

    expect(response.results).toHaveLength(0);
    const personNotices = (response.notices ?? []).filter((n) => n.filter === "person");
    expect(personNotices.map((n) => n.token)).toEqual(["from:typo", "from:alsotypo"]);
    for (const notice of personNotices) {
      expect(notice.level).toBe("error");
      expect(notice.message).toContain("Filter resolves to zero docs.");
    }

    closeTempDb(db);
    gatewayDb.close();
  });

  test("`from:me` with no self-person emits a `person` notice", async () => {
    const { db } = createTestDb();
    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: () => [],
        getSelfPersonId: () => null,
      },
    });
    const response = await pipeline.search({ text: "from:me budget" });
    const notices = response.notices ?? [];
    expect(notices.some((n) => n.token === "from:me" && n.level === "error")).toBe(true);
    closeTempDb(db);
  });

  test("person found but zero docs in requested role emits a notice", async () => {
    // Live-corpus regression: `to:Stripe` resolved Stripe as a person
    // (it has 12 docs as sender) but found 0 docs where Stripe is a
    // recipient. The user got empty results with no explanation. The
    // pipeline should emit an info-level notice explaining that the
    // person was found but has no documents in the requested role.
    const { db } = createTestDb();
    const gatewayDb = createGatewayTestDb();
    // Stripe person exists and resolves
    const stripePersonId = "stripe-person-1";
    gatewayDb.exec(
      `INSERT INTO people (id, canonical_name, source) VALUES ('${stripePersonId}', 'Stripe', 'extracted')`,
    );
    // Stripe has docs as sender but NOT as recipient
    gatewayDb.exec(
      `INSERT INTO document_people (document_id, person_id, role) VALUES ('doc-1', '${stripePersonId}', 'sender')`,
    );

    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: () => [stripePersonId],
        getSelfPersonId: () => null,
      },
    });
    pipeline.setGatewayDb(gatewayDb);
    const response = await pipeline.search({ text: "to:Stripe invoice" });
    expect(response.results).toHaveLength(0);
    const notices = response.notices ?? [];
    const personNotice = notices.find((n) => n.filter === "person");
    expect(personNotice).toBeDefined();
    expect(personNotice!.level).toBe("info");
    expect(personNotice!.message).toContain("Stripe");
    db.close();
    gatewayDb.close();
  });

  test("with: filter emits info notice when person has zero docs in any role", async () => {
    const { db } = createTestDb();
    const gatewayDb = createGatewayTestDb();
    const personId = "orphan-person-1";
    gatewayDb.exec(
      `INSERT INTO people (id, canonical_name, source) VALUES ('${personId}', 'Orphan', 'extracted')`,
    );
    // No document_people rows — person exists but has zero docs in any role.
    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: () => [personId],
        getSelfPersonId: () => null,
      },
    });
    pipeline.setGatewayDb(gatewayDb);
    const response = await pipeline.search({ text: "with:Orphan hello" });
    expect(response.results).toHaveLength(0);
    const notices = response.notices ?? [];
    const personNotice = notices.find((n) => n.filter === "person");
    expect(personNotice).toBeDefined();
    expect(personNotice!.level).toBe("info");
    expect(personNotice!.token).toBe("with:Orphan");
    expect(personNotice!.message).toContain("any");
    db.close();
    gatewayDb.close();
  });

  test("restrictor-only `with:` query browses the person's docs newest-first", async () => {
    // The agent's natural "everything with X" query has no free-text terms,
    // so BM25/vector can't generate candidates. The pipeline must fall back
    // to a recency browse over the person's documents.
    const { db } = createTestDb();
    const gatewayDb = createGatewayTestDb();
    const personId = "john-person-1";
    gatewayDb.exec(
      `INSERT INTO people (id, canonical_name, source) VALUES ('${personId}', 'John', 'extracted')`,
    );
    // John participates in an older email (2026-03-01) and a newer chat (2026-03-10).
    gatewayDb.exec(
      `INSERT INTO document_people (document_id, person_id, role) VALUES ('doc-email-1', '${personId}', 'participant')`,
    );
    gatewayDb.exec(
      `INSERT INTO document_people (document_id, person_id, role) VALUES ('doc-chat-1', '${personId}', 'participant')`,
    );
    const pipeline = new SearchPipeline({
      indexDb: db,
      queryEnricher: {
        resolvePersonIds: () => [personId],
        getSelfPersonId: () => null,
      },
    });
    pipeline.setGatewayDb(gatewayDb);

    const response = await pipeline.search({ text: "with:John" });

    expect(response.results.map((r) => r.documentId)).toEqual(["doc-chat-1", "doc-email-1"]);
    expect(response.stages?.browse?.status).toBe("ran");
    db.close();
    gatewayDb.close();
  });

  test("restrictor-only `source:` query browses that source newest-first", async () => {
    // No person filter, no free text — just a source restrictor.
    const { db } = createTestDb();
    const pipeline = new SearchPipeline({ indexDb: db });
    const response = await pipeline.search({
      text: "",
      filters: { sourceIds: ["apple-notes:local"] },
    });
    expect(response.results.map((r) => r.documentId)).toEqual(["doc-note-1"]);
    expect(response.stages?.browse?.status).toBe("ran");
    db.close();
  });

  test("empty query with no restrictor does NOT browse the whole corpus", async () => {
    const { db } = createTestDb();
    const pipeline = new SearchPipeline({ indexDb: db });
    const response = await pipeline.search({ text: "" });
    expect(response.stages?.browse).toBeUndefined();
    db.close();
  });

  test("clean query carries no notices", async () => {
    const { db } = createTestDb();
    const pipeline = new SearchPipeline({ indexDb: db });
    const response = await pipeline.search({ text: "budget" });
    expect(response.notices).toBeUndefined();
    closeTempDb(db);
  });

  test("RefCountStage runs only when linkRefSource is injected", async () => {
    const { db } = createTestDb();
    let calls = 0;
    const pipeline = new SearchPipeline({
      indexDb: db,
      linkRefSource: {
        getInboundRefCounts: (ids) => {
          calls += 1;
          // Mark the first result with refCount=7 so we can assert
          // the stage actually wrote the value back.
          return new Map([[ids[0] ?? "", 7]]);
        },
      },
    });
    const response = await pipeline.search({ text: "budget" });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(response.results[0]?.refCount).toBe(7);
    expect(response.stages?.refCount?.status).toBe("ran");
    closeTempDb(db);
  });

  test("RefCountStage stays disabled without linkRefSource", async () => {
    const { db } = createTestDb();
    const pipeline = new SearchPipeline({ indexDb: db });
    const response = await pipeline.search({ text: "budget" });
    // No `linkRefSource` injected → stage skipped entirely (no entry).
    expect(response.stages?.refCount).toBeUndefined();
    for (const r of response.results) expect(r.refCount).toBeUndefined();
    closeTempDb(db);
  });
});

describe("SearchPipeline (embedder attached — stage reporting)", () => {
  test("embedder attached → bm25 + vector both ran, fusion=rrf", async () => {
    const { db } = createTestDb();
    const mockUsearch = {
      search: () => [],
      maybeRefresh: () => {},
      reopen: () => {},
      close: () => {},
      size: () => 0,
    } as unknown as import("../indexer/usearch-index.js").UsearchReadHandle;
    const pipeline = new SearchPipeline({ indexDb: db, usearchRead: mockUsearch });

    // Mock embedder: produces a deterministic vector so the cosine-similarity
    // search returns something. We don't care about accuracy here — only that
    // the vector stage runs and the fusion stage reports as RRF.
    pipeline.setEmbedder({
      async embed(texts: string[]) {
        return texts.map(() => new Float32Array(EMBEDDING_DIM).fill(0.01));
      },
      async embedQuery() {
        return new Float32Array(EMBEDDING_DIM).fill(0.01);
      },
    });

    const response = await pipeline.search({ text: "budget" });
    expect(response.stages!.bm25?.status).toBe("ran");
    expect(response.stages!.vector?.status).toBe("ran");
    expect(response.stages!.fusion?.status).toBe("ran");
    expect(response.stages!.fusion?.method).toBe("rrf");
    expect(response.stages!.fusion?.rrfK).toBeGreaterThan(0);
    expect(response.stages!.fusion?.bm25Weight).toBeDefined();
    expect(response.stages!.fusion?.vectorWeight).toBeDefined();

    closeTempDb(db);
  });
});

describe("SearchPipeline (content-hash dedupe)", () => {
  test("byte-identical documents collapse to one result, distinct content survives", async () => {
    const dbPath = `/tmp/omnesis-search-dedupe-${randomUUID()}.db`;
    const db = createIndexDatabase(dbPath);
    const dummyEmbedding = new Float32Array(EMBEDDING_DIM).fill(0);

    // Three Drive re-uploads (same hash "DRIVE_PDF_X") plus one
    // genuinely distinct doc. All four match the query "budget".
    upsertChunks(db, [
      {
        id: "dup-chunk-1",
        documentId: "doc-drive-1",
        chunkIndex: 0,
        content: "Q3 budget planning questionnaire",
        embedding: dummyEmbedding,
        sourceId: "google-drive:user@test.com",
        documentType: "file",
        title: "Budget Planning",
        sourceCreatedAt: "2026-03-01T10:00:00Z",
      },
      {
        id: "dup-chunk-2",
        documentId: "doc-drive-2",
        chunkIndex: 0,
        content: "Q3 budget planning questionnaire",
        embedding: dummyEmbedding,
        sourceId: "google-drive:user@test.com",
        documentType: "file",
        title: "Budget Planning (copy)",
        sourceCreatedAt: "2026-03-02T10:00:00Z",
      },
      {
        id: "dup-chunk-3",
        documentId: "doc-drive-3",
        chunkIndex: 0,
        content: "Q3 budget planning questionnaire",
        embedding: dummyEmbedding,
        sourceId: "google-drive:user@test.com",
        documentType: "file",
        title: "Budget Planning (copy 2)",
        sourceCreatedAt: "2026-03-03T10:00:00Z",
      },
      {
        id: "uniq-chunk-1",
        documentId: "doc-unique",
        chunkIndex: 0,
        content: "Annual budget review distinct content",
        embedding: dummyEmbedding,
        sourceId: "gmail:user@test.com",
        documentType: "email",
        title: "Annual Review",
        sourceCreatedAt: "2026-03-04T10:00:00Z",
      },
    ]);
    // Three drive docs share one content hash; the email doc has its own.
    setIndexedDocument(db, "doc-drive-1", "DRIVE_PDF_X", 1);
    setIndexedDocument(db, "doc-drive-2", "DRIVE_PDF_X", 1);
    setIndexedDocument(db, "doc-drive-3", "DRIVE_PDF_X", 1);
    setIndexedDocument(db, "doc-unique", "UNIQUE_HASH_Y", 1);

    const pipeline = new SearchPipeline({ indexDb: db });
    const response = await pipeline.search({ text: "budget" });

    const docIds = response.results.map((r) => r.documentId);
    // The three drive duplicates must collapse to exactly one row.
    const driveCount = docIds.filter((id) => id.startsWith("doc-drive-")).length;
    expect(driveCount).toBe(1);
    // The distinct-content email must still come through.
    expect(docIds).toContain("doc-unique");
    expect(response.results).toHaveLength(2);

    closeTempDb(db);
  });
});

describe("SearchPipeline (relevance boost)", () => {
  test("relevance score affects ranking", async () => {
    const dbPath = `/tmp/omnesis-search-rel-${randomUUID()}.db`;
    const db = createIndexDatabase(dbPath);
    const dummyEmbedding = new Float32Array(EMBEDDING_DIM).fill(0);

    // Two docs with the same keyword but different relevance scores
    upsertChunks(db, [
      {
        id: "rel-chunk-1",
        documentId: "doc-low-rel",
        chunkIndex: 0,
        content: "important project update from the team",
        embedding: dummyEmbedding,
        sourceId: "gmail:user@test.com",
        documentType: "email",
        title: "Project Update",
        sourceCreatedAt: "2026-03-10T10:00:00Z",
        relevanceScore: 0.1, // low relevance (promotional)
      },
      {
        id: "rel-chunk-2",
        documentId: "doc-high-rel",
        chunkIndex: 0,
        content: "important project update from the team",
        embedding: dummyEmbedding,
        sourceId: "gmail:user@test.com",
        documentType: "email",
        title: "Project Update",
        sourceCreatedAt: "2026-03-10T10:00:00Z",
        relevanceScore: 0.9, // high relevance (personal)
      },
    ]);

    // The two docs have byte-identical content, so BM25 ranks them by an
    // arbitrary tiebreak and fusion separates them by one rank position
    // (~0.0003 at rrfK 60). The head bonuses are two orders of magnitude
    // larger, so with them on the ranking is decided by whichever doc BM25
    // happened to put first, not by relevance. Zero them to isolate the knob
    // under test.
    const pipeline = new SearchPipeline({
      indexDb: db,
      searchConfig: { params: { topRankBonus: 0, nearTopRankBonus: 0 } },
    });
    const response = await pipeline.search({ text: "project update" });

    expect(response.results.length).toBe(2);
    // High relevance should rank first
    expect(response.results[0].documentId).toBe("doc-high-rel");
    expect(response.results[0].scoreBreakdown?.relevanceBoost).toBeGreaterThan(1);
    expect(response.results[1].scoreBreakdown?.relevanceBoost).toBeLessThan(1);

    closeTempDb(db);
  });

  test("null relevance score is neutral (no penalty)", async () => {
    const dbPath = `/tmp/omnesis-search-rel2-${randomUUID()}.db`;
    const db = createIndexDatabase(dbPath);
    const dummyEmbedding = new Float32Array(EMBEDDING_DIM).fill(0);

    upsertChunks(db, [
      {
        id: "null-chunk-1",
        documentId: "doc-no-score",
        chunkIndex: 0,
        content: "team standup notes from monday",
        embedding: dummyEmbedding,
        sourceId: "whatsapp:local",
        documentType: "conversation",
        title: "Team Standup",
        sourceCreatedAt: "2026-03-10T10:00:00Z",
        // no relevanceScore — should be treated as neutral
      },
    ]);

    const pipeline = new SearchPipeline({ indexDb: db });
    const response = await pipeline.search({ text: "standup notes" });

    expect(response.results.length).toBe(1);
    // Should have no relevanceBoost entry
    expect(response.results[0].scoreBreakdown?.relevanceBoost).toBeUndefined();

    closeTempDb(db);
  });
});

describe("SearchPipeline (HTTP endpoint)", () => {
  test("POST /search endpoint", async () => {
    const { db: testDb } = createTestDb();
    const pipeline = new SearchPipeline({ indexDb: testDb });

    // Import and create server
    const { createServer } = await import("../server.js");
    const { createDatabase } = await import("../db.js");
    const { createToken } = await import("../data/repositories/TokenRepository.js");
    const { createDevice } = await import("../data/repositories/DeviceRepository.js");
    const { SCOPE_READ } = await import("@omnesis/core");
    const gwDbPath = `/tmp/omnesis-search-gw-${randomUUID()}.db`;
    const gwDb = createDatabase(gwDbPath);
    const dev = createDevice(gwDb, { name: "search-test", kind: "cli" });
    const { token: testToken } = createToken(gwDb, dev.id, [SCOPE_READ]);
    const sourceRuntimes: TestSourceRuntime[] = [];

    const app = createServer(gwDb, gwDbPath, {
      indexDb: testDb,
      searchPipeline: pipeline,
      ...sourceRuntimeHooks(sourceRuntimes),
    });

    try {
      // Test search endpoint
      const res = await app.request("/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testToken}`,
        },
        body: JSON.stringify({ text: "budget" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.results).toBeDefined();
      expect(data.results.length).toBeGreaterThan(0);
      expect(data.timing).toBeDefined();
      expect(data.timing.totalMs).toBeGreaterThanOrEqual(0);
      expect(sourceRuntimes.length).toBeGreaterThan(0);
    } finally {
      await closeHttpTestResources(sourceRuntimes, testDb, gwDb);
    }
  });

  test("POST /search returns 400 without text", async () => {
    const { db: testDb } = createTestDb();
    const pipeline = new SearchPipeline({ indexDb: testDb });

    const { createServer } = await import("../server.js");
    const { createDatabase } = await import("../db.js");
    const { createToken } = await import("../data/repositories/TokenRepository.js");
    const { createDevice } = await import("../data/repositories/DeviceRepository.js");
    const { SCOPE_READ } = await import("@omnesis/core");
    const gwDbPath = `/tmp/omnesis-search-gw2-${randomUUID()}.db`;
    const gwDb = createDatabase(gwDbPath);
    const dev2 = createDevice(gwDb, { name: "search-test-2", kind: "cli" });
    const { token: testToken2 } = createToken(gwDb, dev2.id, [SCOPE_READ]);
    const sourceRuntimes: TestSourceRuntime[] = [];

    const app = createServer(gwDb, gwDbPath, {
      indexDb: testDb,
      searchPipeline: pipeline,
      ...sourceRuntimeHooks(sourceRuntimes),
    });

    try {
      const res = await app.request("/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testToken2}`,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    } finally {
      await closeHttpTestResources(sourceRuntimes, testDb, gwDb);
    }
  });

  test("POST /search requires auth", async () => {
    const { db: testDb } = createTestDb();
    const pipeline = new SearchPipeline({ indexDb: testDb });

    const { createServer } = await import("../server.js");
    const { createDatabase } = await import("../db.js");
    const gwDbPath = `/tmp/omnesis-search-gw3-${randomUUID()}.db`;
    const gwDb = createDatabase(gwDbPath);
    const sourceRuntimes: TestSourceRuntime[] = [];

    const app = createServer(gwDb, gwDbPath, {
      indexDb: testDb,
      searchPipeline: pipeline,
      ...sourceRuntimeHooks(sourceRuntimes),
    });

    try {
      const res = await app.request("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "test" }),
      });

      expect(res.status).toBe(401);
    } finally {
      await closeHttpTestResources(sourceRuntimes, testDb, gwDb);
    }
  });
});

describe("SearchPipeline debug block", () => {
  const { db } = createTestDb();

  test("debug is absent when verbose is unset", async () => {
    const pipeline = new SearchPipeline({ indexDb: db });
    const response = await pipeline.search({ text: "budget" });
    expect(response.debug).toBeUndefined();
  });

  test("debug carries model state and query length when verbose=true", async () => {
    const pipeline = new SearchPipeline({ indexDb: db });
    const response = await pipeline.search({
      text: "budget review",
      verbose: true,
    });
    expect(response.debug).toBeDefined();
    expect(response.debug!.modelState.vector).toBe("unavailable");
    expect(response.debug!.query.inputLength).toBe("budget review".length);
  });

  test("debug reports the vector model 'ready' once an embedder is attached", async () => {
    const pipeline = new SearchPipeline({ indexDb: db });
    pipeline.setEmbedder({
      async embed(texts: string[]) {
        return texts.map(() => new Float32Array(EMBEDDING_DIM).fill(0.01));
      },
      async embedQuery() {
        return new Float32Array(EMBEDDING_DIM).fill(0.01);
      },
    });
    const response = await pipeline.search({
      text: "budget",
      verbose: true,
    });
    expect(response.debug!.modelState.vector).toBe("ready");
  });
});

describe("SearchPipeline (metadata hydration)", () => {
  test("hydrates mimeType + appUrl from documents.metadata onto results", async () => {
    const dbPath = `/tmp/omnesis-search-mime-${randomUUID()}.db`;
    const db = createIndexDatabase(dbPath);
    const dummyEmbedding = new Float32Array(EMBEDDING_DIM).fill(0);

    // A file doc that matches the query. The denormalized chunk row
    // carries no mimeType — it must be hydrated post-fusion from the
    // gateway DB's documents.metadata blob.
    upsertChunks(db, [
      {
        id: "mime-chunk-1",
        documentId: "doc-pdf-1",
        chunkIndex: 0,
        content: "Quarterly budget report with revenue projections",
        embedding: dummyEmbedding,
        sourceId: "google-drive:user@test.com",
        documentType: "file",
        title: "Budget Report.pdf",
        sourceCreatedAt: "2026-03-01T10:00:00Z",
      },
    ]);

    const gatewayDb = new Database(`/tmp/omnesis-gw-mime-${randomUUID()}.db`);
    gatewayDb.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, metadata TEXT)`);
    gatewayDb.prepare(`INSERT INTO documents (id, metadata) VALUES (?, ?)`).run(
      "doc-pdf-1",
      JSON.stringify({
        appUrl: "googledrive://file/doc-pdf-1",
        extra: { mimeType: "application/pdf" },
      }),
    );

    const pipeline = new SearchPipeline({ indexDb: db });
    pipeline.setGatewayDb(gatewayDb);
    const response = await pipeline.search({ text: "budget report" });

    const hit = response.results.find((r) => r.documentId === "doc-pdf-1");
    expect(hit).toBeDefined();
    expect(hit!.mimeType).toBe("application/pdf");
    expect(hit!.appUrl).toBe("googledrive://file/doc-pdf-1");

    closeTempDb(db);
    gatewayDb.close();
  });

  test("returns the document's own sourceUrl, not the chunk's canonical form", async () => {
    const db = createIndexDatabase(`/tmp/omnesis-search-url-${randomUUID()}.db`);
    // The chunk row holds the canonical link used for matching, which
    // Gmail does not open; the result must carry the published original.
    upsertChunks(db, [
      {
        id: "url-chunk-1",
        documentId: "doc-mail-1",
        chunkIndex: 0,
        content: "Quarterly budget review agenda",
        embedding: new Float32Array(EMBEDDING_DIM).fill(0),
        sourceId: "gmail:user@example.com",
        documentType: "email",
        title: "Budget review",
        sourceCreatedAt: "2026-03-01T10:00:00Z",
        sourceUrl: "https://mail.google.com/mail/#message/18c30b6251bb7dc2",
      },
    ]);
    const gatewayDb = new Database(`/tmp/omnesis-gw-url-${randomUUID()}.db`);
    gatewayDb.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, metadata TEXT)`);
    gatewayDb.prepare(`INSERT INTO documents (id, metadata) VALUES (?, ?)`).run(
      "doc-mail-1",
      JSON.stringify({
        sourceUrl:
          "https://mail.google.com/mail/u/0/?authuser=user%40example.com#all/18c30b6251bb7dc2",
      }),
    );

    const pipeline = new SearchPipeline({ indexDb: db });
    pipeline.setGatewayDb(gatewayDb);
    const response = await pipeline.search({ text: "budget review" });

    const hit = response.results.find((r) => r.documentId === "doc-mail-1");
    expect(hit?.sourceUrl).toBe(
      "https://mail.google.com/mail/u/0/?authuser=user%40example.com#all/18c30b6251bb7dc2",
    );

    closeTempDb(db);
    gatewayDb.close();
  });

  test("drops a chunk's link when the document no longer publishes one", async () => {
    const db = createIndexDatabase(`/tmp/omnesis-search-url2-${randomUUID()}.db`);
    upsertChunks(db, [
      {
        id: "url-chunk-2",
        documentId: "doc-note-2",
        chunkIndex: 0,
        content: "Quarterly budget planning notes",
        embedding: new Float32Array(EMBEDDING_DIM).fill(0),
        sourceId: "notes:local",
        documentType: "note",
        title: "Budget planning",
        sourceCreatedAt: "2026-03-01T10:00:00Z",
        sourceUrl: "fictional-app://notes/2",
      },
    ]);
    const gatewayDb = new Database(`/tmp/omnesis-gw-url2-${randomUUID()}.db`);
    gatewayDb.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, metadata TEXT)`);
    gatewayDb.prepare(`INSERT INTO documents (id, metadata) VALUES (?, ?)`).run("doc-note-2", "{}");

    const pipeline = new SearchPipeline({ indexDb: db });
    pipeline.setGatewayDb(gatewayDb);
    const response = await pipeline.search({ text: "budget planning" });

    const hit = response.results.find((r) => r.documentId === "doc-note-2");
    expect(hit).toBeDefined();
    expect(hit!.sourceUrl).toBeUndefined();

    closeTempDb(db);
    gatewayDb.close();
  });

  test("leaves mimeType undefined when metadata has no mimeType", async () => {
    const dbPath = `/tmp/omnesis-search-mime2-${randomUUID()}.db`;
    const db = createIndexDatabase(dbPath);
    const dummyEmbedding = new Float32Array(EMBEDDING_DIM).fill(0);

    upsertChunks(db, [
      {
        id: "mime-chunk-2",
        documentId: "doc-email-x",
        chunkIndex: 0,
        content: "Quarterly budget report discussion thread",
        embedding: dummyEmbedding,
        sourceId: "gmail:user@test.com",
        documentType: "email",
        title: "Budget thread",
        sourceCreatedAt: "2026-03-01T10:00:00Z",
      },
    ]);

    const gatewayDb = new Database(`/tmp/omnesis-gw-mime2-${randomUUID()}.db`);
    gatewayDb.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY, metadata TEXT)`);
    gatewayDb
      .prepare(`INSERT INTO documents (id, metadata) VALUES (?, ?)`)
      .run("doc-email-x", JSON.stringify({ sourceUrl: "https://mail.google.com/x" }));

    const pipeline = new SearchPipeline({ indexDb: db });
    pipeline.setGatewayDb(gatewayDb);
    const response = await pipeline.search({ text: "budget report" });

    const hit = response.results.find((r) => r.documentId === "doc-email-x");
    expect(hit).toBeDefined();
    expect(hit!.mimeType).toBeUndefined();

    closeTempDb(db);
    gatewayDb.close();
  });
});

/** A corpus where one source type floods the matches for a query. */
function createFloodCorpus() {
  const dbPath = `/tmp/omnesis-flood-test-${randomUUID()}.db`;
  const db = createIndexDatabase(dbPath);
  const emb = new Float32Array(EMBEDDING_DIM).fill(0);
  const mk = (id: string, sourceId: string) => ({
    id: `chunk-${id}`,
    documentId: `doc-${id}`,
    chunkIndex: 0,
    content: "quarterly report on the project status and next steps",
    embedding: emb,
    sourceId,
    documentType: "email",
    title: "Quarterly report",
    sourceCreatedAt: "2026-03-01T10:00:00Z",
  });
  upsertChunks(db, [
    mk("g1", "gmail:user@example.com"),
    mk("g2", "gmail:user@example.com"),
    mk("g3", "gmail:user@example.com"),
    mk("w1", "whatsapp:local"),
  ]);
  return { db };
}

describe("SearchPipeline — default Tier-1 levers engaged", () => {
  const { db } = createTestDb();
  afterAll(() => closeTempDb(db));

  test("diversity runs by default and emits a stage report", async () => {
    const pipeline = new SearchPipeline({ indexDb: db });
    const response = await pipeline.search({ text: "budget" });
    expect(response.stages?.diversity?.status).toBe("ran");
  });

  test("diversity is recall-neutral and absent when explicitly disabled", async () => {
    const on = new SearchPipeline({ indexDb: db });
    const off = new SearchPipeline({
      indexDb: db,
      searchConfig: { diversity: { enabled: false } },
    });
    const rOn = await on.search({ text: "budget" });
    const rOff = await off.search({ text: "budget" });
    expect(rOn.results.length).toBe(rOff.results.length);
    expect(rOff.stages?.diversity).toBeUndefined();
  });

  test("a per-source quota demotes a flooding source's surplus without dropping it", async () => {
    const { db: fdb } = createFloodCorpus();
    const pipeline = new SearchPipeline({
      indexDb: fdb,
      searchConfig: { diversity: { enabled: true, bucketBy: "type", maxPerSourceInTopK: 1 } },
    });
    const r = await pipeline.search({ text: "report" });
    // Recall-neutral: all four documents are still returned.
    expect(r.results.length).toBe(4);
    // The whatsapp doc is pulled above the 2nd/3rd gmail (surplus deferred).
    const whatsappRank = r.results.findIndex((x) => x.sourceId.startsWith("whatsapp"));
    const gmailRanks = r.results
      .map((x, i) => ({ i, gmail: x.sourceId.startsWith("gmail") }))
      .filter((x) => x.gmail)
      .map((x) => x.i);
    expect(whatsappRank).toBeGreaterThanOrEqual(0);
    expect(whatsappRank).toBeLessThan(gmailRanks[1]!);
    closeTempDb(fdb);
  });

  test("auto ISF prior boosts a rare source and leaves an unranked source unboosted", async () => {
    // whatsapp is the more common of the two counted sources (gets no boost);
    // apple-notes is rarer (gets a boost). The gmail source isn't in the
    // counts at all, so it resolves to a 0 prior — proving a source absent
    // from the corpus stats is never boosted.
    const counts = [
      { sourceId: "whatsapp:local", docCount: 50 },
      { sourceId: "apple-notes:local", docCount: 5 },
    ];
    const pipeline = new SearchPipeline({
      indexDb: db,
      getSourceDocCounts: () => counts,
      // Isolate ISF: no diversity reorder, and apply the prior to every rank.
      searchConfig: { diversity: { enabled: false }, sourcePriors: { bm25BypassRank: 0 } },
    });
    const r = await pipeline.search({ text: "budget" });
    const note = r.results.find((x) => x.documentId === "doc-note-1");
    const gmail = r.results.find((x) => x.sourceId.startsWith("gmail"));
    expect(note?.scoreBreakdown?.sourcePrior).toBeGreaterThan(0);
    expect(gmail?.scoreBreakdown?.sourcePrior).toBe(0);
  });
});

describe("SearchPipeline — cognitive projection (F3)", () => {
  function projectionDb() {
    const db = createIndexDatabase(`/tmp/omnesis-proj-test-${randomUUID()}.db`);
    const emb = new Float32Array(EMBEDDING_DIM).fill(0);
    upsertChunks(db, [
      {
        id: "c-doc",
        documentId: "doc-1",
        chunkIndex: 0,
        content: "Return of deposit for the flat; the deposit refund is pending from the landlord",
        embedding: emb,
        sourceId: "gmail:user@test.com",
        documentType: "email",
        title: "Deposit refund",
        sourceCreatedAt: "2026-03-01T10:00:00Z",
      },
      {
        // A hidden open-loop mirror (short, term-dense).
        id: "c-loop",
        documentId: "loop-mirror-1",
        chunkIndex: 0,
        content: "deposit refund",
        embedding: emb,
        sourceId: "open-loops",
        documentType: "open-loop",
        title: "Chase the deposit refund",
        sourceCreatedAt: "2026-03-05T10:00:00Z",
      },
    ]);
    return db;
  }

  test("excludes the loop mirror by default; surfaces it (alongside the doc) under cognitiveProjection", async () => {
    const db = projectionDb();
    const pipeline = new SearchPipeline({ indexDb: db });
    try {
      const off = await pipeline.search({ text: "deposit refund" });
      expect(off.results.map((r) => r.documentId)).toEqual(["doc-1"]); // mirror hidden by default

      const on = await pipeline.search({
        text: "deposit refund",
        cognitiveProjection: true,
      });
      const ids = on.results.map((r) => r.documentId);
      // Co-surfacing: the mirror now appears alongside the real doc. The
      // deterministic down-weight (mirror ranks below an equal-scored doc) is
      // locked by boost-stage.test.ts; asserting a magnitude-dependent ordering
      // over raw BM25 here would be a latent flake, so we only assert presence.
      expect(ids).toContain("loop-mirror-1");
      expect(ids).toContain("doc-1");
    } finally {
      closeTempDb(db);
    }
  });

  test("gating: cognitiveProjection is ignored when experimental mode is off", async () => {
    const db = projectionDb();
    const pipeline = new SearchPipeline({ indexDb: db });
    const prior = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "0";
    try {
      const res = await pipeline.search({
        text: "deposit refund",
        cognitiveProjection: true,
      });
      expect(res.results.map((r) => r.documentId)).toEqual(["doc-1"]); // gate closed -> still hidden
    } finally {
      if (prior === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = prior;
      closeTempDb(db);
    }
  });
});

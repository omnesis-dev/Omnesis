// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { UnsupportedSearchFilterError } from "@omnesis/agent";
import { createCorpusAuthorization } from "../access/corpus-authorization.js";

type Db = Database.Database;

import { createDatabase } from "../db.js";
import { createDocAnnotation } from "../brain/storage/annotations.js";
import { createOpenLoop } from "../brain/storage/open-loops.js";
import {
  createGatewayDocumentByUrlPort,
  createGatewayDocumentPort,
  createGatewaySearchPort,
  createGatewayTrailPort,
} from "./ports.js";
import type Database from "better-sqlite3";
import type { AnalyticsDb } from "../analytics-db.js";
import type { SearchPipeline } from "../search/pipeline.js";
import type { SearchResultItem } from "../search/types.js";

function restrictedAuthorization(mode: "allowlist" | "denylist", sourceIds: string[]) {
  return createCorpusAuthorization(
    {
      principalId: "principal-example",
      grantId: "grant-example",
      grantRevision: 1,
      credentialId: "credential-example",
      accessTokenId: "token-example",
    },
    [
      {
        capability: "direct",
        sourceMode: mode,
        sourceIds,
        releaseMode: null,
        policyFamilyId: null,
        policyRevision: null,
        privacyPolicy: null,
      },
    ],
    "direct",
  )!;
}

// A no-bound-rows analytics stub: these trail-budget tests don't exercise the
// bound-row surfacing (no analytics tables), so the resolver reports zero
// bindings and the walk runs exactly as the pure document graph.
const noAnalytics = {
  getBoundDocumentBindings: async () => new Map(),
  getRecordTableSchema: async () => null,
} as unknown as AnalyticsDb;

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-ports-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert a resolved document_links row (source → target). */
function seedLink(sourceDocId: string, linkType: string, targetDocId: string) {
  db.prepare(
    `INSERT INTO document_links
       (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at)
     VALUES (?, ?, ?, ?, ?, '2026-03-01', '2026-03-01')`,
  ).run(sourceDocId, linkType, targetDocId, targetDocId, targetDocId);
}

function insertDocument(args: {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  mimeType?: string;
}) {
  db.prepare(
    "INSERT OR IGNORE INTO devices (id, name, kind, paired_at) VALUES ('00000000-0000-4000-8000-000000000001', 'Test device', 'desktop', 1)",
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO sources
       (id, type, account_id, device_id, created_at, updated_at)
     VALUES (?, ?, ?, '00000000-0000-4000-8000-000000000001', 1, 1)`,
  ).run(
    args.sourceId,
    args.sourceId.split(":", 1)[0],
    args.sourceId.includes(":") ? args.sourceId.slice(args.sourceId.indexOf(":") + 1) : "test",
  );
  const metadata = JSON.stringify({
    documentType: "file",
    ...(args.mimeType ? { extra: { mimeType: args.mimeType } } : {}),
  });
  db.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', ?, ?, ?, ?, 'hash-' || ?, ?, '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01')`,
  ).run(args.id, args.sourceId, args.id, args.title, args.content, args.id, metadata);
}

/** A document the gateway wrote itself: no `sources` row backs its source id. */
function insertGatewayAuthoredDocument(args: {
  id: string;
  sourceId: string;
  content: string;
  sourceUrl?: string;
}) {
  db.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url)
     VALUES (?, 'system', ?, ?, ?, ?, 'hash-' || ?, '{}', '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01', ?)`,
  ).run(args.id, args.sourceId, args.id, args.id, args.content, args.id, args.sourceUrl ?? null);
}

function seedMemoryDocument() {
  insertDocument({
    id: "doc-memory",
    sourceId: "files:test",
    title: "Project notes",
    content: "This is the draft project schedule.",
  });
  createDocAnnotation(
    db,
    {
      id: "annotation-memory",
      docId: "doc-memory",
      claimType: "status",
      claimText: "This schedule is a draft.",
      evidenceDocId: "doc-memory",
      evidenceQuote: "This is the draft project schedule.",
      confidence: 0.8,
      createdByRun: "interactive_session",
      claimBasis: "quoted",
    },
    3000,
  );
  createOpenLoop(
    db,
    {
      id: "loop-memory",
      title: "Review draft",
      confidence: 0.8,
      importance: 0.5,
      createdByRun: "run",
      docs: ["doc-memory"],
    },
    3000,
  );
}

describe("createGatewayDocumentPort.fetch", () => {
  test("stable fetch surfaces memory while restricted fetch omits it", async () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    vi.stubEnv("OMNESIS_SYNTHETIC", "0");
    try {
      seedMemoryDocument();
      const result = await createGatewayDocumentPort(db).fetch("doc-memory");
      expect(result?.ref.annotations).toEqual([
        expect.objectContaining({ claim: "This schedule is a draft." }),
      ]);
      expect(result?.ref.openLoops).toBeUndefined();
      expect(result?.ref.temporalAnnotations).toBeUndefined();
      const restricted = createGatewayDocumentPort(
        db,
        undefined,
        undefined,
        restrictedAuthorization("allowlist", ["files:test"]),
      );
      expect((await restricted.fetch("doc-memory"))?.ref.annotations).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("emits mimeType from metadata.extra so renderers pick the file-type icon", async () => {
    insertDocument({
      id: "doc-pdf",
      sourceId: "google-drive:self",
      title: "Budget Report.pdf",
      content: "Revenue projections for Q4.",
      mimeType: "application/pdf",
    });

    const port = createGatewayDocumentPort(db);
    const out = await port.fetch("doc-pdf");
    expect(out?.ref.documentId).toBe("doc-pdf");
    expect(out?.ref.mimeType).toBe("application/pdf");
  });

  test("leaves mimeType undefined when the document has no mimeType in metadata", async () => {
    insertDocument({
      id: "doc-email",
      sourceId: "gmail:self",
      title: "Budget thread",
      content: "Discussion about the Q4 numbers.",
    });

    const port = createGatewayDocumentPort(db);
    const out = await port.fetch("doc-email");
    expect(out?.ref.documentId).toBe("doc-email");
    expect(out?.ref.mimeType).toBeUndefined();
  });

  test("rejects an oversized stored row before constructing a full document result", async () => {
    insertDocument({
      id: "doc-oversized",
      sourceId: "google-drive:self",
      title: "Synthetic oversized report",
      content: "x".repeat(1024),
    });

    const port = createGatewayDocumentPort(db, undefined, { maxStoredDocumentBytes: 256 });
    await expect(port.fetch("doc-oversized")).rejects.toThrow("read-size limit");

    const ordinaryPort = createGatewayDocumentPort(db);
    await expect(ordinaryPort.fetch("doc-oversized")).resolves.toMatchObject({
      document: { content: "x".repeat(1024) },
    });
  });

  test("refuses denied documents and omits neighbours for allowed documents", async () => {
    insertDocument({ id: "allowed", sourceId: "mail:alpha", title: "Allowed", content: "safe" });
    insertDocument({
      id: "denied",
      sourceId: "mail:beta",
      title: "Denied",
      content: "DENIED_CANARY",
    });
    seedLink("allowed", "related", "denied");
    const port = createGatewayDocumentPort(
      db,
      undefined,
      undefined,
      restrictedAuthorization("allowlist", ["mail:alpha"]),
    );
    await expect(port.fetch("denied")).resolves.toBeNull();
    await expect(port.fetch("allowed", { includeNeighbors: true })).resolves.toMatchObject({
      ref: { documentId: "allowed" },
    });
    expect((await port.fetch("allowed", { includeNeighbors: true }))?.neighbors).toBeUndefined();
  });

  test("a denylist never reaches a gateway-authored document, which no rule can name", async () => {
    insertDocument({ id: "allowed", sourceId: "mail:alpha", title: "Allowed", content: "safe" });
    insertDocument({ id: "denied", sourceId: "mail:beta", title: "Denied", content: "denied" });
    insertGatewayAuthoredDocument({
      id: "transcript",
      sourceId: "omnesis-chat",
      content: "TRANSCRIPT_CANARY",
    });
    insertGatewayAuthoredDocument({
      id: "loop-mirror",
      sourceId: "open-loops",
      content: "LOOP_CANARY",
    });
    const port = createGatewayDocumentPort(
      db,
      undefined,
      undefined,
      restrictedAuthorization("denylist", ["mail:beta"]),
    );
    await expect(port.fetch("allowed")).resolves.toMatchObject({ ref: { documentId: "allowed" } });
    await expect(port.fetch("denied")).resolves.toBeNull();
    await expect(port.fetch("transcript")).resolves.toBeNull();
    await expect(port.fetch("loop-mirror")).resolves.toBeNull();
  });
});

describe("createGatewayDocumentByUrlPort.lookup", () => {
  test("a denylist never resolves a URL to a gateway-authored document", async () => {
    insertDocument({ id: "allowed", sourceId: "mail:alpha", title: "Allowed", content: "safe" });
    db.prepare("UPDATE documents SET source_url = ? WHERE id = 'allowed'").run(
      "https://example.org/allowed",
    );
    insertGatewayAuthoredDocument({
      id: "transcript",
      sourceId: "omnesis-chat",
      content: "TRANSCRIPT_CANARY",
      sourceUrl: "https://example.org/transcript",
    });
    const port = createGatewayDocumentByUrlPort(
      db,
      undefined,
      restrictedAuthorization("denylist", ["mail:beta"]),
    );
    await expect(port.lookup("https://example.org/allowed")).resolves.toMatchObject({
      ref: { documentId: "allowed" },
    });
    const transcript = await port.lookup("https://example.org/transcript");
    expect(transcript.ref).toBeUndefined();
    expect(JSON.stringify(transcript)).not.toContain("TRANSCRIPT_CANARY");
  });
});

describe("createGatewaySearchPort.search", () => {
  /**
   * Fake pipeline returning a single hydrated result. Isolates the
   * `searchResultToDocRef` mapping (the SearchPort → DocRef hop the
   * agent uses most) from the search engine itself.
   */
  function fakePipeline(item: SearchResultItem): SearchPipeline {
    return fakePipelineMulti([item]);
  }

  /** Fake pipeline returning N hydrated results in rank order. */
  function fakePipelineMulti(items: SearchResultItem[]): SearchPipeline {
    return {
      search: async () => ({
        timing: { totalMs: 1 },
        results: items,
      }),
    } as unknown as SearchPipeline;
  }

  const baseItem: SearchResultItem = {
    documentId: "doc-pdf",
    sourceId: "google-drive:self",
    documentType: "file",
    title: "Budget Report.pdf",
    sourceCreatedAt: "2026-03-01T10:00:00Z",
    chunkText: "Revenue projections for Q4.",
    score: 1,
  };

  test("stable search surfaces grounded memory without experimental loops", async () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    vi.stubEnv("OMNESIS_SYNTHETIC", "0");
    try {
      seedMemoryDocument();
      const port = createGatewaySearchPort(
        fakePipeline({ ...baseItem, documentId: "doc-memory", sourceId: "files:test" }),
        undefined,
        db,
      );
      const result = await port.search({ query: "project schedule" });
      expect(result.results[0]?.annotations).toEqual([
        expect.objectContaining({ claim: "This schedule is a draft." }),
      ]);
      expect(result.results[0]?.openLoops).toBeUndefined();
      expect(result.results[0]?.temporalAnnotations).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("carries mimeType from the search result into the DocRef", async () => {
    const port = createGatewaySearchPort(
      fakePipeline({ ...baseItem, mimeType: "application/pdf" }),
    );
    const out = await port.search({ query: "budget report" });
    expect(out.results[0]?.documentId).toBe("doc-pdf");
    expect(out.results[0]?.mimeType).toBe("application/pdf");
  });

  test("leaves mimeType undefined when the search result has none", async () => {
    const port = createGatewaySearchPort(fakePipeline(baseItem));
    const out = await port.search({ query: "budget report" });
    expect(out.results[0]?.mimeType).toBeUndefined();
  });

  test("hands a separate hard source intersection to ranking and drops denied canaries", async () => {
    insertDocument({ id: "alpha", sourceId: "mail:alpha", title: "Alpha", content: "safe" });
    insertDocument({ id: "beta", sourceId: "mail:beta", title: "Beta", content: "DENIED_CANARY" });
    insertDocument({ id: "future", sourceId: "mail:future", title: "Future", content: "future" });
    const search = vi.fn<SearchPipeline["search"]>(async () => ({
      query: { original: "source:mail DENIED_CANARY" },
      timing: { totalMs: 1 },
      results: [
        { ...baseItem, documentId: "beta", sourceId: "mail:beta", chunkText: "DENIED_CANARY" },
        {
          ...baseItem,
          documentId: "future",
          sourceId: "mail:future",
          chunkText: "future",
          refCount: 9,
        },
      ],
    }));
    const port = createGatewaySearchPort(
      { search } as unknown as SearchPipeline,
      undefined,
      db,
      restrictedAuthorization("denylist", ["mail:beta"]),
    );
    const result = await port.search({ query: "source:mail DENIED_CANARY" });
    expect(search.mock.calls[0]?.[1]).toEqual({ sourceIds: ["mail:alpha", "mail:future"] });
    expect(result.results.map((item) => item.documentId)).toEqual(["future"]);
    expect(result.results[0]?.refCount).toBeUndefined();
    expect(JSON.stringify(result.results)).not.toContain("DENIED_CANARY");
  });

  test("a denylist search drops a gateway-authored hit the pipeline let through", async () => {
    insertDocument({ id: "alpha", sourceId: "mail:alpha", title: "Alpha", content: "safe" });
    insertGatewayAuthoredDocument({
      id: "transcript",
      sourceId: "omnesis-chat",
      content: "TRANSCRIPT_CANARY",
    });
    const search = vi.fn<SearchPipeline["search"]>(async () => ({
      query: { original: "canary" },
      timing: { totalMs: 1 },
      results: [
        { ...baseItem, documentId: "alpha", sourceId: "mail:alpha", chunkText: "safe" },
        {
          ...baseItem,
          documentId: "transcript",
          sourceId: "omnesis-chat",
          chunkText: "TRANSCRIPT_CANARY",
        },
      ],
    }));
    const port = createGatewaySearchPort(
      { search } as unknown as SearchPipeline,
      undefined,
      db,
      restrictedAuthorization("denylist", ["mail:beta"]),
    );
    const result = await port.search({ query: "canary" });
    expect(search.mock.calls[0]?.[1]).toEqual({ sourceIds: ["mail:alpha"] });
    expect(result.results.map((item) => item.documentId)).toEqual(["alpha"]);
    expect(JSON.stringify(result.results)).not.toContain("TRANSCRIPT_CANARY");
  });

  test("a restricted search refuses person and tag filters by name instead of dropping them", async () => {
    insertDocument({ id: "alpha", sourceId: "mail:alpha", title: "Alpha", content: "safe" });
    const search = vi.fn<SearchPipeline["search"]>(async () => ({
      query: { original: "" },
      timing: { totalMs: 1 },
      results: [],
    }));
    const port = createGatewaySearchPort(
      { search } as unknown as SearchPipeline,
      undefined,
      db,
      restrictedAuthorization("allowlist", ["mail:alpha"]),
    );
    await expect(port.search({ query: "budget from:maya" })).rejects.toThrow(
      /the from:maya filter is not available/,
    );
    await expect(port.search({ query: "budget to:maya" })).rejects.toThrow(/to:maya filter/);
    await expect(port.search({ query: "budget with:maya" })).rejects.toThrow(/with:maya filter/);
    await expect(port.search({ query: "budget tag:work" })).rejects.toThrow(/tag:work filter/);
    await expect(port.search({ query: "budget #work" })).rejects.toThrow(/#work filter/);
    await expect(port.search({ query: "budget from:maya tag:work" })).rejects.toThrow(
      /the from:maya, tag:work filters are not available to it\. Remove them/,
    );
    expect(search).not.toHaveBeenCalled();
    await expect(
      port.search({ query: "budget type:email after:2026-01-01" }),
    ).resolves.toMatchObject({ results: [] });
    expect(search).toHaveBeenCalledOnce();
  });

  test("a refused filter is a typed error naming the token as the caller typed it", async () => {
    const search = vi.fn<SearchPipeline["search"]>();
    const port = createGatewaySearchPort(
      { search } as unknown as SearchPipeline,
      undefined,
      db,
      restrictedAuthorization("allowlist", ["mail:alpha"]),
    );
    const failure = await port.search({ query: "budget by:maya" }).catch((error) => error);
    expect(failure).toBeInstanceOf(UnsupportedSearchFilterError);
    expect((failure as UnsupportedSearchFilterError).tokens).toEqual(["by:maya"]);
    expect((failure as Error).message).toContain("by:maya");
    expect((failure as Error).message).not.toContain("from:");
    expect(search).not.toHaveBeenCalled();
  });

  test("an authorization without a database is refused at construction", () => {
    const search = vi.fn<SearchPipeline["search"]>();
    expect(() =>
      createGatewaySearchPort(
        { search } as unknown as SearchPipeline,
        undefined,
        undefined as unknown as Db,
        restrictedAuthorization("allowlist", ["mail:alpha"]),
      ),
    ).toThrow(/needs the database/);
  });

  test("an unrestricted search keeps forwarding person and tag filters", async () => {
    const search = vi.fn<SearchPipeline["search"]>(async () => ({
      query: { original: "" },
      timing: { totalMs: 1 },
      results: [],
    }));
    const port = createGatewaySearchPort({ search } as unknown as SearchPipeline, undefined, db);
    await expect(port.search({ query: "budget from:maya #work" })).resolves.toMatchObject({
      results: [],
    });
    expect(search).toHaveBeenCalledOnce();
  });

  // ─── refCount surfacing ─────────────────────────────────────────────────

  test("surfaces refCount onto the DocRef", async () => {
    const port = createGatewaySearchPort(fakePipeline({ ...baseItem, refCount: 7 }));
    const out = await port.search({ query: "budget report" });
    expect(out.results[0]?.refCount).toBe(7);
  });

  test("omits refCount when the stage set none (isolated doc)", async () => {
    const port = createGatewaySearchPort(fakePipeline(baseItem));
    const out = await port.search({ query: "budget report" });
    expect(out.results[0]?.refCount).toBeUndefined();
  });

  test("omits an explicit refCount of 0 (sparse-by-construction; pins the > 0 guard)", async () => {
    const port = createGatewaySearchPort(fakePipeline({ ...baseItem, refCount: 0 }));
    const out = await port.search({ query: "budget report" });
    expect(out.results[0]?.refCount).toBeUndefined();
  });

  // ─── Top-hit breadcrumb ─────────────────────────────────────────────────

  test("attaches a 1-hop breadcrumb to a top hit", async () => {
    insertDocument({
      id: "seed-hit",
      sourceId: "gmail:self",
      title: "Q4 Vendor Assessment",
      content: "the email body",
    });
    insertDocument({
      id: "att-1",
      sourceId: "gmail:self",
      title: "Q4-Vendor-Assessment.pdf",
      content: "the pdf",
    });
    seedLink("seed-hit", "contains", "att-1");

    const port = createGatewaySearchPort(
      fakePipeline({ ...baseItem, documentId: "seed-hit", sourceId: "gmail:self" }),
      undefined,
      db,
    );
    const out = await port.search({ query: "vendor assessment" });
    const crumbs = out.results[0]?.breadcrumb;
    expect(crumbs).toHaveLength(1);
    expect(crumbs?.[0]).toMatchObject({
      documentId: "att-1",
      title: "Q4-Vendor-Assessment.pdf",
      edge: "contains",
    });
  });

  test("a hit with no neighbours gets no breadcrumb", async () => {
    insertDocument({ id: "seed-hit", sourceId: "gmail:self", title: "Hit", content: "x" });
    const port = createGatewaySearchPort(
      fakePipeline({ ...baseItem, documentId: "seed-hit", sourceId: "gmail:self" }),
      undefined,
      db,
    );
    const out = await port.search({ query: "x" });
    expect(out.results[0]?.breadcrumb).toBeUndefined();
  });

  test("breadcrumbs attach only to the top 3 hits, never the 4th (pins BREADCRUMB_TOP_N)", async () => {
    // Four hits, each with its own attachment neighbour. The breadcrumb cap
    // must walk the top 3 and leave the 4th bare regardless of its neighbour.
    const items: SearchResultItem[] = [];
    for (let i = 0; i < 4; i++) {
      insertDocument({ id: `hit-${i}`, sourceId: "gmail:self", title: `Hit ${i}`, content: "x" });
      insertDocument({ id: `att-${i}`, sourceId: "gmail:self", title: `Att ${i}`, content: "y" });
      seedLink(`hit-${i}`, "contains", `att-${i}`);
      items.push({ ...baseItem, documentId: `hit-${i}`, sourceId: "gmail:self" });
    }
    const port = createGatewaySearchPort(fakePipelineMulti(items), undefined, db);
    const out = await port.search({ query: "hits" });

    expect(out.results[0]?.breadcrumb).toHaveLength(1);
    expect(out.results[1]?.breadcrumb).toHaveLength(1);
    expect(out.results[2]?.breadcrumb).toHaveLength(1);
    expect(out.results[3]?.breadcrumb).toBeUndefined();
  });
});

// ─── Document-port neighbours: includeNeighbors honored ──────────────────────

describe("createGatewayDocumentPort.fetch — includeNeighbors", () => {
  function seedSeedAndNeighbor() {
    insertDocument({
      id: "doc-seed",
      sourceId: "gmail:self",
      title: "Vendor email",
      content: "Please see the attached assessment.",
    });
    insertDocument({
      id: "doc-att",
      sourceId: "gmail:self",
      title: "Q4-Vendor-Assessment.pdf",
      content: "the attached pdf body",
      mimeType: "application/pdf",
    });
    seedLink("doc-seed", "contains", "doc-att");
  }

  test("returns neighbours when includeNeighbors:true", async () => {
    seedSeedAndNeighbor();
    const out = await createGatewayDocumentPort(db).fetch("doc-seed", { includeNeighbors: true });
    expect(out?.neighbors).toBeDefined();
    expect(out?.neighbors?.map((n) => n.documentId)).toEqual(["doc-att"]);
    const att = out?.neighbors?.[0];
    expect(att).toMatchObject({ documentId: "doc-att", mimeType: "application/pdf" });
    // The neighbour DocRef carries NO snippet — a neighbour is a pointer, not
    // a payload (the re-bill multiplier).
    expect(att?.snippet).toBeUndefined();
    // One neighbour, all returned → not truncated.
    expect(out?.neighborsTruncated).toBe(false);
  });

  test("sets neighborsTruncated when the doc has more neighbours than the cap", async () => {
    insertDocument({
      id: "thread-seed",
      sourceId: "gmail:self",
      title: "Thread head",
      content: "x",
    });
    for (let i = 0; i < 12; i++) {
      insertDocument({
        id: `reply-${i}`,
        sourceId: "gmail:self",
        title: `Reply ${i}`,
        content: "y",
      });
      seedLink("thread-seed", "part-of-thread", `reply-${i}`);
    }
    const out = await createGatewayDocumentPort(db).fetch("thread-seed", {
      includeNeighbors: true,
    });
    expect(out?.neighbors).toBeDefined();
    expect(out?.neighborsTruncated).toBe(true);
  });

  test("returns NO neighbours when includeNeighbors is not set", async () => {
    seedSeedAndNeighbor();
    const out = await createGatewayDocumentPort(db).fetch("doc-seed");
    expect(out?.neighbors).toBeUndefined();
  });
});

// ─── Trail port: honest trace_connections budget ───────────────────────────────────

describe("createGatewayTrailPort.build — default depth budget", () => {
  /** A linear chain chain-0 → chain-1 → … → chain-N via intra-source links. */
  function seedChain(n: number) {
    for (let i = 0; i <= n; i++) {
      insertDocument({
        id: `chain-${i}`,
        sourceId: "notion:self",
        title: `Page ${i}`,
        content: "x",
      });
    }
    for (let i = 0; i < n; i++) seedLink(`chain-${i}`, "references", `chain-${i + 1}`);
  }

  test("an unparameterised trail honours the documented depth-4 budget", async () => {
    seedChain(6); // depth-4 walk reaches chain-0..chain-4 only = 5 docs
    const trail = await createGatewayTrailPort(db, noAnalytics).build(["chain-0"]);
    expect(trail.stats.visited).toBe(5);
  });

  test("an explicit depth arg overrides the default", async () => {
    seedChain(6);
    const trail = await createGatewayTrailPort(db, noAnalytics).build(["chain-0"], { depth: 2 });
    expect(trail.stats.visited).toBe(3); // chain-0..chain-2
  });
});

describe("createGatewaySearchPort — the agent's own conversation", () => {
  /**
   * Each conversation is written back as one document, so once a turn has
   * been persisted the next turn can retrieve the record of the conversation
   * it is currently having. The agent cannot recognise that document as
   * itself; the port removes it.
   *
   * All fixture data is invented — never corpus-derived.
   */
  const CONVERSATION_ID = "s_11111111-2222-3333-4444-555555555555";

  function insertConversationDoc(externalId: string, docId: string, title: string) {
    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, 'system', 'omnesis-chat', ?, ?, 'transcript', 'hash-' || ?, ?,
               '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01')`,
    ).run(docId, externalId, title, docId, JSON.stringify({ documentType: "omnesis-chat" }));
  }

  function chatItem(documentId: string, title: string): SearchResultItem {
    return {
      documentId,
      sourceId: "omnesis-chat",
      documentType: "omnesis-chat",
      title,
      sourceCreatedAt: "2026-03-01T10:00:00Z",
      chunkText: "an earlier exchange",
      score: 1,
    };
  }

  const otherItem: SearchResultItem = {
    documentId: "doc-email",
    sourceId: "gmail:self",
    documentType: "email",
    title: "Quarterly summary",
    sourceCreatedAt: "2026-03-01T10:00:00Z",
    chunkText: "the figures",
    score: 0.9,
  };

  test("drops the in-progress conversation from its own results", async () => {
    insertConversationDoc(CONVERSATION_ID, "doc-self", "This very conversation");
    const pipeline = {
      search: async () => ({
        timing: { totalMs: 1 },
        results: [chatItem("doc-self", "This very conversation"), otherItem],
      }),
    } as unknown as SearchPipeline;

    const port = createGatewaySearchPort(pipeline, undefined, db);
    const out = await port.search({
      query: "what did we decide",
      currentConversationId: CONVERSATION_ID,
    });
    expect(out.results.map((r) => r.documentId)).toEqual(["doc-email"]);
  });

  test("keeps other past conversations — only the current one is excluded", async () => {
    insertConversationDoc(CONVERSATION_ID, "doc-self", "This very conversation");
    insertConversationDoc("s_99999999-8888-7777-6666-555555555555", "doc-earlier", "An older one");
    const pipeline = {
      search: async () => ({
        timing: { totalMs: 1 },
        results: [
          chatItem("doc-self", "This very conversation"),
          chatItem("doc-earlier", "An older one"),
        ],
      }),
    } as unknown as SearchPipeline;

    const port = createGatewaySearchPort(pipeline, undefined, db);
    const out = await port.search({
      query: "what did we decide",
      currentConversationId: CONVERSATION_ID,
    });
    // The user's own words in earlier conversations stay retrievable; it is
    // only reading this turn's own transcript back that is circular.
    expect(out.results.map((r) => r.documentId)).toEqual(["doc-earlier"]);
  });

  test("is a no-op before this conversation has been persisted", async () => {
    // First turn: nothing written back yet, so there is no document to drop.
    const pipeline = {
      search: async () => ({ timing: { totalMs: 1 }, results: [otherItem] }),
    } as unknown as SearchPipeline;
    const port = createGatewaySearchPort(pipeline, undefined, db);
    const out = await port.search({
      query: "anything",
      currentConversationId: CONVERSATION_ID,
    });
    expect(out.results.map((r) => r.documentId)).toEqual(["doc-email"]);
  });

  test("does not hand the conversation back as a breadcrumb of its own citation", async () => {
    // Every citation this conversation has made is an edge from the
    // conversation document to the cited one, and the breadcrumb walk is
    // bidirectional — so the conversation is a neighbour of everything it has
    // already cited. Filtering the result list alone would still leak its id.
    insertConversationDoc(CONVERSATION_ID, "doc-self", "This very conversation");
    insertDocument({
      id: "doc-cited",
      sourceId: "gmail:self",
      title: "Quarterly summary",
      content: "the figures",
    });
    seedLink("doc-self", "cited", "doc-cited");

    const pipeline = {
      search: async () => ({
        timing: { totalMs: 1 },
        results: [
          {
            documentId: "doc-cited",
            sourceId: "gmail:self",
            documentType: "email",
            title: "Quarterly summary",
            sourceCreatedAt: "2026-03-01T10:00:00Z",
            chunkText: "the figures",
            score: 1,
          } satisfies SearchResultItem,
        ],
      }),
    } as unknown as SearchPipeline;

    const port = createGatewaySearchPort(pipeline, undefined, db);
    const out = await port.search({
      query: "quarterly",
      currentConversationId: CONVERSATION_ID,
    });
    expect(out.results.map((r) => r.documentId)).toEqual(["doc-cited"]);
    const breadcrumbIds = (out.results[0]?.breadcrumb ?? []).map((b) => b.documentId);
    expect(breadcrumbIds).not.toContain("doc-self");
  });

  test("still surfaces ordinary neighbours in the breadcrumb", async () => {
    // The exclusion must not silence the breadcrumb wholesale.
    insertConversationDoc(CONVERSATION_ID, "doc-self", "This very conversation");
    insertDocument({
      id: "doc-cited",
      sourceId: "gmail:self",
      title: "Quarterly summary",
      content: "the figures",
    });
    insertDocument({
      id: "doc-attach",
      sourceId: "gmail:self",
      title: "figures.pdf",
      content: "a table",
    });
    seedLink("doc-self", "cited", "doc-cited");
    seedLink("doc-cited", "contains", "doc-attach");

    const pipeline = {
      search: async () => ({
        timing: { totalMs: 1 },
        results: [
          {
            documentId: "doc-cited",
            sourceId: "gmail:self",
            documentType: "email",
            title: "Quarterly summary",
            sourceCreatedAt: "2026-03-01T10:00:00Z",
            chunkText: "the figures",
            score: 1,
          } satisfies SearchResultItem,
        ],
      }),
    } as unknown as SearchPipeline;

    const port = createGatewaySearchPort(pipeline, undefined, db);
    const out = await port.search({
      query: "quarterly",
      currentConversationId: CONVERSATION_ID,
    });
    const breadcrumbIds = (out.results[0]?.breadcrumb ?? []).map((b) => b.documentId);
    expect(breadcrumbIds).toContain("doc-attach");
    expect(breadcrumbIds).not.toContain("doc-self");
  });

  test("leaves results untouched when the caller names no conversation", async () => {
    insertConversationDoc(CONVERSATION_ID, "doc-self", "This very conversation");
    const pipeline = {
      search: async () => ({
        timing: { totalMs: 1 },
        results: [chatItem("doc-self", "This very conversation")],
      }),
    } as unknown as SearchPipeline;
    const port = createGatewaySearchPort(pipeline, undefined, db);
    const out = await port.search({ query: "anything" });
    expect(out.results.map((r) => r.documentId)).toEqual(["doc-self"]);
  });
});

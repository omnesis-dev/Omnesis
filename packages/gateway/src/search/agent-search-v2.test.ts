// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { computeContentHash, type SearchProvenance } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { saveKnowledgeNode, purgeKnowledgeBySource } from "../brain/knowledge/storage.js";
import { buildKnowledgeDocumentInput } from "../brain/knowledge/mirror.js";
import { createGatewaySearchPort } from "../agent/ports.js";
import { createCorpusAuthorization } from "../access/corpus-authorization.js";
import { OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID } from "../sources/omnesis-chat/ids.js";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  setIndexedDocument,
  upsertChunks,
} from "../indexer/db.js";
import { SearchPipeline } from "./pipeline.js";
import { closeTempDb } from "./test-utils.js";
import type Database from "better-sqlite3";
import type { SearchConfig } from "./search-config.js";

const BODY =
  "The invented Northstar equipment agreement specifies delivery in September, replacement parts, inspection, and a twelve-month warranty.";
const SOURCE = "archive:fictional";
const DEVICE = "00000000-0000-4000-8000-000000000099";
const NOW = "2025-02-01T10:00:00Z";
let gateway: Database.Database;
let index: Database.Database;

beforeEach(() => {
  gateway = createDatabase(`/tmp/omnesis-test-${randomUUID()}.db`);
  index = createIndexDatabase(`/tmp/omnesis-test-${randomUUID()}.db`);
  gateway
    .prepare(
      "INSERT INTO devices (id,name,kind,paired_at) VALUES (?,'Example desktop','collector',1)",
    )
    .run(DEVICE);
  gateway
    .prepare(
      "INSERT INTO sources (id,type,account_id,device_id,created_at,updated_at) VALUES (?,'archive','fictional',?,1,1)",
    )
    .run(SOURCE, DEVICE);
  addFile("a", "Agreement", BODY);
  addFile("b", "Agreement copy", BODY);
  addFile("c", "Agreement revised", BODY + " Inspection is now required twice.");
});

afterEach(() => {
  vi.unstubAllEnvs();
  closeTempDb(index);
  closeTempDb(gateway);
});

function addFile(id: string, title: string, body: string): void {
  const content = `# ${title}\n\n---\n\n${body}`;
  const hash = computeContentHash(content);
  const url = `https://example.org/${id}`;
  gateway
    .prepare(
      `INSERT INTO documents
    (id,provider_id,source_id,external_id,title,content,content_hash,extracted_content_hash,metadata,
     source_created_at,source_updated_at,ingested_at,updated_at,source_url)
    VALUES (?,'fictional',?,?,?,?,?,?,?, ?,?,?,?,?)`,
    )
    .run(
      id,
      SOURCE,
      id,
      title,
      content,
      hash,
      computeContentHash(body),
      JSON.stringify({ documentType: "file", sourceUrl: url }),
      NOW,
      NOW,
      NOW,
      NOW,
      url,
    );
  upsertChunks(index, [
    {
      id: `chunk-${id}`,
      documentId: id,
      chunkIndex: 0,
      content,
      embedding: new Float32Array(EMBEDDING_DIM),
      sourceId: SOURCE,
      documentType: "file",
      title,
      sourceCreatedAt: NOW,
      sourceUrl: url,
    },
  ]);
  setIndexedDocument(index, id, hash, 1);
}

function pipeline(config?: SearchConfig, wireDb = true): SearchPipeline {
  const p = new SearchPipeline({ indexDb: index, searchConfig: config });
  if (wireDb) p.setGatewayDb(gateway);
  return p;
}

describe("agent search v2 enrollment and compatibility", () => {
  test("client graph facts preserve ordinary result membership, order, metadata and root identity", async () => {
    const p = pipeline({ v2: { topN: 2 } });
    const query = { text: "equipment", verbose: true, limit: 10 };
    const legacy = await p.search(query);
    const enriched = await p.search(query, undefined, { graphContext: true });
    expect(enriched.results).toHaveLength(3);
    expect(enriched.results.map(({ provenance: _provenance, ...hit }) => hit)).toEqual(
      legacy.results,
    );
    expect(enriched.query).toEqual(legacy.query);
    expect(enriched.facets).toEqual(legacy.facets);
    expect(enriched.debug).toEqual(legacy.debug);
    expect(enriched.models).toEqual(legacy.models);
    expect(
      enriched.results
        .slice(0, 2)
        .every((hit) => hit.provenance?.copies[0].documentId === hit.documentId),
    ).toBe(true);
    expect(enriched.results[2].provenance).toBeUndefined();
    const family = enriched.results.find((hit) => ["a", "b"].includes(hit.documentId))!;
    expect(family.provenance!.copies.map((copy) => copy.documentId).sort()).toEqual(["a", "b"]);
    expect(family.provenance!.modelContext).toBeDefined();
  });

  test.each(["plain", "outside-graph-budget"])(
    "fences a generated identity even when its indexed source is ordinary: %s",
    async (mode) => {
      const p = pipeline({ v2: { topN: 1 } });
      const query = { text: "equipment", limit: 10 };
      const before = await p.search(query);
      const moved = before.results.at(-1)!;
      // Simulate delayed index metadata after the corpus identity changed.
      gateway
        .prepare(
          "UPDATE documents SET source_id='brain-knowledge',external_id='missing-owner' WHERE id=?",
        )
        .run(moved.documentId);
      const after = await p.search(
        query,
        undefined,
        mode === "plain" ? undefined : { graphContext: true },
      );
      expect(after.results.map((hit) => hit.documentId)).toEqual(
        before.results
          .filter((hit) => hit.documentId !== moved.documentId)
          .map((hit) => hit.documentId),
      );
      expect(JSON.stringify(after)).not.toContain(`"documentId":"${moved.documentId}"`);
    },
  );

  test.each(["ref-count", "bound-row"])(
    "rechecks generated snippets and graph copies after %s enrichment",
    async (boundary) => {
      vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
      const source = gateway
        .prepare<
          [string],
          { content_hash: string }
        >("SELECT content_hash FROM documents WHERE id=?")
        .get("a")!;
      const node = saveKnowledgeNode(
        gateway,
        {
          id: "derived-node",
          kind: "wiki",
          title: "Equipment synthesis",
          markdown: `<claim id="summary" refs="source:a">${BODY}</claim>`,
          expectedRevision: 0,
          inputVersions: { "source:a": source.content_hash },
        },
        1,
      ).node;
      const projection = buildKnowledgeDocumentInput(node);
      addFile("derived", projection.title, projection.content);
      gateway
        .prepare(
          "UPDATE documents SET source_id=?,external_id=?,content=?,content_hash=?,metadata=? WHERE id='derived'",
        )
        .run(
          projection.sourceId,
          projection.externalId,
          projection.content,
          projection.contentHash,
          JSON.stringify(projection.metadata),
        );
      upsertChunks(index, [
        {
          id: "chunk-derived",
          documentId: "derived",
          chunkIndex: 0,
          content: projection.content,
          embedding: new Float32Array(EMBEDDING_DIM),
          sourceId: projection.sourceId,
          documentType: "knowledge",
          title: projection.title,
          sourceCreatedAt: NOW,
        },
      ]);
      setIndexedDocument(index, "derived", projection.contentHash, 1);
      const p = pipeline({ v2: { topN: 10 } });
      const query = { text: "equipment", limit: 10, cognitiveProjection: true };
      const before = await p.search(query, undefined, { graphContext: true });
      expect(before.results.some((hit) => hit.documentId === "derived")).toBe(true);
      expect(
        before.results
          .find((hit) => hit.documentId === "b")
          ?.provenance?.copies.some((copy) => copy.documentId === "a"),
      ).toBe(true);
      let crossed = false;
      const purge = () => {
        crossed = true;
        purgeKnowledgeBySource(gateway, "a", 2);
      };
      if (boundary === "ref-count")
        p.setLinkRefSource({
          getInboundRefCounts: () => {
            purge();
            return new Map();
          },
        });
      else
        p.setBoundRowResolver({
          getBoundDocumentBindings: async () => {
            purge();
            return new Map();
          },
          getRowsByKeys: async () => new Map(),
        });
      const after = await p.search(
        { ...query, includeBoundRow: boundary === "bound-row" },
        undefined,
        { graphContext: true },
      );
      expect(crossed).toBe(true);
      expect(after.results.map((hit) => hit.documentId).sort()).toEqual(["b", "c"]);
      expect(JSON.stringify(after.results)).not.toContain('"documentId":"a"');
      expect(JSON.stringify(after.results)).not.toContain('"documentId":"derived"');
      expect(
        after.results
          .find((hit) => hit.documentId === "b")
          ?.provenance?.copies.map((copy) => copy.documentId),
      ).toEqual(["b"]);
    },
  );

  test("client graph enrichment preserves an intentional current visibility exclusion", async () => {
    const p = pipeline({ v2: { topN: 10 } });
    const result = await p.search({ text: "equipment", limit: 10 }, undefined, {
      graphContext: true,
      excludeDocumentIds: () => ["a"],
    });
    expect(result.results.map((hit) => hit.documentId).sort()).toEqual(["b", "c"]);
    expect(JSON.stringify(result.results.map((hit) => hit.provenance?.copies))).not.toContain(
      '"documentId":"a"',
    );
  });

  test.each([false, true])(
    "client graph opt-in stays legacy when disabled or missing graph db: %s",
    async (wireDb) => {
      const p = pipeline({ v2: { enabled: !wireDb } }, wireDb);
      expect(
        (await p.search({ text: "equipment" }, undefined, { graphContext: true })).results,
      ).toEqual((await p.search({ text: "equipment" })).results);
    },
  );

  test("source-restricted authorization suppresses client graph context", async () => {
    const p = pipeline();
    const authorization = { sourceIds: [SOURCE] };
    const query = { text: "equipment" };
    const legacy = await p.search(query, authorization);
    expect((await p.search(query, authorization, { graphContext: true })).results).toEqual(
      legacy.results,
    );
  });

  test.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    "an empty or invalid top-result budget suppresses client graph work: %s",
    async (topN) => {
      const p = pipeline({ v2: { topN } });
      const query = { text: "equipment" };
      expect((await p.search(query, undefined, { graphContext: true })).results).toEqual(
        (await p.search(query)).results,
      );
    },
  );

  test.each([false, true])(
    "stale generated answers never regain a legacy trail with indexed source derived=%s",
    async (indexedDerived) => {
      addFile("generated", "Prior answer", BODY);
      gateway
        .prepare("UPDATE documents SET source_id = ?, metadata = ? WHERE id = 'generated'")
        .run(OMNESIS_CHAT_SOURCE_ID, JSON.stringify({ documentType: "conversation" }));
      if (indexedDerived)
        index
          .prepare(
            "UPDATE chunks SET source_id = ?, document_type = 'conversation' WHERE document_id = 'generated'",
          )
          .run(OMNESIS_CHAT_SOURCE_ID);
      setIndexedDocument(index, "generated", computeContentHash("An older indexed answer."), 1);
      gateway
        .prepare(
          `INSERT INTO document_links
        (source_doc_id,link_type,raw_target,normalized_target,target_doc_id,created_at)
        VALUES ('generated','url','a','a','a',?)`,
        )
        .run(NOW);
      const query = { query: '"Prior answer"', limit: 1 };
      const legacy = await createGatewaySearchPort(
        pipeline({ v2: { enabled: false } }),
        undefined,
        gateway,
      ).search(query);
      expect(legacy.results[0].breadcrumb?.map((ref) => ref.documentId)).toContain("a");
      const enriched = await createGatewaySearchPort(
        pipeline({ v2: { enabled: true, topN: 1 } }),
        undefined,
        gateway,
      ).search(query);
      expect(enriched.results[0].documentId).toBe("generated");
      expect(enriched.results[0].provenance).toBeUndefined();
      expect(enriched.results[0].breadcrumb).toBeUndefined();
    },
  );

  test.each([undefined, {}, { v2: {} }])(
    "omitted settings enable bounded graph-aware agent results: %j",
    async (config) => {
      const actual = await createGatewaySearchPort(pipeline(config), undefined, gateway).search({
        query: "equipment",
        limit: 10,
      });
      expect(pipeline(config).agentSearchV2Enabled).toBe(true);
      expect(actual.results).toHaveLength(2);
      const family = actual.results.find((hit) => ["a", "b"].includes(hit.documentId))!;
      expect(family.provenance!.copies.map((copy) => copy.documentId).sort()).toEqual(["a", "b"]);
      expect(family.provenance!.modelContext).toBeDefined();
      expect(actual.results.every((hit) => hit.breadcrumb === undefined)).toBe(true);
    },
  );

  test("explicit false preserves the legacy agent result projection", async () => {
    const disabled = pipeline({ v2: { enabled: false } });
    expect(disabled.agentSearchV2Enabled).toBe(false);
    const expected = await disabled.search({ text: "equipment", limit: 10 });
    const actual = await createGatewaySearchPort(disabled, undefined, gateway).search({
      query: "equipment",
      limit: 10,
    });
    expect(actual.results.map((hit) => hit.documentId)).toEqual(
      expected.results.map((hit) => hit.documentId),
    );
    expect(actual.results).toHaveLength(3);
    expect(actual.results.every((hit) => !hit.provenance)).toBe(true);
  });

  test("default agent searches group files before limiting; public results retain their exact legacy shape", async () => {
    const legacy = pipeline({ v2: { enabled: false } });
    const enrolled = pipeline();
    const expectedPublic = await legacy.search({ text: "equipment", limit: 10 });
    expect((await enrolled.search({ text: "equipment", limit: 10 })).results).toEqual(
      expectedPublic.results,
    );
    const actual = await createGatewaySearchPort(enrolled, undefined, gateway).search({
      query: "equipment",
      limit: 2,
    });
    expect(actual.results).toHaveLength(2);
    expect(actual.results.filter((hit) => ["a", "b"].includes(hit.documentId))).toHaveLength(1);
    const copies = actual.results.find((hit) => ["a", "b"].includes(hit.documentId))!.provenance!
      .copies;
    expect(copies.map((copy) => copy.documentId).sort()).toEqual(["a", "b"]);
    expect(copies.every((copy) => copy.url === `https://example.org/${copy.documentId}`)).toBe(
      true,
    );
    expect(actual.results.every((hit) => hit.breadcrumb === undefined)).toBe(true);
  });

  test("the config alone never changes public search or needs a graph-capable database", async () => {
    const enabled = pipeline(undefined, false);
    expect(
      (await enabled.search({ text: "equipment" }, undefined, { agentContext: true })).results,
    ).toEqual(
      (await pipeline({ v2: { enabled: false } }, false).search({ text: "equipment" })).results,
    );
  });

  test("source authorization blocks default graph enrichment even if an internal caller asks for agent context", async () => {
    const p = pipeline();
    const authorization = { sourceIds: [SOURCE] };
    const expected = await p.search({ text: "equipment" }, authorization);
    const actual = await p.search({ text: "equipment" }, authorization, { agentContext: true });
    expect(actual.results).toEqual(expected.results);
    expect(actual.results.every((hit) => hit.provenance === undefined)).toBe(true);
  });

  test("restricted result mapping strips enriched data even from a misbehaving upstream", async () => {
    const p = pipeline({ v2: { enabled: true } });
    const enriched = await p.search({ text: "equipment" }, undefined, { agentContext: true });
    const stub = { search: async () => enriched } as unknown as SearchPipeline;
    const authorization = createCorpusAuthorization(
      {
        principalId: "fictional-principal",
        grantId: "fictional-grant",
        grantRevision: 1,
        credentialId: "fictional-credential",
        accessTokenId: "fictional-token",
      },
      [
        {
          capability: "direct",
          sourceMode: "allowlist",
          sourceIds: [SOURCE],
          releaseMode: null,
          policyFamilyId: null,
          policyRevision: null,
          privacyPolicy: null,
        },
      ],
      "direct",
    )!;
    const results = (
      await createGatewaySearchPort(stub, undefined, gateway, authorization).search({
        query: "equipment",
      })
    ).results;
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every(
        (hit) =>
          hit.provenance === undefined &&
          hit.refCount === undefined &&
          hit.breadcrumb === undefined,
      ),
    ).toBe(true);
  });

  test("excluded conversation documents cannot consume the v2 result limit or reappear as copies", async () => {
    const enabled = pipeline({ v2: { enabled: true } });
    const result = await enabled.search({ text: "equipment", limit: 2 }, undefined, {
      agentContext: true,
      excludeDocumentIds: ["a", "b"],
    });
    expect(result.results.map((hit) => hit.documentId)).toEqual(["c"]);
    expect(result.results[0].provenance!.copies.map((copy) => copy.documentId)).toEqual(["c"]);
  });

  test.each([false, true])(
    "a conversation created during async retrieval is excluded with v2 enabled=%s",
    async (enabled) => {
      const p = pipeline({ v2: { enabled } });
      const delayed = {
        search: async (...args: Parameters<SearchPipeline["search"]>) => {
          await Promise.resolve();
          gateway
            .prepare(
              "UPDATE documents SET provider_id = ?, source_id = ?, external_id = ? WHERE id = 'c'",
            )
            .run(OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID, "fictional-conversation");
          return p.search(...args);
        },
      } as unknown as SearchPipeline;
      const result = await createGatewaySearchPort(delayed, undefined, gateway).search({
        query: "equipment",
        currentConversationId: "fictional-conversation",
      });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.map((hit) => hit.documentId)).not.toContain("c");
      expect(
        result.results.flatMap(
          (hit) => hit.provenance?.paths.flatMap((path) => path.documentIds) ?? [],
        ),
      ).not.toContain("c");
    },
  );

  test("preserves additive provenance while mapping a search hit to the canonical agent reference", async () => {
    const p = pipeline({ v2: { enabled: true } });
    const port = createGatewaySearchPort(p, undefined, gateway);
    const hit = (await port.search({ query: "equipment" })).results[0];
    const provenance: SearchProvenance | undefined = hit.provenance;
    expect(provenance).toBeDefined();
    expect(hit.url).toBe(`https://example.org/${hit.documentId}`);
    expect(hit.snippet).toContain("equipment agreement");
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeContentHash, type SearchProvenance } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { createGatewaySearchPort } from "../agent/ports.js";
import { createCorpusAuthorization } from "../access/corpus-authorization.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
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
const NOW = "2025-02-01T10:00:00Z";
let gateway: Database.Database;
let index: Database.Database;

beforeEach(() => {
  gateway = createDatabase(`/tmp/omnesis-test-${randomUUID()}.db`);
  index = createIndexDatabase(`/tmp/omnesis-test-${randomUUID()}.db`);
  gateway
    .prepare(
      "INSERT INTO devices (id,name,kind,paired_at) VALUES ('test-device','Example desktop','collector',1)",
    )
    .run();
  gateway
    .prepare(
      "INSERT INTO sources (id,type,account_id,device_id,created_at,updated_at) VALUES (?,'archive','fictional','test-device',1,1)",
    )
    .run(SOURCE);
  addFile("a", "Agreement", BODY);
  addFile("b", "Agreement copy", BODY);
  addFile("c", "Agreement revised", BODY + " Inspection is now required twice.");
});

afterEach(() => {
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
  test.each([undefined, {}, { v2: {} }, { v2: { enabled: false } }])(
    "omitted and disabled flags preserve the legacy agent result projection: %j",
    async (config) => {
      const expected = await createGatewaySearchPort(pipeline(), undefined, gateway).search({
        query: "equipment",
        limit: 10,
      });
      const actual = await createGatewaySearchPort(pipeline(config), undefined, gateway).search({
        query: "equipment",
        limit: 10,
      });
      expect(actual.results).toEqual(expected.results);
      expect(actual.results).toHaveLength(3);
      expect(actual.results.every((hit) => !hit.provenance)).toBe(true);
    },
  );

  test("enabled agent searches group files before limiting; public results retain their exact legacy shape", async () => {
    const legacy = pipeline();
    const enrolled = pipeline({ v2: { enabled: true } });
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
    const enabled = pipeline({ v2: { enabled: true } }, false);
    expect(
      (await enabled.search({ text: "equipment" }, undefined, { agentContext: true })).results,
    ).toEqual((await pipeline(undefined, false).search({ text: "equipment" })).results);
  });

  test("source authorization blocks graph enrichment even if an internal caller asks for agent context", async () => {
    const p = pipeline({ v2: { enabled: true } });
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

  test.each(["interactive", "subagent"] as const)(
    "retrieval guidance is unchanged unless enrolled: %s",
    (audience) => {
      const base = { audience, now: new Date(NOW), timeZone: "UTC" };
      expect(buildSystemPrompt({ ...base, searchV2: false })).toBe(buildSystemPrompt(base));
      const enrolled = buildSystemPrompt({ ...base, searchV2: true });
      expect(enrolled).toContain("Use the graph provenance already retrieved");
      expect(enrolled).toContain("equal extracted text does not establish identical file bytes");
      expect(enrolled).toContain("even when `refCount` is low");
    },
  );
});

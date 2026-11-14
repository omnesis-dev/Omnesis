// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search results' links: what `readSearchResultLinks` reads, and that the
 * pipeline reads them through its port, once, for the results it returns and
 * not for the candidate pool, with the same results as a read on its own
 * handle.
 */

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { createDatabase } from "../db.js";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  setIndexedDocument,
  upsertChunks,
} from "../indexer/db.js";
import { SearchPipeline } from "./pipeline.js";
import {
  readSearchResultLinks,
  type SearchResultLinkReads,
  type SearchResultLinks,
} from "./result-links.js";
import { closeTempDb } from "./test-utils.js";
import type { SearchConfig } from "./search-config.js";

const SOURCE = "archive:fictional";
const NOW = "2025-02-01T10:00:00Z";
/** The statement that reads results' links, as it reaches `prepare`. */
const LINKS_SQL = "json_extract(metadata, '$.extra.mimeType')";
let gateway: Database.Database;
let index: Database.Database;
/** A connection of its own to the gateway database, as a read worker holds. */
let worker: Database.Database;

beforeEach(() => {
  gateway = createDatabase(`/tmp/omnesis-test-${randomUUID()}.db`);
  index = createIndexDatabase(`/tmp/omnesis-test-${randomUUID()}.db`);
  gateway
    .prepare(
      "INSERT INTO devices (id,name,kind,paired_at) VALUES ('device-1','Example desktop','collector',1)",
    )
    .run();
  gateway
    .prepare(
      "INSERT INTO sources (id,type,account_id,device_id,created_at,updated_at) VALUES (?,'archive','fictional','device-1',1,1)",
    )
    .run(SOURCE);
  // Twelve invented agreements, more than any search below returns, with
  // every combination of links; two share a body, and one has no row.
  for (let i = 0; i < 12; i++) {
    const metadata: Record<string, unknown> = { documentType: i % 2 ? "email" : "file" };
    if (i % 3 !== 0) metadata.sourceUrl = `https://example.org/open/d${i}`;
    if (i % 4 === 0) metadata.appUrl = `fictional-app://doc/d${i}`;
    if (i % 2 === 0) metadata.extra = { mimeType: "application/pdf" };
    addDocument(`d${i}`, i === 7 ? 6 : i, metadata, i !== 11);
  }
  worker = new Database(gateway.name, { readonly: true });
});

afterEach(() => {
  worker.close();
  closeTempDb(index);
  closeTempDb(gateway);
});

function addDocument(
  id: string,
  bodyOf: number,
  metadata: Record<string, unknown>,
  withRow: boolean,
): void {
  const content = `# Agreement\n\n---\n\nThe invented equipment agreement ${bodyOf} covers delivery, inspection and a warranty.`;
  const hash = computeContentHash(content);
  if (withRow)
    gateway
      .prepare(
        `INSERT INTO documents (id,provider_id,source_id,external_id,title,content,content_hash,
           extracted_content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
         VALUES (?,'fictional',?,?,'Agreement',?,?,?,?,?,?,?,?)`,
      )
      .run(id, SOURCE, id, content, hash, hash, JSON.stringify(metadata), NOW, NOW, NOW, NOW);
  upsertChunks(index, [
    {
      id: `chunk-${id}`,
      documentId: id,
      chunkIndex: 0,
      content,
      embedding: new Float32Array(EMBEDDING_DIM),
      sourceId: SOURCE,
      documentType: "file",
      title: "Agreement",
      sourceCreatedAt: NOW,
      sourceUrl: `https://example.org/canonical/${id}`,
    },
  ]);
  setIndexedDocument(index, id, hash, 1);
}

function pipeline(config?: SearchConfig): SearchPipeline {
  const p = new SearchPipeline({ indexDb: index, searchConfig: config });
  p.setGatewayDb(gateway);
  return p;
}

/** A port on the worker's connection that records each call, as the worker would receive it. */
function recording() {
  const calls: string[][] = [];
  const port: SearchResultLinkReads = {
    searchResultLinks: (documentIds) => {
      calls.push([...documentIds]);
      expect(structuredClone(documentIds)).toEqual(documentIds);
      return new Promise((resolve) => resolve(readSearchResultLinks(worker, documentIds)));
    },
  };
  return { calls, port };
}

/** Every statement prepared on the gateway handle from now on. */
function preparedOnGateway(): string[] {
  const prepared: string[] = [];
  const prepare = gateway.prepare.bind(gateway);
  gateway.prepare = ((sql: string) => {
    prepared.push(sql);
    return prepare(sql);
  }) as typeof gateway.prepare;
  return prepared;
}

describe("readSearchResultLinks", () => {
  test("reads each document's own links and file type, and leaves out a document without a row", () => {
    const rows = readSearchResultLinks(gateway, ["d0", "d1", "d3", "d11", "missing"]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect([...byId.keys()].sort()).toEqual(["d0", "d1", "d3"]);
    expect(byId.get("d0")).toEqual<SearchResultLinks>({
      id: "d0",
      source_url: null,
      app_url: "fictional-app://doc/d0",
      mime_type: "application/pdf",
    });
    expect(byId.get("d1")).toEqual<SearchResultLinks>({
      id: "d1",
      source_url: "https://example.org/open/d1",
      app_url: null,
      mime_type: null,
    });
    expect(byId.get("d3")!.source_url).toBeNull();
  });

  test("no documents reads nothing", () => {
    const prepared = preparedOnGateway();
    expect(readSearchResultLinks(gateway, [])).toEqual([]);
    expect(prepared).toEqual([]);
  });
});

describe("search reads its results' links through the port", () => {
  const searches = [
    ["an ordinary search", undefined, { text: "equipment agreement", limit: 5 }, {}],
    [
      "an agent search",
      { v2: { enabled: true } },
      { text: "equipment agreement", limit: 3 },
      { agentContext: true },
    ],
    [
      "a search with graph context",
      { v2: { topN: 2 } },
      { text: "equipment agreement", limit: 5 },
      { graphContext: true },
    ],
    [
      "a search with bound rows",
      undefined,
      { text: "equipment agreement", limit: 5, includeBoundRow: true },
      {},
    ],
  ] as const;

  test.each(searches)(
    "%s reads the returned results' links once, through the port, with the same results",
    async (_label, config, query, options) => {
      const expected = await pipeline(config).search(query, undefined, options);
      const p = pipeline(config);
      const { calls, port } = recording();
      p.setResultLinkReads(port);
      const prepared = preparedOnGateway();
      const actual = await p.search(query, undefined, options);

      expect(actual.results).toEqual(expected.results);
      expect(actual.results.length).toBeGreaterThan(0);
      expect(actual.results.length).toBeLessThanOrEqual(query.limit);
      // Only the results being returned, not the candidate pool behind them.
      expect(calls).toEqual([[...new Set(actual.results.map((hit) => hit.documentId))]]);
      // Nothing on this thread read them.
      expect(prepared.filter((sql) => sql.includes(LINKS_SQL))).toEqual([]);
    },
  );

  test("the results carry each document's own links, not the chunk's canonical form", async () => {
    const p = pipeline();
    p.setResultLinkReads(recording().port);
    const { results } = await p.search({ text: "equipment agreement", limit: 12 });
    const byId = new Map(results.map((hit) => [hit.documentId, hit]));
    expect(byId.get("d1")?.sourceUrl).toBe("https://example.org/open/d1");
    // The document publishes no link, so the chunk's is dropped.
    expect(byId.get("d3")?.sourceUrl).toBeUndefined();
    expect(byId.get("d4")).toMatchObject({
      appUrl: "fictional-app://doc/d4",
      mimeType: "application/pdf",
    });
    // Without a row, the chunk's link stands.
    expect(byId.get("d11")?.sourceUrl).toBe("https://example.org/canonical/d11");
  });

  test("a failed read on the worker reads on this thread instead of failing the search", async () => {
    const query = { text: "equipment agreement", limit: 5 };
    const expected = await pipeline().search(query);
    const p = pipeline();
    p.setResultLinkReads({
      searchResultLinks: () => Promise.reject(new Error("io-worker shutting down")),
    });
    expect((await p.search(query)).results).toEqual(expected.results);
  });

  test("a search with no results reads no links", async () => {
    const p = pipeline();
    const { calls, port } = recording();
    p.setResultLinkReads(port);
    const response = await p.search({ text: "nonexistentterm", limit: 5 });
    expect(response.results).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a search without the gateway database reads no links", async () => {
    const p = new SearchPipeline({ indexDb: index });
    const { calls, port } = recording();
    p.setResultLinkReads(port);
    const response = await p.search({ text: "equipment agreement", limit: 5 });
    expect(response.results.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });
});

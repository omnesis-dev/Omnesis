// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * With a readability read port wired, search fences its hits through the port
 * and never through the per-hit knowledge fence on the main handle: the
 * statements that walk a knowledge node's ancestors run on the port's own
 * connection, and the results equal those of a search fenced on the main
 * handle.
 */

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { computeContentHash } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { saveKnowledgeNode } from "../brain/knowledge/storage.js";
import { buildKnowledgeDocumentInput } from "../brain/knowledge/mirror.js";
import {
  knowledgeDocumentsReadable,
  type KnowledgeDocumentRef,
  type KnowledgeReadabilityReads,
} from "../brain/knowledge/retrieval-fence.js";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  setIndexedDocument,
  upsertChunks,
} from "../indexer/db.js";
import { SearchPipeline } from "./pipeline.js";
import { closeTempDb } from "./test-utils.js";

const BODY =
  "The invented Riverside telescope rota assigns two observers per night and a spare lens kit.";
const SOURCE = "archive:fictional";
const NOW = "2025-02-01T10:00:00Z";
/** Statements only the per-hit fence runs: the deletion check and the node fence. */
const FENCE_SQL = [
  /knowledge_source_revisions WHERE document_id=\? AND deleted=1/,
  /current_ancestors/,
];

let gateway: Database.Database;
let index: Database.Database;
/** A second connection to the gateway store, standing in for the read worker's. */
let worker: Database.Database;
let mainSql: string[];

function addDocument(
  id: string,
  sourceId: string,
  externalId: string,
  title: string,
  content: string,
  metadata: object,
  contentHash = computeContentHash(content),
): void {
  gateway
    .prepare(
      `INSERT INTO documents
    (id,provider_id,source_id,external_id,title,content,content_hash,metadata,
     source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES (?,'fictional',?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      sourceId,
      externalId,
      title,
      content,
      contentHash,
      JSON.stringify(metadata),
      NOW,
      NOW,
      NOW,
      NOW,
    );
  upsertChunks(index, [
    {
      id: `chunk-${id}`,
      documentId: id,
      chunkIndex: 0,
      content,
      embedding: new Float32Array(EMBEDDING_DIM),
      sourceId,
      documentType: "file",
      title,
      sourceCreatedAt: NOW,
    },
  ]);
  setIndexedDocument(index, id, contentHash, 1);
}

beforeEach(() => {
  const path = `/tmp/omnesis-test-${randomUUID()}.db`;
  gateway = createDatabase(path);
  index = createIndexDatabase(`/tmp/omnesis-test-${randomUUID()}.db`);
  for (const id of ["rota", "rota-copy"])
    addDocument(id, SOURCE, id, "Telescope rota", BODY, { documentType: "file" });
  const cited = gateway
    .prepare<[], { content_hash: string }>("SELECT content_hash FROM documents WHERE id='rota'")
    .get()!;
  const node = saveKnowledgeNode(
    gateway,
    {
      id: "rota-page",
      kind: "wiki",
      title: "Telescope rota",
      markdown: `<claim id="rota" refs="source:rota">${BODY}</claim>`,
      expectedRevision: 0,
      inputVersions: { "source:rota": cited.content_hash },
    },
    1,
  ).node;
  const projection = buildKnowledgeDocumentInput(node);
  addDocument(
    "rota-mirror",
    projection.sourceId,
    projection.externalId,
    projection.title,
    projection.content,
    projection.metadata,
    projection.contentHash,
  );
  worker = new Database(path, { readonly: true });
  mainSql = [];
  const prepare = gateway.prepare.bind(gateway);
  vi.spyOn(gateway, "prepare").mockImplementation(((sql: string) => {
    mainSql.push(sql);
    return prepare(sql);
  }) as typeof gateway.prepare);
});

afterEach(() => {
  vi.restoreAllMocks();
  worker.close();
  closeTempDb(index);
  closeTempDb(gateway);
});

function pipeline(reads?: KnowledgeReadabilityReads): SearchPipeline {
  const p = new SearchPipeline({ indexDb: index, searchConfig: { v2: { topN: 10 } } });
  p.setGatewayDb(gateway);
  if (reads) p.setKnowledgeReadability(reads);
  return p;
}

const QUERY = { text: "telescope", limit: 10, cognitiveProjection: true };

test.each([
  ["plain", undefined],
  ["agent", { agentContext: true }],
  ["graph", { graphContext: true }],
] as const)(
  "a %s search fences its hits through the port, not the main handle",
  async (_, options) => {
    const expected = await pipeline().search(QUERY, undefined, options);
    expect(expected.results.map((hit) => hit.documentId)).toContain("rota-mirror");
    expect(mainSql.some((sql) => FENCE_SQL.some((fence) => fence.test(sql)))).toBe(true);

    const asked: KnowledgeDocumentRef[][] = [];
    mainSql = [];
    const actual = await pipeline({
      knowledgeDocumentsReadable: (refs) => {
        asked.push([...refs]);
        return Promise.resolve(knowledgeDocumentsReadable(worker, refs));
      },
    }).search(QUERY, undefined, options);

    expect(actual.results).toEqual(expected.results);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.flat().map((ref) => ref.documentId)).toContain("rota-mirror");
    expect(mainSql.filter((sql) => FENCE_SQL.some((fence) => fence.test(sql)))).toEqual([]);
  },
);

test("a hit the port judges unreadable is hidden, graph context included", async () => {
  const result = await pipeline({
    knowledgeDocumentsReadable: (refs) =>
      Promise.resolve(refs.map((ref) => ref.documentId !== "rota-mirror")),
  }).search(QUERY, undefined, { agentContext: true });
  expect(result.results.length).toBeGreaterThan(0);
  expect(JSON.stringify(result.results)).not.toContain("rota-mirror");
});

test("a failed port read fences on the main handle instead of failing the search", async () => {
  const expected = await pipeline().search(QUERY);
  const actual = await pipeline({
    knowledgeDocumentsReadable: () => Promise.reject(new Error("read worker exited")),
  }).search(QUERY);
  expect(actual.results).toEqual(expected.results);
});

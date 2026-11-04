// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A source with a retention cutoff keeps the documents it stored before the
 * cutoff, and the indexer skips them. They are not missing and not backlog:
 * `reindexMissing` neither counts nor reloads them, `/status`, `/index/stats`
 * and the doctor leave them out of the backlog, and widening or lifting the
 * cutoff brings them back on the next pass.
 *
 * The indexer resolves its cutoff the way the indexer worker does (the
 * worker's cutoff map), and the HTTP figures the way the routes do (the live
 * config), so the test also pins that the two resolutions agree.
 *
 * Fixture data is invented per the repo's privacy rule.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_READ } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import { createServer } from "../server.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { buildIndexerCutoffMap } from "../workers/indexer-worker-proxy.js";
import { resolveIndexerCutoffMaxAge } from "../workers/protocol.js";
import { DocumentChunker } from "./chunker.js";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  getAllIndexedDocumentIds,
  getIndexedDocumentCount,
} from "./db.js";
import { DirectDocumentSource } from "./direct-document-source.js";
import { configMaxAgeResolver, cutoffFromMaxAge, indexCoverage } from "./indexable-documents.js";
import { Indexer } from "./indexer.js";
import { computeIndexStats } from "./stats.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { Embedder, IndexableDocument } from "./types.js";
import type { DocumentInput } from "@omnesis/types";

const MAIL = "mail:maya@example.org";
const FILES = "files:jamie@example.org";
const DAY = 24 * 60 * 60 * 1000;
const MODEL = { name: "test-embed", path: "/models/test.gguf", present: true, modelsDir: "/m" };

let directory: string;
let writer: Database.Database;
let reader: Database.Database;
let indexDb: Database.Database;
let source: DirectDocumentSource;
let fetched: string[];
let config: {
  sources: Record<string, { maxAge?: string }>;
  dataRetention?: { maxAge?: string };
};

class FixedEmbedder implements Embedder {
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => {
      const v = new Float32Array(EMBEDDING_DIM);
      v[0] = 1;
      return v;
    });
  }
  async embedQuery(): Promise<Float32Array> {
    return new Float32Array(EMBEDDING_DIM);
  }
  async dispose(): Promise<void> {}
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-indexer-cutoff-"));
  const path = join(directory, "gateway.db");
  writer = createDatabase(path);
  reader = new Database(path, { readonly: true });
  indexDb = createIndexDatabase(join(directory, "index.db"));
  source = new DirectDocumentSource(reader);
  fetched = [];
  const getByIds = source.getByIds.bind(source);
  source.getByIds = async (ids: string[]) => {
    fetched.push(...ids);
    return getByIds(ids);
  };
  config = { sources: { [MAIL]: { maxAge: "2y" }, [FILES]: { maxAge: "2y" } } };

  const now = Date.now();
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  upsertDocuments(writer, [
    doc(MAIL, "mail-recent-1", ago(10)),
    doc(MAIL, "mail-recent-2", ago(400)),
    doc(MAIL, "mail-old-1", ago(3 * 365)),
    doc(MAIL, "mail-old-2", ago(4 * 365)),
    doc(MAIL, "mail-old-contact", ago(5 * 365), "contact"),
    doc(FILES, "file-recent", ago(30)),
    doc(FILES, "file-old-1", ago(3 * 365)),
    doc(FILES, "file-old-2", ago(6 * 365)),
  ] as never);
});

afterEach(() => {
  indexDb.close();
  reader.close();
  writer.close();
  rmSync(directory, { recursive: true, force: true });
});

function doc(
  sourceId: string,
  externalId: string,
  createdAt: string,
  documentType = "message",
): DocumentInput {
  return {
    providerId: sourceId.split(":")[0] as DocumentInput["providerId"],
    sourceId: sourceId as DocumentInput["sourceId"],
    externalId,
    title: `Invented ${externalId}`,
    content: `Invented ${externalId} about a marathon entry form.`,
    contentHash: `hash-${externalId}`,
    metadata: { documentType },
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: createdAt,
  };
}

/** The indexer worker's resolution: its cutoff map, re-read as a hot reload would. */
function workerMaxAge(sourceId: string, from: typeof config = config): string | null {
  return resolveIndexerCutoffMaxAge(buildIndexerCutoffMap(from), sourceId);
}

function workerCutoff(doc: IndexableDocument): string | null {
  return cutoffFromMaxAge(workerMaxAge(doc.sourceId));
}

function newIndexer(): Indexer {
  return new Indexer(indexDb, source, new DocumentChunker(), new FixedEmbedder(), {
    getCutoff: workerCutoff,
    pageSize: 50,
    betweenPageSleepMs: 0,
  });
}

function idsOf(...externalIds: string[]): string[] {
  const lookup = writer.prepare<[string], string>("SELECT id FROM documents WHERE external_id = ?");
  return externalIds.map((externalId) => lookup.pluck().get(externalId)!).sort();
}

const OLD = ["mail-old-1", "mail-old-2", "file-old-1", "file-old-2"];
const IN_SCOPE = ["mail-recent-1", "mail-recent-2", "mail-old-contact", "file-recent"];

/** `/status`'s backlog, served through the real route. */
async function statusBacklog(): Promise<number> {
  const device = createDevice(writer, { name: `test-${randomUUID()}`, kind: "cli" });
  const token = createToken(writer, device.id, [SCOPE_READ]).token;
  const app = createServer(writer, undefined, {
    indexDb,
    config: config as unknown as OmnesisConfig,
  });
  const res = await app.request("/status", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { index: { backlog: number } };
  return body.index.backlog;
}

/** The `/index/stats` and doctor figure: documents still to index. */
function statsRemaining(): number {
  const stats = computeIndexStats({
    db: writer,
    indexDb,
    indexerModel: MODEL,
    config: config as unknown as OmnesisConfig,
  });
  return (stats.totalGatewayDocs ?? 0) - (stats.totalIndexed ?? 0);
}

/** The gap `reindexMissing` would act on, measured independently of it. */
function missingCount(): number {
  return indexCoverage(reader, indexDb, (sourceId) =>
    workerCutoff({ sourceId } as IndexableDocument),
  ).missing;
}

describe("documents older than the retention cutoff", () => {
  test("are neither counted nor reloaded, while in-window unindexed documents still are", async () => {
    expect(await statusBacklog()).toBe(IN_SCOPE.length);
    expect(statsRemaining()).toBe(IN_SCOPE.length);

    const first = await newIndexer().reindexMissing();
    expect(first).toEqual({ indexed: IN_SCOPE.length, errors: 0 });
    expect([...fetched].sort()).toEqual(idsOf(...IN_SCOPE));
    expect([...getAllIndexedDocumentIds(indexDb)].sort()).toEqual(idsOf(...IN_SCOPE));

    // The next pass finds nothing and fetches nothing: the old documents are
    // not reloaded every hour.
    fetched = [];
    const second = await newIndexer().reindexMissing();
    expect(second).toEqual({ indexed: 0, errors: 0 });
    expect(fetched).toEqual([]);

    expect(await statusBacklog()).toBe(0);
    expect(statsRemaining()).toBe(0);
    expect(missingCount()).toBe(0);
  });

  test("lifting the cutoff makes them missing again, and the next pass indexes them", async () => {
    await newIndexer().reindexMissing();
    expect(await statusBacklog()).toBe(0);

    config.sources[MAIL] = { maxAge: "unlimited" };
    delete config.sources[FILES].maxAge;
    expect(await statusBacklog()).toBe(OLD.length);
    expect(statsRemaining()).toBe(OLD.length);
    expect(missingCount()).toBe(OLD.length);

    fetched = [];
    const pass = await newIndexer().reindexMissing();
    expect(pass).toEqual({ indexed: OLD.length, errors: 0 });
    expect([...fetched].sort()).toEqual(idsOf(...OLD));
    expect(getIndexedDocumentCount(indexDb)).toBe(OLD.length + IN_SCOPE.length);
    expect(await statusBacklog()).toBe(0);
    expect(statsRemaining()).toBe(0);
  });

  test("widening the cutoff brings back only the documents the new window covers", async () => {
    await newIndexer().reindexMissing();

    config.sources[MAIL] = { maxAge: "5y" };
    config.sources[FILES] = { maxAge: "5y" };
    const nowInWindow = ["mail-old-1", "mail-old-2", "file-old-1"];
    expect(await statusBacklog()).toBe(nowInWindow.length);
    expect(statsRemaining()).toBe(nowInWindow.length);

    fetched = [];
    const pass = await newIndexer().reindexMissing();
    expect(pass).toEqual({ indexed: nowInWindow.length, errors: 0 });
    expect([...fetched].sort()).toEqual(idsOf(...nowInWindow));
    expect(getAllIndexedDocumentIds(indexDb).has(idsOf("file-old-2")[0]!)).toBe(false);
    expect(await statusBacklog()).toBe(0);
    expect(missingCount()).toBe(0);
  });
});

describe("a cutoff that changes or cannot be applied", () => {
  test("a cutoff that narrows during a pass keeps the newly excluded documents out", async () => {
    config.sources[MAIL] = { maxAge: "unlimited" };
    config.sources[FILES] = { maxAge: "unlimited" };
    const list = source.listIndexableIds.bind(source);
    source.listIndexableIds = async (cutoffFor) => {
      const ids = await list(cutoffFor);
      config.sources[MAIL] = { maxAge: "2y" };
      config.sources[FILES] = { maxAge: "2y" };
      return ids;
    };

    const pass = await newIndexer().reindexMissing();
    expect([...fetched].sort()).toEqual(idsOf(...IN_SCOPE, ...OLD));
    expect(pass).toEqual({ indexed: IN_SCOPE.length, errors: 0 });
    expect([...getAllIndexedDocumentIds(indexDb)].sort()).toEqual(idsOf(...IN_SCOPE));
  });

  test("a maxAge beyond what a duration can express applies no cutoff on every surface", async () => {
    config.sources[MAIL] = { maxAge: "150y" };
    const mailOld = ["mail-old-1", "mail-old-2"];
    expect(workerCutoff({ sourceId: MAIL } as IndexableDocument)).toBeNull();
    expect(await statusBacklog()).toBe(IN_SCOPE.length + mailOld.length);
    expect(statsRemaining()).toBe(IN_SCOPE.length + mailOld.length);

    const pass = await newIndexer().reindexMissing();
    expect(pass).toEqual({ indexed: IN_SCOPE.length + mailOld.length, errors: 0 });
    expect(await statusBacklog()).toBe(0);
    expect(missingCount()).toBe(0);
  });
});

describe("the worker and the HTTP surfaces resolve the same cutoff", () => {
  const cases: Array<[string, typeof config]> = [
    ["instance key", { sources: { [MAIL]: { maxAge: "2y" } } }],
    ["type key", { sources: { mail: { maxAge: "3y" } } }],
    [
      "instance key overriding type key with unlimited",
      { sources: { mail: { maxAge: "3y" }, [MAIL]: { maxAge: "unlimited" } } },
    ],
    [
      "type key overriding sources.default",
      { sources: { default: { maxAge: "1y" }, mail: { maxAge: "5y" } } },
    ],
    ["sources.default", { sources: { default: { maxAge: "1y" } } }],
    ["dataRetention.maxAge", { sources: {}, dataRetention: { maxAge: "4y" } }],
    [
      "sources.default over dataRetention.maxAge",
      { sources: { default: { maxAge: "6y" } }, dataRetention: { maxAge: "1y" } },
    ],
    [
      "unlimited at the default level",
      { sources: { default: { maxAge: "unlimited" } }, dataRetention: { maxAge: "1y" } },
    ],
    ["unlimited dataRetention", { sources: {}, dataRetention: { maxAge: "unlimited" } }],
    ["nothing configured", { sources: {} }],
    ["out of range", { sources: { default: { maxAge: "150y" } } }],
  ];

  test.each(cases)("%s", (_name, c) => {
    const now = Date.now();
    const http = configMaxAgeResolver(c as unknown as OmnesisConfig);
    for (const sourceId of [MAIL, FILES, "mail"]) {
      expect(cutoffFromMaxAge(workerMaxAge(sourceId, c), now), sourceId).toBe(
        cutoffFromMaxAge(http(sourceId), now),
      );
    }
  });

  test("the matrix is not trivially null", () => {
    const now = Date.now();
    const cutoffOf = (c: typeof config, sourceId: string) =>
      cutoffFromMaxAge(workerMaxAge(sourceId, c), now);
    const year = (n: number) => cutoffFromMaxAge(`${n}y`, now);
    expect(cutoffOf(cases[1]![1], MAIL)).toBe(year(3));
    expect(cutoffOf(cases[2]![1], MAIL)).toBeNull();
    expect(cutoffOf(cases[3]![1], FILES)).toBe(year(1));
    expect(cutoffOf(cases[5]![1], FILES)).toBe(year(4));
    expect(cutoffOf(cases[7]![1], FILES)).toBeNull();
  });
});

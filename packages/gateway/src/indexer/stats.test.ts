// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `computeIndexStats` — the figures behind `GET /index/stats` and the
 * doctor's index checks.
 *
 * Two surfaces read these numbers, so the aggregation is pinned here rather
 * than only through whichever endpoint happens to be exercised: the four
 * progression states, the union of sources across the index and gateway
 * databases, and the two counting strategies the data-cutoff configuration
 * selects between.
 *
 * Fixture data is fictional per the repo's privacy rule.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { createIndexDatabase } from "./db.js";
import { computeIndexStats } from "./stats.js";
import type Database from "better-sqlite3";
import type { OmnesisConfig } from "@omnesis/config";

type Db = Database.Database;

const MODEL = {
  name: "test-embed",
  path: "/models/test-embed.gguf",
  present: true,
  modelsDir: "/models",
};

let dir: string;
let db: Db;
let indexDb: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-index-stats-"));
  db = createDatabase(join(dir, "omnesis.db"));
  indexDb = createIndexDatabase(join(dir, "index.db"));
});

afterEach(() => {
  db.close();
  indexDb.close();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

/** Record `docs` documents for a source in the gateway's own stats table. */
function seedGatewaySource(sourceId: string, docs: number): void {
  db.prepare("INSERT INTO source_stats (source_id, doc_count) VALUES (?, ?)").run(sourceId, docs);
}

/** Record a source as having `docs` documents / `chunks` chunks indexed. */
function seedIndexedSource(sourceId: string, docs: number, chunks: number): void {
  indexDb
    .prepare("INSERT INTO source_index_stats (source_id, indexed_docs, chunks) VALUES (?, ?, ?)")
    .run(sourceId, docs, chunks);
}

describe("computeIndexStats — the four states", () => {
  test("a missing model file disables indexing and says why", () => {
    const stats = computeIndexStats({ db, indexDb, indexerModel: { ...MODEL, present: false } });
    expect(stats).toMatchObject({ enabled: false, state: "model-missing" });
    expect(stats.model?.present).toBe(false);
  });

  test("no index database means indexing is off, not broken", () => {
    const stats = computeIndexStats({ db, indexerModel: MODEL });
    expect(stats).toMatchObject({ enabled: false, state: "disabled" });
  });

  test("a worker still coming up reports spawning with the numbers it has", () => {
    seedIndexedSource("demo-mail:user@example.com", 3, 9);
    const stats = computeIndexStats({
      db,
      indexDb,
      indexerModel: MODEL,
      indexerReadiness: () => ({ status: "loading-model" }),
    });
    expect(stats).toMatchObject({ enabled: true, state: "spawning", totalGatewayDocs: 0 });
    // Index-side figures are stale but valid, so they are still reported.
    expect(stats.totalChunks).toBe(0);
    expect(stats.bySource).toEqual({});
  });

  test("a ready worker reports running with full per-source figures", () => {
    seedGatewaySource("demo-mail:user@example.com", 10);
    seedIndexedSource("demo-mail:user@example.com", 4, 12);

    const stats = computeIndexStats({
      db,
      indexDb,
      indexerModel: MODEL,
      indexerReadiness: () => ({ status: "ready" }),
    });

    expect(stats).toMatchObject({ enabled: true, state: "running" });
    expect(stats.totalGatewayDocs).toBe(10);
    expect(stats.totalIndexed).toBe(0); // no indexed_documents rows written
    expect(stats.bySource?.["demo-mail:user@example.com"]).toMatchObject({
      indexedDocs: 4,
      gatewayDocs: 10,
      chunks: 12,
      indexErrors: 0,
    });
  });
});

describe("computeIndexStats — source union and progress", () => {
  test("a source known only to the gateway still gets a row at 0% indexed", () => {
    seedGatewaySource("demo-notes:local", 7);
    const stats = computeIndexStats({ db, indexDb, indexerModel: MODEL });
    expect(stats.bySource?.["demo-notes:local"]).toMatchObject({
      indexedDocs: 0,
      gatewayDocs: 7,
      percentIndexed: 0,
    });
  });

  test("a source known only to the index still gets a row", () => {
    seedIndexedSource("demo-chat:local", 5, 20);
    const stats = computeIndexStats({ db, indexDb, indexerModel: MODEL });
    expect(stats.bySource?.["demo-chat:local"]).toMatchObject({
      indexedDocs: 5,
      gatewayDocs: 0,
      chunks: 20,
    });
  });

  test("totals sum across every source", () => {
    seedGatewaySource("demo-mail:user@example.com", 10);
    seedGatewaySource("demo-notes:local", 5);
    const stats = computeIndexStats({ db, indexDb, indexerModel: MODEL });
    expect(stats.totalGatewayDocs).toBe(15);
  });

  test("an unknown indexing rate leaves the ETA unset rather than guessed", () => {
    seedGatewaySource("demo-notes:local", 100);
    const stats = computeIndexStats({ db, indexDb, indexerModel: MODEL });
    expect(stats.indexRatePerSec).toBeNull();
    expect(stats.etaSeconds).toBeNull();
  });
});

describe("computeIndexStats — data cutoffs", () => {
  /** Insert a document so the cutoff-aware counting path has rows to filter. */
  function seedDocument(sourceId: string, id: string, createdAt: string): void {
    db.prepare(
      `INSERT INTO documents (
         id, provider_id, source_id, external_id, title, content, content_hash,
         source_created_at, source_updated_at, ingested_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "demo-notes",
      sourceId,
      id,
      "Quarterly planning",
      "body",
      `hash-${id}`,
      createdAt,
      createdAt,
      createdAt,
      createdAt,
    );
  }

  test("with no cutoff configured, gateway counts come from the stats table", () => {
    seedGatewaySource("demo-notes:local", 42);
    const stats = computeIndexStats({
      db,
      indexDb,
      indexerModel: MODEL,
      config: {} as OmnesisConfig,
    });
    expect(stats.bySource?.["demo-notes:local"].gatewayDocs).toBe(42);
  });

  // With any cutoff configured the counts switch to a per-source scan of
  // `documents`, so only documents inside the window are counted as work the
  // indexer is expected to have done.
  test("a configured cutoff counts only documents inside the window", () => {
    seedGatewaySource("demo-notes:local", 3);
    seedDocument("demo-notes:local", "doc-recent", "2026-06-01T00:00:00.000Z");
    seedDocument("demo-notes:local", "doc-old-1", "2019-01-01T00:00:00.000Z");
    seedDocument("demo-notes:local", "doc-old-2", "2018-01-01T00:00:00.000Z");

    const stats = computeIndexStats({
      db,
      indexDb,
      indexerModel: MODEL,
      config: { sources: { default: { maxAge: "365d" } } } as unknown as OmnesisConfig,
    });

    // The two pre-cutoff documents drop out; the stats-table count of 3 is
    // deliberately not used on this path.
    expect(stats.bySource?.["demo-notes:local"].gatewayDocs).toBe(1);
    expect(stats.totalGatewayDocs).toBe(1);
  });
});

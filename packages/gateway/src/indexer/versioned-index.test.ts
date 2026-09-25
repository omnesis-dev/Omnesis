// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, afterEach } from "vitest";
import {
  EMBEDDING_DIM,
  createIndexDatabase,
  migrateAdoptInPlaceVersion,
  setIndexEmbedModel,
  getActiveIndexVersion,
  setActiveIndexVersion,
  getIndexVersion,
  listIndexVersions,
  usearchPathForVersion,
  upsertChunks,
  getChunkCount,
  createBuildingIndexVersion,
  setIndexVersionProgress,
  getIndexGenerationStatus,
  purgeUsearchSidecars,
} from "./db.js";
import type { ChunkUpsertInput } from "./db.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const dbs: Db[] = [];
const dirs: string[] = [];
function freshDb(): Db {
  const db = createIndexDatabase(`/tmp/omnesis-versioned-test-${randomUUID()}.db`);
  dbs.push(db);
  return db;
}

afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeChunk(i: number): ChunkUpsertInput {
  const arr = new Float32Array(EMBEDDING_DIM);
  arr[i % EMBEDDING_DIM] = 1;
  return {
    id: `chunk-${i}`,
    documentId: `doc-${i}`,
    chunkIndex: 0,
    content: `synthetic content ${i}`,
    embedding: arr,
    sourceId: "demo-source",
    title: `Doc ${i}`,
    sourceCreatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("versioned-index schema", () => {
  test("createIndexDatabase creates index_versions cleanly on a fresh DB", () => {
    const db = freshDb();
    // Table exists and is queryable.
    expect(listIndexVersions(db)).toEqual([]);
    // No generation adopted on a truly fresh install (no model stamp yet).
    expect(getActiveIndexVersion(db)).toBeNull();
  });

  test("re-opening createIndexDatabase on an existing file replays cleanly", () => {
    const path = `/tmp/omnesis-versioned-test-${randomUUID()}.db`;
    const db1 = createIndexDatabase(path);
    setIndexEmbedModel(db1, "nomic-embed-text-v1.5.Q8_0", 768);
    db1.close();

    // Second "boot": the startup migration adopts version 1 from the stamp.
    const db2 = createIndexDatabase(path);
    dbs.push(db2);
    expect(getActiveIndexVersion(db2)).toBe(1);
    const v1 = getIndexVersion(db2, 1);
    expect(v1?.state).toBe("active");
    expect(v1?.embed_model).toBe("nomic-embed-text-v1.5.Q8_0");
    expect(v1?.embed_dim).toBe(768);
  });
});

describe("secure usearch sidecar purge", () => {
  test("removes legacy, versioned, tmp, and quarantined usearch sidecars only", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-usearch-purge-"));
    dirs.push(dir);
    const removed = [
      "index.usearch",
      "index.usearch.tmp",
      "index.usearch.corrupt-123",
      "index-2.usearch",
      "index-3.usearch.tmp",
      "index-4.usearch.tmp.corrupt-123",
    ];
    const kept = ["index.db", "index-not-a-version.usearch", "notes.txt"];
    for (const name of [...removed, ...kept]) writeFileSync(join(dir, name), name);

    expect(purgeUsearchSidecars(dir)).toBe(removed.length);
    for (const name of removed) expect(existsSync(join(dir, name))).toBe(false);
    for (const name of kept) expect(existsSync(join(dir, name))).toBe(true);
  });
});

describe("adopt-in-place migration", () => {
  test("turns a pre-versioning index into exactly one active version with no re-embed", () => {
    const db = freshDb();
    // Simulate an existing single-index install: a model stamp + indexed chunks,
    // but no version row yet (the stamp predates the versioned model).
    setIndexEmbedModel(db, "text-embedding-3-small", 1536);
    upsertChunks(db, [makeChunk(1), makeChunk(2), makeChunk(3)]);
    const chunksBefore = getChunkCount(db);
    expect(chunksBefore).toBe(3);

    migrateAdoptInPlaceVersion(db);

    const versions = listIndexVersions(db);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      state: "active",
      embed_model: "text-embedding-3-small",
      embed_dim: 1536,
      encoding: "f32",
    });
    expect(getActiveIndexVersion(db)).toBe(1);
    // No re-embed: chunks are untouched by the migration.
    expect(getChunkCount(db)).toBe(chunksBefore);
  });

  test("is idempotent on replay", () => {
    const db = freshDb();
    setIndexEmbedModel(db, "text-embedding-3-small", 1536);
    migrateAdoptInPlaceVersion(db);
    const firstActivatedAt = getIndexVersion(db, 1)?.activated_at;

    // Replays from any prior version with no effect.
    migrateAdoptInPlaceVersion(db);
    migrateAdoptInPlaceVersion(db);

    expect(listIndexVersions(db)).toHaveLength(1);
    expect(getActiveIndexVersion(db)).toBe(1);
    // The existing row is not rewritten.
    expect(getIndexVersion(db, 1)?.activated_at).toBe(firstActivatedAt);
  });

  test("does nothing on a fresh install with no model stamp", () => {
    const db = freshDb();
    migrateAdoptInPlaceVersion(db);
    expect(listIndexVersions(db)).toEqual([]);
    expect(getActiveIndexVersion(db)).toBeNull();
  });
});

describe("version pointer + path scheme", () => {
  test("setActiveIndexVersion flips the cheap scalar pointer", () => {
    const db = freshDb();
    setActiveIndexVersion(db, 7);
    expect(getActiveIndexVersion(db)).toBe(7);
    setActiveIndexVersion(db, 8);
    expect(getActiveIndexVersion(db)).toBe(8);
  });

  test("version 1 lives at the legacy path; later generations use index-<gen>", () => {
    expect(usearchPathForVersion("/cfg", null)).toBe("/cfg/index.usearch");
    expect(usearchPathForVersion("/cfg", 1)).toBe("/cfg/index.usearch");
    expect(usearchPathForVersion("/cfg", 2)).toBe("/cfg/index-2.usearch");
    expect(usearchPathForVersion("/cfg/", 3)).toBe("/cfg/index-3.usearch");
  });
});

// Status two-readout (epic #1011): the gateway computes the active-vs-building
// distinction + rebuild progress as first-class fields so `/index/stats` and
// `/status` can surface a graceful swap as an upgrade-in-flight (the existing
// "% indexed" stays on the complete active generation; the migration progress
// is a separate readout) with NO client-side inference.
describe("getIndexGenerationStatus", () => {
  function adoptV1(db: Db, model = "text-embedding-3-small", dim = 1536): void {
    setIndexEmbedModel(db, model, dim);
    migrateAdoptInPlaceVersion(db);
  }

  test("active-only: no build in flight reports building=null", () => {
    const db = freshDb();
    adoptV1(db);

    const status = getIndexGenerationStatus(db);
    expect(status.active).toEqual({
      version: 1,
      embedModel: "text-embedding-3-small",
      embedDim: 1536,
    });
    expect(status.building).toBeNull();
  });

  test("active + building: surfaces both, with the build's % and N-of-M progress", () => {
    const db = freshDb();
    adoptV1(db);
    createBuildingIndexVersion(db, {
      version: 2,
      embedModel: "text-embedding-3-large",
      embedDim: 3072,
      docsTotal: 200,
    });
    setIndexVersionProgress(db, 2, 50);

    const status = getIndexGenerationStatus(db);
    // The active readout is unchanged — the existing index is intact + serving.
    expect(status.active).toEqual({
      version: 1,
      embedModel: "text-embedding-3-small",
      embedDim: 1536,
    });
    // The build is a SEPARATE readout with its own progress.
    expect(status.building).toEqual({
      version: 2,
      embedModel: "text-embedding-3-large",
      embedDim: 3072,
      docsBuilt: 50,
      docsTotal: 200,
      percent: 25,
    });
  });

  test("percent clamps to 100 and docsBuilt to docsTotal when the counters disagree", () => {
    const db = freshDb();
    adoptV1(db);
    // The two counters seed from different sources, so docs_built can briefly
    // exceed docs_total — that must never read as >100%.
    createBuildingIndexVersion(db, {
      version: 2,
      embedModel: "new-model",
      embedDim: 512,
      docsTotal: 100,
    });
    setIndexVersionProgress(db, 2, 137);

    const status = getIndexGenerationStatus(db);
    expect(status.building).toMatchObject({ docsBuilt: 100, docsTotal: 100, percent: 100 });
  });

  test("docsTotal=0 yields percent 0, never a divide-by-zero NaN", () => {
    const db = freshDb();
    adoptV1(db);
    createBuildingIndexVersion(db, {
      version: 2,
      embedModel: "new-model",
      embedDim: 512,
      docsTotal: 0,
    });

    const status = getIndexGenerationStatus(db);
    expect(status.building).toMatchObject({ docsBuilt: 0, docsTotal: 0, percent: 0 });
  });

  test("first build / no complete active: active=null while a build runs (hard-cutover / fresh-install framing)", () => {
    const db = freshDb();
    // No adopted active generation (fresh install), but a build is in flight.
    createBuildingIndexVersion(db, {
      version: 1,
      embedModel: "first-model",
      embedDim: 768,
      docsTotal: 10,
    });
    setIndexVersionProgress(db, 1, 4);

    const status = getIndexGenerationStatus(db);
    expect(status.active).toBeNull();
    expect(status.building).toMatchObject({ version: 1, percent: 40 });
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  EMBEDDING_DIM,
  createIndexDatabase,
  createBuildingIndexVersion,
  flipActiveIndexVersion,
  setIndexEmbedModel,
  migrateAdoptInPlaceVersion,
  usearchPathForVersion,
} from "./db.js";
import { UsearchWriteHandle, UsearchReadHandle } from "./usearch-index.js";
import { UsearchReadRegistry } from "./usearch-read-registry.js";
import type Database from "better-sqlite3";

type Db = Database.Database;
const DIMS = 32;

let db: Db;
let dir: string;

beforeEach(() => {
  db = createIndexDatabase(`/tmp/omnesis-registry-test-${randomUUID()}.db`);
  dir = mkdtempSync(join(tmpdir(), "registry-usearch-"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Deterministic unit-normalized embedding of `dim` seeded from `val`. */
function makeEmbedding(val: number, dim: number): Float32Array {
  const arr = new Float32Array(dim);
  let s = (val * 0x9e3779b9) >>> 0;
  for (let i = 0; i < dim; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    arr[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += arr[i] * arr[i];
  const norm = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) arr[i] /= norm;
  return arr;
}

/** Write a populated usearch file at the legacy (version-1) path. */
function writeLegacyIndex(dim: number, count: number): void {
  const writer = new UsearchWriteHandle(join(dir, "index.usearch"), dim);
  for (let i = 1; i <= count; i++) writer.add(BigInt(i), makeEmbedding(i, dim));
  writer.close();
}

function mappingsInConfigDir(): string[] | null {
  const mapsPath = "/proc/self/maps";
  if (process.platform !== "linux" || !existsSync(mapsPath)) return null;
  return readFileSync(mapsPath, "utf8")
    .split("\n")
    .filter((line) => line.includes(dir) && line.includes(".usearch"));
}

describe("UsearchReadRegistry", () => {
  test("serves the active version at its own dim, matching a direct handle", () => {
    writeLegacyIndex(EMBEDDING_DIM, 20);
    setIndexEmbedModel(db, "nomic-embed-text-v1.5.Q8_0", EMBEDDING_DIM);
    migrateAdoptInPlaceVersion(db);

    const registry = new UsearchReadRegistry(db, dir);
    registry.maybeRefresh();

    const direct = UsearchReadHandle.open(join(dir, "index.usearch"), EMBEDDING_DIM);
    direct.maybeRefresh();

    expect(registry.size()).toBe(direct.size());
    expect(registry.size()).toBe(20);

    const query = makeEmbedding(3, EMBEDDING_DIM);
    const viaRegistry = registry.search(query, 5).map((r) => r.key);
    const viaDirect = direct.search(query, 5).map((r) => r.key);
    expect(viaRegistry).toEqual(viaDirect);
  });

  test("opens the active version at a non-default dimension from its version row", () => {
    const DIM = 64;
    writeLegacyIndex(DIM, 10);
    // Stamp + adopt a version-1 row at a non-default dim.
    setIndexEmbedModel(db, "some-other-embedder", DIM);
    migrateAdoptInPlaceVersion(db);

    const registry = new UsearchReadRegistry(db, dir);
    registry.maybeRefresh();
    expect(registry.size()).toBe(10);

    // A 64-dim query searches correctly — the registry sourced the dim from
    // the version row, not the 768 default.
    const results = registry.search(makeEmbedding(2, DIM), 3);
    expect(results.length).toBe(3);
  });

  test("falls back to the legacy path at the default dim when no version is adopted", () => {
    // No stamp, no version row — exactly today's pre-versioning behaviour.
    const registry = new UsearchReadRegistry(db, dir);
    expect(registry.size()).toBe(0);
    expect(registry.search(makeEmbedding(1, EMBEDDING_DIM), 5)).toEqual([]);

    // The writer later produces the legacy file; maybeRefresh picks it up
    // with no restart, even though no version row was ever adopted.
    writeLegacyIndex(EMBEDDING_DIM, 8);
    registry.maybeRefresh();
    expect(registry.size()).toBe(8);
  });

  test("rebinds one native mapping across a dimension-changing generation flip", () => {
    writeLegacyIndex(DIMS, 3);
    setIndexEmbedModel(db, "fictional-embedder-a", DIMS);
    migrateAdoptInPlaceVersion(db);
    const registry = new UsearchReadRegistry(db, dir);
    expect(registry.search(makeEmbedding(2, DIMS), 1)[0]?.key).toBe(2n);

    const nextDim = DIMS * 2;
    const nextPath = usearchPathForVersion(dir, 2);
    const nextWriter = new UsearchWriteHandle(nextPath, nextDim);
    nextWriter.add(101n, makeEmbedding(101, nextDim));
    nextWriter.add(102n, makeEmbedding(102, nextDim));
    nextWriter.close();
    createBuildingIndexVersion(db, {
      version: 2,
      embedModel: "fictional-embedder-b",
      embedDim: nextDim,
      docsTotal: 2,
    });
    flipActiveIndexVersion(db, {
      newVersion: 2,
      oldVersion: 1,
      embedModel: "fictional-embedder-b",
      embedDim: nextDim,
    });
    rmSync(join(dir, "index.usearch"), { force: true });

    registry.maybeRefresh();
    expect(registry.activeModelId()).toBe("fictional-embedder-b");
    expect(registry.size()).toBe(2);
    expect(registry.search(makeEmbedding(102, nextDim), 1)[0]?.key).toBe(102n);
    const mappings = mappingsInConfigDir();
    if (mappings) {
      expect(mappings.filter((line) => line.includes("(deleted)"))).toEqual([]);
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toContain(nextPath);
    }
    registry.close();
  });

  test("adopts a same-dimension model generation before reporting its model id", () => {
    writeLegacyIndex(DIMS, 2);
    setIndexEmbedModel(db, "fictional-embedder-a", DIMS);
    migrateAdoptInPlaceVersion(db);
    const registry = new UsearchReadRegistry(db, dir);
    expect(registry.activeModelId()).toBe("fictional-embedder-a");

    const nextPath = usearchPathForVersion(dir, 2);
    const nextWriter = new UsearchWriteHandle(nextPath, DIMS);
    nextWriter.add(201n, makeEmbedding(201, DIMS));
    nextWriter.close();
    createBuildingIndexVersion(db, {
      version: 2,
      embedModel: "fictional-embedder-b",
      embedDim: DIMS,
      docsTotal: 1,
    });
    flipActiveIndexVersion(db, {
      newVersion: 2,
      oldVersion: 1,
      embedModel: "fictional-embedder-b",
      embedDim: DIMS,
    });
    rmSync(join(dir, "index.usearch"), { force: true });

    registry.maybeRefresh();
    expect(registry.activeModelId()).toBe("fictional-embedder-b");
    expect(registry.search(makeEmbedding(201, DIMS), 1)[0]?.key).toBe(201n);
    registry.close();
  });
});

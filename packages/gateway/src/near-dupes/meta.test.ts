// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import {
  readActiveAlgoVersion,
  readNearDupDfBuiltAt,
  readNearDupMeta,
  setActiveAlgoVersion,
  setDfBuiltAt,
  setSweepWatermark,
} from "./meta.js";
import type { Db } from "../data/types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-near-dup-meta-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  // Match the gateway journal while retaining fully synchronized commits.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("meta", () => {
  test("a fresh DB has no active algo version (no row)", () => {
    expect(readActiveAlgoVersion(db)).toBeNull();
    expect(readNearDupMeta(db)).toBeNull();
  });

  test("setActiveAlgoVersion seeds the row with zeroed counters", () => {
    setActiveAlgoVersion(db, "v1");
    const m = readNearDupMeta(db);
    expect(m).toMatchObject({
      algoVersion: "v1",
      totalDocs: 0,
      uniqueShingles: 0,
      builtAt: null,
      sweepWatermark: null,
    });
  });

  test("setActiveAlgoVersion replaces an existing row (algo bump)", () => {
    setActiveAlgoVersion(db, "v1");
    setSweepWatermark(db, "v1", "doc-123");
    setActiveAlgoVersion(db, "v2");
    const m = readNearDupMeta(db);
    expect(m?.algoVersion).toBe("v2");
    expect(m?.sweepWatermark).toBeNull();
  });

  test("setDfBuiltAt stamps the per-algo counters", () => {
    setActiveAlgoVersion(db, "v1");
    setDfBuiltAt(db, "v1", 42, 1337, 1700000000);
    const m = readNearDupMeta(db);
    expect(m).toMatchObject({
      totalDocs: 42,
      uniqueShingles: 1337,
      builtAt: 1700000000,
    });
  });

  test("setSweepWatermark updates only the watermark", () => {
    setActiveAlgoVersion(db, "v1");
    setSweepWatermark(db, "v1", "doc-z");
    expect(readNearDupMeta(db)?.sweepWatermark).toBe("doc-z");
  });
});

describe("readNearDupDfBuiltAt", () => {
  test("returns null when no row exists for the algo (fresh DB)", () => {
    expect(readNearDupDfBuiltAt(db, "any-algo")).toBeNull();
  });

  test("returns null after setActiveAlgoVersion before setDfBuiltAt", () => {
    // This is the post-algo-bump state: the active algo row is
    // seeded but `built_at` is null until the DF refresh task lands
    // its first apply. The compute drip's readiness guard depends on
    // this null to park the inbox safely.
    setActiveAlgoVersion(db, "v2");
    expect(readNearDupDfBuiltAt(db, "v2")).toBeNull();
  });

  test("returns the timestamp set by setDfBuiltAt", () => {
    setActiveAlgoVersion(db, "v2");
    setDfBuiltAt(db, "v2", 100, 1000, 1700000123);
    expect(readNearDupDfBuiltAt(db, "v2")).toBe(1700000123);
  });

  test("returns null for an algo that is not the active one", () => {
    // `setActiveAlgoVersion` clears the table and reseeds for ONE
    // algo. Looking up any other algo returns null — this is what
    // makes the drip park across an algo-bump transition.
    setActiveAlgoVersion(db, "v1");
    setDfBuiltAt(db, "v1", 100, 1000, 1700000000);
    setActiveAlgoVersion(db, "v2"); // bumps — wipes v1's row
    expect(readNearDupDfBuiltAt(db, "v1")).toBeNull();
    expect(readNearDupDfBuiltAt(db, "v2")).toBeNull();
  });
});

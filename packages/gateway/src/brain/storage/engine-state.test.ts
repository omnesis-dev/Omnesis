// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import {
  addToCognitionEngineCounter,
  bumpCognitionDecayDirty,
  getCognitionEngineState,
  readCognitionDecayDirtyVersion,
  readCognitionDecaySweptVersion,
  setCognitionEngineState,
  COGNITION_DECAY_SWEPT_VERSION_KEY,
} from "./engine-state.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("steward engine state", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("get/set round-trips and overwrites", () => {
    expect(getCognitionEngineState(db, "k")).toBeNull();
    setCognitionEngineState(db, "k", "v1");
    expect(getCognitionEngineState(db, "k")).toBe("v1");
    setCognitionEngineState(db, "k", "v2");
    expect(getCognitionEngineState(db, "k")).toBe("v2");
  });

  test("the decay dirty version starts at 0 and increments per bump", () => {
    expect(readCognitionDecayDirtyVersion(db)).toBe(0);
    bumpCognitionDecayDirty(db);
    expect(readCognitionDecayDirtyVersion(db)).toBe(1);
    bumpCognitionDecayDirty(db);
    bumpCognitionDecayDirty(db);
    expect(readCognitionDecayDirtyVersion(db)).toBe(3);
  });

  test("the swept version reads 0 until recorded, then what was recorded", () => {
    expect(readCognitionDecaySweptVersion(db)).toBe(0);
    setCognitionEngineState(db, COGNITION_DECAY_SWEPT_VERSION_KEY, "7");
    expect(readCognitionDecaySweptVersion(db)).toBe(7);
  });

  test("a corrupt numeric value fails closed to 0 (the sweep just runs again)", () => {
    setCognitionEngineState(db, COGNITION_DECAY_SWEPT_VERSION_KEY, "not-a-number");
    expect(readCognitionDecaySweptVersion(db)).toBe(0);
  });
});

describe("addToCognitionEngineCounter", () => {
  let cdb: Db;
  let cpath: string;

  beforeEach(() => {
    cpath = testDbPath();
    cdb = createDatabase(cpath);
  });
  afterEach(() => {
    cdb.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(cpath + suffix)) unlinkSync(cpath + suffix);
    }
  });

  const KEY = "bootstrap_total_enqueued";
  const read = (): number => Number(getCognitionEngineState(cdb, KEY) ?? "0");

  test("creates the counter, accumulates, and preserves canonical integer text", () => {
    addToCognitionEngineCounter(cdb, KEY, 7);
    addToCognitionEngineCounter(cdb, KEY, 5);
    expect(read()).toBe(12);
    expect(getCognitionEngineState(cdb, KEY)).toBe("12");
  });

  test("does the arithmetic in SQL, so a stale caller cannot overwrite a newer value", () => {
    // The bug this replaces: the caller read the total, did work across several
    // awaits, then wrote back `read + n` as an absolute value — so an increment
    // that landed in between was silently replaced, and a crash before the
    // write dropped one entirely. Measured on a live install, the lifetime
    // counter had drifted 226 BELOW the bootstrap runs still on the ledger,
    // and the ledger is pruned, so the real gap is larger.
    addToCognitionEngineCounter(cdb, KEY, 100);
    const staleRead = read();
    addToCognitionEngineCounter(cdb, KEY, 5);
    addToCognitionEngineCounter(cdb, KEY, 10);
    expect(read()).toBe(115);
    expect(staleRead).toBe(100);
  });

  test("takes over a counter previously written absolutely", () => {
    // Upgrades cross this boundary: the key already exists, written by the old
    // assignment path.
    setCognitionEngineState(cdb, KEY, "5119");
    addToCognitionEngineCounter(cdb, KEY, 1);
    expect(read()).toBe(5120);
  });
});

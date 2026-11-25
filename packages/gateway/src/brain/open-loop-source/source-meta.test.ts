// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { getSourceMeta } from "../../db.js";
import { createFreshTestDatabase } from "../../testing/fresh-database.js";
import { directWriteGate } from "../../write-gate.js";
import {
  OPEN_LOOP_SOURCE_ID,
  OPEN_LOOP_SOURCE_LABEL,
  seedOpenLoopSourceMeta,
} from "./source-meta.js";
import { join as fixtureJoin } from "node:path";
import { tmpdir as fixtureTmpdir } from "node:os";

function testDbPath(): string {
  return fixtureJoin(fixtureTmpdir(), `omnesis-test-${randomUUID()}.db`);
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("open-loop source identity seed", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createFreshTestDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("seeds the sync_state display row, idempotently", async () => {
    const gate = directWriteGate(db);
    await seedOpenLoopSourceMeta(gate);
    const meta = getSourceMeta(db)[OPEN_LOOP_SOURCE_ID];
    expect(meta?.label).toBe(OPEN_LOOP_SOURCE_LABEL);
    expect(meta?.bgColor).toBeTruthy();
    expect(meta?.accentColor).toBeTruthy();
    // Re-seeding never clobbers (setSourceMeta COALESCEs).
    await seedOpenLoopSourceMeta(gate);
    expect(getSourceMeta(db)[OPEN_LOOP_SOURCE_ID]?.label).toBe(OPEN_LOOP_SOURCE_LABEL);
  });
});

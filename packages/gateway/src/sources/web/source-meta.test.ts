// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir as fixtureTmpdir } from "node:os";
import { join as fixtureJoin } from "node:path";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
type Db = Database.Database;

import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { WEB_SOURCE_ID } from "../../web-dataset.js";
import { seedWebSourceMeta } from "./source-meta.js";
import type Database from "better-sqlite3";

function testDbPath(): string {
  return fixtureJoin(fixtureTmpdir(), `omnesis-web-meta-test-${randomUUID()}.db`);
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("seedWebSourceMeta", () => {
  let dbPath: string;
  let db: Db;
  beforeEach(() => {
    dbPath = testDbPath();
    db = createDatabase(dbPath);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  test("seeds web's sync_state with label + a PNG-rasterized icon (iOS renders it)", async () => {
    await seedWebSourceMeta(directWriteGate(db));

    const row = db
      .prepare<
        [string],
        { icon: string | null; label: string | null; accent_color: string | null }
      >("SELECT icon, label, accent_color FROM sync_state WHERE source_id = ?")
      .get(WEB_SOURCE_ID);

    expect(row).toBeTruthy();
    expect(row?.label).toBe("Web Pages");
    // The declared icon is an SVG data URI; normalizeIcon rasterizes it to PNG
    // because iOS UIImage can't decode SVG bytes (the whole point of the seed).
    expect(row?.icon).toMatch(/^data:image\/png;base64,/);
    expect(row?.accent_color).toBeTruthy();
  });

  test("re-seeding is idempotent — does not clobber the icon", async () => {
    const gate = directWriteGate(db);
    await seedWebSourceMeta(gate);
    const first = db
      .prepare<[string], { icon: string | null }>("SELECT icon FROM sync_state WHERE source_id = ?")
      .get(WEB_SOURCE_ID);
    await seedWebSourceMeta(gate);
    const second = db
      .prepare<[string], { icon: string | null }>("SELECT icon FROM sync_state WHERE source_id = ?")
      .get(WEB_SOURCE_ID);
    expect(second?.icon).toBe(first?.icon);
  });
});

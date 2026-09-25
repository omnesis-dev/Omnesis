// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;

import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";

import {
  OMNESIS_CHAT_ACCENT_COLOR,
  OMNESIS_CHAT_BG_COLOR,
  OMNESIS_CHAT_LABEL,
  OMNESIS_CHAT_SOURCE_ID,
  seedOmnesisChatSourceMeta,
} from "./source-meta.js";

function testDbPath(): string {
  return `/tmp/omnesis-chat-meta-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("seedOmnesisChatSourceMeta", () => {
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

  test("populates sync_state with label, colors, and a PNG data URI icon", async () => {
    await seedOmnesisChatSourceMeta(directWriteGate(db));

    const row = db
      .prepare<
        [string],
        {
          icon: string | null;
          label: string | null;
          bg_color: string | null;
          accent_color: string | null;
        }
      >("SELECT icon, label, bg_color, accent_color FROM sync_state WHERE source_id = ?")
      .get(OMNESIS_CHAT_SOURCE_ID);

    expect(row).toBeTruthy();
    expect(row?.label).toBe(OMNESIS_CHAT_LABEL);
    expect(row?.bg_color).toBe(OMNESIS_CHAT_BG_COLOR);
    expect(row?.accent_color).toBe(OMNESIS_CHAT_ACCENT_COLOR);
    // The normalize pipeline rasterises every source SVG to PNG and
    // passes raster sources through. The brand asset is a PNG, so we
    // expect the canonical png data-URI form.
    expect(row?.icon).toMatch(/^data:image\/png;base64,/);
  });

  test("re-seeding is idempotent — does not clobber the icon", async () => {
    const gate = directWriteGate(db);
    await seedOmnesisChatSourceMeta(gate);
    const first = db
      .prepare<[string], { icon: string | null }>("SELECT icon FROM sync_state WHERE source_id = ?")
      .get(OMNESIS_CHAT_SOURCE_ID);
    await seedOmnesisChatSourceMeta(gate);
    const second = db
      .prepare<[string], { icon: string | null }>("SELECT icon FROM sync_state WHERE source_id = ?")
      .get(OMNESIS_CHAT_SOURCE_ID);
    expect(second?.icon).toBe(first?.icon);
  });
});

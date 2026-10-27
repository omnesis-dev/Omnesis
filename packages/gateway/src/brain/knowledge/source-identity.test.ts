// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { KNOWLEDGE_SOURCE_ID } from "./source-meta.js";
import { KNOWLEDGE_SOURCE_LABEL, seedKnowledgeSourceMeta } from "./source-identity.js";
import type Database from "better-sqlite3";

describe("seedKnowledgeSourceMeta", () => {
  let path: string;
  let db: Database.Database;
  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
  });

  const row = () =>
    db
      .prepare<[string], { icon: string | null; label: string | null }>(
        "SELECT icon, label FROM sync_state WHERE source_id = ?",
      )
      .get(KNOWLEDGE_SOURCE_ID);

  test("gives wiki pages a label and a PNG wiki icon every client can decode", async () => {
    await seedKnowledgeSourceMeta(directWriteGate(db));
    expect(row()?.label).toBe(KNOWLEDGE_SOURCE_LABEL);
    expect(row()?.icon).toMatch(/^data:image\/png;base64,/);
  });

  test("re-seeding keeps the same icon", async () => {
    const gate = directWriteGate(db);
    await seedKnowledgeSourceMeta(gate);
    const first = row()?.icon;
    await seedKnowledgeSourceMeta(gate);
    expect(row()?.icon).toBe(first);
  });
});

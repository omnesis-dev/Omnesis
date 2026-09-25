// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Byte-identical net for the extracted legacy LIKE search. `likeSearchDocuments`
 * is the single source of the `GET /documents/search` result body, shared by the
 * main-thread fallback and the io-worker (`io.likeSearchDocuments`). These pin
 * the content match, source restriction, hidden-source exclusion, and the
 * ordering + limit so the extraction can't silently drift.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDatabase } from "../db.js";
import { likeSearchDocuments } from "./like-search.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-like-search-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function insertDoc(args: {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  createdAt: string;
}): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
                            metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', ?, ?, ?, ?, 'hash-' || ?, '{}', ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.sourceId,
    args.id,
    args.title,
    args.content,
    args.id,
    args.createdAt,
    args.createdAt,
    args.createdAt,
    args.createdAt,
  );
}

describe("likeSearchDocuments", () => {
  test("matches documents whose content contains the query substring", () => {
    insertDoc({
      id: "d1",
      sourceId: "gmail:self",
      title: "Q4 budget",
      content: "the quarterly budget review is due Friday",
      createdAt: "2026-03-01T00:00:00Z",
    });
    insertDoc({
      id: "d2",
      sourceId: "gmail:self",
      title: "Marathon",
      content: "marathon entry form deadline",
      createdAt: "2026-03-02T00:00:00Z",
    });

    const rows = likeSearchDocuments(db, { query: "budget", hiddenSourceIds: [], limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("d1");
    expect(rows[0]?.title).toBe("Q4 budget");
    expect(rows[0]?.source_id).toBe("gmail:self");
  });

  test("restricts to the given sourceIds", () => {
    insertDoc({
      id: "d1",
      sourceId: "gmail:self",
      title: "A",
      content: "shared keyword here",
      createdAt: "2026-03-01T00:00:00Z",
    });
    insertDoc({
      id: "d2",
      sourceId: "notion:self",
      title: "B",
      content: "shared keyword too",
      createdAt: "2026-03-02T00:00:00Z",
    });

    const rows = likeSearchDocuments(db, {
      query: "shared keyword",
      sourceIds: ["notion:self"],
      hiddenSourceIds: [],
      limit: 50,
    });
    expect(rows.map((r) => r.id)).toEqual(["d2"]);
  });

  test("excludes hidden sources", () => {
    insertDoc({
      id: "d1",
      sourceId: "gmail:self",
      title: "A",
      content: "common word",
      createdAt: "2026-03-01T00:00:00Z",
    });
    insertDoc({
      id: "d2",
      sourceId: "omnesis-chat:self",
      title: "B",
      content: "common word",
      createdAt: "2026-03-02T00:00:00Z",
    });

    const rows = likeSearchDocuments(db, {
      query: "common word",
      hiddenSourceIds: ["omnesis-chat:self"],
      limit: 50,
    });
    expect(rows.map((r) => r.id)).toEqual(["d1"]);
  });

  test("orders by source_created_at DESC and honours the limit", () => {
    for (let i = 0; i < 5; i++) {
      insertDoc({
        id: `d${i}`,
        sourceId: "gmail:self",
        title: `Doc ${i}`,
        content: "ordering probe",
        createdAt: `2026-03-0${i + 1}T00:00:00Z`,
      });
    }
    const rows = likeSearchDocuments(db, {
      query: "ordering probe",
      hiddenSourceIds: [],
      limit: 2,
    });
    // Newest first, capped at the limit.
    expect(rows.map((r) => r.id)).toEqual(["d4", "d3"]);
  });

  test("returns an empty array on no match", () => {
    insertDoc({
      id: "d1",
      sourceId: "gmail:self",
      title: "A",
      content: "nothing relevant",
      createdAt: "2026-03-01T00:00:00Z",
    });
    expect(likeSearchDocuments(db, { query: "absent", hiddenSourceIds: [], limit: 50 })).toEqual(
      [],
    );
  });
});

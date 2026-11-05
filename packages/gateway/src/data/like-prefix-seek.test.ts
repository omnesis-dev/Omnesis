// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "./schema.js";
import { runMigrations } from "./migrations.js";
import {
  documentIdPrefixFilter,
  likePrefixSeek,
  matchDocumentIdPrefix,
} from "./like-prefix-seek.js";
import type { Db } from "./types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-like-prefix-seek-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insert(id: string, externalId: string, sourceId = "notes-a", streamId = ""): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content,
       content_hash, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'notes', ?, ?, ?, 'Title', 'Body', 'hash', '2025-01-01', '2025-01-01',
       '2025-01-01', '2025-01-01')`,
  ).run(id, sourceId, externalId, streamId);
}

function plan(sql: string, params: unknown[]): string[] {
  return db
    .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail);
}

describe("likePrefixSeek", () => {
  test("seeks on the literal head before the first wildcard, ASCII-lowercased", () => {
    expect(likePrefixSeek("AbC-12%")).toEqual({ lower: "abc-12", upper: "abc-13" });
    expect(likePrefixSeek("ab_cd%")).toEqual({ lower: "ab", upper: "ac" });
    expect(likePrefixSeek("ab%cd")).toEqual({ lower: "ab", upper: "ac" });
    expect(likePrefixSeek("Folder/Report/att/%")).toEqual({
      lower: "folder/report/att/",
      upper: "folder/report/att0",
    });
  });

  test("leaves non-ASCII characters as they are, as SQLite's LIKE and LOWER do", () => {
    expect(likePrefixSeek("ÉtÉ%")).toEqual({ lower: "ÉtÉ", upper: "ÉtÊ" });
  });

  test("has no upper bound when the head is empty or cannot be incremented", () => {
    expect(likePrefixSeek("%")).toEqual({ lower: "", upper: null });
    expect(likePrefixSeek("_ab%")).toEqual({ lower: "", upper: null });
    expect(likePrefixSeek("")).toEqual({ lower: "", upper: null });
    expect(likePrefixSeek("\u{10FFFF}\u{10FFFF}%")).toEqual({
      lower: "\u{10FFFF}\u{10FFFF}",
      upper: null,
    });
  });

  test("carries past the last code point and the surrogate range", () => {
    expect(likePrefixSeek("a\u{10FFFF}%").upper).toBe("b");
    expect(likePrefixSeek("a퟿%").upper).toBe("a");
    expect(likePrefixSeek("a\u{1F600}%").upper).toBe("a\u{1F601}");
  });

  test("computes the range on the well-formed text SQLite receives", () => {
    expect(likePrefixSeek("a\uD800%")).toEqual({ lower: "a�", upper: "a￾" });
  });
});

describe("document id prefixes", () => {
  /** The prefix lookup the gateway used before it could seek. */
  function referenceMatches(input: string): string[] {
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE id LIKE ? ORDER BY id")
      .all(`${input}%`)
      .map((row) => row.id);
  }

  function seekMatches(input: string): string[] {
    const filter = documentIdPrefixFilter(input);
    return db
      .prepare<string[], { id: string }>(`SELECT id FROM documents WHERE ${filter.sql} ORDER BY id`)
      .all(...filter.params)
      .map((row) => row.id);
  }

  test("match exactly what the LIKE prefix matched", () => {
    const ids = Array.from({ length: 400 }, () => randomUUID());
    ids.forEach((id, index) => insert(id, `note-${index}`));
    const inputs = new Set<string>(["", "%", "_", "%%", "_-", "-", "é", "\u{10FFFF}", "\uD800"]);
    for (const id of ids.slice(0, 40)) {
      for (const length of [1, 2, 3, 8, 9, 13, 36]) {
        const prefix = id.slice(0, length);
        inputs.add(prefix);
        inputs.add(prefix.toUpperCase());
        inputs.add(`${prefix}x`);
      }
      inputs.add(`${id.slice(0, 4)}_${id.slice(5, 10)}`);
      inputs.add(`${id.slice(0, 3)}%${id.slice(30)}`);
      inputs.add(`_${id.slice(1, 6)}`);
      inputs.add(`${id}-extra`);
    }
    let compared = 0;
    for (const input of inputs) {
      expect(seekMatches(input), input).toEqual(referenceMatches(input));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(800);
  });

  test("matchDocumentIdPrefix returns at most two ids in id order", () => {
    insert("ab02", "a");
    insert("ab01", "b");
    insert("ab03", "c");
    insert("ac00", "d");
    expect(matchDocumentIdPrefix(db, "ab")).toEqual(["ab01", "ab02"]);
    expect(matchDocumentIdPrefix(db, "AB03")).toEqual(["ab03"]);
    expect(matchDocumentIdPrefix(db, "ab0_")).toEqual(["ab01", "ab02"]);
    expect(matchDocumentIdPrefix(db, "ad")).toEqual([]);
  });

  test("seek the primary key rather than scan the table", () => {
    const filter = documentIdPrefixFilter("ab12");
    for (const sql of [
      `SELECT id FROM documents WHERE ${filter.sql} ORDER BY id LIMIT 2`,
      `SELECT id, provider_id, source_id, external_id, stream_id FROM documents
        WHERE ${filter.sql} ORDER BY rowid LIMIT 2`,
    ]) {
      const detail = plan(sql, filter.params);
      expect(detail[0], sql).toMatch(
        /^SEARCH documents USING (COVERING )?INDEX \S+ \(id>\? AND id<\?\)$/,
      );
      expect(detail.join("\n")).not.toMatch(/SCAN documents/);
    }
    const unbounded = documentIdPrefixFilter("_b12");
    expect(
      plan(
        `SELECT id FROM documents WHERE ${unbounded.sql} ORDER BY id LIMIT 2`,
        unbounded.params,
      )[0],
    ).toMatch(/^SEARCH documents USING COVERING INDEX \S+ \(id>\?\)$/);
  });
});

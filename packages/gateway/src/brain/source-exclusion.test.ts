// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  brainSourceInclusionSql,
  createBrainSourceFence,
  excludedDocumentIds,
  isBrainExcludedSource,
} from "./source-exclusion.js";

const SOURCE_IDS = [
  "codex",
  "codex:local",
  "codex:workstation",
  "codex-archive:local",
  "github:jamie-lopez",
  "github:sarah-mendez",
  "gmail:maya@example.com",
  ":orphan",
];

describe("isBrainExcludedSource", () => {
  it("covers every source of a bare type, and nothing else", () => {
    expect(SOURCE_IDS.filter((id) => isBrainExcludedSource(["codex"], id))).toEqual([
      "codex",
      "codex:local",
      "codex:workstation",
    ]);
  });

  it("covers exactly one source for a source id", () => {
    expect(SOURCE_IDS.filter((id) => isBrainExcludedSource(["github:jamie-lopez"], id))).toEqual([
      "github:jamie-lopez",
    ]);
  });

  it("excludes nothing with no entries", () => {
    expect(SOURCE_IDS.some((id) => isBrainExcludedSource([], id))).toBe(false);
  });
});

describe("SQL and document lookups", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY, source_id TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO documents VALUES(?,?)");
    for (const [index, sourceId] of SOURCE_IDS.entries()) insert.run(`doc-${index}`, sourceId);
  });
  afterEach(() => db.close());

  function included(excluded: string[]): string[] {
    const inclusion = brainSourceInclusionSql(excluded, "source_id");
    return db
      .prepare<unknown[], { source_id: string }>(
        `SELECT source_id FROM documents WHERE ${inclusion.sql} ORDER BY rowid`,
      )
      .all(...inclusion.params)
      .map((row) => row.source_id);
  }

  it.each([[[]], [["codex"]], [["github:jamie-lopez"]], [["codex", "gmail:maya@example.com"]]])(
    "agrees with the in-memory matcher for %j",
    (excluded) => {
      expect(included(excluded)).toEqual(
        SOURCE_IDS.filter((id) => !isBrainExcludedSource(excluded, id)),
      );
    },
  );

  it("finds the excluded subset of a set of document ids, ignoring unknown ids", () => {
    expect(
      [
        ...excludedDocumentIds(db, ["codex"], ["doc-0", "doc-1", "doc-3", "doc-6", "unknown"]),
      ].sort(),
    ).toEqual(["doc-0", "doc-1"]);
    expect(excludedDocumentIds(db, [], ["doc-0"]).size).toBe(0);
  });

  it("reads the configured list on every call", () => {
    let excluded: string[] = [];
    const fence = createBrainSourceFence(db, () => excluded);
    expect(fence.excludesSource("codex:local")).toBe(false);
    excluded = ["codex"];
    expect(fence.entries()).toEqual(["codex"]);
    expect(fence.excludesSource("codex:local")).toBe(true);
    expect([...fence.excludedDocuments(["doc-1", "doc-6"])]).toEqual(["doc-1"]);
  });
});

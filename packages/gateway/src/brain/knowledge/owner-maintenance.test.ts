// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { isHistoricalKnowledgeOwner } from "./owner-maintenance.js";

describe("canonical annotation lifecycle", () => {
  it.each(["doc_annotation", "person_annotation"] as const)(
    "uses the live %s lifecycle instead of a stale mirror",
    (kind) => {
      const db = new Database(":memory:");
      try {
        const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
        db.exec(
          `CREATE TABLE ${table}(id TEXT PRIMARY KEY,invalidated_at INTEGER,superseded_by TEXT); INSERT INTO ${table} VALUES('note',NULL,NULL)`,
        );
        const node = {
          id: "mirror",
          ownerId: "note",
          kind,
          canonicalFields: { invalidatedAt: 1, withdrawn: true },
        };
        expect(isHistoricalKnowledgeOwner(db, node, 10)).toBe(false);
        db.exec(`UPDATE ${table} SET invalidated_at=0`);
        expect(isHistoricalKnowledgeOwner(db, node, 10)).toBe(true);
        db.exec(`UPDATE ${table} SET invalidated_at=NULL,superseded_by='replacement'`);
        expect(isHistoricalKnowledgeOwner(db, node, 10)).toBe(true);
        db.exec(`DELETE FROM ${table}`);
        expect(isHistoricalKnowledgeOwner(db, { ...node, canonicalFields: {} }, 10)).toBe(false);
        expect(isHistoricalKnowledgeOwner(db, node, 10)).toBe(true);
      } finally {
        db.close();
      }
    },
  );
});

it("treats only archival loop removal as historical, not a live resolved row or missing owner", () => {
  const db = new Database(":memory:");
  try {
    const node = {
      id: "mirror",
      ownerId: "task",
      kind: "loop" as const,
      canonicalFields: { state: "retired" },
    };
    expect(isHistoricalKnowledgeOwner(db, node, 10)).toBe(false);
    db.exec(
      "CREATE TABLE open_loops(id TEXT PRIMARY KEY,state TEXT); CREATE TABLE retired_loops(id TEXT PRIMARY KEY); INSERT INTO retired_loops VALUES('task')",
    );
    expect(isHistoricalKnowledgeOwner(db, node, 10)).toBe(true);
    for (const state of ["open", "done", "dismissed"]) {
      db.prepare("INSERT OR REPLACE INTO open_loops VALUES('task',?)").run(state);
      expect(isHistoricalKnowledgeOwner(db, node, 10)).toBe(false);
    }
    db.exec("DELETE FROM open_loops; DELETE FROM retired_loops");
    expect(isHistoricalKnowledgeOwner(db, node, 10)).toBe(false);
  } finally {
    db.close();
  }
});

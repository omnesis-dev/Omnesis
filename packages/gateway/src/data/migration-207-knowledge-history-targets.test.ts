// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { compactKnowledgeHistoryTargets } from "./migration-207-knowledge-history-targets.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  // The history as earlier writers kept it: every revision's full citation list.
  db.exec(`CREATE TABLE knowledge_revision_dependencies (
    node_id TEXT NOT NULL, revision INTEGER NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
    PRIMARY KEY(node_id,revision,target_kind,target_id))`);
  const put = db.prepare("INSERT INTO knowledge_revision_dependencies VALUES(?,?,?,?)");
  for (const [node, revision, kind, target] of [
    ["page_a", 1, "source", "doc_c"],
    ["page_a", 2, "source", "doc_c"],
    ["page_a", 2, "source", "doc_a"],
    ["page_a", 3, "source", "doc_a"],
    ["page_a", 3, "node", "page_b"],
    ["page_a", 4, "source", "doc_a"],
    ["page_a", 4, "source", "doc_c"],
    ["page_a", 4, "node", "page_b"],
    ["page_b", 1, "source", "doc_a"],
    ["page_b", 2, "source", "doc_a"],
  ] as const)
    put.run(node, revision, kind, target);
});
afterEach(() => db.close());

const scan = () =>
  db
    .prepare(
      "SELECT node_id,revision,target_kind,target_id FROM knowledge_revision_dependencies ORDER BY node_id,revision,target_kind,target_id",
    )
    .all();
/** What a privacy-closure walk meets for one node: distinct targets, first seen first. */
const reached = (node: string) => [
  ...new Set(
    db
      .prepare<[string], { target_kind: string; target_id: string }>(
        "SELECT target_kind,target_id FROM knowledge_revision_dependencies WHERE node_id=? ORDER BY revision,target_kind,target_id",
      )
      .all(node)
      .map((row) => `${row.target_kind}:${row.target_id}`),
  ),
];

it("keeps each target once, at the earliest revision that cited it", () => {
  const before = { a: reached("page_a"), b: reached("page_b") };
  db.transaction(() => compactKnowledgeHistoryTargets(db))();
  expect(scan()).toEqual([
    { node_id: "page_a", revision: 1, target_kind: "source", target_id: "doc_c" },
    { node_id: "page_a", revision: 2, target_kind: "source", target_id: "doc_a" },
    { node_id: "page_a", revision: 3, target_kind: "node", target_id: "page_b" },
    { node_id: "page_b", revision: 1, target_kind: "source", target_id: "doc_a" },
  ]);
  expect({ a: reached("page_a"), b: reached("page_b") }).toEqual(before);
});

it("is idempotent and skips stores without knowledge history", () => {
  compactKnowledgeHistoryTargets(db);
  compactKnowledgeHistoryTargets(db);
  expect(scan()).toHaveLength(4);
  const empty = new Database(":memory:");
  try {
    expect(() => compactKnowledgeHistoryTargets(empty)).not.toThrow();
  } finally {
    empty.close();
  }
});

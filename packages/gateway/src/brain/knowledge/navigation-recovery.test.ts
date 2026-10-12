// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createKnowledgeTables, saveKnowledgeNode } from "./storage.js";
import { recoverRootNavigation } from "./navigation-recovery.js";
import { readKnowledgeHistory } from "./history-view.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('evidence','A fictional ceramics catalogue.','v1')",
  );
  createKnowledgeTables(db);
});
afterEach(() => db.close());
function save(
  id: string,
  text: string,
  kind: "root" | "wiki" = "wiki",
  title = "Current catalogue",
) {
  const row = db
    .prepare<[string], { revision: number }>("SELECT revision FROM knowledge_nodes WHERE id=?")
    .get(id);
  return saveKnowledgeNode(
    db,
    {
      id,
      kind,
      title,
      expectedRevision: row?.revision ?? 0,
      markdown: `<claim id="scope" refs="source:evidence">${text}</claim>`,
      inputVersions: { "source:evidence": "v1" },
    },
    (row?.revision ?? 0) + 1,
  );
}
function seed() {
  save("wiki_catalogue", "Current source-backed catalogue.");
  save("overview", "Obsolete historical assertion. [Old label](wiki:wiki_catalogue)", "root");
  save("overview", "Compact orientation without links.", "root");
}

it("offers current identities through a verification-only tail without old prose or proof", () => {
  seed();
  save("wiki_catalogue", "New current catalogue.", "wiki", "Renamed current catalogue");
  for (let i = 0; i < 20; i++) save("overview", "Compact orientation without links.", "root");
  const before = db
    .prepare("SELECT markdown,revision FROM knowledge_nodes WHERE id='overview'")
    .get();
  expect(recoverRootNavigation(db, "overview", 8)).toEqual({
    candidates: [{ id: "wiki_catalogue", title: "Renamed current catalogue", revision: 2 }],
    incomplete: false,
  });
  expect(
    db.prepare("SELECT markdown,revision FROM knowledge_nodes WHERE id='overview'").get(),
  ).toEqual(before);
  expect(JSON.stringify(recoverRootNavigation(db, "overview", 8))).not.toMatch(
    /Obsolete|Old label|source:evidence|verified|fingerprint/,
  );
});

it("does not automatically restore a deliberate omission or require any links", () => {
  seed();
  expect(recoverRootNavigation(db, "overview", 8)?.candidates).toHaveLength(1);
  save("overview", "No catalogue belongs in this compact orientation.", "root");
  expect(db.prepare("SELECT plain_text FROM knowledge_nodes WHERE id='overview'").get()).toEqual({
    plain_text: "No catalogue belongs in this compact orientation.",
  });
});

it("avoids history scanning for roots already linking a wiki and for non-root nodes", () => {
  seed();
  save("overview", "[Current catalogue](wiki:wiki_catalogue)", "root");
  expect(recoverRootNavigation(db, "overview", 8)).toBeUndefined();
  expect(recoverRootNavigation(db, "wiki_catalogue", 8)).toBeUndefined();
});

it.each(["deleted", "withdrawn", "private-target", "private-history"] as const)(
  "withholds %s navigation without disclosing old identities",
  (mode) => {
    seed();
    if (mode === "deleted")
      db.prepare("DELETE FROM knowledge_nodes WHERE id='wiki_catalogue'").run();
    if (mode === "withdrawn")
      db.prepare("UPDATE knowledge_nodes SET fields_json=? WHERE id='wiki_catalogue'").run(
        JSON.stringify({ withdrawn: true }),
      );
    if (mode === "private-target") {
      db.exec("INSERT INTO documents VALUES('private-evidence','Private catalogue.','v2')");
      db.prepare(
        "UPDATE knowledge_dependencies SET target_id='private-evidence',ref='source:private-evidence' WHERE node_id='wiki_catalogue'",
      ).run();
      db.prepare(
        "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('private-evidence','v2',1,20)",
      ).run();
    }
    if (mode === "private-history")
      db.prepare(
        "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('evidence','v1',1,20)",
      ).run();
    expect(recoverRootNavigation(db, "overview", 8)).toBeUndefined();
  },
);

it("shares real Markdown link and alias semantics, deduplicating targets", () => {
  save("wiki_catalogue", "Catalogue.");
  save(
    "overview",
    "`[literal](wiki:wiki_literal)` [One](wiki:wiki_catalogue) [Two](/portal/debug/cognition/knowledge/wiki_catalogue?kind=wiki)",
    "root",
  );
  save("overview", "No links.", "root");
  expect(recoverRootNavigation(db, "overview", 8)?.candidates.map((x) => x.id)).toEqual([
    "wiki_catalogue",
  ]);
});

it("does not turn a mismatched typed link into a wiki candidate", () => {
  save("wiki_catalogue", "Catalogue.");
  save("overview", "[Wrong kind](loop:wiki_catalogue)", "root");
  save("overview", "No links.", "root");
  expect(recoverRootNavigation(db, "overview", 8)).toBeUndefined();
});

it("does not let a wrong typed alias suppress a later valid wiki link", () => {
  save("wiki_catalogue", "Catalogue.");
  save(
    "overview",
    "[Wrong kind](loop:wiki_catalogue) [Current catalogue](wiki:wiki_catalogue)",
    "root",
  );
  save("overview", "No links.", "root");
  expect(
    recoverRootNavigation(db, "overview", 8)?.candidates.map((candidate) => candidate.id),
  ).toEqual(["wiki_catalogue"]);
});

it("retains navigation after readable source changes without supplying stale proof", () => {
  seed();
  db.prepare("UPDATE documents SET content_hash='new-version' WHERE id='evidence'").run();
  expect(recoverRootNavigation(db, "overview", 8)).toEqual({
    candidates: [{ id: "wiki_catalogue", title: "Current catalogue", revision: 1 }],
    incomplete: false,
  });
});

it("applies the history privacy fence even after current root dependencies change", () => {
  seed();
  db.exec("INSERT INTO documents VALUES('current-evidence','Current orientation.','current-v1')");
  saveKnowledgeNode(
    db,
    {
      id: "overview",
      kind: "root",
      title: "Current orientation",
      expectedRevision: 2,
      markdown:
        '<claim id="scope" refs="source:current-evidence">Current orientation without links.</claim>',
      inputVersions: { "source:current-evidence": "current-v1" },
    },
    3,
  );
  expect(recoverRootNavigation(db, "overview", 8)?.candidates).toHaveLength(1);
  expect(
    db.prepare("SELECT target_id FROM knowledge_dependencies WHERE node_id='overview'").all(),
  ).toEqual([{ target_id: "current-evidence" }]);
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('evidence','v1',1,20)",
  ).run();
  expect(() => readKnowledgeHistory(db, { id: "overview" })).toThrow("unavailable");
  expect(recoverRootNavigation(db, "overview", 8)).toBeUndefined();
});

it("bounds current navigation lookup work before scanning history", () => {
  seed();
  save(
    "overview",
    Array.from({ length: 129 }, (_, i) => `[Unavailable](wiki:wiki_missing_${i})`).join(" "),
    "root",
  );
  expect(recoverRootNavigation(db, "overview", 8)).toBeUndefined();
});

it("bounds snapshots and scan work without treating omitted history as absent", () => {
  seed();
  db.prepare(
    "UPDATE knowledge_revisions SET plain_text=? WHERE node_id='overview' AND revision=1",
  ).run("x".repeat(65537));
  expect(recoverRootNavigation(db, "overview", 8)).toEqual({ candidates: [], incomplete: true });
  for (let i = 0; i < 105; i++) save("overview", "No links.", "root");
  expect(recoverRootNavigation(db, "overview", 8)).toEqual({ candidates: [], incomplete: true });
});

it("omits oversized historical markup even when its displayed text is short", () => {
  seed();
  db.prepare(
    "UPDATE knowledge_revisions SET markdown=? WHERE node_id='overview' AND revision=1",
  ).run("x".repeat(65537));
  expect(recoverRootNavigation(db, "overview", 8)).toEqual({ candidates: [], incomplete: true });
});

it("returns only a bounded current-target prefix", () => {
  for (let i = 0; i < 10; i++) save(`wiki_item_${i}`, "Catalogue.");
  save(
    "overview",
    Array.from({ length: 10 }, (_, i) => `[Item](wiki:wiki_item_${i})`).join(" "),
    "root",
  );
  save("overview", "No links.", "root");
  expect(recoverRootNavigation(db, "overview", 2)).toMatchObject({
    candidates: [{ id: "wiki_item_0" }, { id: "wiki_item_1" }],
    incomplete: true,
  });
});

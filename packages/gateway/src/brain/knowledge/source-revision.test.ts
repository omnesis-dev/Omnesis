// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { resolveBrainSettings } from "../config.js";
import { KnowledgeService } from "./service.js";
import { directKnowledgeGate } from "./writer.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { createKnowledgeSourceTriggers } from "./source-triggers.js";
import { readKnowledgeSourceRevision } from "./source-revision.js";
import { registerKnowledgeEvidence, getKnowledgeEvidence } from "./storage-evidence.js";
import { resolveKnowledgeReference } from "./storage-validation.js";
import { parseClaimMarkup } from "./claims.js";
import { saveKnowledgeNode } from "./storage.js";

const databases: Database.Database[] = [];
function setup(legacy = false, trackedOnly = false) {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT,content_hash TEXT,content TEXT,metadata TEXT DEFAULT '{}',title TEXT,source_created_at TEXT,source_updated_at TEXT)",
  );
  if (legacy) {
    db.exec(
      "CREATE TABLE knowledge_source_revisions(document_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL); INSERT INTO knowledge_source_revisions VALUES('source','body',0,1); INSERT INTO documents(id,source_id,provider_id,content_hash,content,title) VALUES('source','fictional','fictional','body','The prism glows.','Prism')",
    );
  }
  if (trackedOnly)
    db.exec(`
    CREATE TABLE knowledge_candidate_sources(document_id TEXT);
    CREATE TABLE knowledge_discovery_coverage(subject_id TEXT);
    INSERT INTO documents(id,content_hash,content,title) VALUES('candidate','body-c','Candidate evidence','Candidate'),('coverage','body-d','Coverage evidence','Coverage');
    INSERT INTO knowledge_candidate_sources VALUES('candidate');
    INSERT INTO knowledge_discovery_coverage VALUES('coverage');
  `);
  createKnowledgeTables(db);
  if (trackedOnly) return db;
  createKnowledgeWorkTables(db);
  createKnowledgeSourceTriggers(db);
  if (!legacy)
    db.exec(
      "INSERT INTO documents(id,source_id,provider_id,content_hash,content,title,source_created_at,source_updated_at) VALUES('source','fictional','fictional','body','The prism glows.','Prism','2025-01-01','2025-01-01')",
    );
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

it.each(["title", "source_created_at", "source_updated_at"])(
  "versions metadata-only %s edits and journals them atomically",
  (field) => {
    const db = setup();
    const original = readKnowledgeSourceRevision(db, "source");
    db.prepare(`UPDATE documents SET ${field}=? WHERE id='source'`).run("changed");
    expect(readKnowledgeSourceRevision(db, "source")).not.toBe(original);
    expect(db.prepare("SELECT content_hash FROM documents").get()).toEqual({
      content_hash: "body",
    });
    const count = db.prepare("SELECT COUNT(*) n FROM knowledge_changes").get();
    db.prepare(`UPDATE documents SET ${field}=? WHERE id='source'`).run("changed");
    expect(db.prepare("SELECT COUNT(*) n FROM knowledge_changes").get()).toEqual(count);
    expect(() =>
      db.transaction(() => {
        db.prepare(`UPDATE documents SET ${field}=? WHERE id='source'`).run("rollback");
        throw Error("rollback");
      })(),
    ).toThrow("rollback");
    expect(db.prepare("SELECT COUNT(*) n FROM knowledge_changes").get()).toEqual(count);
  },
);
it("preserves quote/body identity while rejecting stale selected-reference commits", () => {
  const db = setup();
  const quote = registerKnowledgeEvidence(
    db,
    { documentId: "source", contentHash: "body", quote: "The prism glows." },
    1,
  );
  const ref = `source:source#evidence:${quote.id}`;
  const markdown = `<claim id="fact" refs="${ref}">The prism glows.</claim>`;
  const parsed = parseClaimMarkup(markdown).claims[0]!.refs[0]!;
  const before = resolveKnowledgeReference(db, parsed).revision;
  db.prepare("UPDATE documents SET title='Renamed prism' WHERE id='source'").run();
  expect(getKnowledgeEvidence(db, quote.id)?.contentHash).toBe("body");
  expect(resolveKnowledgeReference(db, parsed).revision).not.toBe(before);
  expect(() =>
    saveKnowledgeNode(
      db,
      {
        id: "wiki",
        kind: "wiki",
        title: "Prism",
        markdown,
        expectedRevision: 0,
        inputVersions: { [ref]: before },
      },
      2,
    ),
  ).toThrow("Stale dependency version");
});
it("does not reuse a source revision after body or metadata ABA", () => {
  const db = setup();
  const first = readKnowledgeSourceRevision(db, "source");
  db.exec(
    "UPDATE documents SET content_hash='other',content='The prism dims.' WHERE id='source'; UPDATE documents SET content_hash='body',content='The prism glows.' WHERE id='source'",
  );
  const second = readKnowledgeSourceRevision(db, "source");
  expect(second).not.toBe(first);
  db.exec(
    "UPDATE documents SET title='Other' WHERE id='source'; UPDATE documents SET title='Prism' WHERE id='source'",
  );
  expect(readKnowledgeSourceRevision(db, "source")).not.toBe(second);
});
it("invalidates existing-store legacy generations once without rewriting body hashes", () => {
  const db = setup(true);
  const revision = readKnowledgeSourceRevision(db, "source");
  expect(revision).toBe("body:knowledge:1");
  expect(db.prepare("SELECT revision FROM knowledge_changes").all()).toEqual([{ revision }]);
  createKnowledgeTables(db);
  createKnowledgeSourceTriggers(db);
  expect(readKnowledgeSourceRevision(db, "source")).toBe(revision);
  expect(db.prepare("SELECT COUNT(*) n FROM knowledge_changes").get()).toEqual({ n: 1 });
});
it("invalidates legacy coverage-only and candidate-only decisions without sidecar rows", () => {
  const db = setup(true, true);
  for (const [id, body] of [
    ["candidate", "body-c"],
    ["coverage", "body-d"],
  ]) {
    expect(readKnowledgeSourceRevision(db, id!)).toBe(`${body}:knowledge:1`);
    expect(db.prepare("SELECT revision FROM knowledge_changes WHERE entity_id=?").get(id)).toEqual({
      revision: `${body}:knowledge:1`,
    });
    expect(
      db.prepare("SELECT revision FROM knowledge_cascade_jobs WHERE target_id=?").get(id),
    ).toEqual({ revision: `${body}:knowledge:1` });
  }
  createKnowledgeTables(db);
  expect(db.prepare("SELECT COUNT(*) n FROM knowledge_changes").get()).toEqual({ n: 3 });
});
it("erases retained metadata context on deletion", () => {
  const db = setup();
  db.exec("DELETE FROM documents WHERE id='source'");
  expect(readKnowledgeSourceRevision(db, "source")).toBeNull();
  expect(db.prepare("SELECT source_context,deleted FROM knowledge_source_revisions").get()).toEqual(
    { source_context: null, deleted: 1 },
  );
});

it("rejects a metadata edit during asynchronous verification at the final writer", async () => {
  const db = setup();
  const service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    clock: () => 10,
    getSettings: () => resolveBrainSettings(),
    log: createLogger("source-revision-test"),
    getEntailmentVerifier: async () => ({
      async verify() {
        db.prepare("UPDATE documents SET source_updated_at='2026-01-01' WHERE id='source'").run();
        return { label: "entailment" as const };
      },
      dispose() {},
    }),
  });
  await expect(
    service.save({
      id: "wiki",
      kind: "wiki",
      title: "Prism",
      markdown: '<claim id="fact" refs="source:source">The prism glows.</claim>',
      expectedRevision: 0,
      inputVersions: { "source:source": "body" },
    }),
  ).rejects.toThrow("Stale dependency version");
  expect(db.prepare("SELECT id FROM knowledge_nodes WHERE id='wiki'").get()).toBeUndefined();
});

it("preserves the existing context encoding and revisions for ordinary source metadata", () => {
  const db = setup();
  expect(
    db
      .prepare("SELECT source_context FROM knowledge_source_revisions WHERE document_id='source'")
      .get(),
  ).toEqual({ source_context: JSON.stringify(["Prism", "2025-01-01", "2025-01-01"]) });
  const revision = readKnowledgeSourceRevision(db, "source");
  db.exec("UPDATE documents SET metadata='{\"unrelated\":true}' WHERE id='source'");
  expect(readKnowledgeSourceRevision(db, "source")).toBe(revision);
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { COGNITION_AUTHORED_SOURCES } from "../cognition-authored.js";
import { OMNESIS_CHAT_SOURCE_ID } from "../../sources/omnesis-chat/ids.js";
import { proposeKnowledgeCandidate, getKnowledgeCandidate } from "./discovery.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { createKnowledgeSourceTriggers } from "./source-triggers.js";
import { advanceKnowledgeCascade, getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
import { KNOWLEDGE_SOURCE_ID, KNOWLEDGE_DOCUMENT_TYPE } from "./source-meta.js";

const databases: Database.Database[] = [];
function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,provider_id TEXT,content_hash TEXT,content TEXT,metadata TEXT DEFAULT '{}')",
  );
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  createKnowledgeSourceTriggers(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe("durable source intake", () => {
  it("journals committed content changes without reacting to its own projections", () => {
    const db = setup();
    const put = db.prepare(
      "INSERT INTO documents(id,source_id,provider_id,content_hash,content) VALUES(?,?,'fictional',?,'content')",
    );
    put.run("evidence", "inbox", "v1");
    put.run("mirror", KNOWLEDGE_SOURCE_ID, "v1");
    db.prepare("UPDATE documents SET content_hash='v1' WHERE id='evidence'").run();
    expect(db.prepare("SELECT revision FROM knowledge_changes").all()).toEqual([
      { revision: "v1" },
    ]);
    expect(() =>
      db.transaction(() => {
        db.prepare("UPDATE documents SET content_hash='rolledback' WHERE id='evidence'").run();
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");
    expect(db.prepare("SELECT content_hash FROM knowledge_source_revisions").all()).toEqual([
      { content_hash: "v1" },
    ]);
    db.prepare("UPDATE documents SET content_hash='v2' WHERE id='evidence'").run();
    expect(db.prepare("SELECT revision FROM knowledge_changes ORDER BY seq").all()).toEqual([
      { revision: "v1" },
      { revision: "v2" },
    ]);
  });
  it("accepts a restored source version through UPSERT before maintenance drains", () => {
    const db = setup();
    const upsert = db.prepare(
      `INSERT INTO documents(id,source_id,provider_id,content_hash,content)
       VALUES('evidence','inbox','fictional',?,?)
       ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,content=excluded.content`,
    );
    upsert.run("v1", "Original plan");
    upsert.run("v2", "Revised plan");
    expect(() => upsert.run("v1", "Original plan")).not.toThrow();
    expect(db.prepare("SELECT revision FROM knowledge_changes ORDER BY seq").all()).toEqual([
      { revision: "v1" },
      { revision: "v2" },
      { revision: "v1" },
    ]);
    expect(db.prepare("SELECT content_hash FROM knowledge_source_revisions").get()).toEqual({
      content_hash: "v1",
    });
    expect(advanceKnowledgeCascade(db, 100, 1).pending).toBe(false);
  });
  it("fences derived content in the delete transaction before the maintenance worker runs", () => {
    const db = setup();
    db.prepare(
      "INSERT INTO documents(id,source_id,provider_id,content_hash,content) VALUES('evidence','inbox','fictional','v1','A plan')",
    ).run();
    advanceKnowledgeCascade(db, 100, 1);
    saveKnowledgeNode(
      db,
      {
        id: "project",
        kind: "wiki",
        title: "Project",
        markdown: '<claim id="c" refs="source:evidence">A plan</claim>',
        expectedRevision: 0,
        inputVersions: { "source:evidence": "v1" },
      },
      2,
    );
    expect(getKnowledgeNode(db, "project")).not.toBeNull();
    db.prepare("DELETE FROM documents WHERE id='evidence'").run();
    expect(getKnowledgeNode(db, "project")).toBeNull();
    expect(db.prepare("SELECT 1 FROM knowledge_nodes WHERE id='project'").get()).toBeDefined();
    advanceKnowledgeCascade(db, 100, 3);
    expect(db.prepare("SELECT 1 FROM knowledge_nodes WHERE id='project'").get()).toBeUndefined();
  });
  it("excludes every registered authored source and exclusive type from intake", () => {
    const db = setup();
    for (const [index, source] of COGNITION_AUTHORED_SOURCES.entries()) {
      db.prepare(
        "INSERT INTO documents(id,source_id,provider_id,content_hash,content) VALUES(?,?,'system','v1','generated')",
      ).run(`mirror-${index}`, source.sourceId);
      for (const [typeIndex, type] of source.exclusiveDocumentTypes.entries()) {
        db.prepare(
          "INSERT INTO documents(id,source_id,provider_id,content_hash,content,metadata) VALUES(?,'unknown-source','system','v1','generated',?)",
        ).run(`typed-${index}-${typeIndex}`, JSON.stringify({ documentType: type }));
      }
    }
    db.prepare("UPDATE documents SET content_hash='v2'").run();
    expect(db.prepare("SELECT 1 FROM knowledge_changes").all()).toEqual([]);
    expect(db.prepare("SELECT 1 FROM knowledge_source_revisions").all()).toEqual([]);
  });
  it("maintains explicitly cited agent transcripts without discovering unused authored output", () => {
    const db = setup();
    const put = db.prepare(
      "INSERT INTO documents(id,source_id,provider_id,content_hash,content) VALUES(?,?,'system','v1','A fictional plan')",
    );
    put.run("cited-chat", OMNESIS_CHAT_SOURCE_ID);
    put.run("unused-chat", OMNESIS_CHAT_SOURCE_ID);
    expect(db.prepare("SELECT 1 FROM knowledge_changes").get()).toBeUndefined();
    const save = (revision: number, refs: string, inputVersions: Record<string, string>) =>
      saveKnowledgeNode(
        db,
        {
          id: "chat-project",
          kind: "wiki",
          title: "Fictional project",
          markdown: `<claim id="plan" refs="${refs}">A fictional plan</claim>`,
          expectedRevision: revision,
          inputVersions,
        },
        2 + revision,
      );
    save(0, "source:cited-chat", { "source:cited-chat": "v1" });
    db.prepare("UPDATE documents SET content_hash='v2',content='A revised fictional plan'").run();
    expect(
      db
        .prepare(
          "SELECT entity_id,revision FROM knowledge_changes WHERE kind='source_evidence_changed'",
        )
        .all(),
    ).toEqual([{ entity_id: "cited-chat", revision: "v2" }]);
    expect(getKnowledgeNode(db, "chat-project")?.validity).toBe("stale");
    advanceKnowledgeCascade(db, 100, 4);
    // Re-ground the current page elsewhere: deletion must also follow old revisions.
    put.run("replacement", "inbox");
    advanceKnowledgeCascade(db, 100, 5);
    save(getKnowledgeNode(db, "chat-project")!.revision, "source:replacement", {
      "source:replacement": "v1",
    });
    db.prepare("DELETE FROM documents WHERE id IN ('cited-chat','unused-chat')").run();
    expect(getKnowledgeNode(db, "chat-project")).toBeNull();
    expect(
      db.prepare("SELECT entity_id FROM knowledge_changes WHERE kind='source_deleted'").all(),
    ).toEqual([{ entity_id: "cited-chat" }, { entity_id: "unused-chat" }]);
    advanceKnowledgeCascade(db, 100, 6);
    expect(
      db.prepare("SELECT 1 FROM knowledge_nodes WHERE id='chat-project'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM knowledge_revisions WHERE node_id='chat-project'").get(),
    ).toBeUndefined();
  });
  it("purges prior source provenance even if the document is relabeled as a generated mirror", () => {
    const db = setup();
    db.prepare(
      "INSERT INTO documents(id,source_id,provider_id,content_hash,content) VALUES('relabeled','inbox','fictional','v1','Fictional evidence')",
    ).run();
    advanceKnowledgeCascade(db, 100, 1);
    saveKnowledgeNode(
      db,
      {
        id: "retained-page",
        kind: "wiki",
        title: "Project",
        markdown: '<claim id="c" refs="source:relabeled">Fictional evidence</claim>',
        expectedRevision: 0,
        inputVersions: { "source:relabeled": "v1" },
      },
      2,
    );
    db.prepare("UPDATE documents SET source_id=?,metadata=? WHERE id='relabeled'").run(
      KNOWLEDGE_SOURCE_ID,
      JSON.stringify({ documentType: KNOWLEDGE_DOCUMENT_TYPE }),
    );
    db.prepare("DELETE FROM documents WHERE id='relabeled'").run();
    expect(getKnowledgeNode(db, "retained-page")).toBeNull();
    advanceKnowledgeCascade(db, 100, 3);
    expect(
      db.prepare("SELECT 1 FROM knowledge_revisions WHERE node_id='retained-page'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM knowledge_nodes WHERE id='retained-page'").get(),
    ).toBeUndefined();
  });
  it("purges candidate-only transcript provenance one matched candidate per bounded step", () => {
    const db = setup();
    db.pragma("foreign_keys=ON");
    const put = db.prepare(
      "INSERT INTO documents(id,source_id,provider_id,content_hash,content) VALUES(?,?,'fixture','v1','Fictional planning context')",
    );
    put.run("candidate-chat", OMNESIS_CHAT_SOURCE_ID);
    put.run("unrelated-source", OMNESIS_CHAT_SOURCE_ID);
    for (let i = 0; i < 43; i++)
      proposeKnowledgeCandidate(
        db,
        {
          id: `candidate-${i}`,
          identityKey: `scope-${i}`,
          title: "Fictional project",
          scope: "Planning context",
          evidenceVersions: { [i < 3 ? "candidate-chat" : "unrelated-source"]: "v1" },
        },
        1,
      );
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidate_sources").get()).toEqual({
      n: 43,
    });
    db.prepare("DELETE FROM documents WHERE id='candidate-chat'").run();
    // Ingestion only fences/enqueues: it neither scans nor deletes candidate prose.
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get()).toEqual({ n: 43 });
    expect(getKnowledgeCandidate(db, "candidate-0")).toBeNull();
    expect(getKnowledgeCandidate(db, "candidate-3")).not.toBeNull();
    expect(advanceKnowledgeCascade(db, 1, 2).pending).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get()).toEqual({ n: 42 });
    expect(advanceKnowledgeCascade(db, 1, 3).pending).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get()).toEqual({ n: 41 });
    expect(advanceKnowledgeCascade(db, 100, 4).pending).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get()).toEqual({ n: 40 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidate_sources").get()).toEqual({
      n: 40,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
  it("resets a tombstone when an authorized source insertion restores the same identity", () => {
    const db = setup();
    const put = db.prepare(
      "INSERT INTO documents(id,source_id,provider_id,content_hash,content) VALUES('restored','inbox','fictional',?,'content')",
    );
    put.run("v1");
    db.prepare("DELETE FROM documents WHERE id='restored'").run();
    expect(() => put.run("v2")).toThrow("purge is still pending");
    expect(db.prepare("SELECT 1 FROM documents WHERE id='restored'").get()).toBeUndefined();
    advanceKnowledgeCascade(db, 100, 1);
    put.run("v2");
    expect(
      db
        .prepare(
          "SELECT content_hash,deleted FROM knowledge_source_revisions WHERE document_id='restored'",
        )
        .get(),
    ).toEqual({ content_hash: "v2", deleted: 0 });
  });
});
it("durably queues an in-flight projection that lands after its owner was purged", () => {
  const db = setup();
  db.exec("ALTER TABLE documents ADD COLUMN external_id TEXT");
  createKnowledgeSourceTriggers(db);
  db.prepare("INSERT INTO knowledge_node_tombstones VALUES('removed-page',1)").run();
  const upsert = db.prepare(
    `INSERT INTO documents(id,source_id,provider_id,external_id,content_hash,content)
     VALUES('late-mirror',?,'system','removed-page',?,'Old synthesis')
     ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash`,
  );
  upsert.run(KNOWLEDGE_SOURCE_ID, "v1");
  expect(() => upsert.run(KNOWLEDGE_SOURCE_ID, "v2")).not.toThrow();
  expect(db.prepare("SELECT document_id,node_id FROM knowledge_projection_cleanup").all()).toEqual([
    { document_id: "late-mirror", node_id: "removed-page" },
  ]);
  expect(db.prepare("SELECT 1 FROM knowledge_changes").get()).toBeUndefined();
});

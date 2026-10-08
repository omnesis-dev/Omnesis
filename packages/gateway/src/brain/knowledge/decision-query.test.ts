// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createCognitionDecisionsTable } from "../storage/decisions.js";
import { createKnowledgeDecisionTable, recordKnowledgeDecision } from "./decision-storage.js";
import {
  listKnowledgeDecisionAuditPage,
  listKnowledgeDecisionsForRun,
  listKnowledgeDecisionsForNode,
} from "./decision-query.js";
import { createKnowledgeTables, saveKnowledgeNode } from "./storage.js";
import { knowledgeHash } from "./storage-validation.js";

function fixture() {
  const db = new Database(":memory:");
  createKnowledgeDecisionTable(db);
  db.exec(`CREATE TABLE cognition_runs(id TEXT,last_attempt_at INTEGER,completed_at INTEGER);
    CREATE TABLE knowledge_batches(id TEXT,run_id TEXT);
    CREATE TABLE knowledge_frontier(batch_id TEXT,node_id TEXT,input_versions_json TEXT);
    CREATE TABLE documents(id TEXT PRIMARY KEY,content_hash TEXT,title TEXT,content TEXT,source_created_at TEXT,source_updated_at TEXT,source_id TEXT);
    CREATE TABLE knowledge_source_revisions(document_id TEXT,deleted INTEGER);
    CREATE TABLE knowledge_cascade_jobs(kind TEXT,target_kind TEXT,target_id TEXT);
    INSERT INTO cognition_runs VALUES('run_demo',100,200);
    INSERT INTO knowledge_batches VALUES('batch_demo','run_demo');
    INSERT INTO documents VALUES('doc_demo','version-a','Research memo','A detailed invented research result.','2026-01-01','2026-01-02','fixture-source');
    INSERT INTO knowledge_frontier VALUES('batch_demo','source:doc_demo','{"source:doc_demo":"version-a"}');`);
  const fingerprint = knowledgeHash({
    source: {
      title: "Research memo",
      content: "A detailed invented research result.",
      sourceCreatedAt: "2026-01-01",
      sourceUpdatedAt: "2026-01-02",
    },
  });
  const entry = {
    id: "decision_demo",
    purpose: "discovery" as const,
    inputFingerprint: fingerprint,
    score: 0.37,
    modelId: "scripted",
    latencyMs: 9,
    inputTokens: 40,
    rubricVersion: "knowledge-discovery-value-v3",
  };
  return { db, entry };
}

it("pages all judgement purposes including pre-run review metadata without fetching payloads", () => {
  const { db, entry } = fixture();
  try {
    for (const [index, purpose] of (
      ["discovery", "impact", "review", "urgency"] as const
    ).entries())
      recordKnowledgeDecision(db, { ...entry, id: `audit_${index}`, purpose }, 150);
    const first = listKnowledgeDecisionAuditPage(db, { limit: 2 });
    const second = listKnowledgeDecisionAuditPage(db, { limit: 2, cursor: first.nextCursor! });
    expect([...first.items, ...second.items].map((row) => row.purpose)).toEqual([
      "discovery",
      "impact",
      "review",
      "urgency",
    ]);
    expect(second.nextCursor).toBeNull();
    const reviews = listKnowledgeDecisionAuditPage(db, { purpose: "review", limit: 1 });
    expect(reviews.items).toMatchObject([
      { purpose: "review", association: "unassociated", runId: null, inputInspection: true },
    ]);
    expect(reviews.items[0]).not.toHaveProperty("input");
    expect(() =>
      listKnowledgeDecisionAuditPage(db, { purpose: "review", cursor: first.nextCursor! }),
    ).toThrow();
  } finally {
    db.close();
  }
});

it("keeps legacy judgements discoverable after run pruning and pages cross-ledger identity ties", () => {
  const { db, entry } = fixture();
  try {
    createCognitionDecisionsTable(db);
    recordKnowledgeDecision(db, { ...entry, id: "same_id" }, 150);
    const insert =
      db.prepare(`INSERT INTO cognition_decisions(id,run_id,document_id,subject_document_id,purpose,lane,rubric_version,requested_model_id,threshold,verdict,created_at,request_json)
      VALUES(?,'pruned_run','doc_demo','doc_demo',?,'background','fixture','scripted',1,'pass',150,'{"state":"Retained body must not enter metadata pages"}')`);
    insert.run("same_id", "worth-gate");
    insert.run("record_fixture", "record-check");
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = listKnowledgeDecisionAuditPage(db, { limit: 1, cursor });
      seen.push(...page.items.map((row) => `${row.kind}:${row.id}`));
      expect(JSON.stringify(page)).not.toContain("Retained body");
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["knowledge:same_id", "legacy:record_fixture", "legacy:same_id"]);
    const records = listKnowledgeDecisionAuditPage(db, { purpose: "record-check" });
    expect(records.items).toMatchObject([
      {
        kind: "legacy",
        runAvailable: false,
        inputInspection: true,
        scoreScale: "ordinal-0-3",
        subjectDocumentId: "doc_demo",
        subjectRef: {
          kind: "source",
          id: "doc_demo",
          title: "Research memo",
          sourceId: "fixture-source",
        },
      },
    ]);
    db.prepare("INSERT INTO knowledge_source_revisions VALUES('doc_demo',1)").run();
    expect(listKnowledgeDecisionAuditPage(db, { purpose: "worth-gate" }).items).toMatchObject([
      { subjectDocumentId: null, subjectRef: null },
    ]);
  } finally {
    db.close();
  }
});

describe("run synthesis decision audit", () => {
  it("returns explicit admission receipts separately, including unavailable and threshold recommendations", () => {
    const { db, entry } = fixture();
    try {
      recordKnowledgeDecision(
        db,
        {
          ...entry,
          runId: "run_demo",
          batchId: "batch_demo",
          nodeId: "source:doc_demo",
          threshold: 0.25,
        },
        150,
      );
      recordKnowledgeDecision(
        db,
        { ...entry, id: "unavailable", score: null, runId: "run_demo", threshold: 0.25 },
        160,
      );
      const result = listKnowledgeDecisionsForRun(db, "run_demo").items;
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        kind: "knowledge",
        association: "recorded",
        scoreScale: "normalized-0-1",
        recommendation: "inspect",
        score: 0.37,
        threshold: 0.25,
        nodeId: "source:doc_demo",
        inputTokens: 40,
      });
      expect(result[1]).toMatchObject({ recommendation: "unavailable", score: null });
      db.exec("INSERT INTO knowledge_source_revisions VALUES('doc_demo',1)");
      expect(listKnowledgeDecisionsForRun(db, "run_demo").items[0]!.nodeId).toBeNull();
    } finally {
      db.close();
    }
  });
  it("matches legacy discovery only with exact live content, retained version and unique run interval", () => {
    const { db, entry } = fixture();
    try {
      recordKnowledgeDecision(db, entry, 150);
      expect(listKnowledgeDecisionsForRun(db, "run_demo").items).toMatchObject([
        {
          association: "historical-matched",
          runId: "run_demo",
          batchId: "batch_demo",
          nodeId: "source:doc_demo",
          recommendation: "inspect",
        },
      ]);
      expect(db.prepare("SELECT run_id FROM knowledge_decisions").get()).toEqual({ run_id: null });
      db.exec("UPDATE documents SET content='Changed current evidence'");
      expect(listKnowledgeDecisionsForRun(db, "run_demo").items).toEqual([]);
      db.exec(
        "UPDATE documents SET content='A detailed invented research result.',content_hash='version-b'",
      );
      expect(listKnowledgeDecisionsForRun(db, "run_demo").items).toEqual([]);
      db.exec(`UPDATE documents SET content_hash='version-a';
        INSERT INTO cognition_runs VALUES('other_run',100,200);
        INSERT INTO knowledge_batches VALUES('other_batch','other_run');
        INSERT INTO knowledge_frontier VALUES('other_batch','source:doc_demo','{"source:doc_demo":"version-a"}');`);
      expect(listKnowledgeDecisionsForRun(db, "run_demo").items).toEqual([]);
    } finally {
      db.close();
    }
  });
  it("refuses identical model states from different source IDs in overlapping runs", () => {
    const { db, entry } = fixture();
    try {
      recordKnowledgeDecision(db, entry, 150);
      db.exec(`INSERT INTO cognition_runs VALUES('other_run',100,200);
        INSERT INTO knowledge_batches VALUES('other_batch','other_run');
        INSERT INTO documents SELECT 'other_doc',content_hash,title,content,source_created_at,source_updated_at,source_id FROM documents;
        INSERT INTO knowledge_frontier VALUES('other_batch','source:other_doc','{"source:other_doc":"version-a"}');`);
      const result = listKnowledgeDecisionsForRun(db, "run_demo");
      expect(result.items).toEqual([]);
      expect(result.legacyIncomplete).toBe(true);
    } finally {
      db.close();
    }
  });

  it("does not confuse unchanged oversized sources that the legacy gate bypassed with possible decision owners", () => {
    const { db, entry } = fixture();
    try {
      recordKnowledgeDecision(db, entry, 150);
      db.exec(`INSERT INTO cognition_runs VALUES('large_run',100,200);
        INSERT INTO knowledge_batches VALUES('large_batch','large_run');
        INSERT INTO knowledge_frontier VALUES('large_batch','source:large_doc','{"source:large_doc":"large-version"}');`);
      db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?)").run(
        "large_doc",
        "large-version",
        "Long invented report",
        "Detail. ".repeat(4000),
        "2026-01-01",
        "2026-01-02",
        "fixture-source",
      );
      expect(listKnowledgeDecisionsForRun(db, "run_demo").items).toHaveLength(1);
      db.exec("UPDATE documents SET content_hash='changed-version' WHERE id='large_doc'");
      const uncertain = listKnowledgeDecisionsForRun(db, "run_demo");
      expect(uncertain.items).toEqual([]);
      expect(uncertain.legacyIncomplete).toBe(true);
    } finally {
      db.close();
    }
  });

  it("reports response caps and incomplete legacy association explicitly", () => {
    const { db, entry } = fixture();
    try {
      for (let i = 0; i < 501; i++)
        recordKnowledgeDecision(
          db,
          { ...entry, id: `bounded-${i}`, runId: "run_demo", threshold: 0.25 },
          150,
        );
      const result = listKnowledgeDecisionsForRun(db, "run_demo");
      expect(result.items).toHaveLength(500);
      expect(result.truncated).toBe(true);
      recordKnowledgeDecision(db, { ...entry, id: "unknown", rubricVersion: "unrecognized" }, 150);
      expect(listKnowledgeDecisionsForRun(db, "run_demo").legacyIncomplete).toBe(true);
    } finally {
      db.close();
    }
  });

  it("does not infer ongoing, out-of-interval, different rubric or hidden legacy events", () => {
    const { db, entry } = fixture();
    try {
      recordKnowledgeDecision(db, entry, 99);
      recordKnowledgeDecision(db, { ...entry, id: "different", rubricVersion: "unknown" }, 150);
      expect(listKnowledgeDecisionsForRun(db, "run_demo").items).toEqual([]);
      recordKnowledgeDecision(db, { ...entry, id: "eligible" }, 150);
      db.exec("UPDATE cognition_runs SET completed_at=NULL");
      expect(listKnowledgeDecisionsForRun(db, "run_demo").items).toEqual([]);
      db.exec(
        "UPDATE cognition_runs SET completed_at=200;INSERT INTO knowledge_source_revisions VALUES('doc_demo',1)",
      );
      expect(listKnowledgeDecisionsForRun(db, "run_demo").items).toEqual([]);
    } finally {
      db.close();
    }
  });
});

it("bounds node review history, preserves current subject identity, and refuses hidden nodes", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
    createKnowledgeTables(db);
    createKnowledgeDecisionTable(db);
    saveKnowledgeNode(
      db,
      {
        id: "wiki_workshop",
        kind: "wiki",
        title: "Community workshop",
        expectedRevision: 0,
        inputVersions: {},
        markdown: "Draft overview.",
      },
      1,
    );
    for (let i = 0; i < 52; i++)
      recordKnowledgeDecision(
        db,
        {
          id: `review_${i}`,
          nodeId: "wiki_workshop",
          purpose: "review",
          inputFingerprint: "fixture",
          score: 0.5,
          modelId: "scripted",
          latencyMs: 1,
          inputTokens: 2,
          rubricVersion: "fixture",
        },
        i + 2,
      );
    recordKnowledgeDecision(
      db,
      {
        id: "unrelated",
        nodeId: "wiki_workshop",
        purpose: "impact",
        inputFingerprint: "fixture",
        score: 0.5,
        modelId: "scripted",
        latencyMs: 1,
        inputTokens: 2,
        rubricVersion: "fixture",
      },
      100,
    );
    const page = listKnowledgeDecisionsForNode(db, "wiki_workshop");
    expect(page.items).toHaveLength(50);
    expect(page.truncated).toBe(true);
    expect(page.items[0]).toMatchObject({
      id: "review_51",
      subjectRef: { id: "wiki_workshop", title: "Community workshop", kind: "wiki" },
    });
    db.prepare(
      "INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('wiki_workshop',200)",
    ).run();
    expect(() => listKnowledgeDecisionsForNode(db, "wiki_workshop")).toThrow("not found");
  } finally {
    db.close();
  }
});

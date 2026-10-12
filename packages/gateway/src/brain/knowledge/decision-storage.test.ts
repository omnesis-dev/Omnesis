// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createKnowledgeDecisionTable, recordKnowledgeDecision } from "./decision-storage.js";

it("idempotently upgrades legacy audit rows without inventing associations", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE knowledge_decisions(id TEXT PRIMARY KEY,purpose TEXT,input_fingerprint TEXT,
      score REAL,model_id TEXT,latency_ms INTEGER,input_tokens INTEGER,rubric_version TEXT,created_at INTEGER);
      INSERT INTO knowledge_decisions VALUES('old','discovery','hash',.4,'scripted',5,7,'legacy',10)`);
    createKnowledgeDecisionTable(db);
    createKnowledgeDecisionTable(db);
    expect(
      db
        .prepare("SELECT run_id,batch_id,node_id,threshold FROM knowledge_decisions WHERE id='old'")
        .get(),
    ).toEqual({ run_id: null, batch_id: null, node_id: null, threshold: null });
    recordKnowledgeDecision(
      db,
      {
        id: "new",
        purpose: "impact",
        inputFingerprint: "current",
        score: 0.2,
        modelId: "scripted",
        latencyMs: 2,
        inputTokens: 3,
        rubricVersion: "current",
        runId: "run_demo",
        batchId: "batch_demo",
        nodeId: "wiki_demo",
        threshold: 0.25,
      },
      20,
    );
    expect(
      db
        .prepare(
          "SELECT run_id,batch_id,node_id,threshold,score FROM knowledge_decisions WHERE id='new'",
        )
        .get(),
    ).toEqual({
      run_id: "run_demo",
      batch_id: "batch_demo",
      node_id: "wiki_demo",
      threshold: 0.25,
      score: 0.2,
    });
  } finally {
    db.close();
  }
});

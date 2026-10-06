// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
import type { KnowledgeDecisionPurpose } from "./decision.js";
export interface KnowledgeDecisionAudit {
  id: string;
  purpose: KnowledgeDecisionPurpose;
  inputFingerprint: string;
  score: number | null;
  modelId: string;
  latencyMs: number;
  inputTokens: number | null;
  rubricVersion: string;
}
/** Audit scheduling decisions without retaining source prose in a second ledger. */
export function createKnowledgeDecisionTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_decisions (
    id TEXT PRIMARY KEY,purpose TEXT NOT NULL,input_fingerprint TEXT NOT NULL,score REAL,
    model_id TEXT NOT NULL,latency_ms INTEGER NOT NULL,input_tokens INTEGER,rubric_version TEXT NOT NULL,created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS knowledge_decision_time ON knowledge_decisions(created_at,id);`);
}
export function recordKnowledgeDecision(
  db: Database.Database,
  input: KnowledgeDecisionAudit,
  now: number,
): void {
  db.prepare(
    `INSERT INTO knowledge_decisions(id,purpose,input_fingerprint,score,model_id,latency_ms,input_tokens,rubric_version,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    input.id,
    input.purpose,
    input.inputFingerprint,
    input.score,
    input.modelId,
    input.latencyMs,
    input.inputTokens,
    input.rubricVersion,
    now,
  );
}

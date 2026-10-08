// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { recordDecisionPayload } from "../decision-payload.js";
import {
  createKnowledgeDecisionDebugTables,
  recordKnowledgeDecisionPayload,
  type KnowledgeDecisionPayload,
} from "./decision-debug.js";
import type Database from "better-sqlite3";
import type { KnowledgeDecisionPurpose, KnowledgeDecisionAssociation } from "./decision.js";
export interface KnowledgeDecisionAudit extends KnowledgeDecisionAssociation {
  id: string;
  payload?: KnowledgeDecisionPayload;
  purpose: KnowledgeDecisionPurpose;
  inputFingerprint: string;
  score: number | null;
  modelId: string;
  latencyMs: number;
  inputTokens: number | null;
  rubricVersion: string;
}
/** Metadata is durable; optional exact request/result snapshots use a separately erased store. */
export function createKnowledgeDecisionTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_decisions (
    id TEXT PRIMARY KEY,purpose TEXT NOT NULL,input_fingerprint TEXT NOT NULL,score REAL,
    model_id TEXT NOT NULL,latency_ms INTEGER NOT NULL,input_tokens INTEGER,rubric_version TEXT NOT NULL,created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS knowledge_decision_time ON knowledge_decisions(created_at,id);`);
  const columns = new Set(
    db
      .prepare<[], { name: string }>("PRAGMA table_info(knowledge_decisions)")
      .all()
      .map((row) => row.name),
  );
  for (const [name, type] of [
    ["run_id", "TEXT"],
    ["batch_id", "TEXT"],
    ["node_id", "TEXT"],
    ["threshold", "REAL"],
    ["work_id", "TEXT"],
    ["source_revision", "TEXT"],
    ["scheduling_json", "TEXT"],
  ] as const)
    if (!columns.has(name)) db.exec(`ALTER TABLE knowledge_decisions ADD COLUMN ${name} ${type}`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS knowledge_decision_run ON knowledge_decisions(run_id,created_at,id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS knowledge_decision_legacy ON knowledge_decisions(purpose,input_fingerprint,created_at,id) WHERE run_id IS NULL",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS knowledge_decision_work ON knowledge_decisions(work_id,created_at,id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS knowledge_decision_node ON knowledge_decisions(node_id,created_at DESC,id)",
  );
  createKnowledgeDecisionDebugTables(db);
}
export function recordKnowledgeDecision(
  db: Database.Database,
  input: KnowledgeDecisionAudit,
  now: number,
): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO knowledge_decisions(id,purpose,input_fingerprint,score,model_id,latency_ms,input_tokens,rubric_version,created_at,run_id,batch_id,node_id,threshold,source_revision,scheduling_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      input.runId ?? null,
      input.batchId ?? null,
      input.nodeId ?? null,
      input.threshold ?? null,
      input.urgencyCapture?.inputRevision ?? null,
      input.urgencyCapture
        ? JSON.stringify({ version: 1, status: "unscheduled", policy: input.urgencyCapture.policy })
        : null,
    );
    if (input.purpose === "urgency" && input.urgencyCapture && input.payload)
      recordKnowledgeDecisionPayload(db, input.id, input.urgencyCapture, input.payload, now);
    else if (input.payloadCapture && input.payload)
      recordDecisionPayload(db, input.id, input.payloadCapture, input.payload, now);
  })();
}

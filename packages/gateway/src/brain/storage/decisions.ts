// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The decision ledger: one row per typed decision the Brain asked of the
 * decision model, keyed to the run it was asked for.
 *
 * It is the audit trail of the worth gate — the exact request sent (state and
 * questions), the answers, the score, the threshold, the verdict, the model and
 * the latency — so `/debug/cognition/runs` can show what the decision model
 * did for a run even when it stopped the run before any agent turn. A
 * worth-gate call that returns a score is also recorded as the email's shared
 * worth answer (`worth/answers.ts`); a later decision that reuses a stored
 * answer names it in `reused_from` instead of paying for a second call.
 *
 * Attachments are judged by their parent email: `document_id` is the run's own
 * document, `subject_document_id` the one that was actually scored. Both
 * cascade: deleting a document deletes every judgement that quotes it.
 * Past the activity-retention window the request and answer text is cleared
 * (see the `cognitionDecisions` retention phase); verdicts and scores stay.
 */

import { recordWorthAnswers } from "../../worth/answers.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export type DecisionVerdict = "pass" | "skip" | "unavailable";

/**
 * What a decision was asked for: `worth-gate` judges a run's document before
 * the run, `record-check` a record a run is about to save.
 */
export type DecisionPurpose = "worth-gate" | "record-check";

export interface CognitionDecisionRecord {
  id: string;
  runId: string;
  documentId: string;
  subjectDocumentId: string;
  purpose: DecisionPurpose;
  lane: string;
  rubricVersion: string;
  contentHash: string | null;
  /** The model the gate asked (the assignment's pinned id); keys reuse. */
  requestedModelId: string;
  /** The model that answered, as the backend reported it. */
  modelId: string | null;
  requestJson: string | null;
  responseJson: string | null;
  score: number | null;
  threshold: number;
  verdict: DecisionVerdict;
  error: string | null;
  reusedFrom: string | null;
  /**
   * The Brain record the decision was about (an annotation id), when it judged
   * a record rather than a document; null for document judgements.
   */
  recordId: string | null;
  /**
   * Whether the check acts on its verdicts: false for a record check in shadow
   * mode, whose skip never stopped anything. A worth-gate decision always is.
   */
  enforced: boolean;
  latencyMs: number | null;
  inputTokens: number | null;
  createdAt: number;
}

export function createCognitionDecisionsTable(db: Db): void {
  db.exec(COGNITION_DECISIONS_DDL);
  for (const statement of COGNITION_DECISIONS_INDEXES) db.exec(statement);
}

const COGNITION_DECISIONS_DDL = `
  CREATE TABLE IF NOT EXISTS cognition_decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    subject_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    lane TEXT NOT NULL,
    rubric_version TEXT NOT NULL,
    content_hash TEXT,
    requested_model_id TEXT NOT NULL,
    model_id TEXT,
    score REAL,
    threshold REAL NOT NULL,
    verdict TEXT NOT NULL,
    error TEXT,
    reused_from TEXT,
    record_id TEXT,
    enforced INTEGER NOT NULL DEFAULT 1,
    latency_ms INTEGER,
    input_tokens INTEGER,
    created_at INTEGER NOT NULL,
    -- The audit text, last so reads of the small columns stay on the row's
    -- first page; retention clears it after the activity window.
    request_json TEXT,
    response_json TEXT
  )
`;

const COGNITION_DECISIONS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_cognition_decisions_run ON cognition_decisions(run_id)",
  // The reuse lookup: newest answered decision for a subject under one rubric.
  "CREATE INDEX IF NOT EXISTS idx_cognition_decisions_subject ON cognition_decisions(subject_document_id, rubric_version, created_at DESC)",
  // Bootstrap coverage bands read the newest worth-gate verdict per document;
  // covering, so the lookup never touches the audit text.
  "CREATE INDEX IF NOT EXISTS idx_cognition_decisions_document ON cognition_decisions(document_id, purpose, created_at DESC, verdict)",
  // Retention walks old rows by age.
  "CREATE INDEX IF NOT EXISTS idx_cognition_decisions_created ON cognition_decisions(created_at)",
];

interface DecisionRow {
  id: string;
  run_id: string;
  document_id: string;
  subject_document_id: string;
  purpose: string;
  lane: string;
  rubric_version: string;
  content_hash: string | null;
  requested_model_id: string;
  model_id: string | null;
  request_json: string | null;
  response_json: string | null;
  score: number | null;
  threshold: number;
  verdict: string;
  error: string | null;
  reused_from: string | null;
  record_id: string | null;
  enforced: number;
  latency_ms: number | null;
  input_tokens: number | null;
  created_at: number;
}

function fromRow(row: DecisionRow): CognitionDecisionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    documentId: row.document_id,
    subjectDocumentId: row.subject_document_id,
    purpose: row.purpose as DecisionPurpose,
    lane: row.lane,
    rubricVersion: row.rubric_version,
    contentHash: row.content_hash,
    requestedModelId: row.requested_model_id,
    modelId: row.model_id,
    requestJson: row.request_json,
    responseJson: row.response_json,
    score: row.score,
    threshold: row.threshold,
    verdict: row.verdict as DecisionVerdict,
    error: row.error,
    reusedFrom: row.reused_from,
    recordId: row.record_id,
    enforced: row.enforced === 1,
    latencyMs: row.latency_ms,
    inputTokens: row.input_tokens,
    createdAt: row.created_at,
  };
}

/**
 * Writer side: append one decision. Idempotent on `id`. A worth-gate call
 * that returned a score becomes the email's shared worth answer in the same
 * transaction.
 */
export function insertCognitionDecision(db: Db, record: CognitionDecisionRecord): void {
  db.transaction(() => {
    insertDecisionRow(db, record);
    if (
      record.purpose === "worth-gate" &&
      record.score !== null &&
      record.reusedFrom === null &&
      record.contentHash !== null
    ) {
      recordWorthAnswers(db, [
        {
          id: record.id,
          subjectDocumentId: record.subjectDocumentId,
          contentHash: record.contentHash,
          rubricVersion: record.rubricVersion,
          requestedModelId: record.requestedModelId,
          modelId: record.modelId ?? record.requestedModelId,
          score: record.score,
          answeredAt: record.createdAt,
        },
      ]);
    }
  })();
}

function insertDecisionRow(db: Db, record: CognitionDecisionRecord): void {
  db.prepare(
    `INSERT INTO cognition_decisions (
       id, run_id, document_id, subject_document_id, purpose, lane, rubric_version,
       content_hash, requested_model_id, model_id, request_json, response_json, score,
       threshold, verdict, error, reused_from, record_id, enforced, latency_ms, input_tokens,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    record.id,
    record.runId,
    record.documentId,
    record.subjectDocumentId,
    record.purpose,
    record.lane,
    record.rubricVersion,
    record.contentHash,
    record.requestedModelId,
    record.modelId,
    record.requestJson,
    record.responseJson,
    record.score,
    record.threshold,
    record.verdict,
    record.error,
    record.reusedFrom,
    record.recordId,
    record.enforced ? 1 : 0,
    record.latencyMs,
    record.inputTokens,
    record.createdAt,
  );
}

/** The decisions made for one run, oldest first. */
export function listDecisionsForRun(db: Db, runId: string): CognitionDecisionRecord[] {
  return db
    .prepare<
      [string],
      DecisionRow
    >(`SELECT * FROM cognition_decisions WHERE run_id = ? ORDER BY created_at, id`)
    .all(runId)
    .map(fromRow);
}

/** The worth-gate verdict of each listed run that has one (the newest wins). */
export function decisionVerdictsForRuns(
  db: Db,
  runIds: readonly string[],
): Map<string, DecisionVerdict> {
  const out = new Map<string, DecisionVerdict>();
  if (runIds.length === 0) return out;
  const rows = db
    .prepare<string[], { run_id: string; verdict: string }>(
      `SELECT run_id, verdict FROM cognition_decisions
        WHERE run_id IN (${runIds.map(() => "?").join(",")}) AND purpose = 'worth-gate'
        ORDER BY created_at`,
    )
    .all(...runIds);
  for (const row of rows) out.set(row.run_id, row.verdict as DecisionVerdict);
  return out;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The decision model's answers to the email worth rubric, one per email
 * content: every gate that asks the rubric looks here before asking and
 * records here after, so an email is sent to the decision model once however
 * many gates need its verdict.
 *
 * An answer is keyed by the email, its content hash, the rubric version and
 * the model the gate requested; any change to one of them is a different
 * question. It carries only the score — each gate turns the score into its own
 * verdict at the rubric's threshold and keeps its own record of why.
 *
 * Deleting the email deletes its answers.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

export interface WorthAnswer {
  /** The asking gate's id for the call (the Brain's decision id, when the Brain asked). */
  id: string;
  subjectDocumentId: string;
  contentHash: string;
  rubricVersion: string;
  /** The model the gate asked for; keys the answer. */
  requestedModelId: string;
  /** The model that answered, as the backend reported it. */
  modelId: string;
  score: number;
  answeredAt: number;
}

export interface WorthQuestion {
  subjectDocumentId: string;
  contentHash: string;
  rubricVersion: string;
  requestedModelId: string;
}

/** Idempotent DDL for the answer table. */
export function createWorthAnswersTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worth_answers (
      subject_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      rubric_version TEXT NOT NULL,
      requested_model_id TEXT NOT NULL,
      id TEXT NOT NULL UNIQUE,
      model_id TEXT NOT NULL,
      score REAL NOT NULL,
      answered_at INTEGER NOT NULL,
      PRIMARY KEY (subject_document_id, content_hash, rubric_version, requested_model_id)
    )
  `);
}

interface AnswerRow {
  id: string;
  subject_document_id: string;
  content_hash: string;
  rubric_version: string;
  requested_model_id: string;
  model_id: string;
  score: number;
  answered_at: number;
}

/** The stored answer to exactly this question, or null. Served by the primary key. */
export function findWorthAnswer(db: Db, question: WorthQuestion): WorthAnswer | null {
  const row = db
    .prepare<[string, string, string, string], AnswerRow>(
      `SELECT * FROM worth_answers
        WHERE subject_document_id = ? AND content_hash = ? AND rubric_version = ?
          AND requested_model_id = ?`,
    )
    .get(
      question.subjectDocumentId,
      question.contentHash,
      question.rubricVersion,
      question.requestedModelId,
    );
  return row
    ? {
        id: row.id,
        subjectDocumentId: row.subject_document_id,
        contentHash: row.content_hash,
        rubricVersion: row.rubric_version,
        requestedModelId: row.requested_model_id,
        modelId: row.model_id,
        score: row.score,
        answeredAt: row.answered_at,
      }
    : null;
}

/**
 * Record answers. The first answer to a question stands: two gates that asked
 * at once keep the one recorded first, so every reuse points at one answer. An
 * answer for an email deleted since it was asked is dropped.
 */
export function recordWorthAnswers(db: Db, answers: readonly WorthAnswer[]): void {
  const insert = db.prepare(
    `INSERT INTO worth_answers
       (subject_document_id, content_hash, rubric_version, requested_model_id, id, model_id,
        score, answered_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM documents WHERE id = ?)
     ON CONFLICT DO NOTHING`,
  );
  db.transaction(() => {
    for (const a of answers) {
      insert.run(
        a.subjectDocumentId,
        a.contentHash,
        a.rubricVersion,
        a.requestedModelId,
        a.id,
        a.modelId,
        a.score,
        a.answeredAt,
        a.subjectDocumentId,
      );
    }
  })();
}

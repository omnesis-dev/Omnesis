// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Storage for the mention worth gate: one row per document that carries a
 * date mention, holding whether the decision model judged its email worth
 * recording.
 *
 * - Extraction writes a `pending` row for every document it leaves with at
 *   least one mention, and removes the row when it leaves none, so the gate's
 *   work queue is exactly the mention-bearing documents not yet judged. Each
 *   queueing bumps the row's `generation`, and a verdict settles only the
 *   generation it was fetched for: an answer about content that has since
 *   changed is discarded.
 * - The gate settles a row as `keep` or `drop` (a score against the email
 *   worth rubric) or `exempt` (not an email, or carrying structured booking
 *   dates, so never judged). A row it cannot settle yet — the model failed,
 *   or an attachment's email has not arrived — waits with a growing backoff.
 * - A row judged under another rubric version returns to `pending`, as does
 *   an attachment whose email was judged again for new content.
 *
 * The temporal query hides the mentions of a `drop` document only while the
 * gate is active; the rows themselves never change what is stored.
 */

import { documentsMetadataCodec } from "../../data/json-columns.js";
import { resolveContainingDocument } from "../../domain/LinkGraphService.js";
import { findReusableDecision } from "../../brain/storage/decisions.js";
import {
  EMAIL_BODY_CHARS,
  WORTH_GATED_DOCUMENT_TYPE,
  emailWorthState,
  hasStructuredDate,
  type EmailWorthState,
} from "../../brain/worth-gate/rubric.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export type MentionJudgementVerdict = "pending" | "keep" | "drop" | "exempt";

/** Idempotent DDL for the judgement table and its indexes. */
export function createMentionJudgementsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS date_mention_judgements (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL CHECK (verdict IN ('pending', 'keep', 'drop', 'exempt')),
      generation INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      subject_document_id TEXT,
      content_hash TEXT,
      rubric_version TEXT,
      requested_model_id TEXT,
      model_id TEXT,
      score REAL,
      reused_decision_id TEXT,
      reused_document_id TEXT,
      input_tokens INTEGER,
      judged_at INTEGER
    )
  `);
  // The work queue, in the order the gate takes it.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_date_mention_judgements_pending
       ON date_mention_judgements(next_attempt_at) WHERE verdict = 'pending'`,
  );
  // Scored rows by their email: the same-email reuse and the attachment requeue.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_date_mention_judgements_subject
       ON date_mention_judgements(subject_document_id, content_hash)
       WHERE verdict IN ('keep', 'drop')`,
  );
  // Scored rows by rubric: the requeue after a rubric change.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_date_mention_judgements_rubric
       ON date_mention_judgements(rubric_version) WHERE verdict IN ('keep', 'drop')`,
  );
}

/**
 * SQL that is true when the document behind `column` was judged not worth
 * recording. Served by the table's primary key.
 */
export function judgedNotWorthSql(column: string): string {
  return `EXISTS (SELECT 1 FROM date_mention_judgements j
                   WHERE j.document_id = ${column} AND j.verdict = 'drop')`;
}

interface Queued {
  documentId: string;
  /** The queueing this item was fetched for; a verdict settles only this one. */
  generation: number;
  attempts: number;
}

/** A pending document, resolved to what the gate judges it by. */
export type PendingMentionJudgement =
  | (Queued & { kind: "exempt"; subjectDocumentId: string | null })
  /** An attachment whose email has not arrived: judged once it has. */
  | (Queued & { kind: "wait" })
  | (Queued & {
      kind: "reuse";
      subjectDocumentId: string;
      contentHash: string;
      score: number;
      modelId: string;
      /** The Brain worth gate decision the answer came from. */
      reusedDecisionId: string | null;
      /** The document whose judgement the answer came from; null for the document's own. */
      reusedDocumentId: string | null;
    })
  | (Queued & {
      kind: "ask";
      subjectDocumentId: string;
      contentHash: string;
      state: EmailWorthState;
    });

interface PendingRow {
  document_id: string;
  generation: number;
  attempts: number;
  content_hash: string | null;
  rubric_version: string | null;
  requested_model_id: string | null;
  score: number | null;
}

interface DocHead {
  id: string;
  content_hash: string;
  metadata: string;
}

/**
 * Fetch up to `limit` pending documents due by `now` and resolve each to its
 * subject — the email itself, or the email an attachment belongs to — and to
 * an exemption, an answer to reuse, or the state to ask about. Runs on the io
 * pool's read-only handle.
 *
 * An answer is reused, for the same subject content, rubric and requested
 * model, from the document's own earlier judgement, from the Brain's worth
 * gate, or from another document judged by the same email.
 */
export function fetchPendingMentionJudgements(
  db: Db,
  limit: number,
  rubricVersion: string,
  modelId: string,
  now: number,
): PendingMentionJudgement[] {
  const pending = db
    .prepare<[number, number], PendingRow>(
      `SELECT document_id, generation, attempts, content_hash, rubric_version,
              requested_model_id, score
         FROM date_mention_judgements
        WHERE verdict = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at LIMIT ?`,
    )
    .all(now, limit);
  const readHead = db.prepare<[string], DocHead>(
    "SELECT id, content_hash, metadata FROM documents WHERE id = ?",
  );
  const readBody = db.prepare<[number, string], { title: string | null; content: string | null }>(
    "SELECT title, substr(content, 1, ?) AS content FROM documents WHERE id = ?",
  );
  const judgedBySubject = db.prepare<
    [string, string, string, string],
    { document_id: string; score: number; model_id: string }
  >(
    `SELECT document_id, score, model_id FROM date_mention_judgements
      WHERE subject_document_id = ? AND content_hash = ? AND verdict IN ('keep', 'drop')
        AND rubric_version = ? AND requested_model_id = ?
        AND reused_decision_id IS NULL AND reused_document_id IS NULL
      LIMIT 1`,
  );

  const out: PendingMentionJudgement[] = [];
  for (const row of pending) {
    const queued: Queued = {
      documentId: row.document_id,
      generation: row.generation,
      attempts: row.attempts,
    };
    const doc = readHead.get(row.document_id);
    if (!doc) continue;
    const ownMeta = metadataOf(doc);
    // A document's own booking dates exempt it before its email is consulted.
    if (hasStructuredDate(ownMeta)) {
      out.push({ ...queued, kind: "exempt", subjectDocumentId: null });
      continue;
    }
    let subject: DocHead | undefined = doc;
    let meta = ownMeta;
    if (meta.documentType !== WORTH_GATED_DOCUMENT_TYPE) {
      const containment = resolveContainingDocument(db, doc.id);
      if (containment.kind === "orphan") {
        out.push({ ...queued, kind: "wait" });
        continue;
      }
      subject =
        containment.kind === "contained" ? readHead.get(containment.parentDocumentId) : undefined;
      meta = subject ? metadataOf(subject) : {};
    }
    if (!subject || meta.documentType !== WORTH_GATED_DOCUMENT_TYPE || hasStructuredDate(meta)) {
      out.push({ ...queued, kind: "exempt", subjectDocumentId: subject?.id ?? null });
      continue;
    }
    const scored = { subjectDocumentId: subject.id, contentHash: subject.content_hash };
    if (
      row.score !== null &&
      row.content_hash === subject.content_hash &&
      row.rubric_version === rubricVersion &&
      row.requested_model_id === modelId
    ) {
      out.push({
        ...queued,
        ...scored,
        kind: "reuse",
        score: row.score,
        modelId,
        reusedDecisionId: null,
        reusedDocumentId: null,
      });
      continue;
    }
    const brain = findReusableDecision(
      db,
      subject.id,
      rubricVersion,
      subject.content_hash,
      modelId,
    );
    if (brain?.score != null) {
      out.push({
        ...queued,
        ...scored,
        kind: "reuse",
        score: brain.score,
        modelId: brain.modelId ?? modelId,
        reusedDecisionId: brain.id,
        reusedDocumentId: null,
      });
      continue;
    }
    const own = judgedBySubject.get(subject.id, subject.content_hash, rubricVersion, modelId);
    if (own && own.document_id !== row.document_id) {
      out.push({
        ...queued,
        ...scored,
        kind: "reuse",
        score: own.score,
        modelId: own.model_id,
        reusedDecisionId: null,
        reusedDocumentId: own.document_id,
      });
      continue;
    }
    const body = readBody.get(EMAIL_BODY_CHARS, subject.id);
    out.push({
      ...queued,
      ...scored,
      kind: "ask",
      state: emailWorthState({
        title: body?.title ?? null,
        content: body?.content ?? null,
        metadata: meta,
      }),
    });
  }
  return out;
}

/** One settled judgement, as the writer stores it. */
export interface MentionJudgementRecord {
  documentId: string;
  generation: number;
  verdict: Exclude<MentionJudgementVerdict, "pending">;
  subjectDocumentId: string | null;
  contentHash: string | null;
  rubricVersion: string | null;
  requestedModelId: string | null;
  modelId: string | null;
  score: number | null;
  reusedDecisionId: string | null;
  reusedDocumentId: string | null;
  inputTokens: number | null;
  judgedAt: number;
}

/** A pending document to try again later. */
export interface MentionJudgementDeferral {
  documentId: string;
  generation: number;
  nextAttemptAt: number;
}

/**
 * Settle judgements and push back the ones that must wait. A row changes only
 * while it is still pending at the generation the gate fetched: a document
 * re-extracted meanwhile is judged again for its new content, and one that
 * lost its mentions has no row.
 *
 * Settling an email's own fresh answer returns its attachments judged for
 * earlier content to the queue, so they follow the email's current verdict.
 */
export function applyMentionJudgements(
  db: Db,
  records: readonly MentionJudgementRecord[],
  deferrals: readonly MentionJudgementDeferral[] = [],
): number {
  const settle = db.prepare(
    `UPDATE date_mention_judgements
        SET verdict = ?, subject_document_id = ?, content_hash = ?, rubric_version = ?,
            requested_model_id = ?, model_id = ?, score = ?, reused_decision_id = ?,
            reused_document_id = ?, input_tokens = ?, judged_at = ?, attempts = 0,
            next_attempt_at = 0
      WHERE document_id = ? AND verdict = 'pending' AND generation = ?`,
  );
  const requeueAttachments = db.prepare(
    `UPDATE date_mention_judgements
        SET verdict = 'pending', generation = generation + 1, next_attempt_at = 0
      WHERE subject_document_id = ? AND content_hash IS NOT ? AND verdict IN ('keep', 'drop')
        AND document_id <> ?`,
  );
  const defer = db.prepare(
    `UPDATE date_mention_judgements SET attempts = attempts + 1, next_attempt_at = ?
      WHERE document_id = ? AND verdict = 'pending' AND generation = ?`,
  );
  let settled = 0;
  db.transaction(() => {
    for (const r of records) {
      const changed = settle.run(
        r.verdict,
        r.subjectDocumentId,
        r.contentHash,
        r.rubricVersion,
        r.requestedModelId,
        r.modelId,
        r.score,
        r.reusedDecisionId,
        r.reusedDocumentId,
        r.inputTokens,
        r.judgedAt,
        r.documentId,
        r.generation,
      ).changes;
      settled += changed;
      const freshOwnAnswer =
        changed > 0 &&
        r.subjectDocumentId === r.documentId &&
        r.score !== null &&
        r.reusedDecisionId === null &&
        r.reusedDocumentId === null;
      if (freshOwnAnswer) requeueAttachments.run(r.documentId, r.contentHash, r.documentId);
    }
    for (const d of deferrals) defer.run(d.nextAttemptAt, d.documentId, d.generation);
  })();
  return settled;
}

/**
 * Return up to `limit` judgements made under another rubric version to the
 * queue. The gate calls it until it returns fewer than `limit`, so a rubric
 * change never rewrites the whole table in one writer transaction.
 */
export function requeueStaleMentionJudgements(
  db: Db,
  rubricVersion: string,
  limit: number,
): number {
  return db
    .prepare(
      `UPDATE date_mention_judgements
          SET verdict = 'pending', generation = generation + 1, next_attempt_at = 0
        WHERE document_id IN (
          SELECT document_id FROM date_mention_judgements
           WHERE verdict IN ('keep', 'drop') AND rubric_version IS NOT ?
           LIMIT ?)`,
    )
    .run(rubricVersion, limit).changes;
}

/** Documents with a mention still waiting for a judgement. */
export function countPendingMentionJudgements(db: Db): number {
  return (
    db
      .prepare<
        [],
        { n: number }
      >(`SELECT COUNT(*) AS n FROM date_mention_judgements WHERE verdict = 'pending'`)
      .get()?.n ?? 0
  );
}

function metadataOf(doc: DocHead): Record<string, unknown> {
  return documentsMetadataCodec.parseWithFallback(doc.metadata, { rowId: doc.id }) as Record<
    string,
    unknown
  >;
}

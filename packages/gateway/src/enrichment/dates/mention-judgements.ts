// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Storage for the mention worth gate: one row per document that carries a
 * date mention, holding whether its email was judged worth recording.
 *
 * - Extraction writes a `pending` row for every document it leaves with at
 *   least one mention, and removes the row when it leaves none, so the gate's
 *   work queue is exactly the mention-bearing documents not yet judged. Each
 *   queueing bumps the row's `generation`, and a verdict settles only the
 *   generation it was fetched for: a verdict about content that has since
 *   changed is discarded.
 * - The gate settles a row as `keep` or `drop` (the email's worth score
 *   against the rubric's threshold) or `exempt` (not an email, or carrying
 *   structured booking dates, so never judged). A row it cannot settle yet —
 *   the model failed, or an attachment's email has not arrived — waits with a
 *   growing backoff.
 * - The score itself is the email's shared worth answer (`worth/answers.ts`),
 *   asked once whichever gate needs it; this table keeps only the verdict the
 *   time query reads.
 * - A row judged under another rubric version returns to `pending`, as does
 *   an attachment whose email was judged again for new content.
 *
 * The temporal query hides the mentions of a `drop` document only while the
 * gate is active; the rows themselves never change what is stored.
 */

import { documentsMetadataCodec } from "../../data/json-columns.js";
import { resolveContainingDocument } from "../../domain/LinkGraphService.js";
import { findWorthAnswer, recordWorthAnswers, type WorthAnswer } from "../../worth/answers.js";
import {
  EMAIL_BODY_CHARS,
  WORTH_GATED_DOCUMENT_TYPE,
  emailWorthState,
  hasStructuredDate,
  type EmailWorthState,
} from "../../worth/rubric.js";
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
      score REAL,
      judged_at INTEGER
    )
  `);
  // The work queue, in the order the gate takes it.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_date_mention_judgements_pending
       ON date_mention_judgements(next_attempt_at) WHERE verdict = 'pending'`,
  );
  // Scored rows by their email: the attachment requeue.
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
  /** The email already has a worth answer. */
  | (Queued & { kind: "answered"; subjectDocumentId: string; answer: WorthAnswer })
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
}

interface DocHead {
  id: string;
  content_hash: string;
  metadata: string;
}

/**
 * Fetch up to `limit` pending documents due by `now` and resolve each to its
 * subject — the email itself, or the email an attachment belongs to — and to
 * an exemption, the email's stored worth answer, or the state to ask about.
 * Runs on the io pool's read-only handle.
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
      `SELECT document_id, generation, attempts
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
    const answer = findWorthAnswer(db, {
      subjectDocumentId: subject.id,
      contentHash: subject.content_hash,
      rubricVersion,
      requestedModelId: modelId,
    });
    if (answer) {
      out.push({ ...queued, kind: "answered", subjectDocumentId: subject.id, answer });
      continue;
    }
    const body = readBody.get(EMAIL_BODY_CHARS, subject.id);
    out.push({
      ...queued,
      kind: "ask",
      subjectDocumentId: subject.id,
      contentHash: subject.content_hash,
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
  score: number | null;
  judgedAt: number;
}

/** A pending document to try again later. */
export interface MentionJudgementDeferral {
  documentId: string;
  generation: number;
  nextAttemptAt: number;
}

/**
 * Record the worth answers the gate asked for, settle judgements and push back
 * the ones that must wait, in one transaction. A row changes only while it is
 * still pending at the generation the gate fetched: a document re-extracted
 * meanwhile is judged again for its new content, and one that lost its
 * mentions has no row.
 *
 * Settling an email's own row returns its attachments judged for other
 * content to the queue, so they follow the email's current verdict.
 */
export function applyMentionJudgements(
  db: Db,
  records: readonly MentionJudgementRecord[],
  deferrals: readonly MentionJudgementDeferral[] = [],
  answers: readonly WorthAnswer[] = [],
): number {
  const settle = db.prepare(
    `UPDATE date_mention_judgements
        SET verdict = ?, subject_document_id = ?, content_hash = ?, rubric_version = ?,
            score = ?, judged_at = ?, attempts = 0, next_attempt_at = 0
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
    recordWorthAnswers(db, answers);
    for (const r of records) {
      const changed = settle.run(
        r.verdict,
        r.subjectDocumentId,
        r.contentHash,
        r.rubricVersion,
        r.score,
        r.judgedAt,
        r.documentId,
        r.generation,
      ).changes;
      settled += changed;
      if (changed > 0 && r.score !== null && r.subjectDocumentId === r.documentId) {
        requeueAttachments.run(r.documentId, r.contentHash, r.documentId);
      }
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

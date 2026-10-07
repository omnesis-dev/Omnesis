// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { assertKnowledgeRunFence, type KnowledgeRunFence } from "./run-fence.js";
import { enqueueKnowledgeWork, type KnowledgeWork } from "./work.js";
import { getKnowledgeNode } from "./storage.js";
import { materializeKnowledgeOwner, readKnowledgeOwner } from "./owner-adapters.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

/** Failed or colliding runs retain history but release locks and retry current inputs. */
export function abandonKnowledgeBatch(
  db: Database.Database,
  input: { batchId: string; notBefore: number },
  now: number,
): boolean {
  return db.transaction(() => {
    const batch = db
      .prepare<[string], { status: string }>("SELECT status FROM knowledge_batches WHERE id=?")
      .get(input.batchId);
    if (!batch || ["completed", "abandoned"].includes(batch.status)) return false;
    db.prepare(
      "UPDATE knowledge_batches SET status='abandoned',updated_at=?,finished_at=?,revision=revision+1 WHERE id=?",
    ).run(now, now, input.batchId);
    const rows = db
      .prepare<[string], KnowledgeWork>(
        `SELECT id,subject_id AS subjectId,subject_kind AS subjectKind,reason,input_revision AS inputRevision,
      input_changed_at AS inputChangedAt,generation,tier,due_at AS dueAt,created_at AS createdAt,updated_at AS updatedAt,status,batch_id AS batchId,attempts,last_error AS lastError FROM knowledge_work WHERE batch_id=? AND status='batched'`,
      )
      .all(input.batchId);
    db.prepare(
      "UPDATE knowledge_work SET status='deferred',updated_at=? WHERE batch_id=? AND status='batched'",
    ).run(now, input.batchId);
    for (const work of rows) {
      const revision =
        work.subjectKind === "source"
          ? db
              .prepare<
                [string],
                { revision: string }
              >("SELECT content_hash AS revision FROM documents WHERE id=?")
              .get(work.subjectId)?.revision
          : db
              .prepare<
                [string],
                { revision: string }
              >("SELECT CAST(revision AS TEXT) AS revision FROM knowledge_nodes WHERE id=? AND COALESCE(json_extract(fields_json,'$.withdrawn'),0)!=1")
              .get(work.subjectId)?.revision;
      if (!revision) continue;
      const next = enqueueKnowledgeWork(
        db,
        {
          id: `kw_${randomUUID()}`,
          subjectId: work.subjectId,
          subjectKind: work.subjectKind,
          reason: work.reason,
          inputRevision: revision,
          tier: work.tier,
          dueAt: Math.max(input.notBefore, work.dueAt),
          ...(work.lastError === "pending_content" || work.lastError === "derivation"
            ? { readinessReason: work.lastError }
            : {}),
        },
        now,
        work.id,
      );
      db.prepare(
        "UPDATE knowledge_work SET attempts=MAX(attempts,?),input_changed_at=CASE WHEN input_revision=? THEN MIN(input_changed_at,?) ELSE input_changed_at END WHERE id=?",
      ).run(work.attempts, work.inputRevision, work.inputChangedAt, next.id);
    }
    return true;
  })();
}

/** Scheduling metadata is bookkeeping, not a semantic page edit or verification. */
export function scheduleKnowledgeReview(
  db: Database.Database,
  input: {
    id: string;
    expectedRevision: number;
    nextReviewAt: number;
    decision?: "now" | "defer" | "dormant";
    workId?: string;
    reason?: string;
  },
  now: number,
): void {
  db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.nextReviewAt',?,'$.reviewDecision',?,'$.reviewReason',?,'$.reviewDecidedAt',?)
    WHERE id=? AND revision=?`,
      )
      .run(
        input.nextReviewAt,
        input.decision ?? "defer",
        input.reason ?? "bounded_deferral",
        now,
        input.id,
        input.expectedRevision,
      );
    if (result.changes !== 1)
      throw new KnowledgeStorageError(
        "revision_conflict",
        "Review candidate changed during scheduling",
      );
    if (input.decision === "now") {
      if (!input.workId)
        throw new KnowledgeStorageError(
          "claim_invalid",
          "Immediate review requires a work identity",
        );
      enqueueKnowledgeWork(
        db,
        {
          id: input.workId,
          subjectId: input.id,
          subjectKind: "node",
          reason: "review",
          inputRevision: String(input.expectedRevision),
          tier: "immediate",
          dueAt: now,
        },
        now,
      );
    }
    // Deliberately no lastVerifiedAt or updated_at mutation: scheduling is not evidence.
  })();
}

export function setKnowledgeCheckpoint(
  db: Database.Database,
  input: { id: string; value: unknown; expectedRevision: number },
  now: number,
): void {
  const result = db
    .prepare(
      `INSERT INTO knowledge_checkpoints(id,value_json,revision,updated_at)
    SELECT ?,?,1,? WHERE ?=0 ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json,revision=knowledge_checkpoints.revision+1,updated_at=excluded.updated_at
    WHERE knowledge_checkpoints.revision=?`,
    )
    .run(
      input.id,
      JSON.stringify(input.value),
      now,
      input.expectedRevision,
      input.expectedRevision,
    );
  if (result.changes !== 1 && input.expectedRevision !== 0) {
    const update = db
      .prepare(
        "UPDATE knowledge_checkpoints SET value_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
      )
      .run(JSON.stringify(input.value), now, input.id, input.expectedRevision);
    if (update.changes === 1) return;
  }
  if (result.changes !== 1)
    throw new KnowledgeStorageError("revision_conflict", "Checkpoint changed");
}

/** Candidate repair edges are durable hints, never evidence or claim support. */
export function recordKnowledgeDiscoveryTargets(
  db: Database.Database,
  input: {
    sourceId: string;
    sourceRevision: string;
    nodeIds: string[];
    runFence?: KnowledgeRunFence;
  },
  now: number,
): void {
  if (input.nodeIds.length > 64)
    throw new KnowledgeStorageError("claim_invalid", "Too many discovery targets");
  db.transaction(() => {
    assertKnowledgeRunFence(db, input.runFence);
    const source = db
      .prepare<
        [string],
        { content_hash: string }
      >("SELECT d.content_hash FROM documents d LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id WHERE d.id=? AND COALESCE(r.deleted,0)=0")
      .get(input.sourceId);
    if (
      !source ||
      source.content_hash !== input.sourceRevision ||
      !isKnowledgeEvidenceReadable(db, input.sourceId)
    )
      throw new KnowledgeStorageError("revision_conflict", "Discovery source changed");
    const conversionBudget = { chars: 262144, references: 1024 };
    for (const id of new Set(input.nodeIds)) {
      const target =
        getKnowledgeNode(db, id) ?? materializeKnowledgeOwner(db, id, now, conversionBudget);
      if (!target || target.canonicalFields.withdrawn === true)
        throw new KnowledgeStorageError("reference_invalid", "Discovery target is not available");
      if (target.kind === "doc_annotation" || target.kind === "person_annotation") {
        const owner = readKnowledgeOwner(db, target.kind, target.ownerId ?? id);
        if (owner.canonicalFields.invalidatedAt != null)
          throw new KnowledgeStorageError(
            "reference_invalid",
            "Discovery target annotation is inactive; use its active replacement",
          );
      }
      db.prepare(
        "INSERT OR IGNORE INTO knowledge_discovery_targets(source_id,source_revision,node_id,created_at) VALUES(?,?,?,?)",
      ).run(input.sourceId, input.sourceRevision, id, now);
    }
  })();
}

/** Reconcile queued identities under the writer lock before claiming a bounded plan. */
export function refreshKnowledgeWork(db: Database.Database, ids: string[], now: number): number {
  if (ids.length > 512)
    throw new KnowledgeStorageError("claim_invalid", "Work refresh exceeds bound");
  return db.transaction(() => {
    let changed = 0;
    for (const id of new Set(ids)) {
      const work = db
        .prepare<
          [string],
          { subject_id: string; subject_kind: string; input_revision: string }
        >("SELECT subject_id,subject_kind,input_revision FROM knowledge_work WHERE id=? AND status='pending'")
        .get(id);
      if (!work) continue;
      const current =
        work.subject_kind === "source"
          ? db
              .prepare<
                [string],
                { revision: string }
              >("SELECT content_hash AS revision FROM documents WHERE id=?")
              .get(work.subject_id)
          : db
              .prepare<
                [string],
                { revision: string }
              >("SELECT CAST(revision AS TEXT) AS revision FROM knowledge_nodes WHERE id=? AND COALESCE(json_extract(fields_json,'$.withdrawn'),0)!=1")
              .get(work.subject_id);
      if (!current) {
        changed += db
          .prepare(
            "UPDATE knowledge_work SET status='completed',updated_at=?,last_error='subject_removed' WHERE id=?",
          )
          .run(now, id).changes;
      } else if (current.revision !== work.input_revision) {
        changed += db
          .prepare(
            "UPDATE knowledge_work SET input_revision=?,input_changed_at=?,generation=generation+1,updated_at=? WHERE id=?",
          )
          .run(current.revision, now, now, id).changes;
      }
    }
    return changed;
  })();
}

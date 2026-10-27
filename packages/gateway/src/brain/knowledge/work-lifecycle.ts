// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { knowledgeSourceRevisionSql } from "./source-revision.js";
import { assertKnowledgeRunFence, type KnowledgeRunFence } from "./run-fence.js";
import { enqueueKnowledgeWork, findParkedKnowledgeWork, type KnowledgeWork } from "./work.js";
import {
  KNOWLEDGE_WORK_PARKED,
  knowledgeRetryDelayMs,
  type KnowledgeRetryPolicy,
} from "./work-retry.js";
import { getKnowledgeNode } from "./storage.js";
import { materializeKnowledgeOwner, readKnowledgeOwner } from "./owner-adapters.js";
import { isKnowledgeEvidenceReadable } from "./storage-source-fence.js";
import { KnowledgeStorageError } from "./types.js";
import type Database from "better-sqlite3";

export interface AbandonKnowledgeBatchInput {
  batchId: string;
  notBefore: number;
  /**
   * Present only when the batch's run failed. Work the run was offered but
   * did not finish is then charged a failure under this policy; work the
   * batch never reached is not.
   */
  failure?: KnowledgeRetryPolicy;
}

/** Above this many unfinished dependents, abandonment retries every seed whole. */
export const MAX_CARRIED_FRONTIER_NODES = 64;

const SETTLED = new Set(["changed", "unchanged", "skipped"]);
const UNRESOLVED = new Set(["pending", "offered", "deferred"]);

interface AbandonedFrontierRow {
  nodeId: string;
  status: string;
  depth: number;
  inputVersionsJson: string;
}

const workKey = (work: Pick<KnowledgeWork, "subjectKind" | "subjectId">): string =>
  work.subjectKind === "source" ? `source:${work.subjectId}` : work.subjectId;

function currentWorkRevision(
  db: Database.Database,
  subjectKind: KnowledgeWork["subjectKind"],
  subjectId: string,
): string | undefined {
  return subjectKind === "source"
    ? db
        .prepare<[string], { revision: string }>(
          `SELECT ${knowledgeSourceRevisionSql()} AS revision FROM documents d WHERE id=?`,
        )
        .get(subjectId)?.revision
    : db
        .prepare<[string], { revision: string }>(
          "SELECT CAST(revision AS TEXT) AS revision FROM knowledge_nodes WHERE id=? AND COALESCE(json_extract(fields_json,'$.withdrawn'),0)!=1",
        )
        .get(subjectId)?.revision;
}

/** Park this obligation, and any queued twin at the same input revision. */
function parkKnowledgeWork(
  db: Database.Database,
  work: Pick<KnowledgeWork, "id" | "subjectKind" | "subjectId" | "reason" | "inputRevision">,
  failures: number,
  now: number,
): void {
  db.prepare(
    `UPDATE knowledge_work SET status='deferred',last_error=?,failures=MAX(failures,?),updated_at=?
    WHERE id=? OR (subject_kind=? AND subject_id=? AND reason=? AND input_revision=? AND status='pending')`,
  ).run(
    KNOWLEDGE_WORK_PARKED,
    failures,
    now,
    work.id,
    work.subjectKind,
    work.subjectId,
    work.reason,
    work.inputRevision,
  );
}

/**
 * Failed or colliding runs retain history and release locks. What the batch
 * finished stays finished: a seed whose own frontier settled, with nothing it
 * owes still open, completes here; unfinished dependents it expanded become
 * their own queued work. Everything else is retried at its current input
 * revision. After a failed run, work it was offered and did not finish backs
 * off exponentially and is parked once its failures reach the policy's cap.
 */
export function abandonKnowledgeBatch(
  db: Database.Database,
  input: AbandonKnowledgeBatchInput,
  now: number,
): boolean {
  return db.transaction(() => {
    const batch = db
      .prepare<[string], { status: string; tier: KnowledgeWork["tier"] }>(
        "SELECT status,tier FROM knowledge_batches WHERE id=?",
      )
      .get(input.batchId);
    if (!batch || ["completed", "abandoned"].includes(batch.status)) return false;
    db.prepare(
      "UPDATE knowledge_batches SET status='abandoned',updated_at=?,finished_at=?,revision=revision+1 WHERE id=?",
    ).run(now, now, input.batchId);
    const rows = db
      .prepare<[string], KnowledgeWork>(
        `SELECT id,subject_id AS subjectId,subject_kind AS subjectKind,reason,input_revision AS inputRevision,
      input_changed_at AS inputChangedAt,generation,tier,due_at AS dueAt,created_at AS createdAt,updated_at AS updatedAt,status,batch_id AS batchId,attempts,failures,last_error AS lastError FROM knowledge_work WHERE batch_id=? AND status='batched'`,
      )
      .all(input.batchId);
    db.prepare(
      "UPDATE knowledge_work SET status='deferred',updated_at=? WHERE batch_id=? AND status='batched'",
    ).run(now, input.batchId);
    // Bounded by the batch's own frontier, which the engine caps before offering.
    const frontier = db
      .prepare<[string], AbandonedFrontierRow>(
        "SELECT node_id AS nodeId,status,depth,input_versions_json AS inputVersionsJson FROM knowledge_frontier WHERE batch_id=?",
      )
      .all(input.batchId);
    const byNode = new Map<string, AbandonedFrontierRow[]>();
    for (const item of frontier) {
      const items = byNode.get(item.nodeId);
      if (items) items.push(item);
      else byNode.set(item.nodeId, [item]);
    }
    // Every obligation the batch held, including ones a run already rescheduled
    // itself (a deferred curation or placement keeps its own successor).
    const seedKeys = new Set(
      db
        .prepare<[string], Pick<KnowledgeWork, "subjectKind" | "subjectId">>(
          "SELECT subject_kind AS subjectKind,subject_id AS subjectId FROM knowledge_work WHERE batch_id=?",
        )
        .all(input.batchId)
        .map(workKey),
    );
    const carried = [...byNode]
      .filter(
        ([nodeId, items]) =>
          !seedKeys.has(nodeId) &&
          !nodeId.startsWith("source:") &&
          items.some((item) => UNRESOLVED.has(item.status)),
      )
      .map(([nodeId, items]) => ({
        nodeId,
        offered: items.some((item) => item.status === "offered"),
      }));
    const keepProgress = carried.length <= MAX_CARRIED_FRONTIER_NODES;
    const decisionOwed = db.prepare(
      `SELECT 1 FROM knowledge_candidate_decision_work cw JOIN knowledge_candidates c ON c.id=cw.candidate_id
      WHERE cw.work_id=? AND cw.generation=c.decision_generation AND c.decision_pending=1
        AND c.status IN ('proposed','deferred') LIMIT 1`,
    );
    const charge = (failures: number, attempted: boolean): number =>
      failures + (input.failure && attempted ? 1 : 0);
    for (const work of rows) {
      const key = workKey(work);
      const items = byNode.get(key) ?? [];
      const versionKey = work.subjectKind === "source" ? key : `node:${work.subjectId}`;
      const settled = items.some((item) => {
        if (item.depth !== 0 || !SETTLED.has(item.status)) return false;
        const versions = JSON.parse(item.inputVersionsJson) as Record<string, unknown>;
        return String(versions[versionKey]) === work.inputRevision;
      });
      // Unfinished dependents, including the source's own discovery targets,
      // are carried below as their own work; they do not hold the source open.
      const owesMore =
        items.some((item) => UNRESOLVED.has(item.status)) || !!decisionOwed.get(work.id);
      if (keepProgress && settled && !owesMore) {
        db.prepare("UPDATE knowledge_work SET status='completed',updated_at=? WHERE id=?").run(
          now,
          work.id,
        );
        continue;
      }
      const revision = currentWorkRevision(db, work.subjectKind, work.subjectId);
      if (!revision) continue;
      const attempted = settled || items.some((item) => item.status === "offered");
      const sameRevision = revision === work.inputRevision;
      const failures = sameRevision ? charge(work.failures, attempted) : 0;
      const charged = !!input.failure && sameRevision && failures > work.failures;
      const parked = findParkedKnowledgeWork(db, { ...work, inputRevision: revision });
      if (
        parked ||
        (charged && work.reason !== "root" && failures >= input.failure!.maxFailedAttempts)
      ) {
        parkKnowledgeWork(db, work, Math.max(failures, parked?.failures ?? 0), now);
        continue;
      }
      const retryAt = charged ? now + knowledgeRetryDelayMs(failures, input.failure!) : null;
      const next = enqueueKnowledgeWork(
        db,
        {
          id: `kw_${randomUUID()}`,
          subjectId: work.subjectId,
          subjectKind: work.subjectKind,
          reason: work.reason,
          inputRevision: revision,
          tier: work.tier,
          dueAt: Math.max(input.notBefore, retryAt ?? work.dueAt),
          ...(work.lastError === "pending_content" || work.lastError === "derivation"
            ? { readinessReason: work.lastError }
            : {}),
        },
        now,
        work.id,
      );
      // A pending twin keeps its own deadline unless this failure defers it.
      db.prepare(
        `UPDATE knowledge_work SET attempts=MAX(attempts,?),due_at=MAX(due_at,?),
        failures=CASE WHEN input_revision=? THEN MAX(failures,?) ELSE failures END,
        input_changed_at=CASE WHEN input_revision=? THEN MIN(input_changed_at,?) ELSE input_changed_at END WHERE id=?`,
      ).run(
        work.attempts,
        retryAt ?? 0,
        work.inputRevision,
        failures,
        work.inputRevision,
        work.inputChangedAt,
        next.id,
      );
    }
    if (!keepProgress) return true;
    // Expanded dependents are ordinary change obligations once their seed is done.
    for (const item of carried) {
      const node = db
        .prepare<[string], { revision: number; kind: string }>(
          "SELECT revision,kind FROM knowledge_nodes WHERE id=? AND COALESCE(json_extract(fields_json,'$.withdrawn'),0)!=1",
        )
        .get(item.nodeId);
      if (!node) continue;
      const reason = node.kind === "root" ? "root" : "change";
      // Repeated failures of the same dependent accumulate across batches.
      const previous =
        db
          .prepare<[string, string, string], { failures: number }>(
            `SELECT MAX(failures) AS failures FROM knowledge_work WHERE subject_kind='node' AND subject_id=?
            AND reason=? AND input_revision=?`,
          )
          .get(item.nodeId, reason, String(node.revision))?.failures ?? 0;
      const failures = input.failure && item.offered ? previous + 1 : 0;
      const next = enqueueKnowledgeWork(
        db,
        {
          id: `kw_${randomUUID()}`,
          subjectId: item.nodeId,
          subjectKind: "node",
          reason,
          inputRevision: String(node.revision),
          tier: batch.tier,
          dueAt: failures
            ? Math.max(input.notBefore, now + knowledgeRetryDelayMs(failures, input.failure!))
            : input.notBefore,
        },
        now,
      );
      if (!failures || next.status !== "pending") continue;
      if (reason !== "root" && failures >= input.failure!.maxFailedAttempts)
        parkKnowledgeWork(db, next, failures, now);
      else
        db.prepare(
          "UPDATE knowledge_work SET failures=MAX(failures,?),due_at=MAX(due_at,?) WHERE id=?",
        ).run(failures, now + knowledgeRetryDelayMs(failures, input.failure!), next.id);
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
    /** Also record this one-time request under `reviewRequests`, so it is not repeated. */
    request?: string;
  },
  now: number,
): void {
  if (input.request !== undefined && !/^[a-z][a-z0-9_]*$/.test(input.request))
    throw new KnowledgeStorageError("claim_invalid", "Review request keys are snake_case names");
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
    if (result.changes === 1 && input.request !== undefined)
      db.prepare(
        `UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.reviewRequests.${input.request}',?) WHERE id=?`,
      ).run(now, input.id);
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
      .prepare<[string], { content_hash: string }>(
        `SELECT ${knowledgeSourceRevisionSql()} AS content_hash FROM documents d LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id WHERE d.id=? AND COALESCE(r.deleted,0)=0`,
      )
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
        .prepare<[string], { subject_id: string; subject_kind: string; input_revision: string }>(
          "SELECT subject_id,subject_kind,input_revision FROM knowledge_work WHERE id=? AND status='pending'",
        )
        .get(id);
      if (!work) continue;
      const current =
        work.subject_kind === "source"
          ? db
              .prepare<[string], { revision: string }>(
                `SELECT ${knowledgeSourceRevisionSql()} AS revision FROM documents d WHERE id=?`,
              )
              .get(work.subject_id)
          : db
              .prepare<[string], { revision: string }>(
                "SELECT CAST(revision AS TEXT) AS revision FROM knowledge_nodes WHERE id=? AND COALESCE(json_extract(fields_json,'$.withdrawn'),0)!=1",
              )
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
            "UPDATE knowledge_work SET input_revision=?,input_changed_at=?,generation=generation+1,failures=0,updated_at=? WHERE id=?",
          )
          .run(current.revision, now, now, id).changes;
      }
    }
    return changed;
  })();
}

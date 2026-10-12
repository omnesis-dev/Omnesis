// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BadRequestError } from "../../http/errors.js";
import { decodePageCursor, encodePageCursor } from "../../http/pagination-cursor.js";
import { OPEN_LOOP_SOURCE_ID, OPEN_LOOP_DOCUMENT_TYPE } from "../open-loop-source/source-meta.js";
import { knowledgeOwnerReadPredicate } from "./storage-fence.js";
import { KNOWLEDGE_SOURCE_ID, KNOWLEDGE_DOCUMENT_TYPE } from "./source-meta.js";
import { listKnowledgeDecisionsForWork, readDecisionSubjectRef } from "./decision-query.js";
import type { MaintenanceTier } from "./planner.js";
import type { KnowledgeWorkReason } from "./work.js";
import type Database from "better-sqlite3";

export interface PendingKnowledgeWorkOptions {
  reason: KnowledgeWorkReason;
  tier: MaintenanceTier;
  /** Exact grouped last_error; omitted means the NULL/scheduled group. */
  readiness?: string | null;
  limit?: number;
  cursor?: string;
}
interface Row {
  id: string;
  subjectId: string;
  subjectKind: "source" | "node";
  reason: KnowledgeWorkReason;
  tier: MaintenanceTier;
  dueAt: number;
  readiness: string | null;
  inputRevision: string;
  generation: number;
}
export function createKnowledgePendingReadIndexes(db: Database.Database): void {
  const columns = db.prepare<[], { name: string }>("PRAGMA table_info(knowledge_work)").all();
  if (
    ["status", "reason", "tier", "last_error", "due_at", "id"].every((name) =>
      columns.some((c) => c.name === name),
    )
  )
    db.exec(
      "CREATE INDEX IF NOT EXISTS knowledge_work_pending_group ON knowledge_work(status,reason,tier,last_error,due_at,id)",
    );
}

/** A live, privacy-fenced group view; a work link is recorded association, not inferred causation. */
export function readPendingKnowledgeWork(
  db: Database.Database,
  options: PendingKnowledgeWorkOptions,
) {
  return db.transaction(() => {
    if ((options.cursor?.length ?? 0) > 2048 || (options.readiness?.length ?? 0) > 1024)
      throw new BadRequestError("Invalid pending work filter or cursor");
    const readiness = options.readiness ?? null;
    const scope = JSON.stringify({ reason: options.reason, tier: options.tier, readiness });
    const cursor = decodePageCursor(options.cursor, "knowledge-pending-work", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const c = payload as Record<string, unknown>;
      return c.scope === scope &&
        typeof c.id === "string" &&
        c.id.length <= 256 &&
        typeof c.at === "number" &&
        Number.isSafeInteger(c.at)
        ? { id: c.id, at: c.at }
        : null;
    });
    const limit = Math.max(1, Math.min(50, options.limit ?? 20));
    const hasRemoved = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='removed_sources'")
      .get();
    const hasMetadata = db
      .prepare<[], { name: string }>("PRAGMA table_info(documents)")
      .all()
      .some((c) => c.name === "metadata");
    const sourceFence = `EXISTS(SELECT 1 FROM documents d LEFT JOIN knowledge_source_revisions r ON r.document_id=d.id WHERE d.id=w.subject_id AND COALESCE(r.deleted,0)=0
      AND d.source_id NOT IN (@knowledgeSource,@loopSource)
      ${hasMetadata ? "AND COALESCE(json_extract(d.metadata,'$.documentType'),'') NOT IN (@knowledgeType,@loopType)" : ""}
      ${hasRemoved ? "AND NOT EXISTS(SELECT 1 FROM removed_sources removed WHERE removed.id=d.source_id)" : ""}
      AND NOT EXISTS(SELECT 1 FROM knowledge_cascade_jobs j WHERE j.kind='purge' AND j.target_kind='source' AND j.target_id=d.id))`;
    const nodeFence = `EXISTS(SELECT 1 FROM knowledge_nodes n WHERE n.id=w.subject_id) AND ${knowledgeOwnerReadPredicate(db, "w.subject_id")}`;
    const values: Record<string, string | number | null> = {
      reason: options.reason,
      tier: options.tier,
      readiness,
      limit: limit + 1,
      knowledgeSource: KNOWLEDGE_SOURCE_ID,
      loopSource: OPEN_LOOP_SOURCE_ID,
    };
    if (hasMetadata) {
      values.knowledgeType = KNOWLEDGE_DOCUMENT_TYPE;
      values.loopType = OPEN_LOOP_DOCUMENT_TYPE;
    }
    if (cursor) {
      values.afterAt = cursor.at;
      values.afterId = cursor.id;
    }
    const rows = db
      .prepare<Record<string, string | number | null>, Row>(
        `SELECT w.id,w.subject_id AS subjectId,w.subject_kind AS subjectKind,w.reason,w.tier,w.due_at AS dueAt,w.last_error AS readiness,w.input_revision AS inputRevision,w.generation FROM knowledge_work w
      WHERE w.status='pending' AND w.reason=@reason AND w.tier=@tier AND w.last_error IS @readiness
      AND ((w.subject_kind='source' AND ${sourceFence}) OR (w.subject_kind='node' AND (${nodeFence})))
      ${cursor ? "AND (w.due_at>@afterAt OR (w.due_at=@afterAt AND w.id>@afterId))" : ""}
      ORDER BY w.due_at,w.id LIMIT @limit`,
      )
      .all(values);
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    const hasMore = rows.length > limit;
    return {
      items: selected.map(({ subjectId, subjectKind, ...row }) => {
        const nodeId = subjectKind === "source" ? `source:${subjectId}` : subjectId;
        return {
          ...row,
          nodeId,
          subjectRef: readDecisionSubjectRef(db, nodeId),
          decisions: listKnowledgeDecisionsForWork(db, row.id),
        };
      }),
      hasMore,
      nextCursor:
        hasMore && last
          ? encodePageCursor("knowledge-pending-work", { scope, id: last.id, at: last.dueAt })
          : null,
    };
  })();
}

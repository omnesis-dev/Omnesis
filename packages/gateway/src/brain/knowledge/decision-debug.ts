// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  captureDecisionPayloadSubjects,
  recordDecisionPayload,
  type DecisionPayload,
} from "../decision-payload.js";
import { scheduleKnowledgeChange, type UrgencyPolicy } from "./planner.js";
import { KnowledgeStorageError } from "./types.js";
import type { KnowledgeWork, EnqueueKnowledgeWork } from "./work.js";
import type Database from "better-sqlite3";

export interface KnowledgeUrgencyCapture {
  sourceId: string;
  inputRevision: string;
  policy: UrgencyPolicy;
  erasureGeneration: number;
}
export type KnowledgeDecisionPayload = DecisionPayload;
export {
  createDecisionPayloadTables as createKnowledgeDecisionDebugTables,
  decisionPayloadErasureGeneration as knowledgeDecisionErasureGeneration,
} from "../decision-payload.js";

export function recordKnowledgeDecisionPayload(
  db: Database.Database,
  id: string,
  capture: KnowledgeUrgencyCapture,
  payload: KnowledgeDecisionPayload,
  now = Date.now(),
): void {
  const scope = captureDecisionPayloadSubjects(
    db,
    { sourceIds: [capture.sourceId] },
    capture.erasureGeneration,
  );
  if (!scope) return;
  recordDecisionPayload(db, id, scope, payload, now);
  db.prepare(
    "UPDATE knowledge_decision_inputs SET source_id=?,input_revision=? WHERE decision_id=?",
  ).run(capture.sourceId, capture.inputRevision, id);
}

/** Called inside the work enqueue transaction, after deduplication chose the actual work. */
export function associateKnowledgeUrgency(
  db: Database.Database,
  input: EnqueueKnowledgeWork & { urgencyDecision?: { id: string; anchorAt: number } },
  work: KnowledgeWork,
): void {
  const link = input.urgencyDecision;
  if (!link) return;
  const row = db
    .prepare<
      [string],
      {
        nodeId: string;
        inputRevision: string;
        score: number | null;
        scheduling: string;
        workId: string | null;
      }
    >(
      "SELECT node_id AS nodeId,source_revision AS inputRevision,score,scheduling_json AS scheduling,work_id AS workId FROM knowledge_decisions WHERE id=? AND purpose='urgency'",
    )
    .get(link.id);
  if (
    !row ||
    row.nodeId !== `source:${input.subjectId}` ||
    row.inputRevision !== input.inputRevision ||
    input.subjectKind !== "source" ||
    (row.workId !== null && row.workId !== work.id)
  )
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Urgency decision does not match the scheduled source generation",
    );
  const previous = JSON.parse(row.scheduling) as { policy: UrgencyPolicy };
  const proposed = scheduleKnowledgeChange(row.score, link.anchorAt, previous.policy);
  if (proposed.tier !== input.tier || proposed.dueAt !== input.dueAt)
    throw new KnowledgeStorageError(
      "revision_conflict",
      "Urgency schedule differs from the captured policy",
    );
  db.prepare("UPDATE knowledge_decisions SET work_id=?,scheduling_json=? WHERE id=?").run(
    work.id,
    JSON.stringify({
      ...previous,
      status: "scheduled",
      anchorAt: link.anchorAt,
      proposed,
      applied: { tier: work.tier, dueAt: work.dueAt },
      fallbackSoon: row.score === null,
      explicitOverride: false,
    }),
    link.id,
  );
}
export { readDecisionPayload as readKnowledgeDecisionDebug } from "../decision-payload.js";

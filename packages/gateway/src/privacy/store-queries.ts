// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";

import {
  approvalJoinSql,
  buildReleasedAnswerResponse,
  effectiveApprovalStatus,
  getApprovalJoined,
  getTask,
  parseReview,
  parseStringArray,
  responseForTask,
  toApprovalSummary,
} from "./store-internals.js";
import {
  AnswerStoreError,
  PrivacyCursorError,
  type ApprovalJoinedRow,
  type DecisionJoinedRow,
  type PrivacyDb,
} from "./store-types.js";
import {
  fallbackExternalAgentIdentity,
  privacyExternalAgentIdentities,
  privacyExternalAgentIdentity,
  recordedReleaseEgressAt,
} from "./presentation.js";
import type { ChatMessage } from "@omnesis/agent";
import type {
  AnswerResponse,
  PrivacyApprovalDetail,
  PrivacyApprovalStatus,
  PrivacyApprovalSummary,
  PrivacyDecisionSummary,
} from "@omnesis/types/privacy";

export interface PrivacyApprovalPage {
  approvals: PrivacyApprovalSummary[];
  nextCursor: string | null;
  totalCount: number;
}

export function getAnswerTaskResponse(
  db: PrivacyDb,
  taskId: string,
  ownerId: string,
): AnswerResponse | null {
  const task = getTask(db, taskId);
  if (!task) return null;
  if (task.owner_id !== ownerId) {
    throw new AnswerStoreError("owner_mismatch", "Answer task belongs to another caller.");
  }
  return responseForTask(db, taskId);
}

export function loadReleasedAnswerHistory(
  db: PrivacyDb,
  conversationId: string,
  ownerId: string,
): ChatMessage[] {
  const conversation = db
    .prepare<
      [string],
      { owner_id: string }
    >("SELECT owner_id FROM answer_conversations WHERE id = ?")
    .get(conversationId);
  if (!conversation) {
    throw new AnswerStoreError("conversation_not_found", "Answer conversation not found.");
  }
  if (conversation.owner_id !== ownerId) {
    throw new AnswerStoreError("owner_mismatch", "Answer conversation belongs to another caller.");
  }
  return db
    .prepare<[string], { role: "user" | "assistant"; content: string }>(
      "SELECT role, content FROM answer_messages WHERE conversation_id = ? ORDER BY id ASC",
    )
    .all(conversationId)
    .map((row) => ({ role: row.role, parts: [{ kind: "text", text: row.content }] }));
}

export function listPrivacyApprovals(
  db: PrivacyDb,
  status: PrivacyApprovalStatus | "all" = "pending",
  limit = 100,
  now = Date.now(),
): PrivacyApprovalSummary[] {
  return listPrivacyApprovalPage(db, status, limit, undefined, now).approvals;
}

export function listPrivacyApprovalPage(
  db: PrivacyDb,
  status: PrivacyApprovalStatus | "all" = "pending",
  limit = 100,
  cursor?: string,
  now = Date.now(),
): PrivacyApprovalPage {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const after = cursor ? decodeApprovalCursor(cursor, status) : null;
  // A pending approval whose deadline has lapsed is presented as expired even
  // before the periodic sweep materializes the flip, so the status filters
  // match what `effectiveApprovalStatus` renders.
  const [statusWhere, statusParams] =
    status === "all"
      ? ["1 = 1", []]
      : status === "pending"
        ? ["a.status = 'pending' AND a.expires_at > ?", [now]]
        : status === "expired"
          ? ["(a.status = 'expired' OR (a.status = 'pending' AND a.expires_at <= ?))", [now]]
          : ["a.status = ?", [status]];
  const where = `${statusWhere}${
    after ? " AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))" : ""
  }`;
  const params = [
    ...statusParams,
    ...(after ? [after.createdAt, after.createdAt, after.id] : []),
    safeLimit + 1,
  ];
  const rows = db
    .prepare<
      unknown[],
      ApprovalJoinedRow
    >(`${approvalJoinSql(where)} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
    .all(...params);
  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit);
  const identities = privacyExternalAgentIdentities(
    db,
    page.map((row) => row.owner_id),
  );
  const approvals = page.map((row) =>
    toApprovalSummary(row, identities.get(row.owner_id) ?? fallbackExternalAgentIdentity(), now),
  );
  const last = approvals.at(-1);
  const totalCount =
    db
      .prepare<
        unknown[],
        { count: number }
      >(`SELECT COUNT(*) AS count FROM answer_approvals a WHERE ${statusWhere}`)
      .get(...statusParams)?.count ?? 0;
  return {
    approvals,
    nextCursor: hasMore && last ? encodeApprovalCursor(status, last.createdAt, last.id) : null,
    totalCount,
  };
}

function encodeApprovalCursor(
  status: PrivacyApprovalStatus | "all",
  createdAt: number,
  id: string,
): string {
  return Buffer.from(JSON.stringify(["privacy-approvals", status, createdAt, id]), "utf8").toString(
    "base64url",
  );
}

function decodeApprovalCursor(
  cursor: string,
  expectedStatus: PrivacyApprovalStatus | "all",
): { createdAt: number; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== "privacy-approvals" ||
      value[1] !== expectedStatus ||
      typeof value[2] !== "number" ||
      !Number.isSafeInteger(value[2]) ||
      typeof value[3] !== "string" ||
      value[3].length === 0
    ) {
      throw new PrivacyCursorError();
    }
    return { createdAt: value[2], id: value[3] };
  } catch (error) {
    if (error instanceof PrivacyCursorError) throw error;
    throw new PrivacyCursorError();
  }
}

export function getPrivacyApproval(
  db: PrivacyDb,
  approvalId: string,
  now = Date.now(),
): PrivacyApprovalDetail | null {
  const row = getApprovalJoined(db, approvalId);
  if (!row) return null;
  const review = parseReview(row.review_json, row.policy_revision);
  const release = row.release_id
    ? db
        .prepare<
          [string],
          { answer: string }
        >("SELECT answer FROM answer_releases WHERE task_id = ?")
        .get(row.id)
    : null;
  return {
    ...toApprovalSummary(row, privacyExternalAgentIdentity(db, row.owner_id), now),
    workflowPurpose: row.workflow_purpose,
    question: row.question,
    candidateAnswer: row.approval_candidate_answer,
    sharedAt:
      release &&
      row.release_id &&
      (row.status === "released" || row.status === "released_with_reductions")
        ? recordedReleaseEgressAt(db, {
            taskId: row.id,
            workflowId: row.workflow_id,
            conversationId: row.conversation_id,
            status: row.status,
            releaseId: row.release_id,
            responseDigest: releaseResponseDigest(row, release.answer),
          })
        : null,
    review: row.denial_reason === "hard_stop" ? { ...review, fallbackCause: "hard_stop" } : review,
  };
}

function releaseResponseDigest(row: ApprovalJoinedRow, answer: string): string {
  if (!row.release_id || (row.status !== "released" && row.status !== "released_with_reductions")) {
    throw new AnswerStoreError("task_state_conflict", "Released answer metadata is incomplete.");
  }
  return sha256(
    JSON.stringify(
      buildReleasedAnswerResponse({
        workflowId: row.workflow_id,
        conversationId: row.conversation_id,
        taskId: row.id,
        status: row.status,
        releaseId: row.release_id,
        answer,
        reductions: parseStringArray(row.reductions_json),
      }),
    ),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function listPrivacyDecisions(
  db: PrivacyDb,
  limit = 100,
  now = Date.now(),
): PrivacyDecisionSummary[] {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  return db
    .prepare<[number], DecisionJoinedRow>(
      `SELECT t.*, r.answer AS release_answer,
              a.status AS approval_status, a.expires_at AS approval_expires_at
         FROM answer_tasks t
         LEFT JOIN answer_releases r ON r.task_id = t.id
         LEFT JOIN answer_approvals a ON a.task_id = t.id
        WHERE t.status IN (
          'approval_required', 'released', 'released_with_reductions', 'denied'
        )
        ORDER BY t.created_at DESC
        LIMIT ?`,
    )
    .all(safeLimit)
    .map((row) => ({
      taskId: row.id,
      workflowId: row.workflow_id,
      conversationId: row.conversation_id,
      // A lapsed-but-unswept pending approval presents as the expired
      // denial the sweep will materialize — same rule as every other
      // privacy read surface.
      status:
        row.status === "approval_required"
          ? row.approval_status === "pending" &&
            effectiveApprovalStatus("pending", row.approval_expires_at, now) === "expired"
            ? "denied"
            : "approval_required"
          : row.status === "released_with_reductions"
            ? "released_with_reductions"
            : row.status === "released"
              ? "released"
              : "denied",
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      releaseId: row.release_id,
      answer: row.release_answer,
      reductions: parseStringArray(row.reductions_json),
      review: parseReview(row.review_json, row.policy_revision),
    }));
}

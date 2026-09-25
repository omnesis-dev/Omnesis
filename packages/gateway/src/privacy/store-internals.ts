// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { assertNever } from "@omnesis/core";
import { DEFAULT_PRIVACY_POLICY_FAMILY_ID } from "@omnesis/types/privacy";
import {
  AnswerStoreError,
  DENIED_TRANSCRIPT_MARKER,
  type AnswerRequestIdentity,
  type ApprovalJoinedRow,
  type ConversationAvailabilityRow,
  type PrivacyDb,
  type PrivacyPolicyRevisionGuard,
  type TaskDbRow,
} from "./store-types.js";
import { policyRevision } from "./policy-store.js";
import type {
  AnswerResponse,
  ReducedAnswerResponse,
  ReleasedAnswerResponse,
  PrivacyCumulativeCategory,
  PrivacyApprovalStatus,
  PrivacyApprovalSummary,
  PrivacyReviewRecord,
  PrivacyExternalAgentIdentity,
  PrivacyReviewerFallbackCause,
} from "@omnesis/types/privacy";

const MAX_DISCLOSURE_CATEGORIES = 50;

export function digestCandidate(candidate: string): string {
  return createHash("sha256").update(candidate, "utf8").digest("hex");
}

export function answerRequestFingerprint(input: AnswerRequestIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.question,
        input.workflowId ?? null,
        input.conversationId ?? null,
        input.workflowName === undefined
          ? null
          : cleanWorkflowText(input.workflowName, "Answer workflow", 120),
        input.workflowPurpose === undefined
          ? null
          : cleanWorkflowText(input.workflowPurpose, "", 500),
        input.subscriptionFiringId ?? null,
        input.approvalMode ?? "allow",
      ]),
      "utf8",
    )
    .digest("hex");
}

export function getWorkflowPurpose(db: PrivacyDb, workflowId: string): string {
  return getWorkflowIdentity(db, workflowId).purpose;
}

export function getWorkflowIdentity(
  db: PrivacyDb,
  workflowId: string,
): { name: string; purpose: string } {
  const row = db
    .prepare<
      [string],
      { name: string; purpose: string }
    >("SELECT name, purpose FROM answer_workflows WHERE id = ?")
    .get(workflowId);
  if (!row) throw new AnswerStoreError("workflow_not_found", "Answer workflow not found.");
  return row;
}

export function getConversation(db: PrivacyDb, id: string): ConversationAvailabilityRow | null {
  return (
    db
      .prepare<
        [string],
        ConversationAvailabilityRow
      >("SELECT owner_id, active_task_id FROM answer_conversations WHERE id = ?")
      .get(id) ?? null
  );
}

export function getTask(db: PrivacyDb, id: string): TaskDbRow | null {
  return db.prepare<[string], TaskDbRow>("SELECT * FROM answer_tasks WHERE id = ?").get(id) ?? null;
}

export function getOwnedTask(db: PrivacyDb, id: string, ownerId: string): TaskDbRow {
  const task = getTask(db, id);
  if (!task) throw new AnswerStoreError("task_not_found", "Answer task not found.");
  if (task.owner_id !== ownerId) {
    throw new AnswerStoreError("owner_mismatch", "Answer task belongs to another caller.");
  }
  return task;
}

export function getTaskByClientRequest(
  db: PrivacyDb,
  ownerId: string,
  requestId: string,
): TaskDbRow | null {
  return (
    db
      .prepare<
        [string, string],
        TaskDbRow
      >("SELECT * FROM answer_tasks WHERE owner_id = ? AND client_request_id = ?")
      .get(ownerId, requestId) ?? null
  );
}

export function ensureWorkflowAvailable(
  db: PrivacyDb,
  workflowId: string,
  ownerId: string,
  now: number,
): void {
  const row = db
    .prepare<
      [string],
      { owner_id: string; status: string; expires_at: number }
    >("SELECT owner_id, status, expires_at FROM answer_workflows WHERE id = ?")
    .get(workflowId);
  if (!row) throw new AnswerStoreError("workflow_not_found", "Answer workflow not found.");
  if (row.owner_id !== ownerId) {
    throw new AnswerStoreError("owner_mismatch", "Answer workflow belongs to another caller.");
  }
  if (row.expires_at <= now) {
    db.prepare(
      "UPDATE answer_workflows SET status = 'expired', closed_at = ? WHERE id = ? AND status = 'active'",
    ).run(now, workflowId);
    throw new AnswerStoreError("workflow_expired", "Answer workflow has expired.");
  }
  if (row.status !== "active") {
    throw new AnswerStoreError("workflow_closed", "Answer workflow is closed.");
  }
}

export function ensureConversationAvailable(
  db: PrivacyDb,
  conversationId: string,
  activeTaskId: string | null,
  now: number,
): void {
  if (!activeTaskId) return;
  const task = getTask(db, activeTaskId);
  if (!task) {
    db.prepare("UPDATE answer_conversations SET active_task_id = NULL WHERE id = ?").run(
      conversationId,
    );
    return;
  }
  if (task.status !== "running" && task.status !== "approval_required") {
    clearActiveTask(db, conversationId, task.id, now);
    return;
  }
  throw new AnswerStoreError(
    "conversation_busy",
    "This answer conversation already has a task in progress.",
  );
}

export function insertRelease(
  db: PrivacyDb,
  task: TaskDbRow,
  releaseId: string,
  answer: string,
  reductions: string[],
  now: number,
): void {
  db.prepare(
    `INSERT INTO answer_releases
       (id, task_id, owner_id, answer, reductions_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(releaseId, task.id, task.owner_id, answer, JSON.stringify(reductions), now);
}

export function advanceWorkflowDisclosure(
  db: PrivacyDb,
  input: {
    workflowId: string;
    review: PrivacyReviewRecord;
    answerCharacters: number;
    now: number;
    expectedRevision?: number;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO answer_workflow_disclosure (
       workflow_id, revision, released_turns, released_characters, categories_json, updated_at
     ) VALUES (?, 0, 0, 0, '[]', ?)`,
  ).run(input.workflowId, input.now);
  const row = db
    .prepare<
      [string],
      {
        revision: number;
        released_turns: number;
        released_characters: number;
        categories_json: string;
      }
    >(
      `SELECT revision, released_turns, released_characters, categories_json
         FROM answer_workflow_disclosure WHERE workflow_id = ?`,
    )
    .get(input.workflowId)!;
  if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) {
    throw new AnswerStoreError(
      "disclosure_changed",
      "Workflow disclosure changed while the answer was being reviewed.",
    );
  }
  const categories = mergeDisclosureCategories(
    parseDisclosureCategories(row.categories_json),
    input.review.findings.map((finding) => ({
      category: finding.category,
      detailLevel: finding.detailLevel,
      subject: finding.subject,
      count: 1,
    })),
  );
  db.prepare(
    `UPDATE answer_workflow_disclosure
        SET revision = ?, released_turns = ?, released_characters = ?,
            categories_json = ?, updated_at = ?
      WHERE workflow_id = ? AND revision = ?`,
  ).run(
    row.revision + 1,
    row.released_turns + 1,
    row.released_characters + input.answerCharacters,
    JSON.stringify(categories),
    input.now,
    input.workflowId,
    row.revision,
  );
}

export function assertPolicyRevision(
  db: PrivacyDb,
  guard: PrivacyPolicyRevisionGuard | undefined,
): void {
  if (!guard) return;
  const state = db
    .prepare<
      [string],
      { revision: string; digest: string }
    >("SELECT revision, digest FROM privacy_policy_state WHERE family_id = ?")
    .get(DEFAULT_PRIVACY_POLICY_FAMILY_ID);
  // Standalone/test stores without a ledger retain the legacy file guard. A
  // production gateway bootstraps state before any reviewed release.
  if (state === undefined) {
    try {
      if (policyRevision(readFileSync(guard.path, "utf8")) === guard.expectedRevision) return;
    } catch {
      /* fail closed below */
    }
  }
  if (
    state === undefined ||
    state.revision !== guard.expectedRevision ||
    (guard.expectedDigest !== undefined && state.digest !== guard.expectedDigest)
  ) {
    throw new AnswerStoreError(
      "policy_changed",
      "The privacy policy changed while the answer was being reviewed.",
    );
  }
}

export function assertSubscriptionDisclosureRevision(
  db: PrivacyDb,
  workflowId: string,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined) return;
  let revision = 0;
  try {
    revision =
      db
        .prepare<
          [string],
          { revision: number }
        >("SELECT revision FROM subscription_workflow_disclosure WHERE workflow_id = ?")
        .get(workflowId)?.revision ?? 0;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("no such table")) throw error;
  }
  if (revision !== expectedRevision) {
    throw new AnswerStoreError(
      "disclosure_changed",
      "Watch existence disclosures changed while the answer was being reviewed.",
    );
  }
}

export function parseDisclosureCategories(value: string): PrivacyCumulativeCategory[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PrivacyCumulativeCategory => {
      if (!item || typeof item !== "object") return false;
      const row = item as Partial<PrivacyCumulativeCategory>;
      return (
        typeof row.category === "string" &&
        ["existence", "summary", "exact", "original"].includes(row.detailLevel ?? "") &&
        ["user", "other_person", "multiple_people", "unknown"].includes(row.subject ?? "") &&
        Number.isSafeInteger(row.count) &&
        (row.count ?? 0) > 0
      );
    });
  } catch {
    return [];
  }
}

function mergeDisclosureCategories(
  prior: PrivacyCumulativeCategory[],
  added: PrivacyCumulativeCategory[],
): PrivacyCumulativeCategory[] {
  const counts = new Map<string, PrivacyCumulativeCategory>();
  let omitted = 0;
  for (const category of [...prior, ...added]) {
    if (category.category === "other_categories") {
      omitted += category.count;
      continue;
    }
    const key = `${category.category}\u0000${category.detailLevel}\u0000${category.subject}`;
    const existing = counts.get(key);
    if (existing) existing.count += category.count;
    else counts.set(key, { ...category });
  }
  const sorted = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.category.localeCompare(b.category),
  );
  const retained = sorted.slice(0, MAX_DISCLOSURE_CATEGORIES - 1);
  omitted += sorted
    .slice(MAX_DISCLOSURE_CATEGORIES - 1)
    .reduce((total, category) => total + category.count, 0);
  if (omitted > 0) {
    retained.push({
      category: "other_categories",
      detailLevel: "original",
      subject: "unknown",
      count: omitted,
    });
  }
  return retained;
}

export function appendResolvedTranscript(
  db: PrivacyDb,
  task: Pick<TaskDbRow, "id" | "conversation_id" | "question">,
  assistantText: string,
  now: number,
): void {
  const insert = db.prepare(
    `INSERT INTO answer_messages (conversation_id, task_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run(task.conversation_id, task.id, "user", task.question, now);
  insert.run(task.conversation_id, task.id, "assistant", assistantText, now);
}

export function clearActiveTask(
  db: PrivacyDb,
  conversationId: string,
  taskId: string,
  now: number,
): void {
  db.prepare(
    `UPDATE answer_conversations
       SET active_task_id = NULL, updated_at = ?
     WHERE id = ? AND active_task_id = ?`,
  ).run(now, conversationId, taskId);
}

export function responseForTask(db: PrivacyDb, taskId: string): AnswerResponse | null {
  const task = getTask(db, taskId);
  if (!task) return null;
  const base = {
    workflowId: task.workflow_id,
    conversationId: task.conversation_id,
    taskId: task.id,
  };
  switch (task.status) {
    case "released": {
      const release = getRelease(db, task.id);
      if (!task.release_id || !release) return null;
      return buildReleasedAnswerResponse({
        ...base,
        status: "released",
        releaseId: task.release_id,
        answer: release.answer,
        reductions: [],
      });
    }
    case "released_with_reductions": {
      const release = getRelease(db, task.id);
      if (!task.release_id || !release) return null;
      return buildReleasedAnswerResponse({
        ...base,
        status: "released_with_reductions",
        releaseId: task.release_id,
        answer: release.answer,
        reductions: parseStringArray(task.reductions_json),
      });
    }
    case "approval_required": {
      if (!task.approval_id) return null;
      const approval = db
        .prepare<
          [string],
          { expires_at: number }
        >("SELECT expires_at FROM answer_approvals WHERE id = ?")
        .get(task.approval_id);
      if (!approval) return null;
      return {
        ...base,
        status: "approval_required",
        approvalId: task.approval_id,
        approvalExpiresAt: approval.expires_at,
      };
    }
    case "denied":
    case "canceled": {
      const raw = task.denial_reason;
      const reason =
        raw === "hard_stop" ||
        raw === "user_denied" ||
        raw === "expired" ||
        raw === "canceled" ||
        raw === "approval_not_available"
          ? raw
          : "privacy_policy";
      return { ...base, status: "denied", reason };
    }
    case "running":
    case "failed":
      return null;
    default:
      return assertNever(task.status);
  }
}

export function buildReleasedAnswerResponse(input: {
  workflowId: string;
  conversationId: string;
  taskId: string;
  status: "released" | "released_with_reductions";
  releaseId: string;
  answer: string;
  reductions: string[];
}): ReleasedAnswerResponse | ReducedAnswerResponse {
  const base = {
    workflowId: input.workflowId,
    conversationId: input.conversationId,
    taskId: input.taskId,
  };
  switch (input.status) {
    case "released":
      return {
        ...base,
        status: "released",
        releaseId: input.releaseId,
        answer: input.answer,
      };
    case "released_with_reductions":
      return {
        ...base,
        status: "released_with_reductions",
        releaseId: input.releaseId,
        answer: input.answer,
        reductions: input.reductions,
      };
    default:
      return assertNever(input.status);
  }
}

function getRelease(db: PrivacyDb, taskId: string): { answer: string } | null {
  return (
    db
      .prepare<[string], { answer: string }>("SELECT answer FROM answer_releases WHERE task_id = ?")
      .get(taskId) ?? null
  );
}

export function getApprovalJoined(db: PrivacyDb, approvalId: string): ApprovalJoinedRow | null {
  return (
    db.prepare<[string], ApprovalJoinedRow>(approvalJoinSql("a.id = ?")).get(approvalId) ?? null
  );
}

export function approvalJoinSql(where: string): string {
  return `SELECT t.*,
           a.status AS approval_status,
           a.created_at AS approval_created_at,
           a.expires_at AS approval_expires_at,
           a.resolved_at AS approval_resolved_at,
           a.candidate_answer AS approval_candidate_answer,
           a.release_status AS approval_release_status,
           a.reductions_json AS approval_reductions_json,
           w.name AS workflow_name,
           w.purpose AS workflow_purpose
      FROM answer_approvals a
      JOIN answer_tasks t ON t.id = a.task_id
      JOIN answer_workflows w ON w.id = t.workflow_id
     WHERE ${where}`;
}

export function toApprovalSummary(
  row: ApprovalJoinedRow,
  externalAgent: PrivacyExternalAgentIdentity,
  now: number,
): PrivacyApprovalSummary {
  return {
    id: row.approval_id!,
    taskId: row.id,
    workflowId: row.workflow_id,
    conversationId: row.conversation_id,
    workflowName: row.workflow_name,
    externalAgent,
    status: effectiveApprovalStatus(
      normalizeApprovalStatus(row.approval_status),
      row.approval_expires_at,
      now,
    ),
    createdAt: row.approval_created_at,
    expiresAt: row.approval_expires_at,
    resolvedAt: row.approval_resolved_at,
  };
}

/**
 * Presents a pending approval whose deadline has lapsed as `expired`, without
 * requiring the periodic sweep (which materializes the flip and its audit
 * events on the writer) to have run yet. Read paths must never wait on the
 * writer, so expiry is derived at read time from `expires_at`.
 */
export function effectiveApprovalStatus<S extends PrivacyApprovalStatus | null>(
  status: S,
  expiresAt: number | null,
  now: number,
): S | "expired" {
  return status === "pending" && expiresAt !== null && expiresAt <= now ? "expired" : status;
}

export function expireJoinedApproval(db: PrivacyDb, row: ApprovalJoinedRow, now: number): void {
  db.prepare(
    "UPDATE answer_approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'",
  ).run(now, row.approval_id);
  appendResolvedTranscript(db, row, DENIED_TRANSCRIPT_MARKER, now);
  db.prepare(
    `UPDATE answer_tasks
       SET status = 'denied', denial_reason = 'expired',
           candidate_answer = NULL, candidate_digest = NULL, resolved_at = ?
     WHERE id = ? AND status = 'approval_required'`,
  ).run(now, row.id);
  clearActiveTask(db, row.conversation_id, row.id, now);
}

function normalizeApprovalStatus(status: string): PrivacyApprovalStatus {
  if (status === "approved" || status === "denied" || status === "expired") return status;
  return "pending";
}

export function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function parseReview(
  value: string | null,
  policyRevision: string | null,
): PrivacyReviewRecord {
  if (value) {
    try {
      const parsed = JSON.parse(value) as PrivacyReviewRecord;
      if (parsed && typeof parsed === "object" && typeof parsed.recipeVersion === "string") {
        return { ...parsed, fallbackCause: normalizeReviewerFallbackCause(parsed.fallbackCause) };
      }
    } catch {
      // Fall through to the fail-closed metadata record.
    }
  }
  return {
    recipeVersion: "privacy-reviewer-v1",
    provider: null,
    model: null,
    confidence: null,
    policyRevision: policyRevision ?? "",
    fallbackCause: null,
    findings: [],
    rationale: "Privacy review metadata was unavailable.",
  };
}

function normalizeReviewerFallbackCause(value: unknown): PrivacyReviewerFallbackCause | null {
  switch (value) {
    case "not_configured":
    case "request_failed":
    case "context_window_exceeded":
    case "output_truncated":
    case "invalid_output":
    case "low_confidence":
    case "policy_requires_review":
    case "hard_stop":
      return value;
    default:
      return null;
  }
}

export function cleanWorkflowText(
  value: string | undefined,
  fallback: string,
  max: number,
): string {
  const clean = value?.trim().replace(/\s+/g, " ") ?? "";
  return clean.length > 0 ? clean.slice(0, max) : fallback;
}

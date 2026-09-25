// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";

import { assertNever } from "@omnesis/core";

import { appendAnswerAuditEvent, auditDisplay } from "./store-audit.js";
import { detectCredentialHardStop } from "./reviewer.js";

import {
  advanceWorkflowDisclosure,
  assertPolicyRevision,
  assertSubscriptionDisclosureRevision,
  answerRequestFingerprint,
  appendResolvedTranscript,
  approvalJoinSql,
  cleanWorkflowText,
  clearActiveTask,
  digestCandidate,
  ensureConversationAvailable,
  ensureWorkflowAvailable,
  expireJoinedApproval,
  getApprovalJoined,
  getConversation,
  getOwnedTask,
  getTask,
  getTaskByClientRequest,
  getWorkflowIdentity,
  getWorkflowPurpose,
  insertRelease,
  parseReview,
  responseForTask,
} from "./store-internals.js";
import {
  AnswerStoreError,
  DENIED_TRANSCRIPT_MARKER,
  type ApprovalJoinedRow,
  type BeginAnswerTaskInput,
  type BegunAnswerTask,
  type CompleteAnswerTaskInput,
  type PrivacyDb,
  type ResolveApprovalInput,
} from "./store-types.js";
import type { AnswerResponse } from "@omnesis/types/privacy";

export function beginAnswerTask(db: PrivacyDb, input: BeginAnswerTaskInput): BegunAnswerTask {
  return db.transaction((): BegunAnswerTask => {
    const deletedRequest = db
      .prepare<[string, string], { request_fingerprint: string }>(
        `SELECT request_fingerprint FROM answer_request_tombstones
          WHERE owner_id = ? AND client_request_id = ?`,
      )
      .get(input.ownerId, input.clientRequestId);
    if (deletedRequest) {
      if (deletedRequest.request_fingerprint !== answerRequestFingerprint(input)) {
        throw new AnswerStoreError(
          "idempotency_conflict",
          "The answer request id was already used with different input.",
        );
      }
      throw new AnswerStoreError(
        "conversation_deleted",
        "The privacy conversation for this request was deleted.",
      );
    }
    const duplicate = getTaskByClientRequest(db, input.ownerId, input.clientRequestId);
    if (duplicate) {
      const workflow = getWorkflowIdentity(db, duplicate.workflow_id);
      if (answerRequestFingerprint(input) !== duplicate.request_fingerprint) {
        throw new AnswerStoreError(
          "idempotency_conflict",
          "The answer request id was already used with different input.",
        );
      }
      const requestedCompletionDevice = input.completionRoute?.integrationDeviceId ?? null;
      const requestedNativeConversation = input.completionRoute?.nativeConversationId ?? null;
      if (
        requestedCompletionDevice !== duplicate.completion_device_id ||
        requestedNativeConversation !== duplicate.completion_native_conversation_id
      ) {
        throw new AnswerStoreError(
          "idempotency_conflict",
          "The answer request id was already used with a different native completion route.",
        );
      }
      if (duplicate.status === "failed" || duplicate.status === "canceled") {
        ensureWorkflowAvailable(db, duplicate.workflow_id, input.ownerId, input.now);
        const conversation = getConversation(db, duplicate.conversation_id);
        if (!conversation || conversation.owner_id !== input.ownerId) {
          throw new AnswerStoreError("conversation_not_found", "Answer conversation not found.");
        }
        ensureConversationAvailableWithExpiryAudit(
          db,
          duplicate.conversation_id,
          conversation.active_task_id,
          input.now,
        );
        db.prepare(
          `UPDATE answer_tasks
             SET status = 'running', policy_revision = NULL, review_json = NULL,
                 reductions_json = NULL, release_id = NULL, approval_id = NULL,
                 denial_reason = NULL, candidate_answer = NULL, candidate_digest = NULL,
                 resolved_at = NULL, created_at = ?
           WHERE id = ?`,
        ).run(input.now, duplicate.id);
        db.prepare(
          "UPDATE answer_conversations SET active_task_id = ?, updated_at = ? WHERE id = ?",
        ).run(duplicate.id, input.now, duplicate.conversation_id);
        appendExternalRequestAudit(db, duplicate.id, input);
        return {
          workflowId: duplicate.workflow_id,
          workflowPurpose: workflow.purpose,
          conversationId: duplicate.conversation_id,
          taskId: duplicate.id,
          duplicate: false,
          state: "running",
        };
      }
      return {
        workflowId: duplicate.workflow_id,
        workflowPurpose: workflow.purpose,
        conversationId: duplicate.conversation_id,
        taskId: duplicate.id,
        duplicate: true,
        state: duplicate.status,
      };
    }

    let workflowId = input.workflowId;
    let conversationId = input.conversationId;
    if (conversationId) {
      const tombstone = db
        .prepare<
          [string],
          { owner_id: string }
        >("SELECT owner_id FROM answer_conversation_tombstones WHERE id = ?")
        .get(conversationId);
      if (tombstone) {
        if (tombstone.owner_id !== input.ownerId) {
          throw new AnswerStoreError(
            "owner_mismatch",
            "Answer conversation belongs to another caller.",
          );
        }
        throw new AnswerStoreError(
          "conversation_deleted",
          "This privacy conversation was deleted and cannot be continued.",
        );
      }
      const conversation = db
        .prepare<
          [string],
          { id: string; workflow_id: string; owner_id: string; active_task_id: string | null }
        >("SELECT id, workflow_id, owner_id, active_task_id FROM answer_conversations WHERE id = ?")
        .get(conversationId);
      if (!conversation) {
        throw new AnswerStoreError("conversation_not_found", "Answer conversation not found.");
      }
      if (conversation.owner_id !== input.ownerId) {
        throw new AnswerStoreError(
          "owner_mismatch",
          "Answer conversation belongs to another caller.",
        );
      }
      if (workflowId && workflowId !== conversation.workflow_id) {
        throw new AnswerStoreError(
          "conversation_not_found",
          "Answer conversation does not belong to that workflow.",
        );
      }
      workflowId = conversation.workflow_id;
      ensureConversationAvailableWithExpiryAudit(
        db,
        conversation.id,
        conversation.active_task_id,
        input.now,
      );
    }

    if (workflowId) {
      ensureWorkflowAvailable(db, workflowId, input.ownerId, input.now);
    } else {
      workflowId = input.ids.workflowId;
      db.prepare(
        `INSERT INTO answer_workflows
           (id, owner_id, name, purpose, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        workflowId,
        input.ownerId,
        cleanWorkflowText(input.workflowName, "Answer workflow", 120),
        cleanWorkflowText(input.workflowPurpose, "", 500),
        input.now,
        input.workflowExpiresAt,
      );
      db.prepare(
        `INSERT INTO answer_workflow_disclosure (
           workflow_id, revision, released_turns, released_characters, categories_json, updated_at
         ) VALUES (?, 0, 0, 0, '[]', ?)`,
      ).run(workflowId, input.now);
    }

    if (!conversationId) {
      conversationId = input.ids.conversationId;
      if (
        db
          .prepare<
            [string],
            { id: string }
          >("SELECT id FROM answer_conversation_tombstones WHERE id = ?")
          .get(conversationId)
      ) {
        throw new AnswerStoreError(
          "conversation_deleted",
          "The generated privacy conversation id was previously deleted.",
        );
      }
      db.prepare(
        `INSERT INTO answer_conversations
           (id, workflow_id, owner_id, active_task_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      ).run(conversationId, workflowId, input.ownerId, input.now, input.now);
    }

    db.prepare(
      `INSERT INTO answer_tasks (
         id, workflow_id, conversation_id, owner_id, client_request_id,
         request_fingerprint, subscription_firing_id, completion_device_id,
         completion_native_conversation_id, question, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      input.ids.taskId,
      workflowId,
      conversationId,
      input.ownerId,
      input.clientRequestId,
      answerRequestFingerprint(input),
      input.subscriptionFiringId ?? null,
      input.completionRoute?.integrationDeviceId ?? null,
      input.completionRoute?.nativeConversationId ?? null,
      input.question,
      input.now,
    );
    db.prepare(
      "UPDATE answer_conversations SET active_task_id = ?, updated_at = ? WHERE id = ?",
    ).run(input.ids.taskId, input.now, conversationId);
    appendExternalRequestAudit(db, input.ids.taskId, input);

    return {
      workflowId,
      workflowPurpose: getWorkflowPurpose(db, workflowId),
      conversationId,
      taskId: input.ids.taskId,
      duplicate: false,
      state: "running",
    };
  })();
}

export function recoverInterruptedAnswerTasks(db: PrivacyDb, now: number): number {
  return db.transaction(() => {
    const tasks = db
      .prepare<
        [],
        { id: string; owner_id: string }
      >("SELECT id, owner_id FROM answer_tasks WHERE status = 'running'")
      .all();
    if (tasks.length === 0) return 0;
    db.prepare(
      `UPDATE answer_conversations
          SET active_task_id = NULL, updated_at = ?
        WHERE active_task_id IN (SELECT id FROM answer_tasks WHERE status = 'running')`,
    ).run(now);
    for (const task of tasks) {
      appendAnswerAuditEvent(db, {
        id: auditId(),
        taskId: task.id,
        ownerId: task.owner_id,
        kind: "failed",
        display: auditDisplay({
          title: "Answer interrupted",
          status: "failed",
          text: "The gateway restarted before this answer completed.",
        }),
        payload: { reason: "gateway_restart" },
        now,
      });
    }
    db.prepare(
      `UPDATE answer_tasks
          SET status = 'failed', candidate_answer = NULL, candidate_digest = NULL,
              resolved_at = ?
        WHERE status = 'running'`,
    ).run(now);
    return tasks.length;
  })();
}

export function completeAnswerTask(db: PrivacyDb, input: CompleteAnswerTaskInput): AnswerResponse {
  return db.transaction(() => {
    const task = getOwnedTask(db, input.taskId, input.ownerId);
    if (task.status !== "running") {
      throw new AnswerStoreError("task_state_conflict", "Answer task is no longer running.");
    }
    const reviewJson = JSON.stringify(input.review);

    switch (input.outcome.kind) {
      case "release": {
        assertPolicyRevision(db, input.outcome.policyGuard);
        assertSubscriptionDisclosureRevision(
          db,
          task.workflow_id,
          input.outcome.expectedExistenceDisclosureRevision,
        );
        advanceWorkflowDisclosure(db, {
          workflowId: task.workflow_id,
          review: input.review,
          answerCharacters: input.outcome.answer.length,
          now: input.now,
          expectedRevision: input.outcome.expectedDisclosureRevision,
        });
        insertRelease(db, task, input.outcome.releaseId, input.outcome.answer, [], input.now);
        appendResolvedTranscript(db, task, input.outcome.answer, input.now);
        db.prepare(
          `UPDATE answer_tasks
             SET status = 'released', policy_revision = ?, review_json = ?,
                 release_id = ?, reductions_json = '[]', resolved_at = ?
           WHERE id = ?`,
        ).run(input.review.policyRevision, reviewJson, input.outcome.releaseId, input.now, task.id);
        clearActiveTask(db, task.conversation_id, task.id, input.now);
        appendAnswerAuditEvent(db, {
          id: auditId(),
          taskId: task.id,
          ownerId: task.owner_id,
          kind: "released",
          display: auditDisplay({
            title: "Released unchanged",
            status: "released",
            text: preview(input.outcome.answer),
            releaseId: input.outcome.releaseId,
            digest: digestCandidate(input.outcome.answer),
          }),
          payload: {
            answer: input.outcome.answer,
            releaseId: input.outcome.releaseId,
            answerDigest: digestCandidate(input.outcome.answer),
          },
          now: input.now,
        });
        return responseForTask(db, task.id)!;
      }
      case "reduce": {
        assertPolicyRevision(db, input.outcome.policyGuard);
        assertSubscriptionDisclosureRevision(
          db,
          task.workflow_id,
          input.outcome.expectedExistenceDisclosureRevision,
        );
        advanceWorkflowDisclosure(db, {
          workflowId: task.workflow_id,
          review: input.review,
          answerCharacters: input.outcome.answer.length,
          now: input.now,
          expectedRevision: input.outcome.expectedDisclosureRevision,
        });
        insertRelease(
          db,
          task,
          input.outcome.releaseId,
          input.outcome.answer,
          input.outcome.reductions,
          input.now,
        );
        appendResolvedTranscript(db, task, input.outcome.answer, input.now);
        db.prepare(
          `UPDATE answer_tasks
             SET status = 'released_with_reductions', policy_revision = ?, review_json = ?,
                 release_id = ?, reductions_json = ?, resolved_at = ?
           WHERE id = ?`,
        ).run(
          input.review.policyRevision,
          reviewJson,
          input.outcome.releaseId,
          JSON.stringify(input.outcome.reductions),
          input.now,
          task.id,
        );
        clearActiveTask(db, task.conversation_id, task.id, input.now);
        appendAnswerAuditEvent(db, {
          id: auditId(),
          taskId: task.id,
          ownerId: task.owner_id,
          kind: "released",
          display: auditDisplay({
            title: "Released with reductions",
            status: "released_with_reductions",
            text: preview(input.outcome.answer),
            releaseId: input.outcome.releaseId,
            digest: digestCandidate(input.outcome.answer),
            reductions: input.outcome.reductions,
          }),
          payload: {
            answer: input.outcome.answer,
            releaseId: input.outcome.releaseId,
            answerDigest: digestCandidate(input.outcome.answer),
            reductions: input.outcome.reductions,
          },
          now: input.now,
        });
        return responseForTask(db, task.id)!;
      }
      case "approval": {
        const releaseStatus = input.outcome.releaseStatus ?? "released";
        const reductions = input.outcome.reductions ?? [];
        db.prepare(
          `INSERT INTO answer_approvals (
             id, task_id, candidate_digest, candidate_answer, policy_revision,
             release_status, reductions_json, status, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        ).run(
          input.outcome.approvalId,
          task.id,
          input.outcome.candidateDigest,
          input.outcome.candidateAnswer,
          input.review.policyRevision,
          releaseStatus,
          JSON.stringify(reductions),
          input.now,
          input.outcome.expiresAt,
        );
        db.prepare(
          `UPDATE answer_tasks
             SET status = 'approval_required', candidate_answer = ?,
                 candidate_digest = ?, policy_revision = ?, review_json = ?,
                 approval_id = ?
           WHERE id = ?`,
        ).run(
          input.outcome.candidateAnswer,
          input.outcome.candidateDigest,
          input.review.policyRevision,
          reviewJson,
          input.outcome.approvalId,
          task.id,
        );
        if (task.completion_device_id && task.completion_native_conversation_id) {
          db.prepare(
            `INSERT OR IGNORE INTO answer_completion_deliveries
               (id, task_id, integration_device_id, native_conversation_id, status, next_attempt_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
          ).run(
            `acd_${randomUUID()}`,
            task.id,
            task.completion_device_id,
            task.completion_native_conversation_id,
            input.now,
            input.now,
            input.now,
          );
        }
        appendAnswerAuditEvent(db, {
          id: auditId(),
          taskId: task.id,
          ownerId: task.owner_id,
          kind: "approval_requested",
          display: auditDisplay({
            title: "Approval required",
            status: "approval_required",
            text: "The candidate is held inside Omnesis until the user decides.",
            approvalId: input.outcome.approvalId,
            digest: input.outcome.candidateDigest,
            reductions,
          }),
          payload: {
            approvalId: input.outcome.approvalId,
            candidateDigest: input.outcome.candidateDigest,
            policyRevision: input.review.policyRevision,
            releaseStatus,
            reductions,
            expiresAt: input.outcome.expiresAt,
          },
          now: input.now,
        });
        return responseForTask(db, task.id)!;
      }
      case "deny": {
        appendResolvedTranscript(db, task, DENIED_TRANSCRIPT_MARKER, input.now);
        db.prepare(
          `UPDATE answer_tasks
             SET status = 'denied', policy_revision = ?, review_json = ?,
                 denial_reason = ?, candidate_answer = NULL, candidate_digest = NULL,
                 resolved_at = ?
           WHERE id = ?`,
        ).run(input.review.policyRevision, reviewJson, input.outcome.reason, input.now, task.id);
        clearActiveTask(db, task.conversation_id, task.id, input.now);
        appendAnswerAuditEvent(db, {
          id: auditId(),
          taskId: task.id,
          ownerId: task.owner_id,
          kind: "denied",
          display: auditDisplay({
            title: "Nothing released",
            status: "denied",
            text: "The privacy boundary denied this request.",
            detail: input.outcome.reason === "hard_stop" ? "Deterministic hard stop" : null,
          }),
          payload: { reason: input.outcome.reason },
          now: input.now,
        });
        return responseForTask(db, task.id)!;
      }
      default:
        return assertNever(input.outcome);
    }
  })();
}

/**
 * The reason an answer task ended in `failed`, as durably recorded. `detail`
 * holds vetted provider disposition metadata when a model provider rejected
 * the request; it is absent for failures Omnesis raised on its own.
 */
export interface AnswerFailureSummary {
  code: string;
  message: string;
  detail?: string;
}

export function failAnswerTask(
  db: PrivacyDb,
  taskId: string,
  ownerId: string,
  now: number,
  failure?: AnswerFailureSummary,
): boolean {
  return db.transaction(() => {
    const task = getOwnedTask(db, taskId, ownerId);
    if (task.status !== "running") return false;
    db.prepare(
      `UPDATE answer_tasks
         SET status = 'failed', candidate_answer = NULL, candidate_digest = NULL, resolved_at = ?
       WHERE id = ?`,
    ).run(now, task.id);
    clearActiveTask(db, task.conversation_id, task.id, now);
    appendAnswerAuditEvent(db, {
      id: auditId(),
      taskId: task.id,
      ownerId: task.owner_id,
      kind: "failed",
      display: auditDisplay({
        title: "Answer failed",
        status: "failed",
        text: failure?.message ?? "Omnesis could not complete this answer.",
        ...(failure?.detail ? { detail: failure.detail } : {}),
      }),
      payload: { reason: failure?.code ?? "answer_generation_or_review_failed" },
      now,
    });
    return true;
  })();
}

export function resolvePrivacyApproval(
  db: PrivacyDb,
  input: ResolveApprovalInput,
): AnswerResponse | null {
  return db.transaction(() => {
    const joined = getApprovalJoined(db, input.approvalId);
    if (!joined) return null;
    if (joined.approval_status !== "pending") return responseForTask(db, joined.id);

    if (joined.approval_expires_at <= input.now) {
      expireJoinedApproval(db, joined, input.now);
      appendApprovalExpirationAudit(db, joined, input.now);
      return responseForTask(db, joined.id);
    }

    if (input.action === "deny") {
      db.prepare(
        "UPDATE answer_approvals SET status = 'denied', resolved_at = ? WHERE id = ? AND status = 'pending'",
      ).run(input.now, input.approvalId);
      appendResolvedTranscript(db, joined, DENIED_TRANSCRIPT_MARKER, input.now);
      db.prepare(
        `UPDATE answer_tasks
           SET status = 'denied', denial_reason = 'user_denied',
               candidate_answer = NULL, candidate_digest = NULL, resolved_at = ?
         WHERE id = ? AND status = 'approval_required'`,
      ).run(input.now, joined.id);
      clearActiveTask(db, joined.conversation_id, joined.id, input.now);
      appendApprovalResolutionAudit(db, joined, "user_denied", input.now, input);
      appendAnswerAuditEvent(db, {
        id: auditId(),
        taskId: joined.id,
        ownerId: joined.owner_id,
        kind: "denied",
        display: auditDisplay({
          title: "Nothing released",
          status: "denied",
          text: "The user denied the held candidate.",
          approvalId: input.approvalId,
        }),
        payload: { reason: "user_denied", approvalId: input.approvalId },
        now: input.now,
      });
      return responseForTask(db, joined.id);
    }

    const candidate = joined.approval_candidate_answer;
    if (!candidate || digestCandidate(candidate) !== joined.candidate_digest) {
      throw new AnswerStoreError(
        "task_state_conflict",
        "Held answer no longer matches the approval record.",
      );
    }
    const approvalReview = parseReview(joined.review_json, joined.policy_revision);
    const hardStop = detectCredentialHardStop(`${joined.question}\n${candidate}`);
    const credentialApprovalAuthorized =
      hardStop !== null &&
      approvalReview.credentialApprovalRequired === true &&
      approvalReview.fallbackCause === "policy_requires_review" &&
      approvalReview.findings.some(
        (finding) =>
          finding.category === hardStop.category &&
          finding.detailLevel === "original" &&
          finding.disposition === "approval",
      );
    if (hardStop && !credentialApprovalAuthorized) {
      db.prepare(
        "UPDATE answer_approvals SET status = 'denied', resolved_at = ? WHERE id = ? AND status = 'pending'",
      ).run(input.now, input.approvalId);
      appendResolvedTranscript(db, joined, DENIED_TRANSCRIPT_MARKER, input.now);
      db.prepare(
        `UPDATE answer_tasks
           SET status = 'denied', denial_reason = 'hard_stop',
               candidate_answer = NULL, candidate_digest = NULL, resolved_at = ?
         WHERE id = ? AND status = 'approval_required'`,
      ).run(input.now, joined.id);
      clearActiveTask(db, joined.conversation_id, joined.id, input.now);
      appendApprovalResolutionAudit(db, joined, "hard_stop", input.now, input);
      appendAnswerAuditEvent(db, {
        id: auditId(),
        taskId: joined.id,
        ownerId: joined.owner_id,
        kind: "denied",
        display: auditDisplay({
          title: "Nothing released",
          status: "denied",
          text: "A deterministic credential hard stop cannot be overridden by approval.",
          detail: hardStop.description,
          approvalId: input.approvalId,
        }),
        payload: { reason: "hard_stop", approvalId: input.approvalId, finding: hardStop },
        now: input.now,
      });
      return responseForTask(db, joined.id);
    }
    const reductions = parseApprovalReductions(joined.approval_reductions_json);
    advanceWorkflowDisclosure(db, {
      workflowId: joined.workflow_id,
      review: approvalReview,
      answerCharacters: candidate.length,
      now: input.now,
    });
    insertRelease(db, joined, input.releaseId, candidate, reductions, input.now);
    appendResolvedTranscript(db, joined, candidate, input.now);
    db.prepare(
      "UPDATE answer_approvals SET status = 'approved', resolved_at = ? WHERE id = ? AND status = 'pending'",
    ).run(input.now, input.approvalId);
    db.prepare(
      `UPDATE answer_tasks
         SET status = ?, release_id = ?, reductions_json = ?,
             candidate_answer = NULL, candidate_digest = NULL, resolved_at = ?
       WHERE id = ? AND status = 'approval_required'`,
    ).run(
      joined.approval_release_status,
      input.releaseId,
      JSON.stringify(reductions),
      input.now,
      joined.id,
    );
    clearActiveTask(db, joined.conversation_id, joined.id, input.now);
    appendApprovalResolutionAudit(db, joined, "approved", input.now, input);
    appendAnswerAuditEvent(db, {
      id: auditId(),
      taskId: joined.id,
      ownerId: joined.owner_id,
      kind: "released",
      display: auditDisplay({
        title:
          joined.approval_release_status === "released_with_reductions"
            ? "Approved reduced answer released"
            : "Approved answer released",
        status: joined.approval_release_status,
        text: preview(candidate),
        approvalId: input.approvalId,
        releaseId: input.releaseId,
        digest: digestCandidate(candidate),
        reductions,
      }),
      payload: {
        answer: candidate,
        answerDigest: digestCandidate(candidate),
        approvalId: input.approvalId,
        releaseId: input.releaseId,
        reductions,
      },
      now: input.now,
    });
    return responseForTask(db, joined.id);
  })();
}

export function expirePrivacyApprovals(db: PrivacyDb, now: number): number {
  return db.transaction(() => {
    const expired = db
      .prepare<
        [number],
        ApprovalJoinedRow
      >(approvalJoinSql("a.status = 'pending' AND a.expires_at <= ?"))
      .all(now);
    for (const joined of expired) {
      expireJoinedApproval(db, joined, now);
      appendApprovalExpirationAudit(db, joined, now);
    }
    return expired.length;
  })();
}

function appendApprovalExpirationAudit(db: PrivacyDb, task: ApprovalJoinedRow, now: number): void {
  appendApprovalResolutionAudit(db, task, "expired", now);
  appendAnswerAuditEvent(db, {
    id: auditId(),
    taskId: task.id,
    ownerId: task.owner_id,
    kind: "denied",
    display: auditDisplay({
      title: "Nothing released",
      status: "denied",
      text: "The approval expired before the user decided.",
      approvalId: task.approval_id,
    }),
    payload: { reason: "expired", approvalId: task.approval_id },
    now,
  });
}

function ensureConversationAvailableWithExpiryAudit(
  db: PrivacyDb,
  conversationId: string,
  activeTaskId: string | null,
  now: number,
): void {
  if (activeTaskId) {
    const task = getTask(db, activeTaskId);
    if (task?.status === "approval_required" && task.approval_id) {
      const approval = getApprovalJoined(db, task.approval_id);
      if (
        approval &&
        approval.approval_status === "pending" &&
        approval.approval_expires_at <= now
      ) {
        expireJoinedApproval(db, approval, now);
        appendApprovalExpirationAudit(db, approval, now);
      }
    }
  }
  ensureConversationAvailable(db, conversationId, activeTaskId, now);
}

function appendExternalRequestAudit(
  db: PrivacyDb,
  taskId: string,
  input: BeginAnswerTaskInput,
): void {
  appendAnswerAuditEvent(db, {
    id: auditId(),
    taskId,
    ownerId: input.ownerId,
    kind: "external_request",
    display: auditDisplay({
      title: "External request",
      text: preview(input.question),
      detail: input.workflowPurpose?.trim() || null,
      status: "running",
    }),
    payload: {
      question: input.question,
      clientRequestId: input.clientRequestId,
      workflowName: input.workflowName ?? null,
      workflowPurpose: input.workflowPurpose ?? null,
    },
    now: input.now,
  });
}

function appendApprovalResolutionAudit(
  db: PrivacyDb,
  task: ApprovalJoinedRow,
  outcome: "approved" | "user_denied" | "hard_stop" | "expired",
  now: number,
  resolution?: Pick<ResolveApprovalInput, "action" | "requestContext">,
): void {
  const status = outcome === "approved" ? "approved" : outcome === "expired" ? "expired" : "denied";
  appendAnswerAuditEvent(db, {
    id: auditId(),
    taskId: task.id,
    ownerId: task.owner_id,
    kind: "approval_resolved",
    display: auditDisplay({
      title:
        outcome === "approved"
          ? "User approved"
          : outcome === "user_denied"
            ? "User denied"
            : outcome === "hard_stop"
              ? "User approved; system blocked"
              : "Approval expired",
      status,
      approvalId: task.approval_id,
      digest: task.candidate_digest,
    }),
    payload: {
      approvalId: task.approval_id,
      status,
      resolvedAt: now,
      action: resolution?.action ?? null,
      outcome,
      request: resolution?.requestContext ?? null,
    },
    now,
  });
}

function parseApprovalReductions(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function preview(value: string): string {
  return value.length <= 4_000 ? value : `${value.slice(0, 4_000)}\n...`;
}

function auditId(): string {
  return `audit_${randomUUID()}`;
}

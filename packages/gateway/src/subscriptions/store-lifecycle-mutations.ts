// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { assertNever } from "@omnesis/core";
import { getSubscriptionApproval, getSubscriptionForDevice } from "./store-queries.js";
import {
  parseStoredSubscriptionJson,
  storedSubscriptionCompiledPlanCodec,
  subscriptionPrivacyCategoriesCodec,
  subscriptionReactionWorkflowPurpose,
} from "./store-codecs.js";
import { isWatchV2Plan } from "./watch-v2-plan.js";
import {
  SUBSCRIPTION_APPROVAL_LIFETIME_MS,
  audit,
  cancelOpenSubscriptionDeliveries,
  json,
  matchesPrivacyPolicyRevision,
} from "./store-mutation-helpers.js";
import type { SubscriptionDetail, SubscriptionStatus } from "@omnesis/types";
import type { Db } from "../data/types.js";
import type {
  CreateSubscriptionMutation,
  CreateSubscriptionMutationResult,
  PurgeSubscriptionMutation,
  PurgeSubscriptionMutationResult,
  RecordSubscriptionPrivacyReviewMutation,
  RecordSubscriptionPrivacyReviewMutationResult,
  ResolveSubscriptionApprovalMutation,
  ResolveSubscriptionApprovalMutationResult,
  SubscriptionApprovalResolvedBy,
  RevokeSubscriptionMutation,
  RevokeSubscriptionMutationResult,
  ReviseSubscriptionMutation,
  ReviseSubscriptionMutationResult,
  SetSubscriptionStatusMutationResult,
} from "./store-types.js";

function workflowDisclosureMatches(
  db: Db,
  workflowId: string,
  expectedAnswerRevision: number | undefined,
  expectedExistenceRevision: number | undefined,
): boolean {
  const answerRevision =
    db
      .prepare<
        [string],
        { revision: number }
      >("SELECT revision FROM answer_workflow_disclosure WHERE workflow_id = ?")
      .get(workflowId)?.revision ?? 0;
  const existenceRevision =
    db
      .prepare<
        [string],
        { revision: number }
      >("SELECT revision FROM subscription_workflow_disclosure WHERE workflow_id = ?")
      .get(workflowId)?.revision ?? 0;
  return (
    (expectedAnswerRevision === undefined || answerRevision === expectedAnswerRevision) &&
    (expectedExistenceRevision === undefined || existenceRevision === expectedExistenceRevision)
  );
}

export function recordSubscriptionPrivacyReview(
  db: Db,
  input: RecordSubscriptionPrivacyReviewMutation,
): RecordSubscriptionPrivacyReviewMutationResult {
  try {
    return db.transaction(() => {
      if (!matchesPrivacyPolicyRevision(db, input.policyGuard)) {
        return { outcome: "policy_changed" } as const;
      }
      const row = db
        .prepare<
          [string, string],
          {
            current_revision: number;
            status: string;
            approval_status: string;
            policy_revision: string;
            privacy_categories_json: string;
          }
        >(
          `SELECT s.current_revision, s.status, a.status AS approval_status, r.policy_revision,
                r.privacy_categories_json
           FROM subscriptions s
           JOIN subscription_revisions r
             ON r.subscription_id = s.id AND r.revision = s.current_revision
           JOIN subscription_approvals a
             ON a.subscription_id = s.id AND a.revision = s.current_revision
          WHERE s.id = ? AND a.id = ?`,
        )
        .get(input.subscriptionId, input.approvalId);
      if (!row) return { outcome: "not_found" } as const;
      if (row.current_revision !== input.revision) return { outcome: "stale_revision" } as const;
      if (row.policy_revision !== input.policyRevision)
        return { outcome: "policy_changed" } as const;
      if (input.review.policyRevision !== input.policyRevision) {
        return { outcome: "policy_changed" } as const;
      }
      const workflow = db
        .prepare<[string, number], { workflow_id: string }>(
          `SELECT workflow_id FROM subscription_revisions
          WHERE subscription_id = ? AND revision = ?`,
        )
        .get(input.subscriptionId, input.revision);
      if (
        !workflow ||
        !workflowDisclosureMatches(
          db,
          workflow.workflow_id,
          input.expectedAnswerDisclosureRevision,
          input.expectedExistenceDisclosureRevision,
        )
      ) {
        return { outcome: "disclosure_changed" } as const;
      }
      if (row.status !== "pending_approval" || row.approval_status !== "pending") {
        return { outcome: "terminal" } as const;
      }
      const findings = input.review.findings.map((finding) => ({
        category: finding.category,
        detailLevel: "existence" as const,
        subject: finding.subject,
        count: 1,
      }));
      const fallbackCategories = parseStoredSubscriptionJson(
        subscriptionPrivacyCategoriesCodec,
        row.privacy_categories_json,
        "privacy categories",
      ).map((category) => ({
        category,
        detailLevel: "existence" as const,
        subject: "unknown" as const,
        count: 1,
      }));
      const disclosureCategories = findings.length > 0 ? findings : fallbackCategories;
      db.prepare(
        `UPDATE subscription_approvals
          SET privacy_review_json = ?, disclosure_categories_json = ?
        WHERE id = ?`,
      ).run(JSON.stringify(input.review), JSON.stringify(disclosureCategories), input.approvalId);
      audit(db, {
        subscriptionId: input.subscriptionId,
        revision: input.revision,
        eventType: "privacy_reviewed",
        title: "Watch existence reviewed by privacy policy",
        status: input.decision,
        payload: {
          approvalId: input.approvalId,
          policyRevision: input.policyRevision,
          decision: input.decision,
          review: input.review,
        },
        createdAt: input.reviewedAt,
      });
      if (input.decision === "ask") return { outcome: "recorded" } as const;
      const resolution = resolveSubscriptionApprovalInTransaction(db, {
        approvalId: input.approvalId,
        decision: input.decision === "allow" ? "approve" : "deny",
        resolvedBy: { kind: "policy" },
        policyRevision: input.policyRevision,
        policyGuard: input.policyGuard,
        expectedAnswerDisclosureRevision: input.expectedAnswerDisclosureRevision,
        expectedExistenceDisclosureRevision: input.expectedExistenceDisclosureRevision,
        grantId: input.grantId,
        grantExpiresAt: input.grantExpiresAt,
        resolvedAt: input.resolvedAt,
      });
      if (resolution.outcome !== "resolved") {
        throw new PrivacyReviewResolutionAbort(resolution);
      }
      return resolution;
    })();
  } catch (error) {
    if (error instanceof PrivacyReviewResolutionAbort) return error.result;
    throw error;
  }
}

class PrivacyReviewResolutionAbort extends Error {
  constructor(
    readonly result: Exclude<ResolveSubscriptionApprovalMutationResult, { outcome: "resolved" }>,
  ) {
    super(`watch privacy resolution aborted: ${result.outcome}`);
  }
}

export function createSubscription(
  db: Db,
  input: CreateSubscriptionMutation,
): CreateSubscriptionMutationResult {
  return db.transaction(() => {
    const existing = db
      .prepare<[string, string], { id: string; request_fingerprint: string }>(
        `SELECT id, request_fingerprint FROM subscriptions
          WHERE owner_id = ? AND client_request_id = ?`,
      )
      .get(input.ownerId, input.clientRequestId);
    if (existing) {
      if (existing.request_fingerprint !== input.requestFingerprint) {
        return { outcome: "idempotency_conflict" } as const;
      }
      const subscription = getSubscriptionForDevice(db, existing.id, input.integrationDeviceId);
      if (!subscription) return { outcome: "idempotency_conflict" } as const;
      return { outcome: "replayed", subscription } as const;
    }

    if (input.createWorkflow) {
      db.prepare(
        `INSERT INTO answer_workflows
           (id, owner_id, name, purpose, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        input.workflowId,
        input.ownerId,
        input.workflowName,
        input.workflowPurpose,
        input.createdAt,
        input.workflowExpiresAt,
      );
      db.prepare(
        `INSERT INTO answer_workflow_disclosure
           (workflow_id, revision, released_turns, released_characters, categories_json, updated_at)
         VALUES (?, 0, 0, 0, '[]', ?)`,
      ).run(input.workflowId, input.createdAt);
    } else {
      const workflow = db
        .prepare<[string, string, string, number], { id: string }>(
          `SELECT id FROM answer_workflows
            WHERE id = ? AND owner_id = ? AND purpose = ?
              AND status = 'active' AND expires_at >= ?`,
        )
        .get(input.workflowId, input.ownerId, input.workflowPurpose, input.workflowExpiresAt);
      if (!workflow) return { outcome: "workflow_unavailable" } as const;
    }

    db.prepare(
      `INSERT INTO subscription_workflow_disclosure
         (workflow_id, revision, existence_signals, categories_json, updated_at)
       VALUES (?, 0, 0, '[]', ?)
       ON CONFLICT(workflow_id) DO NOTHING`,
    ).run(input.workflowId, input.createdAt);

    db.prepare(
      `INSERT INTO subscriptions
         (id, integration_device_id, owner_id, workflow_id, client_request_id,
          request_fingerprint, current_revision, status, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'pending_approval', ?, ?, ?)`,
    ).run(
      input.id,
      input.integrationDeviceId,
      input.ownerId,
      input.workflowId,
      input.clientRequestId,
      input.requestFingerprint,
      input.createdAt,
      input.createdAt,
      input.expiresAt,
    );
    // A record arms nothing of its own. Its condition is a watch, evaluated by
    // the watch runtime from its own definition store; what lives here is the
    // agreement — who asked, what they were told it would do, and what they
    // are allowed to be sent when it comes true.
    db.prepare(
      `INSERT INTO subscription_revisions
         (subscription_id, revision, workflow_id, condition_json, reaction_json, interpretation_json,
          grounding_json, compile_run_id, compiled_plan_json, compiler_version, privacy_categories_json,
          policy_revision, created_at, expires_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.workflowId,
      json(input.condition),
      json(input.reaction),
      json(input.interpretation),
      input.grounding === undefined ? null : json(input.grounding),
      input.compileRunId ?? null,
      json(input.compiledPlan),
      input.compilerVersion,
      json(input.privacyCategories),
      input.policyRevision,
      input.createdAt,
      input.expiresAt,
    );
    db.prepare(
      `INSERT INTO subscription_approvals
         (id, subscription_id, revision, status, created_at, expires_at)
       VALUES (?, ?, 1, 'pending', ?, ?)`,
    ).run(input.approvalId, input.id, input.createdAt, input.approvalExpiresAt);
    audit(db, {
      subscriptionId: input.id,
      revision: 1,
      eventType: "approval_requested",
      title: "Watch approval requested",
      status: "pending",
      createdAt: input.createdAt,
    });
    const subscription = getSubscriptionForDevice(db, input.id, input.integrationDeviceId);
    if (!subscription) throw new Error("created subscription could not be read back");
    return { outcome: "created", subscription } as const;
  })();
}

/** Project wall-clock expiry into every durable subscription capability. */
export function expireSubscriptions(db: Db, now: number): number {
  return db.transaction(() => {
    const rows = db
      .prepare<[number], { id: string; current_revision: number }>(
        `SELECT id, current_revision
           FROM subscriptions
          WHERE status NOT IN ('expired', 'revoked')
            AND expires_at IS NOT NULL
            AND expires_at <= ?`,
      )
      .all(now);
    for (const row of rows) {
      db.prepare(
        `UPDATE subscriptions
            SET status = 'expired', updated_at = ?
          WHERE id = ?`,
      ).run(now, row.id);
      db.prepare(
        `UPDATE subscription_approvals
            SET status = 'expired', resolved_at = COALESCE(resolved_at, ?)
          WHERE subscription_id = ? AND status = 'pending'`,
      ).run(now, row.id);
      db.prepare(
        `UPDATE subscription_grants SET revoked_at = COALESCE(revoked_at, ?)
          WHERE subscription_id = ? AND revoked_at IS NULL`,
      ).run(now, row.id);
      cancelOpenSubscriptionDeliveries(db, row.id, now, "subscription expired");
      audit(db, {
        subscriptionId: row.id,
        revision: row.current_revision,
        eventType: "expired",
        title: "Watch expired",
        status: "expired",
        createdAt: now,
      });
    }
    return rows.length;
  })();
}

/**
 * A privacy-policy edit invalidates every standing INTEGRATION subscription
 * grant. Materialize that invalidation as a fresh immutable revision and
 * approval, rather than leaving an apparently active subscription that can
 * keep firing into a permanently blocked delivery queue.
 *
 * Operator watches (ios-push reactions) are exempt: the privacy policy
 * governs what may leave the corpus toward an external agent, and an
 * operator watch's firing never leaves — it lands on the operator's own
 * phone. Re-fencing it on every policy edit would gate an internal mechanism
 * on an exit concern.
 */
export function reconcileSubscriptionsPolicy(
  db: Db,
  policyRevision: string,
  reconciledAt: number,
): number {
  return db.transaction(() => {
    const rows = db
      .prepare<
        [string],
        {
          id: string;
          current_revision: number;
          status: string;
          expires_at: number | null;
          workflow_id: string;
          condition_json: string;
          reaction_json: string;
          interpretation_json: string;
          compile_run_id: string | null;
          compiled_plan_json: string;
          compiler_version: string;
          privacy_categories_json: string;
          revision_expires_at: number | null;
        }
      >(
        `SELECT s.id, s.current_revision, s.status, s.expires_at,
                r.workflow_id,
                r.condition_json, r.reaction_json, r.interpretation_json,
                r.compile_run_id, r.compiled_plan_json, r.compiler_version,
                r.privacy_categories_json,
                r.expires_at AS revision_expires_at
           FROM subscriptions s
           JOIN subscription_revisions r
             ON r.subscription_id = s.id AND r.revision = s.current_revision
          WHERE s.status IN ('pending_approval', 'active', 'paused')
            AND r.policy_revision <> ?
            AND json_extract(r.reaction_json, '$.kind') <> 'ios-push'`,
      )
      .all(policyRevision);
    for (const row of rows) {
      const revision = row.current_revision + 1;
      db.prepare(
        `UPDATE subscription_approvals
            SET status = 'expired', resolved_at = COALESCE(resolved_at, ?)
          WHERE subscription_id = ? AND status = 'pending'`,
      ).run(reconciledAt, row.id);
      db.prepare(
        `UPDATE subscription_grants
            SET revoked_at = COALESCE(revoked_at, ?)
          WHERE subscription_id = ? AND revoked_at IS NULL`,
      ).run(reconciledAt, row.id);
      cancelOpenSubscriptionDeliveries(db, row.id, reconciledAt, "privacy policy changed");
      // The plan carries over unchanged, but its grounding does not: that block
      // is a measurement taken at a moment, and re-measuring needs analytics
      // this writer transaction cannot reach. A NULL leaves the fresh approval
      // without the block rather than showing a months-old count as current.
      // The compile run id DOES carry over — it is provenance of the plan,
      // not a measurement, and the plan is byte-identical here.
      db.prepare(
        `INSERT INTO subscription_revisions
           (subscription_id, revision, workflow_id, condition_json, reaction_json, interpretation_json,
            compile_run_id, compiled_plan_json, compiler_version, privacy_categories_json,
            policy_revision, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        revision,
        row.workflow_id,
        row.condition_json,
        row.reaction_json,
        row.interpretation_json,
        row.compile_run_id,
        row.compiled_plan_json,
        row.compiler_version,
        row.privacy_categories_json,
        policyRevision,
        reconciledAt,
        row.revision_expires_at,
      );
      const approvalId = `sapp_${randomUUID()}`;
      const approvalExpiresAt = Math.min(
        row.expires_at ?? reconciledAt + SUBSCRIPTION_APPROVAL_LIFETIME_MS,
        reconciledAt + SUBSCRIPTION_APPROVAL_LIFETIME_MS,
      );
      db.prepare(
        `INSERT INTO subscription_approvals
           (id, subscription_id, revision, status, created_at, expires_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      ).run(approvalId, row.id, revision, reconciledAt, approvalExpiresAt);
      // A policy change requires fresh approval, but it must not silently
      // erase an operator's paused intent. The pending approval row carries
      // the reapproval state while a paused subscription stays non-firing.
      db.prepare(
        `UPDATE subscriptions
            SET current_revision = ?,
                status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'pending_approval' END,
                updated_at = ?
          WHERE id = ?`,
      ).run(revision, reconciledAt, row.id);
      audit(db, {
        subscriptionId: row.id,
        revision,
        eventType: "policy_reapproval_requested",
        title: "Privacy policy changed; watch approval requested",
        status: "pending",
        payload: { approvalId },
        createdAt: reconciledAt,
      });
    }
    return rows.length;
  })();
}

export function setSubscriptionStatus(
  db: Db,
  input: {
    subscriptionId: string;
    integrationDeviceId: string;
    expectedRevision: number;
    status: "active" | "paused";
    policyRevision: string;
    updatedAt: number;
  },
): SetSubscriptionStatusMutationResult {
  return db.transaction(() => {
    const current = db
      .prepare<
        [string, string],
        {
          current_revision: number;
          status: string;
          compiled_plan_json: string;
        }
      >(
        `SELECT s.current_revision, s.status, r.compiled_plan_json
           FROM subscriptions s
           JOIN subscription_revisions r
             ON r.subscription_id = s.id AND r.revision = s.current_revision
          WHERE s.id = ? AND s.integration_device_id = ?`,
      )
      .get(input.subscriptionId, input.integrationDeviceId);
    if (!current) return { outcome: "not_found" } as const;
    if (current.current_revision !== input.expectedRevision) {
      return { outcome: "stale_revision" } as const;
    }
    if (current.status !== "active" && current.status !== "paused") {
      return { outcome: "terminal" } as const;
    }
    if (current.status === input.status) {
      const subscription = getSubscriptionForDevice(
        db,
        input.subscriptionId,
        input.integrationDeviceId,
      );
      if (!subscription) throw new Error("unchanged subscription could not be read back");
      return { outcome: "updated", subscription } as const;
    }
    if (input.status === "active") {
      // Resuming requires a grant issued under the CURRENT policy. Only
      // integration subscriptions reach this today (pause/resume is an
      // integration-facing surface). An operator watch's grant keeps the
      // policy revision it was created under — by design, since a policy edit
      // does not re-fence a watch that never leaves the corpus — so extending
      // pause/resume to operator watches means relaxing this check for them,
      // exactly as the delivery claim does.
      const grant = db
        .prepare<[string, number, string, number], { id: string }>(
          `SELECT id FROM subscription_grants
            WHERE subscription_id = ? AND revision = ? AND policy_revision = ?
              AND revoked_at IS NULL AND expires_at > ?`,
        )
        .get(input.subscriptionId, current.current_revision, input.policyRevision, input.updatedAt);
      if (!grant) return { outcome: "grant_unavailable" } as const;
    }
    // Status is the whole mechanism. A record arms nothing, so pausing does
    // not disarm anything — it stops a firing being carried, because only an
    // active anchor carries one.
    return setStatusWithoutTrigger(db, input, current.current_revision);
  })();
}

/**
 * The audit title an approval resolution carries. Exhaustive over
 * `SubscriptionApprovalResolvedBy` on purpose: a new authority added to that
 * union must say what it is called in the operator's audit trail, rather than
 * inheriting the wording of an operator tap it is not.
 */
function approvalResolutionTitle(
  decision: "approve" | "deny",
  resolvedBy: SubscriptionApprovalResolvedBy,
): string {
  if (decision === "deny") return "Watch denied";
  switch (resolvedBy.kind) {
    case "device":
      return "Watch approved";
    case "policy":
      return "Watch allowed by your privacy policy";
    case "operator":
      return "Watch activated at your request";
    default:
      return assertNever(resolvedBy);
  }
}

/**
 * The device and token an approval resolution is attributed to. Exhaustive for
 * the same reason as the title: a new authority that silently fell through to
 * `null` here would be indistinguishable in the ledger from one with no device
 * behind it.
 */
function approvalResolutionAttribution(resolvedBy: SubscriptionApprovalResolvedBy): {
  deviceId: string | null;
  tokenId: string | null;
} {
  switch (resolvedBy.kind) {
    case "device":
      return { deviceId: resolvedBy.deviceId, tokenId: resolvedBy.tokenId };
    case "policy":
    case "operator":
      return { deviceId: null, tokenId: null };
    default:
      return assertNever(resolvedBy);
  }
}

function resolveSubscriptionApprovalInTransaction(
  db: Db,
  input: ResolveSubscriptionApprovalMutation,
): ResolveSubscriptionApprovalMutationResult {
  if (!matchesPrivacyPolicyRevision(db, input.policyGuard)) {
    return { outcome: "policy_changed" } as const;
  }
  const row = db
    .prepare<
      [string],
      {
        subscription_id: string;
        revision: number;
        status: string;
        expires_at: number;
        current_revision: number;
        subscription_status: string;
        policy_revision: string;
        integration_device_id: string;
        workflow_id: string;
        privacy_categories_json: string;
        disclosure_categories_json: string;
        compiled_plan_json: string;
      }
    >(
      `SELECT a.subscription_id, a.revision, a.status, a.expires_at,
                s.current_revision, s.status AS subscription_status,
                r.policy_revision, s.integration_device_id,
                r.workflow_id, r.privacy_categories_json,
                a.disclosure_categories_json, r.compiled_plan_json
           FROM subscription_approvals a
           JOIN subscriptions s ON s.id = a.subscription_id
           JOIN subscription_revisions r
             ON r.subscription_id = a.subscription_id AND r.revision = a.revision
          WHERE a.id = ?`,
    )
    .get(input.approvalId);
  if (!row) return { outcome: "not_found" } as const;
  if (row.status !== "pending") return { outcome: "already_resolved" } as const;
  if (row.expires_at <= input.resolvedAt) {
    db.prepare(
      "UPDATE subscription_approvals SET status = 'expired', resolved_at = ? WHERE id = ?",
    ).run(input.resolvedAt, input.approvalId);
    return { outcome: "expired" } as const;
  }
  if (row.subscription_status !== "pending_approval" && row.subscription_status !== "paused") {
    return { outcome: "terminal" } as const;
  }
  if (row.current_revision !== row.revision) return { outcome: "stale_revision" } as const;
  if (row.policy_revision !== input.policyRevision) return { outcome: "policy_changed" } as const;
  if (
    !workflowDisclosureMatches(
      db,
      row.workflow_id,
      input.expectedAnswerDisclosureRevision,
      input.expectedExistenceDisclosureRevision,
    )
  ) {
    return { outcome: "disclosure_changed" } as const;
  }
  const status = input.decision === "approve" ? "approved" : "denied";
  const attribution = approvalResolutionAttribution(input.resolvedBy);
  db.prepare(
    `UPDATE subscription_approvals
          SET status = ?, resolved_at = ?, resolved_by_device_id = ?, resolved_by_token_id = ?
        WHERE id = ?`,
  ).run(status, input.resolvedAt, attribution.deviceId, attribution.tokenId, input.approvalId);
  if (input.decision === "approve") {
    const disclosureCategories =
      row.disclosure_categories_json === "[]"
        ? JSON.stringify(
            parseStoredSubscriptionJson(
              subscriptionPrivacyCategoriesCodec,
              row.privacy_categories_json,
              "privacy categories",
            ).map((category) => ({
              category,
              detailLevel: "existence",
              subject: "unknown",
              count: 1,
            })),
          )
        : row.disclosure_categories_json;
    db.prepare(
      `INSERT INTO subscription_grants
           (id, subscription_id, revision, integration_device_id, workflow_id,
            approval_id, policy_revision, push_detail, categories_json,
            disclosure_categories_json,
            created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'existence', ?, ?, ?, ?)`,
    ).run(
      input.grantId,
      row.subscription_id,
      row.revision,
      row.integration_device_id,
      row.workflow_id,
      input.approvalId,
      input.policyRevision,
      row.privacy_categories_json,
      disclosureCategories,
      input.resolvedAt,
      input.grantExpiresAt,
    );
    const approvedStatus = row.subscription_status === "paused" ? "paused" : "active";
    db.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?").run(
      approvedStatus,
      input.resolvedAt,
      row.subscription_id,
    );
  } else {
    db.prepare("UPDATE subscriptions SET status = 'denied', updated_at = ? WHERE id = ?").run(
      input.resolvedAt,
      row.subscription_id,
    );
  }
  audit(db, {
    subscriptionId: row.subscription_id,
    revision: row.revision,
    eventType: "approval_resolved",
    title: approvalResolutionTitle(input.decision, input.resolvedBy),
    status,
    payload: { approvalId: input.approvalId, resolvedBy: input.resolvedBy.kind },
    createdAt: input.resolvedAt,
  });
  const approval = getSubscriptionApproval(db, input.approvalId);
  if (!approval) throw new Error("resolved approval could not be read back");
  return { outcome: "resolved", approval } as const;
}

export function resolveSubscriptionApproval(
  db: Db,
  input: ResolveSubscriptionApprovalMutation,
): ResolveSubscriptionApprovalMutationResult {
  return db.transaction(() => resolveSubscriptionApprovalInTransaction(db, input))();
}

export function revokeSubscription(
  db: Db,
  input: RevokeSubscriptionMutation,
): RevokeSubscriptionMutationResult {
  return db.transaction(() => {
    const current = db
      .prepare<[string, string], { current_revision: number }>(
        `SELECT current_revision FROM subscriptions
          WHERE id = ? AND integration_device_id = ?`,
      )
      .get(input.subscriptionId, input.integrationDeviceId);
    if (!current) return { outcome: "not_found" } as const;
    db.prepare(
      `UPDATE subscriptions
          SET status = 'revoked', updated_at = ?, revoked_at = ?, revoked_reason = ?
        WHERE id = ?`,
    ).run(input.revokedAt, input.revokedAt, input.reason ?? null, input.subscriptionId);
    db.prepare(
      `UPDATE subscription_grants SET revoked_at = ?
        WHERE subscription_id = ? AND revoked_at IS NULL`,
    ).run(input.revokedAt, input.subscriptionId);
    db.prepare(
      `UPDATE subscription_approvals
          SET status = 'expired', resolved_at = ?
        WHERE subscription_id = ? AND status = 'pending'`,
    ).run(input.revokedAt, input.subscriptionId);
    cancelOpenSubscriptionDeliveries(
      db,
      input.subscriptionId,
      input.revokedAt,
      "subscription revoked",
    );
    audit(db, {
      subscriptionId: input.subscriptionId,
      revision: current.current_revision,
      eventType: "revoked",
      title: "Watch revoked",
      status: "revoked",
      createdAt: input.revokedAt,
    });
    const subscription = getSubscriptionForDevice(
      db,
      input.subscriptionId,
      input.integrationDeviceId,
    );
    if (!subscription) throw new Error("revoked subscription could not be read back");
    return { outcome: "revoked", subscription } as const;
  })();
}

/**
 * Hard-delete a terminal subscription and everything that exists only to serve
 * it: revisions, approvals, grants, firings with their evidence rows,
 * deliveries, the audit ledger, the firing-bound answer-authority
 * bearer tokens, the hidden managed trigger (whose state and firing history
 * cascade with it), and any answer workflow left unreferenced once the
 * subscription is gone.
 *
 * Only `revoked` and `expired` subscriptions qualify. Revocation or expiry is
 * what makes a watch deletable, keeping every hard delete a deliberate second
 * step behind an intentional terminal one — a live watch can never vanish in
 * one call, and a denied watch (which an integration may still revise) must be
 * revoked before it can be purged.
 *
 * There is deliberately no tombstone: purging frees the idempotency key, so an
 * integration may propose a fresh watch under the same `clientRequestId` — it
 * still needs a new approval. Soft audit references to purged firing ids (in
 * answer tasks and egress events) are left dangling by design.
 *
 * The firing-evidence delete guard (store-schema.ts) fires for every evidence
 * row the cascade removes. That guard exists to block deliveries when a
 * document privacy-delete knocks evidence out from under a live firing; here
 * its compensating updates only touch rows of this same subscription, all
 * deleted in this same transaction, so it degrades to a harmless no-op.
 */
export function purgeSubscription(
  db: Db,
  input: PurgeSubscriptionMutation,
): PurgeSubscriptionMutationResult {
  return db.transaction(() => {
    const row = db
      .prepare<[string], { status: string }>("SELECT status FROM subscriptions WHERE id = ?")
      .get(input.subscriptionId);
    if (!row) return { outcome: "not_found" } as const;
    if (row.status !== "revoked" && row.status !== "expired") {
      return { outcome: "not_purgeable", status: row.status as SubscriptionStatus } as const;
    }
    // Every workflow this subscription has ever referenced: revisions may
    // point at replaced workflows the current subscription row no longer
    // names, and those must be considered for garbage collection too.
    const workflowIds = db
      .prepare<[string, string], { workflow_id: string }>(
        `SELECT DISTINCT workflow_id FROM subscription_revisions WHERE subscription_id = ?
         UNION
         SELECT workflow_id FROM subscriptions WHERE id = ?`,
      )
      .all(input.subscriptionId, input.subscriptionId)
      .map((r) => r.workflow_id);
    const counts = db
      .prepare<[string, string], { revisions: number; firings: number }>(
        `SELECT
           (SELECT COUNT(*) FROM subscription_revisions WHERE subscription_id = ?) AS revisions,
           (SELECT COUNT(*) FROM subscription_firings WHERE subscription_id = ?) AS firings`,
      )
      .get(input.subscriptionId, input.subscriptionId);
    // Firing-bound bearer credentials, minted solely to carry one capability
    // each: reading what caused a firing, and reporting what its workflow did.
    // Letting an authority row cascade away on its own would leave a live token
    // with no authority behind it, so the token rows go first (each cascades
    // its own authority row).
    const answerTokensDeleted =
      db
        .prepare(
          `DELETE FROM tokens WHERE id IN (
             SELECT token_id FROM subscription_firing_answer_authorities
              WHERE subscription_id = ?)`,
        )
        .run(input.subscriptionId).changes +
      db
        .prepare(
          `DELETE FROM tokens WHERE id IN (
             SELECT token_id FROM subscription_firing_outcome_authorities
              WHERE subscription_id = ?)`,
        )
        .run(input.subscriptionId).changes;
    db.prepare("DELETE FROM subscriptions WHERE id = ?").run(input.subscriptionId);
    // Garbage-collect workflows nothing references any more. The NOT EXISTS
    // set enumerates every table with a workflow FK that is not a pure child
    // of the workflow row: a residual reference from any of them means the
    // workflow is shared and deleting it would cascade into that owner.
    // See #1564 — a workflow kept alive here is never reaped when its last
    // reference goes away later.
    let workflowsDeleted = 0;
    const deleteOrphanWorkflow = db.prepare(
      `DELETE FROM answer_workflows
        WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.workflow_id = answer_workflows.id)
          AND NOT EXISTS (SELECT 1 FROM subscription_revisions r WHERE r.workflow_id = answer_workflows.id)
          AND NOT EXISTS (SELECT 1 FROM subscription_grants g WHERE g.workflow_id = answer_workflows.id)
          AND NOT EXISTS (SELECT 1 FROM subscription_firings f WHERE f.workflow_id = answer_workflows.id)
          AND NOT EXISTS (SELECT 1 FROM subscription_deliveries d WHERE d.workflow_id = answer_workflows.id)
          AND NOT EXISTS (SELECT 1 FROM subscription_firing_answer_authorities a WHERE a.workflow_id = answer_workflows.id)
          AND NOT EXISTS (SELECT 1 FROM subscription_firing_outcome_authorities o WHERE o.workflow_id = answer_workflows.id)
          AND NOT EXISTS (SELECT 1 FROM answer_conversations c WHERE c.workflow_id = answer_workflows.id)
          AND NOT EXISTS (SELECT 1 FROM answer_tasks t WHERE t.workflow_id = answer_workflows.id)
          AND NOT EXISTS (SELECT 1 FROM answer_workflow_grants wg WHERE wg.workflow_id = answer_workflows.id)`,
    );
    for (const workflowId of workflowIds) {
      workflowsDeleted += deleteOrphanWorkflow.run(workflowId).changes;
    }
    return {
      outcome: "purged",
      purge: {
        subscriptionId: input.subscriptionId,
        status: row.status as "revoked" | "expired",
        revisionsDeleted: counts?.revisions ?? 0,
        firingsDeleted: counts?.firings ?? 0,
        answerTokensDeleted,
        workflowsDeleted,
      },
    } as const;
  })();
}

/**
 * Pause or resume a record that arms no trigger.
 *
 * The same write the trigger-backed path performs, minus the trigger: set the
 * status, cancel anything already in flight when pausing, and leave the audit
 * trail saying what happened. Kept beside its caller rather than folded into it
 * so the trigger-backed path stays readable as one story.
 */
function setStatusWithoutTrigger(
  db: Db,
  input: { subscriptionId: string; integrationDeviceId: string; status: string; updatedAt: number },
  revision: number,
): { outcome: "updated"; subscription: SubscriptionDetail } {
  db.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE id = ?").run(
    input.status,
    input.updatedAt,
    input.subscriptionId,
  );
  if (input.status === "paused") {
    cancelOpenSubscriptionDeliveries(
      db,
      input.subscriptionId,
      input.updatedAt,
      "subscription paused",
    );
  }
  audit(db, {
    subscriptionId: input.subscriptionId,
    revision,
    eventType: input.status === "active" ? "resumed" : "paused",
    title: input.status === "active" ? "Watch resumed" : "Watch paused",
    status: input.status,
    createdAt: input.updatedAt,
  });
  const subscription = getSubscriptionForDevice(
    db,
    input.subscriptionId,
    input.integrationDeviceId,
  );
  if (!subscription) throw new Error("updated subscription could not be read back");
  return { outcome: "updated", subscription } as const;
}

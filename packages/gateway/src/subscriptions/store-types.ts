// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type {
  SubscriptionApprovalDetail,
  SubscriptionApprovalSummary,
  SubscriptionCondition,
  SubscriptionDetail,
  SubscriptionFiringSummary,
  SubscriptionInterpretation,
  SubscriptionPurgeSummary,
  SubscriptionReaction,
  SubscriptionStatus,
  SubscriptionSummary,
  SubscriptionWatchGrounding,
} from "@omnesis/types";
import type { SubscriptionCompiledPlan } from "./store-codecs.js";
import type { PrivacyPolicyRevisionGuard, RecordedAnswerEgress } from "../privacy/store-types.js";
import type { PrivacyReviewRecord } from "@omnesis/types/privacy";
import type { FiringAnswerEvidence } from "../privacy/firing-evidence.js";

export interface CreateSubscriptionMutation {
  id: string;
  approvalId: string;
  workflowId: string;
  integrationDeviceId: string;
  ownerId: string;
  clientRequestId: string;
  requestFingerprint: string;
  condition: SubscriptionCondition;
  reaction: SubscriptionReaction;
  interpretation: SubscriptionInterpretation;
  /** Compile-time watch measurement; omitted when nothing was measured. */
  grounding?: SubscriptionWatchGrounding;
  /** The `subscription_compile` run that produced the plan; omitted when no recorder ran. */
  compileRunId?: string;
  compiledPlan: SubscriptionCompiledPlan;
  compilerVersion: string;
  privacyCategories: string[];
  policyRevision: string;
  createdAt: number;
  expiresAt: number | null;
  approvalExpiresAt: number;
  workflowName: string;
  workflowPurpose: string;
  createWorkflow: boolean;
  workflowExpiresAt: number;
}

export type CreateSubscriptionMutationResult =
  | { outcome: "created"; subscription: SubscriptionDetail }
  | { outcome: "replayed"; subscription: SubscriptionDetail }
  | { outcome: "idempotency_conflict" }
  | { outcome: "workflow_unavailable" };

export interface ReviseSubscriptionMutation {
  subscriptionId: string;
  integrationDeviceId: string;
  expectedRevision: number;
  approvalId: string;
  condition: SubscriptionCondition;
  reaction: SubscriptionReaction;
  interpretation: SubscriptionInterpretation;
  /** Compile-time watch measurement; omitted when nothing was measured. */
  grounding?: SubscriptionWatchGrounding;
  /** The `subscription_compile` run that produced the plan; omitted when no recorder ran. */
  compileRunId?: string;
  compiledPlan: SubscriptionCompiledPlan;
  compilerVersion: string;
  privacyCategories: string[];
  policyRevision: string;
  updatedAt: number;
  expiresAt: number | null;
  approvalExpiresAt: number;
  replacementWorkflow?: {
    id: string;
    name: string;
    purpose: string;
    expiresAt: number;
  };
}

export type ReviseSubscriptionMutationResult =
  | { outcome: "revised"; subscription: SubscriptionDetail }
  | { outcome: "not_found" }
  | { outcome: "stale_revision" }
  | { outcome: "terminal" };

export type SetSubscriptionStatusMutationResult =
  | { outcome: "updated"; subscription: SubscriptionDetail }
  | { outcome: "not_found" }
  | { outcome: "stale_revision" }
  | { outcome: "grant_unavailable" }
  | { outcome: "semantic_unavailable" }
  | { outcome: "terminal" };

/**
 * What resolved a subscription approval. `device` is the operator acting from
 * a paired client. `policy` is the privacy reviewer's decision under the
 * current policy, which has no device or token behind it — attributing it to the
 * integration device that proposed the watch would record the agent as having
 * approved its own request. `operator` is the operator's own conversational
 * request: an operator watch delivers to their own phone and crosses no
 * egress boundary, so asking for it IS approving it — there is no separate
 * device tap to attribute.
 *
 * All consumers of this union are exhaustive, so a new authority is a
 * compile error until it says what the audit trail calls it and which device,
 * if any, the ledger attributes it to.
 */
export type SubscriptionApprovalResolvedBy =
  | { kind: "device"; deviceId: string | null; tokenId: string | null }
  | { kind: "policy" }
  | { kind: "operator" };

export interface ResolveSubscriptionApprovalMutation {
  approvalId: string;
  decision: "approve" | "deny";
  resolvedBy: SubscriptionApprovalResolvedBy;
  policyRevision: string;
  policyGuard?: PrivacyPolicyRevisionGuard;
  expectedAnswerDisclosureRevision?: number;
  expectedExistenceDisclosureRevision?: number;
  grantId: string;
  grantExpiresAt: number;
  resolvedAt: number;
}

export type ResolveSubscriptionApprovalMutationResult =
  | { outcome: "resolved"; approval: SubscriptionApprovalDetail }
  | { outcome: "not_found" }
  | { outcome: "already_resolved" }
  | { outcome: "expired" }
  | { outcome: "stale_revision" }
  | { outcome: "policy_changed" }
  | { outcome: "disclosure_changed" }
  | { outcome: "semantic_unavailable" }
  | { outcome: "terminal" };

interface RecordSubscriptionPrivacyReviewMutationBase {
  subscriptionId: string;
  approvalId: string;
  revision: number;
  policyRevision: string;
  policyGuard?: PrivacyPolicyRevisionGuard;
  expectedAnswerDisclosureRevision: number;
  expectedExistenceDisclosureRevision: number;
  review: PrivacyReviewRecord;
  reviewedAt: number;
}

export type RecordSubscriptionPrivacyReviewMutation =
  | (RecordSubscriptionPrivacyReviewMutationBase & { decision: "ask" })
  | (RecordSubscriptionPrivacyReviewMutationBase & {
      decision: "allow" | "deny";
      grantId: string;
      grantExpiresAt: number;
      resolvedAt: number;
    });

export type RecordSubscriptionPrivacyReviewMutationResult =
  | { outcome: "recorded" }
  | ResolveSubscriptionApprovalMutationResult;

export interface RevokeSubscriptionMutation {
  subscriptionId: string;
  integrationDeviceId: string;
  revokedAt: number;
  /**
   * Why the record was revoked, when something other than a person revoked it.
   *
   * Absent means a person: the operator taking a watch back, or the integration
   * that owns it withdrawing its own. That is a decision, and every repair path
   * treats it as one — a machine may not overturn it.
   *
   * A machine that revokes as a step of a larger change says so here, so the
   * half-finished change it is a step of can be recognised later and completed
   * rather than mistaken for somebody's answer. The Watch V2 wake anchors are
   * the one writer that does — see `MACHINE_ANCHOR_RETIREMENT` in
   * `watch/anchors.ts`.
   */
  reason?: string;
}

export interface PurgeSubscriptionMutation {
  subscriptionId: string;
}

export type PurgeSubscriptionMutationResult =
  | { outcome: "purged"; purge: SubscriptionPurgeSummary }
  | { outcome: "not_found" }
  /** The subscription is not terminal; revoke it first. */
  | { outcome: "not_purgeable"; status: SubscriptionStatus };

export interface EnqueueSubscriptionEvaluationMutation {
  id: string;
  subscriptionId: string;
  revision: number;
  documentId: string;
  /**
   * The part of `documentId` the candidate was nominated on — an attachment
   * attributed to the record it arrived on. `null` when the nominated document
   * is its own subject. The verdict may name it as evidence beside the
   * subject; nothing else in the evaluation changes.
   */
  matchedDocumentId: string | null;
  indexEventKey: string;
  similarity: number;
  createdAt: number;
}

export type EnqueueSubscriptionEvaluationMutationResult =
  | { outcome: "enqueued"; evaluationId: string }
  | { outcome: "existing"; evaluationId: string }
  | { outcome: "ineligible" };

/** Trusted evaluator input. Contains the private plan and corpus document id. */
export interface SubscriptionEvaluationDetail {
  id: string;
  subscriptionId: string;
  revision: number;
  documentId: string;
  /** The nominated part of `documentId`, or `null` when there was none. */
  matchedDocumentId: string | null;
  indexEventKey: string;
  similarity: number;
  attempts: number;
  condition: SubscriptionCondition;
  compiledPlan: SubscriptionCompiledPlan;
  policyRevision: string;
  /**
   * Whether the subscription delivers by iOS push (an operator watch). The
   * verdict procedure is identical either way; only the exit gates differ —
   * an operator watch's settle is not fenced on live-policy currency.
   */
  operatorWatch: boolean;
}

export type SubscriptionEvaluationStatus =
  | "pending"
  | "evaluating"
  | "matched"
  | "not_matched"
  | "retry"
  | "failed";

/**
 * Operator-facing record of one candidate judgment: what the prefilter
 * selected, what the evaluator decided, and why. Similarity scores and
 * rationales describe the owner's corpus rather than the existence signal a
 * subscriber was granted, so this projection is admin-only.
 */
export interface SubscriptionEvaluationJudgment {
  id: string;
  subscriptionId: string;
  revision: number;
  documentId: string;
  indexEventKey: string;
  similarity: number;
  status: SubscriptionEvaluationStatus;
  attempts: number;
  rationale: string | null;
  evaluatorModel: string | null;
  createdAt: number;
  /** When the judgment reached its current status. */
  updatedAt: number;
}

/** Minimal trusted prompt context: no reaction, grant, audit, or policy payload. */
export interface SubscriptionEvaluationPromptContext {
  evaluationId: string;
  subscriptionId: string;
  revision: number;
  documentId: string;
  indexEventKey: string;
  conditionDescription: string;
  semanticQuery: string;
}

export interface FireSubscriptionMutation {
  firingId: string;
  subscriptionId: string;
  revision: number;
  indexEventKey: string;
  evidenceDocumentIds: string[];
  policyRevision: string;
  firedAt: number;
  /**
   * What the plan recorded as satisfying the condition, for a firing that
   * carries no documents. Captured now because a query run when the agent
   * finally asks can return a different row, or none.
   */
  observation?: Record<string, unknown>;
}

export type FireSubscriptionMutationResult =
  | { outcome: "fired"; firingId: string }
  | { outcome: "duplicate"; firingId: string }
  | {
      outcome: "not_found" | "inactive" | "stale_revision" | "grant_unavailable" | "expired";
    };

export interface ClaimSubscriptionDeliveriesMutation {
  claimedAt: number;
  policyRevision: string;
  limit: number;
  leaseMs: number;
  maxAttempts: number;
}

/**
 * Private identifier-only delivery material. The caller adds a freshly issued
 * firing-bound answer token immediately before transport; no evidence or
 * compiled matching plan can enter the wire payload.
 */
export interface ClaimedSubscriptionDelivery {
  id: string;
  claimId: string;
  attempt: number;
  firingId: string;
  subscriptionId: string;
  revision: number;
  integrationDeviceId: string;
  workflowId: string;
  ownerId: string;
  /** The revision's reaction — what the delivery adapter dispatches on. */
  reaction: SubscriptionReaction;
  claimedAt: number;
  claimExpiresAt: number;
  /**
   * `prepare` durably stages the private wake before a final authority check.
   * `commit` resumes a wake whose disclosure was already atomically
   * authorized, for example after a lost WebSocket acknowledgement.
   */
  phase: "prepare" | "commit" | "cancel";
}

export interface AuthorizeSubscriptionDeliveryCommitMutation {
  deliveryId: string;
  claimId: string;
  policyRevision: string;
  /**
   * Synchronous commit-boundary guard for direct edits to the policy file.
   * API policy writes are also serialized around this mutation by the caller.
   */
  policyGuard?: PrivacyPolicyRevisionGuard;
  authorizedAt: number;
}

export type AuthorizeSubscriptionDeliveryCommitMutationResult =
  | { outcome: "authorized" }
  | {
      outcome:
        | "not_found"
        | "stale_claim"
        | "inactive"
        | "stale_revision"
        | "grant_unavailable"
        | "policy_changed"
        | "expired"
        | "authority_unavailable";
    };

export interface SettleSubscriptionDeliveryMutation {
  deliveryId: string;
  claimId: string;
  settledAt: number;
  outcome:
    | { kind: "delivered"; acceptedAt: number; localRunId: string }
    /**
     * An iOS push reached at least one of the operator's devices. Same
     * delivered end state, but settled straight from `claimed`: a push has
     * no remote staging, so it never crosses the wake protocol's
     * prepare/commit boundary. `localRunId` is the trigger-firing row the
     * push embeds for the notification tap to deep-link to.
     */
    | { kind: "pushed"; acceptedAt: number; localRunId: string }
    | { kind: "retry"; nextAttemptAt: number; error: string }
    | { kind: "retry_commit"; nextAttemptAt: number; error: string }
    | { kind: "retry_cancel"; nextAttemptAt: number; error: string }
    | { kind: "queue_cancel"; nextAttemptAt: number; error: string }
    | { kind: "parked"; nextAttemptAt: number; error: string }
    | { kind: "failed"; error: string }
    | { kind: "failed_commit"; error: string; code: string }
    | { kind: "cancelled"; cancelledAt: number }
    | {
        kind: "manual_review";
        phase: "commit" | "cancel";
        error: string;
        code: "ambiguous_start" | "cancel_too_late";
      };
}

export type SettleSubscriptionDeliveryMutationResult =
  | {
      outcome: "settled";
      status: "retry" | "manual_review" | "delivered" | "failed";
    }
  | { outcome: "not_found" | "stale_claim" };

/** What a woken run reports back when it ends. */
export type WorkflowOutcomeStatus = "completed" | "nothing_to_do" | "failed" | "deferred";

export interface IssueSubscriptionFiringOutcomeAuthorityMutation {
  id: string;
  deliveryId: string;
  tokenId: string;
  createdAt: number;
  expiresAt: number;
}

export type IssueSubscriptionFiringOutcomeAuthorityMutationResult =
  | { outcome: "issued"; firingId: string }
  | { outcome: "not_found" | "token_unavailable" };

export interface RecordSubscriptionFiringOutcomeMutation {
  tokenId: string;
  firingId: string;
  status: WorkflowOutcomeStatus;
  report?: string;
  reportedAt: number;
}

export type RecordSubscriptionFiringOutcomeMutationResult =
  | { outcome: "recorded"; runs: number }
  | { outcome: "not_found" | "revoked" | "expired" | "too_many_reports" };

export interface IssueSubscriptionFiringAnswerAuthorityMutation {
  id: string;
  deliveryId: string;
  claimId: string;
  tokenId: string;
  policyRevision: string;
  /** Omitted for the initial pre-commit preparation. */
  phase?: "prepare" | "commit_refresh";
  policyGuard?: PrivacyPolicyRevisionGuard;
  createdAt: number;
  expiresAt: number;
}

export type IssueSubscriptionFiringAnswerAuthorityMutationResult =
  | {
      outcome: "issued";
      authority: SubscriptionFiringAnswerAuthority;
    }
  | {
      outcome:
        | "not_found"
        | "stale_claim"
        | "inactive"
        | "stale_revision"
        | "grant_unavailable"
        | "policy_changed"
        | "expired"
        | "token_unavailable";
    };

export interface SubscriptionFiringAnswerAuthority {
  id: string;
  tokenId: string;
  deliveryId: string;
  firingId: string;
  subscriptionId: string;
  revision: number;
  workflowId: string;
  ownerId: string;
  /**
   * Private evidence bound to the immutable firing. This is consumed only
   * inside the gateway's Answer boundary and never enters a wake payload or
   * public subscription response.
   */
  evidenceDocumentIds: string[];
  firingEvidence: FiringAnswerEvidence;
  policyRevision: string;
  createdAt: number;
  expiresAt: number;
  firstUsedAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  consumedAt: number | null;
  revokedAt: number | null;
}

export type SubscriptionFiringAnswerAuthorityRejection =
  | "not_found"
  | "expired"
  | "revoked"
  | "consumed"
  | "inactive"
  | "stale_revision"
  | "grant_unavailable"
  | "policy_changed";

export type ValidateSubscriptionFiringAnswerAuthorityResult =
  | { outcome: "authorized"; authority: SubscriptionFiringAnswerAuthority }
  | { outcome: SubscriptionFiringAnswerAuthorityRejection };

export interface UseSubscriptionFiringAnswerAuthorityMutation {
  tokenId: string;
  firingId: string;
  policyRevision: string;
  usedAt: number;
  /** Normal workflow follow-ups leave this false so authority lasts until TTL. */
  consume?: boolean;
}

export interface FinalizeSubscriptionFiringAnswerEgressMutation {
  tokenId: string;
  firingId: string;
  policyRevision: string;
  taskId: string;
  ownerId: string;
  egressId: string;
  recordedAt: number;
}

export type FinalizeSubscriptionFiringAnswerEgressMutationResult =
  | { outcome: "recorded"; egress: RecordedAnswerEgress }
  | {
      outcome:
        | SubscriptionFiringAnswerAuthorityRejection
        | "task_scope_mismatch"
        | "task_unreleased";
    };

export interface SettleSubscriptionEvaluationMutation {
  evaluationId: string;
  decision: "matched" | "not_matched";
  rationale: string;
  evaluatorModel: string;
  settledAt: number;
  firing?: Omit<FireSubscriptionMutation, "subscriptionId" | "revision" | "indexEventKey">;
}

export type SettleSubscriptionEvaluationMutationResult =
  | { outcome: "settled"; firingId: string | null }
  | { outcome: "not_found" | "not_claimed" | "firing_required" }
  /** The verdict named a document other than the one the evaluation covers. */
  | { outcome: "evidence_mismatch" }
  | Exclude<FireSubscriptionMutationResult, { outcome: "fired" | "duplicate" }>;

export type RevokeSubscriptionMutationResult =
  | { outcome: "revoked"; subscription: SubscriptionDetail }
  | { outcome: "not_found" };

export interface StoredSubscriptionRow {
  id: string;
  integration_device_id: string;
  workflow_id: string;
  current_revision: number;
  status: SubscriptionStatus;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  condition_json: string;
  reaction_json: string;
  interpretation_json: string;
  compile_run_id: string | null;
  privacy_categories_json: string;
  policy_revision: string;
  integration_name: string;
  integration_kind: string;
  workflow_name: string;
  workflow_purpose: string;
  revoked_at: number | null;
  firing_count: number;
  last_fired_at: number | null;
}

export interface StoredSubscriptionApprovalRow {
  id: string;
  subscription_id: string;
  revision: number;
  status: SubscriptionApprovalSummary["status"];
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
  workflow_id: string;
  integration_device_id: string;
  condition_json: string;
  reaction_json: string;
  interpretation_json: string;
  grounding_json: string | null;
  privacy_categories_json: string;
  policy_revision: string;
  integration_name: string;
  integration_kind: string;
  workflow_name: string;
  workflow_purpose: string;
}

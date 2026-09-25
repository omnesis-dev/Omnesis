// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
import type {
  AnswerResponse,
  PrivacyAuditEventDisplay,
  PrivacyAuditEventKind,
  PrivacyReviewRecord,
} from "@omnesis/types/privacy";

export type PrivacyDb = Database.Database;

export class PrivacyCursorError extends Error {
  constructor(message = "Invalid privacy pagination cursor.") {
    super(message);
    this.name = "PrivacyCursorError";
  }
}

export const DENIED_TRANSCRIPT_MARKER =
  "No answer was released because the Omnesis privacy boundary denied this request.";

export type AnswerTaskState =
  | "running"
  | "approval_required"
  | "released"
  | "released_with_reductions"
  | "denied"
  | "failed"
  | "canceled";

export interface BeginAnswerTaskInput {
  ownerId: string;
  workflowId?: string;
  conversationId?: string;
  clientRequestId: string;
  question: string;
  workflowName?: string;
  workflowPurpose?: string;
  approvalMode?: "allow" | "never";
  /** Exact immutable subscription firing scope, when this is a firing answer. */
  subscriptionFiringId?: string;
  completionRoute?: AnswerCompletionRoute;
  ids: {
    workflowId: string;
    conversationId: string;
    taskId: string;
  };
  now: number;
  workflowExpiresAt: number;
}

/** Trusted native conversation route, supplied by an integration plugin. */
export interface AnswerCompletionRoute {
  integrationDeviceId: string;
  nativeConversationId: string;
}

export interface AnswerCompletionDelivery {
  id: string;
  taskId: string;
  integrationDeviceId: string;
  nativeConversationId: string;
  status: "pending" | "claimed" | "retry" | "commit_authorized" | "delivered" | "failed";
  attempts: number;
  claimId: string | null;
  claimExpiresAt: number | null;
}

export interface ClaimAnswerCompletionDeliveriesInput {
  now: number;
  limit: number;
  leaseMs: number;
  maxAttempts: number;
}

export interface ClaimedAnswerCompletionDelivery extends AnswerCompletionDelivery {
  claimId: string;
  attempt: number;
  claimExpiresAt: number;
  phase: "prepare" | "commit";
}

export interface AuthorizeAnswerCompletionDeliveryInput {
  deliveryId: string;
  claimId: string;
  now: number;
}

export interface SettleAnswerCompletionDeliveryInput {
  deliveryId: string;
  claimId: string;
  now: number;
  outcome:
    | { kind: "delivered"; acceptedAt: number; localRunId: string }
    | { kind: "retry"; nextAttemptAt: number; error: string }
    | { kind: "failed"; error: string };
}
export interface BegunAnswerTask {
  workflowId: string;
  workflowPurpose: string;
  conversationId: string;
  taskId: string;
  duplicate: boolean;
  state: AnswerTaskState;
}

export interface CompleteAnswerTaskInput {
  taskId: string;
  ownerId: string;
  review: PrivacyReviewRecord;
  now: number;
  outcome:
    | {
        kind: "release";
        releaseId: string;
        answer: string;
        expectedDisclosureRevision: number;
        expectedExistenceDisclosureRevision?: number;
        policyGuard?: PrivacyPolicyRevisionGuard;
      }
    | {
        kind: "reduce";
        releaseId: string;
        answer: string;
        reductions: string[];
        expectedDisclosureRevision: number;
        expectedExistenceDisclosureRevision?: number;
        policyGuard?: PrivacyPolicyRevisionGuard;
      }
    | {
        kind: "approval";
        approvalId: string;
        candidateAnswer: string;
        candidateDigest: string;
        releaseStatus: "released" | "released_with_reductions";
        reductions: string[];
        expiresAt: number;
      }
    | { kind: "deny"; reason: "privacy_policy" | "hard_stop" | "approval_not_available" };
}

export interface PrivacyPolicyRevisionGuard {
  path: string;
  expectedRevision: string;
  /** Normalized text digest; revision tokens are deliberately not content-addressed. */
  expectedDigest?: string;
}

export type ResolveApprovalAction = "approve" | "deny";

export interface ApprovalResolutionRequestContext {
  requestId: string;
  tokenId: string | null;
  deviceId: string | null;
}

export interface ResolveApprovalInput {
  approvalId: string;
  action: ResolveApprovalAction;
  requestContext: ApprovalResolutionRequestContext;
  releaseId: string;
  now: number;
}

export interface TaskDbRow {
  id: string;
  workflow_id: string;
  conversation_id: string;
  owner_id: string;
  client_request_id: string;
  request_fingerprint: string;
  subscription_firing_id: string | null;
  completion_device_id: string | null;
  completion_native_conversation_id: string | null;
  question: string;
  status: AnswerTaskState;
  candidate_answer: string | null;
  candidate_digest: string | null;
  policy_revision: string | null;
  review_json: string | null;
  reductions_json: string | null;
  release_id: string | null;
  approval_id: string | null;
  denial_reason: string | null;
  created_at: number;
  resolved_at: number | null;
}

export interface ApprovalJoinedRow extends TaskDbRow {
  approval_status: string;
  approval_created_at: number;
  approval_expires_at: number;
  approval_resolved_at: number | null;
  workflow_name: string;
  workflow_purpose: string;
  approval_candidate_answer: string | null;
  approval_release_status: "released" | "released_with_reductions";
  approval_reductions_json: string;
}

export interface DecisionJoinedRow extends TaskDbRow {
  release_answer: string | null;
  approval_status: string | null;
  approval_expires_at: number | null;
}

export interface ConversationAvailabilityRow {
  owner_id: string;
  active_task_id: string | null;
}

export interface AnswerRequestIdentity {
  question: string;
  workflowId?: string;
  conversationId?: string;
  workflowName?: string;
  workflowPurpose?: string;
  approvalMode?: "allow" | "never";
  subscriptionFiringId?: string;
}

export interface AppendAnswerAuditEventInput {
  id: string;
  taskId: string;
  ownerId: string;
  kind: PrivacyAuditEventKind;
  display: PrivacyAuditEventDisplay;
  payload?: unknown;
  now: number;
}

export type AnswerEgressEndpoint =
  | "/answer"
  | "/answer/tasks/:id"
  | "/mcp"
  | "/subscriptions/firings/:id/answer";

export interface RecordAnswerEgressInput {
  id: string;
  taskId: string;
  ownerId: string;
  endpoint: AnswerEgressEndpoint;
  now: number;
  subscriptionFiringId?: string;
  /** External MCP egress atomically revalidates and attributes delegated authority. */
  mcpInvocationAudit?: import("../access/types.js").McpToolInvocationAuditInput;
  /**
   * A device token's `/answer` egress atomically revalidates that the token
   * still holds `ownerId`: live, on a device that is not revoked, whose access
   * level — or lack of one — still gives the scope the answer was made under.
   */
  deviceAnswerAuthority?: { deviceId: string; tokenId: string };
}

export interface RecordedAnswerEgress {
  response: AnswerResponse;
  responseJson: string;
}

export interface DeletePrivacyConversationInput {
  conversationId: string;
  now: number;
}

export const ANSWER_STORE_ERROR_CODES = [
  "workflow_not_found",
  "workflow_expired",
  "workflow_closed",
  "conversation_not_found",
  "conversation_deleted",
  "owner_mismatch",
  "conversation_busy",
  "conversation_running",
  "disclosure_changed",
  "policy_changed",
  "egress_limit",
  "task_not_found",
  "task_state_conflict",
  "approval_not_found",
  "idempotency_conflict",
  "authority_changed",
] as const;

export type AnswerStoreErrorCode = (typeof ANSWER_STORE_ERROR_CODES)[number];

const answerStoreErrorCodes = new Set<string>(ANSWER_STORE_ERROR_CODES);

export class AnswerStoreError extends Error {
  constructor(
    readonly code: AnswerStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AnswerStoreError";
  }
}

export function rehydrateAnswerStoreError(error: unknown): AnswerStoreError | null {
  if (error instanceof AnswerStoreError) return error;
  if (!(error instanceof Error) || error.name !== "AnswerStoreError") return null;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== "string" || !answerStoreErrorCodes.has(code)) return null;
  return new AnswerStoreError(code as AnswerStoreErrorCode, error.message);
}

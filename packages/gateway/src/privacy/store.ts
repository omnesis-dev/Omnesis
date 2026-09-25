// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Stable public facade for the external-answer privacy store.
 *
 * Implementation is split by concern:
 * - `store-types.ts` owns the public contracts, errors, and persisted row types.
 * - `store-schema.ts` owns idempotent table/index creation.
 * - `store-mutations.ts` owns workflow, task, approval, expiry, and recovery transitions.
 * - `store-queries.ts` owns released history and operator-facing projections.
 * - `store-internals.ts` owns shared SQL primitives and response reconstruction.
 *
 * Keep public imports pointed at this module. New persistence work belongs in
 * the focused collaborators above; this facade preserves the existing surface.
 */

export {
  createAnswerApprovalListIndexes,
  createAnswerPrivacyTables,
  createDirectAuditTables,
} from "./store-schema.js";

export {
  beginAnswerTask,
  completeAnswerTask,
  expirePrivacyApprovals,
  failAnswerTask,
  recoverInterruptedAnswerTasks,
  resolvePrivacyApproval,
} from "./store-mutations.js";
export type { AnswerFailureSummary } from "./store-mutations.js";

export {
  authorizeAnswerCompletionDelivery,
  claimAnswerCompletionDeliveries,
  settleAnswerCompletionDelivery,
} from "./completion-delivery-store.js";

export {
  getAnswerTaskResponse,
  getPrivacyApproval,
  listPrivacyApprovalPage,
  listPrivacyApprovals,
  listPrivacyDecisions,
  loadReleasedAnswerHistory,
} from "./store-queries.js";
export type { PrivacyApprovalPage } from "./store-queries.js";

export {
  appendDirectAuditEvent,
  deleteDirectAuditSession,
  directAuditSessionExists,
  getDirectAuditEvent,
  listDirectAuditEvents,
  listDirectAuditSessions,
} from "./direct-audit.js";
export type {
  AppendDirectAuditEventInput,
  DirectAuditEvent,
  DirectAuditEventDetail,
  DirectAuditSession,
} from "./direct-audit.js";
export { DIRECT_HEURISTIC_SESSION_GAP_MS, directSessionKeys } from "./direct-session.js";
export type { DirectSessionKeys, DirectSessionRequest } from "./direct-session.js";

export {
  MAX_DISTINCT_ANSWER_EGRESS_RESPONSES_PER_TASK,
  appendAnswerAuditEvent,
  appendAnswerAuditEvents,
  auditDisplay,
  deletePrivacyConversation,
  getPrivacyAuditEvent,
  getPrivacyConversation,
  listPrivacyAuditEvents,
  listPrivacyConversations,
  loadPrivacyReviewerContext,
  loadWorkflowCumulativeDisclosure,
  recordAnswerEgress,
} from "./store-audit.js";

export {
  PRIVACY_REVIEWER_HEALTH_FAILURE_THRESHOLD,
  PRIVACY_REVIEWER_HEALTH_WINDOW_MS,
  getPrivacyReviewerHealth,
  listPrivacyExchangeFeed,
  listPrivacyExchangePresentations,
  privacyExternalAgentIdentities,
  privacyExternalAgentIdentity,
} from "./presentation.js";

export { advanceWorkflowDisclosure, digestCandidate, parseReview } from "./store-internals.js";

export {
  ANSWER_STORE_ERROR_CODES,
  AnswerStoreError,
  PrivacyCursorError,
  DENIED_TRANSCRIPT_MARKER,
  rehydrateAnswerStoreError,
  type AnswerStoreErrorCode,
  type AnswerTaskState,
  type ApprovalResolutionRequestContext,
  type BeginAnswerTaskInput,
  type AnswerCompletionDelivery,
  type ClaimedAnswerCompletionDelivery,
  type ClaimAnswerCompletionDeliveriesInput,
  type AuthorizeAnswerCompletionDeliveryInput,
  type SettleAnswerCompletionDeliveryInput,
  type BegunAnswerTask,
  type CompleteAnswerTaskInput,
  type AppendAnswerAuditEventInput,
  type DeletePrivacyConversationInput,
  type RecordAnswerEgressInput,
  type RecordedAnswerEgress,
  type ResolveApprovalAction,
  type ResolveApprovalInput,
} from "./store-types.js";

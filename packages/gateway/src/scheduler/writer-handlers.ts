// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { promoteSourceWireContract } from "../data/repositories/SourceWireContractRepository.js";
import { replaceSourceSyncIssues } from "../data/repositories/SourceSyncIssueRepository.js";
import {
  type SyncIssue,
  type SyncIssueAssessment,
  DeviceId,
  SourceId,
  TokenId,
  type DocumentInput,
  type PersonMention,
  type Scope,
  type DeviceCapability,
  type DeviceKind,
  type AccountId,
  type ApnsRegistration,
  type FcmRegistration,
  type DeviceUpdateState,
  type NotificationDeliveryHealth,
  type SourceType,
  type MultiDeviceMode,
  type SyncRemediation,
} from "@omnesis/types";
import {
  preparePendingSourcePage,
  acknowledgePendingSourcePage,
  type PreparePendingSourcePage,
} from "../data/repositories/PendingSourcePageRepository.js";

/**
 * Single source of truth for every writer op the worker can dispatch.
 *
 * One map (`writerHandlers`) holds the (opName → handler-with-db) pairs.
 * Yieldable variants live in `writerYieldableHandlers` (handler takes a
 * `PreemptToken` after `db`).
 *
 * Consumed by:
 *  - `workers/writer-worker.ts` — spreads this map as its dispatch table
 *  - `write-ops.ts`              — types `WRITE_OP_DEFS[].name` as
 *                                  `WriterOpName`, catching typos and
 *                                  enforcing every op has a Task def
 *  - `write-gate.ts`             — types the `call<K>(op, args)`
 *                                  factory so caller-args match the
 *                                  handler's expected shape
 *
 * Adding a new writer op is a one-edit change: declare the handler here.
 * The other three places fail to compile until they're updated.
 */

import type Database from "better-sqlite3";
import { advanceOccWatermark } from "../data/occ-materialized.js";
import { beginLinkDeclarationUpdate, finishLinkDeclarationUpdate } from "../data/list-revisions.js";
type Db = Database.Database;

// DF applies can span millions of rows. Return to the scheduler frequently
// even when no higher-priority task has requested preemption, so queued writes
// at the same priority are not trapped behind the entire rebuild.
const NEAR_DUP_DF_APPLY_SLICE_MS = 100;

import { type SourceSyncMeta, type SyncCursor } from "@omnesis/source-sdk";

// Handlers import from canonical homes, not the
// (`./people.js`, `./links.js`) wrapper shells. The shells stay for
// route/service-layer callers; here we make the writer's surface
// area auditable in one place. The 3 own-logic functions still in
// `people.ts` (`runMergePass`, `collapseTransitiveChains`,
// `upsertTransitiveCollapse`) keep their `../people.js` import below
// — they move out under merge-service-decomposition.
import {
  applySourceUrlRecanonicalizationPage,
  finishSourceUrlRecanonicalization,
  type SourceUrlRecanonicalizationCursor,
  type SourceUrlRecanonicalizationMutation,
} from "../domain/SourceUrlRecanonicalization.js";
import {
  issueSubscriptionFiringOutcomeAuthority,
  recordSubscriptionFiringOutcome,
} from "../subscriptions/store-outcome-mutations.js";
import {
  authorizeSubscriptionDeliveryCommit,
  claimSubscriptionDeliveries,
  createSubscription,
  fireSubscription,
  issueSubscriptionFiringAnswerAuthority,
  purgeSubscription,
  recordSubscriptionPrivacyReview,
  resolveSubscriptionApproval,
  revokeSubscription,
  setSubscriptionStatus,
  settleSubscriptionDelivery,
  useSubscriptionFiringAnswerAuthority,
  finalizeSubscriptionFiringAnswerEgress,
  expireSubscriptions,
  reconcileSubscriptionsPolicy,
} from "../subscriptions/store-mutations.js";
import {
  pruneActivityRetentionBatch,
  reclaimActivityRetentionPages,
  type ActivityRetentionPhase,
} from "../activity-retention/store.js";
import { refreshSqliteTableStats } from "../sqlite-catalog.js";
import {
  cleanupExpiredAccessStateBatch,
  createAuthorizationRequest,
  createExecutionBinding,
  decideAuthorizationRequest,
  exchangeOAuthToken,
  issueAuthorizationCode,
  issueAuthorizationCodeById,
  enqueueAccessAuthorizationNotification,
  recordMcpToolInvocationAudit,
  registerOAuthClient,
  reissueExecutionDeviceTokens,
  renameAccessPrincipal,
  upsertOAuthMetadataClient,
  revokeAccessEntity,
  touchPrincipalCredentialUsageBatch,
  updateAccessGrant,
  updateAccessLevel,
  createAccessLevel,
  deleteAccessLevel,
  setConnectionLevel,
  setDeviceLevel,
  type AccessCleanupPhase,
  type OAuthClientCleanupCursor,
} from "../access/store.js";
import { currentDeviceAnswerOwner } from "../access/device-answer-scope.js";
import {
  upsertMergeCandidates,
  acceptMergeCandidate,
  applyMergeAdjudication,
  autoApproveHighConfidenceCandidates,
  denyMergeCandidate,
  sweepCollapsedMergeCandidates,
  pruneSuppressedMergeCandidates,
  reconcilePendingMergeCandidates,
  upsertTokenLabels,
  mergeCluster,
  type ApplyMergeAdjudicationInput,
  type MergeCandidateProposal,
  type TokenLabelRow,
  type AcceptMergeCandidateInput,
} from "../merge-candidates.js";
import {
  upsertLinkStats,
  reconcileLinkStatsCounters,
} from "../data/repositories/LinkStatsRepository.js";
import {
  reconcileUnresolvedLinks,
  upsertLinkResolutionsYieldable,
  type LinkReconcileApplyState,
  type LinkReconcileBatch,
} from "../domain/LinkGraphService.js";
import { applyExtractedDates } from "../enrichment/dates/storage.js";
import {
  insertTemporalAnnotation,
  updateTemporalAnnotation,
  invalidateTemporalAnnotation,
  invalidateTemporalAnnotationsForDoc,
  markTemporalAnnotationsRefilePresented,
  cascadeTemporalAnnotationPrivacyDelete,
  type CreateTemporalAnnotationInput,
  type UpdateTemporalAnnotationPatch,
  type TemporalAnnotationInvalidationResult,
} from "../enrichment/temporal-annotations/storage.js";
import { addToCognitionEngineCounter } from "../brain/storage/engine-state.js";
import {
  markDocsBootstrapProcessed,
  readmitFailedBootstrapDoc,
} from "../brain/storage/bootstrap.js";
import {
  recordCognitionCoverage,
  retractOrphanCognitionCoverage,
  type CognitionCoverageDelta,
} from "../brain/storage/coverage.js";
import { recordSweepTally, type SweepTallyDelta } from "../brain/storage/sweep-tally.js";
import { drainPendingEdges } from "../domain/EdgeDeclarationWriter.js";
import { upsertExtractedLinksBatch } from "../domain/LinkExtraction.js";
import { physicalDedupSharedAliases, type PhysicalDedupResumeState } from "../physical-merge.js";
import { pruneNoreplyAliases } from "../bootstrap/prune-noreply-aliases.js";
import { upgradePlaceholderCanonicalNames } from "../bootstrap/upgrade-placeholder-canonical-names.js";
import { demoteSharedAddresses } from "../domain/SharedAddressDemotion.js";
import { reconcileSelfFromConfig } from "../domain/SelfIdentity.js";
import {
  runMergePass,
  collapseTransitiveChains,
  upsertTransitiveCollapse,
  type TransitiveCollapseRow,
} from "../people.js";
import {
  markPeopleGraphDirty,
  markLinkStatsDirty,
  markNearDupDfDirty,
} from "../data/DirtyMarks.js";
import { upsertInteractionScores } from "../domain/InteractionScoreService.js";
import {
  refreshPeopleCounts,
  upsertPeopleCounts,
  zeroPeopleCountsForLosers,
  recomputeNamePrimaries,
} from "../data/repositories/PersonRepository.js";
import {
  mergePeople,
  unmergePerson,
  rebuildPeopleFromDocuments,
  createMergeRule,
  deleteMergeRule,
  deleteMergeRuleGroup,
  upsertAutoDetectedRules,
  upsertMergeEquivalences,
  type RebuildPhase,
  type AutoDetectedRule,
  type AutoDetectUpsertResumeState,
  type CreateMergeRuleInput,
  type MergeEquivalenceSnapshot,
} from "../domain/MergeService.js";
import {
  seedFromContacts,
  upsertSeedFromContacts,
  detectSelfFromSourceIds,
} from "../domain/ContactCardBootstrap.js";
import {
  findOrCreatePerson,
  resolveDocumentPeople,
  backfillManyPeople,
} from "../domain/PeopleResolutionService.js";
import {
  upsertDocuments,
  upsertWithCursorYieldable,
  deleteDocuments,
  cascadeOpenLoopPrivacyDeleteWithMirrors,
  deleteDocumentForUser,
  deleteDocumentForRetention,
  completeDocumentRetention,
  applySnapshotAbsencePlan,
  applyReplicaOmissions,
  type ReplicaOmissionArgs,
  judgeAnalyticsTombstones,
  recordAnalyticsPresence,
  recordAnalyticsRestorerOmissions,
  recordAnalyticsSweepVerdict,
  type AnalyticsTombstoneArgs,
  type AnalyticsPresenceArgs,
  type AnalyticsRestorerSnapshotArgs,
  type AnalyticsSweepVerdict,
  reclaimStaleAbsences,
  acknowledgeAbsenceCascade,
  deleteDocumentsByIds,
  sweepDueAbsences,
  type SnapshotAbsencePlan,
  type StaleAbsenceCandidate,
  deleteAllBySource,
  deleteAllByStream,
  deleteAllByProvider,
  markSourceStatsDirty,
  refreshSourceStatsRow,
  upsertSourceStatsRow,
  setSyncState,
  setSourceMeta,
  setSyncError,
  clearSyncError,
  clearReauthReminder,
  beginSyncAttempt,
  revokeSyncAttempt,
  resetMemberCursor,
  reserveReauthReminder,
  releaseReauthReminder,
  type SourceStatsAggregation,
  type UpsertWithCursorArgs,
} from "../db.js";
import { isReminderDue, type ReauthBackoffConfig } from "../push/reauth-reminder-policy.js";
import {
  releaseMobilePermissionReminder,
  reserveMobilePermissionReminder,
  type MobilePermissionBackoffConfig,
} from "../data/repositories/MobilePermissionHealthRepository.js";
import {
  createSourceWithPermissionInvalidation,
  deleteSourceWithPermissionInvalidation,
  forgetDeviceWithPermissionInvalidation,
  moveSourceWithPermissionInvalidation,
  removeSourceMemberWithPermissionInvalidation,
  removeSourceWithPermissionInvalidation,
  replaceOwnedMobilePermissionHealth,
  revokeDeviceWithPermissionInvalidation,
  updateSourceWithPermissionInvalidation,
} from "../push/mobile-permission-operations.js";
import {
  cleanupExpiredNotifications,
  claimNotification,
  confirmNotification,
  enqueueNotification,
  leaseNotificationWakes,
  settleNotificationWake,
  supersedeNotificationsByCollapseIdPrefix,
  type ClaimNotificationInput,
  type ConfirmNotificationInput,
  type EnqueueNotificationInput,
  type LeaseNotificationWakesInput,
  type SettleNotificationWakeInput,
} from "../push/queue.js";
import {
  commitMobilePermissionReminderNotification,
  commitReauthReminderNotification,
} from "../push/reminder-notification-operations.js";
import {
  bootstrapSelfFromDevices,
  clearApnsToken,
  clearFcmToken,
  createDevice,
  createOrAdoptDevice,
  replaceDeviceForRepair,
  setApnsToken,
  setFcmToken,
  setDeviceUpdateRequest,
  setNotificationDeliveryHealth,
  setRelayPushConsent,
  setRelayPushRegistration,
  withdrawRelayPushConsent,
  updateDeviceCapabilities,
  updateDeviceSelfInfo,
  touchDevice,
  createPairing,
  consumePairing,
  redeemDevicePairing,
  revokePairing,
  redeemAgentIntegrationPairing,
  cleanupExpiredPairings,
  renameDevice,
  type RelayPushConsentOutcome,
  type CreatePairingOptions,
} from "../data/repositories/DeviceRepository.js";
import {
  beginDeviceDoctorRun,
  completeDeviceDoctorRun,
  failDeviceDoctorRun,
  requeueDeviceDoctorRun,
  startDeviceDoctorRun,
  type BeginDeviceDoctorRunInput,
  type CompleteDeviceDoctorRunInput,
  type FailDeviceDoctorRunInput,
  type RequeueDeviceDoctorRunInput,
  type StartDeviceDoctorRunInput,
} from "../data/repositories/DeviceDoctorRunRepository.js";
import {
  applyNearDupBatch,
  applyNearDupDfFromStaging,
  algoSweepStep,
  generationSweepStep,
  bumpNearDupAlgo,
  stripRemaining,
} from "../near-dupes/NearDupWriterOps.js";
import { enqueueNearDupInbox, type NearDupInboxReason } from "../near-dupes/inbox.js";
import {
  createToken,
  validateToken,
  reconcileDeviceTokenScopes,
  touchTokenUsage,
  touchTokenUsageBatch,
  revokeToken,
  ensureBootstrapToken,
  createSession,
  refreshSessionActivity,
  validateSession,
  purgeExpiredSession,
  deleteSession,
  cleanupExpiredSessions,
  cleanupExpiredTokens,
} from "../data/repositories/TokenRepository.js";
import {
  addSourceMember,
  updateSourceForMember,
  updateExistingSourceMemberConfigOverride,
  createSourceWithId,
  markSourceRemoved,
  markSourceCleanupDone,
  clearSourceRemoved,
  clearSourceRemovedIfCleanupDone,
} from "../data/repositories/SourceRepository.js";
import {
  completeSourceStreamCleanup,
  recordSourceStreamCleanupFailure,
  type SourceStreamCleanupJob,
} from "../data/repositories/SourceStreamCleanupRepository.js";
import {
  completeSourceModeTransitionPublication,
  finalizeSourceModeTransition,
  adoptSourceModeTransitionBatch,
  prepareSourceModeTransition,
  recordSourceModeTransitionFailure,
  recordSourceModeTransitionPublicationFailure,
} from "../data/repositories/SourceModeTransitionRepository.js";
import {
  upsertSourceDocumentProfiles,
  type SourceDocumentProfileEntry,
} from "../data/repositories/SourceDocumentProfileRepository.js";
import {
  upsertConversationCitations,
  type ConversationCitationInput,
} from "../sources/omnesis-chat/citation-writer.js";
import {
  insertNoteEntry,
  updateNoteEntryText,
  deleteNoteEntry,
  type NoteEntry,
} from "../sources/omnesis-notes/storage.js";
import {
  insertAgentMessage,
  type AgentMessageRow,
} from "../sources/agent-conversations/storage.js";
import {
  enqueueCognitionRun,
  claimDueCognitionRuns,
  finalizeCognitionRun,
  recordSettledCognitionRun,
  cancelPendingCognitionRunsByDedupeKeys,
  pullForwardReadyCognitionRun,
  cancelScheduledRunsForLoop,
  setCognitionEngineState,
  createOpenLoop,
  updateOpenLoop,
  rewriteOpenLoopPeople,
  appendOpenLoopLedger,
  deleteOpenLoop,
  createBrief,
  updateBrief,
  retractBriefsForResolvedLoop,
  retireBrief,
  markBriefRead,
  setBriefThreadConversation,
  restampBriefThreadConversation,
  resurfaceDueSnoozedBriefs,
  writeCognitionNotes,
  appendCognitionNotes,
  editCognitionNotes,
  wipeCognitionNotes,
  dismissBriefAndEnqueueFeedback,
  createDocAnnotation,
  createDocAnnotationSuperseding,
  supersedeDocAnnotationBy,
  updateDocAnnotation,
  deleteDocAnnotation,
  invalidateAnnotationsForDoc,
  cascadeAnnotationPrivacyDelete,
  invalidateBriefClaimsForDoc,
  cascadeBriefClaimPrivacyDelete,
  createPersonAnnotation,
  createPersonAnnotationSuperseding,
  supersedePersonAnnotationBy,
  revisePersonAnnotation,
  deletePersonAnnotation,
  invalidatePersonAnnotationsForDoc,
  cascadePersonAnnotationPrivacyDelete,
  mutateWithConsumptionDependencies,
  retractAnnotationWithDependentRechecks,
  recordCognitionSpend,
  type ConsumptionDependencyContext,
  type CognitionRunUsage,
  type EnqueueCognitionRunInput,
  type FinalizeCognitionRunInput,
  type RecordSettledCognitionRunInput,
  type CreateOpenLoopInput,
  type UpdateOpenLoopInput,
  type CreateBriefInput,
  type UpdateBriefInput,
  type DismissBriefInput,
  type CreateDocAnnotationInput,
  type UpdateDocAnnotationPatch,
  type CreatePersonAnnotationInput,
  type UpdatePersonAnnotationPatch,
} from "../brain/index.js";
import { resolveDerivationStages, type DerivationStageId } from "../domain/DocumentDerivation.js";
import {
  forgetConversationReadState,
  markConversationOpened,
  recordAgentMessage,
} from "../agent/conversation-read-state.js";
import {
  createDevAnnotation,
  resolveDevAnnotation,
  deleteDevAnnotation,
  type CreateDevAnnotationInput,
} from "../dev-annotations/store.js";
import {
  appendAnswerAuditEvents,
  appendDirectAuditEvent,
  deleteDirectAuditSession,
  beginAnswerTask,
  completeAnswerTask,
  deletePrivacyConversation,
  expirePrivacyApprovals,
  failAnswerTask,
  recordAnswerEgress,
  recoverInterruptedAnswerTasks,
  resolvePrivacyApproval,
  type AppendAnswerAuditEventInput,
  type AppendDirectAuditEventInput,
  type BeginAnswerTaskInput,
  type CompleteAnswerTaskInput,
  type DeletePrivacyConversationInput,
  type RecordAnswerEgressInput,
  type ResolveApprovalInput,
  authorizeAnswerCompletionDelivery,
  claimAnswerCompletionDeliveries,
  settleAnswerCompletionDelivery,
  type AuthorizeAnswerCompletionDeliveryInput,
  type ClaimAnswerCompletionDeliveriesInput,
  type SettleAnswerCompletionDeliveryInput,
  type AnswerFailureSummary,
} from "../privacy/store.js";
import {
  commitPrivacyPolicy,
  deletePrivacyPolicyFamily,
  markPrivacyPolicyMirrorSynced,
  type CommitPrivacyPolicyInput,
} from "../privacy/policy-history.js";

import {
  withPairingGenerationFence,
  type PairingGenerationFence,
} from "../data/pairing-generation-fence.js";
import type { SelfIdentitySource } from "../self-identity-sources.js";
import type {
  AccessPrincipalRenameInput,
  AccessRevocationInput,
  AccessConnectionLevelInput,
  AccessDeviceLevelInput,
  AccessLevelCreateInput,
  AccessLevelDeleteInput,
  AccessLevelUpdateInput,
  AccessGrantUpdateInput,
  AuthorizationRequestCreateInput,
  AuthorizationRequestDecisionInput,
  ExecutionBindingCreateInput,
  OAuthClientRegistrationInput,
  OAuthClientMetadataDocument,
  OAuthTokenExchangeInput,
  McpToolInvocationAuditInput,
} from "../access/types.js";
import type { PreemptToken } from "./preempt.js";
import type { SeedFromContactsPlan } from "../domain/ContactCardBootstrap.js";
import type { PeopleCountRow } from "../data/repositories/PersonRepository.js";
import type { InteractionScoresSnapshot } from "../domain/InteractionScoreService.js";
import type { ResolvedNearDupConfig } from "../near-dupes/config.js";
import type { NearDupApplyBatch } from "../near-dupes/types.js";
import type { LinkStatsAggregation } from "../data/repositories/LinkStatsRepository.js";
import type { ExtractedLinkBatchEntry } from "../domain/LinkExtraction.js";
import type { DateExtractionResult } from "../enrichment/dates/extractor.js";
import type {
  AuthorizeSubscriptionDeliveryCommitMutation,
  ClaimSubscriptionDeliveriesMutation,
  CreateSubscriptionMutation,
  EnqueueSubscriptionEvaluationMutation,
  FireSubscriptionMutation,
  IssueSubscriptionFiringAnswerAuthorityMutation,
  IssueSubscriptionFiringOutcomeAuthorityMutation,
  RecordSubscriptionFiringOutcomeMutation,
  PurgeSubscriptionMutation,
  RecordSubscriptionPrivacyReviewMutation,
  ResolveSubscriptionApprovalMutation,
  RevokeSubscriptionMutation,
  ReviseSubscriptionMutation,
  SettleSubscriptionEvaluationMutation,
  SettleSubscriptionDeliveryMutation,
  UseSubscriptionFiringAnswerAuthorityMutation,
  FinalizeSubscriptionFiringAnswerEgressMutation,
} from "../subscriptions/store-types.js";
import type { MobilePermissionHealthReport } from "@omnesis/types/mobile-permission-health";

/**
 * Sync writer ops. `db` is bound at dispatch time — the handler signature
 * here is what the gate factory's `call(op, args)` must match.
 *
 * Handler return types are passed through to the gate (wrapped in a
 * Promise). Void-returning handlers omit an explicit `return` so TS
 * infers `void` and the gate can declare `Promise<void>`. The
 * worker-side message loop already coerces `undefined` to `null` on
 * the wire, so the wire shape doesn't depend on return-statement style.
 */
export const writerHandlers = {
  // ── db.ts ─────────────────────────────────────────────────────────
  // Note: `db.upsertDocuments` lives in `writerYieldableHandlers` below
  // — handleCall dispatches there first since cooperative yield is
  // always desirable for the heaviest writer op.
  "db.deleteDocuments": (
    db: Db,
    providerId: string,
    sourceId: string,
    externalIds: string[],
    expectedWipeEpoch?: number,
    cursorRow?: string,
    streamId?: string,
  ) =>
    deleteDocuments(
      db,
      providerId,
      sourceId,
      externalIds,
      expectedWipeEpoch,
      cursorRow ?? "",
      streamId ?? "",
    ),
  "db.deleteDocumentForUser": (
    db: Db,
    providerId: string,
    sourceId: string,
    externalId: string,
    streamId?: string,
    tombstone?: boolean,
  ) =>
    deleteDocumentForUser(db, providerId, sourceId, externalId, streamId ?? "", tombstone ?? true),
  "db.deleteDocumentForRetention": (
    db: Db,
    providerId: string,
    sourceId: string,
    externalId: string,
  ) => deleteDocumentForRetention(db, providerId, sourceId, externalId),
  "db.completeDocumentRetention": (
    db: Db,
    providerId: string,
    sourceId: string,
    externalId: string,
  ) => completeDocumentRetention(db, providerId, sourceId, externalId),
  "db.applySnapshotAbsencePlan": (
    db: Db,
    plan: SnapshotAbsencePlan,
    expectedWipeEpoch?: number,
    cursorRow?: string,
  ) => applySnapshotAbsencePlan(db, plan, expectedWipeEpoch, cursorRow ?? ""),
  "db.applyReplicaOmissions": (db: Db, args: ReplicaOmissionArgs) =>
    applyReplicaOmissions(db, args),
  "db.judgeAnalyticsTombstones": (db: Db, args: AnalyticsTombstoneArgs) =>
    judgeAnalyticsTombstones(db, args),
  "db.recordAnalyticsPresence": (db: Db, args: AnalyticsPresenceArgs): void => {
    recordAnalyticsPresence(db, args);
  },
  "db.recordAnalyticsRestorerOmissions": (db: Db, args: AnalyticsRestorerSnapshotArgs) =>
    recordAnalyticsRestorerOmissions(db, args),
  "db.recordAnalyticsSweepVerdict": (db: Db, verdict: AnalyticsSweepVerdict, now: number): void => {
    recordAnalyticsSweepVerdict(db, verdict, now);
  },
  "db.reclaimStaleAbsences": (db: Db, candidates: StaleAbsenceCandidate[]) =>
    reclaimStaleAbsences(db, candidates),
  "db.sweepDueAbsences": (
    db: Db,
    documentIds: string[],
    opts: { minObservations: number; dueBefore: number; now: number },
  ) => sweepDueAbsences(db, documentIds, { ...opts, deleteDocumentsByIds }),
  "db.acknowledgeAbsenceCascade": (db: Db, id: number, part: "index" | "cognition") =>
    acknowledgeAbsenceCascade(db, id, part),
  "db.deleteAllBySource": (db: Db, sourceId: string) => deleteAllBySource(db, sourceId),
  "db.deleteAllByStream": (db: Db, sourceId: string, streamId: string) =>
    deleteAllByStream(db, sourceId, streamId),
  "db.deleteAllByProvider": (db: Db, providerId: string) => deleteAllByProvider(db, providerId),
  "db.markSourceStatsDirty": (db: Db, sourceId: string | undefined): void => {
    markSourceStatsDirty(db, sourceId);
  },
  "db.refreshSourceStatsRow": (db: Db, sourceId: string): void => {
    refreshSourceStatsRow(db, sourceId);
  },
  "db.upsertSourceStatsRow": (db: Db, sourceId: string, agg: SourceStatsAggregation): void => {
    upsertSourceStatsRow(db, sourceId, agg);
  },
  "db.beginSyncAttempt": (db: Db, sourceId: string, cursorRow?: string) =>
    beginSyncAttempt(db, sourceId, cursorRow ?? ""),
  "db.promoteSourceWireContract": (db: Db, sourceId: string, version: number): void => {
    promoteSourceWireContract(db, sourceId, version);
  },
  "db.replaceSourceSyncIssues": (
    db: Db,
    sourceId: string,
    deviceId: string,
    issues: readonly SyncIssue[],
    assessments?: readonly SyncIssueAssessment[],
  ) => replaceSourceSyncIssues(db, sourceId, deviceId, issues, undefined, assessments),
  "db.preparePendingSourcePage": (db: Db, args: PreparePendingSourcePage) =>
    preparePendingSourcePage(db, args),
  "db.acknowledgePendingSourcePage": (db: Db, args: Omit<PreparePendingSourcePage, "payload">) =>
    acknowledgePendingSourcePage(db, args),
  "db.revokeSyncAttempt": (db: Db, sourceId: string, expectedEpoch: number, cursorRow?: string) =>
    revokeSyncAttempt(db, sourceId, expectedEpoch, cursorRow ?? ""),
  "db.resetMemberCursor": (db: Db, sourceId: string, deviceId: string): void => {
    resetMemberCursor(db, sourceId, deviceId);
  },

  "db.setSyncState": (
    db: Db,
    sourceId: string,
    cursor: SyncCursor,
    meta?: SourceSyncMeta,
    writeEpoch?: number,
    deviceId?: string,
  ): boolean =>
    setSyncState(db, sourceId, cursor, meta, undefined, false, writeEpoch, deviceId ?? ""),
  "db.setSourceMeta": (db: Db, sourceId: string, meta: SourceSyncMeta): void => {
    setSourceMeta(db, sourceId, meta);
  },
  "db.applySourceUrlRecanonicalizationPage": (
    db: Db,
    cursor: SourceUrlRecanonicalizationCursor,
    mutations: readonly SourceUrlRecanonicalizationMutation[],
  ) => applySourceUrlRecanonicalizationPage(db, cursor, mutations),
  "db.finishSourceUrlRecanonicalization": (db: Db, cursor: SourceUrlRecanonicalizationCursor) =>
    finishSourceUrlRecanonicalization(db, cursor),
  // Note: `db.upsertWithCursor` lives in `writerYieldableHandlers` —
  // it's the collector's hot ingest path (realtime priority), so we
  // want it to yield between doc chunks rather than park the writer
  // for the entire page.
  "db.setSyncError": (
    db: Db,
    sourceId: string,
    errorMessage: string,
    deviceId?: string,
    remediation?: SyncRemediation,
  ): void => {
    setSyncError(db, sourceId, errorMessage, deviceId ?? "", remediation);
  },

  "db.recoverReauthReminder": (
    db: Db,
    principal: string,
    deviceId: string,
    collapsePrefix: string,
    now: number,
  ): number =>
    db
      .transaction(() => {
        clearReauthReminder(db, principal, deviceId);
        return supersedeNotificationsByCollapseIdPrefix(db, collapsePrefix, now);
      })
      .immediate(),
  "db.reserveReauthReminder": (
    db: Db,
    principal: string,
    deviceId: string,
    now: number,
    cfg: ReauthBackoffConfig,
  ) =>
    reserveReauthReminder(db, principal, deviceId, now, cfg.reservationTtlMs, (existing) =>
      isReminderDue(existing, now, cfg),
    ),
  "db.releaseReauthReminder": (db: Db, token: string) => releaseReauthReminder(db, token),
  "notifications.commitReauthReminder": (
    db: Db,
    token: string,
    now: number,
    input: EnqueueNotificationInput,
  ) => commitReauthReminderNotification(db, token, now, input),
  "mobilePermission.replace": (
    db: Db,
    input: {
      sourceId: SourceId;
      deviceId: DeviceId;
      report: MobilePermissionHealthReport;
      receivedAt: number;
    },
  ) => replaceOwnedMobilePermissionHealth(db, input),
  "mobilePermission.reserveReminder": (
    db: Db,
    sourceId: SourceId,
    now: number,
    cfg: MobilePermissionBackoffConfig,
  ) => reserveMobilePermissionReminder(db, sourceId, now, cfg),
  "mobilePermission.releaseReminder": (db: Db, token: string, episodeId: string) =>
    releaseMobilePermissionReminder(db, token, episodeId),
  "notifications.commitMobilePermissionReminder": (
    db: Db,
    token: string,
    episodeId: string,
    now: number,
    input: EnqueueNotificationInput,
  ) => commitMobilePermissionReminderNotification(db, token, episodeId, now, input),

  "db.clearSyncError": (db: Db, sourceId: string, deviceId?: string): void => {
    clearSyncError(db, sourceId, deviceId);
  },

  // ── people.ts ─────────────────────────────────────────────────────
  "people.findOrCreatePerson": (
    db: Db,
    mention: PersonMention,
    sourceId: string,
    docDate: string,
  ) => findOrCreatePerson(db, mention, sourceId, docDate),
  "people.resolveDocumentPeople": (
    db: Db,
    docId: string,
    people: PersonMention[],
    sourceId: string,
    docDate: string,
  ) => resolveDocumentPeople(db, docId, people, sourceId, docDate),
  // Note: `people.backfillManyPeople` lives in `writerYieldableHandlers`.
  "people.seedFromContacts": (db: Db) => seedFromContacts(db),
  "people.upsertSeedFromContacts": (db: Db, plan: SeedFromContactsPlan) =>
    upsertSeedFromContacts(db, plan),
  "people.detectSelfFromSourceIds": (db: Db, hooks: readonly SelfIdentitySource[]): number =>
    detectSelfFromSourceIds(db, hooks),
  "people.bootstrapSelfFromConfig": (
    db: Db,
    configSelf:
      | { name?: string; emails?: readonly string[]; phones?: readonly string[] }
      | undefined,
  ): string | null => reconcileSelfFromConfig(db, configSelf),
  "people.mergePeople": (db: Db, winnerId: string, loserId: string): void => {
    mergePeople(db, winnerId, loserId);
  },
  "people.runMergePass": (db: Db) => runMergePass(db),
  "people.collapseTransitiveChains": (db: Db) => collapseTransitiveChains(db),
  "people.upsertTransitiveCollapse": (db: Db, rows: TransitiveCollapseRow[]) =>
    upsertTransitiveCollapse(db, rows),
  // Note: `people.rebuildPeopleFromDocuments` lives in
  // `writerYieldableHandlers` below — the O(corpus) flag-clear is batched and
  // polls the preempt token so a rebuild can't park realtime ingest.
  "people.refreshPeopleCounts": (db: Db): void => {
    refreshPeopleCounts(db);
  },
  "people.upsertPeopleCounts": (db: Db, rows: PeopleCountRow[]) => upsertPeopleCounts(db, rows),
  "people.advanceCountsWatermark": (db: Db, capturedVersion: number) => {
    advanceOccWatermark(db, { job: "people_counts", capturedVersion });
  },
  "people.zeroPeopleCountsForLosers": (db: Db) => zeroPeopleCountsForLosers(db),
  "people.recomputeNamePrimaries": (db: Db) => recomputeNamePrimaries(db),
  "people.upsertInteractionScores": (db: Db, snapshot: InteractionScoresSnapshot) =>
    upsertInteractionScores(db, snapshot),
  "people.markPeopleGraphDirty": (db: Db): void => {
    markPeopleGraphDirty(db);
  },
  "people.createMergeRule": (db: Db, input: CreateMergeRuleInput) => createMergeRule(db, input),
  "people.deleteMergeRule": (db: Db, ruleId: string) => deleteMergeRule(db, ruleId),
  "people.deleteMergeRuleGroup": (db: Db, groupId: string) => deleteMergeRuleGroup(db, groupId),
  // Note: `people.upsertAutoDetectedRules` lives in
  // `writerYieldableHandlers` below — it yields between candidates so a
  // large auto-detect pass can't park realtime ingest.
  "people.upsertMergeEquivalences": (db: Db, snapshot: MergeEquivalenceSnapshot) =>
    upsertMergeEquivalences(db, snapshot),
  "people.unmergePerson": (db: Db, personId: string): void => {
    unmergePerson(db, personId);
  },
  // Note: `people.physicalDedupSharedAliases` lives in
  // `writerYieldableHandlers` below — it yields between clusters so a large
  // dedup pass can't park realtime ingest.
  "people.pruneNoreplyAliases": (db: Db) => pruneNoreplyAliases(db),
  "people.upgradePlaceholderCanonicalNames": (db: Db) => upgradePlaceholderCanonicalNames(db),
  "people.demoteSharedAddresses": (db: Db, nameThreshold?: number, maxEmails?: number) =>
    demoteSharedAddresses(db, nameThreshold, maxEmails),
  "people.upsertMergeCandidates": (db: Db, proposals: readonly MergeCandidateProposal[]) =>
    upsertMergeCandidates(db, proposals),
  "people.acceptMergeCandidate": (db: Db, input: AcceptMergeCandidateInput) =>
    acceptMergeCandidate(db, input),
  "people.denyMergeCandidate": (db: Db, candidateId: string) => denyMergeCandidate(db, candidateId),
  "people.mergeCluster": (
    db: Db,
    personIds: readonly string[],
    opts?: { reason?: string | null; createdBy?: string | null },
  ) => mergeCluster(db, personIds, opts ?? {}),
  "people.sweepCollapsedMergeCandidates": (db: Db) => sweepCollapsedMergeCandidates(db),
  "people.pruneSuppressedMergeCandidates": (db: Db) => pruneSuppressedMergeCandidates(db),
  "people.autoApproveHighConfidenceCandidates": (db: Db) => autoApproveHighConfidenceCandidates(db),
  "people.reconcilePendingMergeCandidates": (
    db: Db,
    proposals: readonly MergeCandidateProposal[],
  ) => reconcilePendingMergeCandidates(db, proposals),
  "people.applyMergeAdjudication": (db: Db, input: ApplyMergeAdjudicationInput) =>
    applyMergeAdjudication(db, input),
  "people.upsertTokenLabels": (db: Db, rows: readonly TokenLabelRow[]) =>
    upsertTokenLabels(db, rows),

  // ── links.ts ──────────────────────────────────────────────────────
  "links.reconcileUnresolvedLinks": (db: Db, limit?: number) => reconcileUnresolvedLinks(db, limit),
  "links.beginDeclarationUpdate": (db: Db) => beginLinkDeclarationUpdate(db),
  "links.finishDeclarationUpdate": (db: Db) => finishLinkDeclarationUpdate(db),
  // `links.upsertLinkResolutions` lives in `writerYieldableHandlers` below.
  // URL-reconciliation batches are split into bounded transactions so the
  // background repair pass cannot park realtime ingest on the single writer.
  "db.applyExtractedDates": (db: Db, entries: DateExtractionResult[]) =>
    applyExtractedDates(db, entries),
  // Drain of source-declared forward-reference edges: resolve parked
  // edges whose target has since been ingested, promote them into
  // document_links, and TTL-drop ones whose target never arrived.
  "edges.drainPending": (db: Db, limit?: number) => drainPendingEdges(db, { limit }),
  // Note: `links.upsertExtractedLinksBatch` lives in
  // `writerYieldableHandlers` below — link batches commonly produce
  // hundreds of inserts per doc and the original single-transaction
  // shape parked the writer for 2-3 s per call.
  "links.markLinkStatsDirty": (db: Db): void => {
    markLinkStatsDirty(db);
  },
  "links.upsertLinkStats": (db: Db, agg: LinkStatsAggregation) => upsertLinkStats(db, agg),
  "links.reconcileLinkStatsCounters": (db: Db) => reconcileLinkStatsCounters(db),

  // ── sqlite-catalog.ts ─────────────────────────────────────────────
  "catalog.refreshSqliteTableStats": (db: Db): void => {
    refreshSqliteTableStats(db);
  },

  // ── access / MCP OAuth ────────────────────────────────────────────
  "access.oauthClientRegister": (db: Db, input: OAuthClientRegistrationInput) =>
    registerOAuthClient(db, input),
  "access.oauthMetadataClientUpsert": (db: Db, input: OAuthClientMetadataDocument) =>
    upsertOAuthMetadataClient(db, input),
  "access.executionBindingCreate": (db: Db, input: ExecutionBindingCreateInput) =>
    createExecutionBinding(db, input),
  "access.authorizationCreate": (db: Db, input: AuthorizationRequestCreateInput) =>
    createAuthorizationRequest(db, input),
  "access.authorizationNotificationEnqueue": (
    db: Db,
    requestId: string,
    deviceIds: readonly DeviceId[],
  ) => enqueueAccessAuthorizationNotification(db, requestId, deviceIds, Date.now()),
  "access.authorizationDecide": (db: Db, input: AuthorizationRequestDecisionInput) =>
    decideAuthorizationRequest(db, input),
  "access.authorizationIssueCode": (db: Db, browserHandle: string) =>
    issueAuthorizationCode(db, browserHandle),
  "access.authorizationIssueCodeById": (db: Db, requestId: string) =>
    issueAuthorizationCodeById(db, requestId),
  "access.tokenExchange": (db: Db, input: OAuthTokenExchangeInput) => exchangeOAuthToken(db, input),
  "access.executionTokensReissue": (db: Db, input: { deviceId: string; oauthClientId: string }) =>
    reissueExecutionDeviceTokens(db, input),
  "access.grantUpdate": (db: Db, input: AccessGrantUpdateInput) => updateAccessGrant(db, input),
  "access.levelCreate": (db: Db, input: AccessLevelCreateInput) => createAccessLevel(db, input),
  "access.levelUpdate": (db: Db, input: AccessLevelUpdateInput) => updateAccessLevel(db, input),
  "access.levelDelete": (db: Db, input: AccessLevelDeleteInput) => deleteAccessLevel(db, input),
  "access.connectionLevelSet": (db: Db, input: AccessConnectionLevelInput) =>
    setConnectionLevel(db, input),
  "access.deviceLevelSet": (db: Db, input: AccessDeviceLevelInput) => setDeviceLevel(db, input),
  "access.principalRename": (db: Db, input: AccessPrincipalRenameInput) =>
    renameAccessPrincipal(db, input),
  "access.revoke": (db: Db, input: AccessRevocationInput) => revokeAccessEntity(db, input),
  "access.mcpInvocationAudit": (db: Db, input: McpToolInvocationAuditInput): boolean =>
    recordMcpToolInvocationAudit(db, input),
  "access.credentialUsageTouchBatch": (
    db: Db,
    rows: ReadonlyArray<{ credentialId: string; observedAt: number }>,
  ): void => {
    touchPrincipalCredentialUsageBatch(db, rows);
  },
  "access.cleanupBatch": (
    db: Db,
    phase: AccessCleanupPhase,
    now: number,
    limit: number,
    cursor?: OAuthClientCleanupCursor,
  ) => cleanupExpiredAccessStateBatch(db, phase, now, limit, cursor),

  // ── devices.ts ────────────────────────────────────────────────────
  "devices.createDevice": (
    db: Db,
    opts: { name: string; kind: DeviceKind; capabilities?: DeviceCapability },
  ) => createDevice(db, opts),
  "devices.createOrAdoptDevice": (
    db: Db,
    input: {
      name: string;
      kind: DeviceKind;
      capabilities: DeviceCapability;
      scopes: readonly Scope[];
      onlineDeviceIds?: readonly DeviceId[];
    },
  ) => createOrAdoptDevice(db, input),
  "devices.deleteDevice": (db: Db, id: string) =>
    forgetDeviceWithPermissionInvalidation(db, DeviceId(id)),
  "devices.revokeDevice": (
    db: Db,
    id: string,
    pairingFence?: PairingGenerationFence,
    expectedImpactFingerprint?: string,
  ) =>
    withPairingGenerationFence(db, pairingFence, () =>
      revokeDeviceWithPermissionInvalidation(
        db,
        DeviceId(id),
        Date.now(),
        expectedImpactFingerprint,
      ),
    ),
  "devices.renameDevice": (db: Db, id: string, name: string) =>
    renameDevice(db, DeviceId(id), name),
  "devices.replaceDeviceForRepair": (
    db: Db,
    oldId: string,
    opts: { name: string; kind: DeviceKind; capabilities?: DeviceCapability },
  ) => replaceDeviceForRepair(db, DeviceId(oldId), opts),
  "devices.updateDeviceCapabilities": (
    db: Db,
    id: string,
    capabilities: DeviceCapability,
    protocolVersion?: number,
  ) => {
    return updateDeviceCapabilities(db, DeviceId(id), capabilities, protocolVersion);
  },
  "devices.setUpdateRequest": (
    db: Db,
    id: string,
    request: {
      desiredVersion: string | null;
      state: DeviceUpdateState;
      detail?: string | null;
      onlyIfState?: DeviceUpdateState;
      onlyIfDesiredVersion?: string | null;
      onlyIfReportedVersion?: string | null;
      onlyIfSourceCommit?: string | null;
      notIfState?: DeviceUpdateState;
    },
  ): boolean => setDeviceUpdateRequest(db, DeviceId(id), request),
  "devices.doctorRunBegin": (db: Db, input: BeginDeviceDoctorRunInput): boolean =>
    beginDeviceDoctorRun(db, input),
  "devices.doctorRunStart": (db: Db, input: StartDeviceDoctorRunInput): boolean =>
    startDeviceDoctorRun(db, input),
  "devices.doctorRunRequeue": (db: Db, input: RequeueDeviceDoctorRunInput): boolean =>
    requeueDeviceDoctorRun(db, input),
  "devices.doctorRunFail": (db: Db, input: FailDeviceDoctorRunInput): boolean =>
    failDeviceDoctorRun(db, input),
  "devices.doctorRunComplete": (db: Db, input: CompleteDeviceDoctorRunInput): boolean =>
    completeDeviceDoctorRun(db, input),
  "devices.updateDeviceSelfInfo": (
    db: Db,
    id: string,
    patch: { selfEmails?: string[]; selfPhones?: string[] },
  ): void => {
    updateDeviceSelfInfo(db, DeviceId(id), patch);
  },
  "devices.setNotificationDeliveryHealth": (
    db: Db,
    id: string,
    status: NotificationDeliveryHealth,
    updatedAt: number,
  ): void => {
    setNotificationDeliveryHealth(db, DeviceId(id), status, updatedAt);
  },
  "devices.setApnsToken": (db: Db, id: string, registration: ApnsRegistration): void => {
    setApnsToken(db, DeviceId(id), registration);
  },
  "devices.clearApnsToken": (db: Db, id: string, expected?: ApnsRegistration): boolean => {
    return clearApnsToken(db, DeviceId(id), expected);
  },
  "devices.setFcmToken": (db: Db, id: string, registration: FcmRegistration): void => {
    setFcmToken(db, DeviceId(id), registration);
  },
  "devices.clearFcmToken": (db: Db, id: string, expected?: FcmRegistration): boolean => {
    return clearFcmToken(db, DeviceId(id), expected);
  },
  "devices.setRelayPushConsent": (
    db: Db,
    id: string,
    consent: { appId: string; grantedAt: number },
  ): RelayPushConsentOutcome => setRelayPushConsent(db, DeviceId(id), consent),
  "devices.withdrawRelayPushConsent": (db: Db, id: string): boolean =>
    withdrawRelayPushConsent(db, DeviceId(id)),
  "devices.setRelayPushRegistration": (
    db: Db,
    id: string,
    registration: { relayUrl: string; credential: string; appId: string },
  ): boolean => setRelayPushRegistration(db, DeviceId(id), registration),
  "notifications.enqueue": (db: Db, input: EnqueueNotificationInput) =>
    enqueueNotification(db, input),
  "notifications.leaseWakes": (db: Db, input: LeaseNotificationWakesInput) =>
    leaseNotificationWakes(db, input),
  "notifications.settleWake": (db: Db, input: SettleNotificationWakeInput) =>
    settleNotificationWake(db, input),
  "notifications.claim": (db: Db, input: ClaimNotificationInput) => claimNotification(db, input),
  "notifications.confirm": (db: Db, input: ConfirmNotificationInput) =>
    confirmNotification(db, input),
  "notifications.cleanupExpired": (db: Db, now: number) => cleanupExpiredNotifications(db, now),
  "devices.bootstrapSelfFromDevices": (db: Db) => bootstrapSelfFromDevices(db),
  "devices.touchDevice": (db: Db, id: string): void => {
    touchDevice(db, DeviceId(id));
  },
  // Forwarded whole and typed from createPairing itself, so every option the
  // caller sets (access level, TLS fingerprint, self annotation) reaches it.
  "devices.createPairing": (db: Db, opts: CreatePairingOptions) => createPairing(db, opts),
  "devices.consumePairing": (db: Db, pairingCode: string, expectedKind?: DeviceKind) =>
    consumePairing(db, pairingCode, expectedKind),
  "devices.redeemDevicePairing": (
    db: Db,
    input: {
      pairingCode: string;
      expectedKind?: DeviceKind;
      capabilities: DeviceCapability;
      onlineDeviceIds?: readonly DeviceId[];
      idempotencyKey?: string;
    },
  ) => redeemDevicePairing(db, input),
  "devices.revokePairing": (db: Db, pairingCode: string) => revokePairing(db, pairingCode),
  "devices.redeemAgentIntegrationPairing": (
    db: Db,
    input: {
      pairingCode: string;
      harness: "openclaw" | "hermes";
      capabilities: DeviceCapability;
      repairDeviceId?: DeviceId;
      idempotencyKey?: string;
    },
  ) => redeemAgentIntegrationPairing(db, input),
  "devices.cleanupExpiredPairings": (db: Db) => cleanupExpiredPairings(db),

  // ── tokens.ts ─────────────────────────────────────────────────────
  "tokens.createToken": (
    db: Db,
    deviceId: string,
    scopes: readonly Scope[],
    name: string | null | undefined,
    opts?: { ttlMs?: number },
  ) => createToken(db, DeviceId(deviceId), scopes, name, opts),
  "tokens.validateToken": (db: Db, rawToken: string) => validateToken(db, rawToken),
  "tokens.touchTokenUsage": (db: Db, tokenId: string, deviceId: string): void => {
    // Swallow SQLITE_BUSY so a transient contention can't surface as a
    // failed beacon back to the caller (caller is fire-and-forget anyway).
    try {
      touchTokenUsage(db, TokenId(tokenId), DeviceId(deviceId));
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== "SQLITE_BUSY") throw err;
    }
  },
  // `tokens.touchTokenUsageBatch` is yieldable — see
  // `writerYieldableHandlers` below. Per-row sub-transactions let
  // realtime writer ops preempt mid-batch.
  "tokens.reconcileDeviceTokenScopes": (db: Db, tokenId: string, kind: DeviceKind) =>
    reconcileDeviceTokenScopes(db, TokenId(tokenId), kind),
  "tokens.revokeToken": (db: Db, id: string) => revokeToken(db, TokenId(id)),
  "tokens.ensureBootstrapToken": (db: Db, configDir: string) => ensureBootstrapToken(db, configDir),
  "tokens.createSession": (
    db: Db,
    tokenId: string,
    scopes: readonly Scope[],
    expiresInMs?: number,
  ) => createSession(db, TokenId(tokenId), scopes, expiresInMs),
  "tokens.refreshSessionActivity": (
    db: Db,
    sessionId: string,
    sessionTtlMs: number,
    throttleMs: number,
  ) => refreshSessionActivity(db, sessionId, sessionTtlMs, throttleMs),
  "tokens.validateSession": (db: Db, sessionId: string) => validateSession(db, sessionId),
  "tokens.purgeExpiredSession": (db: Db, sessionId: string): void => {
    purgeExpiredSession(db, sessionId);
  },
  "tokens.deleteSession": (db: Db, sessionId: string): void => {
    deleteSession(db, sessionId);
  },
  "tokens.cleanupExpiredSessions": (db: Db) => cleanupExpiredSessions(db),
  "tokens.cleanupExpiredTokens": (db: Db) => cleanupExpiredTokens(db),
  "activityRetention.pruneBatch": (
    db: Db,
    phase: ActivityRetentionPhase,
    cutoff: number,
    limit: number,
  ) => pruneActivityRetentionBatch(db, phase, cutoff, limit),
  "activityRetention.reclaimPages": (db: Db, maxPages: number) =>
    reclaimActivityRetentionPages(db, maxPages),

  // ── sources.ts ────────────────────────────────────────────────────
  "sources.createSource": (
    db: Db,
    opts: {
      type: SourceType;
      accountId: AccountId;
      deviceId: DeviceId;
      config?: Record<string, unknown>;
      memberConfigOverride?: Record<string, unknown>;
      memberScopedParams?: readonly string[];
      enabled?: boolean;
      pairingFence?: PairingGenerationFence;
    },
  ) =>
    withPairingGenerationFence(db, opts.pairingFence, () =>
      createSourceWithPermissionInvalidation(db, opts),
    ),
  "sources.createSourceWithId": (
    db: Db,
    id: string,
    opts: {
      type: SourceType;
      accountId: AccountId;
      deviceId: DeviceId;
      config?: Record<string, unknown>;
      memberConfigOverride?: Record<string, unknown>;
      memberScopedParams?: readonly string[];
      enabled?: boolean;
      pairingFence?: PairingGenerationFence;
    },
  ) =>
    withPairingGenerationFence(db, opts.pairingFence, () =>
      createSourceWithId(db, SourceId(id), opts),
    ),
  "sources.updateSource": (
    db: Db,
    id: string,
    patch: { config?: Record<string, unknown>; enabled?: boolean; deviceId?: DeviceId },
  ) => updateSourceWithPermissionInvalidation(db, SourceId(id), patch),
  "sources.moveSource": (
    db: Db,
    id: string,
    patch: {
      config?: Record<string, unknown>;
      enabled?: boolean;
      deviceId?: DeviceId;
      expectDeviceId?: DeviceId;
      memberScopedParams?: readonly string[];
      pairingFence?: PairingGenerationFence;
    },
  ) =>
    withPairingGenerationFence(db, patch.pairingFence, () =>
      moveSourceWithPermissionInvalidation(db, SourceId(id), patch),
    ),
  "sources.deleteSource": (db: Db, id: string) =>
    deleteSourceWithPermissionInvalidation(db, SourceId(id)),
  "sources.addMember": (
    db: Db,
    id: string,
    deviceId: string,
    configOverride?: Record<string, unknown>,
    memberScopedParams?: readonly string[],
    pairingFence?: PairingGenerationFence,
    allowDetachedRejoin?: boolean,
  ) =>
    withPairingGenerationFence(db, pairingFence, () =>
      addSourceMember(
        db,
        SourceId(id),
        DeviceId(deviceId),
        undefined,
        configOverride,
        memberScopedParams,
        allowDetachedRejoin,
      ),
    ),
  "sources.updateForMember": (
    db: Db,
    id: string,
    deviceId: string,
    patch: { config?: Record<string, unknown>; enabled?: boolean },
    configOverride: Record<string, unknown>,
    memberScopedParams: readonly string[],
    pairingFence?: PairingGenerationFence,
  ) =>
    withPairingGenerationFence(db, pairingFence, () =>
      updateSourceForMember(
        db,
        SourceId(id),
        DeviceId(deviceId),
        patch,
        configOverride,
        memberScopedParams,
      ),
    ),
  "sources.updateMemberConfig": (
    db: Db,
    id: string,
    deviceId: string,
    configOverride: Record<string, unknown>,
    memberScopedParams: readonly string[],
    pairingFence?: PairingGenerationFence,
  ) =>
    withPairingGenerationFence(db, pairingFence, () =>
      updateExistingSourceMemberConfigOverride(
        db,
        SourceId(id),
        DeviceId(deviceId),
        configOverride,
        memberScopedParams,
      ),
    ),
  "sources.removeMember": (
    db: Db,
    id: string,
    deviceId: string,
    pairingFence?: PairingGenerationFence,
  ) =>
    withPairingGenerationFence(db, pairingFence, () =>
      removeSourceMemberWithPermissionInvalidation(db, SourceId(id), DeviceId(deviceId)),
    ),
  "sources.prepareModeTransition": (
    db: Db,
    id: string,
    toMode: MultiDeviceMode,
    expectedOwnerDeviceId: string,
    memberScopedParams: readonly string[],
    replicaVersionPolicy?: "source-updated-at",
    pairingFence?: PairingGenerationFence,
  ) =>
    withPairingGenerationFence(db, pairingFence, () =>
      prepareSourceModeTransition(
        db,
        SourceId(id),
        toMode,
        DeviceId(expectedOwnerDeviceId),
        undefined,
        memberScopedParams,
        replicaVersionPolicy,
      ),
    ),
  "sources.adoptModeTransitionBatch": (db: Db, id: string) =>
    adoptSourceModeTransitionBatch(db, SourceId(id)),
  "sources.finalizeModeTransition": (db: Db, id: string) =>
    finalizeSourceModeTransition(db, SourceId(id)),
  "sources.failModeTransition": (db: Db, id: string, message: string) =>
    recordSourceModeTransitionFailure(db, SourceId(id), message),
  "sources.failModeTransitionPublication": (db: Db, id: string, message: string) =>
    recordSourceModeTransitionPublicationFailure(db, SourceId(id), message),
  "sources.completeModeTransitionPublication": (db: Db, id: string) =>
    completeSourceModeTransitionPublication(db, SourceId(id)),
  "sources.failStreamCleanup": (db: Db, job: SourceStreamCleanupJob, message: string) =>
    recordSourceStreamCleanupFailure(db, job, message),
  "sources.completeStreamCleanup": (db: Db, job: SourceStreamCleanupJob) =>
    completeSourceStreamCleanup(db, job),
  "sources.removeSource": (db: Db, id: string, pairingFence?: PairingGenerationFence) =>
    withPairingGenerationFence(db, pairingFence, () =>
      removeSourceWithPermissionInvalidation(db, SourceId(id)),
    ),
  "sources.markSourceRemoved": (db: Db, id: string, opts?: { cleanupPending?: boolean }) =>
    markSourceRemoved(db, SourceId(id), opts),
  "sources.markSourceCleanupDone": (db: Db, id: string) => markSourceCleanupDone(db, SourceId(id)),
  "sources.clearSourceRemoved": (db: Db, id: string) => clearSourceRemoved(db, SourceId(id)),
  "sources.clearSourceRemovedIfCleanupDone": (db: Db, id: string) =>
    clearSourceRemovedIfCleanupDone(db, SourceId(id)),
  "sources.upsertDocumentProfiles": (
    db: Db,
    entries: readonly SourceDocumentProfileEntry[],
    publishedAt: number,
  ) => upsertSourceDocumentProfiles(db, entries, publishedAt),

  // ── briefs (the Cognition Steward run queue) ─────────────────────────────
  "cognition.enqueue": (db: Db, input: EnqueueCognitionRunInput, now: number) =>
    enqueueCognitionRun(db, input, now),
  "cognition.claimDue": (db: Db, opts: { now: number; limit?: number; maxAttempts?: number }) =>
    claimDueCognitionRuns(db, opts),
  "cognition.finalize": (db: Db, input: FinalizeCognitionRunInput): void =>
    finalizeCognitionRun(db, input),
  // A run that executed outside the queue (watch compilation): insert its row
  // already settled, with attribution + spend in the same transaction.
  "cognition.recordSettledRun": (db: Db, input: RecordSettledCognitionRunInput): void =>
    recordSettledCognitionRun(db, input),
  // Readiness barrier: atomically revalidate and release deferred data runs
  // whose datum finished deriving or disappeared. One writer trip per pass.
  "cognition.pullForward": (
    db: Db,
    entries: Array<{
      id: string;
      docId: string;
      observedDebounceUntil: number;
      nextAttemptAt: number;
      expectedNextAttemptAt: number;
    }>,
    activeDerivationStageIds: readonly DerivationStageId[],
  ): number => {
    const activeStages = resolveDerivationStages(activeDerivationStageIds);
    return entries.reduce(
      (n, e) =>
        n +
        (pullForwardReadyCognitionRun(
          db,
          e.id,
          e.docId,
          e.observedDebounceUntil,
          e.nextAttemptAt,
          e.expectedNextAttemptAt,
          activeStages,
        )
          ? 1
          : 0),
      0,
    );
  },
  "cognition.cancelPending": (db: Db, dedupeKeys: string[]) =>
    cancelPendingCognitionRunsByDedupeKeys(db, dedupeKeys),
  "cognition.cancelScheduledForLoop": (db: Db, loopId: string) =>
    cancelScheduledRunsForLoop(db, loopId),
  "cognition.engineStateSet": (db: Db, key: string, value: string): void =>
    setCognitionEngineState(db, key, value),
  // Non-run spend accounting: fold one mechanism call's token usage into its
  // (day, mechanism, model) bucket. Run-settling spend goes through
  // `cognition.finalize`; this op serves mechanisms with no run row (the
  // entailment gate, interactive turns, sub-agents). `countRun: false` folds
  // tokens without bumping the completed-run counter (failed/aborted turns).
  "cognition.recordCognitionSpend": (
    db: Db,
    day: string,
    mechanism: string,
    modelId: string,
    usage: CognitionRunUsage,
    opts?: { countRun?: boolean },
  ): void => recordCognitionSpend(db, day, mechanism, modelId, usage, opts),
  // Open-loop / brief / notes mutations (the Cognition Steward's tool layer).
  "cognition.openLoopCreate": (
    db: Db,
    input: CreateOpenLoopInput,
    dependencies: ConsumptionDependencyContext,
    now: number,
  ) =>
    mutateWithConsumptionDependencies(db, dependencies, "loop", input.id, now, () =>
      createOpenLoop(db, input, now),
    ),
  "cognition.openLoopUpdate": (
    db: Db,
    id: string,
    input: UpdateOpenLoopInput,
    dependencies: ConsumptionDependencyContext,
    now: number,
  ) =>
    mutateWithConsumptionDependencies(db, dependencies, "loop", id, now, () =>
      updateOpenLoop(db, id, input, now),
    ),
  "cognition.openLoopRewritePeople": (
    db: Db,
    id: string,
    actors: readonly string[],
    involved: readonly string[],
  ): boolean => rewriteOpenLoopPeople(db, id, actors, involved),
  "cognition.openLoopLedgerAppend": (
    db: Db,
    loopId: string,
    entry: { runId: string; note: string },
    now: number,
  ): void => appendOpenLoopLedger(db, loopId, entry, now),
  // The write-gated delete records a consolidation trace (the agent-issued
  // `open_loop_delete` path); the storage default is trace-free.
  "cognition.openLoopDelete": (db: Db, id: string, now: number) =>
    deleteOpenLoop(db, id, { retire: true, now }),
  "cognition.openLoopCascade": (db: Db, deletedDocIds: readonly string[]) =>
    cascadeOpenLoopPrivacyDeleteWithMirrors(db, deletedDocIds),
  "cognition.annotationCreate": (db: Db, input: CreateDocAnnotationInput, now: number) =>
    createDocAnnotation(db, input, now, true),
  // Atomic create-and-supersede (belief revision): the successor row and the
  // superseded row's invalidated_at + superseded_by stamps land in ONE
  // transaction, so a crash can never leave both claims standing.
  "cognition.annotationCreateSuperseding": (
    db: Db,
    input: CreateDocAnnotationInput,
    supersedesId: string,
    now: number,
  ) => createDocAnnotationSuperseding(db, input, supersedesId, now, true),
  // Pure belief retirement (no create): both rows' liveness is re-checked
  // inside the write, so a target retired by a concurrent write comes back
  // superseded:false instead of being silently re-pointed.
  "cognition.annotationSupersede": (
    db: Db,
    id: string,
    supersededById: string,
    now: number,
  ): { superseded: boolean } => supersedeDocAnnotationBy(db, id, supersededById, now),
  "cognition.annotationUpdate": (
    db: Db,
    id: string,
    patch: UpdateDocAnnotationPatch,
    now: number,
  ) => updateDocAnnotation(db, id, patch, now),
  "cognition.annotationDelete": (db: Db, id: string, now: number): boolean =>
    retractAnnotationWithDependentRechecks(db, "doc", id, now, () => deleteDocAnnotation(db, id)),
  "cognition.annotationInvalidate": (db: Db, docId: string, now: number) =>
    invalidateAnnotationsForDoc(db, docId, now),
  "cognition.annotationPrivacyDelete": (db: Db, deletedDocIds: readonly string[]): string[] =>
    cascadeAnnotationPrivacyDelete(db, deletedDocIds),
  "cognition.briefClaimInvalidate": (db: Db, docId: string, now: number): number =>
    invalidateBriefClaimsForDoc(db, docId, now),
  "cognition.briefClaimPrivacyDelete": (db: Db, deletedDocIds: readonly string[]): string[] =>
    cascadeBriefClaimPrivacyDelete(db, deletedDocIds),
  "cognition.personAnnotationCreate": (db: Db, input: CreatePersonAnnotationInput, now: number) =>
    createPersonAnnotation(db, input, now),
  "cognition.personAnnotationCreateSuperseding": (
    db: Db,
    input: CreatePersonAnnotationInput,
    supersedesId: string,
    now: number,
  ) => createPersonAnnotationSuperseding(db, input, supersedesId, now),
  "cognition.personAnnotationSupersede": (
    db: Db,
    id: string,
    supersededById: string,
    now: number,
  ): { superseded: boolean } => supersedePersonAnnotationBy(db, id, supersededById, now),
  "cognition.personAnnotationRevise": (
    db: Db,
    id: string,
    patch: UpdatePersonAnnotationPatch,
    now: number,
  ): boolean => revisePersonAnnotation(db, id, patch, now),
  "cognition.personAnnotationRetract": (db: Db, id: string, now: number): boolean =>
    retractAnnotationWithDependentRechecks(db, "person", id, now, () =>
      deletePersonAnnotation(db, id),
    ),
  "cognition.personAnnotationInvalidate": (db: Db, docId: string, now: number) =>
    invalidatePersonAnnotationsForDoc(db, docId, now),
  "cognition.personAnnotationPrivacyDelete": (db: Db, deletedDocIds: readonly string[]): string[] =>
    cascadePersonAnnotationPrivacyDelete(db, deletedDocIds),
  "conversationReadState.markSeen": (db: Db, conversationId: string): void =>
    markConversationOpened(db, conversationId),
  "conversationReadState.agentContentArrived": (
    db: Db,
    conversationId: string,
    now: number,
  ): { openedEpisode: boolean } => recordAgentMessage(db, conversationId, now),
  "conversationReadState.forget": (db: Db, conversationIds: readonly string[]): void =>
    forgetConversationReadState(db, conversationIds),
  "devAnnotations.create": (db: Db, input: CreateDevAnnotationInput, now: number) =>
    createDevAnnotation(db, input, now),
  "devAnnotations.resolve": (db: Db, id: string, now: number, resolvedNote?: string | null) =>
    resolveDevAnnotation(db, id, now, resolvedNote),
  "devAnnotations.delete": (db: Db, id: string): boolean => deleteDevAnnotation(db, id),
  "privacy.answerBegin": (db: Db, input: BeginAnswerTaskInput) => beginAnswerTask(db, input),
  "privacy.answerComplete": (db: Db, input: CompleteAnswerTaskInput) =>
    completeAnswerTask(db, input),
  "privacy.answerFail": (
    db: Db,
    taskId: string,
    ownerId: string,
    now: number,
    failure?: AnswerFailureSummary,
  ): boolean => failAnswerTask(db, taskId, ownerId, now, failure),
  "privacy.approvalResolve": (db: Db, input: ResolveApprovalInput) =>
    resolvePrivacyApproval(db, input),
  "privacy.approvalsExpire": (db: Db, now: number): number => expirePrivacyApprovals(db, now),
  "privacy.answersRecover": (db: Db, now: number): number => recoverInterruptedAnswerTasks(db, now),
  "privacy.auditAppend": (db: Db, inputs: ReadonlyArray<AppendAnswerAuditEventInput>): void =>
    appendAnswerAuditEvents(db, inputs),
  "privacy.directAuditAppend": (
    db: Db,
    input: AppendDirectAuditEventInput,
  ): { sessionId: string; eventId: string } => {
    const { session, eventId } = appendDirectAuditEvent(db, input);
    return { sessionId: session.id, eventId };
  },
  "privacy.directSessionDelete": (db: Db, sessionId: string): boolean =>
    deleteDirectAuditSession(db, null, sessionId),
  "privacy.egressRecord": (db: Db, input: RecordAnswerEgressInput) =>
    recordAnswerEgress(db, input, recordMcpToolInvocationAudit, currentDeviceAnswerOwner),
  "privacy.conversationDelete": (db: Db, input: DeletePrivacyConversationInput): boolean =>
    deletePrivacyConversation(db, input),
  "privacy.policyCommit": (db: Db, input: CommitPrivacyPolicyInput) =>
    commitPrivacyPolicy(db, input),
  "privacy.policyDelete": (db: Db, familyId: string, now: number) =>
    deletePrivacyPolicyFamily(db, familyId, now),
  "privacy.policyMirrorSynced": (db: Db, generation: number, digest: string) =>
    markPrivacyPolicyMirrorSynced(db, generation, digest),
  "privacy.completionsClaim": (db: Db, input: ClaimAnswerCompletionDeliveriesInput) =>
    claimAnswerCompletionDeliveries(db, input),
  "privacy.completionAuthorize": (db: Db, input: AuthorizeAnswerCompletionDeliveryInput) =>
    authorizeAnswerCompletionDelivery(db, input),
  "privacy.completionSettle": (db: Db, input: SettleAnswerCompletionDeliveryInput) =>
    settleAnswerCompletionDelivery(db, input),
  "subscriptions.create": (db: Db, input: CreateSubscriptionMutation) =>
    createSubscription(db, input),
  "subscriptions.setStatus": (
    db: Db,
    input: {
      subscriptionId: string;
      integrationDeviceId: string;
      expectedRevision: number;
      status: "active" | "paused";
      policyRevision: string;
      updatedAt: number;
    },
  ) => setSubscriptionStatus(db, input),
  "subscriptions.resolveApproval": (db: Db, input: ResolveSubscriptionApprovalMutation) =>
    resolveSubscriptionApproval(db, input),
  "subscriptions.privacyReviewRecord": (db: Db, input: RecordSubscriptionPrivacyReviewMutation) =>
    recordSubscriptionPrivacyReview(db, input),
  "subscriptions.revoke": (db: Db, input: RevokeSubscriptionMutation) =>
    revokeSubscription(db, input),
  "subscriptions.purge": (db: Db, input: PurgeSubscriptionMutation) => purgeSubscription(db, input),
  "subscriptions.fire": (db: Db, input: FireSubscriptionMutation) => fireSubscription(db, input),
  "subscriptions.deliveriesClaim": (db: Db, input: ClaimSubscriptionDeliveriesMutation) =>
    claimSubscriptionDeliveries(db, input),
  "subscriptions.deliveryCommitAuthorize": (
    db: Db,
    input: AuthorizeSubscriptionDeliveryCommitMutation,
  ) => authorizeSubscriptionDeliveryCommit(db, input),
  "subscriptions.deliverySettle": (db: Db, input: SettleSubscriptionDeliveryMutation) =>
    settleSubscriptionDelivery(db, input),
  "subscriptions.answerAuthorityIssue": (
    db: Db,
    input: IssueSubscriptionFiringAnswerAuthorityMutation,
  ) => issueSubscriptionFiringAnswerAuthority(db, input),
  "subscriptions.outcomeAuthorityIssue": (
    db: Db,
    input: IssueSubscriptionFiringOutcomeAuthorityMutation,
  ) => issueSubscriptionFiringOutcomeAuthority(db, input),
  "subscriptions.outcomeRecord": (db: Db, input: RecordSubscriptionFiringOutcomeMutation) =>
    recordSubscriptionFiringOutcome(db, input),
  "subscriptions.answerAuthorityUse": (
    db: Db,
    input: UseSubscriptionFiringAnswerAuthorityMutation,
  ) => useSubscriptionFiringAnswerAuthority(db, input),
  "subscriptions.answerEgressFinalize": (
    db: Db,
    input: FinalizeSubscriptionFiringAnswerEgressMutation,
  ) => finalizeSubscriptionFiringAnswerEgress(db, input),
  "subscriptions.expire": (db: Db, now: number): number => expireSubscriptions(db, now),
  "subscriptions.reconcilePolicy": (db: Db, policyRevision: string, reconciledAt: number): number =>
    reconcileSubscriptionsPolicy(db, policyRevision, reconciledAt),
  "cognition.bootstrapMarkProcessed": (db: Db, docIds: readonly string[], nowIso: string): number =>
    markDocsBootstrapProcessed(db, docIds, nowIso),
  "cognition.bootstrapReadmitFailed": (db: Db, docId: string): boolean =>
    readmitFailedBootstrapDoc(db, docId),
  "cognition.engineCounterAdd": (db: Db, key: string, delta: number): void =>
    addToCognitionEngineCounter(db, key, delta),
  "cognition.coverageRecord": (
    db: Db,
    deltas: readonly CognitionCoverageDelta[],
    now: number,
  ): number => recordCognitionCoverage(db, deltas, now),
  "cognition.coverageRetractOrphans": (db: Db): number => retractOrphanCognitionCoverage(db),
  "cognition.sweepTallyRecord": (db: Db, delta: SweepTallyDelta, now: number): void =>
    recordSweepTally(db, delta, now),
  "temporalAnnotations.create": (db: Db, input: CreateTemporalAnnotationInput, now: number) =>
    insertTemporalAnnotation(db, input, now),
  "temporalAnnotations.update": (
    db: Db,
    id: string,
    patch: UpdateTemporalAnnotationPatch,
    now: number,
  ) => updateTemporalAnnotation(db, id, patch, now),
  "temporalAnnotations.invalidate": (db: Db, id: string, now: number): boolean =>
    invalidateTemporalAnnotation(db, id, now),
  "temporalAnnotations.invalidateForDoc": (
    db: Db,
    docId: string,
    now: number,
  ): TemporalAnnotationInvalidationResult => invalidateTemporalAnnotationsForDoc(db, docId, now),
  "temporalAnnotations.refilePresented": (db: Db, ids: readonly string[], runId: string): null => {
    markTemporalAnnotationsRefilePresented(db, ids, runId);
    return null;
  },
  "temporalAnnotations.privacyDelete": (db: Db, deletedDocIds: readonly string[]): string[] =>
    cascadeTemporalAnnotationPrivacyDelete(db, deletedDocIds),
  "cognition.briefCreate": (
    db: Db,
    input: CreateBriefInput,
    dependencies: ConsumptionDependencyContext,
    now: number,
  ) =>
    mutateWithConsumptionDependencies(db, dependencies, "brief", input.id, now, () =>
      createBrief(db, input, now),
    ),
  "cognition.briefUpdate": (
    db: Db,
    id: string,
    input: UpdateBriefInput,
    dependencies: ConsumptionDependencyContext,
    now: number,
  ) =>
    mutateWithConsumptionDependencies(db, dependencies, "brief", id, now, () =>
      updateBrief(db, id, input, now),
    ),
  "cognition.briefRetire": (db: Db, id: string, now: number) => retireBrief(db, id, now),
  "cognition.briefRetractForLoop": (db: Db, loopId: string, now: number) =>
    retractBriefsForResolvedLoop(db, loopId, now),
  "cognition.briefDismiss": (db: Db, input: DismissBriefInput, now: number) =>
    dismissBriefAndEnqueueFeedback(db, input, now),
  "cognition.briefMarkRead": (db: Db, id: string, now: number) => markBriefRead(db, id, now),
  "cognition.briefSetThread": (db: Db, id: string, conversationId: string, now: number) =>
    setBriefThreadConversation(db, id, conversationId, now),
  "cognition.briefRestampThread": (
    db: Db,
    id: string,
    deadId: string,
    conversationId: string,
    now: number,
  ) => restampBriefThreadConversation(db, id, deadId, conversationId, now),
  "cognition.snoozeResurface": (db: Db, now: number): number => resurfaceDueSnoozedBriefs(db, now),
  "cognition.notesWrite": (db: Db, content: string, opts: { maxBytes: number; now: number }) =>
    writeCognitionNotes(db, content, opts),
  "cognition.notesAppend": (db: Db, text: string, opts: { maxBytes: number; now: number }) =>
    appendCognitionNotes(db, text, opts),
  "cognition.notesEdit": (
    db: Db,
    oldText: string,
    newText: string,
    opts: { maxBytes: number; now: number },
  ) => editCognitionNotes(db, oldText, newText, opts),
  "cognition.notesWipe": (db: Db, now: number): void => wipeCognitionNotes(db, now),

  // ── omnesis-chat ──────────────────────────────────────────────────
  // Conversations as first-class documents. Replaces
  // the full `link_type='cited'` edge set for a conversation document
  // with the supplied citation list. Pure write, no resolution; targets
  // arrive already resolved as document IDs (the agent's `annotate`
  // tool passed them).
  "omnesisChat.upsertConversationCitations": (
    db: Db,
    sourceDocId: string,
    citations: ReadonlyArray<ConversationCitationInput>,
  ) => upsertConversationCitations(db, sourceDocId, citations),

  // ── omnesis-notes ─────────────────────────────────────────────────
  // The quick-capture ledger (`note_entries`). Append is the hot path
  // (one row per captured note); update/delete are the user's edit and
  // hard-delete of a single entry. The per-day document projection is
  // driven separately by the NotesDayUpserter, not by these ops.
  "notes.appendEntry": (db: Db, entry: NoteEntry, audit?: McpToolInvocationAuditInput): boolean =>
    insertNoteEntry(db, entry, audit),
  "notes.updateEntry": (db: Db, id: string, text: string, nowIso: string): boolean =>
    updateNoteEntryText(db, id, text, nowIso),
  "notes.deleteEntry": (db: Db, id: string) => deleteNoteEntry(db, id),

  // Append one pushed agent-conversation turn to the ledger. The per-bucket
  // day-document projection is driven separately by the
  // AgentConversationsUpserter, not by this op.
  "agentMessages.appendMessage": (db: Db, m: AgentMessageRow): boolean => insertAgentMessage(db, m),

  // ── near-dupes ────────────────────────────────────────────────────
  // Writer-side enqueue of inbox rows from event-bus subscribers.
  // The dedup index keeps one row per (doc, reason); a re-enqueue replaces
  // it rather than being ignored, so the row carries the newest id.
  "nearDup.enqueueInbox": (db: Db, docIds: ReadonlyArray<string>, reason: NearDupInboxReason) =>
    enqueueNearDupInbox(db, docIds, reason),
  // Boot-time algo-version bump. Idempotent — re-running with the
  // already-active version is a no-op. Single transaction inside the
  // helper, so this op doesn't need to yield.
  "nearDup.bumpAlgo": (db: Db, config: ResolvedNearDupConfig) => bumpNearDupAlgo(db, config),
  // One-shot pass through the four near-dup tables, deleting up to
  // `chunkSize` rows tagged with non-active algos. Returns
  // `{cleared, done}` — the periodic task calls this in a loop until
  // `done: true`. Not yieldable; one pass fits in <100ms.
  "nearDup.algoSweepStep": (db: Db, config: ResolvedNearDupConfig) => algoSweepStep(db, config),
  "nearDup.generationSweepStep": (db: Db, config: ResolvedNearDupConfig) =>
    generationSweepStep(db, config),
  // OCC dirty-mark for the DF refresh job. Direct callers (admin
  // tools, tests) bump this; production code bumps inline from the
  // ingest path via the DB cascade hooks.
  "nearDup.markDfDirty": (db: Db): void => {
    markNearDupDfDirty(db);
  },
} as const;

/**
 * Yieldable variants. Handler signature is `(db, token, ...args)` instead
 * of `(db, ...args)`. May return a `{kind:"yield", resume}` outcome to
 * cooperatively yield mid-flight (`asOutcome()` in the runner detects it
 * and re-enqueues at the same priority).
 *
 * Names listed here are dispatched first in the writer worker. The
 * non-yieldable fallback only applies when a name appears in
 * `writerHandlers` and not here.
 */
export const writerYieldableHandlers = {
  /**
   * Cooperative-yield variant of `db.upsertDocuments`. Processes the
   * docs in chunks (one transaction per chunk); between chunks, polls
   * the preempt token. If a higher-priority op is waiting, returns a
   * yield outcome with the remaining docs as the continuation arg —
   * Scheduler re-enqueues at the same priority and the higher-priority
   * op runs in between.
   */
  "db.upsertDocuments": (
    db: Db,
    token: PreemptToken,
    docs: DocumentInput[],
    writeEpochs?: Readonly<Record<string, number>>,
    cursorRows?: Readonly<Record<string, string>>,
    streams?: Readonly<Record<string, string>>,
    replicaVersionPolicies?: Readonly<Record<string, "source-updated-at">>,
    priorIgnoredReplicaDocuments: Array<{ sourceId: string; externalId: string }> = [],
    priorSuppressedDocuments: Array<{ sourceId: string; externalId: string }> = [],
  ) => {
    const result = upsertDocuments(db, docs, {
      token,
      writeEpochs,
      cursorRows,
      streams,
      replicaVersionPolicies,
    });
    if (result.remaining.length > 0) {
      // Carry the specs into the continuation so yielded chunks
      // still canonicalize.
      return {
        kind: "yield" as const,
        resume: [
          result.remaining,
          writeEpochs,
          cursorRows,
          streams,
          replicaVersionPolicies,
          [...priorIgnoredReplicaDocuments, ...result.ignoredReplicaDocuments],
          [...priorSuppressedDocuments, ...result.suppressedDocuments],
        ],
      };
    }
    return {
      rejectedSourceIds: result.rejectedSourceIds,
      ignoredReplicaDocuments: [...priorIgnoredReplicaDocuments, ...result.ignoredReplicaDocuments],
      suppressedDocuments: [...priorSuppressedDocuments, ...result.suppressedDocuments],
    };
  },

  /**
   * Cooperative-yield variant of `db.upsertWithCursor`. The collector's
   * per-page sync goes through here at realtime priority — when the
   * page carries more than `UPSERT_WITH_CURSOR_CHUNK_SIZE` documents,
   * the handler chunks the upserts and yields between chunks so the
   * writer queue can drain other realtime work (e.g. token usage
   * flushes, sessions, sync-state writes from other sources) instead
   * of parking 12-25s on one big page.
   *
   * Correctness invariants — see the `upsertWithCursorYieldable`
   * doc-comment in DocumentRepository.ts. Briefly:
   *   - Cursor advance happens ONLY in the final chunk (atomic with
   *     deletes + reconcile). A crash or yield before the final chunk
   *     leaves the cursor stale; collector retry re-sends the page;
   *     idempotent upserts make the retry safe.
   *   - Deletes + reconcile + setSyncState run together in the final
   *     transaction, preserving the original all-or-nothing
   *     guarantee on those operations.
   */
  "db.upsertWithCursor": (db: Db, token: PreemptToken, args: UpsertWithCursorArgs) => {
    const outcome = upsertWithCursorYieldable(db, args, { token });
    if (outcome.kind === "yield") {
      return { kind: "yield" as const, resume: [outcome.resume] };
    }
    return outcome.value;
  },

  /**
   * Yieldable people backfill — per-doc transactions, breaks on
   * higher-priority enqueue. Caller (periodic task on main runner)
   * sees the partial result and schedules the next tick.
   */
  "people.backfillManyPeople": (db: Db, token: PreemptToken, batchSize?: number) =>
    backfillManyPeople(db, batchSize, { token }),

  /**
   * Yieldable people rebuild. The `reset` phase clears the people graph +
   * re-seeds (one bounded unit); the `flags` phase clears the O(corpus)
   * `people_resolved_at` markers in batches, polling the token between them.
   * The resume carries the hooks and the phase string (`"flags"`) — plain
   * data, wire-safe. See `rebuildPeopleFromDocuments` for the ordering
   * rationale.
   */
  "people.rebuildPeopleFromDocuments": (
    db: Db,
    token: PreemptToken,
    hooks: readonly SelfIdentitySource[],
    phase: RebuildPhase = "reset",
  ) => {
    const r = rebuildPeopleFromDocuments(db, hooks, token, phase);
    if (r) return { kind: "yield" as const, resume: [hooks, r.resume] };
    return undefined;
  },

  /**
   * Yieldable auto-detect applicator. Same shape as the dedup below: each
   * candidate is one bounded unit (a cluster's physical merge, or one rule
   * insert), and the orchestrator polls the token between them and carries
   * the remaining candidates + running counts on a yield. The resume payload
   * is plain rule sides + numbers, so it is wire-safe. On a continuation the
   * leading `candidates` argument is empty — the resume state carries what is
   * left, so the full set is not re-cloned across worker IPC each time.
   *
   * Yieldable because the candidate set does not drain: a cluster the
   * applicator permanently refuses is re-detected on every 5-minute pass, so
   * without a seam that occupancy recurs for the life of the install.
   */
  "people.upsertAutoDetectedRules": (
    db: Db,
    token: PreemptToken,
    candidates: AutoDetectedRule[],
    resume?: AutoDetectUpsertResumeState,
  ) => {
    const r = upsertAutoDetectedRules(db, candidates, token, resume);
    if (r.resume) {
      return { kind: "yield" as const, resume: [[], r.resume] };
    }
    return { inserted: r.inserted, skipped: r.skipped };
  },

  /**
   * Yieldable strong-identifier dedup. Each cluster's merge is its own
   * bounded transaction; the orchestrator polls the token between clusters
   * and carries the remaining cluster keys + running counts on a yield. The
   * resume payload is plain `{alias_type, alias}` structs + numbers, so it is
   * wire-safe. See the store function for the stale-key rationale.
   */
  "people.physicalDedupSharedAliases": (
    db: Db,
    token: PreemptToken,
    resume?: PhysicalDedupResumeState,
  ) => {
    const r = physicalDedupSharedAliases(db, token, resume);
    if (!r.done) {
      return {
        kind: "yield" as const,
        resume: [
          {
            clusters: r.resumeClusters,
            clustersProcessed: r.clustersProcessed,
            peopleMerged: r.peopleMerged,
          },
        ],
      };
    }
    return { clustersProcessed: r.clustersProcessed, peopleMerged: r.peopleMerged };
  },

  /**
   * Yieldable variant of `tokens.touchTokenUsageBatch`. Per-row
   * commit; token poll between rows. Without this the batch flush
   * parked the writer for several seconds at a time when many
   * tokens had accumulated in the buffer, leaving realtime ops
   * like `db.setSyncError` waiting (observed: 2.2s realtime queue
   * time behind a 3.5s touchTokenUsageBatch).
   *
   * Worker IPC strips brand types, so we re-brand at the boundary.
   * SQLITE_BUSY is swallowed — token usage is informational and a
   * missed beacon comes back on the next flush tick.
   */
  "tokens.touchTokenUsageBatch": (
    db: Db,
    token: PreemptToken,
    rows: ReadonlyArray<{ tokenId: string; deviceId: string }>,
  ) => {
    if (!rows || rows.length === 0) return undefined;
    const branded = rows.map((r) => ({
      tokenId: TokenId(r.tokenId),
      deviceId: DeviceId(r.deviceId),
    }));
    try {
      const result = touchTokenUsageBatch(db, branded, { token });
      if (result.remaining.length > 0) {
        // Resume args are passed back through the wire so they need
        // to be plain (non-branded) — strip the brands. The handler
        // re-brands them on the next invocation.
        const plain = result.remaining.map((r) => ({
          tokenId: r.tokenId as unknown as string,
          deviceId: r.deviceId as unknown as string,
        }));
        return { kind: "yield" as const, resume: [plain] };
      }
      return undefined;
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== "SQLITE_BUSY") throw err;
      return undefined;
    }
  },

  /**
   * Yieldable apply of an extraction batch. The token is polled between
   * documents and between chunks within a document, so higher-priority
   * writer work can preempt either way. Returns the applied/skipped/
   * extracted counters AND `remaining` — the rows not yet done. When
   * `remaining` is non-empty the runner re-enqueues at the same priority
   * with those rows as the next call's args.
   *
   * Correctness: a document is not atomic, by design — it spans one
   * transaction per chunk of links. What makes that safe is that
   * `links_extracted_at` is stamped only after the last chunk, so a
   * document stopped part-way still reads as un-extracted and is never
   * mistaken for a finished one. A preempted document comes back carrying
   * how far it got and resumes there; a crashed one comes back carrying
   * nothing and is redone from the delete, which is idempotent.
   * `markLinkStatsDirty` fires per document so the link-stats refresh
   * picks up partial progress.
   */
  "links.upsertExtractedLinksBatch": (
    db: Db,
    token: PreemptToken,
    rows: ExtractedLinkBatchEntry[],
  ) => {
    const result = upsertExtractedLinksBatch(db, rows, { token });
    if (result.remaining.length > 0) {
      return { kind: "yield" as const, resume: [result.remaining] };
    }
    return {
      applied: result.applied,
      skipped: result.skipped,
      extracted: result.extracted,
    };
  },

  /**
   * Bounded URL-reconciliation apply. Each continuation performs at most
   * fifty mutations in one transaction, then polls the preemption token.
   * The running counters and phase offset travel in the continuation; the
   * durable scan cursors advance only after every mutation phase completes.
   */
  "links.upsertLinkResolutions": (
    db: Db,
    token: PreemptToken,
    input: LinkReconcileBatch | LinkReconcileApplyState,
  ) => {
    const result = upsertLinkResolutionsYieldable(db, input, { token });
    if (result.remaining !== null) {
      return { kind: "yield" as const, resume: [result.remaining] };
    }
    return {
      updated: result.updated,
      deleted: result.deleted,
      retargeted: result.retargeted,
    };
  },

  /**
   * Yieldable apply of a NearDupApplyBatch. Per-doc sub-transactions
   * with a token poll between docs. When the token requests yield we
   * pack the un-applied tail into `remaining` and re-enqueue at the
   * same priority — the higher-priority op slots in between, and the
   * next call resumes where we left off.
   */
  "nearDup.applyBatch": (db: Db, token: PreemptToken, batch: NearDupApplyBatch) => {
    const result = applyNearDupBatch(db, batch, { token });
    if (result.remaining !== null) {
      return { kind: "yield" as const, resume: [result.remaining] };
    }
    return stripRemaining(result);
  },

  /**
   * Chunked apply of a staged DF build. Inserts in batches of
   * DF_APPLY_CHUNK_SIZE, yielding between chunks when the time slice expires
   * or the token fires so same- and higher-priority writes can interleave.
   * Progress is a keyset position in the staging table, carried on the resume.
   */
  "nearDup.applyDfFromStaging": (
    db: Db,
    token: PreemptToken,
    input: {
      stagingPath: string;
      stagingKeyHex?: string;
      algoVersion: string;
      totalDocs: number;
      minDf: number;
      capturedVersion: number;
      expectedRows: number;
    },
    resume: { afterShingle: string | null; applied: number; generation?: number } = {
      afterShingle: null,
      applied: 0,
    },
  ) => {
    const result = applyNearDupDfFromStaging(db, input, resume, {
      token,
      maxSliceMs: NEAR_DUP_DF_APPLY_SLICE_MS,
    });
    if (!result.done) {
      return {
        kind: "yield" as const,
        // The generation travels with the resume. Without it the
        // continuation picks a fresh one and the build ends up split
        // across two, with only the last of them published.
        resume: [
          input,
          {
            afterShingle: result.nextAfterShingle,
            applied: result.rebuilt,
            generation: result.generation,
          },
        ],
      };
    }
    return { rebuilt: result.rebuilt };
  },
} as const;

export type WriterHandlers = typeof writerHandlers;
export type WriterYieldableHandlers = typeof writerYieldableHandlers;

/** Union of every dispatchable writer op name. */
export type WriterOpName = keyof WriterHandlers | keyof WriterYieldableHandlers;

/** Args (post-`db`) accepted by the handler for a given op name. */
export type WriterArgs<K extends WriterOpName> = K extends keyof WriterYieldableHandlers
  ? WriterYieldableHandlers[K] extends (db: Db, token: PreemptToken, ...rest: infer A) => unknown
    ? A
    : never
  : K extends keyof WriterHandlers
    ? WriterHandlers[K] extends (db: Db, ...rest: infer A) => unknown
      ? A
      : never
    : never;

/**
 * Sync return type of the handler. The gate wraps it in a Promise. For
 * yieldable ops we strip the yield-outcome variant since it isn't a
 * value the caller observes — the runner unwraps it via `asOutcome()`.
 */
export type WriterReturn<K extends WriterOpName> = K extends keyof WriterYieldableHandlers
  ? WriterYieldableHandlers[K] extends (...args: never) => infer R
    ? Exclude<R, { kind: "yield"; resume: unknown }>
    : never
  : K extends keyof WriterHandlers
    ? WriterHandlers[K] extends (...args: never) => infer R
      ? R
      : never
    : never;

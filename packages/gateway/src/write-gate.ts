// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { promoteSourceWireContract } from "./data/repositories/SourceWireContractRepository.js";
import { replaceSourceSyncIssues } from "./data/repositories/SourceSyncIssueRepository.js";
import type {
  SyncIssue,
  SyncIssueAssessment,
  SyncRemediation,
  DocumentInput,
  PersonMention,
  Scope,
  DeviceId,
  DeviceCapability,
  DeviceKind,
  DeviceUpdateState,
  DeviceRecord,
  ApnsRegistration,
  FcmRegistration,
  NotificationDeliveryHealth,
  SourceId,
  SourceType,
  AccountId,
  MultiDeviceMode,
  TokenId,
} from "@omnesis/types";
import {
  preparePendingSourcePage,
  acknowledgePendingSourcePage,
  type PendingSourcePage,
  type PreparePendingSourcePage,
} from "./data/repositories/PendingSourcePageRepository.js";

/**
 * WriteGate is the uniform surface for every write against `omnesis.db`.
 *
 * Production code (index.ts → createServer, WS handlers) hands in a
 * gate produced by `writeGateFromScheduler(scheduler)` — that gate
 * routes each typed method through the Scheduler's writer runner
 * (which owns the single writable handle on omnesis.db). Tests that don't need the
 * crash-protection invariant hand in `directWriteGate(db)`, which
 * just wraps the sync write functions in `Promise.resolve` and runs
 * them on the test's own db handle.
 *
 * Why this indirection: the Scheduler-backed gate round-trips every
 * call over a worker `postMessage`, which requires spawning a Worker.
 * Doing that once per test case would add seconds per test file and
 * force every test onto real file-backed DBs. Keeping a sync fallback
 * lets unit tests stay fast without giving up the single-writer
 * invariant in production.
 *
 * All methods are typed; the corresponding op names live in
 * `scheduler/write-ops.ts` (one Task per method). Add new ops by
 * extending both this interface and the WriteOps registry.
 */

import type { AccountDescriptor, SourceSyncMeta, SyncCursor } from "@omnesis/source-sdk";
import { advanceOccWatermark } from "./data/occ-materialized.js";
import type { PairingGenerationFence } from "./data/pairing-generation-fence.js";
import { withPairingGenerationFence } from "./data/pairing-generation-fence.js";
type Db = Database.Database;

import {
  cleanupExpiredAccessStateBatch,
  createAccessLevel,
  createAuthorizationRequest,
  createExecutionBinding,
  decideAuthorizationRequest,
  deleteAccessLevel,
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
  setConnectionLevel,
  setDeviceLevel,
  touchPrincipalCredentialUsageBatch,
  updateAccessGrant,
  updateAccessLevel,
  type AccessCleanupPhase,
  type AccessCleanupResult,
  type OAuthClientCleanupCursor,
  type AccessMutationResult,
} from "./access/store.js";
import { currentDeviceAnswerOwner } from "./access/device-answer-scope.js";
import type {
  AccessConnectionLevelInput,
  AccessDeviceLevelInput,
  AccessDeviceLevelResult,
  AccessConnectionLevelResult,
  AccessLevelCreateInput,
  AccessLevelDeleteInput,
  AccessLevelSummary,
  AccessLevelUpdateInput,
  AccessPrincipal,
  AccessPrincipalRenameInput,
  AccessRevocationInput,
  AccessGrantUpdateInput,
  AccessGrantUpdateResult,
  AccessAuthorizationNotificationEnqueueResult,
  AuthorizationRequestCreateInput,
  AuthorizationRequestDecisionInput,
  AuthorizationRequestPublic,
  ExecutionBindingCreateInput,
  ExecutionBindingCreateResult,
  OAuthClientRegistration,
  OAuthClientRegistrationInput,
  OAuthClientMetadataDocument,
  OAuthTokenExchangeInput,
  OAuthTokenSet,
  McpToolInvocationAuditInput,
} from "./access/types.js";

import {
  upsertDocuments,
  upsertWithCursor,
  prepareDocumentsForWrite,
  deleteDocuments,
  cascadeOpenLoopPrivacyDeleteWithMirrors,
  deleteDocumentForUser,
  deleteDocumentForRetention,
  completeDocumentRetention,
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
  applySnapshotAbsencePlan,
  applyReplicaOmissions,
  type ReplicaOmissionArgs,
  type ReplicaVerdictOutcome,
  judgeAnalyticsTombstones,
  recordAnalyticsPresence,
  recordAnalyticsRestorerOmissions,
  recordAnalyticsSweepVerdict,
  type AnalyticsTombstoneArgs,
  type AnalyticsTombstoneVerdict,
  type AnalyticsPresenceArgs,
  type AnalyticsRestorerSnapshotArgs,
  type AnalyticsSweepVerdict,
  reclaimStaleAbsences,
  acknowledgeAbsenceCascade,
  deleteDocumentsByIds,
  sweepDueAbsences,
  type SourceStatsAggregation,
  type AbsenceSweepBatch,
  type SnapshotAbsenceApplied,
  type SnapshotAbsencePlan,
  type StaleAbsenceCandidate,
  type UpsertWithCursorArgs,
  type UpsertWithCursorResult,
  type DeleteAllByStreamResult,
} from "./db.js";
import {
  findOrCreatePerson,
  resolveDocumentPeople,
  backfillManyPeople,
  seedFromContacts,
  upsertSeedFromContacts,
  detectSelfFromSourceIds,
  mergePeople,
  unmergePerson,
  runMergePass,
  collapseTransitiveChains,
  upsertTransitiveCollapse,
  rebuildPeopleFromDocuments,
  refreshPeopleCounts,
  upsertPeopleCounts,
  upsertInteractionScores,
  markPeopleGraphDirty,
  createMergeRule,
  deleteMergeRule,
  deleteMergeRuleGroup,
  upsertAutoDetectedRules,
  upsertMergeEquivalences,
  type AutoDetectedRule,
  type CreateMergeRuleInput,
  type CreateMergeRuleResult,
  type InteractionScoresSnapshot,
  type MergeEquivalenceSnapshot,
  type PeopleCountRow,
  type SeedFromContactsPlan,
  type TransitiveCollapseRow,
  type UpsertMergeEquivalencesResult,
} from "./people.js";
import { physicalDedupSharedAliases } from "./physical-merge.js";
import { pruneNoreplyAliases } from "./bootstrap/prune-noreply-aliases.js";
import { upgradePlaceholderCanonicalNames } from "./bootstrap/upgrade-placeholder-canonical-names.js";
import {
  demoteSharedAddresses,
  type DemoteSharedAddressesResult,
} from "./domain/SharedAddressDemotion.js";
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
  type TokenLabelRow,
  type MergeClusterResult,
  type AcceptMergeCandidateInput,
  type AcceptMergeCandidateResult,
  type ApplyMergeAdjudicationInput,
  type ApplyMergeAdjudicationResult,
  type MergeCandidateProposal,
  type MergeCandidateRow,
  type UpsertMergeCandidatesResult,
} from "./merge-candidates.js";
import { drainPendingEdges } from "./domain/EdgeDeclarationWriter.js";
import {
  reconcileUnresolvedLinks,
  upsertLinkResolutions,
  upsertExtractedLinksBatch,
  markLinkStatsDirty,
  upsertLinkStats,
  type LinkReconcileBatch,
  type ExtractedLinkBatchEntry,
  type LinkStatsAggregation,
} from "./links.js";
import { reconcileLinkStatsCounters } from "./data/repositories/LinkStatsRepository.js";
import { beginLinkDeclarationUpdate, finishLinkDeclarationUpdate } from "./data/list-revisions.js";
import { applyExtractedDates as applyExtractedDatesToDb } from "./enrichment/dates/storage.js";
import type { DateExtractionResult } from "./enrichment/dates/extractor.js";
import {
  insertTemporalAnnotation,
  updateTemporalAnnotation,
  invalidateTemporalAnnotation,
  invalidateTemporalAnnotationsForDoc,
  markTemporalAnnotationsRefilePresented,
  cascadeTemporalAnnotationPrivacyDelete,
  type CreateTemporalAnnotationInput,
  type UpdateTemporalAnnotationPatch,
  type TemporalAnnotation,
  type TemporalAnnotationInvalidationResult,
} from "./enrichment/temporal-annotations/storage.js";
import {
  markDocsBootstrapProcessed,
  readmitFailedBootstrapDoc,
} from "./brain/storage/bootstrap.js";
import {
  recordCognitionCoverage,
  retractOrphanCognitionCoverage,
  type CognitionCoverageDelta,
} from "./brain/storage/coverage.js";
import { recordSweepTally, type SweepTallyDelta } from "./brain/storage/sweep-tally.js";
import {
  forgetConversationReadState,
  markConversationOpened,
  recordAgentMessage,
} from "./agent/conversation-read-state.js";
import {
  createDevAnnotation,
  resolveDevAnnotation,
  deleteDevAnnotation,
  type CreateDevAnnotationInput,
  type DevAnnotationRow,
} from "./dev-annotations/store.js";
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
  authorizeAnswerCompletionDelivery,
  claimAnswerCompletionDeliveries,
  settleAnswerCompletionDelivery,
  type AppendAnswerAuditEventInput,
  type AppendDirectAuditEventInput,
  type BeginAnswerTaskInput,
  type BegunAnswerTask,
  type CompleteAnswerTaskInput,
  type DeletePrivacyConversationInput,
  type RecordAnswerEgressInput,
  type RecordedAnswerEgress,
  type ResolveApprovalInput,
  type AuthorizeAnswerCompletionDeliveryInput,
  type ClaimedAnswerCompletionDelivery,
  type ClaimAnswerCompletionDeliveriesInput,
  type SettleAnswerCompletionDeliveryInput,
  type AnswerFailureSummary,
} from "./privacy/store.js";
import type { AnswerResponse } from "@omnesis/types/privacy";
import {
  commitPrivacyPolicy,
  deletePrivacyPolicyFamily,
  renamePrivacyPolicyFamily,
  type RenamePrivacyPolicyFamilyResult,
  type DeletePrivacyPolicyFamilyResult,
  markPrivacyPolicyMirrorSynced,
  type CommitPrivacyPolicyInput,
  type CommitPrivacyPolicyResult,
} from "./privacy/policy-history.js";
import {
  issueSubscriptionFiringOutcomeAuthority,
  recordSubscriptionFiringOutcome,
} from "./subscriptions/store-outcome-mutations.js";
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
} from "./subscriptions/store-mutations.js";
import type {
  AuthorizeSubscriptionDeliveryCommitMutation,
  AuthorizeSubscriptionDeliveryCommitMutationResult,
  ClaimedSubscriptionDelivery,
  ClaimSubscriptionDeliveriesMutation,
  CreateSubscriptionMutation,
  CreateSubscriptionMutationResult,
  EnqueueSubscriptionEvaluationMutation,
  EnqueueSubscriptionEvaluationMutationResult,
  FireSubscriptionMutation,
  FireSubscriptionMutationResult,
  IssueSubscriptionFiringAnswerAuthorityMutation,
  IssueSubscriptionFiringOutcomeAuthorityMutation,
  IssueSubscriptionFiringOutcomeAuthorityMutationResult,
  RecordSubscriptionFiringOutcomeMutation,
  RecordSubscriptionFiringOutcomeMutationResult,
  IssueSubscriptionFiringAnswerAuthorityMutationResult,
  PurgeSubscriptionMutation,
  PurgeSubscriptionMutationResult,
  RecordSubscriptionPrivacyReviewMutation,
  RecordSubscriptionPrivacyReviewMutationResult,
  ResolveSubscriptionApprovalMutation,
  ResolveSubscriptionApprovalMutationResult,
  RevokeSubscriptionMutation,
  RevokeSubscriptionMutationResult,
  ReviseSubscriptionMutation,
  ReviseSubscriptionMutationResult,
  SetSubscriptionStatusMutationResult,
  SettleSubscriptionDeliveryMutation,
  SettleSubscriptionDeliveryMutationResult,
  SettleSubscriptionEvaluationMutation,
  SettleSubscriptionEvaluationMutationResult,
  SubscriptionEvaluationDetail,
  UseSubscriptionFiringAnswerAuthorityMutation,
  ValidateSubscriptionFiringAnswerAuthorityResult,
  FinalizeSubscriptionFiringAnswerEgressMutation,
  FinalizeSubscriptionFiringAnswerEgressMutationResult,
} from "./subscriptions/store-types.js";
import {
  zeroPeopleCountsForLosers,
  recomputeNamePrimaries,
} from "./data/repositories/PersonRepository.js";
import { refreshSqliteTableStats } from "./sqlite-catalog.js";
import { reconcileSelfFromConfig } from "./domain/SelfIdentity.js";
import type { SelfIdentitySource } from "./self-identity-sources.js";
import {
  type AgentIntegrationPairingResult,
  type CreatePairingOptions,
  type PendingPairing,
  type DevicePairingRedemption,
  bootstrapSelfFromDevices,
  clearApnsToken,
  clearFcmToken,
  createDevice,
  createOrAdoptDevice,
  replaceDeviceForRepair,
  setApnsToken,
  setFcmToken,
  setNotificationDeliveryHealth,
  setDeviceUpdateRequest,
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
  type CreateOrAdoptDeviceResult,
  type RelayPushConsentOutcome,
  type RenameDeviceResult,
} from "./data/repositories/DeviceRepository.js";
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
} from "./data/repositories/DeviceDoctorRunRepository.js";
import {
  applyNearDupBatch,
  applyNearDupDfFromStaging,
  algoSweepStep,
  generationSweepStep,
  bumpNearDupAlgo,
  stripRemaining,
} from "./near-dupes/NearDupWriterOps.js";
import { enqueueNearDupInbox, type NearDupInboxReason } from "./near-dupes/inbox.js";
import {
  upsertConversationCitations,
  type ConversationCitationInput,
  type UpsertConversationCitationsResult,
} from "./sources/omnesis-chat/citation-writer.js";
import {
  insertNoteEntry,
  updateNoteEntryText,
  deleteNoteEntry,
  type NoteEntry,
} from "./sources/omnesis-notes/storage.js";
import { insertAgentMessage, type AgentMessageRow } from "./sources/agent-conversations/storage.js";
import { resolveDerivationStages, type DerivationStageId } from "./domain/DocumentDerivation.js";
import {
  pruneActivityRetentionBatch,
  reclaimActivityRetentionPages,
  type ActivityRetentionBatchResult,
  type ActivityRetentionPhase,
} from "./activity-retention/store.js";
import {
  enqueueCognitionRun,
  claimDueCognitionRuns,
  finalizeCognitionRun,
  recordSettledCognitionRun,
  cancelPendingCognitionRunsByDedupeKeys,
  pullForwardReadyCognitionRun,
  cancelScheduledRunsForLoop,
  addToCognitionEngineCounter,
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
  type ConsumptionMutationResult,
  type CognitionRunUsage,
  type EnqueueCognitionRunInput,
  type EnqueueCognitionRunResult,
  type FinalizeCognitionRunInput,
  type RecordSettledCognitionRunInput,
  type ClaimedCognitionRun,
  type CreateOpenLoopInput,
  type UpdateOpenLoopInput,
  type DeleteOpenLoopResult,
  type CreateBriefInput,
  type UpdateBriefInput,
  type DismissBriefInput,
  type DismissBriefResult,
  type MarkBriefReadResult,
  type AppendCognitionNotesResult,
  type EditCognitionNotesResult,
  type OpenLoopRow,
  type BriefRow,
  type CreateDocAnnotationInput,
  type UpdateDocAnnotationPatch,
  type DocAnnotationRow,
  type AnnotationInvalidationResult,
  type CreatePersonAnnotationInput,
  type UpdatePersonAnnotationPatch,
  type PersonAnnotationRow,
} from "./brain/index.js";
import { markNearDupDfDirty } from "./data/DirtyMarks.js";
import { isReminderDue, type ReauthBackoffConfig } from "./push/reauth-reminder-policy.js";
import {
  releaseMobilePermissionReminder,
  reserveMobilePermissionReminder,
  type MobilePermissionBackoffConfig,
  type MobilePermissionReminderReservation,
} from "./data/repositories/MobilePermissionHealthRepository.js";
import type { MobilePermissionHealthReport } from "@omnesis/types/mobile-permission-health";
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
  type DeleteDeviceResult,
  type OwnedPermissionHealthResult,
  type RemovedSource,
} from "./push/mobile-permission-operations.js";
import type { ResolvedNearDupConfig } from "./near-dupes/config.js";
import type { NearDupApplyBatch, NearDupApplyResult } from "./near-dupes/types.js";
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
} from "./data/repositories/TokenRepository.js";
import {
  createSourceWithId,
  addSourceMember,
  updateSourceForMember,
  updateExistingSourceMemberConfigOverride,
  markSourceRemoved,
  markSourceCleanupDone,
  clearSourceRemoved,
  clearSourceRemovedIfCleanupDone,
} from "./data/repositories/SourceRepository.js";
import type {
  RemoveSourceMemberResult,
  SourceRecord,
} from "./data/repositories/SourceRepository.js";
import {
  completeSourceModeTransitionPublication,
  finalizeSourceModeTransition,
  adoptSourceModeTransitionBatch,
  prepareSourceModeTransition,
  recordSourceModeTransitionFailure,
  recordSourceModeTransitionPublicationFailure,
  type SourceModeTransitionAdoptionBatch,
  type SourceModeTransition,
} from "./data/repositories/SourceModeTransitionRepository.js";
import type { SourceStreamCleanupJob } from "./data/repositories/SourceStreamCleanupRepository.js";
import {
  completeSourceStreamCleanup,
  recordSourceStreamCleanupFailure,
} from "./data/repositories/SourceStreamCleanupRepository.js";
import {
  upsertSourceDocumentProfiles,
  type SourceDocumentProfileEntry,
} from "./data/repositories/SourceDocumentProfileRepository.js";
import { buildSafeUrlCanonicalizerRegistry } from "./known-url-pattern-safety.js";
import { getUrlCanonicalizers, getUrlCanonicalizerSpecs } from "./url-canonicalizers.js";
import type { UrlCanonicalizerSpec } from "@omnesis/core";
import type { ValidatedToken, SessionInfo } from "./data/repositories/TokenRepository.js";
import {
  cleanupExpiredNotifications,
  claimNotification,
  confirmNotification,
  enqueueNotification,
  leaseNotificationWakes,
  settleNotificationWake,
  supersedeNotificationsByCollapseIdPrefix,
  type ClaimedNotificationDelivery,
  type ClaimNotificationInput,
  type ConfirmNotificationInput,
  type EnqueueNotificationInput,
  type EnqueueNotificationResult,
  type LeaseNotificationWakesInput,
  type LeasedNotificationWake,
  type SettleNotificationWakeInput,
} from "./push/queue.js";
import {
  commitMobilePermissionReminderNotification,
  commitReauthReminderNotification,
  type CommittedReminderNotificationResult,
} from "./push/reminder-notification-operations.js";

export interface WriteGate {
  // ── db.ts ─────────────────────────────────────────────────────────
  upsertDocuments(
    docs: DocumentInput[],
    canonicalizers?: readonly UrlCanonicalizerSpec[],
    writeEpochs?: Readonly<Record<string, number>>,
    /** The cursor row each `writeEpochs` entry was claimed on (`""` = shared). */
    cursorRows?: Readonly<Record<string, string>>,
    /** The stream each source's documents belong to (`""` = the source's one stream). */
    streams?: Readonly<Record<string, string>>,
    /** Conflict policies for independently replicated shared sources. */
    replicaVersionPolicies?: Readonly<Record<string, "source-updated-at">>,
  ): Promise<{
    rejectedSourceIds: string[];
    ignoredReplicaDocuments: Array<{ sourceId: string; externalId: string }>;
    /** Rows refused because the user deleted them for good. */
    suppressedDocuments: Array<{ sourceId: string; externalId: string }>;
  }>;
  /**
   * Returns the document_ids that were deleted so the caller can cascade
   * the cleanup to the index database (chunks / indexed_documents).
   * `omnesis.db` and `index.db` are separate SQLite files so the cascade
   * can't be a pure trigger. `expectedWipeEpoch` fences off-writer snapshot
   * victims against a source wipe before the delete reaches the writer.
   */
  deleteDocuments(
    providerId: string,
    sourceId: string,
    externalIds: string[],
    expectedWipeEpoch?: number,
    cursorRow?: string,
    streamId?: string,
  ): Promise<string[]>;
  /**
   * User-initiated single-document privacy delete. Cascades to the
   * document's extracted-attachment children and, with `tombstone` (the
   * default), writes a durable tombstone per deleted key so a later re-sync /
   * re-capture can't resurrect it. Returns the deleted document_ids for the
   * index-side cascade.
   */
  deleteDocumentForUser(
    providerId: string,
    sourceId: string,
    externalId: string,
    streamId?: string,
    tombstone?: boolean,
  ): Promise<string[]>;
  /** Bounded, exact document delete used by activity retention. */
  deleteDocumentForRetention(
    providerId: string,
    sourceId: string,
    externalId: string,
  ): Promise<string | null>;
  /** Remove the temporary tombstone once the index-side delete is durable. */
  completeDocumentRetention(
    providerId: string,
    sourceId: string,
    externalId: string,
  ): Promise<void>;
  /**
   * Writer half of the snapshot reconcile: record and revoke pending absences
   * from a plan the IO worker computed. Records only — an absence deletes
   * nothing until the sweep finds its deadline spent. `expectedWipeEpoch`
   * fences the plan against a wipe that landed after the diff was taken.
   */
  applySnapshotAbsencePlan(
    plan: SnapshotAbsencePlan,
    expectedWipeEpoch?: number,
    cursorRow?: string,
  ): Promise<SnapshotAbsenceApplied>;
  /**
   * Count a replicated member's standalone snapshot against the items it keeps
   * alive and apply the verdicts that matured. See `applyReplicaOmissions`.
   */
  applyReplicaOmissions(args: ReplicaOmissionArgs): Promise<ReplicaVerdictOutcome>;
  /**
   * The replica deletion ledger for structured rows, called from inside a
   * DuckDB transaction so the verdict is durable before the rows it concerns
   * change. See `AnalyticsReplicaClaimRepository`.
   */
  judgeAnalyticsTombstones(args: AnalyticsTombstoneArgs): Promise<AnalyticsTombstoneVerdict>;
  recordAnalyticsPresence(args: AnalyticsPresenceArgs): Promise<void>;
  recordAnalyticsRestorerOmissions(args: AnalyticsRestorerSnapshotArgs): Promise<string[]>;
  recordAnalyticsSweepVerdict(verdict: AnalyticsSweepVerdict, now: number): Promise<void>;
  /** Reclaim a bounded tail invalidated by absence-scope generation advances. */
  reclaimStaleAbsences(candidates: readonly StaleAbsenceCandidate[]): Promise<number>;
  /**
   * Spend the deadline on a batch of absences: re-decide due-ness inside the
   * writer transaction, record the ids, and delete. See `sweepDueAbsences`.
   */
  sweepDueAbsences(
    documentIds: string[],
    opts: { minObservations: number; dueBefore: number; now: number },
  ): Promise<AbsenceSweepBatch>;
  acknowledgeAbsenceCascade(id: number, part: "index" | "cognition"): Promise<void>;
  deleteAllBySource(sourceId: string): Promise<number>;
  /**
   * Delete one device stream of a partitioned source — its documents,
   * tombstones and cursor claim — leaving the source and its other streams
   * in place. Returns the deleted document ids for the index and cognition
   * cascades.
   */
  deleteAllByStream(sourceId: string, streamId: string): Promise<DeleteAllByStreamResult>;
  deleteAllByProvider(providerId: string): Promise<number>;
  markSourceStatsDirty(sourceId?: string): Promise<void>;
  refreshSourceStatsRow(sourceId: string): Promise<void>;
  /**
   * Upsert a pre-computed `source_stats` row. Paired with the
   * read-handle `computeSourceStatsRow` so the heavy aggregation can
   * run off the writer; this method only performs the cheap one-row
   * UPSERT.
   */
  upsertSourceStatsRow(sourceId: string, agg: SourceStatsAggregation): Promise<void>;
  /** Advance a cursor row's epoch (`""` = shared) and return this sync attempt's write lease. */
  beginSyncAttempt(sourceId: string, cursorRow?: string): Promise<number>;
  promoteSourceWireContract(sourceId: string, version: number): Promise<void>;
  replaceSourceSyncIssues(
    sourceId: string,
    deviceId: string,
    issues: readonly SyncIssue[],
    assessments?: readonly SyncIssueAssessment[],
  ): Promise<void>;
  preparePendingSourcePage(args: PreparePendingSourcePage): Promise<PendingSourcePage | null>;
  acknowledgePendingSourcePage(args: Omit<PreparePendingSourcePage, "payload">): Promise<boolean>;
  /** Revoke `expectedEpoch` only when no newer attempt has claimed that row. */
  revokeSyncAttempt(sourceId: string, expectedEpoch: number, cursorRow?: string): Promise<boolean>;
  /** Send one member's cursor row back to a bootstrap: no cursor, its epoch advanced, the row kept. */
  resetMemberCursor(sourceId: string, deviceId: string): Promise<void>;

  setSyncState(
    sourceId: string,
    cursor: SyncCursor,
    meta?: SourceSyncMeta,
    writeEpoch?: number,
    /** The row to write: `""` (shared) or a member device's own row. */
    deviceId?: string,
  ): Promise<boolean>;
  /**
   * Boot-time helper for gateway-hosted sources that have no sync cursor.
   * UPSERTs only the display metadata columns
   * (icon, label, colors) into `sync_state`, leaving cursor /
   * last_synced_at / error fields untouched. See
   * `data/repositories/SyncStateRepository.ts:setSourceMeta`.
   */
  setSourceMeta(sourceId: string, meta: SourceSyncMeta): Promise<void>;
  /**
   * Atomic per-page sync write — upserts + deletions + snapshot
   * reconcile + cursor advance in one SQLite transaction. Closes the
   * at-least-once gap where the cursor could lag the
   * documents on a partial failure. The collector's
   * `source-sync-runner.ts` calls this in place of the prior
   * upsertDocuments → deleteDocuments → snapshot absence marks →
   * setSyncState sequence.
   */
  upsertWithCursor(
    args: UpsertWithCursorArgs,
    canonicalizers?: readonly UrlCanonicalizerSpec[],
  ): Promise<UpsertWithCursorResult>;
  applySourceUrlRecanonicalizationPage(
    cursor: import("./domain/SourceUrlRecanonicalization.js").SourceUrlRecanonicalizationCursor,
    mutations: readonly import("./domain/SourceUrlRecanonicalization.js").SourceUrlRecanonicalizationMutation[],
  ): Promise<
    import("./domain/SourceUrlRecanonicalization.js").SourceUrlRecanonicalizationApplyResult
  >;
  finishSourceUrlRecanonicalization(
    cursor: import("./domain/SourceUrlRecanonicalization.js").SourceUrlRecanonicalizationCursor,
  ): Promise<boolean>;
  /**
   * Persist a sync error message on one row (`""` = shared), with the
   * structured remedy the collector reported beside it; survives gateway restart.
   */
  setSyncError(
    sourceId: string,
    errorMessage: string,
    deviceId?: string,
    remediation?: SyncRemediation,
  ): Promise<void>;
  /** Clear the persisted sync error on one row, or on every row of the source when no device is given. */
  clearSyncError(sourceId: string, deviceId?: string): Promise<void>;
  /** Drop one device's reminder episode for a principal and supersede its pending reminders. */
  recoverReauthReminder(
    principal: string,
    deviceId: string,
    collapsePrefix: string,
    now: number,
  ): Promise<number>;
  reserveReauthReminder(
    principal: string,
    deviceId: string,
    now: number,
    cfg: ReauthBackoffConfig,
  ): Promise<string | null>;
  releaseReauthReminder(token: string): Promise<boolean>;
  commitReauthReminderNotification(
    token: string,
    now: number,
    input: EnqueueNotificationInput,
  ): Promise<CommittedReminderNotificationResult | null>;
  replaceMobilePermissionHealth(input: {
    sourceId: SourceId;
    deviceId: DeviceId;
    report: MobilePermissionHealthReport;
    receivedAt: number;
  }): Promise<OwnedPermissionHealthResult>;
  reserveMobilePermissionReminder(
    sourceId: SourceId,
    now: number,
    cfg: MobilePermissionBackoffConfig,
  ): Promise<MobilePermissionReminderReservation | null>;
  releaseMobilePermissionReminder(token: string, episodeId: string): Promise<boolean>;
  commitMobilePermissionReminderNotification(
    token: string,
    episodeId: string,
    now: number,
    input: EnqueueNotificationInput,
  ): Promise<CommittedReminderNotificationResult | null>;

  // ── people.ts ─────────────────────────────────────────────────────
  findOrCreatePerson(
    mention: PersonMention,
    sourceId: string,
    docDate: string,
  ): Promise<string | null>;
  resolveDocumentPeople(
    docId: string,
    people: PersonMention[],
    sourceId: string,
    docDate: string,
  ): Promise<{ resolved: number; created: number; skipped: number }>;
  backfillManyPeople(
    batchSize?: number,
  ): Promise<{ processed: number; resolved: number; skipped: number }>;
  seedFromContacts(): Promise<{ seeded: number; selfDetected: boolean }>;
  /**
   * Apply a pre-computed seed plan from `computeSeedFromContacts`. Pairs
   * with the read-handle compute op so the boot-time contact scan +
   * JSON.parse don't run on the writer.
   */
  upsertSeedFromContacts(
    plan: SeedFromContactsPlan,
  ): Promise<{ seeded: number; selfDetected: boolean }>;
  /**
   * Pair every registered source against the collector-declared self-identity
   * hooks and attach the resulting LID aliases to self. The hooks travel with
   * the call: the registry lives on the HTTP thread and the worker never sees
   * a push. Resolves to the number of aliases added.
   */
  detectSelfFromSourceIds(hooks: readonly SelfIdentitySource[]): Promise<number>;
  /**
   * Boot-time bootstrap/enrich of the canonical self person from `config.self`
   * (the operator's own name / emails / phones). Returns the self person id, or
   * null when config carries no usable identifier and no self exists yet.
   */
  bootstrapSelfFromConfig(
    configSelf:
      | { name?: string; emails?: readonly string[]; phones?: readonly string[] }
      | undefined,
  ): Promise<string | null>;
  mergePeople(winnerId: string, loserId: string): Promise<void>;
  runMergePass(): Promise<{ merged: number }>;
  /**
   * Collapse transitive merge chains. Called by the backfill
   * worker as the final step of its split people-counts refresh after a batch
   * of `mergePeople` calls. Idempotent.
   */
  collapseTransitiveChains(): Promise<{ collapsed: number }>;
  /**
   * Persist a pre-computed transitive-collapse plan. Paired with the
   * read-handle `computeTransitiveCollapse` so the chain walk runs on
   * the io worker. Each row's optimistic-concurrency token
   * (`expectedMergedInto`) protects against a concurrent merge: if
   * `merged_into` shifted under us, the row is skipped and the next
   * pass re-resolves it.
   */
  upsertTransitiveCollapse(rows: TransitiveCollapseRow[]): Promise<{ collapsed: number }>;
  /** Full people rebuild; the self-identity hooks ride along for the reset phase self pass. */
  rebuildPeopleFromDocuments(hooks: readonly SelfIdentitySource[]): Promise<void>;
  refreshPeopleCounts(): Promise<void>;
  /**
   * Persist a pre-computed list of `(personId, docCount, aliasCount)`
   * triples. Paired with the read-handle `computePeopleCounts` so the
   * heavy JOINs over `document_people` + `person_aliases` don't run
   * on the writer worker. Skips rows whose counts haven't changed,
   * so a steady-state refresh over an unchanged graph is nearly free.
   */
  upsertPeopleCounts(rows: PeopleCountRow[]): Promise<{ updated: number }>;
  /**
   * Stamp the people-counts watermark after a completed sweep. Monotonic:
   * a graph change during the sweep leaves dirty ahead of it, so the next
   * tick runs again rather than trusting a pass that raced it.
   */
  advancePeopleCountsWatermark(capturedVersion: number): Promise<void>;
  zeroPeopleCountsForLosers(): Promise<{ updated: number }>;
  /** Recompute the dominant (primary) name per person from occurrence_count and
   *  sync canonical_name to it. */
  recomputeNamePrimaries(): Promise<{ updated: number }>;
  /**
   * Persist a snapshot of per-person interaction scores. Pairs with
   * `IoGate.interactionScores`. Updates the in-snapshot rows
   * (skipping any whose score is unchanged), then zeroes any
   * unmerged non-self people who weren't in the snapshot. After
   * both passes, advances `interaction_scores_meta.last_computed_version`
   * to the snapshot's captured `dirtyVersion` so the periodic refresh
   * task can compare against subsequent dirty bumps.
   */
  upsertInteractionScores(
    snapshot: InteractionScoresSnapshot,
  ): Promise<{ updated: number; zeroed: number }>;
  /**
   * Bump `interaction_scores_meta.dirty_version`. Direct callers that
   * mutate document_people / people / person_aliases via paths that
   * don't already bump (admin one-shots, tests). Production code
   * relies on the inline bumps in db.ts + people.ts mutations.
   */
  markPeopleGraphDirty(): Promise<void>;
  /**
   * Insert (or reactivate) a merge rule. Idempotent on canonical
   * (sideA, sideB, kind). Triggers a merge_rules dirty bump → next
   * eval tick re-derives equivalences.
   */
  createMergeRule(input: CreateMergeRuleInput): Promise<CreateMergeRuleResult>;
  /** Soft-delete a merge rule. Returns true iff the rule was active. */
  deleteMergeRule(ruleId: string): Promise<boolean>;
  /** Delete every rule of one cluster-merge batch (shared group_id). Returns
   *  how many rules were removed. The eval re-derives equivalences next tick. */
  deleteMergeRuleGroup(groupId: string): Promise<number>;
  /**
   * Insert any auto-detected rules not already present (active or
   * deactivated). Pairs with `IoGate.autoDetectedRules`.
   */
  upsertAutoDetectedRules(
    candidates: AutoDetectedRule[],
  ): Promise<{ inserted: number; skipped: number }>;
  /**
   * Apply a pre-computed equivalences snapshot. Pairs with
   * `IoGate.mergeEquivalences`. Chunked + yieldable; advances
   * `merge_rules_meta.last_evaluated_version` only on a complete pass.
   */
  upsertMergeEquivalences(
    snapshot: MergeEquivalenceSnapshot,
  ): Promise<UpsertMergeEquivalencesResult>;
  /** Clear merged_into on a person. Inverse of `mergePeople`. */
  unmergePerson(personId: string): Promise<void>;
  /**
   * Sweep every cluster of people sharing a strong-identifier alias
   * (email/phone/lid) and physical-merge them into one canonical.
   * Unlike `migrateTautologyRules`, this works directly off the alias
   * graph without going through `merge_rules` — a safety net that
   * catches duplicates produced by ingestion bugs after the migration.
   */
  physicalDedupSharedAliases(): Promise<{ clustersProcessed: number; peopleMerged: number }>;
  /**
   * One-shot data fix. Delete every `email` person-alias whose
   * value is a shared no-reply firehose (`comments-noreply@…`,
   * `notifications-noreply@…`, …) and mark every document linked to
   * the affected people (or their canonicals) for re-resolution.
   * Idempotent — subsequent boots are no-ops once the table is clean.
   */
  pruneNoreplyAliases(): Promise<{ aliasesRemoved: number; documentsToRebackfill: number }>;
  /**
   * One-shot data fix. Promote a trusted `name` alias onto any
   * canonical person whose `canonical_name` is still a phone/email-shaped
   * placeholder, healing the People graph regardless of sync order.
   * Idempotent — subsequent boots are no-ops once headlines are real names.
   */
  upgradePlaceholderCanonicalNames(): Promise<{ upgraded: number }>;
  /**
   * Detect "shared address" people (one email, many distinct name aliases —
   * a mailbox the static heuristic can't name, e.g. a ticket queue),
   * blocklist their email in `non_identifying_emails`, and delete the
   * bucket. Boot sweep; idempotent once the buckets are gone. Thresholds
   * fall back to the module defaults when omitted.
   */
  demoteSharedAddresses(
    nameThreshold?: number,
    maxEmails?: number,
  ): Promise<DemoteSharedAddressesResult>;
  /**
   * Persist a batch of fuzzy-detected merge candidates. Pairs with
   * `IoGate.mergeCandidatesFuzzy`. Inserts brand-new pairs as
   * pending; refreshes the score on existing pending rows; skips
   * any pair already accepted/denied (decisions are durable).
   */
  upsertMergeCandidates(
    proposals: readonly MergeCandidateProposal[],
  ): Promise<UpsertMergeCandidatesResult>;
  /**
   * Accept a candidate: creates a `kind='user'` merge_rule and flips
   * the candidate row to `accepted` with a back-reference. The next
   * eval tick picks up the rule and re-derives equivalences.
   */
  acceptMergeCandidate(input: AcceptMergeCandidateInput): Promise<AcceptMergeCandidateResult>;
  /**
   * Deny a candidate. The row stays as a permanent veto so the
   * detector never re-proposes the same pair.
   */
  denyMergeCandidate(candidateId: string): Promise<MergeCandidateRow>;
  /**
   * Sweep `pending` candidates whose two sides currently resolve to
   * the same single person — these are stale (drift collapsed them
   * post-detection) and the operator shouldn't see them as
   * decisions to make. Marks them `accepted` with `rule_id=NULL`.
   */
  sweepCollapsedMergeCandidates(): Promise<{ swept: number }>;

  /**
   * Delete `pending` candidates the role-mailbox suppression rule now
   * rejects (cross-org matches on generic functional words). Idempotent;
   * converges rows proposed before this feature or before classification.
   */
  pruneSuppressedMergeCandidates(): Promise<{ pruned: number }>;

  /** Auto-approve structurally high-confidence pending candidates as reversible
   * `kind:"system"` merge rules (never touching `is_self`), so the operator only
   * reviews the uncertain ones. Idempotent. */
  autoApproveHighConfidenceCandidates(): Promise<{ approved: number }>;

  /** Apply a background-agent adjudication verdict to a pending candidate —
   * merge (guard-re-checked system rule), distinct (deny), or unsure (stamp). */
  applyMergeAdjudication(input: ApplyMergeAdjudicationInput): Promise<ApplyMergeAdjudicationResult>;

  /** Delete pending candidates no longer in the latest (complete) detection
   *  output. Heals staleness when the algorithm changes what it surfaces. */
  reconcilePendingMergeCandidates(
    proposals: readonly MergeCandidateProposal[],
  ): Promise<{ deleted: number }>;

  /** Persist token identity labels produced by the classifier task. */
  upsertTokenLabels(rows: readonly TokenLabelRow[]): Promise<{ upserted: number }>;

  /** Unify a cluster of people via N-1 user merge rules (grouped card). */
  mergeCluster(
    personIds: readonly string[],
    opts?: { reason?: string | null; createdBy?: string | null },
  ): Promise<MergeClusterResult>;

  // ── links.ts ──────────────────────────────────────────────────────
  reconcileUnresolvedLinks(limit?: number): Promise<number>;
  beginLinkDeclarationUpdate(): Promise<number>;
  finishLinkDeclarationUpdate(): Promise<number>;
  /**
   * Persist a pre-computed reconcile batch (resolutions + cursor
   * advancement signal). Paired with the read-handle
   * `computeLinkResolutions` so the heavy SELECT-side resolution doesn't
   * run on the writer worker. Skips rows whose `targetDocId` is null,
   * so a no-progress reconcile pass is effectively free, and advances
   * the persisted cursor in `link_reconcile_state` so the next tick
   * picks up from where this one stopped.
   */
  upsertLinkResolutions(
    batch: LinkReconcileBatch,
  ): Promise<{ updated: number; deleted: number; retargeted: number }>;
  /**
   * Persist a batch of per-document extracted dates (the date-enrichment
   * signal) and stamp each document's `dates_extracted_at`. Paired with
   * `IoGate.fetchDateExtractionBatch` + `CpuGate.extractDatesFromDocs` so the
   * fetch + regex compute run off the writer; this call is the cheap write
   * half. Documents deleted between fetch and apply are skipped.
   */
  applyExtractedDates(
    entries: DateExtractionResult[],
  ): Promise<{ applied: number; datesWritten: number }>;
  /**
   * Drain the `pending_edges` backlog: promote forward-reference
   * source-declared edges whose target has since been ingested, and TTL-drop
   * ones whose target never arrived. Bounded by `limit`.
   */
  drainPendingEdges(
    limit?: number,
  ): Promise<{ promoted: number; dropped: number; retried: number }>;
  /**
   * Apply an extraction batch whose links the cpu phase found and the io
   * phase (`IoGate.resolveExtractedLinks`) gave targets to. Each entry
   * carries a
   * `contentHash` snapshot used for optimistic concurrency: rows whose
   * doc was re-upserted between compute and writer are skipped, and
   * the next periodic tick re-extracts against the fresh content.
   */
  upsertExtractedLinksBatch(
    rows: ExtractedLinkBatchEntry[],
  ): Promise<{ applied: number; skipped: number; extracted: number }>;
  /**
   * Bump the singleton `link_stats.dirty_version` so any in-flight
   * compute snapshot is invalidated. Tests / admin use this directly;
   * production code's mark-dirty calls run inline inside the SQL fn
   * that mutated `document_links`.
   */
  markLinkStatsDirty(): Promise<void>;
  /**
   * Persist a pre-computed `link_stats` aggregation. Paired with
   * `IoGate.linkStats` so the heavy COUNT(*) scans run on the
   * io worker. Skips the upsert (returns updated=0) if
   * `dirty_version` shifted between compute and writer apply — the
   * next periodic refresh tick will recompute.
   */
  upsertLinkStats(agg: LinkStatsAggregation): Promise<{ updated: number }>;
  reconcileLinkStatsCounters(): Promise<{ corrected: number }>;

  // ── sqlite-catalog.ts ─────────────────────────────────────────────
  refreshSqliteTableStats(): Promise<void>;

  // ── access / MCP OAuth ────────────────────────────────────────────
  registerOAuthClient(input: OAuthClientRegistrationInput): Promise<OAuthClientRegistration>;
  upsertOAuthMetadataClient(input: OAuthClientMetadataDocument): Promise<OAuthClientRegistration>;
  createExecutionBinding(
    input: ExecutionBindingCreateInput,
  ): Promise<AccessMutationResult<ExecutionBindingCreateResult>>;
  createAuthorizationRequest(input: AuthorizationRequestCreateInput): Promise<
    AccessMutationResult<{
      id: string;
      browserHandle: string;
      userCode: string;
      expiresAt: number;
    }>
  >;
  enqueueAccessAuthorizationNotification(
    requestId: string,
    deviceIds: readonly DeviceId[],
  ): Promise<AccessAuthorizationNotificationEnqueueResult | null>;
  decideAuthorizationRequest(
    input: AuthorizationRequestDecisionInput,
  ): Promise<AccessMutationResult<AuthorizationRequestPublic>>;
  issueAuthorizationCode(
    browserHandle: string,
  ): Promise<
    AccessMutationResult<
      | { status: "denied"; redirectUri: string; state: string }
      | { status: "approved"; redirectUri: string; state: string; code: string }
    >
  >;
  issueAuthorizationCodeById(
    requestId: string,
  ): Promise<
    AccessMutationResult<
      | { status: "denied"; redirectUri: string; state: string }
      | { status: "approved"; redirectUri: string; state: string; code: string }
    >
  >;
  exchangeOAuthToken(input: OAuthTokenExchangeInput): Promise<AccessMutationResult<OAuthTokenSet>>;
  reissueExecutionDeviceTokens(input: {
    deviceId: string;
    oauthClientId: string;
  }): Promise<AccessMutationResult<OAuthTokenSet>>;
  updateAccessGrant(
    input: AccessGrantUpdateInput,
  ): Promise<AccessMutationResult<AccessGrantUpdateResult>>;
  createAccessLevel(
    input: AccessLevelCreateInput,
  ): Promise<AccessMutationResult<AccessLevelSummary>>;
  updateAccessLevel(
    input: AccessLevelUpdateInput,
  ): Promise<AccessMutationResult<AccessLevelSummary>>;
  deleteAccessLevel(input: AccessLevelDeleteInput): Promise<AccessMutationResult<null>>;
  setAccessConnectionLevel(
    input: AccessConnectionLevelInput,
  ): Promise<AccessMutationResult<AccessConnectionLevelResult>>;
  setAccessDeviceLevel(
    input: AccessDeviceLevelInput,
  ): Promise<AccessMutationResult<AccessDeviceLevelResult>>;
  renameAccessPrincipal(
    input: AccessPrincipalRenameInput,
  ): Promise<AccessMutationResult<AccessPrincipal>>;
  revokeAccessEntity(input: AccessRevocationInput): Promise<boolean>;
  recordMcpToolInvocationAudit(input: McpToolInvocationAuditInput): Promise<boolean>;
  touchPrincipalCredentialUsageBatch(
    rows: ReadonlyArray<{ credentialId: string; observedAt: number }>,
  ): Promise<void>;
  cleanupExpiredAccessStateBatch(
    phase: AccessCleanupPhase,
    now: number,
    limit: number,
    cursor?: OAuthClientCleanupCursor,
  ): Promise<AccessCleanupResult>;

  // ── devices.ts ────────────────────────────────────────────────────
  createDevice(opts: {
    name: string;
    kind: DeviceKind;
    capabilities?: DeviceCapability;
  }): Promise<DeviceRecord>;
  /**
   * Register a device and mint its first credential in one transaction,
   * adopting a revoked row of the same name and kind. See
   * createOrAdoptDevice.
   */
  createOrAdoptDevice(input: {
    name: string;
    kind: DeviceKind;
    capabilities: DeviceCapability;
    scopes: readonly Scope[];
    onlineDeviceIds?: readonly DeviceId[];
  }): Promise<CreateOrAdoptDeviceResult>;
  /**
   * Hard-delete a device ("forget"). Refused inside the write transaction
   * while any source is owned by or shared with the device. See
   * forgetDeviceWithPermissionInvalidation.
   */
  deleteDevice(id: DeviceId): Promise<DeleteDeviceResult>;
  /**
   * Revoke a device — the default unpair. Device tokens, push registrations,
   * and principal credentials bound to the device are invalidated; the row,
   * its sources and their data stay. See revokeDeviceWithPermissionInvalidation.
   */
  revokeDevice(
    id: DeviceId,
    pairingFence?: PairingGenerationFence,
    expectedImpactFingerprint?: string,
  ): Promise<boolean>;
  /** Display rename; refused when the name is taken. See renameDevice. */
  renameDevice(id: DeviceId, name: string): Promise<RenameDeviceResult>;
  replaceDeviceForRepair(
    oldId: DeviceId,
    opts: { name: string; kind: DeviceKind; capabilities?: DeviceCapability },
  ): Promise<DeviceRecord>;
  /**
   * Persist a completed hello: the capabilities declared, the product
   * version hoisted out of them, and the wire protocol the handshake
   * settled on (the gateway's own observation, from the envelope).
   */
  updateDeviceCapabilities(
    id: DeviceId,
    capabilities: DeviceCapability,
    protocolVersion?: number,
  ): Promise<SourceId[]>;
  /**
   * Record (or close out) the version an operator asked this device to
   * update itself to. See setDeviceUpdateRequest.
   */
  setDeviceUpdateRequest(
    id: DeviceId,
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
  ): Promise<boolean>;
  /** Create a pending run unless this device already has one in flight. */
  beginDeviceDoctorRun(input: BeginDeviceDoctorRunInput): Promise<boolean>;
  /** Claim this exact pending run for command dispatch. */
  startDeviceDoctorRun(input: StartDeviceDoctorRunInput): Promise<boolean>;
  /** Put this exact claimed run back into the pending queue. */
  requeueDeviceDoctorRun(input: RequeueDeviceDoctorRunInput): Promise<boolean>;
  /** Settle this exact queued or claimed run as failed. */
  failDeviceDoctorRun(input: FailDeviceDoctorRunInput): Promise<boolean>;
  /** Persist a report only while this exact run still owns the device slot. */
  completeDeviceDoctorRun(input: CompleteDeviceDoctorRunInput): Promise<boolean>;
  /**
   * Replace the device's self annotation. Each field is
   * optional; pass `undefined` (or omit) to leave it untouched. The
   * caller validates upstream — phones must be E.164 and emails must
   * be `normalizeEmail`-d before this is called.
   */
  updateDeviceSelfInfo(
    id: DeviceId,
    patch: { selfEmails?: string[]; selfPhones?: string[] },
  ): Promise<void>;
  /** Store the phone's normalized OS notification-delivery state. */
  setDeviceNotificationDeliveryHealth(
    id: DeviceId,
    status: NotificationDeliveryHealth,
    updatedAt: number,
  ): Promise<void>;
  /**
   * Record (or refresh) the APNs device token for an iOS device.
   * Replaces any prior registration. Throws when `id` doesn't exist —
   * the HTTP route translates that to 404. Environment is "sandbox"
   * for Debug builds and "production" for TestFlight / App Store.
   */
  setDeviceApnsToken(id: DeviceId, registration: ApnsRegistration): Promise<void>;
  /**
   * Clear the APNs registration on a device. Called when APNs
   * responds with `Unregistered` / `BadDeviceToken` so the next
   * `notify-ios` fan-out skips the device cleanly.
   */
  clearDeviceApnsToken(id: DeviceId, expected?: ApnsRegistration): Promise<boolean>;
  /** Record or refresh an Android device's Firebase Messaging token. */
  setDeviceFcmToken(id: DeviceId, registration: FcmRegistration): Promise<void>;
  /** Clear an Android Firebase registration after FCM reports it invalid. */
  clearDeviceFcmToken(id: DeviceId, expected?: FcmRegistration): Promise<boolean>;
  setDeviceRelayPushConsent(
    id: DeviceId,
    consent: { appId: string; grantedAt: number },
  ): Promise<RelayPushConsentOutcome>;
  withdrawDeviceRelayPushConsent(id: DeviceId): Promise<boolean>;
  setDeviceRelayPushRegistration(
    id: DeviceId,
    registration: { relayUrl: string; credential: string; appId: string },
  ): Promise<boolean>;
  enqueueNotification(input: EnqueueNotificationInput): Promise<EnqueueNotificationResult | null>;
  leaseNotificationWakes(input: LeaseNotificationWakesInput): Promise<LeasedNotificationWake[]>;
  settleNotificationWake(input: SettleNotificationWakeInput): Promise<boolean>;
  claimNotification(input: ClaimNotificationInput): Promise<ClaimedNotificationDelivery | null>;
  confirmNotification(input: ConfirmNotificationInput): Promise<boolean>;
  cleanupExpiredNotifications(now: number): Promise<number>;
  /**
   * Boot-time helper: if no canonical self person exists,
   * materialize one from the earliest-paired device that carries self
   * annotation. Idempotent — returns null when self already exists or
   * no device has annotation.
   */
  bootstrapSelfFromDevices(): Promise<string | null>;
  touchDevice(id: DeviceId): Promise<void>;
  createPairing(opts: CreatePairingOptions): Promise<PendingPairing>;
  consumePairing(pairingCode: string, expectedKind?: DeviceKind): Promise<PendingPairing | null>;
  redeemDevicePairing(input: {
    pairingCode: string;
    expectedKind?: DeviceKind;
    capabilities: DeviceCapability;
    onlineDeviceIds?: readonly DeviceId[];
    idempotencyKey?: string;
  }): Promise<DevicePairingRedemption>;
  revokePairing(pairingCode: string): Promise<boolean>;
  redeemAgentIntegrationPairing(input: {
    pairingCode: string;
    harness: "openclaw" | "hermes";
    capabilities: DeviceCapability;
    repairDeviceId?: DeviceId;
    idempotencyKey?: string;
  }): Promise<AgentIntegrationPairingResult>;
  cleanupExpiredPairings(): Promise<number>;

  // ── tokens.ts ─────────────────────────────────────────────────────
  /**
   * Mint a token. `opts.ttlMs` sets an expiry (omit for a never-expiring
   * device token); short-lived callback tokens pass a TTL.
   */
  createToken(
    deviceId: DeviceId,
    scopes: readonly Scope[],
    name?: string | null,
    opts?: { ttlMs?: number },
  ): Promise<{ id: TokenId; token: string }>;
  validateToken(rawToken: string): Promise<ValidatedToken | null>;
  /**
   * Fire-and-forget activity beacon paired with `lookupToken()` on the
   * HTTP auth hot path. See tokens.ts comments.
   */
  touchTokenUsage(tokenId: TokenId, deviceId: DeviceId): Promise<void>;
  /**
   * Batched form of `touchTokenUsage`. Used by the `auth.flushTokenUsage`
   * periodic task to drain the in-memory `TokenUsageBuffer` in a single
   * writer round-trip instead of one fan-out call per token. Empty
   * arrays are a no-op.
   */
  touchTokenUsageBatch(
    rows: ReadonlyArray<{ tokenId: TokenId; deviceId: DeviceId }>,
  ): Promise<void>;
  /**
   * Add any `write:<source-type>` scope this device kind should hold but the
   * token is missing. Returns the resulting scope set, or `null` when the
   * token row is gone. See `reconcileDeviceTokenScopes`.
   */
  reconcileDeviceTokenScopes(tokenId: TokenId, kind: DeviceKind): Promise<Scope[] | null>;
  revokeToken(id: TokenId): Promise<boolean>;
  ensureBootstrapToken(configDir: string): Promise<string | null>;
  createSession(tokenId: TokenId, scopes: readonly Scope[], expiresInMs?: number): Promise<string>;
  refreshSessionActivity(
    sessionId: string,
    sessionTtlMs: number,
    throttleMs: number,
  ): Promise<boolean>;
  validateSession(sessionId: string): Promise<SessionInfo | null>;
  /**
   * Fire-and-forget DELETE for an expired session, paired with
   * `lookupSession()` on the portal auth hot path.
   */
  purgeExpiredSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  cleanupExpiredSessions(): Promise<number>;
  /** Delete tokens past their `expires_at` (short-lived callback tokens). */
  cleanupExpiredTokens(): Promise<number>;
  /** Delete one bounded batch of disposable operational history. */
  pruneActivityRetentionBatch(
    phase: ActivityRetentionPhase,
    cutoff: number,
    limit: number,
  ): Promise<ActivityRetentionBatchResult>;
  /** Incrementally return a bounded number of reusable pages to the OS. */
  reclaimActivityRetentionPages(maxPages: number): Promise<number>;

  // ── sources.ts ────────────────────────────────────────────────────
  createSource(opts: {
    type: SourceType;
    accountId: AccountId;
    account?: AccountDescriptor | null;
    deviceId: DeviceId;
    config?: Record<string, unknown>;
    memberConfigOverride?: Record<string, unknown>;
    memberScopedParams?: readonly string[];
    enabled?: boolean;
    multiDeviceMode?: MultiDeviceMode;
    pairingFence?: PairingGenerationFence;
  }): Promise<SourceRecord | null>;
  createSourceWithId(
    id: SourceId,
    opts: {
      type: SourceType;
      accountId: AccountId;
      account?: AccountDescriptor | null;
      deviceId: DeviceId;
      config?: Record<string, unknown>;
      memberConfigOverride?: Record<string, unknown>;
      memberScopedParams?: readonly string[];
      enabled?: boolean;
      multiDeviceMode?: MultiDeviceMode;
      pairingFence?: PairingGenerationFence;
    },
  ): Promise<SourceRecord | null>;
  updateSource(
    id: SourceId,
    patch: { config?: Record<string, unknown>; enabled?: boolean; deviceId?: DeviceId },
  ): Promise<SourceRecord | null>;
  /**
   * `updateSource` that also returns the owner and displaced membership read
   * inside the write transaction. Used by the re-home path (PATCH deviceId),
   * whose caller must notify every device that actually lost the source — a
   * pre-write read can go stale under concurrent membership changes.
   * `expectDeviceId` makes the
   * write conditional on ownership: on a mismatch nothing is written and
   * the untouched record comes back with its actual owner.
   */
  moveSource(
    id: SourceId,
    patch: {
      config?: Record<string, unknown>;
      enabled?: boolean;
      deviceId?: DeviceId;
      expectDeviceId?: DeviceId;
      memberScopedParams?: readonly string[];
      pairingFence?: PairingGenerationFence;
    },
  ): Promise<{
    record: SourceRecord;
    previousDeviceId: DeviceId;
    displacedDeviceIds: DeviceId[];
    streamCleanups: SourceStreamCleanupJob[];
  } | null>;
  deleteSource(id: SourceId): Promise<boolean>;
  /** Join a member; implicit pushes must not rejoin a stream the user detached. */
  addSourceMember(
    id: SourceId,
    deviceId: DeviceId,
    configOverride?: Record<string, unknown>,
    memberScopedParams?: readonly string[],
    pairingFence?: PairingGenerationFence,
    allowDetachedRejoin?: boolean,
  ): Promise<boolean>;
  updateSourceForMember(
    id: SourceId,
    deviceId: DeviceId,
    patch: { config?: Record<string, unknown>; enabled?: boolean },
    configOverride: Record<string, unknown>,
    memberScopedParams: readonly string[],
    pairingFence?: PairingGenerationFence,
  ): Promise<SourceRecord | null>;
  updateSourceMemberConfigOverride(
    id: SourceId,
    deviceId: DeviceId,
    configOverride: Record<string, unknown>,
    memberScopedParams: readonly string[],
    pairingFence?: PairingGenerationFence,
  ): Promise<boolean>;
  /** Detach a device from a source; ownership passes to the oldest remaining member. */
  removeSourceMember(
    id: SourceId,
    deviceId: DeviceId,
    pairingFence?: PairingGenerationFence,
  ): Promise<RemoveSourceMemberResult>;
  prepareSourceModeTransition(
    id: SourceId,
    toMode: MultiDeviceMode,
    expectedOwnerDeviceId: DeviceId,
    memberScopedParams: readonly string[],
    replicaVersionPolicy?: "source-updated-at",
    pairingFence?: PairingGenerationFence,
  ): Promise<SourceModeTransition | null>;
  adoptSourceModeTransitionBatch(id: SourceId): Promise<SourceModeTransitionAdoptionBatch>;
  finalizeSourceModeTransition(id: SourceId): Promise<SourceRecord>;
  recordSourceModeTransitionFailure(id: SourceId, message: string): Promise<boolean>;
  recordSourceModeTransitionPublicationFailure(id: SourceId, message: string): Promise<boolean>;
  completeSourceModeTransitionPublication(id: SourceId): Promise<boolean>;
  recordSourceStreamCleanupFailure(job: SourceStreamCleanupJob, message: string): Promise<boolean>;
  completeSourceStreamCleanup(job: SourceStreamCleanupJob): Promise<boolean>;
  /** Capture former members, delete the live row and establish its tombstone atomically. */
  removeSource(id: SourceId, pairingFence?: PairingGenerationFence): Promise<RemovedSource | null>;
  /** Record a durable removal tombstone for `id` (see SourceRepository). */
  markSourceRemoved(id: SourceId, opts?: { cleanupPending?: boolean }): Promise<void>;
  /** Record that the post-removal sweep for `id` has finished. */
  markSourceCleanupDone(id: SourceId): Promise<void>;
  /** Clear the removal tombstone for `id` (explicit re-enable). */
  clearSourceRemoved(id: SourceId): Promise<void>;
  /** Clear only a completed tombstone; a concurrent pending removal wins. */
  clearSourceRemovedIfCleanupDone(id: SourceId): Promise<boolean>;
  /**
   * Replace the stored per-source-type document-event profiles with the
   * publishing collector's full declaration. See
   * `data/repositories/SourceDocumentProfileRepository.ts`.
   */
  upsertSourceDocumentProfiles(
    entries: readonly SourceDocumentProfileEntry[],
    publishedAt: number,
  ): Promise<{ stored: number }>;

  // ── briefs (the Cognition Steward run queue) ─────────────────────────────
  /** Enqueue one Cognition Steward run (or fold into a pending row by dedupe key). */
  enqueueCognitionRun(
    input: EnqueueCognitionRunInput,
    now: number,
  ): Promise<EnqueueCognitionRunResult>;
  /** Atomically claim due `pending` runs (bumps attempts). */
  claimDueCognitionRuns(opts: {
    now: number;
    limit?: number;
    maxAttempts?: number;
  }): Promise<ClaimedCognitionRun[]>;
  /**
   * Settle one attempt: mark the row completed/failed and fold the
   * attempt's usage into its (day, mechanism, model) spend bucket, in
   * one writer transaction.
   */
  finalizeCognitionRun(input: FinalizeCognitionRunInput): Promise<void>;
  /**
   * Record a run that executed outside the queue (watch compilation),
   * inserting its row already settled together with attribution + spend —
   * the inline counterpart of enqueue → claim → finalize.
   */
  recordSettledCognitionRun(input: RecordSettledCognitionRunInput): Promise<void>;
  /**
   * Readiness barrier release: make deferred `data` runs due sooner, once
   * their datum's deterministic derivation has finished or the datum vanished.
   * Revalidates readiness atomically with the schedule CAS, never delays a run,
   * and returns how many actually moved.
   */
  pullForwardCognitionRuns(
    entries: Array<{
      id: string;
      docId: string;
      observedDebounceUntil: number;
      nextAttemptAt: number;
      expectedNextAttemptAt: number;
    }>,
    activeDerivationStageIds: readonly DerivationStageId[],
  ): Promise<number>;
  /** Drop pending runs by dedupe key (decay-sweep retractions). */
  cancelPendingCognitionRuns(dedupeKeys: string[]): Promise<number>;
  /**
   * Cascade-cancel a resolved/deleted loop's never-claimed
   * `schedule_agent_run` checks (linked via the payload `loopId`).
   * Returns the number dropped.
   */
  cancelScheduledRunsForLoop(loopId: string): Promise<number>;
  /** Upsert one Cognition Steward engine-state row (daily marker, sweep versions). */
  setCognitionEngineState(key: string, value: string): Promise<void>;
  /**
   * Add to a numeric engine-state counter without a read-modify-write window.
   * See `addToCognitionEngineCounter` — a lifetime counter that loses an
   * increment never recovers it.
   */
  addToCognitionEngineCounter(key: string, delta: number): Promise<void>;
  /**
   * Fold one mechanism call's token usage into its (day, mechanism, model)
   * `cognition_spend` bucket. For mechanisms with no run row (the entailment
   * gate, interactive turns, sub-agents); run-settling spend goes through
   * `finalizeCognitionRun`. `countRun: false` folds the tokens without
   * bumping the bucket's completed-run counter (failed/aborted turns).
   */
  recordCognitionSpend(
    day: string,
    mechanism: string,
    modelId: string,
    usage: CognitionRunUsage,
    opts?: { countRun?: boolean },
  ): Promise<void>;
  // Open-loop / brief / notes mutations — the Cognition Steward's tool layer is
  // the only production caller (only the agent mutates loops/briefs in
  // V1). The mirror-document upsert is a separate `upsertDocuments` call.
  /** Atomically create an open loop and record its live annotation dependencies. */
  createOpenLoop(
    input: CreateOpenLoopInput,
    dependencies: ConsumptionDependencyContext,
    now: number,
  ): Promise<ConsumptionMutationResult<OpenLoopRow>>;
  /** Atomically partial-update an open loop and record its live dependencies. */
  updateOpenLoop(
    id: string,
    input: UpdateOpenLoopInput,
    dependencies: ConsumptionDependencyContext,
    now: number,
  ): Promise<ConsumptionMutationResult<OpenLoopRow | null>>;
  /**
   * Rewrite only a loop's person refs (normalization sweep) — no
   * `last_update` bump, no decay reset. False when the loop is gone.
   */
  rewriteOpenLoopPeople(
    id: string,
    actors: readonly string[],
    involved: readonly string[],
  ): Promise<boolean>;
  /** Append a run-id-stamped ledger entry and bump the loop's last_update. */
  appendOpenLoopLedger(
    loopId: string,
    entry: { runId: string; note: string },
    now: number,
  ): Promise<void>;
  /**
   * Delete a loop, enforcing the deletion invariant on attached briefs.
   * `now` (unix ms) stamps the retirement trace — the caller's cognition clock.
   */
  deleteOpenLoop(id: string, now: number): Promise<DeleteOpenLoopResult>;
  /**
   * Durable doc-annotation ops. `createDocAnnotation` persists an
   * evidence-grounded prior; `invalidateAnnotationsForDoc` re-judges the
   * priors touching a changed document against its new content — quote broke
   * → soft-dropped, quote survived → kept live but re-stamped `unverified`;
   * `cascadeAnnotationPrivacyDelete` hard-purges those grounded on
   * privacy-deleted documents (always blanket).
   */
  createDocAnnotation(input: CreateDocAnnotationInput, now: number): Promise<DocAnnotationRow>;
  /**
   * Belief revision, atomically: create the successor prior AND retire the
   * annotation it supersedes (invalidated_at + superseded_by) in one writer
   * op, so a crash can never leave both claims standing. `superseded` is
   * false when the old row was already dead/unknown by write time.
   */
  createDocAnnotationSuperseding(
    input: CreateDocAnnotationInput,
    supersedesId: string,
    now: number,
  ): Promise<{ annotation: DocAnnotationRow; superseded: boolean }>;
  /**
   * Pure belief retirement — no create: retire the live prior `id` in favour
   * of the ALREADY-EXISTING live annotation `supersededById`. Liveness of
   * both rows is re-checked inside the write; `superseded` is false (nothing
   * changed) when either was dead/unknown by write time.
   */
  supersedeDocAnnotationBy(
    id: string,
    supersededById: string,
    now: number,
  ): Promise<{ superseded: boolean }>;
  /** Revise a prior in place (claim/confidence); null when it doesn't exist. */
  updateDocAnnotation(
    id: string,
    patch: UpdateDocAnnotationPatch,
    now: number,
  ): Promise<DocAnnotationRow | null>;
  /** Hard-delete one prior by id (retract). False when it doesn't exist. */
  deleteDocAnnotation(id: string, now: number): Promise<boolean>;
  invalidateAnnotationsForDoc(docId: string, now: number): Promise<AnnotationInvalidationResult>;
  cascadeAnnotationPrivacyDelete(deletedDocIds: readonly string[]): Promise<string[]>;
  /**
   * Brief-claim evidence-lifecycle ops. A claim's `evidence_quote` is the
   * cited document's text verbatim, so the evidence document's lifecycle
   * reaches into the claim set: `invalidateBriefClaimsForDoc` soft-drops the
   * live claims whose quote no longer appears in the changed content;
   * `cascadeBriefClaimPrivacyDelete` hard-purges every claim — live and
   * invalidated — citing a privacy-deleted document (always blanket).
   */
  invalidateBriefClaimsForDoc(docId: string, now: number): Promise<number>;
  cascadeBriefClaimPrivacyDelete(deletedDocIds: readonly string[]): Promise<string[]>;
  /**
   * Atomically delete loops grounded on the removed documents, their briefs
   * and mirrored corpus documents. Mirror index cleanup is queued durably.
   */
  cascadeOpenLoopPrivacyDelete(
    deletedDocIds: readonly string[],
  ): Promise<{ deletedLoopIds: string[]; deletedBriefIds: string[] }>;
  /**
   * Durable person-annotation ops (person-keyed sibling of the doc ones).
   * `createPersonAnnotation` persists an evidence-grounded prior about a
   * person; `revisePersonAnnotation`/`retractPersonAnnotation` edit/hard-remove
   * one (the person-annotation revise/retract tools);
   * `invalidatePersonAnnotationsForDoc` re-judges priors whose evidence doc
   * changed (quote broke → soft-dropped, survived → kept unverified);
   * `cascadePersonAnnotationPrivacyDelete` hard-purges those on a
   * privacy-deleted evidence doc.
   */
  createPersonAnnotation(
    input: CreatePersonAnnotationInput,
    now: number,
  ): Promise<PersonAnnotationRow>;
  /** Atomic create-and-supersede — the person-store sibling of `createDocAnnotationSuperseding`. */
  createPersonAnnotationSuperseding(
    input: CreatePersonAnnotationInput,
    supersedesId: string,
    now: number,
  ): Promise<{ annotation: PersonAnnotationRow; superseded: boolean }>;
  /** Pure belief retirement — the person-store sibling of `supersedeDocAnnotationBy`. */
  supersedePersonAnnotationBy(
    id: string,
    supersededById: string,
    now: number,
  ): Promise<{ superseded: boolean }>;
  revisePersonAnnotation(
    id: string,
    patch: UpdatePersonAnnotationPatch,
    now: number,
  ): Promise<boolean>;
  retractPersonAnnotation(id: string, now: number): Promise<boolean>;
  invalidatePersonAnnotationsForDoc(
    docId: string,
    now: number,
  ): Promise<AnnotationInvalidationResult>;
  cascadePersonAnnotationPrivacyDelete(deletedDocIds: readonly string[]): Promise<string[]>;
  /**
   * Conversation read state — whether an agent conversation holds something
   * the operator has not seen. Reads do not come through here: "which of
   * these are unread" is answered straight off the read handle when the list
   * is rendered.
   */
  markConversationSeen(conversationId: string): Promise<void>;
  recordConversationAgentContent(
    conversationId: string,
    now: number,
  ): Promise<{ openedEpisode: boolean }>;
  forgetConversationReadState(conversationIds: readonly string[]): Promise<void>;
  /**
   * Developer-annotation ops (OMNESIS_DEV_MODE): the operator → engineer
   * feedback channel. Distinct from the doc-annotation ops above — these are
   * user-authored data-quality notes, not agent-derived priors.
   */
  createDevAnnotation(input: CreateDevAnnotationInput, now: number): Promise<DevAnnotationRow>;
  resolveDevAnnotation(
    id: string,
    now: number,
    resolvedNote?: string | null,
  ): Promise<DevAnnotationRow | null>;
  deleteDevAnnotation(id: string): Promise<boolean>;
  /** Durable state transitions for the external-answer privacy boundary. */
  beginAnswerTask(input: BeginAnswerTaskInput): Promise<BegunAnswerTask>;
  completeAnswerTask(input: CompleteAnswerTaskInput): Promise<AnswerResponse>;
  failAnswerTask(
    taskId: string,
    ownerId: string,
    now: number,
    failure?: AnswerFailureSummary,
  ): Promise<boolean>;
  resolvePrivacyApproval(input: ResolveApprovalInput): Promise<AnswerResponse | null>;
  expirePrivacyApprovals(now: number): Promise<number>;
  recoverInterruptedAnswerTasks(now: number): Promise<number>;
  appendAnswerAuditEvents(inputs: ReadonlyArray<AppendAnswerAuditEventInput>): Promise<void>;
  appendDirectAuditEvent(input: AppendDirectAuditEventInput): Promise<{
    sessionId: string;
    eventId: string;
  }>;
  deleteDirectAuditSession(sessionId: string): Promise<boolean>;
  recordAnswerEgress(input: RecordAnswerEgressInput): Promise<RecordedAnswerEgress | null>;
  deletePrivacyConversation(input: DeletePrivacyConversationInput): Promise<boolean>;
  commitPrivacyPolicy(input: CommitPrivacyPolicyInput): Promise<CommitPrivacyPolicyResult>;
  deletePrivacyPolicyFamily(
    familyId: string,
    now: number,
  ): Promise<DeletePrivacyPolicyFamilyResult>;
  renamePrivacyPolicyFamily(
    familyId: string,
    name: string,
    now: number,
  ): Promise<RenamePrivacyPolicyFamilyResult>;
  markPrivacyPolicyMirrorSynced(generation: number, digest: string): Promise<boolean>;
  claimAnswerCompletionDeliveries(
    input: ClaimAnswerCompletionDeliveriesInput,
  ): Promise<ClaimedAnswerCompletionDelivery[]>;
  authorizeAnswerCompletionDelivery(
    input: AuthorizeAnswerCompletionDeliveryInput,
  ): Promise<boolean>;
  settleAnswerCompletionDelivery(input: SettleAnswerCompletionDeliveryInput): Promise<boolean>;
  /** Subscription lifecycle and semantic-evaluation writes. */
  createSubscription(input: CreateSubscriptionMutation): Promise<CreateSubscriptionMutationResult>;
  setSubscriptionStatus(input: {
    subscriptionId: string;
    integrationDeviceId: string;
    expectedRevision: number;
    status: "active" | "paused";
    policyRevision: string;
    updatedAt: number;
  }): Promise<SetSubscriptionStatusMutationResult>;
  resolveSubscriptionApproval(
    input: ResolveSubscriptionApprovalMutation,
  ): Promise<ResolveSubscriptionApprovalMutationResult>;
  recordSubscriptionPrivacyReview(
    input: RecordSubscriptionPrivacyReviewMutation,
  ): Promise<RecordSubscriptionPrivacyReviewMutationResult>;
  revokeSubscription(input: RevokeSubscriptionMutation): Promise<RevokeSubscriptionMutationResult>;
  purgeSubscription(input: PurgeSubscriptionMutation): Promise<PurgeSubscriptionMutationResult>;
  fireSubscription(input: FireSubscriptionMutation): Promise<FireSubscriptionMutationResult>;
  claimSubscriptionDeliveries(
    input: ClaimSubscriptionDeliveriesMutation,
  ): Promise<ClaimedSubscriptionDelivery[]>;
  authorizeSubscriptionDeliveryCommit(
    input: AuthorizeSubscriptionDeliveryCommitMutation,
  ): Promise<AuthorizeSubscriptionDeliveryCommitMutationResult>;
  settleSubscriptionDelivery(
    input: SettleSubscriptionDeliveryMutation,
  ): Promise<SettleSubscriptionDeliveryMutationResult>;
  issueSubscriptionFiringAnswerAuthority(
    input: IssueSubscriptionFiringAnswerAuthorityMutation,
  ): Promise<IssueSubscriptionFiringAnswerAuthorityMutationResult>;
  issueSubscriptionFiringOutcomeAuthority(
    input: IssueSubscriptionFiringOutcomeAuthorityMutation,
  ): Promise<IssueSubscriptionFiringOutcomeAuthorityMutationResult>;
  recordSubscriptionFiringOutcome(
    input: RecordSubscriptionFiringOutcomeMutation,
  ): Promise<RecordSubscriptionFiringOutcomeMutationResult>;
  useSubscriptionFiringAnswerAuthority(
    input: UseSubscriptionFiringAnswerAuthorityMutation,
  ): Promise<ValidateSubscriptionFiringAnswerAuthorityResult>;
  finalizeSubscriptionFiringAnswerEgress(
    input: FinalizeSubscriptionFiringAnswerEgressMutation,
  ): Promise<FinalizeSubscriptionFiringAnswerEgressMutationResult>;
  expireSubscriptions(now: number): Promise<number>;
  reconcileSubscriptionsPolicy(policyRevision: string, reconciledAt: number): Promise<number>;
  /**
   * LLM temporal-annotation ops. This is the only mutable temporal store:
   * deterministic temporal projections deliberately have no write-gate
   * methods, so an agent cannot mutate them.
   */
  /**
   * Mark documents as bootstrap-processed (the retrospective sweep's per-doc
   * marker) — set at enqueue for a run's own doc and at settle for the docs it
   * opened. Set at enqueue and lifted only by `readmitFailedBootstrapDoc`,
   * so the ordinary path never re-selects a document twice. Returns the number
   * newly marked.
   */
  markDocsBootstrapProcessed(docIds: readonly string[], nowIso: string): Promise<number>;
  /**
   * Lift the processed marker for a document whose bootstrap run just failed
   * terminally, so the enqueuer may select it again. Bounded per document —
   * see `readmitFailedBootstrapDoc`. Resolves to whether the marker was lifted.
   */
  readmitFailedBootstrapDoc(docId: string): Promise<boolean>;
  /**
   * Per-source coverage tallies (reporting only — see brain/storage/coverage.ts).
   * `recordCognitionCoverage` applies increments from the bootstrap enqueue
   * pass and from run settlement; `retractOrphanCognitionCoverage` drops rows
   * for sources whose documents are all gone, driven by the one
   * cognitive-state cascade every document-delete path runs.
   */
  recordCognitionCoverage(deltas: readonly CognitionCoverageDelta[], now: number): Promise<number>;
  retractOrphanCognitionCoverage(): Promise<number>;
  /**
   * Per-sweep production tallies (reporting only — see
   * brain/storage/sweep-tally.ts). Applied at run settlement, and when the
   * brief judge holds a card a sweep tried to ship.
   */
  recordSweepTally(delta: SweepTallyDelta, now: number): Promise<void>;
  createTemporalAnnotation(
    input: CreateTemporalAnnotationInput,
    now: number,
  ): Promise<TemporalAnnotation>;
  /** Edit a live LLM-owned temporal annotation. */
  updateTemporalAnnotation(
    id: string,
    patch: UpdateTemporalAnnotationPatch,
    now: number,
  ): Promise<boolean>;
  /** Soft-remove a live LLM-owned temporal annotation. */
  invalidateTemporalAnnotation(id: string, now: number): Promise<boolean>;
  /**
   * Per-atom content-change invalidation for live entries citing `docId` —
   * the calendar surface relies on it (a stale entry rendered verbatim is
   * worse than a gap). Entries with a surviving grounding quote are kept;
   * only fully-ungrounded ones are soft-invalidated.
   */
  invalidateTemporalAnnotationsForDoc(
    docId: string,
    now: number,
  ): Promise<TemporalAnnotationInvalidationResult>;
  /**
   * Stamp `refile_presented_run` on churn-invalidated annotations a data
   * run's prompt just listed for re-filing — retires them from the re-file
   * lookup once that run completes.
   */
  markTemporalAnnotationsRefilePresented(ids: readonly string[], runId: string): Promise<void>;
  cascadeTemporalAnnotationPrivacyDelete(deletedDocIds: readonly string[]): Promise<string[]>;
  /** Atomically create a brief and record its live annotation dependencies. */
  createBrief(
    input: CreateBriefInput,
    dependencies: ConsumptionDependencyContext,
    now: number,
  ): Promise<ConsumptionMutationResult<BriefRow>>;
  /** Atomically partial-update a brief and record its live dependencies. */
  updateBrief(
    id: string,
    input: UpdateBriefInput,
    dependencies: ConsumptionDependencyContext,
    now: number,
  ): Promise<ConsumptionMutationResult<BriefRow | null>>;
  /**
   * Withdraw a brief from the feed, keeping its row (state `retired`, which is
   * terminal). False when the brief doesn't exist.
   */
  retireBrief(id: string, now: number): Promise<boolean>;
  /**
   * Retract a resolved loop's still-actionable briefs — move every
   * non-terminal brief attached to `loopId` to `dismissed_already_handled`
   * (a terminal handled state). The loop-resolve cascade: a resolved loop
   * never leaves a lingering, actionable brief. Idempotent. Returns the
   * retracted brief ids.
   */
  retractBriefsForResolvedLoop(loopId: string, now: number): Promise<string[]>;
  /**
   * Dismiss a brief (user-driven, from the feed's dismiss modal): flip
   * its `dismissed_*` state + store the free text + enqueue the async
   * feedback run, atomically.
   */
  dismissBrief(input: DismissBriefInput, now: number): Promise<DismissBriefResult>;
  /** Mark a brief seen (`unread` → `read`); idempotent on `read`. */
  markBriefRead(id: string, now: number): Promise<MarkBriefReadResult>;
  /** Stamp a brief's follow-up thread (once; false if already stamped). */
  setBriefThreadConversation(id: string, conversationId: string, now: number): Promise<boolean>;
  /** Replace a dead thread pointer (CAS on the dead id; false if it moved). */
  restampBriefThreadConversation(
    id: string,
    deadConversationId: string,
    conversationId: string,
    now: number,
  ): Promise<boolean>;
  /**
   * Return every `dismissed_snoozed` brief whose user-picked `next_show`
   * has arrived to `unread` (the durable snooze resurface, run on the
   * rhythm tick). Returns the number resurfaced.
   */
  resurfaceDueSnoozedBriefs(now: number): Promise<number>;
  /** Replace the agent-notes blob (size-capped); returns the stored content. */
  writeCognitionNotes(content: string, opts: { maxBytes: number; now: number }): Promise<string>;
  /**
   * Atomically append a line to the agent-notes blob (read-modify-write in
   * one writer transaction, so concurrent runs can't clobber each other).
   * `applied: false` = the append would exceed the cap; notes unchanged.
   */
  appendCognitionNotes(
    text: string,
    opts: { maxBytes: number; now: number },
  ): Promise<AppendCognitionNotesResult>;
  /**
   * Atomically replace one exact substring of the agent-notes blob (same
   * single-transaction discipline as append). Refused when `oldText` is
   * absent or ambiguous, or when the edit would exceed the overflow ceiling.
   */
  editCognitionNotes(
    oldText: string,
    newText: string,
    opts: { maxBytes: number; now: number },
  ): Promise<EditCognitionNotesResult>;
  /** Wipe the agent-notes blob — the one operator (CLI) mutation in V1. */
  wipeCognitionNotes(now: number): Promise<void>;

  // ── omnesis-chat ──────────────────────────────────────────────────
  /**
   * Replace every `link_type='cited'` edge originating from
   * `sourceDocId` with the supplied citation set. Type A:
   * conversations as first-class documents.
   */
  upsertConversationCitations(
    sourceDocId: string,
    citations: ReadonlyArray<ConversationCitationInput>,
  ): Promise<UpsertConversationCitationsResult>;

  // ── omnesis-notes ─────────────────────────────────────────────────
  /**
   * Append one captured note to the `note_entries` ledger. Returns
   * false when a row with that id already exists — the id doubles as
   * the client idempotency key, so a retried capture is a no-op.
   */
  appendNoteEntry(entry: NoteEntry, audit?: McpToolInvocationAuditInput): Promise<boolean>;
  /**
   * Replace an entry's text (bumps `updated_at`). Returns false when
   * the id is unknown.
   */
  updateNoteEntry(id: string, text: string, now: string): Promise<boolean>;
  /**
   * Hard-delete one entry. Returns whether a row was deleted plus its
   * day so the caller can re-render that day's projected document.
   */
  deleteNoteEntry(id: string): Promise<{ deleted: boolean; day: string | null }>;

  // ── agent-conversations (pushed) ──────────────────────────────────
  /**
   * Append one pushed agent-conversation turn to the `agent_messages`
   * ledger. Returns false when a row with that id already exists — the id
   * doubles as the client idempotency key, so a re-pushed turn is a no-op.
   */
  appendAgentMessage(message: AgentMessageRow): Promise<boolean>;

  // ── near-dupes ────────────────────────────────────────────────────
  /**
   * Enqueue a set of docs into `near_dup_inbox` for the near-dup
   * compute drip. A doc pending under the same reason keeps a single
   * row, but a re-enqueue replaces that row and mints a strictly larger
   * id — so content queued while a compute pass holds an earlier peek is
   * not drained away with the batch it was queued behind.
   */
  enqueueNearDupInbox(
    docIds: ReadonlyArray<string>,
    reason: NearDupInboxReason,
  ): Promise<{ enqueued: number }>;
  /**
   * Apply a NearDupApplyBatch produced by the near-dup pipeline.
   * Yieldable per-doc commits — higher-priority writer work preempts
   * between docs and the next call picks up the un-applied tail.
   */
  applyNearDupBatch(batch: NearDupApplyBatch): Promise<NearDupApplyResult>;
  /**
   * Apply a DF build the compute pass left in a staging database. The
   * writer opens that file itself rather than being handed its rows, so a
   * multi-million-row table never crosses a worker boundary. Wipes the
   * existing rows for the algo, streams the staged ones in yieldable
   * chunks, and advances the OCC watermark.
   */
  applyNearDupDfFromStaging(input: {
    stagingPath: string;
    /** Hex key the staging file was written with, when stores are encrypted. */
    stagingKeyHex?: string;
    algoVersion: string;
    totalDocs: number;
    minDf: number;
    capturedVersion: number;
    expectedRows: number;
  }): Promise<{ rebuilt: number }>;
  /**
   * Boot-time helper. If the persisted `near_dup_df_meta.algo_version`
   * differs from `config.algorithm.algoVersion`, bulk-enqueue every
   * eligible doc for re-processing under the new algo. Idempotent.
   */
  bumpNearDupAlgo(
    config: ResolvedNearDupConfig,
  ): Promise<{ enqueued: number; bumpedFrom: string | null }>;
  /**
   * One pass through the four near-dup tables deleting rows tagged
   * with non-active algos. The periodic `nearDupAlgoSweep` task loops
   * over this until `done: true`.
   */
  nearDupAlgoSweepStep(config: ResolvedNearDupConfig): Promise<{ cleared: number; done: boolean }>;
  /**
   * Reclaim one chunk of a superseded DF generation. Cheap where
   * `nearDupAlgoSweepStep` is not, so the periodic task repeats this one.
   */
  nearDupGenerationSweepStep(
    config: ResolvedNearDupConfig,
  ): Promise<{ cleared: number; done: boolean }>;
  /**
   * Bump `refresh_meta(job='near_dup_df').dirty_version`. Direct
   * callers that mutate eligible documents via paths that don't
   * already bump (admin, tests). Production code bumps inline.
   */
  markNearDupDfDirty(): Promise<void>;
}

import {
  writerHandlers,
  type WriterArgs,
  type WriterOpName,
  type WriterReturn,
} from "./scheduler/writer-handlers.js";
import type Database from "better-sqlite3";
/**
 * Dispatch function signature — takes an op name + positional args and
 * returns a promise of the op's result. Typed against the writer
 * handler registry so caller-args structurally match the handler that
 * will receive them (post-`db`). Any transport — postMessage to the
 * worker, direct in-process call, forward-via-main-hop from another
 * worker — implements this signature and plugs into `writeGateFromCall`
 * below.
 *
 * Bug class this catches: a gate factory entry that says
 * `call("op.name", [a, b])` while the handler expects `(db, a, b, c)`
 * now fails to compile, instead of producing a runtime "undefined
 * argument" deep inside the worker.
 */
export type WriterCallFn = <K extends WriterOpName>(
  op: K,
  args: WriterArgs<K>,
) => Promise<Awaited<WriterReturn<K>>>;

/**
 * Apply a pairing's staged self annotation to the freshly created
 * device, reusing the same `updateDeviceSelfInfo` write the explicit
 * `devices set-self` path uses. No-op when the operator skipped the
 * annotation (both lists empty), so the default pairing flow is unchanged.
 *
 * The identifiers were validated + normalized at the HTTP boundary before
 * the code was minted, so this is a raw write — it just lands them onto the
 * device row in the same redeem flow that created it.
 */
export async function applyPendingSelfInfo(
  w: WriteGate,
  deviceId: DeviceId,
  pending: Pick<PendingPairing, "selfEmails" | "selfPhones">,
): Promise<void> {
  const patch: { selfEmails?: string[]; selfPhones?: string[] } = {};
  if (pending.selfEmails.length > 0) patch.selfEmails = pending.selfEmails;
  if (pending.selfPhones.length > 0) patch.selfPhones = pending.selfPhones;
  if (patch.selfEmails === undefined && patch.selfPhones === undefined) return;
  await w.updateDeviceSelfInfo(deviceId, patch);
}

/**
 * Build a `WriteGate` from a generic call function. Used by
 * `writeGateFromScheduler` (call = enqueue a writer Task on the
 * Scheduler) and the `directWriteGate` test fallback (call = invoke
 * the underlying SQL fn synchronously). Keeping one copy of the
 * method-name → op-name mapping means the two transports can never
 * drift.
 */
function canonicalizerRegistryForWrite(
  specs?: readonly UrlCanonicalizerSpec[],
): ReadonlyMap<string, UrlCanonicalizerSpec> | undefined {
  if (!specs || specs.length === 0) return undefined;
  // Production HTTP services pass the process registry's data-only spec
  // snapshot. Reuse its already-compiled matchers instead of constructing a
  // fresh WebAssembly RE2 registry for every ingest request. Ad-hoc specs are
  // retained for direct callers and tests, and are still compiled off-writer.
  return specs === getUrlCanonicalizerSpecs()
    ? getUrlCanonicalizers()
    : buildSafeUrlCanonicalizerRegistry(specs);
}

export function writeGateFromCall(call: WriterCallFn): WriteGate {
  return {
    upsertDocuments: (
      docs,
      canonicalizers,
      writeEpochs,
      cursorRows,
      streams,
      replicaVersionPolicies,
    ) => {
      const registry = canonicalizerRegistryForWrite(canonicalizers);
      const prepared = prepareDocumentsForWrite(docs, registry);
      return call("db.upsertDocuments", [
        prepared,
        writeEpochs,
        cursorRows,
        streams,
        replicaVersionPolicies,
      ]);
    },
    deleteDocuments: (providerId, sourceId, externalIds, expectedWipeEpoch, cursorRow, streamId) =>
      call("db.deleteDocuments", [
        providerId,
        sourceId,
        externalIds,
        expectedWipeEpoch,
        cursorRow,
        streamId,
      ]),
    deleteDocumentForUser: (providerId, sourceId, externalId, streamId, tombstone) =>
      call("db.deleteDocumentForUser", [providerId, sourceId, externalId, streamId, tombstone]),
    deleteDocumentForRetention: (providerId, sourceId, externalId) =>
      call("db.deleteDocumentForRetention", [providerId, sourceId, externalId]),
    completeDocumentRetention: (providerId, sourceId, externalId) =>
      call("db.completeDocumentRetention", [providerId, sourceId, externalId]),
    applySnapshotAbsencePlan: (plan, expectedWipeEpoch, cursorRow) =>
      call("db.applySnapshotAbsencePlan", [plan, expectedWipeEpoch, cursorRow]),
    applyReplicaOmissions: (args) => call("db.applyReplicaOmissions", [args]),
    judgeAnalyticsTombstones: (args) => call("db.judgeAnalyticsTombstones", [args]),
    recordAnalyticsPresence: (args) => call("db.recordAnalyticsPresence", [args]),
    recordAnalyticsRestorerOmissions: (args) => call("db.recordAnalyticsRestorerOmissions", [args]),
    recordAnalyticsSweepVerdict: (verdict, now) =>
      call("db.recordAnalyticsSweepVerdict", [verdict, now]),
    reclaimStaleAbsences: (candidates) => call("db.reclaimStaleAbsences", [[...candidates]]),
    sweepDueAbsences: (documentIds, opts) => call("db.sweepDueAbsences", [documentIds, opts]),
    acknowledgeAbsenceCascade: (id, part) => call("db.acknowledgeAbsenceCascade", [id, part]),
    deleteAllBySource: (sourceId) => call("db.deleteAllBySource", [sourceId]),
    deleteAllByStream: (sourceId, streamId) => call("db.deleteAllByStream", [sourceId, streamId]),
    deleteAllByProvider: (providerId) => call("db.deleteAllByProvider", [providerId]),
    markSourceStatsDirty: (sourceId) => call("db.markSourceStatsDirty", [sourceId]),
    refreshSourceStatsRow: (sourceId) => call("db.refreshSourceStatsRow", [sourceId]),
    upsertSourceStatsRow: (sourceId, agg) => call("db.upsertSourceStatsRow", [sourceId, agg]),
    beginSyncAttempt: (sourceId, cursorRow) => call("db.beginSyncAttempt", [sourceId, cursorRow]),
    promoteSourceWireContract: (sourceId, version) =>
      call("db.promoteSourceWireContract", [sourceId, version]),
    preparePendingSourcePage: (args) => call("db.preparePendingSourcePage", [args]),
    replaceSourceSyncIssues: (sourceId, deviceId, issues, assessments) =>
      call("db.replaceSourceSyncIssues", [sourceId, deviceId, issues, assessments]),
    acknowledgePendingSourcePage: (args) => call("db.acknowledgePendingSourcePage", [args]),
    revokeSyncAttempt: (sourceId, expectedEpoch, cursorRow) =>
      call("db.revokeSyncAttempt", [sourceId, expectedEpoch, cursorRow]),
    resetMemberCursor: (sourceId, deviceId) => call("db.resetMemberCursor", [sourceId, deviceId]),

    setSyncState: (sourceId, cursor, meta, writeEpoch, deviceId) =>
      call("db.setSyncState", [sourceId, cursor, meta, writeEpoch, deviceId]),
    setSourceMeta: (sourceId, meta) => call("db.setSourceMeta", [sourceId, meta]),
    upsertWithCursor: (args, canonicalizers) => {
      const registry = canonicalizerRegistryForWrite(canonicalizers);
      return call("db.upsertWithCursor", [
        {
          ...args,
          documents: args.documents
            ? prepareDocumentsForWrite(args.documents, registry)
            : args.documents,
        },
      ]);
    },
    applySourceUrlRecanonicalizationPage: (cursor, mutations) =>
      call("db.applySourceUrlRecanonicalizationPage", [cursor, mutations]),
    finishSourceUrlRecanonicalization: (cursor) =>
      call("db.finishSourceUrlRecanonicalization", [cursor]),
    setSyncError: (sourceId, errorMessage, deviceId, remediation) =>
      call("db.setSyncError", [sourceId, errorMessage, deviceId, remediation]),
    clearSyncError: (sourceId, deviceId) => call("db.clearSyncError", [sourceId, deviceId]),
    recoverReauthReminder: (principal, deviceId, collapsePrefix, now) =>
      call("db.recoverReauthReminder", [principal, deviceId, collapsePrefix, now]),
    reserveReauthReminder: (principal, deviceId, now, cfg) =>
      call("db.reserveReauthReminder", [principal, deviceId, now, cfg]),
    releaseReauthReminder: (token) => call("db.releaseReauthReminder", [token]),
    commitReauthReminderNotification: (token, now, input) =>
      call("notifications.commitReauthReminder", [token, now, input]),
    replaceMobilePermissionHealth: (input) => call("mobilePermission.replace", [input]),
    reserveMobilePermissionReminder: (sourceId, now, cfg) =>
      call("mobilePermission.reserveReminder", [sourceId, now, cfg]),
    releaseMobilePermissionReminder: (token, episodeId) =>
      call("mobilePermission.releaseReminder", [token, episodeId]),
    commitMobilePermissionReminderNotification: (token, episodeId, now, input) =>
      call("notifications.commitMobilePermissionReminder", [token, episodeId, now, input]),

    findOrCreatePerson: (mention, sourceId, docDate) =>
      call("people.findOrCreatePerson", [mention, sourceId, docDate]),
    resolveDocumentPeople: (docId, people, sourceId, docDate) =>
      call("people.resolveDocumentPeople", [docId, people, sourceId, docDate]),
    backfillManyPeople: (batchSize) => call("people.backfillManyPeople", [batchSize]),
    seedFromContacts: () => call("people.seedFromContacts", []),
    upsertSeedFromContacts: (plan) => call("people.upsertSeedFromContacts", [plan]),
    detectSelfFromSourceIds: (hooks) => call("people.detectSelfFromSourceIds", [hooks]),
    bootstrapSelfFromConfig: (configSelf) => call("people.bootstrapSelfFromConfig", [configSelf]),
    mergePeople: (winnerId, loserId) => call("people.mergePeople", [winnerId, loserId]),
    runMergePass: () => call("people.runMergePass", []),
    collapseTransitiveChains: () => call("people.collapseTransitiveChains", []),
    upsertTransitiveCollapse: (rows) => call("people.upsertTransitiveCollapse", [rows]),
    rebuildPeopleFromDocuments: (hooks) => call("people.rebuildPeopleFromDocuments", [hooks]),
    refreshPeopleCounts: () => call("people.refreshPeopleCounts", []),
    upsertPeopleCounts: (rows) => call("people.upsertPeopleCounts", [rows]),
    advancePeopleCountsWatermark: (capturedVersion) =>
      call("people.advanceCountsWatermark", [capturedVersion]),
    zeroPeopleCountsForLosers: () => call("people.zeroPeopleCountsForLosers", []),
    recomputeNamePrimaries: () => call("people.recomputeNamePrimaries", []),
    upsertInteractionScores: (snapshot) => call("people.upsertInteractionScores", [snapshot]),
    markPeopleGraphDirty: () => call("people.markPeopleGraphDirty", []),
    createMergeRule: (input) => call("people.createMergeRule", [input]),
    deleteMergeRule: (ruleId) => call("people.deleteMergeRule", [ruleId]),
    deleteMergeRuleGroup: (groupId) => call("people.deleteMergeRuleGroup", [groupId]),
    upsertAutoDetectedRules: (candidates) => call("people.upsertAutoDetectedRules", [candidates]),
    upsertMergeEquivalences: (snapshot) => call("people.upsertMergeEquivalences", [snapshot]),
    unmergePerson: (personId) => call("people.unmergePerson", [personId]),
    physicalDedupSharedAliases: () => call("people.physicalDedupSharedAliases", []),
    pruneNoreplyAliases: () => call("people.pruneNoreplyAliases", []),
    upgradePlaceholderCanonicalNames: () => call("people.upgradePlaceholderCanonicalNames", []),
    demoteSharedAddresses: (nameThreshold, maxEmails) =>
      call("people.demoteSharedAddresses", [nameThreshold, maxEmails]),
    upsertMergeCandidates: (proposals) => call("people.upsertMergeCandidates", [proposals]),
    acceptMergeCandidate: (input) => call("people.acceptMergeCandidate", [input]),
    denyMergeCandidate: (candidateId) => call("people.denyMergeCandidate", [candidateId]),
    sweepCollapsedMergeCandidates: () => call("people.sweepCollapsedMergeCandidates", []),
    pruneSuppressedMergeCandidates: () => call("people.pruneSuppressedMergeCandidates", []),
    autoApproveHighConfidenceCandidates: () =>
      call("people.autoApproveHighConfidenceCandidates", []),
    applyMergeAdjudication: (input) => call("people.applyMergeAdjudication", [input]),
    reconcilePendingMergeCandidates: (proposals) =>
      call("people.reconcilePendingMergeCandidates", [proposals]),
    upsertTokenLabels: (rows) => call("people.upsertTokenLabels", [rows]),
    mergeCluster: (personIds, opts) => call("people.mergeCluster", [personIds, opts]),

    reconcileUnresolvedLinks: (limit) => call("links.reconcileUnresolvedLinks", [limit]),
    beginLinkDeclarationUpdate: () => call("links.beginDeclarationUpdate", []),
    finishLinkDeclarationUpdate: () => call("links.finishDeclarationUpdate", []),
    upsertLinkResolutions: (batch) => call("links.upsertLinkResolutions", [batch]),
    applyExtractedDates: (entries) => call("db.applyExtractedDates", [entries]),
    drainPendingEdges: (limit) => call("edges.drainPending", [limit]),
    upsertExtractedLinksBatch: (rows) => call("links.upsertExtractedLinksBatch", [rows]),
    markLinkStatsDirty: () => call("links.markLinkStatsDirty", []),
    upsertLinkStats: (agg) => call("links.upsertLinkStats", [agg]),
    reconcileLinkStatsCounters: () => call("links.reconcileLinkStatsCounters", []),

    refreshSqliteTableStats: () => call("catalog.refreshSqliteTableStats", []),

    registerOAuthClient: (input) => call("access.oauthClientRegister", [input]),
    upsertOAuthMetadataClient: (input) => call("access.oauthMetadataClientUpsert", [input]),
    createExecutionBinding: (input) => call("access.executionBindingCreate", [input]),
    createAuthorizationRequest: (input) => call("access.authorizationCreate", [input]),
    enqueueAccessAuthorizationNotification: (requestId, deviceIds) =>
      call("access.authorizationNotificationEnqueue", [requestId, deviceIds]),
    decideAuthorizationRequest: (input) => call("access.authorizationDecide", [input]),
    issueAuthorizationCode: (browserHandle) =>
      call("access.authorizationIssueCode", [browserHandle]),
    issueAuthorizationCodeById: (requestId) =>
      call("access.authorizationIssueCodeById", [requestId]),
    exchangeOAuthToken: (input) => call("access.tokenExchange", [input]),
    reissueExecutionDeviceTokens: (input) => call("access.executionTokensReissue", [input]),
    updateAccessGrant: (input) => call("access.grantUpdate", [input]),
    createAccessLevel: (input) => call("access.levelCreate", [input]),
    updateAccessLevel: (input) => call("access.levelUpdate", [input]),
    deleteAccessLevel: (input) => call("access.levelDelete", [input]),
    setAccessConnectionLevel: (input) => call("access.connectionLevelSet", [input]),
    setAccessDeviceLevel: (input) => call("access.deviceLevelSet", [input]),
    renameAccessPrincipal: (input) => call("access.principalRename", [input]),
    revokeAccessEntity: (input) => call("access.revoke", [input]),
    recordMcpToolInvocationAudit: (input) => call("access.mcpInvocationAudit", [input]),
    touchPrincipalCredentialUsageBatch: (rows) => call("access.credentialUsageTouchBatch", [rows]),
    cleanupExpiredAccessStateBatch: (phase, now, limit, cursor) =>
      call("access.cleanupBatch", [phase, now, limit, cursor]),

    createDevice: (opts) => call("devices.createDevice", [opts]),
    createOrAdoptDevice: (input) => call("devices.createOrAdoptDevice", [input]),
    deleteDevice: (id) => call("devices.deleteDevice", [id]),
    revokeDevice: (id, pairingFence, expectedImpactFingerprint) =>
      call("devices.revokeDevice", [id, pairingFence, expectedImpactFingerprint]),
    renameDevice: (id, name) => call("devices.renameDevice", [id, name]),
    replaceDeviceForRepair: (oldId, opts) => call("devices.replaceDeviceForRepair", [oldId, opts]),
    updateDeviceCapabilities: (id, caps, protocolVersion) =>
      call("devices.updateDeviceCapabilities", [id, caps, protocolVersion]),
    setDeviceUpdateRequest: (id, request) => call("devices.setUpdateRequest", [id, request]),
    beginDeviceDoctorRun: (input) => call("devices.doctorRunBegin", [input]),
    startDeviceDoctorRun: (input) => call("devices.doctorRunStart", [input]),
    requeueDeviceDoctorRun: (input) => call("devices.doctorRunRequeue", [input]),
    failDeviceDoctorRun: (input) => call("devices.doctorRunFail", [input]),
    completeDeviceDoctorRun: (input) => call("devices.doctorRunComplete", [input]),
    updateDeviceSelfInfo: (id, patch) => call("devices.updateDeviceSelfInfo", [id, patch]),
    setDeviceNotificationDeliveryHealth: (id, status, updatedAt) =>
      call("devices.setNotificationDeliveryHealth", [id, status, updatedAt]),
    setDeviceApnsToken: (id, registration) => call("devices.setApnsToken", [id, registration]),
    clearDeviceApnsToken: (id, expected) => call("devices.clearApnsToken", [id, expected]),
    setDeviceFcmToken: (id, registration) => call("devices.setFcmToken", [id, registration]),
    clearDeviceFcmToken: (id, expected) => call("devices.clearFcmToken", [id, expected]),
    setDeviceRelayPushConsent: (id, consent) => call("devices.setRelayPushConsent", [id, consent]),
    withdrawDeviceRelayPushConsent: (id) => call("devices.withdrawRelayPushConsent", [id]),
    setDeviceRelayPushRegistration: (id, registration) =>
      call("devices.setRelayPushRegistration", [id, registration]),
    enqueueNotification: (input) => call("notifications.enqueue", [input]),
    leaseNotificationWakes: (input) => call("notifications.leaseWakes", [input]),
    settleNotificationWake: (input) => call("notifications.settleWake", [input]),
    claimNotification: (input) => call("notifications.claim", [input]),
    confirmNotification: (input) => call("notifications.confirm", [input]),
    cleanupExpiredNotifications: (now) => call("notifications.cleanupExpired", [now]),
    bootstrapSelfFromDevices: () => call("devices.bootstrapSelfFromDevices", []),
    touchDevice: (id) => call("devices.touchDevice", [id]),
    createPairing: (opts) => call("devices.createPairing", [opts]),
    consumePairing: (pairingCode, expectedKind) =>
      call("devices.consumePairing", [pairingCode, expectedKind]),
    redeemDevicePairing: (input) => call("devices.redeemDevicePairing", [input]),
    revokePairing: (pairingCode) => call("devices.revokePairing", [pairingCode]),
    redeemAgentIntegrationPairing: (input) =>
      call("devices.redeemAgentIntegrationPairing", [input]),
    cleanupExpiredPairings: () => call("devices.cleanupExpiredPairings", []),

    createToken: (deviceId, scopes, name, opts) =>
      call("tokens.createToken", [deviceId, scopes, name ?? null, opts ?? {}]),
    validateToken: (rawToken) => call("tokens.validateToken", [rawToken]),
    touchTokenUsage: (tokenId, deviceId) => call("tokens.touchTokenUsage", [tokenId, deviceId]),
    touchTokenUsageBatch: (rows) => call("tokens.touchTokenUsageBatch", [rows]),
    reconcileDeviceTokenScopes: (tokenId, kind) =>
      call("tokens.reconcileDeviceTokenScopes", [tokenId, kind]),
    revokeToken: (id) => call("tokens.revokeToken", [id]),
    ensureBootstrapToken: (configDir) => call("tokens.ensureBootstrapToken", [configDir]),
    createSession: (tokenId, scopes, expiresInMs) =>
      call("tokens.createSession", [tokenId, scopes, expiresInMs]),
    refreshSessionActivity: (sessionId, sessionTtlMs, throttleMs) =>
      call("tokens.refreshSessionActivity", [sessionId, sessionTtlMs, throttleMs]),
    validateSession: (sessionId) => call("tokens.validateSession", [sessionId]),
    purgeExpiredSession: (sessionId) => call("tokens.purgeExpiredSession", [sessionId]),
    deleteSession: (sessionId) => call("tokens.deleteSession", [sessionId]),
    cleanupExpiredSessions: () => call("tokens.cleanupExpiredSessions", []),
    cleanupExpiredTokens: () => call("tokens.cleanupExpiredTokens", []),
    pruneActivityRetentionBatch: (phase, cutoff, limit) =>
      call("activityRetention.pruneBatch", [phase, cutoff, limit]),
    reclaimActivityRetentionPages: (maxPages) => call("activityRetention.reclaimPages", [maxPages]),

    createSource: (opts) => call("sources.createSource", [opts]),
    createSourceWithId: (id, opts) => call("sources.createSourceWithId", [id, opts]),
    updateSource: (id, patch) => call("sources.updateSource", [id, patch]),
    moveSource: (id, patch) => call("sources.moveSource", [id, patch]),
    deleteSource: (id) => call("sources.deleteSource", [id]),
    addSourceMember: (
      id,
      deviceId,
      configOverride,
      memberScopedParams,
      pairingFence,
      allowDetachedRejoin,
    ) =>
      call("sources.addMember", [
        id,
        deviceId,
        configOverride,
        memberScopedParams,
        pairingFence,
        allowDetachedRejoin,
      ]),
    updateSourceForMember: (
      id,
      deviceId,
      patch,
      configOverride,
      memberScopedParams,
      pairingFence,
    ) =>
      call("sources.updateForMember", [
        id,
        deviceId,
        patch,
        configOverride,
        memberScopedParams,
        pairingFence,
      ]),
    updateSourceMemberConfigOverride: (
      id,
      deviceId,
      configOverride,
      memberScopedParams,
      pairingFence,
    ) =>
      call("sources.updateMemberConfig", [
        id,
        deviceId,
        configOverride,
        memberScopedParams,
        pairingFence,
      ]),
    removeSourceMember: (id, deviceId, pairingFence) =>
      call("sources.removeMember", [id, deviceId, pairingFence]),
    prepareSourceModeTransition: (
      id,
      toMode,
      expectedOwnerDeviceId,
      memberScopedParams,
      replicaVersionPolicy,
      pairingFence,
    ) =>
      call("sources.prepareModeTransition", [
        id,
        toMode,
        expectedOwnerDeviceId,
        memberScopedParams,
        replicaVersionPolicy,
        pairingFence,
      ]),
    adoptSourceModeTransitionBatch: (id) => call("sources.adoptModeTransitionBatch", [id]),
    finalizeSourceModeTransition: (id) => call("sources.finalizeModeTransition", [id]),
    recordSourceModeTransitionFailure: (id, message) =>
      call("sources.failModeTransition", [id, message]),
    recordSourceModeTransitionPublicationFailure: (id, message) =>
      call("sources.failModeTransitionPublication", [id, message]),
    completeSourceModeTransitionPublication: (id) =>
      call("sources.completeModeTransitionPublication", [id]),
    recordSourceStreamCleanupFailure: (job, message) =>
      call("sources.failStreamCleanup", [job, message]),
    completeSourceStreamCleanup: (job) => call("sources.completeStreamCleanup", [job]),
    removeSource: (id, pairingFence) => call("sources.removeSource", [id, pairingFence]),
    markSourceRemoved: (id, opts) => call("sources.markSourceRemoved", [id, opts]),
    markSourceCleanupDone: (id) => call("sources.markSourceCleanupDone", [id]),
    clearSourceRemoved: (id) => call("sources.clearSourceRemoved", [id]),
    clearSourceRemovedIfCleanupDone: (id) => call("sources.clearSourceRemovedIfCleanupDone", [id]),
    upsertSourceDocumentProfiles: (entries, publishedAt) =>
      call("sources.upsertDocumentProfiles", [entries, publishedAt]),

    enqueueCognitionRun: (input, now) => call("cognition.enqueue", [input, now]),
    claimDueCognitionRuns: (opts) => call("cognition.claimDue", [opts]),
    finalizeCognitionRun: (input) => call("cognition.finalize", [input]),
    recordSettledCognitionRun: (input) => call("cognition.recordSettledRun", [input]),
    pullForwardCognitionRuns: (entries, activeDerivationStageIds) =>
      call("cognition.pullForward", [entries, activeDerivationStageIds]),
    cancelPendingCognitionRuns: (dedupeKeys) => call("cognition.cancelPending", [dedupeKeys]),
    cancelScheduledRunsForLoop: (loopId) => call("cognition.cancelScheduledForLoop", [loopId]),
    setCognitionEngineState: (key, value) => call("cognition.engineStateSet", [key, value]),
    addToCognitionEngineCounter: (key, delta) => call("cognition.engineCounterAdd", [key, delta]),
    recordCognitionSpend: (day, mechanism, modelId, usage, opts) =>
      call("cognition.recordCognitionSpend", [day, mechanism, modelId, usage, opts]),
    createOpenLoop: (input, dependencies, now) =>
      call("cognition.openLoopCreate", [input, dependencies, now]),
    updateOpenLoop: (id, input, dependencies, now) =>
      call("cognition.openLoopUpdate", [id, input, dependencies, now]),
    rewriteOpenLoopPeople: (id, actors, involved) =>
      call("cognition.openLoopRewritePeople", [id, actors, involved]),
    appendOpenLoopLedger: (loopId, entry, now) =>
      call("cognition.openLoopLedgerAppend", [loopId, entry, now]),
    deleteOpenLoop: (id, now) => call("cognition.openLoopDelete", [id, now]),
    createDocAnnotation: (input, now) => call("cognition.annotationCreate", [input, now]),
    createDocAnnotationSuperseding: (input, supersedesId, now) =>
      call("cognition.annotationCreateSuperseding", [input, supersedesId, now]),
    supersedeDocAnnotationBy: (id, supersededById, now) =>
      call("cognition.annotationSupersede", [id, supersededById, now]),
    updateDocAnnotation: (id, patch, now) => call("cognition.annotationUpdate", [id, patch, now]),
    deleteDocAnnotation: (id, now) => call("cognition.annotationDelete", [id, now]),
    invalidateAnnotationsForDoc: (docId, now) =>
      call("cognition.annotationInvalidate", [docId, now]),
    createPersonAnnotation: (input, now) => call("cognition.personAnnotationCreate", [input, now]),
    createPersonAnnotationSuperseding: (input, supersedesId, now) =>
      call("cognition.personAnnotationCreateSuperseding", [input, supersedesId, now]),
    supersedePersonAnnotationBy: (id, supersededById, now) =>
      call("cognition.personAnnotationSupersede", [id, supersededById, now]),
    revisePersonAnnotation: (id, patch, now) =>
      call("cognition.personAnnotationRevise", [id, patch, now]),
    retractPersonAnnotation: (id, now) => call("cognition.personAnnotationRetract", [id, now]),
    invalidatePersonAnnotationsForDoc: (docId, now) =>
      call("cognition.personAnnotationInvalidate", [docId, now]),
    cascadePersonAnnotationPrivacyDelete: (deletedDocIds) =>
      call("cognition.personAnnotationPrivacyDelete", [deletedDocIds]),
    markConversationSeen: (conversationId) =>
      call("conversationReadState.markSeen", [conversationId]),
    recordConversationAgentContent: (conversationId, now) =>
      call("conversationReadState.agentContentArrived", [conversationId, now]),
    forgetConversationReadState: (conversationIds) =>
      call("conversationReadState.forget", [conversationIds]),
    createDevAnnotation: (input, now) => call("devAnnotations.create", [input, now]),
    resolveDevAnnotation: (id, now, resolvedNote) =>
      call("devAnnotations.resolve", [id, now, resolvedNote]),
    deleteDevAnnotation: (id) => call("devAnnotations.delete", [id]),
    beginAnswerTask: (input) => call("privacy.answerBegin", [input]),
    completeAnswerTask: (input) => call("privacy.answerComplete", [input]),
    failAnswerTask: (taskId, ownerId, now, failure) =>
      call("privacy.answerFail", [taskId, ownerId, now, failure]),
    resolvePrivacyApproval: (input) => call("privacy.approvalResolve", [input]),
    expirePrivacyApprovals: (now) => call("privacy.approvalsExpire", [now]),
    recoverInterruptedAnswerTasks: (now) => call("privacy.answersRecover", [now]),
    appendAnswerAuditEvents: (inputs) => call("privacy.auditAppend", [inputs]),
    appendDirectAuditEvent: (input) => call("privacy.directAuditAppend", [input]),
    deleteDirectAuditSession: (sessionId) => call("privacy.directSessionDelete", [sessionId]),
    recordAnswerEgress: (input) => call("privacy.egressRecord", [input]),
    deletePrivacyConversation: (input) => call("privacy.conversationDelete", [input]),
    commitPrivacyPolicy: (input) => call("privacy.policyCommit", [input]),
    deletePrivacyPolicyFamily: (familyId, now) => call("privacy.policyDelete", [familyId, now]),
    renamePrivacyPolicyFamily: (familyId, name, now) =>
      call("privacy.policyRename", [familyId, name, now]),
    markPrivacyPolicyMirrorSynced: (generation, digest) =>
      call("privacy.policyMirrorSynced", [generation, digest]),
    claimAnswerCompletionDeliveries: (input) => call("privacy.completionsClaim", [input]),
    authorizeAnswerCompletionDelivery: (input) => call("privacy.completionAuthorize", [input]),
    settleAnswerCompletionDelivery: (input) => call("privacy.completionSettle", [input]),
    createSubscription: (input) => call("subscriptions.create", [input]),
    setSubscriptionStatus: (input) => call("subscriptions.setStatus", [input]),
    resolveSubscriptionApproval: (input) => call("subscriptions.resolveApproval", [input]),
    recordSubscriptionPrivacyReview: (input) => call("subscriptions.privacyReviewRecord", [input]),
    revokeSubscription: (input) => call("subscriptions.revoke", [input]),
    purgeSubscription: (input) => call("subscriptions.purge", [input]),
    fireSubscription: (input) => call("subscriptions.fire", [input]),
    claimSubscriptionDeliveries: (input) => call("subscriptions.deliveriesClaim", [input]),
    authorizeSubscriptionDeliveryCommit: (input) =>
      call("subscriptions.deliveryCommitAuthorize", [input]),
    settleSubscriptionDelivery: (input) => call("subscriptions.deliverySettle", [input]),
    issueSubscriptionFiringAnswerAuthority: (input) =>
      call("subscriptions.answerAuthorityIssue", [input]),
    issueSubscriptionFiringOutcomeAuthority: (input) =>
      call("subscriptions.outcomeAuthorityIssue", [input]),
    recordSubscriptionFiringOutcome: (input) => call("subscriptions.outcomeRecord", [input]),
    useSubscriptionFiringAnswerAuthority: (input) =>
      call("subscriptions.answerAuthorityUse", [input]),
    finalizeSubscriptionFiringAnswerEgress: (input) =>
      call("subscriptions.answerEgressFinalize", [input]),
    expireSubscriptions: (now) => call("subscriptions.expire", [now]),
    reconcileSubscriptionsPolicy: (policyRevision, reconciledAt) =>
      call("subscriptions.reconcilePolicy", [policyRevision, reconciledAt]),
    markDocsBootstrapProcessed: (docIds, nowIso) =>
      call("cognition.bootstrapMarkProcessed", [docIds, nowIso]),
    readmitFailedBootstrapDoc: (docId) => call("cognition.bootstrapReadmitFailed", [docId]),
    recordCognitionCoverage: (deltas, now) => call("cognition.coverageRecord", [deltas, now]),
    recordSweepTally: (delta, now) => call("cognition.sweepTallyRecord", [delta, now]),
    retractOrphanCognitionCoverage: () => call("cognition.coverageRetractOrphans", []),
    createTemporalAnnotation: (input, now) => call("temporalAnnotations.create", [input, now]),
    updateTemporalAnnotation: (id, patch, now) =>
      call("temporalAnnotations.update", [id, patch, now]),
    invalidateTemporalAnnotation: (id, now) => call("temporalAnnotations.invalidate", [id, now]),
    invalidateTemporalAnnotationsForDoc: (docId, now) =>
      call("temporalAnnotations.invalidateForDoc", [docId, now]),
    markTemporalAnnotationsRefilePresented: async (ids, runId) => {
      await call("temporalAnnotations.refilePresented", [ids, runId]);
    },
    cascadeTemporalAnnotationPrivacyDelete: (deletedDocIds) =>
      call("temporalAnnotations.privacyDelete", [deletedDocIds]),
    cascadeAnnotationPrivacyDelete: (deletedDocIds) =>
      call("cognition.annotationPrivacyDelete", [deletedDocIds]),
    invalidateBriefClaimsForDoc: (docId, now) =>
      call("cognition.briefClaimInvalidate", [docId, now]),
    cascadeBriefClaimPrivacyDelete: (deletedDocIds) =>
      call("cognition.briefClaimPrivacyDelete", [deletedDocIds]),
    cascadeOpenLoopPrivacyDelete: (deletedDocIds) =>
      call("cognition.openLoopCascade", [deletedDocIds]),
    createBrief: (input, dependencies, now) =>
      call("cognition.briefCreate", [input, dependencies, now]),
    updateBrief: (id, input, dependencies, now) =>
      call("cognition.briefUpdate", [id, input, dependencies, now]),
    retireBrief: (id, now) => call("cognition.briefRetire", [id, now]),
    retractBriefsForResolvedLoop: (loopId, now) =>
      call("cognition.briefRetractForLoop", [loopId, now]),
    dismissBrief: (input, now) => call("cognition.briefDismiss", [input, now]),
    markBriefRead: (id, now) => call("cognition.briefMarkRead", [id, now]),
    setBriefThreadConversation: (id, conversationId, now) =>
      call("cognition.briefSetThread", [id, conversationId, now]),
    restampBriefThreadConversation: (id, deadId, conversationId, now) =>
      call("cognition.briefRestampThread", [id, deadId, conversationId, now]),
    resurfaceDueSnoozedBriefs: (now) => call("cognition.snoozeResurface", [now]),
    writeCognitionNotes: (content, opts) => call("cognition.notesWrite", [content, opts]),
    appendCognitionNotes: (text, opts) => call("cognition.notesAppend", [text, opts]),
    editCognitionNotes: (oldText, newText, opts) =>
      call("cognition.notesEdit", [oldText, newText, opts]),
    wipeCognitionNotes: (now) => call("cognition.notesWipe", [now]),

    upsertConversationCitations: (sourceDocId, citations) =>
      call("omnesisChat.upsertConversationCitations", [sourceDocId, citations]),

    appendNoteEntry: (entry, audit) => call("notes.appendEntry", [entry, audit]),
    updateNoteEntry: (id, text, now) => call("notes.updateEntry", [id, text, now]),
    deleteNoteEntry: (id) => call("notes.deleteEntry", [id]),

    appendAgentMessage: (message) => call("agentMessages.appendMessage", [message]),

    enqueueNearDupInbox: (docIds, reason) => call("nearDup.enqueueInbox", [docIds, reason]),
    applyNearDupBatch: (batch) => call("nearDup.applyBatch", [batch]),
    applyNearDupDfFromStaging: (input) => call("nearDup.applyDfFromStaging", [input]),
    bumpNearDupAlgo: (config) => call("nearDup.bumpAlgo", [config]),
    nearDupAlgoSweepStep: (config) => call("nearDup.algoSweepStep", [config]),
    nearDupGenerationSweepStep: (config) => call("nearDup.generationSweepStep", [config]),
    markNearDupDfDirty: () => call("nearDup.markDfDirty", []),
  };
}

/**
 * Sync-in-Promise adapter for tests. Runs each write directly against
 * the passed db handle. Don't use in production — bypasses the single-
 * writer invariant.
 */
export function directWriteGate(db: Db): WriteGate {
  return {
    upsertDocuments: async (
      docs,
      canonicalizers,
      writeEpochs,
      cursorRows,
      streams,
      replicaVersionPolicies,
    ) => {
      const registry = canonicalizerRegistryForWrite(canonicalizers);
      const result = upsertDocuments(db, prepareDocumentsForWrite(docs, registry), {
        writeEpochs,
        cursorRows,
        streams,
        replicaVersionPolicies,
      });
      return {
        rejectedSourceIds: result.rejectedSourceIds,
        ignoredReplicaDocuments: result.ignoredReplicaDocuments,
        suppressedDocuments: result.suppressedDocuments,
      };
    },
    deleteDocuments: async (
      providerId,
      sourceId,
      externalIds,
      expectedWipeEpoch,
      cursorRow,
      streamId,
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
    deleteDocumentForUser: async (providerId, sourceId, externalId, streamId, tombstone) =>
      deleteDocumentForUser(
        db,
        providerId,
        sourceId,
        externalId,
        streamId ?? "",
        tombstone ?? true,
      ),
    deleteDocumentForRetention: async (providerId, sourceId, externalId) =>
      deleteDocumentForRetention(db, providerId, sourceId, externalId),
    completeDocumentRetention: async (providerId, sourceId, externalId) =>
      completeDocumentRetention(db, providerId, sourceId, externalId),
    applySnapshotAbsencePlan: async (plan, expectedWipeEpoch, cursorRow) =>
      applySnapshotAbsencePlan(db, plan, expectedWipeEpoch, cursorRow ?? ""),
    applyReplicaOmissions: async (args) => applyReplicaOmissions(db, args),
    judgeAnalyticsTombstones: async (args) => judgeAnalyticsTombstones(db, args),
    recordAnalyticsPresence: async (args) => {
      recordAnalyticsPresence(db, args);
    },
    recordAnalyticsRestorerOmissions: async (args) => recordAnalyticsRestorerOmissions(db, args),
    recordAnalyticsSweepVerdict: async (verdict, now) => {
      recordAnalyticsSweepVerdict(db, verdict, now);
    },
    reclaimStaleAbsences: async (candidates) => reclaimStaleAbsences(db, candidates),
    sweepDueAbsences: async (documentIds, opts) =>
      sweepDueAbsences(db, documentIds, { ...opts, deleteDocumentsByIds }),
    acknowledgeAbsenceCascade: async (id, part) => acknowledgeAbsenceCascade(db, id, part),
    deleteAllBySource: async (sourceId) => deleteAllBySource(db, sourceId),
    deleteAllByStream: async (sourceId, streamId) => deleteAllByStream(db, sourceId, streamId),
    deleteAllByProvider: async (providerId) => deleteAllByProvider(db, providerId),
    markSourceStatsDirty: async (sourceId) => markSourceStatsDirty(db, sourceId),
    refreshSourceStatsRow: async (sourceId) => refreshSourceStatsRow(db, sourceId),
    upsertSourceStatsRow: async (sourceId, agg) => upsertSourceStatsRow(db, sourceId, agg),
    beginSyncAttempt: async (sourceId, cursorRow) =>
      beginSyncAttempt(db, sourceId, cursorRow ?? ""),
    promoteSourceWireContract: async (sourceId, version) => {
      promoteSourceWireContract(db, sourceId, version);
    },
    preparePendingSourcePage: async (args) => preparePendingSourcePage(db, args),
    replaceSourceSyncIssues: async (sourceId, deviceId, issues, assessments) =>
      replaceSourceSyncIssues(db, sourceId, deviceId, issues, undefined, assessments),
    acknowledgePendingSourcePage: async (args) => acknowledgePendingSourcePage(db, args),
    revokeSyncAttempt: async (sourceId, expectedEpoch, cursorRow) =>
      revokeSyncAttempt(db, sourceId, expectedEpoch, cursorRow ?? ""),
    resetMemberCursor: async (sourceId, deviceId) => {
      resetMemberCursor(db, sourceId, deviceId);
    },

    setSyncState: async (sourceId, cursor, meta, writeEpoch, deviceId) =>
      setSyncState(db, sourceId, cursor, meta, undefined, false, writeEpoch, deviceId ?? ""),
    setSourceMeta: async (sourceId, meta) => {
      setSourceMeta(db, sourceId, meta);
    },
    upsertWithCursor: async (args, canonicalizers) => {
      const registry = canonicalizerRegistryForWrite(canonicalizers);
      return upsertWithCursor(db, {
        ...args,
        documents: args.documents
          ? prepareDocumentsForWrite(args.documents, registry)
          : args.documents,
      });
    },
    applySourceUrlRecanonicalizationPage: async (cursor, mutations) =>
      writerHandlers["db.applySourceUrlRecanonicalizationPage"](db, cursor, mutations),
    finishSourceUrlRecanonicalization: async (cursor) =>
      writerHandlers["db.finishSourceUrlRecanonicalization"](db, cursor),
    setSyncError: async (sourceId, errorMessage, deviceId, remediation) => {
      setSyncError(db, sourceId, errorMessage, deviceId ?? "", remediation);
    },
    clearSyncError: async (sourceId, deviceId) => {
      clearSyncError(db, sourceId, deviceId);
    },
    recoverReauthReminder: async (principal, deviceId, collapsePrefix, now) =>
      db
        .transaction(() => {
          clearReauthReminder(db, principal, deviceId);
          return supersedeNotificationsByCollapseIdPrefix(db, collapsePrefix, now);
        })
        .immediate(),
    reserveReauthReminder: async (principal, deviceId, now, cfg) =>
      reserveReauthReminder(db, principal, deviceId, now, cfg.reservationTtlMs, (existing) =>
        isReminderDue(existing, now, cfg),
      ),
    releaseReauthReminder: async (token) => releaseReauthReminder(db, token),
    commitReauthReminderNotification: async (token, now, input) =>
      commitReauthReminderNotification(db, token, now, input),
    replaceMobilePermissionHealth: async (input) => replaceOwnedMobilePermissionHealth(db, input),
    reserveMobilePermissionReminder: async (sourceId, now, cfg) =>
      reserveMobilePermissionReminder(db, sourceId, now, cfg),
    releaseMobilePermissionReminder: async (token, episodeId) =>
      releaseMobilePermissionReminder(db, token, episodeId),
    commitMobilePermissionReminderNotification: async (token, episodeId, now, input) =>
      commitMobilePermissionReminderNotification(db, token, episodeId, now, input),

    findOrCreatePerson: async (mention, sourceId, docDate) =>
      findOrCreatePerson(db, mention, sourceId, docDate),
    resolveDocumentPeople: async (docId, people, sourceId, docDate) =>
      resolveDocumentPeople(db, docId, people, sourceId, docDate),
    backfillManyPeople: async (batchSize) => backfillManyPeople(db, batchSize),
    seedFromContacts: async () => seedFromContacts(db),
    upsertSeedFromContacts: async (plan) => upsertSeedFromContacts(db, plan),
    detectSelfFromSourceIds: async (hooks) => detectSelfFromSourceIds(db, hooks),
    bootstrapSelfFromConfig: async (configSelf) => reconcileSelfFromConfig(db, configSelf),
    mergePeople: async (winnerId, loserId) => {
      mergePeople(db, winnerId, loserId);
    },
    runMergePass: async () => runMergePass(db),
    collapseTransitiveChains: async () => collapseTransitiveChains(db),
    upsertTransitiveCollapse: async (rows) => upsertTransitiveCollapse(db, rows),
    rebuildPeopleFromDocuments: async (hooks) => {
      rebuildPeopleFromDocuments(db, hooks);
    },
    refreshPeopleCounts: async () => {
      refreshPeopleCounts(db);
    },
    upsertPeopleCounts: async (rows) => upsertPeopleCounts(db, rows),
    advancePeopleCountsWatermark: async (capturedVersion) => {
      advanceOccWatermark(db, { job: "people_counts", capturedVersion });
    },
    zeroPeopleCountsForLosers: async () => zeroPeopleCountsForLosers(db),
    recomputeNamePrimaries: async () => recomputeNamePrimaries(db),
    upsertInteractionScores: async (snapshot) => upsertInteractionScores(db, snapshot),
    markPeopleGraphDirty: async () => {
      markPeopleGraphDirty(db);
    },
    createMergeRule: async (input) => createMergeRule(db, input),
    deleteMergeRule: async (ruleId) => deleteMergeRule(db, ruleId),
    deleteMergeRuleGroup: async (groupId) => deleteMergeRuleGroup(db, groupId),
    upsertAutoDetectedRules: async (candidates) => upsertAutoDetectedRules(db, candidates),
    upsertMergeEquivalences: async (snapshot) => upsertMergeEquivalences(db, snapshot),
    unmergePerson: async (personId) => {
      unmergePerson(db, personId);
    },
    physicalDedupSharedAliases: async () => {
      // Direct-handle path: no token, so the dedup runs to completion in one
      // call. Return just the counts (drop the yield-continuation fields).
      const r = physicalDedupSharedAliases(db);
      return { clustersProcessed: r.clustersProcessed, peopleMerged: r.peopleMerged };
    },
    pruneNoreplyAliases: async () => pruneNoreplyAliases(db),
    upgradePlaceholderCanonicalNames: async () => upgradePlaceholderCanonicalNames(db),
    demoteSharedAddresses: async (nameThreshold, maxEmails) =>
      demoteSharedAddresses(db, nameThreshold, maxEmails),
    upsertMergeCandidates: async (proposals) => upsertMergeCandidates(db, proposals),
    acceptMergeCandidate: async (input) => acceptMergeCandidate(db, input),
    denyMergeCandidate: async (candidateId) => denyMergeCandidate(db, candidateId),
    sweepCollapsedMergeCandidates: async () => sweepCollapsedMergeCandidates(db),
    pruneSuppressedMergeCandidates: async () => pruneSuppressedMergeCandidates(db),
    autoApproveHighConfidenceCandidates: async () => autoApproveHighConfidenceCandidates(db),
    applyMergeAdjudication: async (input) => applyMergeAdjudication(db, input),
    reconcilePendingMergeCandidates: async (proposals) =>
      reconcilePendingMergeCandidates(db, proposals),
    upsertTokenLabels: async (rows) => upsertTokenLabels(db, rows),
    mergeCluster: async (personIds, opts) => mergeCluster(db, personIds, opts ?? {}),

    reconcileUnresolvedLinks: async (limit) => reconcileUnresolvedLinks(db, limit),
    beginLinkDeclarationUpdate: async () => beginLinkDeclarationUpdate(db),
    finishLinkDeclarationUpdate: async () => finishLinkDeclarationUpdate(db),
    upsertLinkResolutions: async (batch) => upsertLinkResolutions(db, batch),
    applyExtractedDates: async (entries) => applyExtractedDatesToDb(db, entries),
    drainPendingEdges: async (limit) => drainPendingEdges(db, { limit }),
    upsertExtractedLinksBatch: async (rows) => upsertExtractedLinksBatch(db, rows),
    markLinkStatsDirty: async () => {
      markLinkStatsDirty(db);
    },
    upsertLinkStats: async (agg) => upsertLinkStats(db, agg),
    reconcileLinkStatsCounters: async () => reconcileLinkStatsCounters(db),

    refreshSqliteTableStats: async () => {
      refreshSqliteTableStats(db);
    },

    registerOAuthClient: async (input) => registerOAuthClient(db, input),
    upsertOAuthMetadataClient: async (input) => upsertOAuthMetadataClient(db, input),
    createExecutionBinding: async (input) => createExecutionBinding(db, input),
    createAuthorizationRequest: async (input) => createAuthorizationRequest(db, input),
    enqueueAccessAuthorizationNotification: async (requestId, deviceIds) =>
      enqueueAccessAuthorizationNotification(db, requestId, deviceIds, Date.now()),
    decideAuthorizationRequest: async (input) => decideAuthorizationRequest(db, input),
    issueAuthorizationCode: async (browserHandle) => issueAuthorizationCode(db, browserHandle),
    issueAuthorizationCodeById: async (requestId) => issueAuthorizationCodeById(db, requestId),
    exchangeOAuthToken: async (input) => exchangeOAuthToken(db, input),
    reissueExecutionDeviceTokens: async (input) => reissueExecutionDeviceTokens(db, input),
    updateAccessGrant: async (input) => updateAccessGrant(db, input),
    createAccessLevel: async (input) => createAccessLevel(db, input),
    updateAccessLevel: async (input) => updateAccessLevel(db, input),
    deleteAccessLevel: async (input) => deleteAccessLevel(db, input),
    setAccessConnectionLevel: async (input) => setConnectionLevel(db, input),
    setAccessDeviceLevel: async (input) => setDeviceLevel(db, input),
    renameAccessPrincipal: async (input) => renameAccessPrincipal(db, input),
    revokeAccessEntity: async (input) => revokeAccessEntity(db, input),
    recordMcpToolInvocationAudit: async (input) => recordMcpToolInvocationAudit(db, input),
    touchPrincipalCredentialUsageBatch: async (rows) => {
      touchPrincipalCredentialUsageBatch(db, rows);
    },
    cleanupExpiredAccessStateBatch: async (phase, now, limit, cursor) =>
      cleanupExpiredAccessStateBatch(db, phase, now, limit, cursor),

    createDevice: async (opts) => createDevice(db, opts),
    createOrAdoptDevice: async (input) => createOrAdoptDevice(db, input),
    deleteDevice: async (id) => forgetDeviceWithPermissionInvalidation(db, id),
    revokeDevice: async (id, pairingFence, expectedImpactFingerprint) =>
      withPairingGenerationFence(db, pairingFence, () =>
        revokeDeviceWithPermissionInvalidation(db, id, Date.now(), expectedImpactFingerprint),
      ),
    renameDevice: async (id, name) => renameDevice(db, id, name),
    replaceDeviceForRepair: async (oldId, opts) => replaceDeviceForRepair(db, oldId, opts),
    updateDeviceCapabilities: async (id, caps, protocolVersion) => {
      return updateDeviceCapabilities(db, id, caps, protocolVersion);
    },
    setDeviceUpdateRequest: async (id, request) => setDeviceUpdateRequest(db, id, request),
    beginDeviceDoctorRun: async (input) => beginDeviceDoctorRun(db, input),
    startDeviceDoctorRun: async (input) => startDeviceDoctorRun(db, input),
    requeueDeviceDoctorRun: async (input) => requeueDeviceDoctorRun(db, input),
    failDeviceDoctorRun: async (input) => failDeviceDoctorRun(db, input),
    completeDeviceDoctorRun: async (input) => completeDeviceDoctorRun(db, input),
    updateDeviceSelfInfo: async (id, patch) => {
      updateDeviceSelfInfo(db, id, patch);
    },
    setDeviceNotificationDeliveryHealth: async (id, status, updatedAt) => {
      setNotificationDeliveryHealth(db, id, status, updatedAt);
    },
    setDeviceApnsToken: async (id, registration) => {
      setApnsToken(db, id, registration);
    },
    clearDeviceApnsToken: async (id, expected) => {
      return clearApnsToken(db, id, expected);
    },
    setDeviceFcmToken: async (id, registration) => {
      setFcmToken(db, id, registration);
    },
    clearDeviceFcmToken: async (id, expected) => {
      return clearFcmToken(db, id, expected);
    },
    setDeviceRelayPushConsent: async (id, consent) => setRelayPushConsent(db, id, consent),
    withdrawDeviceRelayPushConsent: async (id) => withdrawRelayPushConsent(db, id),
    setDeviceRelayPushRegistration: async (id, registration) => {
      return setRelayPushRegistration(db, id, registration);
    },
    enqueueNotification: async (input) => enqueueNotification(db, input),
    leaseNotificationWakes: async (input) => leaseNotificationWakes(db, input),
    settleNotificationWake: async (input) => settleNotificationWake(db, input),
    claimNotification: async (input) => claimNotification(db, input),
    confirmNotification: async (input) => confirmNotification(db, input),
    cleanupExpiredNotifications: async (now) => cleanupExpiredNotifications(db, now),
    bootstrapSelfFromDevices: async () => bootstrapSelfFromDevices(db),
    touchDevice: async (id) => {
      touchDevice(db, id);
    },
    createPairing: async (opts) => createPairing(db, opts),
    consumePairing: async (pairingCode, expectedKind) =>
      consumePairing(db, pairingCode, expectedKind),
    redeemDevicePairing: async (input) => redeemDevicePairing(db, input),
    revokePairing: async (pairingCode) => revokePairing(db, pairingCode),
    redeemAgentIntegrationPairing: async (input) => redeemAgentIntegrationPairing(db, input),
    cleanupExpiredPairings: async () => cleanupExpiredPairings(db),

    createToken: async (deviceId, scopes, name, opts) =>
      createToken(db, deviceId, scopes, name ?? null, opts),
    validateToken: async (rawToken) => validateToken(db, rawToken),
    touchTokenUsage: async (tokenId, deviceId) => {
      touchTokenUsage(db, tokenId, deviceId);
    },
    touchTokenUsageBatch: async (rows) => {
      // Direct (test-mode) gate: no preempt token, so the function
      // commits every row in turn and returns. Yield outcome is
      // structurally impossible here. We ignore the return value to
      // match the void-returning gate interface.
      touchTokenUsageBatch(db, rows);
    },
    reconcileDeviceTokenScopes: async (tokenId, kind) =>
      reconcileDeviceTokenScopes(db, tokenId, kind),
    revokeToken: async (id) => revokeToken(db, id),
    ensureBootstrapToken: async (configDir) => ensureBootstrapToken(db, configDir),
    createSession: async (tokenId, scopes, expiresInMs) =>
      createSession(db, tokenId, scopes, expiresInMs),
    refreshSessionActivity: async (sessionId, sessionTtlMs, throttleMs) =>
      refreshSessionActivity(db, sessionId, sessionTtlMs, throttleMs),
    validateSession: async (sessionId) => validateSession(db, sessionId),
    purgeExpiredSession: async (sessionId) => {
      purgeExpiredSession(db, sessionId);
    },
    deleteSession: async (sessionId) => {
      deleteSession(db, sessionId);
    },
    cleanupExpiredSessions: async () => cleanupExpiredSessions(db),
    cleanupExpiredTokens: async () => cleanupExpiredTokens(db),
    pruneActivityRetentionBatch: async (phase, cutoff, limit) =>
      pruneActivityRetentionBatch(db, phase, cutoff, limit),
    reclaimActivityRetentionPages: async (maxPages) => reclaimActivityRetentionPages(db, maxPages),

    createSource: async (opts) =>
      withPairingGenerationFence(db, opts.pairingFence, () =>
        createSourceWithPermissionInvalidation(db, opts),
      ),
    createSourceWithId: async (id, opts) =>
      withPairingGenerationFence(db, opts.pairingFence, () => createSourceWithId(db, id, opts)),
    updateSource: async (id, patch) => updateSourceWithPermissionInvalidation(db, id, patch),
    moveSource: async (id, patch) =>
      withPairingGenerationFence(db, patch.pairingFence, () =>
        moveSourceWithPermissionInvalidation(db, id, patch),
      ),
    addSourceMember: async (
      id,
      deviceId,
      configOverride,
      memberScopedParams,
      pairingFence,
      allowDetachedRejoin,
    ) =>
      withPairingGenerationFence(db, pairingFence, () =>
        addSourceMember(
          db,
          id,
          deviceId,
          undefined,
          configOverride,
          memberScopedParams,
          allowDetachedRejoin,
        ),
      ),
    updateSourceForMember: async (
      id,
      deviceId,
      patch,
      configOverride,
      memberScopedParams,
      pairingFence,
    ) =>
      withPairingGenerationFence(db, pairingFence, () =>
        updateSourceForMember(db, id, deviceId, patch, configOverride, memberScopedParams),
      ),
    updateSourceMemberConfigOverride: async (
      id,
      deviceId,
      configOverride,
      memberScopedParams,
      pairingFence,
    ) =>
      withPairingGenerationFence(db, pairingFence, () =>
        updateExistingSourceMemberConfigOverride(
          db,
          id,
          deviceId,
          configOverride,
          memberScopedParams,
        ),
      ),
    removeSourceMember: async (id, deviceId, pairingFence) =>
      withPairingGenerationFence(db, pairingFence, () =>
        removeSourceMemberWithPermissionInvalidation(db, id, deviceId),
      ),
    prepareSourceModeTransition: async (
      id,
      toMode,
      expectedOwnerDeviceId,
      memberScopedParams,
      replicaVersionPolicy,
      pairingFence,
    ) =>
      withPairingGenerationFence(db, pairingFence, () =>
        prepareSourceModeTransition(
          db,
          id,
          toMode,
          expectedOwnerDeviceId,
          undefined,
          memberScopedParams,
          replicaVersionPolicy,
        ),
      ),
    adoptSourceModeTransitionBatch: async (id) => adoptSourceModeTransitionBatch(db, id),
    finalizeSourceModeTransition: async (id) => finalizeSourceModeTransition(db, id),
    recordSourceModeTransitionFailure: async (id, message) =>
      recordSourceModeTransitionFailure(db, id, message),
    recordSourceModeTransitionPublicationFailure: async (id, message) =>
      recordSourceModeTransitionPublicationFailure(db, id, message),
    completeSourceModeTransitionPublication: async (id) =>
      completeSourceModeTransitionPublication(db, id),
    recordSourceStreamCleanupFailure: async (job, message) =>
      recordSourceStreamCleanupFailure(db, job, message),
    completeSourceStreamCleanup: async (job) => completeSourceStreamCleanup(db, job),
    deleteSource: async (id) => deleteSourceWithPermissionInvalidation(db, id),
    removeSource: async (id, pairingFence) =>
      withPairingGenerationFence(db, pairingFence, () =>
        removeSourceWithPermissionInvalidation(db, id),
      ),
    markSourceRemoved: async (id, opts) => markSourceRemoved(db, id, opts),
    markSourceCleanupDone: async (id) => markSourceCleanupDone(db, id),
    clearSourceRemoved: async (id) => clearSourceRemoved(db, id),
    clearSourceRemovedIfCleanupDone: async (id) => clearSourceRemovedIfCleanupDone(db, id),
    upsertSourceDocumentProfiles: async (entries, publishedAt) =>
      upsertSourceDocumentProfiles(db, entries, publishedAt),

    enqueueCognitionRun: async (input, now) => enqueueCognitionRun(db, input, now),
    claimDueCognitionRuns: async (opts) => claimDueCognitionRuns(db, opts),
    finalizeCognitionRun: async (input) => {
      finalizeCognitionRun(db, input);
    },
    recordSettledCognitionRun: async (input) => {
      recordSettledCognitionRun(db, input);
    },
    pullForwardCognitionRuns: async (entries, activeDerivationStageIds) => {
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
    cancelPendingCognitionRuns: async (dedupeKeys) =>
      cancelPendingCognitionRunsByDedupeKeys(db, dedupeKeys),
    cancelScheduledRunsForLoop: async (loopId) => cancelScheduledRunsForLoop(db, loopId),
    setCognitionEngineState: async (key, value) => {
      setCognitionEngineState(db, key, value);
    },
    addToCognitionEngineCounter: async (key, delta) => {
      addToCognitionEngineCounter(db, key, delta);
    },
    recordCognitionSpend: async (day, mechanism, modelId, usage, opts) => {
      recordCognitionSpend(db, day, mechanism, modelId, usage, opts);
    },
    createOpenLoop: async (input, dependencies, now) =>
      mutateWithConsumptionDependencies(db, dependencies, "loop", input.id, now, () =>
        createOpenLoop(db, input, now),
      ),
    updateOpenLoop: async (id, input, dependencies, now) =>
      mutateWithConsumptionDependencies(db, dependencies, "loop", id, now, () =>
        updateOpenLoop(db, id, input, now),
      ),
    rewriteOpenLoopPeople: async (id, actors, involved) =>
      rewriteOpenLoopPeople(db, id, actors, involved),
    appendOpenLoopLedger: async (loopId, entry, now) =>
      appendOpenLoopLedger(db, loopId, entry, now),
    // The write-gated delete records a consolidation trace (the agent-issued
    // `open_loop_delete` path); the storage default is trace-free.
    deleteOpenLoop: async (id, now) => deleteOpenLoop(db, id, { retire: true, now }),
    createDocAnnotation: async (input, now) => createDocAnnotation(db, input, now, true),
    createDocAnnotationSuperseding: async (input, supersedesId, now) =>
      createDocAnnotationSuperseding(db, input, supersedesId, now, true),
    supersedeDocAnnotationBy: async (id, supersededById, now) =>
      supersedeDocAnnotationBy(db, id, supersededById, now),
    updateDocAnnotation: async (id, patch, now) => updateDocAnnotation(db, id, patch, now),
    deleteDocAnnotation: async (id, now) =>
      retractAnnotationWithDependentRechecks(db, "doc", id, now, () => deleteDocAnnotation(db, id)),
    invalidateAnnotationsForDoc: async (docId, now) => invalidateAnnotationsForDoc(db, docId, now),
    cascadeAnnotationPrivacyDelete: async (deletedDocIds) =>
      cascadeAnnotationPrivacyDelete(db, deletedDocIds),
    invalidateBriefClaimsForDoc: async (docId, now) => invalidateBriefClaimsForDoc(db, docId, now),
    cascadeBriefClaimPrivacyDelete: async (deletedDocIds) =>
      cascadeBriefClaimPrivacyDelete(db, deletedDocIds),
    cascadeOpenLoopPrivacyDelete: async (deletedDocIds) =>
      cascadeOpenLoopPrivacyDeleteWithMirrors(db, deletedDocIds),
    createPersonAnnotation: async (input, now) => createPersonAnnotation(db, input, now),
    createPersonAnnotationSuperseding: async (input, supersedesId, now) =>
      createPersonAnnotationSuperseding(db, input, supersedesId, now),
    supersedePersonAnnotationBy: async (id, supersededById, now) =>
      supersedePersonAnnotationBy(db, id, supersededById, now),
    revisePersonAnnotation: async (id, patch, now) => revisePersonAnnotation(db, id, patch, now),
    retractPersonAnnotation: async (id, now) =>
      retractAnnotationWithDependentRechecks(db, "person", id, now, () =>
        deletePersonAnnotation(db, id),
      ),
    invalidatePersonAnnotationsForDoc: async (docId, now) =>
      invalidatePersonAnnotationsForDoc(db, docId, now),
    cascadePersonAnnotationPrivacyDelete: async (deletedDocIds) =>
      cascadePersonAnnotationPrivacyDelete(db, deletedDocIds),
    markConversationSeen: async (conversationId) => markConversationOpened(db, conversationId),
    recordConversationAgentContent: async (conversationId, now) =>
      recordAgentMessage(db, conversationId, now),
    forgetConversationReadState: async (conversationIds) =>
      forgetConversationReadState(db, conversationIds),
    createDevAnnotation: async (input, now) => createDevAnnotation(db, input, now),
    resolveDevAnnotation: async (id, now, resolvedNote) =>
      resolveDevAnnotation(db, id, now, resolvedNote),
    deleteDevAnnotation: async (id) => deleteDevAnnotation(db, id),
    beginAnswerTask: async (input) => beginAnswerTask(db, input),
    completeAnswerTask: async (input) => completeAnswerTask(db, input),
    failAnswerTask: async (taskId, ownerId, now, failure) =>
      failAnswerTask(db, taskId, ownerId, now, failure),
    resolvePrivacyApproval: async (input) => resolvePrivacyApproval(db, input),
    expirePrivacyApprovals: async (now) => expirePrivacyApprovals(db, now),
    recoverInterruptedAnswerTasks: async (now) => recoverInterruptedAnswerTasks(db, now),
    appendAnswerAuditEvents: async (inputs) => appendAnswerAuditEvents(db, inputs),
    appendDirectAuditEvent: async (input) => {
      const { session, eventId } = appendDirectAuditEvent(db, input);
      return { sessionId: session.id, eventId };
    },
    deleteDirectAuditSession: async (sessionId) => deleteDirectAuditSession(db, null, sessionId),
    recordAnswerEgress: async (input) =>
      recordAnswerEgress(db, input, recordMcpToolInvocationAudit, currentDeviceAnswerOwner),
    deletePrivacyConversation: async (input) => deletePrivacyConversation(db, input),
    commitPrivacyPolicy: async (input) => commitPrivacyPolicy(db, input),
    deletePrivacyPolicyFamily: async (familyId, now) =>
      deletePrivacyPolicyFamily(db, familyId, now),
    renamePrivacyPolicyFamily: async (familyId, name, now) =>
      renamePrivacyPolicyFamily(db, familyId, name, now),
    markPrivacyPolicyMirrorSynced: async (generation, digest) =>
      markPrivacyPolicyMirrorSynced(db, generation, digest),
    claimAnswerCompletionDeliveries: async (input) => claimAnswerCompletionDeliveries(db, input),
    authorizeAnswerCompletionDelivery: async (input) =>
      authorizeAnswerCompletionDelivery(db, input),
    settleAnswerCompletionDelivery: async (input) => settleAnswerCompletionDelivery(db, input),
    createSubscription: async (input) => createSubscription(db, input),
    setSubscriptionStatus: async (input) => setSubscriptionStatus(db, input),
    resolveSubscriptionApproval: async (input) => resolveSubscriptionApproval(db, input),
    recordSubscriptionPrivacyReview: async (input) => recordSubscriptionPrivacyReview(db, input),
    revokeSubscription: async (input) => revokeSubscription(db, input),
    purgeSubscription: async (input) => purgeSubscription(db, input),
    fireSubscription: async (input) => fireSubscription(db, input),
    claimSubscriptionDeliveries: async (input) => claimSubscriptionDeliveries(db, input),
    authorizeSubscriptionDeliveryCommit: async (input) =>
      authorizeSubscriptionDeliveryCommit(db, input),
    settleSubscriptionDelivery: async (input) => settleSubscriptionDelivery(db, input),
    issueSubscriptionFiringAnswerAuthority: async (input) =>
      issueSubscriptionFiringAnswerAuthority(db, input),
    issueSubscriptionFiringOutcomeAuthority: async (input) =>
      issueSubscriptionFiringOutcomeAuthority(db, input),
    recordSubscriptionFiringOutcome: async (input) => recordSubscriptionFiringOutcome(db, input),
    useSubscriptionFiringAnswerAuthority: async (input) =>
      useSubscriptionFiringAnswerAuthority(db, input),
    finalizeSubscriptionFiringAnswerEgress: async (input) =>
      finalizeSubscriptionFiringAnswerEgress(db, input),
    expireSubscriptions: async (now) => expireSubscriptions(db, now),
    reconcileSubscriptionsPolicy: async (policyRevision, reconciledAt) =>
      reconcileSubscriptionsPolicy(db, policyRevision, reconciledAt),
    markDocsBootstrapProcessed: async (docIds, nowIso) =>
      markDocsBootstrapProcessed(db, docIds, nowIso),
    readmitFailedBootstrapDoc: async (docId) => readmitFailedBootstrapDoc(db, docId),
    recordCognitionCoverage: async (deltas, now) => recordCognitionCoverage(db, deltas, now),
    recordSweepTally: async (delta, now) => recordSweepTally(db, delta, now),
    retractOrphanCognitionCoverage: async () => retractOrphanCognitionCoverage(db),
    createTemporalAnnotation: async (input, now) => insertTemporalAnnotation(db, input, now),
    updateTemporalAnnotation: async (id, patch, now) =>
      updateTemporalAnnotation(db, id, patch, now),
    invalidateTemporalAnnotation: async (id, now) => invalidateTemporalAnnotation(db, id, now),
    invalidateTemporalAnnotationsForDoc: async (docId, now) =>
      invalidateTemporalAnnotationsForDoc(db, docId, now),
    markTemporalAnnotationsRefilePresented: async (ids, runId) =>
      markTemporalAnnotationsRefilePresented(db, ids, runId),
    cascadeTemporalAnnotationPrivacyDelete: async (deletedDocIds) =>
      cascadeTemporalAnnotationPrivacyDelete(db, deletedDocIds),
    createBrief: async (input, dependencies, now) =>
      mutateWithConsumptionDependencies(db, dependencies, "brief", input.id, now, () =>
        createBrief(db, input, now),
      ),
    updateBrief: async (id, input, dependencies, now) =>
      mutateWithConsumptionDependencies(db, dependencies, "brief", id, now, () =>
        updateBrief(db, id, input, now),
      ),
    retireBrief: async (id, now) => retireBrief(db, id, now),
    retractBriefsForResolvedLoop: async (loopId, now) =>
      retractBriefsForResolvedLoop(db, loopId, now),
    dismissBrief: async (input, now) => dismissBriefAndEnqueueFeedback(db, input, now),
    markBriefRead: async (id, now) => markBriefRead(db, id, now),
    setBriefThreadConversation: async (id, conversationId, now) =>
      setBriefThreadConversation(db, id, conversationId, now),
    restampBriefThreadConversation: async (id, deadId, conversationId, now) =>
      restampBriefThreadConversation(db, id, deadId, conversationId, now),
    resurfaceDueSnoozedBriefs: async (now) => resurfaceDueSnoozedBriefs(db, now),
    writeCognitionNotes: async (content, opts) => writeCognitionNotes(db, content, opts),
    appendCognitionNotes: async (text, opts) => appendCognitionNotes(db, text, opts),
    editCognitionNotes: async (oldText, newText, opts) =>
      editCognitionNotes(db, oldText, newText, opts),
    wipeCognitionNotes: async (now) => wipeCognitionNotes(db, now),

    upsertConversationCitations: async (sourceDocId, citations) =>
      upsertConversationCitations(db, sourceDocId, citations),

    appendNoteEntry: async (entry, audit) => insertNoteEntry(db, entry, audit),
    updateNoteEntry: async (id, text, now) => updateNoteEntryText(db, id, text, now),
    deleteNoteEntry: async (id) => deleteNoteEntry(db, id),

    appendAgentMessage: async (message) => insertAgentMessage(db, message),

    enqueueNearDupInbox: async (docIds, reason) => enqueueNearDupInbox(db, docIds, reason),
    applyNearDupBatch: async (batch) => stripRemaining(applyNearDupBatch(db, batch)),
    applyNearDupDfFromStaging: async (input) => {
      const result = applyNearDupDfFromStaging(db, input);
      return { rebuilt: result.rebuilt };
    },
    bumpNearDupAlgo: async (config) => bumpNearDupAlgo(db, config),
    nearDupAlgoSweepStep: async (config) => algoSweepStep(db, config),
    nearDupGenerationSweepStep: async (config) => generationSweepStep(db, config),
    markNearDupDfDirty: async () => {
      markNearDupDfDirty(db);
    },
  };
}

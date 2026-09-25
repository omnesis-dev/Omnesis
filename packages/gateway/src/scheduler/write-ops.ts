// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `WriteOps` — Task definitions for every write op against `omnesis.db`.
 *
 * Each entry maps a worker op name (matching the dispatch table in
 * `workers/writer-worker.ts`) to a Task whose Runner is "writer". The
 * Task's `name` IS the worker op name — the WriterTaskRunner forwards
 * it as the `op` field on the {type:"call"} message.
 *
 * Per-task metadata:
 *   - `priority`: default "realtime" (collector ingest path is the
 *     dominant caller). HTTP middleware overrides via `runWithPriority`
 *     for user-driven requests; backfill drips override to "background".
 *   - `latencyBudgetMs`: soft target. Slow-op log fires when exceeded.
 *     Heavier ops (upsertDocuments) get a more generous budget; small
 *     ops (token touches) keep the default 200ms.
 *
 * `writeGateFromScheduler(scheduler)` produces a `WriteGate` whose
 * methods enqueue these tasks. This is the production WriteGate —
 * server.ts and ws.ts consume it transparently.
 */

import { writeGateFromCall, type WriteGate, type WriterCallFn } from "../write-gate.js";
import { rehydrateAnswerStoreError } from "../privacy/store.js";
import { rehydrateSourceModeTransitionPrepareError } from "../data/repositories/SourceModeTransitionRepository.js";
import { TaskExecutionError, type Priority, type Task } from "./types.js";
import type { Scheduler } from "./scheduler.js";
import type { WriterOpName } from "./writer-handlers.js";

interface WriteOpDef {
  /**
   * Worker dispatch name. Identical to Task.name. Typed against the
   * handler-registry union so a misspelling in this array, or a name
   * that doesn't actually have a handler, fails to compile.
   */
  readonly name: WriterOpName;
  /** Default priority before HTTP middleware override. */
  readonly priority: Priority;
  /** Slow-op log threshold in ms. */
  readonly latencyBudgetMs?: number;
}

/** Default write-op latency budget: small writes finish in tens of ms. */
const DEFAULT_BUDGET_MS = 200;

/**
 * Heavy writes that legitimately take longer than the default — the
 * "split me" candidates from issue #199. The hottest (`upsertDocuments`,
 * `upsertWithCursor`, the people rebuild + strong-id dedup, link/near-dup
 * batches) have yieldable variants in `writerYieldableHandlers` that commit
 * in bounded sub-transactions and poll the preempt token; the rest stay
 * coarse and rely on Scheduler-level priority ordering + preemption.
 */
const HEAVY_BUDGET_MS = 500;

const WRITE_OP_DEFS: readonly WriteOpDef[] = [
  // ── db.ts — bulk writes ────────────────────────────────────────────
  { name: "db.upsertDocuments", priority: "realtime", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "db.deleteDocuments", priority: "realtime" },
  // User-initiated single-document privacy delete (#1065) — interactive,
  // so "user" priority like the other user-driven deletes below.
  { name: "db.deleteDocumentForUser", priority: "user" },
  { name: "db.deleteDocumentForRetention", priority: "background" },
  { name: "db.completeDocumentRetention", priority: "background" },
  // The page-embedded marks ride inside `db.upsertWithCursor`; this op serves
  // the standalone reconcile endpoint, which is not on a page's critical path.
  { name: "db.applySnapshotAbsencePlan", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "db.applyReplicaOmissions", priority: "background" },
  // The page-path ledger ops of a replicated analytics page run inside the
  // DuckDB transaction that waits on them, so they share its priority.
  { name: "db.judgeAnalyticsTombstones", priority: "realtime" },
  { name: "db.recordAnalyticsPresence", priority: "realtime" },
  { name: "db.recordAnalyticsRestorerOmissions", priority: "realtime" },
  { name: "db.recordAnalyticsSweepVerdict", priority: "background" },
  { name: "db.reclaimStaleAbsences", priority: "background" },
  { name: "db.sweepDueAbsences", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "db.acknowledgeAbsenceCascade", priority: "background" },
  // Bulk source/provider wipes are O(source-docs) single-transaction cascades
  // that freeze the single writer for their whole duration. They stay "user":
  // every trigger path (remove-source, admin clear-docs) is an authenticated
  // HTTP request whose middleware already sets the "user" per-request priority,
  // which overrides this default at enqueue anyway. The real fix — making the
  // freeze O(chunk) — is to chunk + yield the cascade delete; that was deferred
  // because chunking opens a re-insertion race (a fresh sync re-adds docs
  // between chunk yields) and a crash-durability gap, both of which need their
  // own handling before it's safe.
  { name: "db.deleteAllBySource", priority: "user" },
  { name: "db.deleteAllByStream", priority: "user" },
  { name: "db.deleteAllByProvider", priority: "user" },
  { name: "db.markSourceStatsDirty", priority: "background" },
  { name: "db.refreshSourceStatsRow", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "db.upsertSourceStatsRow", priority: "background" },
  { name: "db.beginSyncAttempt", priority: "realtime" },
  { name: "db.promoteSourceWireContract", priority: "realtime" },
  { name: "db.preparePendingSourcePage", priority: "realtime" },
  { name: "db.acknowledgePendingSourcePage", priority: "realtime" },
  { name: "db.revokeSyncAttempt", priority: "realtime" },
  // A per-device resync: the operator waits on it, like the wipes above.
  { name: "db.resetMemberCursor", priority: "user" },
  { name: "db.setSyncState", priority: "realtime" },
  { name: "db.setSourceMeta", priority: "realtime" },
  // Atomic per-page sync write — bundles up to upsertDocuments +
  // deleteDocuments + snapshot absence marks + setSyncState into one
  // transaction (issue #322). Heavy budget mirrors the
  // upsertDocuments component which dominates the cost.
  { name: "db.upsertWithCursor", priority: "realtime", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "db.setSyncError", priority: "realtime" },
  { name: "db.replaceSourceSyncIssues", priority: "realtime" },
  { name: "db.clearSyncError", priority: "realtime" },
  // Re-auth reminder backoff (#683). Publication is reserve/commit based so
  // failed or concurrent delivery attempts never consume the backoff.
  { name: "db.recoverReauthReminder", priority: "realtime" },
  { name: "db.reserveReauthReminder", priority: "realtime" },
  { name: "db.releaseReauthReminder", priority: "realtime" },
  { name: "notifications.commitReauthReminder", priority: "realtime" },
  { name: "mobilePermission.replace", priority: "realtime" },
  { name: "mobilePermission.reserveReminder", priority: "background" },
  { name: "mobilePermission.releaseReminder", priority: "background" },
  { name: "notifications.commitMobilePermissionReminder", priority: "realtime" },
  // Reader-planned source_url repair. Apply is at most 50 indexed OCC updates;
  // finish is one fingerprint row. Neither parses metadata or runs regexes.
  { name: "db.applySourceUrlRecanonicalizationPage", priority: "background" },
  { name: "db.finishSourceUrlRecanonicalization", priority: "background" },

  // ── people.ts ──────────────────────────────────────────────────────
  { name: "people.findOrCreatePerson", priority: "realtime" },
  { name: "people.resolveDocumentPeople", priority: "background" },
  { name: "people.backfillManyPeople", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "people.seedFromContacts", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  {
    name: "people.upsertSeedFromContacts",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  { name: "people.detectSelfFromSourceIds", priority: "background" },
  { name: "people.bootstrapSelfFromConfig", priority: "background" },
  { name: "people.mergePeople", priority: "background" },
  { name: "people.runMergePass", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  {
    name: "people.collapseTransitiveChains",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  {
    name: "people.upsertTransitiveCollapse",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  {
    name: "people.rebuildPeopleFromDocuments",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  { name: "people.refreshPeopleCounts", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "people.upsertPeopleCounts", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "people.advanceCountsWatermark", priority: "background" },
  { name: "people.zeroPeopleCountsForLosers", priority: "background" },
  {
    name: "people.recomputeNamePrimaries",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  // Writer-side does N UPDATEs across the full people set (skipping
  // unchanged rows via the diff filter), plus a zero-pass for stale
  // rows. At ~50k people the SELECT-for-diff alone takes a few hundred
  // ms even when zero rows actually mutate. 2s budget so the slow-op
  // alarm fires only on pathological cases (lock contention, runaway
  // people graph), not normal steady-state refresh.
  { name: "people.upsertInteractionScores", priority: "background", latencyBudgetMs: 2_000 },
  { name: "people.markPeopleGraphDirty", priority: "background" },
  // Merge rules:
  //   - createMergeRule + deleteMergeRule are user-driven (HTTP POST/DELETE),
  //     small writes; "user" priority so they outpace background backfill.
  //   - upsertAutoDetectedRules + upsertMergeEquivalences are background.
  //     The equivalence apply is the heaviest write — chunked + yieldable.
  { name: "people.createMergeRule", priority: "user" },
  { name: "people.deleteMergeRule", priority: "user" },
  { name: "people.deleteMergeRuleGroup", priority: "user" },
  { name: "people.upsertAutoDetectedRules", priority: "background", latencyBudgetMs: 2_000 },
  { name: "people.upsertMergeEquivalences", priority: "background", latencyBudgetMs: 2_000 },
  { name: "people.unmergePerson", priority: "user" },
  // Startup safety-net pass: scan strong-identifier alias clusters and
  // physical-merge any duplicates that slipped past ingestion. Also
  // available as an on-demand op (no admin endpoint surfaces it yet,
  // but it's wired so a future admin tool can hit it). Usually a no-op.
  { name: "people.physicalDedupSharedAliases", priority: "background", latencyBudgetMs: 5_000 },
  // One-shot boot data fix: prune shared no-reply email aliases and
  // mark affected documents for re-resolution. Single transaction,
  // idempotent — subsequent boots are no-ops.
  { name: "people.pruneNoreplyAliases", priority: "background", latencyBudgetMs: 5_000 },
  // One-shot boot data fix (#583): promote a trusted name alias onto any
  // person whose canonical_name is still a phone/email placeholder. Single
  // transaction, idempotent — subsequent boots are no-ops.
  {
    name: "people.upgradePlaceholderCanonicalNames",
    priority: "background",
    latencyBudgetMs: 5_000,
  },
  // Detect shared-address ("one mailbox, many senders") people by name-alias
  // cardinality, blocklist their email, and delete the bucket. Boot sweep,
  // idempotent — subsequent boots are no-ops once the buckets are gone.
  { name: "people.demoteSharedAddresses", priority: "background", latencyBudgetMs: 5_000 },
  // Fuzzy merge-candidate detection writeback. Same shape as
  // upsertAutoDetectedRules — many small INSERTs/UPDATEs in one
  // transaction, sub-second on 3k people.
  { name: "people.upsertMergeCandidates", priority: "background", latencyBudgetMs: 2_000 },
  // User-driven actions on candidates — small writes, "user" prio.
  { name: "people.acceptMergeCandidate", priority: "user" },
  { name: "people.denyMergeCandidate", priority: "user" },
  // Cluster merge from the grouped candidate card — creates N-1 user rules.
  { name: "people.mergeCluster", priority: "user" },
  // Periodic sweep of collapsed candidates — runs alongside the
  // merge-rules eval task. Background priority since drift cleanup
  // shouldn't compete with user actions.
  { name: "people.sweepCollapsedMergeCandidates", priority: "background", latencyBudgetMs: 1_000 },
  // Prune pending candidates the role-mailbox suppression rule now rejects —
  // runs alongside fuzzy detection to converge pre-existing junk rows.
  { name: "people.pruneSuppressedMergeCandidates", priority: "background", latencyBudgetMs: 1_000 },
  // Auto-approve high-confidence pending candidates as reversible system merge
  // rules — runs after detection so the operator only reviews uncertain ones.
  {
    name: "people.autoApproveHighConfidenceCandidates",
    priority: "background",
    latencyBudgetMs: 5_000,
  },
  // Reconcile pending candidates to the latest detection output (delete rows no
  // longer proposed). Runs after a complete (uncapped) detection pass.
  {
    name: "people.reconcilePendingMergeCandidates",
    priority: "background",
    latencyBudgetMs: 2_000,
  },
  // Apply a background-agent adjudication verdict (merge/distinct/unsure) to a
  // pending candidate — the merge_adjudication run's single write.
  { name: "people.applyMergeAdjudication", priority: "background", latencyBudgetMs: 2_000 },
  // Token identity-label writeback from the classifier task.
  { name: "people.upsertTokenLabels", priority: "background", latencyBudgetMs: 1_000 },

  // ── links.ts ───────────────────────────────────────────────────────
  {
    name: "links.reconcileUnresolvedLinks",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  { name: "links.beginDeclarationUpdate", priority: "realtime" },
  { name: "links.finishDeclarationUpdate", priority: "realtime" },
  { name: "links.upsertLinkResolutions", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  // Date-enrichment apply — small per-doc DELETE+INSERT+flag-stamp over a
  // bounded batch. Background priority so it never starts ahead of user /
  // realtime writes.
  { name: "db.applyExtractedDates", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "edges.drainPending", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  {
    name: "links.upsertExtractedLinksBatch",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  { name: "links.markLinkStatsDirty", priority: "background" },
  { name: "links.upsertLinkStats", priority: "background" },
  { name: "links.reconcileLinkStatsCounters", priority: "background", latencyBudgetMs: 30_000 },

  // ── catalog ────────────────────────────────────────────────────────
  {
    name: "catalog.refreshSqliteTableStats",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },

  // ── access / MCP OAuth ─────────────────────────────────────────────
  { name: "access.oauthClientRegister", priority: "user" },
  { name: "access.oauthMetadataClientUpsert", priority: "user" },
  { name: "access.executionBindingCreate", priority: "user" },
  { name: "access.authorizationCreate", priority: "user" },
  { name: "access.authorizationNotificationEnqueue", priority: "user" },
  { name: "access.authorizationDecide", priority: "user" },
  { name: "access.authorizationIssueCode", priority: "user" },
  { name: "access.authorizationIssueCodeById", priority: "user" },
  { name: "access.tokenExchange", priority: "user" },
  { name: "access.executionTokensReissue", priority: "user" },
  { name: "access.grantUpdate", priority: "user" },
  { name: "access.levelCreate", priority: "user" },
  { name: "access.levelUpdate", priority: "user" },
  { name: "access.levelDelete", priority: "user" },
  { name: "access.connectionLevelSet", priority: "user" },
  { name: "access.deviceLevelSet", priority: "user" },
  { name: "access.principalRename", priority: "user" },
  { name: "access.revoke", priority: "user" },
  { name: "access.mcpInvocationAudit", priority: "user" },
  { name: "access.credentialUsageTouchBatch", priority: "background" },
  { name: "access.cleanupBatch", priority: "background" },

  // ── devices.ts ─────────────────────────────────────────────────────
  { name: "devices.createDevice", priority: "user" },
  { name: "devices.createOrAdoptDevice", priority: "user" },
  { name: "devices.deleteDevice", priority: "user" },
  { name: "devices.revokeDevice", priority: "user" },
  { name: "devices.renameDevice", priority: "user" },
  { name: "devices.replaceDeviceForRepair", priority: "user" },
  { name: "devices.updateDeviceCapabilities", priority: "user" },
  { name: "devices.setUpdateRequest", priority: "user" },
  { name: "devices.doctorRunBegin", priority: "user" },
  { name: "devices.doctorRunStart", priority: "realtime" },
  { name: "devices.doctorRunRequeue", priority: "realtime" },
  { name: "devices.doctorRunFail", priority: "realtime" },
  { name: "devices.doctorRunComplete", priority: "realtime" },
  { name: "devices.updateDeviceSelfInfo", priority: "user" },
  { name: "devices.setNotificationDeliveryHealth", priority: "user" },
  { name: "devices.setApnsToken", priority: "user" },
  { name: "devices.clearApnsToken", priority: "background" },
  { name: "devices.setFcmToken", priority: "user" },
  { name: "devices.clearFcmToken", priority: "background" },
  { name: "devices.setRelayPushConsent", priority: "user" },
  { name: "devices.withdrawRelayPushConsent", priority: "user" },
  { name: "devices.setRelayPushRegistration", priority: "user" },
  { name: "devices.bootstrapSelfFromDevices", priority: "background" },
  { name: "devices.touchDevice", priority: "background" },
  { name: "devices.createPairing", priority: "user" },
  { name: "devices.consumePairing", priority: "user" },
  { name: "devices.redeemDevicePairing", priority: "user" },
  { name: "devices.revokePairing", priority: "user" },
  { name: "devices.redeemAgentIntegrationPairing", priority: "user" },
  { name: "devices.cleanupExpiredPairings", priority: "background" },

  // Notification content is private and every lease transition is atomic on
  // the single writer. Claim/confirm are interactive device requests.
  { name: "notifications.enqueue", priority: "realtime" },
  // Foreground publish also awaits these bounded transitions, but retry ticks
  // can fan them out. Keep them behind interactive claim/confirm work.
  { name: "notifications.leaseWakes", priority: "background" },
  { name: "notifications.settleWake", priority: "background" },
  { name: "notifications.claim", priority: "user" },
  { name: "notifications.confirm", priority: "user" },
  { name: "notifications.cleanupExpired", priority: "background" },

  // ── tokens.ts ──────────────────────────────────────────────────────
  { name: "tokens.createToken", priority: "user" },
  { name: "tokens.validateToken", priority: "user" },
  { name: "tokens.touchTokenUsage", priority: "background" },
  { name: "tokens.touchTokenUsageBatch", priority: "background" },
  { name: "tokens.reconcileDeviceTokenScopes", priority: "user" },
  { name: "tokens.revokeToken", priority: "user" },
  { name: "tokens.ensureBootstrapToken", priority: "user" },
  { name: "tokens.createSession", priority: "user" },
  { name: "tokens.refreshSessionActivity", priority: "background" },
  { name: "tokens.validateSession", priority: "user" },
  { name: "tokens.purgeExpiredSession", priority: "background" },
  { name: "tokens.deleteSession", priority: "user" },
  { name: "tokens.cleanupExpiredSessions", priority: "background" },
  { name: "tokens.cleanupExpiredTokens", priority: "background" },
  // One bounded operational-history DELETE. Returning to the Scheduler after
  // every batch lets queued user/realtime writes jump ahead.
  { name: "activityRetention.pruneBatch", priority: "background" },
  { name: "activityRetention.reclaimPages", priority: "background" },

  // ── sources.ts ─────────────────────────────────────────────────────
  { name: "sources.createSource", priority: "user" },
  { name: "sources.createSourceWithId", priority: "user" },
  { name: "sources.updateSource", priority: "user" },
  { name: "sources.moveSource", priority: "user" },
  { name: "sources.deleteSource", priority: "user" },
  { name: "sources.addMember", priority: "user" },
  { name: "sources.updateForMember", priority: "user" },
  { name: "sources.updateMemberConfig", priority: "user" },
  { name: "sources.removeMember", priority: "user" },
  { name: "sources.prepareModeTransition", priority: "user" },
  { name: "sources.adoptModeTransitionBatch", priority: "background" },
  { name: "sources.finalizeModeTransition", priority: "user" },
  { name: "sources.failModeTransition", priority: "background" },
  { name: "sources.failModeTransitionPublication", priority: "background" },
  { name: "sources.completeModeTransitionPublication", priority: "background" },
  { name: "sources.failStreamCleanup", priority: "background" },
  { name: "sources.completeStreamCleanup", priority: "background" },
  { name: "sources.removeSource", priority: "user" },
  { name: "sources.markSourceRemoved", priority: "user" },
  // Only ever written by the detached post-removal sweep, which is background
  // work by construction.
  { name: "sources.markSourceCleanupDone", priority: "background" },
  { name: "sources.clearSourceRemoved", priority: "user" },
  { name: "sources.clearSourceRemovedIfCleanupDone", priority: "user" },
  // Collector boot push of every source type's document-event profile. One
  // small transaction over a table with one row per installed source type.
  { name: "sources.upsertDocumentProfiles", priority: "realtime" },

  // ── briefs (the Cognition Steward run queue) ───────────────────────────────
  // Agent runs are asynchronous background work that must never contend
  // with ingest or interactive writes.
  { name: "cognition.enqueue", priority: "background" },
  { name: "cognition.claimDue", priority: "background" },
  { name: "cognition.finalize", priority: "background" },
  // An inline run's record is awaited inside the authoring request that
  // produced it (watch compilation), so it shares that request's priority
  // rather than queueing behind the background backlog.
  { name: "cognition.recordSettledRun", priority: "user" },
  { name: "cognition.pullForward", priority: "background" },
  { name: "cognition.cancelPending", priority: "background" },
  { name: "cognition.cancelScheduledForLoop", priority: "background" },
  { name: "cognition.engineStateSet", priority: "background" },
  { name: "cognition.recordCognitionSpend", priority: "background" },
  // Loop/brief/notes mutations issued by the Cognition Steward's tools mid-run —
  // background like the rest: agent runs never contend with ingest.
  { name: "cognition.openLoopCreate", priority: "background" },
  { name: "cognition.openLoopUpdate", priority: "background" },
  { name: "cognition.openLoopRewritePeople", priority: "background" },
  { name: "cognition.openLoopLedgerAppend", priority: "background" },
  { name: "cognition.openLoopDelete", priority: "background" },
  // Retract the loops (and their attached briefs) whose supporting documents
  // were deleted in bulk. Background: it trails a sweep the operator has
  // already been told completed.
  { name: "cognition.openLoopCascade", priority: "background" },
  // Durable doc-annotation ops. The privacy-delete cascade rides a
  // user-initiated document delete, so it takes user priority to complete
  // promptly (derived text may embed the removed content); create/invalidate
  // are ordinary background steward writes.
  { name: "cognition.annotationCreate", priority: "background" },
  { name: "cognition.annotationCreateSuperseding", priority: "background" },
  { name: "cognition.annotationSupersede", priority: "background" },
  { name: "cognition.annotationUpdate", priority: "background" },
  { name: "cognition.annotationDelete", priority: "background" },
  { name: "cognition.annotationInvalidate", priority: "background" },
  { name: "cognition.annotationPrivacyDelete", priority: "user" },
  // Brief-claim evidence-lifecycle ops: content-change invalidation is an
  // ordinary background write like its annotation sibling; the privacy
  // cascade rides a user-initiated document delete (the claim's
  // evidence_quote is the removed content verbatim), so user priority.
  { name: "cognition.briefClaimInvalidate", priority: "background" },
  { name: "cognition.briefClaimPrivacyDelete", priority: "user" },
  // Durable person-annotation ops — the person-keyed sibling of the doc ones.
  // create/revise/retract/invalidate are ordinary background steward writes;
  // privacyDelete rides a user-initiated document delete (user priority).
  { name: "cognition.personAnnotationCreate", priority: "background" },
  { name: "cognition.personAnnotationCreateSuperseding", priority: "background" },
  { name: "cognition.personAnnotationSupersede", priority: "background" },
  { name: "cognition.personAnnotationRevise", priority: "background" },
  { name: "cognition.personAnnotationRetract", priority: "background" },
  { name: "cognition.personAnnotationInvalidate", priority: "background" },
  { name: "cognition.personAnnotationPrivacyDelete", priority: "user" },
  // Developer annotations (OMNESIS_DEV_MODE): operator-authored data-quality
  // notes filed from the portal / app. User priority — they ride the HTTP
  // path and must not wait behind ingest.
  // Conversation read state: which agent conversations hold something the
  // operator has not seen. User priority — one rides the HTTP path when a
  // surface reports a conversation on screen, the other lands at the end of a
  // turn, and both feed a badge the operator is looking at right now.
  { name: "conversationReadState.markSeen", priority: "user" },
  { name: "conversationReadState.agentContentArrived", priority: "user" },
  { name: "conversationReadState.forget", priority: "user" },
  { name: "devAnnotations.create", priority: "user" },
  { name: "devAnnotations.resolve", priority: "user" },
  { name: "devAnnotations.delete", priority: "user" },
  { name: "privacy.answerBegin", priority: "user" },
  { name: "privacy.answersRecover", priority: "background" },
  { name: "privacy.answerComplete", priority: "user" },
  { name: "privacy.answerFail", priority: "user" },
  { name: "privacy.approvalResolve", priority: "user" },
  { name: "privacy.approvalsExpire", priority: "user" },
  { name: "privacy.auditAppend", priority: "user" },
  { name: "privacy.directAuditAppend", priority: "user" },
  { name: "privacy.egressRecord", priority: "user" },
  { name: "privacy.conversationDelete", priority: "user" },
  { name: "privacy.directSessionDelete", priority: "user" },
  { name: "privacy.policyCommit", priority: "user" },
  { name: "privacy.policyMirrorSynced", priority: "user" },
  { name: "privacy.completionsClaim", priority: "background" },
  { name: "privacy.completionAuthorize", priority: "background" },
  { name: "privacy.completionSettle", priority: "background" },
  { name: "subscriptions.create", priority: "user" },
  { name: "subscriptions.setStatus", priority: "user" },
  { name: "subscriptions.resolveApproval", priority: "user" },
  { name: "subscriptions.privacyReviewRecord", priority: "user" },
  { name: "subscriptions.revoke", priority: "user" },
  { name: "subscriptions.purge", priority: "user" },
  { name: "subscriptions.fire", priority: "background" },
  { name: "subscriptions.deliveriesClaim", priority: "background" },
  { name: "subscriptions.deliveryCommitAuthorize", priority: "background" },
  { name: "subscriptions.deliverySettle", priority: "background" },
  { name: "subscriptions.answerAuthorityIssue", priority: "background" },
  { name: "subscriptions.outcomeAuthorityIssue", priority: "background" },
  // A woken agent is waiting on the response: it is holding its run open to
  // say what it did, and queueing that behind a backfill would make reporting
  // look like the thing that hangs.
  { name: "subscriptions.outcomeRecord", priority: "user" },
  { name: "subscriptions.answerAuthorityUse", priority: "user" },
  { name: "subscriptions.answerEgressFinalize", priority: "user" },
  { name: "subscriptions.expire", priority: "background" },
  { name: "subscriptions.reconcilePolicy", priority: "background" },
  { name: "cognition.bootstrapMarkProcessed", priority: "background" },
  { name: "cognition.bootstrapReadmitFailed", priority: "background" },
  { name: "cognition.engineCounterAdd", priority: "background" },
  { name: "cognition.coverageRecord", priority: "background" },
  { name: "cognition.coverageRetractOrphans", priority: "background" },
  { name: "cognition.sweepTallyRecord", priority: "background" },
  { name: "temporalAnnotations.create", priority: "background" },
  { name: "temporalAnnotations.update", priority: "background" },
  { name: "temporalAnnotations.invalidate", priority: "background" },
  // Content-change invalidation — an ordinary background write, like its
  // annotation sibling.
  { name: "temporalAnnotations.invalidateForDoc", priority: "background" },
  { name: "temporalAnnotations.refilePresented", priority: "background" },
  { name: "temporalAnnotations.privacyDelete", priority: "user" },
  { name: "cognition.briefCreate", priority: "background" },
  { name: "cognition.briefUpdate", priority: "background" },
  // The agent withdrawing its own card.
  { name: "cognition.briefRetire", priority: "background" },
  // Loop-resolve cascade: retract a resolved loop's still-actionable briefs.
  { name: "cognition.briefRetractForLoop", priority: "background" },
  { name: "cognition.notesWrite", priority: "background" },
  { name: "cognition.notesAppend", priority: "background" },
  { name: "cognition.notesEdit", priority: "background" },
  // The two user-driven writes in the feature (HTTP POSTs from the feed:
  // the dismiss modal and the per-brief mark-read), so user priority like
  // the trigger CRUD ops: a tap in the app must not wait behind ingest.
  { name: "cognition.briefDismiss", priority: "user" },
  { name: "cognition.briefMarkRead", priority: "user" },
  // Talk-back thread stamps — user priority: both run on the HTTP path
  // of "open the brief's thread", which must not wait behind ingest.
  { name: "cognition.briefSetThread", priority: "user" },
  { name: "cognition.briefRestampThread", priority: "user" },
  // Durable snooze resurface — a background rhythm sweep, not user-driven.
  { name: "cognition.snoozeResurface", priority: "background" },
  // The operator CLI's notes wipe — user priority for the same reason:
  // an operator command must not wait behind ingest.
  { name: "cognition.notesWipe", priority: "user" },

  // ── omnesis-chat ──────────────────────────────────────────────────
  // Citation edges for agent-conversation documents. The write fires
  // from a debounced timer well after the user-visible HTTP response
  // returned, so background priority is correct — letting it preempt
  // realtime sync writes or interactive search-handle traffic would
  // be wrong. Small write (typically <10 rows) so the default budget
  // is fine.
  { name: "omnesisChat.upsertConversationCitations", priority: "background" },

  // ── omnesis-notes ─────────────────────────────────────────────────
  // All three ride user-driven HTTP requests (POST/PATCH/DELETE /notes)
  // with a human waiting on the response, so "user" priority like the
  // other interactive writes (briefDismiss, createMergeRule): a quick
  // capture must not sit behind a bulk backfill. Small single-row
  // writes; the default budget is fine.
  { name: "notes.appendEntry", priority: "user" },
  { name: "notes.updateEntry", priority: "user" },
  { name: "notes.deleteEntry", priority: "user" },

  // Pushed agent-conversation turns (experimental). Small single-row writes;
  // a plugin's live push must not sit behind a bulk backfill.
  { name: "agentMessages.appendMessage", priority: "user" },

  // ── near-dupes ────────────────────────────────────────────────────
  // Inbox enqueue. Dispatched only from `nearDupInboxFlushTask`, which
  // drains the in-memory buffer the event-bus subscriber fills — never
  // from a request handler. Running outside any request ALS scope means
  // this background priority is actually honored: a dispatch from inside
  // the collector's realtime request scope would inherit realtime and park
  // the writer under bulk ingest (the failure mode in #555). The flush
  // coalesces per-doc ids into chunked batches, so this is a handful of
  // background ops per second rather than one realtime op per ingested doc.
  { name: "nearDup.enqueueInbox", priority: "background" },
  // Apply a NearDupApplyBatch — yieldable per-doc commits. Heavy
  // budget because a 25-doc batch with several hundred bucket-row
  // inserts each can run hundreds of ms.
  { name: "nearDup.applyBatch", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  // DF table swap — inserts up to millions of rows into a new generation
  // in yieldable chunks, then publishes it with a single-row pointer move.
  // Heavy budget; the slow-op alarm fires if any single chunk takes
  // > 500ms.
  {
    name: "nearDup.applyDfFromStaging",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  // One-shot algo bump at boot. Idempotent. Inside one transaction so
  // this op can't yield — but the call only runs at boot, never on a
  // hot path.
  { name: "nearDup.bumpAlgo", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  // One pass over the four near-dup tables clearing rows for non-active
  // algo versions. Bounded by `algoSweepChunkSize` per table per call, and
  // skipped for `near_dup_df` when a primary-key seek shows no such rows —
  // proving their absence any other way reads the whole table.
  { name: "nearDup.algoSweepStep", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  // One chunk of a superseded DF generation. A range on the primary key's
  // own prefix, so unlike the stale-algo pass above it costs no table read
  // — which is what lets the tick repeat it enough to keep up with
  // rebuilds.
  {
    name: "nearDup.generationSweepStep",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  { name: "nearDup.markDfDirty", priority: "background" },
];

/** Map from worker op name to Task. Built once at module load. */
export const WriteOps: ReadonlyMap<string, Task<unknown[], unknown>> = (() => {
  const map = new Map<string, Task<unknown[], unknown>>();
  for (const def of WRITE_OP_DEFS) {
    map.set(def.name, {
      name: def.name,
      runner: "writer",
      priority: def.priority,
      latencyBudgetMs: def.latencyBudgetMs ?? DEFAULT_BUDGET_MS,
      async run(): Promise<never> {
        throw new Error(`${def.name} executes on the writer worker, not main`);
      },
    });
  }
  return map;
})();

/**
 * Build a `WriteGate` whose methods enqueue the corresponding `WriteOps[name]`
 * task on the Scheduler. Every typed `WriteGate.fn(args)` becomes
 * `scheduler.enqueue(WriteOps.get(opName), [args])`.
 *
 * Effective priority resolution at enqueue time:
 *   `runWithPriority`-set ALS priority (HTTP middleware) > task default.
 */
export function writeGateFromScheduler(scheduler: Scheduler): WriteGate {
  const call: WriterCallFn = (op, args) => {
    const task = WriteOps.get(op);
    if (!task) {
      return Promise.reject(new Error(`unknown write op: ${op}`));
    }
    // The handler-shape generics are erased at the dispatcher boundary
    // (the worker receives unknown[] and casts back). The compile-time
    // contract on `WriterCallFn` is what keeps caller-args aligned.
    return (scheduler.enqueue(task, args as unknown[]) as Promise<never>).catch(
      (error: unknown) => {
        if (
          op.startsWith("privacy.") &&
          error instanceof TaskExecutionError &&
          error.taskName === op
        ) {
          const storeError = rehydrateAnswerStoreError(error.cause);
          if (storeError) throw storeError;
        }
        if (
          op === "sources.prepareModeTransition" &&
          error instanceof TaskExecutionError &&
          error.taskName === op
        ) {
          const prepareError = rehydrateSourceModeTransitionPrepareError(error.cause);
          if (prepareError) throw prepareError;
        }
        throw error;
      },
    );
  };
  return writeGateFromCall(call);
}

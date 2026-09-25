// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Single source of truth for every compute op the worker can dispatch.
 *
 * Mirror of `writer-handlers.ts` for the read-only io runner. Every
 * handler takes the worker's read-only `db` as its first argument.
 *
 * Consumed by:
 *  - `workers/compute-worker.ts` — spreads this map as its dispatch table
 *  - `compute-ops.ts`            — types `COMPUTE_OP_DEFS[].name` as
 *                                  `IoOpName` so misspellings fail
 *                                  to compile and every Task def matches
 *                                  a real handler
 */

import type Database from "better-sqlite3";
import { readOccMeta } from "../data/occ-materialized.js";
import { collectorRosterSnapshot } from "../collector-declaration-roster.js";
type Db = Database.Database;

// Handlers import from canonical homes, not the
// (`./people.js`, `./links.js`) wrapper shells. `computeAutoMergePairs`,
// `computeTransitiveCollapse`, and `pickMergeWinner` remain own-logic
// in `people.ts` (move out under merge-service-decomposition).
import {
  planAnalyticsSweep,
  type AnalyticsSweepCandidate,
} from "../data/repositories/AnalyticsReplicaClaimRepository.js";
import {
  computePeopleCounts,
  computePeopleCountsChunk,
  searchPeople,
  type PersonBrowseCursor,
  type PersonSortBy,
} from "../data/repositories/PersonRepository.js";
import { assemblePersonLookup } from "../domain/person-lookup.js";
import { likeSearchDocuments } from "../search/like-search.js";
import { computeSeedFromContacts } from "../domain/ContactCardBootstrap.js";
import {
  computeInteractionScores,
  computeInteractionScoresChunk,
  fetchSelfPersonId,
  readInteractionScoresMeta,
} from "../domain/InteractionScoreService.js";
import {
  computeMergeEquivalences,
  fetchMergeEquivalencesData,
  computeAutoDetectedRules,
  fetchAutoDetectData,
  readMergeRulesMeta,
} from "../domain/MergeService.js";
import { resolvePersonId } from "../domain/PeopleResolutionService.js";
import { computeAutoMergePairs, computeTransitiveCollapse, pickMergeWinner } from "../people.js";
import {
  computeEnrichedMergeCandidates,
  explainMergeCandidateVisibility,
  fetchMergeCandidatesData,
  selectTokensNeedingClassification,
  type MergeCandidateClusterCursor,
} from "../merge-candidates.js";
import { computeSourceStatsRow, listDirtyStatsSourceIds } from "../db.js";
import {
  computeSnapshotAbsencePlan,
  listStaleAbsences,
  listPendingAbsenceCascades,
  listDueAbsences,
  type SnapshotAbsencePolicy,
  type SnapshotAbsenceScope,
} from "../data/repositories/AbsenceRepository.js";
import { computeLinkResolutions } from "../domain/LinkGraphService.js";
import {
  computeLinkStats,
  readLinkStatsFromCounters,
} from "../data/repositories/LinkStatsRepository.js";
import { fetchLinksForBatch, resolveExtractedLinks } from "../domain/LinkExtraction.js";
import {
  fetchDateExtractionBatch,
  countPendingDateExtraction,
} from "../enrichment/dates/storage.js";
import {
  fetchNearDupInbox,
  fetchNearDupCandidates,
  fetchNearDupDfData,
} from "../near-dupes/NearDupComputeService.js";
import {
  captureDfOccVersion,
  fetchDfDocChunk,
  nearDupFileLikeDocsSince,
} from "../near-dupes/NearDupDfService.js";
import { readNearDupDfBuiltAt, readNearDupDfMeta } from "../near-dupes/meta.js";
import { readConversationRetentionCandidates } from "../agent/conversation-retention.js";
import { bootstrapCorpusByMonth, countPendingBootstrap } from "../brain/storage/bootstrap.js";
import {
  planSourceUrlRecanonicalization,
  type SourceUrlRecanonicalizationCursor,
} from "../domain/SourceUrlRecanonicalization.js";
import type { ConversationRetentionFile } from "../agent/conversation-retention.js";
import type { ExtractedLinkBatchEntry } from "../domain/LinkExtraction.js";
import type { UrlCanonicalizerSpec } from "@omnesis/core";

export const ioHandlers = {
  // Identity op for runner integration tests — verifies the call/result
  // envelope without any DB access.
  "io.echo": <T>(_db: Db, value: T): T => value,
  "io.collectorRosterSnapshot": (db: Db) => collectorRosterSnapshot(db),
  "io.planSourceUrlRecanonicalization": (
    db: Db,
    specs: readonly UrlCanonicalizerSpec[],
    cursor?: SourceUrlRecanonicalizationCursor,
  ) => planSourceUrlRecanonicalization(db, specs, cursor),
  // Smallest non-trivial read op — proves the handle is usable.
  "io.countDocuments": (db: Db) => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  },
  // The lane's backlog. `corpusTotal` rather than a count of already-scanned
  // documents: the partial indexes on `dates_extracted_at` cover only the
  // IS NULL side, so counting the negation is a full table scan — and on an
  // encrypted corpus, a decrypt of every page of the widest table. The caller
  // subtracts.
  // The corpus month by month, split five ways. A grouped scan of the same
  // population the backlog counts, so it rides the same worker for the same
  // reason: on a real corpus it takes seconds, and on the main handle those
  // seconds are the event loop.
  "io.bootstrapCorpusByMonth": (db: Db, recencyFloor: string, todayIso: string) =>
    bootstrapCorpusByMonth(db, recencyFloor, todayIso),
  "io.bootstrapBacklog": (db: Db, recencyFloor: string) => ({
    remaining: countPendingBootstrap(db, recencyFloor),
    dateScanPending: countPendingDateExtraction(db),
    corpusTotal: (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n,
  }),
  "io.conversationRetentionCandidates": (
    _db: Db,
    files: ConversationRetentionFile[],
    cutoffMs: number,
  ) => readConversationRetentionCandidates(files, cutoffMs),

  // People browse (GET /people). A joined query over people +
  // interaction scores + doc counts that runs ~O(people) and, on the main
  // thread, froze every other request for seconds; here it runs on a read
  // worker at user priority so the event loop stays free.
  "io.browsePeople": (
    db: Db,
    query: string,
    limit: number,
    options: { sortBy?: PersonSortBy; after?: PersonBrowseCursor },
  ) => searchPeople(db, query, limit, options),

  // Person lookup (agent `lookup_people`). The same heavy `searchPeople` join
  // as browse, plus up to ~limit per-candidate follow-ups; on the main thread
  // it froze every request on nearly every agent turn. `experimental` is passed
  // in (computed main-thread) — the worker never reads env.
  "io.lookupPeople": (db: Db, query: string, limit: number, opts: { experimental: boolean }) =>
    assemblePersonLookup(db, query, limit, opts),

  // Enriched merge-candidate list (GET /people/merge-candidates). Scans the
  // whole pending set (≤5000) with union-find clustering + ranking; ran on the
  // main thread. Read-only, serializable output.
  "io.enrichedMergeCandidates": (
    db: Db,
    opts: {
      status: "pending" | "accepted" | "denied";
      limit: number;
      clusterLimit?: number;
      clusterAfter?: MergeCandidateClusterCursor;
      q?: string;
    },
  ) => computeEnrichedMergeCandidates(db, opts),

  // Per-candidate veto verdicts (GET /people/merge-candidates/visibility).
  // Same resolution + gate evaluation as its sibling minus the ranking, and
  // the accepted/denied sets it can be pointed at are never pruned. Read-only,
  // serializable output.
  "io.mergeCandidateVisibility": (db: Db, opts: { status: "pending" | "accepted" | "denied" }) =>
    explainMergeCandidateVisibility(db, opts),

  // Legacy LIKE search (GET /documents/search) — a leading-wildcard
  // `content LIKE '%q%'` full-table scan. Low-traffic legacy path, moved off
  // the main thread for the same reason as its siblings.
  "io.likeSearchDocuments": (
    db: Db,
    args: {
      query: string;
      sourceIds?: string[];
      hiddenSourceIds: string[];
      limit: number;
    },
  ) => likeSearchDocuments(db, args),

  // ── people compute (read halves of compute/upsert splits) ─────────
  "io.peopleCounts": (db: Db) => computePeopleCounts(db),
  "io.peopleCountsChunk": (db: Db, cursor: string | null, batchSize: number) =>
    computePeopleCountsChunk(db, cursor, batchSize),
  "io.mergeCandidates": (db: Db, perStepLimit?: number) => computeAutoMergePairs(db, perStepLimit),
  "io.seedFromContactsPlan": (db: Db) => computeSeedFromContacts(db),
  "io.resolvePairWinner": (db: Db, a: string, b: string) => {
    const ra = resolvePersonId(db, a);
    const rb = resolvePersonId(db, b);
    if (ra === rb) return null;
    return pickMergeWinner(db, ra, rb);
  },
  "io.transitiveCollapse": (db: Db) => computeTransitiveCollapse(db),
  "io.interactionScores": (db: Db, opts?: { halfLifeDays?: number; nowMs?: number }) =>
    computeInteractionScores(db, opts ?? {}),
  "io.interactionScoresMeta": (db: Db) => readInteractionScoresMeta(db),
  "io.peopleCountsMeta": (db: Db) => readOccMeta(db, "people_counts"),
  "io.selfPersonId": (db: Db) => fetchSelfPersonId(db),
  "io.interactionScoresChunk": (db: Db, cursor: string | null, batchSize: number, selfId: string) =>
    computeInteractionScoresChunk(db, cursor, batchSize, selfId),
  "io.mergeEquivalences": (db: Db) => computeMergeEquivalences(db),
  "io.mergeEquivalencesData": (db: Db) => fetchMergeEquivalencesData(db),
  "io.autoDetectedRules": (db: Db) => computeAutoDetectedRules(db),
  "io.autoDetectData": (db: Db) => fetchAutoDetectData(db),
  "io.mergeRulesMeta": (db: Db) => readMergeRulesMeta(db),
  // ── source-stats ───────────────────────────────────────────────────
  "io.dirtyStatsSourceIds": (db: Db) => listDirtyStatsSourceIds(db),
  "io.sourceStatsRow": (db: Db, sourceId: string) => computeSourceStatsRow(db, sourceId),

  // ── links compute (read half of links.upsertLinkResolutions split) ─
  "io.linkResolutions": (
    db: Db,
    limit: number,
    fallbackRepresentationSourcePrefixes: string[],
    referenceOnlySourcePrefixes: string[],
    urlTargetRolesReady: boolean,
    knownUrlPatternSources: string[],
    knownUrlPatternDeclarationReady: boolean,
    expectedCollectorRosterRevision: number,
  ) =>
    computeLinkResolutions(
      db,
      limit,
      fallbackRepresentationSourcePrefixes,
      referenceOnlySourcePrefixes,
      urlTargetRolesReady,
      knownUrlPatternSources,
      knownUrlPatternDeclarationReady,
      expectedCollectorRosterRevision,
    ),
  "io.linkStats": (db: Db) => computeLinkStats(db),
  "io.linkStatsCounters": (db: Db) => readLinkStatsFromCounters(db),

  // ── snapshot absence compute (the off-writer half of the reconcile) ──────
  "io.snapshotAbsencePlan": (
    db: Db,
    providerId: string,
    sourceId: string,
    presentExternalIds: string[],
    policy: SnapshotAbsencePolicy,
    scope?: SnapshotAbsenceScope,
  ) => computeSnapshotAbsencePlan(db, providerId, sourceId, presentExternalIds, policy, scope),
  "io.staleAbsences": (db: Db, limit: number) => listStaleAbsences(db, limit),
  "io.dueAbsences": (db: Db, opts: { dueBefore: number; minObservations: number; limit: number }) =>
    listDueAbsences(db, opts),
  "io.pendingAbsenceCascades": (db: Db, limit: number) => listPendingAbsenceCascades(db, limit),
  "io.planAnalyticsSweep": (db: Db, candidates: AnalyticsSweepCandidate[]) =>
    planAnalyticsSweep(db, candidates),

  // ── near-dupes ─────────────────────────────────────────────────────
  // Cheap PK read on `refresh_meta` for the DF refresh OCC poll.
  "io.nearDupDfMeta": (db: Db) => readNearDupDfMeta(db),
  // Per-algo DF readiness check for the compute drip. Distinct from
  // the global OCC meta above because the algo-sweep wipes the
  // old-algo DF rows but doesn't reset the global watermark.
  "io.nearDupDfBuiltAt": (db: Db, algoVersion: string) => readNearDupDfBuiltAt(db, algoVersion),

  // ── near-dup three-phase pipeline (IO-only fetch ops) ──────────────
  "io.nearDupFetchInbox": (db: Db, batchSize: number, eligibleDocTypes: string[]) =>
    fetchNearDupInbox(db, batchSize, eligibleDocTypes),
  "io.nearDupFetchCandidates": (
    db: Db,
    signedDocs: Array<{ docId: string; bands: number[]; reason: string }>,
    algoVersion: string,
    bandCount: number,
    maxCandidatesPerDoc: number,
  ) => fetchNearDupCandidates(db, signedDocs, algoVersion, bandCount, maxCandidatesPerDoc),
  "io.nearDupFetchDfData": (db: Db, algoVersion: string) => fetchNearDupDfData(db, algoVersion),

  // ── merge-candidates three-phase pipeline (IO-only fetch) ──────────
  "io.fetchMergeCandidatesData": (db: Db) => fetchMergeCandidatesData(db),
  "io.selectTokensNeedingClassification": (db: Db, opts?: { minSpread?: number; limit?: number }) =>
    selectTokensNeedingClassification(db, opts ?? {}),

  // ── link-extraction three-phase pipeline (IO-only fetch) ───────────
  "io.fetchLinksForBatch": (db: Db, batchSize: number) => fetchLinksForBatch(db, batchSize),
  "io.resolveExtractedLinks": (
    db: Db,
    entries: ExtractedLinkBatchEntry[],
    fallbackRepresentationSourcePrefixes: string[],
    referenceOnlySourcePrefixes: string[],
    urlTargetRolesReady: boolean,
    knownUrlPatternSources: string[],
    knownUrlPatternDeclarationReady: boolean,
  ) =>
    resolveExtractedLinks(
      db,
      entries,
      fallbackRepresentationSourcePrefixes,
      referenceOnlySourcePrefixes,
      urlTargetRolesReady,
      knownUrlPatternSources,
      knownUrlPatternDeclarationReady,
    ),

  // ── date-enrichment three-phase pipeline (IO-only fetch) ───────────
  "io.fetchDateExtractionBatch": (db: Db, limit: number, maxChars: number) =>
    fetchDateExtractionBatch(db, limit, maxChars),

  // ── DF snapshot three-phase pipeline (IO-only fetch) ───────────────
  "io.captureDfOccVersion": (db: Db) => captureDfOccVersion(db),
  "io.fetchDfDocChunk": (
    db: Db,
    eligibleDocTypes: string[],
    minContentLength: number,
    maxContentLength: number,
    afterId: string | null,
    limit: number,
  ) =>
    fetchDfDocChunk(
      db,
      new Set(eligibleDocTypes),
      minContentLength,
      maxContentLength,
      afterId,
      limit,
    ),
  "io.nearDupFileLikeDocsSince": (db: Db, builtAtSec: number, fileLikeDocTypes: string[]) =>
    nearDupFileLikeDocsSince(db, builtAtSec, fileLikeDocTypes),
} as const;

export type IoHandlers = typeof ioHandlers;
export type IoOpName = keyof IoHandlers;

export type IoArgs<K extends IoOpName> = IoHandlers[K] extends (db: Db, ...rest: infer A) => unknown
  ? A
  : never;

export type IoReturn<K extends IoOpName> = IoHandlers[K] extends (...args: never) => infer R
  ? R
  : never;

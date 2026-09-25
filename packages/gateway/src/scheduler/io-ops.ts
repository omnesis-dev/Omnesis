// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `IoOps` — Task definitions for read-heavy compute work.
 *
 * Mirror of `write-ops.ts` but for the io runner. Each entry maps
 * a worker op name (matching the dispatch table in
 * `workers/compute-worker.ts`) to a Task whose Runner is "io".
 *
 * `ioGateFromScheduler(scheduler)` returns a typed `IoGate`
 * so callers (the periodic backfill orchestrators) can write
 * `compute.peopleCounts()` instead of constructing the raw enqueue.
 *
 * All compute ops default to `background` priority — they're the read
 * halves of background work like the merge pass. There's no expectation
 * of a higher-priority compute caller; if one ever arrives, override
 * via `runWithPriority`.
 */

import type {
  AutoDetectedRule,
  AutoMergePair,
  InteractionScoresSnapshot,
  MergeEquivalenceSnapshot,
  PeopleCountRow,
  SeedFromContactsPlan,
  TransitiveCollapseRow,
} from "../people.js";
import type {
  PeopleCountsChunkResult,
  PersonBrowseCursor,
  PersonSortBy,
  PersonSummary,
} from "../data/repositories/PersonRepository.js";
import type { InteractionScoresChunkResult } from "../domain/InteractionScoreService.js";
import type { AnalyticsSweepCandidate, AnalyticsSweepPlan, SourceStatsAggregation } from "../db.js";
import type {
  DueAbsence,
  AbsenceCascade,
  SnapshotAbsencePlan,
  SnapshotAbsencePolicy,
  SnapshotAbsenceScope,
  StaleAbsenceCandidate,
} from "../data/repositories/AbsenceRepository.js";
import type { LinkReconcileBatch, LinkStatsAggregation } from "../links.js";
import type { LinkStats } from "../data/repositories/LinkStatsRepository.js";
import type { Scheduler } from "./scheduler.js";
import type { Priority, Task } from "./types.js";
import type { IoOpName } from "./io-handlers.js";
import type { ResolvedNearDupConfig } from "../near-dupes/config.js";
import type {
  NearDupFetchResult,
  NearDupCandidateFetchResult,
} from "../near-dupes/NearDupComputeService.js";
import type { MergeCandidatesFetchData } from "../merge-candidates-cpu.js";
import type {
  EnrichedMergeCandidatesResult,
  MergeCandidateClusterCursor,
  MergeCandidateVisibility,
  TokenClassificationCandidate,
} from "../merge-candidates.js";
import type { LinkExtractionDocRow } from "../domain/LinkExtraction-cpu.js";
import type { ExtractedLinkBatchEntry } from "../domain/LinkExtraction.js";
import type { DateExtractionDocRow } from "../enrichment/dates/extractor.js";
import type { LikeSearchArgs, LikeSearchRow } from "../search/like-search.js";
import type { PersonSummary as LookupPersonSummary, UrlCanonicalizerSpec } from "@omnesis/core";
import type {
  ConversationRetentionCandidate,
  ConversationRetentionFile,
} from "../agent/conversation-retention.js";
import type { CollectorRosterSnapshot } from "../collector-declaration-roster.js";
import type {
  SourceUrlRecanonicalizationCursor,
  SourceUrlRecanonicalizationPlan,
} from "../domain/SourceUrlRecanonicalization.js";

export interface IoGate {
  /** Sanity ping for tests. */
  echo<T>(value: T): Promise<T>;
  /** Single-row aggregate over `documents`. */
  countDocuments(): Promise<number>;
  /** Authoritative roster plus its monotone writer-side OCC revision. */
  collectorRosterSnapshot(): Promise<CollectorRosterSnapshot>;
  planSourceUrlRecanonicalization(
    specs: readonly UrlCanonicalizerSpec[],
    cursor?: SourceUrlRecanonicalizationCursor,
  ): Promise<SourceUrlRecanonicalizationPlan>;
  /**
   * The corpus month by month, split into what the lane has made of each
   * document. The hero picture of where the Brain stands — and a full grouped
   * scan, so it lives out here beside the backlog count.
   */
  bootstrapCorpusByMonth(
    recencyFloor: string,
    todayIso: string,
  ): Promise<
    Array<{
      month: string;
      unscanned: number;
      discarded: number;
      owed: number;
      reviewed: number;
      failed: number;
    }>
  >;
  /**
   * The retrospective lane's backlog, plus the date-scan progress that
   * qualifies it. On the io worker because the count is a scan of the
   * unprocessed half of `documents` with a correlated subquery per surviving
   * row — seconds on a real corpus, which on the main handle would freeze the
   * event loop, and with it the very lane the caller is observing.
   */
  bootstrapBacklog(recencyFloor: string): Promise<{
    remaining: number;
    dateScanPending: number;
    corpusTotal: number;
  }>;
  /** Parse a bounded transcript-file batch off the main event loop. */
  conversationRetentionCandidates(
    files: readonly ConversationRetentionFile[],
    cutoffMs: number,
  ): Promise<ConversationRetentionCandidate[]>;
  /**
   * Browse people for GET /people. A joined, ~O(people) read that on the
   * main thread froze every request for seconds; run it on a read worker at
   * user priority instead.
   */
  browsePeople(
    query: string,
    limit: number,
    options: { sortBy?: PersonSortBy; after?: PersonBrowseCursor },
  ): Promise<PersonSummary[]>;
  /**
   * Person lookup for the agent's `lookup_people` tool. The same heavy join as
   * browse plus up to ~limit per-candidate follow-ups; it fires on nearly every
   * agent turn (the system prompt mandates it before `search_documents`), so it
   * runs at user priority off the main event loop. `experimental` is a
   * main-thread env read computed by the caller and passed in — never read
   * inside the worker.
   */
  lookupPeople(
    query: string,
    limit: number,
    opts: { experimental: boolean },
  ): Promise<LookupPersonSummary[]>;
  /**
   * Enriched merge-candidate list for GET /people/merge-candidates. Scans the
   * whole pending set (≤5000) with union-find clustering + ranking. Read-only.
   */
  enrichedMergeCandidates(opts: {
    status: "pending" | "accepted" | "denied";
    limit: number;
    clusterLimit?: number;
    clusterAfter?: MergeCandidateClusterCursor;
    q?: string;
  }): Promise<EnrichedMergeCandidatesResult>;
  /**
   * Per-candidate veto verdicts for GET /people/merge-candidates/visibility.
   * Same per-side resolution and gate evaluation as the enriched list, minus
   * the ranking — and unlike pending, the accepted/denied sets are never
   * pruned, so this scan grows for the life of the install. Read-only.
   */
  mergeCandidateVisibility(opts: {
    status: "pending" | "accepted" | "denied";
  }): Promise<MergeCandidateVisibility[]>;
  /**
   * Legacy `content LIKE '%q%'` document search (GET /documents/search) — an
   * unindexed leading-wildcard full-table scan. Low-traffic legacy path.
   */
  likeSearchDocuments(args: LikeSearchArgs): Promise<LikeSearchRow[]>;
  /**
   * Compute `(personId, docCount, aliasCount)` for every unmerged person in
   * one read. Heavy — a full scan of `document_people` — which is why it
   * runs out here rather than on the writer thread.
   */
  peopleCounts(): Promise<PeopleCountRow[]>;
  /** Cursor-paginated variant, for the sweep-accumulate refresh. */
  peopleCountsChunk(cursor: string | null, batchSize: number): Promise<PeopleCountsChunkResult>;
  /**
   * Pick up to `perStepLimit` candidate pairs for merging. Two LIMIT 50
   * SELECTs over multi-million-row joins. Read-only.
   */
  mergeCandidates(perStepLimit?: number): Promise<AutoMergePair[]>;
  /**
   * Resolve both ids to canonicals and pick the winner. Returns null if
   * the pair already collapses to one canonical (no merge needed).
   */
  resolvePairWinner(a: string, b: string): Promise<{ winner: string; loser: string } | null>;
  /** Source ids whose `source_stats.needs_refresh = 1`. */
  dirtyStatsSourceIds(): Promise<string[]>;
  /**
   * Heavy aggregation for one source: doc count, min/max source_created_at,
   * sum of content/title/metadata sizes. Multi-second on large sources.
   */
  sourceStatsRow(sourceId: string): Promise<SourceStatsAggregation>;
  /**
   * Walk up to `limit` unresolved `document_links` rows past the
   * persisted reconcile cursor and compute the resolution for each on
   * the read handle. Pairs with the writer's `upsertLinkResolutions`,
   * which both applies the resolutions AND advances the cursor (or
   * wraps it to 0 on an empty scan) so the next tick starts from
   * where this one left off.
   */
  linkResolutions(
    limit: number,
    fallbackRepresentationSourcePrefixes: string[],
    referenceOnlySourcePrefixes: string[],
    urlTargetRolesReady: boolean,
    knownUrlPatternSources: string[],
    knownUrlPatternDeclarationReady: boolean,
    expectedCollectorRosterRevision: number,
  ): Promise<LinkReconcileBatch>;
  /**
   * Scan `documentType='contact'` documents and emit a structured plan
   * for the writer's `upsertSeedFromContacts`. Boot-time, single-shot;
   * keeps the full-table scan + per-row JSON.parse off the writer.
   */
  seedFromContactsPlan(): Promise<SeedFromContactsPlan>;
  /**
   * Read half of the snapshot reconcile: diff a source's snapshot against the
   * stored corpus and decide which absences to record, corroborate or revoke,
   * bounded by the policy's mark ceiling. The writer applies the plan verbatim,
   * so it never carries the whole-source diff.
   */
  snapshotAbsencePlan(
    providerId: string,
    sourceId: string,
    presentExternalIds: string[],
    policy: SnapshotAbsencePolicy,
    scope?: SnapshotAbsenceScope,
  ): Promise<SnapshotAbsencePlan>;
  /** Bounded stale-generation candidates selected off the writer. */
  staleAbsences(limit: number): Promise<StaleAbsenceCandidate[]>;
  /**
   * The pending absences whose deadline has passed, oldest first. Driven from
   * the scope table through the live-generation index, so invalidated ledger
   * rows do not turn the sweep into a scan of the corpus.
   */
  dueAbsences(opts: {
    dueBefore: number;
    minObservations: number;
    limit: number;
  }): Promise<DueAbsence[]>;
  /** Durable post-delete cascades not yet acknowledged by every derived store. */
  pendingAbsenceCascades(limit: number): Promise<AbsenceCascade[]>;
  /**
   * What the replica deletion ledger says about a batch of due analytics
   * absences before the sweep acts on them; see `planAnalyticsSweep`.
   */
  planAnalyticsSweep(candidates: readonly AnalyticsSweepCandidate[]): Promise<AnalyticsSweepPlan>;
  /**
   * Walk every `people` row with `merged_into IS NOT NULL`, follow each
   * chain to its root, and return only rows whose direct merged_into
   * needs repointing. Pairs with the writer's
   * `upsertTransitiveCollapse`. Each row carries an
   * `expectedMergedInto` token so the writer can skip rows whose
   * merged_into has shifted under a concurrent merge.
   */
  transitiveCollapse(): Promise<TransitiveCollapseRow[]>;
  /**
   * Snapshot the link graph aggregations on the read handle. Three
   * COUNT(*) scans over `document_links` (978k rows live, ~9.8s);
   * pairs with the writer's `upsertLinkStats`. The returned
   * `capturedVersion` is the OCC token consumed by the upsert — a
   * concurrent `markLinkStatsDirty` during compute makes the upsert
   * no-op so the next refresh tick picks up the change.
   */
  linkStats(): Promise<LinkStatsAggregation>;
  /** Read link stats from trigger-maintained counters (< 1ms). */
  linkStatsCounters(): Promise<LinkStats>;
  /**
   * Snapshot the per-person interaction-score graph on the read
   * handle. Walks `document_people` joined to `documents.source_created_at`
   * and emits one row per non-self person reachable from the self
   * person. Pairs with the writer's `upsertInteractionScores`.
   *
   * The returned snapshot carries `dirtyVersion`, captured before the
   * scan; the writer advances `last_computed_version` to that value
   * after a successful apply so the next periodic tick can tell
   * whether anything has moved.
   */
  interactionScores(opts?: { halfLifeDays?: number }): Promise<InteractionScoresSnapshot>;
  /** Lookup self person ID for the interaction scores sweep. */
  selfPersonId(): Promise<string | null>;
  /** Cursor-paginated edge fetch for the sweep-accumulate pattern. */
  interactionScoresChunk(
    cursor: string | null,
    batchSize: number,
    selfId: string,
  ): Promise<InteractionScoresChunkResult>;
  /**
   * Read the {dirty, last computed, last computed at} triple for the
   * people-counts sweep, so it can skip when the people graph has not moved
   * since the last completed pass.
   */
  peopleCountsMeta(): Promise<{
    dirtyVersion: number;
    lastComputedVersion: number;
    lastComputedAt: number | null;
  }>;
  /**
   * Read the singleton `interaction_scores_meta` row. Cheap enough to
   * call every periodic-task tick — used by the refresh task to
   * decide whether to skip (`dirty_version <= last_computed_version`)
   * or fire a compute pass.
   */
  interactionScoresMeta(): Promise<{
    dirtyVersion: number;
    lastComputedVersion: number;
    lastComputedAt: number | null;
  }>;
  /**
   * Read half of the merge-rules eval pass. Loads active rules,
   * resolves each side's aliases to person ids, runs union-find to
   * compute connected components, picks canonical roots, and emits
   * the (loser → root) equivalences. Pairs with the writer's
   * `people.upsertMergeEquivalences`. Captures the meta dirty version
   * so the writer can advance `last_evaluated_version` post-apply.
   */
  mergeEquivalences(): Promise<MergeEquivalenceSnapshot>;
  /** IO-only phase: fetch rules + aliases + person meta. */
  mergeEquivalencesData(): Promise<import("../domain/merge/types.js").MergeEquivalencesIoData>;
  /**
   * Read half of the auto-detect pass. Scans `person_aliases` +
   * `people` for shared-identifier and contact-name candidates, emits
   * one entry per pair the auto-detector wants to bridge as a
   * `kind='system'` rule. Pairs with `people.upsertAutoDetectedRules`.
   */
  autoDetectedRules(): Promise<AutoDetectedRule[]>;
  /** IO-only phase: fetch shared-alias and contact-name pairs. */
  autoDetectData(): Promise<import("../domain/merge/types.js").AutoDetectIoData>;
  /**
   * Read the singleton `merge_rules_meta` row. Cheap; the eval task
   * polls it every tick to decide whether to skip.
   */
  mergeRulesMeta(): Promise<{
    dirtyVersion: number;
    lastEvaluatedVersion: number;
    lastEvaluatedAt: number | null;
  }>;
  /**
   * Read the OCC meta for the DF refresh job (cheap PK read on
   * `refresh_meta`). The periodic DF refresh task polls this each tick.
   */
  nearDupDfMeta(): Promise<{
    dirtyVersion: number;
    lastAppliedVersion: number;
    lastAppliedAt: number | null;
  }>;
  /**
   * Per-algo DF readiness check used by the compute drip. Returns the
   * `built_at` of the active algo's DF, or null if the table hasn't
   * been built for this algo yet (drip should park).
   */
  nearDupDfBuiltAt(algoVersion: string): Promise<number | null>;
  nearDupFetchInbox(batchSize: number, eligibleDocTypes: string[]): Promise<NearDupFetchResult>;
  nearDupFetchCandidates(
    signedDocs: Array<{ docId: string; bands: number[]; reason: string }>,
    algoVersion: string,
    bandCount: number,
    maxCandidatesPerDoc: number,
  ): Promise<NearDupCandidateFetchResult>;
  nearDupFetchDfData(algoVersion: string): Promise<SharedArrayBuffer>;
  fetchMergeCandidatesData(): Promise<MergeCandidatesFetchData>;
  selectTokensNeedingClassification(opts?: {
    minSpread?: number;
    limit?: number;
  }): Promise<TokenClassificationCandidate[]>;
  fetchLinksForBatch(batchSize: number): Promise<LinkExtractionDocRow[]>;
  /**
   * Middle phase of link extraction: give every extracted link its target.
   * One indexed lookup per link, so it runs out here rather than in the
   * writer's transaction. Pairs with the writer's
   * `upsertExtractedLinksBatch`, which applies what this found.
   */
  resolveExtractedLinks(
    entries: ExtractedLinkBatchEntry[],
    fallbackRepresentationSourcePrefixes: string[],
    referenceOnlySourcePrefixes: string[],
    urlTargetRolesReady: boolean,
    knownUrlPatternSources: string[],
    knownUrlPatternDeclarationReady: boolean,
  ): Promise<import("../domain/LinkExtraction.js").ExtractedLinkResolution[]>;
  /**
   * Fetch up to `limit` documents still needing date extraction, with content
   * truncated to `maxChars`. The read half of the date-enrichment split.
   */
  fetchDateExtractionBatch(limit: number, maxChars: number): Promise<DateExtractionDocRow[]>;
  captureDfOccVersion(): Promise<number>;
  fetchDfDocChunk(
    eligibleDocTypes: string[],
    minContentLength: number,
    maxContentLength: number,
    afterId: string | null,
    limit: number,
  ): Promise<Array<{ id: string; content: string }>>;
  /** Whether any file-like document arrived since the DF table was built. */
  nearDupFileLikeDocsSince(builtAtSec: number, fileLikeDocTypes: string[]): Promise<boolean>;
}

interface IoOpDef {
  /**
   * Worker dispatch name. Typed against the handler-registry union so a
   * misspelling in this array, or a name that doesn't actually have a
   * handler, fails to compile.
   */
  readonly name: IoOpName;
  readonly priority: Priority;
  readonly latencyBudgetMs?: number;
}

const DEFAULT_BUDGET_MS = 200;
const HEAVY_BUDGET_MS = 2_000;

const COMPUTE_OP_DEFS: readonly IoOpDef[] = [
  { name: "io.echo", priority: "background" },
  { name: "io.collectorRosterSnapshot", priority: "background" },
  { name: "io.planSourceUrlRecanonicalization", priority: "background" },
  { name: "io.countDocuments", priority: "background" },
  // Heavy budget: this one is a corpus scan by nature, so the slow-op alarm
  // should fire on a genuine outlier rather than on every call.
  { name: "io.bootstrapBacklog", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  {
    name: "io.bootstrapCorpusByMonth",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  { name: "io.conversationRetentionCandidates", priority: "background" },
  { name: "io.browsePeople", priority: "user" },
  // The three interactive reads moved off the main event loop — user priority
  // (preempts background compute), heavy budget so the slow-op alarm only fires
  // on a genuine outlier.
  { name: "io.lookupPeople", priority: "user", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.enrichedMergeCandidates", priority: "user", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.mergeCandidateVisibility", priority: "user", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.likeSearchDocuments", priority: "user", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.peopleCounts", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.peopleCountsChunk", priority: "background" },
  { name: "io.mergeCandidates", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.resolvePairWinner", priority: "background" },
  { name: "io.dirtyStatsSourceIds", priority: "background" },
  { name: "io.sourceStatsRow", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.linkResolutions", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  {
    name: "io.seedFromContactsPlan",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  { name: "io.snapshotAbsencePlan", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.staleAbsences", priority: "background" },
  { name: "io.dueAbsences", priority: "background", latencyBudgetMs: DEFAULT_BUDGET_MS },
  { name: "io.pendingAbsenceCascades", priority: "background" },
  { name: "io.planAnalyticsSweep", priority: "background" },
  { name: "io.transitiveCollapse", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  // 5s budget — outlier docs (Notion pages, browser-history daily
  // summaries) can spend multi-second time in the regex even on the
  // read handle. The whole point of moving it off the writer is that
  // the budget overrun no longer parks user-priority writes.
  // 3s budget — three COUNT(*) scans over a 978k-row table run ~9.8s
  // on the live DB. The compute pass takes the hit on the read
  // handle; the slow-op log fires past 3s, well before that worst
  // case, so we're alerted if the table grows further.
  { name: "io.linkStats", priority: "background", latencyBudgetMs: 3_000 },
  { name: "io.linkStatsCounters", priority: "background" },
  // 5s budget — one full scan over `document_people` joined to
  // `documents.source_created_at`. On a 440k-edge graph the join
  // typically lands sub-second; bumped to 5s so we get an alert
  // before it ever creeps into "slow" territory at scale.
  { name: "io.interactionScores", priority: "background", latencyBudgetMs: 5_000 },
  { name: "io.interactionScoresMeta", priority: "background" },
  { name: "io.peopleCountsMeta", priority: "background" },
  { name: "io.selfPersonId", priority: "background" },
  { name: "io.interactionScoresChunk", priority: "background" },
  // 5s budget — at thousands of rules + thousands of matched people
  // the union-find pass is well under a second on the live DB. Budget
  // gives headroom before the slow-op alarm fires.
  { name: "io.mergeEquivalences", priority: "background", latencyBudgetMs: 5_000 },
  { name: "io.mergeEquivalencesData", priority: "background", latencyBudgetMs: 5_000 },
  // 3s — full alias join scanning the entire person_aliases table.
  // Comparable to compute.peopleCounts.
  { name: "io.autoDetectedRules", priority: "background", latencyBudgetMs: 3_000 },
  { name: "io.autoDetectData", priority: "background", latencyBudgetMs: 3_000 },
  { name: "io.mergeRulesMeta", priority: "background" },
  // Fuzzy detector — full alias scan, IDF build, inverted-index
  // pair-find with substring-shadow expansion. ~hundreds of ms on 3k
  // people; bumped to 5s headroom.
  // Near-dup compute: drains inbox, signs each doc, runs LSH lookup +
  // verify-and-gate. Each batch handles up to 25 docs (configurable).
  // Full DF rebuild — corpus-wide shingle scan. On 1 M docs the scan
  // takes minutes; the 30s budget is the slow-op alarm, not a hard
  // cap. The pass runs on the read handle so an overrun doesn't park
  // realtime writes.
  { name: "io.nearDupDfMeta", priority: "background" },
  { name: "io.nearDupDfBuiltAt", priority: "background" },
  // Three-phase pipeline IO-only fetch ops
  { name: "io.nearDupFetchInbox", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.nearDupFetchCandidates", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.nearDupFetchDfData", priority: "background", latencyBudgetMs: 5_000 },
  { name: "io.fetchMergeCandidatesData", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  {
    name: "io.selectTokensNeedingClassification",
    priority: "background",
    latencyBudgetMs: HEAVY_BUDGET_MS,
  },
  { name: "io.fetchLinksForBatch", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.resolveExtractedLinks", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.fetchDateExtractionBatch", priority: "background", latencyBudgetMs: HEAVY_BUDGET_MS },
  { name: "io.captureDfOccVersion", priority: "background" },
  { name: "io.fetchDfDocChunk", priority: "background", latencyBudgetMs: 5_000 },
  { name: "io.nearDupFileLikeDocsSince", priority: "background" },
];

export const IoOps: ReadonlyMap<string, Task<unknown[], unknown>> = (() => {
  const map = new Map<string, Task<unknown[], unknown>>();
  for (const def of COMPUTE_OP_DEFS) {
    map.set(def.name, {
      name: def.name,
      runner: "io",
      priority: def.priority,
      latencyBudgetMs: def.latencyBudgetMs ?? DEFAULT_BUDGET_MS,
      async run(): Promise<never> {
        throw new Error(`${def.name} executes on the io worker, not main`);
      },
    });
  }
  return map;
})();

export function ioGateFromScheduler(scheduler: Scheduler): IoGate {
  const call = <T>(op: string, args: unknown[]): Promise<T> => {
    const task = IoOps.get(op);
    if (!task) {
      return Promise.reject(new Error(`unknown io op: ${op}`));
    }
    return scheduler.enqueue(task, args) as Promise<T>;
  };
  return {
    echo: (value) => call("io.echo", [value]),
    collectorRosterSnapshot: () => call("io.collectorRosterSnapshot", []),
    planSourceUrlRecanonicalization: (specs, cursor) =>
      call("io.planSourceUrlRecanonicalization", [specs, cursor]),
    countDocuments: () => call("io.countDocuments", []),
    bootstrapBacklog: (recencyFloor) => call("io.bootstrapBacklog", [recencyFloor]),
    bootstrapCorpusByMonth: (recencyFloor, todayIso) =>
      call("io.bootstrapCorpusByMonth", [recencyFloor, todayIso]),
    conversationRetentionCandidates: (files, cutoffMs) =>
      call("io.conversationRetentionCandidates", [files, cutoffMs]),
    browsePeople: (query, limit, options) => call("io.browsePeople", [query, limit, options]),
    lookupPeople: (query, limit, opts) => call("io.lookupPeople", [query, limit, opts]),
    enrichedMergeCandidates: (opts) => call("io.enrichedMergeCandidates", [opts]),
    mergeCandidateVisibility: (opts) => call("io.mergeCandidateVisibility", [opts]),
    likeSearchDocuments: (args) => call("io.likeSearchDocuments", [args]),
    peopleCounts: () => call("io.peopleCounts", []),
    peopleCountsChunk: (cursor, batchSize) => call("io.peopleCountsChunk", [cursor, batchSize]),
    mergeCandidates: (perStepLimit) => call("io.mergeCandidates", [perStepLimit]),
    resolvePairWinner: (a, b) => call("io.resolvePairWinner", [a, b]),
    dirtyStatsSourceIds: () => call("io.dirtyStatsSourceIds", []),
    sourceStatsRow: (sourceId) => call("io.sourceStatsRow", [sourceId]),
    linkResolutions: (
      limit,
      fallbackRepresentationSourcePrefixes,
      referenceOnlySourcePrefixes,
      urlTargetRolesReady,
      knownUrlPatternSources,
      knownUrlPatternDeclarationReady,
      expectedCollectorRosterRevision,
    ) =>
      call("io.linkResolutions", [
        limit,
        fallbackRepresentationSourcePrefixes,
        referenceOnlySourcePrefixes,
        urlTargetRolesReady,
        knownUrlPatternSources,
        knownUrlPatternDeclarationReady,
        expectedCollectorRosterRevision,
      ]),
    seedFromContactsPlan: () => call("io.seedFromContactsPlan", []),
    snapshotAbsencePlan: (providerId, sourceId, presentExternalIds, policy, scope) =>
      call("io.snapshotAbsencePlan", [providerId, sourceId, presentExternalIds, policy, scope]),
    staleAbsences: (limit) => call("io.staleAbsences", [limit]),
    dueAbsences: (opts) => call("io.dueAbsences", [opts]),
    pendingAbsenceCascades: (limit) => call("io.pendingAbsenceCascades", [limit]),
    planAnalyticsSweep: (candidates) => call("io.planAnalyticsSweep", [[...candidates]]),
    transitiveCollapse: () => call("io.transitiveCollapse", []),
    linkStats: () => call("io.linkStats", []),
    linkStatsCounters: () => call("io.linkStatsCounters", []),
    interactionScores: (opts) => call("io.interactionScores", [opts ?? {}]),
    interactionScoresMeta: () => call("io.interactionScoresMeta", []),
    peopleCountsMeta: () => call("io.peopleCountsMeta", []),
    selfPersonId: () => call("io.selfPersonId", []),
    interactionScoresChunk: (cursor, batchSize, selfId) =>
      call("io.interactionScoresChunk", [cursor, batchSize, selfId]),
    mergeEquivalences: () => call("io.mergeEquivalences", []),
    mergeEquivalencesData: () => call("io.mergeEquivalencesData", []),
    autoDetectedRules: () => call("io.autoDetectedRules", []),
    autoDetectData: () => call("io.autoDetectData", []),
    mergeRulesMeta: () => call("io.mergeRulesMeta", []),
    nearDupDfMeta: () => call("io.nearDupDfMeta", []),
    nearDupDfBuiltAt: (algoVersion) => call("io.nearDupDfBuiltAt", [algoVersion]),
    nearDupFetchInbox: (batchSize, eligibleDocTypes) =>
      call("io.nearDupFetchInbox", [batchSize, eligibleDocTypes]),
    nearDupFetchCandidates: (signedDocs, algoVersion, bandCount, maxCandidatesPerDoc) =>
      call("io.nearDupFetchCandidates", [signedDocs, algoVersion, bandCount, maxCandidatesPerDoc]),
    nearDupFetchDfData: (algoVersion) => call("io.nearDupFetchDfData", [algoVersion]),
    fetchMergeCandidatesData: () => call("io.fetchMergeCandidatesData", []),
    selectTokensNeedingClassification: (opts) =>
      call("io.selectTokensNeedingClassification", [opts ?? {}]),
    fetchLinksForBatch: (batchSize) => call("io.fetchLinksForBatch", [batchSize]),
    resolveExtractedLinks: (
      entries,
      fallbackRepresentationSourcePrefixes,
      referenceOnlySourcePrefixes,
      urlTargetRolesReady,
      knownUrlPatternSources,
      knownUrlPatternDeclarationReady,
    ) =>
      call("io.resolveExtractedLinks", [
        entries,
        fallbackRepresentationSourcePrefixes,
        referenceOnlySourcePrefixes,
        urlTargetRolesReady,
        knownUrlPatternSources,
        knownUrlPatternDeclarationReady,
      ]),
    fetchDateExtractionBatch: (limit, maxChars) =>
      call("io.fetchDateExtractionBatch", [limit, maxChars]),
    captureDfOccVersion: () => call("io.captureDfOccVersion", []),
    fetchDfDocChunk: (eligibleDocTypes, minContentLength, maxContentLength, afterId, limit) =>
      call("io.fetchDfDocChunk", [
        eligibleDocTypes,
        minContentLength,
        maxContentLength,
        afterId,
        limit,
      ]),
    nearDupFileLikeDocsSince: (builtAtSec, fileLikeDocTypes) =>
      call("io.nearDupFileLikeDocsSince", [builtAtSec, fileLikeDocTypes]),
  };
}

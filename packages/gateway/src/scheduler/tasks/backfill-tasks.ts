// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Backfill PeriodicTask factories. Each takes the shared BackfillTaskOptsInternal
 * and returns one PeriodicTask; createBackfillTasks (backfill.ts) assembles them.
 */

import { syntheticEnabled } from "@omnesis/core";
import { countNearDupInbox } from "../../near-dupes/inbox.js";
import { getUrlCanonicalizerSpecs } from "../../url-canonicalizers.js";
import { linkDeclarationBundlesReady } from "../../link-declaration-readiness.js";
import { getKnownUrlPatternSources, knownUrlPatternsReady } from "../../known-url-patterns.js";
import {
  getFallbackUrlRepresentationSources,
  getReferenceOnlyUrlSources,
  urlGraphRolesReady,
} from "../../url-graph-roles.js";
import { assembleVerifyPairs, assembleFinalBatch } from "../../near-dupes/NearDupAssembler.js";
import { NearDupDfStagingWorker } from "../../near-dupes/NearDupDfStagingWorker.js";
import {
  DECAY_HALF_LIFE_DAYS,
  harmonicMean,
  type InteractionEdgeTuple,
  type InteractionScoreRow,
  type InteractionScoresSnapshot,
} from "../../domain/InteractionScoreService.js";
import { withResolvedTargets } from "../../domain/LinkExtraction.js";
import { classifyTokens } from "../../token-identity-classifier.js";
import { DEFAULT_MERGE_CANDIDATE_MAX_RESULTS } from "../../merge-candidates.js";
import {
  occRefreshTask,
  sweepAccumulateTask,
  runBackfillTick,
  isIdleResult,
  type IdleResult,
} from "./backfill-helpers.js";
import type { TokenLabelRow } from "../../merge-candidates.js";
import type { PeopleCountRow } from "../../data/repositories/PersonRepository.js";
import type { PeriodicTask } from "../types.js";
import type { BackfillTaskOptsInternal } from "./backfill.js";

/** Docs per parallel near-dup sign call — chunked so the CPU pool signs concurrently. */
const SIGN_CHUNK_SIZE = 16;
/** Candidate pairs per parallel near-dup verify call. */
const VERIFY_CHUNK_SIZE = 256;

/** Split an array into fixed-size chunks. */
function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── Link drip ─────────────────────────────────────────────────────────

export function linkBackfillTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const { writeGate, ioGate, cpuGate, log, linkBackfillIntervalMs, linkIdleDelayMs, trackers } =
    opts;
  let total = 0;
  let extracted = 0;
  let skippedTotal = 0;
  /**
   * Per-tick batch size. Larger = better fsync amortization. Smaller =
   * tighter preemption granularity. The compute pass runs on the read
   * handle (no writer block), so the batch size only bounds the
   * writer's outer transaction — 5 keeps writer-busy windows short.
   */
  const BATCH_SIZE = 5;
  const taskName = "backfill.linkBatch";
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: linkBackfillIntervalMs,
    idlePeriodMs: linkIdleDelayMs,
    startDelayMs: 1_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        // Three phases, each on the worker that suits it, and none of them
        // on the writer:
        //
        //   io   fetch the documents still needing extraction
        //   cpu  run the regex over each one (1-5s on outlier docs like
        //        wiki pages or browser-history daily summaries)
        //   io   give every extracted link its target — one indexed lookup
        //        per link, and a link-heavy document carries hundreds
        //
        // Only then does the writer run, and what it runs is pure writing.
        // Resolving inside its transaction instead would hold the gateway's
        // one write connection for as long as the lookups take.
        //
        // Canonicalizer specs are read on the main thread (where the admin
        // POST populates them) and passed through to the compute worker —
        // `getUrlCanonicalizers()` inside the worker would return the
        // worker's own empty registry.
        const startMs = Date.now();
        const collectorRoster = await ioGate.collectorRosterSnapshot();
        if (collectorRoster.revision % 2 === 1) return { idle: true };
        if (!linkDeclarationBundlesReady()) return { idle: true };
        const docs = await ioGate.fetchLinksForBatch(BATCH_SIZE);
        const canonicalizers = getUrlCanonicalizerSpecs();
        const urlTargetRolesReady = urlGraphRolesReady();
        const knownUrlPatternSources = getKnownUrlPatternSources();
        const knownUrlPatternDeclarationReady = knownUrlPatternsReady();
        const fallbackRepresentationSourcePrefixes = urlTargetRolesReady
          ? [...getFallbackUrlRepresentationSources()]
          : [];
        const referenceOnlySourcePrefixes = urlTargetRolesReady
          ? [...getReferenceOnlyUrlSources()]
          : [];
        const extractedBatch =
          docs.length > 0
            ? (
                await Promise.all(
                  docs.map((doc) => cpuGate.extractLinksFromDocs([doc], canonicalizers)),
                )
              ).flat()
            : [];
        // Resolve the whole batch in one call, not per document: the
        // `shares-phone` type resolves against other documents' links, so a
        // pair mentioning the same number resolves only if both are in scope
        // together. The io phase returns the targets alone; folding them
        // back in happens here rather than on the worker, so a link-heavy
        // batch is not copied back to deliver a handful of strings.
        const rosterBoundBatch = extractedBatch.map((entry) => ({
          ...entry,
          expectedCollectorRosterRevision: collectorRoster.revision,
        }));
        const batch =
          rosterBoundBatch.length > 0
            ? withResolvedTargets(
                rosterBoundBatch,
                await ioGate.resolveExtractedLinks(
                  rosterBoundBatch,
                  fallbackRepresentationSourcePrefixes,
                  referenceOnlySourcePrefixes,
                  urlTargetRolesReady,
                  knownUrlPatternSources,
                  knownUrlPatternDeclarationReady,
                ),
              )
            : [];
        const computedMs = Date.now() - startMs;
        if (batch.length === 0) {
          if (total > 0) {
            log.info(
              `link backfill complete: ${total} docs, ${extracted} links, ${skippedTotal} skipped`,
            );
            total = 0;
            extracted = 0;
            skippedTotal = 0;
          }
          return { idle: true };
        }
        const {
          applied,
          skipped,
          extracted: extractedNow,
        } = await writeGate.upsertExtractedLinksBatch(batch);
        total += applied;
        extracted += extractedNow;
        skippedTotal += skipped;
        // Decrement the in-memory backlog by the number of docs we
        // just processed. This tracker only ever counts throughput; the
        // backlog's depth and head-of-queue age are reported separately by
        // the per-stage derivation-SLA observers, which take their numbers
        // from a ground-truth scan rather than from accumulated ticks.
        trackers.linkBackfill.recordTick(applied);
        const prev = total - applied;
        if (Math.floor(prev / 500) !== Math.floor(total / 500)) {
          log.info(
            `link backfill progress: ${total} docs, ${extracted} links, ${skippedTotal} skipped (compute=${computedMs}ms)`,
          );
        }
        return { idle: false };
      });
    },
  };
}

// ── Link reconcile (every 5 min) ──────────────────────────────────────

export function linkReconcileTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const { writeGate, ioGate, log, linkReconcileIntervalMs, linkReconcileBatchSize, trackers } =
    opts;
  const taskName = "backfill.linkReconcile";
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: linkReconcileIntervalMs,
    startDelayMs: 30_000,
    initialArgs: undefined,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        // The compute side runs on the compute worker's read-only
        // handle, so big batches don't park the writer. The writer applies
        // fixed-size mutation transactions with cooperative preemption, then
        // advances the cursor only after the whole logical batch. The cursor
        // lives in `link_reconcile_state` and ensures every
        // unresolved link is visited once per cycle — without it the
        // 5-minute period repeatedly re-scans the rowid-asc head of
        // the unresolved bucket and never reaches newer arrivals.
        const startMs = Date.now();
        const collectorRoster = await ioGate.collectorRosterSnapshot();
        if (collectorRoster.revision % 2 === 1) return { idle: true };
        if (!linkDeclarationBundlesReady()) return { idle: true };
        const urlTargetRolesReady = urlGraphRolesReady();
        const batch = await ioGate.linkResolutions(
          linkReconcileBatchSize,
          urlTargetRolesReady ? [...getFallbackUrlRepresentationSources()] : [],
          urlTargetRolesReady ? [...getReferenceOnlyUrlSources()] : [],
          urlTargetRolesReady,
          getKnownUrlPatternSources(),
          knownUrlPatternsReady(),
          collectorRoster.revision,
        );
        const computedMs = Date.now() - startMs;
        const { updated, deleted, retargeted } = await writeGate.upsertLinkResolutions(batch);
        // Drain the source-declared forward-reference backlog on the
        // same cadence: a declared edge whose target has since been ingested
        // is promoted into document_links; one whose target never arrives is
        // TTL-dropped. Cheap when pending_edges is empty (one bounded SELECT).
        const pendingDrain = await writeGate.drainPendingEdges();
        if (pendingDrain.promoted > 0 || pendingDrain.dropped > 0) {
          log.info(
            `pending-edge drain: ${pendingDrain.promoted} promoted, ${pendingDrain.dropped} dropped, ${pendingDrain.retried} retried`,
          );
        }
        // Resolved links leave the unresolved backlog. Ground truth
        // is reconciled separately by the linkReconcileReconciler.
        trackers.linkReconcile.recordTick(updated);
        if (updated > 0 || deleted > 0 || retargeted > 0) {
          const tookMs = Date.now() - startMs;
          // `deleted` is the url-link prune draining the permanently-
          // unresolvable external url backlog as the cursor walks it.
          log.info(
            `link reconciliation: ${updated} resolved, ${retargeted} retargeted, ${deleted} pruned in ${tookMs}ms (compute=${computedMs}ms, ${batch.resolutions.length + (batch.retargets?.length ?? 0)} candidates)`,
          );
        }
        return { idle: false };
      });
    },
  };
}

// ── People drip ───────────────────────────────────────────────────────

export function peopleBackfillTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const {
    writeGate,
    log,
    peopleBatchSize,
    peopleBatchIntervalMs,
    peopleIdleDelayMs,
    trackers,
    kickPeriodic,
  } = opts;
  let total = 0;
  let resolved = 0;
  let skipped = 0;
  const taskName = "backfill.peopleBatch";
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: peopleBatchIntervalMs,
    idlePeriodMs: peopleIdleDelayMs,
    startDelayMs: 2_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        const result = await writeGate.backfillManyPeople(peopleBatchSize);
        if (result.processed > 0) {
          total += result.processed;
          resolved += result.resolved;
          skipped += result.skipped;
          // Decrement the in-memory people-backfill backlog. Ground
          // truth is too expensive to recompute frequently (multi-table
          // join on document_people, ~440k rows live) — we accept
          // drift between reconciliations.
          trackers.peopleBackfill.recordTick(result.processed);
          const prev = total - result.processed;
          if (Math.floor(prev / 500) !== Math.floor(total / 500)) {
            log.info(
              `people backfill progress: ${total} docs, ${resolved} resolved, ${skipped} skipped`,
            );
          }
          return { idle: false };
        }
        if (total > 0) {
          log.info(
            `people backfill complete: ${total} docs, ${resolved} resolved, ${skipped} skipped`,
          );
          // The initial auto-detect tick can land while a large ingestion is
          // still creating people. Wake a trailing scan only once the backlog
          // is empty so shared aliases introduced by the final batch are not
          // left unresolved until the long periodic cadence.
          kickPeriodic("backfill.autoDetect");
          total = 0;
          resolved = 0;
          skipped = 0;
        }
        return { idle: true };
      });
    },
  };
}

/**
 * How long the people counts may go unrefreshed while the graph looks
 * unchanged. A backstop for a missed dirty mark, not the normal cadence.
 */
const PEOPLE_COUNTS_MAX_STALENESS_MS = 6 * 60 * 60 * 1_000;

// ── People counts + name primaries refresh ───────────────────────────
//
// Recomputes each canonical person's document and alias counts and their
// primary name. Finding duplicate people and merging them is not this
// task's job — that is `backfill.autoDetect` and `backfill.mergeRulesEval`
// — but a merge is the main reason these numbers move, so the sweep is
// gated on the people-graph dirty mark those tasks set.

export function peopleCountsRefreshTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const { writeGate, ioGate, log, peopleCountsRefreshIntervalMs, trackers, kickPeriodic } = opts;
  // The dirty version this sweep computed against, stamped when it finishes.
  let sweepDirtyVersion = 0;
  return sweepAccumulateTask<PeopleCountRow, { rows: PeopleCountRow[] }>({
    name: "backfill.peopleCountsRefresh",
    log,
    periodMs: 500,
    idlePeriodMs: peopleCountsRefreshIntervalMs,
    startDelayMs: 60_000,
    tracker: trackers.peopleCountsRefresh,
    shouldStartSweep: async () => {
      // Run when the people graph has actually moved. Every mutation that
      // can change a count — a merge, a document resolving to a person, an
      // alias moving — marks this job dirty, so an unchanged graph means
      // there is nothing to recompute and fifty chunks of work to skip.
      //
      // The age check is the safety net for that reasoning: dirty marking
      // is a list of call sites, and a missed one would otherwise leave the
      // People page wrong indefinitely. Bounding staleness to
      // PEOPLE_COUNTS_MAX_STALENESS_MS turns that failure into a delay.
      const meta = await ioGate.peopleCountsMeta();
      if (meta.dirtyVersion > meta.lastComputedVersion) return true;
      const lastAt = meta.lastComputedAt;
      if (lastAt === null) return true;
      return Date.now() - lastAt >= PEOPLE_COUNTS_MAX_STALENESS_MS;
    },
    initSweep: async () => {
      sweepDirtyVersion = (await ioGate.peopleCountsMeta()).dirtyVersion;
      // Flatten merge chains before counting anything.
      //
      // A merge records `loser.merged_into = winner`. Merging that winner
      // into a third person leaves A→B→C, and every reader that follows
      // `merged_into` a single hop — this sweep among them — then credits
      // A's documents to B, which is not a canonical person and appears in
      // no batch, so C is short by them for as long as the chain stands.
      // Rule-based merges avoid this by writing every member straight to
      // its component root; a merge made by hand does not. The repair runs
      // here, where its result is needed and where the walk can run on a
      // reader rather than on the writer.
      // Best-effort: this is a repair, and counts that are one merge stale
      // beat counts that never refresh because the repair failed.
      try {
        const chains = await ioGate.transitiveCollapse();
        if (chains.length > 0) {
          const { collapsed } = await writeGate.upsertTransitiveCollapse(chains);
          if (collapsed > 0) {
            log.info(`collapsed ${collapsed} transitive merge chain(s) before the people sweep`);
          }
        }
      } catch (err) {
        log.warn(
          `transitive merge-chain collapse failed before the people sweep: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { rows: [] };
    },
    fetchChunk: (cursor) => ioGate.peopleCountsChunk(cursor, 1000),
    mergeChunk: (acc, rows) => {
      acc.rows.push(...rows);
    },
    applyResult: async (acc) => {
      const { updated } = await writeGate.upsertPeopleCounts(acc.rows);
      await writeGate.zeroPeopleCountsForLosers();
      // Refresh the dominant (primary) name per person from occurrence_count —
      // same per-person cadence, drives display + the name-filtered detector.
      await writeGate.recomputeNamePrimaries();
      // Stamp the watermark only now, with the version captured before the
      // first chunk: a graph change during the sweep leaves dirty ahead of
      // it, so the next tick runs again rather than trusting a pass that
      // raced it.
      await writeGate.advancePeopleCountsWatermark(sweepDirtyVersion);
      // A newly promoted contact name can expose another deterministic
      // auto-detect candidate. The resulting auto → eval → merge-pass cycle
      // terminates when eval is caught up and no longer kicks this sweep.
      kickPeriodic("backfill.autoDetect");
      return { affected: updated, checked: acc.rows.length };
    },
    logSummary: (acc, applied, { sweepMs }) => {
      log.info(
        `refreshed people counts: ${applied.affected} of ${acc.rows.length} rows changed in ${sweepMs}ms`,
      );
    },
  });
}

// ── Source-stats refresh drip ─────────────────────────────────────────

export function sourceStatsRefreshTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const { writeGate, ioGate, log, statsRefreshIntervalMs, trackers } = opts;
  const taskName = "backfill.statsRefresh";
  // Which dirty source this task takes next. One source is refreshed per tick,
  // and the aggregation is committed only if nothing wrote to that source while
  // it ran — so a source that is still ingesting loses that race every time.
  // Always taking the head of the list then means one busy source holds the
  // turn indefinitely and every other source starves behind it: their
  // `total_units` stays null, and the count a client reads falls back to the
  // document total. On a source whose documents aggregate — a day of WhatsApp
  // messages, a digest of browser visits — that is a different number, and two
  // clients end up disagreeing about the same source.
  let nextDirtyIndex = 0;
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: statsRefreshIntervalMs,
    idlePeriodMs: 30_000,
    startDelayMs: 500,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        const dirty = await ioGate.dirtyStatsSourceIds();
        if (dirty.length === 0) {
          // Caught up. The dirty-source backlog is conceptually zero
          // until something marks a source dirty again — push that
          // ground truth into the tracker so the UI reads 0 cleanly.
          trackers.sourceStatsRefresh.setRemaining(0);
          return { idle: true };
        }

        // Round-robin, so a source that cannot commit yields its turn.
        if (nextDirtyIndex >= dirty.length) nextDirtyIndex = 0;
        const sid = dirty[nextDirtyIndex];
        nextDirtyIndex += 1;
        const startMs = Date.now();
        const agg = await ioGate.sourceStatsRow(sid);
        const computedMs = Date.now() - startMs;
        await writeGate.upsertSourceStatsRow(sid, agg);
        // Push the actual remaining dirty count straight from the
        // compute-side query — it's already cheap (PK lookup on small
        // table) so there's no point maintaining a separate counter.
        trackers.sourceStatsRefresh.setRemaining(Math.max(0, dirty.length - 1));
        trackers.sourceStatsRefresh.recordTick(1);
        const tookMs = Date.now() - startMs;
        if (tookMs > 500) {
          log.info(
            `refreshed source_stats for ${sid} in ${tookMs}ms (compute=${computedMs}ms, ${dirty.length - 1} dirty remaining)`,
          );
        }
        return { idle: false };
      });
    },
  };
}

// ── Link-stats reconciliation ─────────────────────────────────────────
//
// SQLite triggers on `document_links` maintain per-type counters in
// `link_stats_counters` (O(1) reads). This task periodically reconciles
// the trigger-maintained counters against a full table scan to correct
// any drift, and syncs the materialized `link_stats` row.

export function linkStatsRefreshTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const { writeGate, log, linkStatsRefreshIntervalMs, linkStatsIdleDelayMs, trackers } = opts;
  const taskName = "backfill.linkStatsRefresh";
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: linkStatsRefreshIntervalMs,
    idlePeriodMs: linkStatsIdleDelayMs,
    startDelayMs: 60_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        trackers.linkStatsRefresh.recordSweepStarted();
        const startMs = Date.now();
        const { corrected } = await writeGate.reconcileLinkStatsCounters();
        const tookMs = Date.now() - startMs;
        trackers.linkStatsRefresh.recordSweepCompleted({ affected: corrected });
        if (corrected > 0 || tookMs > 1000) {
          log.info(`link_stats reconciliation: ${corrected} counter rows corrected in ${tookMs}ms`);
        }
        return { idle: true };
      });
    },
  };
}

// ── Interaction-scores refresh drip ───────────────────────────────────
//
// Compute every per-person inbound / outbound / interaction score
// (lifetime + 1y-decayed) and persist via the writer. Driven by the
// singleton `interaction_scores_meta.dirty_version` counter:
//
//   - `markPeopleGraphDirty` (people.ts + db.ts cascade paths)
//     bumps `dirty_version` whenever document_people / people /
//     person_aliases shifts.
//   - The task polls `interactionScoresMeta()` each tick. If
//     `dirty_version <= last_computed_version`, the scores are fresh
//     and the task goes idle.
//   - Otherwise it fires `interactionScores()` (compute) then
//     `upsertInteractionScores(snapshot)` (writer). The writer
//     advances `last_computed_version` to the snapshot's captured
//     `dirtyVersion`, so a bump that lands DURING compute will
//     re-trigger on the next tick.
//
// This keeps the writer thread free: the heavy join + per-doc decay
// math runs on the compute worker's read handle. The writer just
// applies a bulk UPDATE pass, chunked internally so it stays under
// the 500ms HEAVY_BUDGET_MS slow-op alert.

export function interactionScoresRefreshTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const {
    writeGate,
    ioGate,
    log,
    interactionScoresRefreshIntervalMs,
    interactionScoresIdleDelayMs,
    trackers,
  } = opts;

  // Sweep context captured by initSweep, read by fetchChunk/mergeChunk/applyResult.
  let sweepSelfId: string | null = null;
  let sweepDirtyVersion = 0;
  let sweepNowMs = 0;
  let sweepDecayConstant = 0;

  interface ScoresAcc {
    perPerson: Map<
      string,
      { inRaw: number; outRaw: number; inDecayed: number; outDecayed: number }
    >;
    totalInRaw: number;
    totalOutRaw: number;
    totalInDecayed: number;
    totalOutDecayed: number;
  }

  return sweepAccumulateTask<InteractionEdgeTuple, ScoresAcc>({
    name: "backfill.interactionScoresRefresh",
    log,
    // periodMs also paces mid-sweep chunks (500 people each), so a
    // full sweep takes ~people/500 minutes.
    periodMs: interactionScoresRefreshIntervalMs,
    idlePeriodMs: interactionScoresIdleDelayMs,
    startDelayMs: 10_000,
    tracker: trackers.interactionScoresRefresh,
    shouldStartSweep: async () => {
      const m = await ioGate.interactionScoresMeta();
      return m.dirtyVersion > m.lastComputedVersion;
    },
    initSweep: async () => {
      sweepSelfId = await ioGate.selfPersonId();
      const m = await ioGate.interactionScoresMeta();
      sweepDirtyVersion = m.dirtyVersion;
      sweepNowMs = Date.now();
      sweepDecayConstant = Math.LN2 / (DECAY_HALF_LIFE_DAYS * 86_400_000);
      return {
        perPerson: new Map(),
        totalInRaw: 0,
        totalOutRaw: 0,
        totalInDecayed: 0,
        totalOutDecayed: 0,
      };
    },
    fetchChunk: async (cursor) => {
      if (!sweepSelfId) return { rows: [], nextCursor: null };
      return ioGate.interactionScoresChunk(cursor, 500, sweepSelfId);
    },
    mergeChunk: (acc, edges) => {
      for (const edge of edges) {
        const inboundEdge = edge.pK === 2 || (edge.pK === 1 && edge.selfK === 1) ? 1 : 0;
        const outboundEdge = edge.selfK === 2 || (edge.selfK === 1 && edge.pK === 1) ? 1 : 0;
        if (inboundEdge === 0 && outboundEdge === 0) continue;

        let weight = 1;
        if (edge.docDate) {
          const ts = Date.parse(edge.docDate);
          if (Number.isFinite(ts)) {
            const ageMs = Math.max(0, sweepNowMs - ts);
            weight = Math.exp(-sweepDecayConstant * ageMs);
          }
        }

        let person = acc.perPerson.get(edge.personId);
        if (!person) {
          person = { inRaw: 0, outRaw: 0, inDecayed: 0, outDecayed: 0 };
          acc.perPerson.set(edge.personId, person);
        }
        person.inRaw += inboundEdge;
        person.outRaw += outboundEdge;
        person.inDecayed += inboundEdge * weight;
        person.outDecayed += outboundEdge * weight;
        acc.totalInRaw += inboundEdge;
        acc.totalOutRaw += outboundEdge;
        acc.totalInDecayed += inboundEdge * weight;
        acc.totalOutDecayed += outboundEdge * weight;
      }
    },
    applyResult: async (acc) => {
      const rows: InteractionScoreRow[] = [];
      for (const [personId, a] of acc.perPerson) {
        const inScore = acc.totalInRaw > 0 ? a.inRaw / acc.totalInRaw : 0;
        const outScore = acc.totalOutRaw > 0 ? a.outRaw / acc.totalOutRaw : 0;
        const inScoreRecent = acc.totalInDecayed > 0 ? a.inDecayed / acc.totalInDecayed : 0;
        const outScoreRecent = acc.totalOutDecayed > 0 ? a.outDecayed / acc.totalOutDecayed : 0;
        rows.push({
          personId,
          inboundCount: a.inRaw,
          outboundCount: a.outRaw,
          inboundScore: inScore,
          outboundScore: outScore,
          interactionScore: harmonicMean(inScore, outScore),
          inboundScoreRecent: inScoreRecent,
          outboundScoreRecent: outScoreRecent,
          interactionScoreRecent: harmonicMean(inScoreRecent, outScoreRecent),
        });
      }
      const snapshot: InteractionScoresSnapshot = {
        rows,
        dirtyVersion: sweepDirtyVersion,
        computedAt: new Date(sweepNowMs).toISOString(),
      };
      const { updated, zeroed } = await writeGate.upsertInteractionScores(snapshot);
      return { affected: updated + zeroed, checked: rows.length };
    },
    logSummary: (acc, applied, { sweepMs }) => {
      if (applied.affected > 0 || sweepMs > 1000) {
        log.info(
          `refreshed interaction scores: ${applied.affected} affected across ${acc.perPerson.size} people in ${sweepMs}ms (dirtyVersion=${sweepDirtyVersion})`,
        );
      }
    },
  });
}

// ── Merge-rules eval drip ─────────────────────────────────────────────
//
// The eval pass derives `people.merged_into` from the active set of
// `merge_rules` (both `kind='system'` auto-detected and `kind='user'`
// user-asserted). User-issued rule mutations kick this task directly
// (PersonService → Scheduler.kickPeriodic), so merges and unmerges
// materialize within seconds; the periodic cadence covers system rules
// and acts as the repair / catch-all path.
//
// All compute on the read-only handle, all writes as chunked
// transactions on the writer worker. The apply op supports cooperative
// preemption but its handler currently passes no preempt token, so it
// runs to completion once dispatched; higher-priority writer ops queue
// ahead of it between ops, not mid-op.

export function mergeRulesEvalTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const {
    writeGate,
    ioGate,
    cpuGate,
    log,
    mergeRulesEvalIntervalMs,
    mergeRulesEvalIdleDelayMs,
    trackers,
    kickPeriodic,
  } = opts;
  // Closure-captured per-tick value. The pre-step's `swept` count needs
  // to flow into the summary log (alongside the OCC-driven counts).
  let lastCandSweep = 0;
  return occRefreshTask({
    name: "backfill.mergeRulesEval",
    log,
    periodMs: mergeRulesEvalIntervalMs,
    idlePeriodMs: mergeRulesEvalIdleDelayMs,
    startDelayMs: 15_000,
    tracker: trackers.mergeRulesEval,
    // Always sweep stale candidates first, regardless of whether
    // rule-eval has work to do this tick. The sweep targets
    // `merge_candidates` (not `merge_rules`), so it's not gated on
    // `merge_rules_meta.dirty_version`. Cheap when nothing is stale
    // (queries only `pending` rows). Catches ongoing drift and
    // pre-deploy stale rows that aren't tied to a rule-version bump.
    preStep: async () => {
      const candSweep = await writeGate.sweepCollapsedMergeCandidates();
      lastCandSweep = candSweep.swept;
      if (candSweep.swept > 0) {
        log.info(`merge rules eval: ${candSweep.swept} stale-candidates-swept`);
      }
      return candSweep.swept > 0;
    },
    readMeta: async () => {
      const m = await ioGate.mergeRulesMeta();
      return { dirtyVersion: m.dirtyVersion, lastAppliedVersion: m.lastEvaluatedVersion };
    },
    computeSnapshot: async () => {
      const data = await ioGate.mergeEquivalencesData();
      return cpuGate.computeMergeEquivalences(data);
    },
    applySnapshot: async (snapshot) => {
      const result = await writeGate.upsertMergeEquivalences(snapshot);
      const affected = result.added + result.changed + result.removed;
      // A dirty rule snapshot is also the post-people-resolution barrier.
      // Counts and scores can change even when the equivalence diff is empty,
      // so refresh both after every applied snapshot. Caught-up eval ticks
      // short-circuit before applySnapshot and do not create needless work.
      kickPeriodic("backfill.interactionScoresRefresh");
      kickPeriodic("backfill.peopleCountsRefresh");
      if (affected > 0) {
        // Candidates bridging the now-merged people are satisfied, but
        // the pre-step sweep ran before this apply — re-sweep so a
        // kicked tick clears them in the same pass (the portal's
        // cluster-merge flow polls for exactly that). Best-effort: on
        // failure (writer backpressure) the next tick's pre-step
        // catches up.
        try {
          const postSweep = await writeGate.sweepCollapsedMergeCandidates();
          lastCandSweep += postSweep.swept;
        } catch (err) {
          log.warn(
            `merge rules eval: post-apply candidate re-sweep failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return {
        affected,
        checked: snapshot.equivalences.length,
      };
    },
    logSummary: (snapshot, applied, { computedMs, tookMs }) => {
      if (applied.affected > 0 || lastCandSweep > 0 || tookMs > 1000) {
        log.info(
          `merge rules eval: ${applied.affected} eq-changes, ${lastCandSweep} stale-candidates-swept across ${snapshot.equivalences.length} equivalences in ${tookMs}ms (compute=${computedMs}ms, dirtyVersion=${snapshot.dirtyVersion})`,
        );
      }
    },
  });
}

// ── Auto-detect drip ──────────────────────────────────────────────────
//
// Scans for shared-identifier (email/phone/lid) and contact-name
// candidates. Shared aliases are physically merged; future cross-identifier
// candidates produce `kind='system'` rules. Every completed scan kicks rule
// evaluation so the graph converges without waiting for its idle backoff.
//
// Less frequent cadence than eval — the underlying alias graph
// changes as fast as the people backfill ingests new edges, but the
// auto-detect is bounded work per tick (hash of rule pairs already
// seen via the unique index short-circuits no-op iterations).

export function autoDetectTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<
  unknown,
  IdleResult & { successful?: true; inserted?: number; mutationGeneration?: number }
> {
  const { writeGate, ioGate, cpuGate, log, autoDetectIntervalMs, kickPeriodic } = opts;
  const taskName = "backfill.autoDetect";
  let mutationGeneration = 0;
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: autoDetectIntervalMs,
    startDelayMs: 30_000,
    initialArgs: undefined,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        const startMs = Date.now();
        const rawData = await ioGate.autoDetectData();
        const candidates = await cpuGate.computeAutoDetectedRules(rawData);
        const computedMs = Date.now() - startMs;
        if (candidates.length === 0) {
          kickPeriodic("backfill.mergeRulesEval");
          return {
            idle: false,
            successful: true as const,
            inserted: 0,
            mutationGeneration,
          };
        }
        const result = await writeGate.upsertAutoDetectedRules(candidates);
        // The write may physically merge shared aliases or persist future
        // cross-identifier rules. Only wake evaluation after that state is
        // durable; the eval apply owns the downstream score/count refreshes.
        kickPeriodic("backfill.mergeRulesEval");
        mutationGeneration += result.inserted;
        const tookMs = Date.now() - startMs;
        if (result.inserted > 0 || tookMs > 1000) {
          log.info(
            `auto-detect: ${candidates.length} candidates, ${result.inserted} new system rules, ${result.skipped} pre-existing in ${tookMs}ms (compute=${computedMs}ms)`,
          );
        }
        return {
          idle: false,
          successful: true as const,
          inserted: result.inserted,
          mutationGeneration,
        };
      });
    },
  };
}

// ── Fuzzy merge-candidate detection ───────────────────────────────────
//
// Runs the IDF-weighted name-token scorer over the unmerged-people
// graph and surfaces probable identity matches as candidates the
// operator can accept / deny via the portal.
//
// Gating: only runs when (a) merge_rules eval is up to date with the
// current dirty version AND (b) interaction_scores eval is up to date
// — guarantees we score against a steady-state graph instead of one
// where active merges haven't materialized yet. When either is dirty,
// the task returns idle so the next tick uses the (longer) idle delay.

export function mergeCandidatesDetectTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const {
    writeGate,
    ioGate,
    cpuGate,
    log,
    mergeCandidatesDetectIntervalMs,
    mergeCandidatesDetectIdleDelayMs,
    trackers,
  } = opts;
  const taskName = "backfill.mergeCandidatesDetect";
  // Wall-clock of the last completed detection pass. The steady-state gate
  // prefers a settled graph, but on a continuously-ingesting instance the
  // merge-rules / interaction-score versions are almost always mid-flight, so
  // a strict gate starves detection for hours. Force a pass if it's been too
  // long — a slightly-stale graph yields candidates the next pass + the
  // collapse/prune sweeps correct, which is far better than never refreshing.
  const FORCE_DETECT_AFTER_MS = 15 * 60_000;
  let lastDetectedAtMs = 0;
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: mergeCandidatesDetectIntervalMs,
    idlePeriodMs: mergeCandidatesDetectIdleDelayMs,
    // Generous start delay — the boot path is busy enough.
    startDelayMs: 90_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      // Doesn't use occRefreshTask: the gate isn't ONE OCC version,
      // it's BOTH (mergeRules eval AND interactionScores) being
      // current. The factory only models a single dirty/lastApplied
      // pair, so we keep this one explicit.
      return runBackfillTick(taskName, log, async () => {
        // Converge pre-existing pending rows the suppression rule now rejects
        // (proposed before classification, or before this feature). This is
        // independent of graph steadiness — it only needs token labels, domain
        // spread, and the blocklist — so it runs BEFORE the detection gate
        // below, which otherwise defers indefinitely on a busy live graph.
        const { pruned } = await writeGate.pruneSuppressedMergeCandidates();

        // Steady-state check. If either eval is behind its dirty
        // version, the graph is in flight; defer detection to the next tick.
        // (The prune above already ran.)
        const [mrMeta, isMeta] = await Promise.all([
          ioGate.mergeRulesMeta(),
          ioGate.interactionScoresMeta(),
        ]);
        const graphInFlight =
          mrMeta.dirtyVersion > mrMeta.lastEvaluatedVersion ||
          isMeta.dirtyVersion > isMeta.lastComputedVersion;
        const stale = Date.now() - lastDetectedAtMs > FORCE_DETECT_AFTER_MS;
        if (graphInFlight && !stale) {
          return { idle: pruned === 0 };
        }

        trackers.mergeCandidatesDetect.recordSweepStarted();
        const startMs = Date.now();
        const fetchData = await ioGate.fetchMergeCandidatesData();
        // The interaction-score head gate exists to suppress low-signal name matches
        // on a real corpus (only surface candidates for high-interaction contacts).
        // Under a synthetic corpus (the demo gateway) there is no such noise, so we
        // disable it — otherwise a genuine curated duplicate never surfaces because
        // no synthetic contact accrues a meaningful interaction score. Real gateways
        // keep the default gate.
        const proposals = await cpuGate.scoreMergeCandidates(
          fetchData,
          syntheticEnabled() ? { headPercentile: 0 } : undefined,
        );
        const computedMs = Date.now() - startMs;
        lastDetectedAtMs = Date.now();
        if (proposals.length === 0) {
          trackers.mergeCandidatesDetect.recordSweepCompleted();
          return { idle: pruned === 0 };
        }
        const result = await writeGate.upsertMergeCandidates(proposals);
        // Reconcile pending → latest output: drop rows no longer proposed (heals
        // staleness when the algorithm changes what it surfaces). Skip if the
        // detector hit its result cap — the set would be incomplete and we'd
        // delete the uncapped tail.
        let reconciled = 0;
        if (proposals.length < DEFAULT_MERGE_CANDIDATE_MAX_RESULTS) {
          reconciled = (await writeGate.reconcilePendingMergeCandidates(proposals)).deleted;
        }
        // Promote the structurally high-confidence survivors to reversible system
        // merges so only the uncertain ones remain for the operator to review.
        const { approved } = await writeGate.autoApproveHighConfidenceCandidates();
        const tookMs = Date.now() - startMs;
        trackers.mergeCandidatesDetect.recordSweepCompleted({
          checked: proposals.length,
          affected: result.inserted + result.refreshed + reconciled + approved,
        });
        if (result.inserted > 0 || result.refreshed > 0 || approved > 0 || tookMs > 1000) {
          log.info(
            `merge candidates detect: ${proposals.length} proposals → ${result.inserted} new, ${result.refreshed} refreshed, ${result.skipped} decided, ${approved} auto-approved in ${tookMs}ms (compute=${computedMs}ms)`,
          );
        }
        return { idle: false };
      });
    },
  };
}

/** Active cadence for the token-identity classifier. Mostly idle — only new
 *  high-spread tokens need labeling — so the active period exists to drain a
 *  backlog quickly, and the idle period throttles steady-state polling. */
const TOKEN_CLASSIFY_INTERVAL_MS = 5 * 60_000;
const TOKEN_CLASSIFY_IDLE_MS = 60 * 60_000;

/**
 * Token-identity classifier. Labels the high-spread email-local tokens that
 * drive merge-candidate role-mailbox suppression (`personal_name` /
 * `role_generic` / `ambiguous`) via the configured generative model, and
 * writes them to `token_identity_labels`. No-ops when no model is available.
 */
export function tokenIdentityClassifyTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const { ioGate, writeGate, log, getCompletionProvider, trackers } = opts;
  const taskName = "backfill.tokenIdentityClassify";
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: TOKEN_CLASSIFY_INTERVAL_MS,
    idlePeriodMs: TOKEN_CLASSIFY_IDLE_MS,
    startDelayMs: 120_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        // Candidates first: the query is a cheap indexed read, whereas
        // building a provider may spin up a local model. No work, no model.
        const candidates = await ioGate.selectTokensNeedingClassification({ limit: 200 });
        if (candidates.length === 0) return { idle: true };
        const provider = getCompletionProvider();
        if (!provider) return { idle: true };

        trackers.tokenIdentityClassify.recordSweepStarted();
        const startMs = Date.now();
        try {
          const labels = await classifyTokens(
            provider,
            candidates.map((c) => c.token),
          );
          // Persist only what the model actually returned. A batch the model
          // never answered — a timeout, a 429 — leaves its tokens unlabeled so
          // the next sweep retries them; writing a placeholder would take them
          // out of `selectTokensNeedingClassification` forever.
          const rows: TokenLabelRow[] = candidates
            .filter((c) => labels.has(c.token))
            .map((c) => ({
              token: c.token,
              label: labels.get(c.token)!,
              domainSpread: c.domainSpread,
            }));
          const { upserted } = await writeGate.upsertTokenLabels(rows);
          trackers.tokenIdentityClassify.recordSweepCompleted({
            checked: candidates.length,
            affected: upserted,
          });
          log.info(`token classify: ${upserted} token(s) labeled in ${Date.now() - startMs}ms`);
          return { idle: false };
        } finally {
          // The provider is built per sweep, so this sweep owns it. Releasing
          // it here keeps a local model from sitting resident between the
          // hour-long idle ticks. Best-effort: a failed release must not mask
          // the classification error that is already propagating.
          try {
            await provider.dispose();
          } catch (err) {
            log.warn(
              `token classify: releasing the completion provider failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      });
    },
  };
}

// ── Catalog refresh (every 5 min) ─────────────────────────────────────

export function catalogRefreshTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const { writeGate, log, catalogRefreshIntervalMs } = opts;
  const taskName = "backfill.catalogRefresh";
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: catalogRefreshIntervalMs,
    startDelayMs: 90_000,
    initialArgs: undefined,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        const startMs = Date.now();
        await writeGate.refreshSqliteTableStats();
        log.info(`refreshed sqlite_table_stats in ${Date.now() - startMs}ms`);
        return { idle: false };
      });
    },
  };
}

// ── Near-dup compute drip ─────────────────────────────────────────────
//
// Drains up to `config.scheduler.computeBatchSize` rows from
// `near_dup_inbox` per tick. Compute runs on the compute worker's
// read-only handle (LSH bucket lookup + candidate verify + gate);
// writer applies the resulting batch in yieldable per-doc commits.
// When the inbox is empty the task returns `idle: true` and the
// scheduler waits `computeIdlePeriodMs` before the next poke.

export function nearDupComputeTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const { writeGate, ioGate, cpuGate, log, trackers, getNearDupConfig, readDb, dfCacheRef } = opts;
  const taskName = "backfill.nearDupCompute";
  let parkLoggedForAlgo: string | null = null;
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: getNearDupConfig().scheduler.computePeriodMs,
    idlePeriodMs: getNearDupConfig().scheduler.computeIdlePeriodMs,
    startDelayMs: 5_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        const config = getNearDupConfig();
        if (!config.enabled) return { idle: true };
        trackers.nearDupCompute.setRemaining(countNearDupInbox(readDb));
        const dfBuiltAt = await ioGate.nearDupDfBuiltAt(config.algorithm.algoVersion);
        if (dfBuiltAt === null) {
          if (parkLoggedForAlgo !== config.algorithm.algoVersion) {
            log.info(
              `near-dup compute parked: DF not yet built for algo ${config.algorithm.algoVersion} — waiting for nearDupDfRefresh to land`,
            );
            parkLoggedForAlgo = config.algorithm.algoVersion;
          }
          return { idle: true };
        }
        parkLoggedForAlgo = null;
        const startMs = Date.now();
        const eligibleDocTypes = [...config.eligibleDocTypes];

        // Phase 1: Fetch inbox + doc content (IO on compute worker)
        const fetched = await ioGate.nearDupFetchInbox(
          config.scheduler.computeBatchSize,
          eligibleDocTypes,
        );
        if (fetched.inboxRows.length === 0) return { idle: true };
        if (fetched.docs.length === 0 && fetched.deleteDocIds.length === 0) {
          // All inbox rows were delete-reason or ineligible — still
          // need to consume them from the inbox.
          const batch = assembleFinalBatch(
            fetched,
            [],
            { candidates: {}, candidateIdsByDoc: {}, existingEdges: {} },
            [],
            config.algorithm.algoVersion,
          );
          await writeGate.applyNearDupBatch(batch);
          trackers.nearDupCompute.recordTick(fetched.inboxRows.length);
          return { idle: false };
        }

        // DF data for IDF weighting — cached on the main thread,
        // invalidated when nearDupDfRefreshTask rebuilds the table.
        if (
          !dfCacheRef.current ||
          dfCacheRef.current.algoVersion !== config.algorithm.algoVersion
        ) {
          dfCacheRef.current = {
            algoVersion: config.algorithm.algoVersion,
            data: await ioGate.nearDupFetchDfData(config.algorithm.algoVersion),
          };
        }
        const dfData = dfCacheRef.current.data;

        // Phase 2a: Sign docs (CPU pool), fanned out in chunks so the pool
        // signs in parallel. The DF table is a shared SharedArrayBuffer
        // (`dfData`), so handing it to each chunk is a zero-copy reference —
        // none of the per-call clone cost that made per-doc fan-out
        // pathological before the SAB landed. Each chunk still builds the
        // (O(1)) lookup view once for its docs.
        const signedDocs = (
          await Promise.all(
            chunk(fetched.docs, SIGN_CHUNK_SIZE).map((docChunk) =>
              cpuGate.nearDupSignBatch(docChunk, config.algorithm, dfData, eligibleDocTypes),
            ),
          )
        ).flat();
        const signedMs = Date.now() - startMs;

        // Phase 2b: Fetch candidates for signed docs (IO on compute worker)
        const docsWithBands = signedDocs
          .filter((s) => !s.shouldDelete && s.bands !== null)
          .map((s) => ({ docId: s.docId, bands: s.bands!, reason: s.reason }));
        const candidateResult =
          docsWithBands.length > 0
            ? await ioGate.nearDupFetchCandidates(
                docsWithBands,
                config.algorithm.algoVersion,
                config.algorithm.bands,
                config.scheduler.maxCandidatesPerDoc,
              )
            : { candidates: {}, candidateIdsByDoc: {}, existingEdges: {} };
        const candMs = Date.now() - startMs;

        // Phase 2c: Assemble verify pairs (main thread)
        const pairs = assembleVerifyPairs(
          signedDocs,
          candidateResult,
          config.algorithm,
          eligibleDocTypes,
          config.scheduler.maxCandidatesPerDoc,
        );
        const pairsMs = Date.now() - startMs;

        // Phase 2d: Verify pairs (CPU pool). Same rule as signing — one call
        // for all pairs so the DF table is transferred + the lookup built
        // once, not once per pair.
        const gateOpts = {
          recordThreshold: config.gate.recordThreshold,
          maxIdfWeight: config.algorithm.maxIdfWeight ?? 8.0,
          emailJaccardMin: config.gate.emailJaccardMin,
          emailPairUniqueDf2Min: config.gate.emailPairUniqueDf2Min,
          fileLikeJaccardMin: config.gate.fileLikeJaccardMin,
          fileLikePairUniqueDf2Min: config.gate.fileLikePairUniqueDf2Min,
          fileLikeContainmentMin: config.gate.fileLikeContainmentMin,
          automatedSenderPrefixes: [...config.gate.automatedSenderPrefixes],
        };
        // Verify in parallel across the pool too — this is the dominant CPU
        // cost (an LSH match produces ~20 candidate pairs per doc, all
        // verified to find the few real edges). Same shared-SAB zero-copy
        // fan-out as signing.
        const verified =
          pairs.length > 0
            ? (
                await Promise.all(
                  chunk(pairs, VERIFY_CHUNK_SIZE).map((pairChunk) =>
                    cpuGate.nearDupVerifyBatch(pairChunk, dfData, gateOpts),
                  ),
                )
              ).flat()
            : [];
        const verifyMs = Date.now() - startMs;

        // Phase 3: Assemble + apply (writer)
        const batch = assembleFinalBatch(
          fetched,
          signedDocs,
          candidateResult,
          verified,
          config.algorithm.algoVersion,
        );
        if (
          batch.processedInboxIds.length === 0 &&
          batch.signatureDeletes.length === 0 &&
          batch.signatures.length === 0 &&
          batch.edgeUpserts.length === 0
        ) {
          return { idle: true };
        }
        const applied = await writeGate.applyNearDupBatch(batch);
        trackers.nearDupCompute.recordTick(applied.inboxConsumed);
        const tookMs = Date.now() - startMs;
        if (applied.edgesUpserted > 0 || tookMs > 1000) {
          log.info(
            `near-dup compute: ${applied.inboxConsumed} inbox, ${applied.signaturesUpserted} sigs, ${applied.edgesUpserted} edges (+), ${applied.edgesDeleted} edges (-) in ${tookMs}ms ` +
              `(sign=${signedMs} cand=${candMs - signedMs} pairs=${pairsMs - candMs}[${pairs.length}p] verify=${verifyMs - pairsMs} apply=${tookMs - verifyMs}ms)`,
          );
        }
        return { idle: false };
      });
    },
  };
}

// ── Near-dup DF refresh (wall-clock driven) ───────────────────────────
//
// Periodic full rebuild of `near_dup_df`. Trade-off: avoids the
// race-prone incremental delete-then-add path, accepts a few percent
// recall miss in the gap between rebuilds. Compute scans the eligible
// corpus on the read handle; the writer inserts the result as a new
// generation beside the live one and publishes it by moving a single
// pointer, so a rebuild never clears what readers are using and never
// holds the write lock for longer than one chunk.
//
// Trigger logic is wall-clock based, NOT OCC-driven: nothing in the
// corpus-ingest cascade marks this job dirty, so an OCC gate would mean
// the DF never rebuilt after the first time. The task fires when the
// active algo's DF has never been built (`built_at IS NULL` — fresh DB or
// post-algo-bump), or when the age tests below say so. OCC capture +
// advance still happens inside compute/apply, for the
// apply-vs-concurrent-bump race window — just not as the trigger.
//
// A tick that decides not to rebuild is idle, so the next one is
// `dfRefreshIdlePeriodMs` away rather than a minute. That is what the
// quiet-hour arm is checked against: the window has to stay wide enough
// that a tick lands inside it, which is why it is a whole hour and not a
// point in time.

/**
 * Where a DF build accumulates before the writer attaches it. One fixed
 * path per install: only one DF refresh runs at a time, so a leftover from
 * an interrupted build is simply overwritten by the next one rather than
 * accumulating.
 */
function dfStagingPath(readDb: { name: string }): string {
  const onDisk = readDb.name && readDb.name !== ":memory:";
  if (onDisk) return join(dirname(readDb.name), "near-dup-df-staging.sqlite");
  // An in-memory database has no directory to sit beside and no identity to
  // share, so give it one per process — otherwise two of them would stage
  // into the same file.
  return join(tmpdir(), `near-dup-df-staging-${process.pid}.sqlite`);
}

function removeDfStaging(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } catch {
      // Disk to reclaim later, not a reason to fail a completed build.
    }
  }
}

const DF_CHUNK_SIZE = 500;
const MIN_DF_TO_PERSIST = 2;

export function nearDupDfRefreshTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const { writeGate, ioGate, cpuGate, log, trackers, getNearDupConfig, dfCacheRef, readDb } = opts;
  const derivedStoreKey = opts.derivedStoreKey;
  const taskName = "backfill.nearDupDfRefresh";
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: 60_000,
    idlePeriodMs: getNearDupConfig().scheduler.dfRefreshIdlePeriodMs,
    startDelayMs: 120_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        const config = getNearDupConfig();
        if (!config.enabled) return { idle: true };
        const builtAt = await ioGate.nearDupDfBuiltAt(config.algorithm.algoVersion);
        const now = new Date();
        const nowSec = Math.floor(now.getTime() / 1000);
        const isFreshAlgo = builtAt === null;
        const ageSec = builtAt === null ? Number.POSITIVE_INFINITY : nowSec - builtAt;
        // What the DF table is: for every distinct shingle, how many
        // documents contain it — a statistic over the whole corpus, used to
        // weigh a rare phrase above a common one. A few hundred new
        // documents move no per-shingle count enough to change which pairs
        // are near-duplicates, so a bare timer spends a full corpus scan
        // and its memory peak to reach almost exactly the table it already
        // had.
        //
        // What actually wants a fresh statistic is a new FILE — the
        // documents duplicate detection is really for, since files get
        // re-uploaded, re-attached and synced between sources. So: rebuild
        // when a file-like document has arrived and the table is at least
        // `dfRefreshPeriodMs` old, and otherwise once `dfMaxAgeMs` has
        // passed, in `dfQuietHourLocal`, where half an hour of CPU costs
        // nobody anything.
        //
        // Detection itself is unaffected and stays immediate: a new
        // document is signed and matched through the near-dup inbox within
        // seconds. This decides only how current the weighting is.
        const filesArrived =
          builtAt === null
            ? true
            : await ioGate.nearDupFileLikeDocsSince(builtAt, [...config.fileLikeDocTypes]);
        const sched = config.scheduler;
        const fileTriggered = filesArrived && ageSec * 1000 >= sched.dfRefreshPeriodMs;
        const dailyDue =
          ageSec * 1000 >= sched.dfMaxAgeMs && now.getHours() === sched.dfQuietHourLocal;
        if (!isFreshAlgo && !fileTriggered && !dailyDue) {
          trackers.nearDupDfRefresh.recordSweepCompleted();
          return { idle: true };
        }

        trackers.nearDupDfRefresh.recordSweepStarted();
        const startMs = Date.now();
        const eligibleDocTypes = [...config.eligibleDocTypes];

        // Capture OCC version once upfront before any chunk fetching
        const capturedVersion = await ioGate.captureDfOccVersion();

        // Phase 2: page the corpus → shingle on the CPU pool → merge
        // counts into the accumulator.
        //
        // Accumulate into a file next to the database rather than into
        // this process. The corpus yields tens of millions of distinct
        // shingles before pruning; held in memory they are held in RSS, and
        // the writer then needed its own copy of the survivors. On a file,
        // the writer reads the result by attaching it.
        const stagingPath = dfStagingPath(readDb);
        removeDfStaging(stagingPath);
        const staging = new NearDupDfStagingWorker({
          stagingPath,
          ...(derivedStoreKey ? { stagingKey: derivedStoreKey } : {}),
          ...(opts.backgroundWorkerNice !== undefined
            ? { backgroundWorkerNice: opts.backgroundWorkerNice }
            : {}),
        });
        try {
          let afterId: string | null = null;
          for (;;) {
            // Fetch a page of doc content (IO on compute worker)
            const page = await ioGate.fetchDfDocChunk(
              eligibleDocTypes,
              config.minContentLength,
              config.maxContentLength,
              afterId,
              DF_CHUNK_SIZE,
            );
            if (page.length === 0) break;
            afterId = page[page.length - 1].id;
            const contents = page.map((row) => row.content);

            // Dispatch per-doc shingle extraction in parallel across CPU pool
            const perDocResults = await Promise.all(
              contents.map((content) =>
                cpuGate.extractDfChunk({
                  contents: [content],
                  shingleSize: config.algorithm.shingleSize,
                  stripQuotes: config.algorithm.stripQuotes,
                }),
              ),
            );

            // The proxy bounds flattening + IPC into acknowledged slices, and
            // the dedicated worker alone owns the SQLite handle.
            await staging.add(perDocResults);
          }
          const { totalDocs, uniqueShingles } = await staging.finish(MIN_DF_TO_PERSIST);
          const computedMs = Date.now() - startMs;

          // Phase 3: apply, by attaching the staging file on the writer.
          const { rebuilt } = await writeGate.applyNearDupDfFromStaging({
            stagingPath,
            ...(derivedStoreKey ? { stagingKeyHex: derivedStoreKey.toString("hex") } : {}),
            algoVersion: config.algorithm.algoVersion,
            totalDocs,
            minDf: MIN_DF_TO_PERSIST,
            capturedVersion,
            expectedRows: uniqueShingles,
          });
          dfCacheRef.current = null;
          const tookMs = Date.now() - startMs;
          trackers.nearDupDfRefresh.recordSweepCompleted({
            affected: rebuilt,
            checked: uniqueShingles,
          });
          log.info(
            `near-dup DF refresh (${isFreshAlgo ? "fresh-algo" : "stale"}): ${totalDocs} docs, ${uniqueShingles} unique shingles, ${rebuilt} rows in ${tookMs}ms (compute=${computedMs}ms)`,
          );
          return { idle: false };
        } finally {
          try {
            await staging.dispose();
          } finally {
            // Unconditionally: this file holds document text, and a build that
            // failed part-way has no claim to leave gigabytes of it on disk.
            removeDfStaging(stagingPath);
          }
        }
      });
    },
  };
}

// ── Near-dup algo sweep ───────────────────────────────────────────────
//
// One-shot cleanup pass after an algo bump. Loops over the four
// near-dup tables deleting rows tagged with non-active algos in
// chunks of `algoSweepChunkSize`. Idle once a pass finds nothing.

export function nearDupAlgoSweepTask(
  opts: BackfillTaskOptsInternal,
): PeriodicTask<unknown, IdleResult> {
  const { writeGate, log, trackers, getNearDupConfig } = opts;
  const taskName = "backfill.nearDupAlgoSweep";
  return {
    name: taskName,
    runner: "main",
    priority: "background",
    periodMs: 30_000,
    idlePeriodMs: 60 * 60_000,
    // Wait until the boot algo-bump has had a chance to land — running
    // the sweep before bumpNearDupAlgo writes the new active row would
    // wipe legitimately fresh rows.
    startDelayMs: 60_000,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run() {
      return runBackfillTick(taskName, log, async () => {
        trackers.nearDupAlgoSweep.recordSweepStarted();
        const config = getNearDupConfig();
        const startMs = Date.now();
        // The stale-ALGO pass, once per tick. It is guarded so that when
        // no bump is outstanding it costs a primary-key seek rather than a
        // read of the table.
        const algo = await writeGate.nearDupAlgoSweepStep(config);
        let cleared = algo.cleared;
        let done = algo.done;

        // Superseded GENERATIONS are a range on the primary key's own
        // prefix, so a chunk costs no table read. That is what makes it
        // safe to repeat, and repeating is what keeps the reclaim rate
        // ahead of rebuilds — one chunk per tick would let a corpus that
        // rebuilds every few hours grow a generation faster than the sweep
        // retires it. The bound stays small even so: every chunk is a
        // writer op on the background lane, and a tick that filled that
        // lane would stall the writer's heartbeat and starve the indexer
        // sharing it.
        for (let step = 0; step < config.scheduler.algoSweepStepsPerTick; step += 1) {
          const gen = await writeGate.nearDupGenerationSweepStep(config);
          cleared += gen.cleared;
          if (gen.done) break;
          done = false;
        }
        const tookMs = Date.now() - startMs;
        trackers.nearDupAlgoSweep.recordSweepCompleted({ affected: cleared });
        if (cleared > 0) {
          log.info(`near-dup algo sweep: ${cleared} stale rows in ${tookMs}ms`);
        }
        // Idle only when the table is actually clean; otherwise the next
        // tick picks up where the budget stopped.
        return { idle: done };
      });
    },
  };
}

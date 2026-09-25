// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Read-side service for the operator Cognition HTTP surface.
 *
 * Route collaborators parse HTTP input and shape responses; every database
 * and transcript-store read stays here so the route layer has no repository
 * knowledge.
 */

import { parseSourceKey, type CognitionDocumentRef } from "@omnesis/core";
import { getDocumentTitlesAndSources } from "../db.js";
import { mutableListRevision, type MutableListRevisionScope } from "../data/list-revisions.js";
import {
  listTemporalAnnotations,
  temporalAnnotationStats,
} from "../enrichment/temporal-annotations/storage.js";
import { artifactProvenance } from "./artifact-provenance.js";
import { displayPersonRefs } from "./person-refs.js";
import { countBootstrapProcessed } from "./storage/bootstrap.js";
import {
  readBootstrapStatus,
  readBootstrapBacklog,
  readBootstrapTimeline,
} from "./bootstrap-status.js";
import { listLiveBriefClaims } from "./storage/brief-claims.js";
import { getBrief, listBriefs, listBriefsForLoop } from "./storage/briefs.js";
import { listCognitionCoverage } from "./storage/coverage.js";
import { getOpenLoop, listOpenLoopLedger, listOpenLoops } from "./storage/open-loops.js";
import { readCognitionNotes } from "./storage/notes.js";
import { listRetiredLoops } from "./storage/retired-loops.js";
import {
  getCognitionRun,
  getCognitionRunsByIds,
  listCognitionRuns,
  listRecentSettledCognitionRuns,
  listUpcomingCognitionRuns,
} from "./storage/run-queue.js";
import {
  listCognitionSpendDayTotals,
  cognitionSpendDay,
  getCognitionSpendDayTotal,
} from "./storage/spend.js";
import {
  FsCognitionTranscriptStore,
  type CognitionRunTranscript,
  type CognitionTranscriptCursor,
} from "./transcripts.js";
import {
  cognitionBudgetVerdict,
  type CognitionBudgetSettings,
  type CognitionBudgetVerdict,
} from "./cognition/budget.js";
import type {
  BootstrapTimeline,
  BootstrapTimelineReader,
  BootstrapBacklog,
  BootstrapBacklogReader,
  BootstrapSettingsView,
  BootstrapStatus,
} from "./bootstrap-status.js";
import type Database from "better-sqlite3";

/** Today's background-cognition spend against whatever ceiling is set. */
export interface BrainBudgetStatus {
  settings: CognitionBudgetSettings;
  /** The local-day bucket the counters below belong to. */
  day: string;
  /**
   * What the ceiling is measured against: prompt + completion, undifferentiated.
   * Enforcement stays on this deliberately — a limit an operator sets has to be
   * a number they can predict, not one that moves with how well the prompt
   * cached that day.
   */
  usedTokens: number;
  usedRuns: number;
  /**
   * The same spend, split by what it actually costs.
   *
   * `cacheRead` is a SUBSET of `prompt`, not additional — the provider re-read
   * a prefix it already held, typically at a fraction of the price of fresh
   * input. Collapsing the two hides the largest cost lever this workload has:
   * on a corpus-wide backfill most of every prompt is a cached prefix, so a
   * flat token count reports a bill several times the real one and, worse,
   * barely moves when the hit rate collapses.
   */
  breakdown: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** `prompt - cacheRead`: the part that was genuinely read for the first time. */
    freshInputTokens: number;
    /** Cached share of prompt, 0..1. Null when nothing was read at all. */
    cacheHitRate: number | null;
  };
  verdict: CognitionBudgetVerdict;
}

export interface RunActivityReader {
  startedAtMs(id: string): number | null;
  runningIds?(): string[];
}

/**
 * The gateway's name for the document reference it serves on this wire. One
 * declaration, in core, because the CLI and the portal render the same shape
 * and a second copy here is how the two drift.
 */
export type CognitionAdminDocumentRef = CognitionDocumentRef;

function sourceType(sourceId: string): string | null {
  try {
    return parseSourceKey(sourceId).sourceType;
  } catch {
    return null;
  }
}

export class CognitionAdminQueryService {
  private readonly transcripts: FsCognitionTranscriptStore | null;

  /**
   * Approximately when this process started — this service is constructed as
   * the routes mount, within seconds of the lane composing its own origin.
   *
   * Exactness does not matter, because it is only consulted for the sliver of
   * time before the lane's first pass stamps `bootstrap_hold_since`. From that
   * moment the stamped instant is authoritative and this is unused, so the two
   * clocks cannot drift into disagreeing about a hold that is actually running.
   *
   * Supplied by the mount from the same injected clock the lane composes its
   * own origin from — never read from the wall, which the brain's clock
   * discipline forbids and a virtual-clock run would be broken by.
   */
  private readonly startedAt: number;

  constructor(
    private readonly db: Database.Database,
    transcriptsDir: string | undefined,
    private readonly activity: RunActivityReader | undefined,
    startedAt?: number,
  ) {
    this.transcripts = transcriptsDir ? new FsCognitionTranscriptStore(transcriptsDir) : null;
    // Zero, not a wall-clock reading: the brain reads time only through its
    // injected clock, so that a virtual-clock run stays authoritative. A
    // caller that can supply the real origin passes it; absent one, an origin
    // in the distant past simply means "no boot hold", which is the safe
    // reading — it never invents a hold that is not happening.
    this.startedAt = startedAt ?? 0;
  }

  paginationRevision(scope: MutableListRevisionScope): number {
    return mutableListRevision(this.db, scope);
  }

  pulse(now: number) {
    const counts = this.db
      .prepare<
        [number, number, number],
        {
          queuedRuns: number;
          upcomingRuns: number;
          totalRuns: number;
          openLoops: number;
          snoozedLoops: number;
          totalLoops: number;
          unreadBriefs: number;
          totalBriefs: number;
          failedRuns24h: number;
        }
      >(
        `SELECT
           (SELECT COUNT(*) FROM cognition_runs
             WHERE status = 'pending' AND next_attempt_at <= ?) AS queuedRuns,
           (SELECT COUNT(*) FROM cognition_runs
             WHERE status = 'pending' AND next_attempt_at > ?) AS upcomingRuns,
           (SELECT COUNT(*) FROM cognition_runs) AS totalRuns,
           (SELECT COUNT(*) FROM open_loops WHERE state = 'open') AS openLoops,
           (SELECT COUNT(*) FROM open_loops WHERE state = 'snoozed') AS snoozedLoops,
           (SELECT COUNT(*) FROM open_loops) AS totalLoops,
           (SELECT COUNT(*) FROM briefs WHERE state = 'unread') AS unreadBriefs,
           (SELECT COUNT(*) FROM briefs) AS totalBriefs,
           (SELECT COUNT(*) FROM cognition_runs
             WHERE status = 'failed' AND completed_at >= ?) AS failedRuns24h`,
      )
      .get(now, now, now - 24 * 60 * 60 * 1000)!;
    const runningRows = getCognitionRunsByIds(this.db, this.activity?.runningIds?.() ?? []);
    const runningDuePending = runningRows.filter(
      (run) => run.status === "pending" && run.nextAttemptAt <= now,
    ).length;
    counts.queuedRuns = Math.max(0, counts.queuedRuns - runningDuePending);
    return {
      counts,
      runningRows,
      upcomingRuns: listUpcomingCognitionRuns(this.db, now, 10),
      recentSettledRuns: listRecentSettledCognitionRuns(this.db, 10),
    };
  }

  listLoops(options: Parameters<typeof listOpenLoops>[1]) {
    return listOpenLoops(this.db, options);
  }

  getLoop(id: string) {
    return getOpenLoop(this.db, id);
  }

  listLoopLedger(id: string, options?: Parameters<typeof listOpenLoopLedger>[2]) {
    return listOpenLoopLedger(this.db, id, options);
  }

  listLoopBriefs(id: string, options?: Parameters<typeof listBriefsForLoop>[2]) {
    return listBriefsForLoop(this.db, id, options);
  }

  listRuns(options: Parameters<typeof listCognitionRuns>[1]) {
    return listCognitionRuns(this.db, options);
  }

  getRun(id: string) {
    return getCognitionRun(this.db, id);
  }

  listBriefs(options: Parameters<typeof listBriefs>[1]) {
    return listBriefs(this.db, options);
  }

  getBrief(id: string) {
    return getBrief(this.db, id);
  }

  listRetiredLoops(options: Parameters<typeof listRetiredLoops>[1]) {
    return listRetiredLoops(this.db, options);
  }

  listSpend(options: Parameters<typeof listCognitionSpendDayTotals>[1]) {
    return listCognitionSpendDayTotals(this.db, options);
  }

  listCoverage(options: Parameters<typeof listCognitionCoverage>[1]) {
    return listCognitionCoverage(this.db, options);
  }

  bootstrapProcessedCount(): number {
    return countBootstrapProcessed(this.db);
  }

  /**
   * What background cognition has spent today, against whatever ceiling is
   * set.
   *
   * Reported in tokens and runs and nothing else. Currency is deliberately
   * absent everywhere in the Brain: no first-party inference API exposes a
   * price, so any figure in money would be an unverifiable estimate standing
   * between the operator and a large spend — see the note on
   * `cognitionBudgetVerdict`.
   */
  budget(settings: CognitionBudgetSettings, now: number): BrainBudgetStatus {
    const total = getCognitionSpendDayTotal(this.db, cognitionSpendDay(now));
    const promptTokens = total?.promptTokens ?? 0;
    const cacheReadTokens = total?.cacheReadTokens ?? 0;
    return {
      settings,
      day: cognitionSpendDay(now),
      usedTokens: promptTokens + (total?.completionTokens ?? 0),
      usedRuns: total?.runs ?? 0,
      breakdown: {
        promptTokens,
        completionTokens: total?.completionTokens ?? 0,
        cacheReadTokens,
        cacheCreationTokens: total?.cacheCreationTokens ?? 0,
        // Clamped: a provider reporting more cached than prompted would
        // otherwise render as negative fresh input, which is not a thing.
        freshInputTokens: Math.max(0, promptTokens - cacheReadTokens),
        cacheHitRate: promptTokens > 0 ? cacheReadTokens / promptTokens : null,
      },
      verdict: cognitionBudgetVerdict(this.db, settings, now),
    };
  }

  /**
   * The retrospective lane's live state. `startedAt` is this process's start,
   * which is what the lane's boot hold is measured against.
   */
  bootstrapStatus(settings: BootstrapSettingsView, now: number): BootstrapStatus {
    return readBootstrapStatus(this.db, settings, { now, startedAt: this.startedAt });
  }

  /**
   * The backlog, off the main loop. Routed through here for the same reason
   * every other read is — a route holds no database knowledge — even though
   * the work itself happens on the io worker rather than this handle.
   */
  bootstrapBacklog(
    io: BootstrapBacklogReader,
    opts: { now: () => number; recencyWindowMs: number },
  ): Promise<BootstrapBacklog> {
    return readBootstrapBacklog(io, opts);
  }

  /** The corpus month by month, off the main loop. See `bootstrapBacklog`. */
  bootstrapTimeline(
    io: BootstrapTimelineReader,
    opts: { now: () => number; recencyWindowMs: number },
  ): Promise<BootstrapTimeline> {
    return readBootstrapTimeline(io, opts);
  }

  listTemporal(options: Parameters<typeof listTemporalAnnotations>[1]) {
    return listTemporalAnnotations(this.db, options);
  }

  temporalStats() {
    return temporalAnnotationStats(this.db);
  }

  readNotes(): string {
    return readCognitionNotes(this.db);
  }

  documentRefs(docIds: readonly string[]): CognitionAdminDocumentRef[] {
    const found = getDocumentTitlesAndSources(this.db, [...docIds]);
    return docIds.map((id) => {
      const doc = found.get(id);
      return doc
        ? { id, title: doc.title, sourceType: sourceType(doc.sourceId) }
        : { id, title: null, sourceType: null };
    });
  }

  sourceType(sourceId: string): string | null {
    return sourceType(sourceId);
  }

  personRefs(refs: readonly string[]) {
    return displayPersonRefs(this.db, refs);
  }

  provenance(runId: string) {
    return artifactProvenance(this.db, runId);
  }

  briefClaims(briefId: string) {
    const claims = listLiveBriefClaims(this.db, briefId);
    const evidence = this.documentRefs(claims.map((claim) => claim.evidenceDocId));
    return claims.map((claim, index) => ({ claim, evidenceDoc: evidence[index]! }));
  }

  activityReader(): RunActivityReader | undefined {
    return this.activity;
  }

  transcriptRef(fileName: string) {
    return this.transcripts?.ref(fileName) ?? null;
  }

  listTranscripts(options: { limit: number; before?: CognitionTranscriptCursor; runId?: string }) {
    return (
      this.transcripts?.listPageWithStatus(options) ??
      Promise.resolve({ items: [], indexComplete: true })
    );
  }

  listTranscriptsForRun(runId: string) {
    return (
      this.transcripts?.listForRunWithStatus(runId) ??
      Promise.resolve({ items: [], indexComplete: true })
    );
  }

  loadTranscript(fileName: string): Promise<CognitionRunTranscript> {
    if (!this.transcripts) {
      return Promise.reject(Object.assign(new Error("transcript not found"), { code: "ENOENT" }));
    }
    return this.transcripts.loadAsync(fileName);
  }
}

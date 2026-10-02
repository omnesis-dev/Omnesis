// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { analyticsDeleteKey, SnapshotEnumeration } from "@omnesis/source-sdk";
import { activitySchemas } from "./schemas.js";
import { activityToDocument, activityToRecord } from "./normalizer.js";
import {
  COMPARED_COLUMNS,
  computeSummaryHash,
  movedCounters,
  summaryEdited,
} from "./normalizer-detail.js";
import {
  syncDetailBackfill,
  syncSocialBackfill,
  syncZonesBackfill,
  syncStreamsBackfill,
  syncEnrichPending,
} from "./enrichment.js";
import { syncAthleteRefresh, shouldRefreshAthlete } from "./athlete-refresh.js";
import { gearDisplayName, storedGear } from "./gear.js";
import { activityIdList } from "./sql.js";
import { quotaDeferral, requireEnrichmentBudget, StravaQuotaDeferral } from "./client.js";
import type {
  SourceAnalyticsAccess,
  StructuredSyncResult,
  SyncProgress,
  TableWrite,
} from "@omnesis/source-sdk";
import type { StravaActivitiesCursor, StravaSummaryActivity } from "./types.js";
import type { StravaClient } from "./client.js";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";
import type { ResolvedGear } from "./normalizer.js";

const log = createLogger("source:strava-activities");

const PAGE_SIZE = 100;
const TABLE_NAME = "strava_activities";

/** 24h cadence for the snapshot rewalk. */
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 6h cadence for edit-detection sweep. */
const EDIT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const EDIT_SWEEP_DEPTH_DAYS = 30;
const EDIT_SWEEP_DEPTH_MS = EDIT_SWEEP_DEPTH_DAYS * 24 * 60 * 60 * 1000;

/**
 * Strava Activities — hybrid structured source.
 *
 * Emits one DuckDB row + one searchable document per activity, with five
 * enrichment phases that fan out from the summary import to fetch
 * description, splits, best efforts, segment efforts, laps, comments,
 * kudoers, zones, and per-second streams. See `types.ts` for the full
 * phase machine documentation.
 */
export class StravaActivitiesSource {
  constructor(
    private client: StravaClient,
    private sourceId: SourceId,
    private providerId: ProviderId,
    private dataCutoff?: string,
    private athleteName?: string,
    private athleteId?: number,
    private analytics?: SourceAnalyticsAccess,
  ) {}

  async syncStructured(
    cursor: StravaActivitiesCursor | null,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    const result = await this.syncPage(cursor);
    if (result.analytics === undefined) return result;
    const withOwner = (write: TableWrite): TableWrite => {
      if (
        !activitySchemas.some(
          (schema) =>
            schema.tableName === write.tableName && schema.sharedDiscriminatorParent !== undefined,
        ) ||
        !write.records?.length
      )
        return write;
      if (this.athleteId === undefined)
        throw new Error("Activity children require an owning athlete");
      return {
        ...write,
        records: write.records.map((record) => ({ ...record, source_athlete_id: this.athleteId })),
      };
    };
    return {
      ...result,
      analytics:
        "tableName" in result.analytics
          ? withOwner(result.analytics)
          : result.analytics.map(withOwner),
    };
  }

  private async syncPage(
    cursor: StravaActivitiesCursor | null,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    const cur: StravaActivitiesCursor = cursor ?? {
      phase: "backfill",
      backfillBefore: Math.floor(Date.now() / 1000),
      backfillPage: 1,
      lastActivityTimestamp: undefined,
    };

    if (cur.phase === "backfill") return this.syncBackfill(cur);
    // A walk under way. Its pages are paced like enrichment's, so a page the
    // budget refuses lists new activities instead and keeps the walk's place.
    if (cur.phase === "snapshot-rewalk")
      return this.enrichOrList(cur, () => this.syncSnapshotRewalk(cur));
    if (cur.phase === "edit-sweep") return this.enrichOrList(cur, () => this.syncEditSweep(cur));

    const walk = await this.dueWalk(cur);
    if (walk) return walk;

    if (cur.phase === "athlete-refresh")
      return this.enrichOrList(cur, () => this.dispatchAthleteRefresh(cur));
    if (cur.phase === "detail-backfill")
      return this.enrichOrList(cur, () => this.dispatchDetail(cur));
    if (cur.phase === "social-backfill")
      return this.enrichOrList(cur, () => this.dispatchSocial(cur));
    if (cur.phase === "zones-backfill")
      return this.enrichOrList(cur, () => this.dispatchZones(cur));
    if (cur.phase === "streams-backfill")
      return this.enrichOrList(cur, () => this.dispatchStreams(cur));
    if (cur.phase === "enrich-pending")
      return this.enrichOrList(cur, () => this.dispatchEnrichPending(cur));

    // `incremental` — the rest of the priority chain, after the walks above.
    // Not through `enrichOrList`: a refused page here falls through to the
    // listing below, which would otherwise run twice.
    if (this.analytics && this.athleteId !== undefined) {
      if (shouldRefreshAthlete(cur)) {
        const refreshed = await this.unlessRefused(() =>
          this.dispatchAthleteRefresh({ ...cur, phase: "athlete-refresh" }),
        );
        if (refreshed) return refreshed;
      } else {
        // Nothing time-gated is due — opportunistically run enrich-pending.
        // With nothing pending it hands back `incremental`, and a page the
        // budget refused hands back nothing; either way the listing runs.
        const enriched = await this.unlessRefused(() =>
          this.dispatchEnrichPending({ ...cur, phase: "enrich-pending" }),
        );
        if (enriched && enriched.cursor.phase !== "incremental") return enriched;
      }
    }
    return this.syncIncremental(cur);
  }

  /**
   * A page of enrichment or of a walk, or a listing of new activities in its
   * place when the rate-limit budget refuses it.
   *
   * The listing keeps the cursor's phase. It is a detour, not a step in the
   * phase machine, so the next page goes back to the refused work where it
   * stopped: the same tier (a refused page never advanced `enrichTier`), the
   * same pending marks, the same gear and the same walk page. Parking the
   * source instead would hold new activities back with the backlog, until UTC
   * midnight once a backlog had spent the day, or until the whole backlog had
   * drained.
   */
  private async enrichOrList(
    cur: StravaActivitiesCursor,
    page: () => Promise<StructuredSyncResult<StravaActivitiesCursor>>,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    const enriched = await this.unlessRefused(page);
    if (enriched) return enriched;
    // A full listing page reports `hasMore` and has moved the high-water mark
    // up to the newest activity on it, so the detour pages forward and cannot
    // spin.
    const { result: listed, walked } = await this.listNew(cur);
    return {
      ...listed,
      cursor: {
        ...listed.cursor,
        phase: cur.phase,
        // A rewalk under way names what the listing walked, or its snapshot
        // would leave it out: the walk's pages end at the `before` it was
        // pinned to, and the activities the listing finds are newer. Every one
        // walked, not only those written: one the store already holds as
        // listed, such as one a crash had kept from committing its cursor, is
        // still there.
        ...(cur.phase === "snapshot-rewalk" && {
          snapshotIds: [...(cur.snapshotIds ?? []), ...walked],
        }),
      },
    };
  }

  /**
   * The snapshot rewalk or the edit sweep, when one is due, entered from the
   * phase the cursor is in, to which it hands the cursor back when it ends.
   *
   * From every phase, not `incremental` alone: a backlog holds the cursor in
   * the athlete refresh, a tier phase or `enrich-pending` until it drains, which
   * after a first import or a resync takes days, and deletions, edits and late
   * uploads reach the store through these two walks only. Each stamps its
   * cadence when it ends, so the phase it hands back to does not find it due
   * again: a walk interrupts once per cadence, not on every page.
   *
   * A walk the budget refuses is passed over rather than parked or listed in
   * place of: the cursor stays where it was and the phase's own page runs, or
   * gives way to the listing, as it would have, so a refused walk holds back
   * neither the backlog nor new activities. The next page asks again.
   *
   * Not while a detail page's completion marks are still to be written. A mark
   * re-reads the row it marks, and a walk that had written an edited summary
   * over it in between, its detail columns empty and to be fetched again, would
   * have that row marked done as it stood. The marks take one page; the walk
   * follows it. The social tier's marks can wait far longer, behind the budget,
   * so a walk does not wait for them but passes over the rows they name (see
   * `buildOutputs`).
   */
  private async dueWalk(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor> | undefined> {
    if (cur.pendingDetailStamps?.length) return undefined;
    // What runs when the budget refuses a walk, for the log.
    const instead = `carrying on with ${cur.phase}`;
    if (this.shouldStartSnapshot(cur)) {
      const walked = await this.unlessRefused(
        () =>
          this.syncSnapshotRewalk({
            ...cur,
            phase: "snapshot-rewalk",
            resumePhase: cur.phase,
            snapshotBefore: Math.floor(Date.now() / 1000),
            snapshotPage: 1,
            snapshotIds: [],
          }),
        instead,
      );
      if (walked) return walked;
    }
    if (this.shouldStartEditSweep(cur)) {
      const swept = await this.unlessRefused(
        () =>
          this.syncEditSweep({
            ...cur,
            phase: "edit-sweep",
            resumePhase: cur.phase,
            editSweepAfter: Math.floor(Date.now() / 1000) - Math.floor(EDIT_SWEEP_DEPTH_MS / 1000),
            editSweepPage: 1,
          }),
        instead,
      );
      if (swept) return swept;
    }
    return undefined;
  }

  /**
   * Runs `page`, or returns `undefined` when its budget gate refused it. The
   * gates refuse before the page's first call, so nothing was spent and
   * nothing is lost. Any other error, a 429 Strava sent included, still ends
   * the tick. `instead` names, for the log, what the caller runs in its place.
   */
  private async unlessRefused(
    page: () => Promise<StructuredSyncResult<StravaActivitiesCursor>>,
    instead = "listing new activities instead",
  ): Promise<StructuredSyncResult<StravaActivitiesCursor> | undefined> {
    try {
      return await page();
    } catch (err) {
      if (!(err instanceof StravaQuotaDeferral)) throw err;
      log.info(`${err.message}; ${instead}`);
      return undefined;
    }
  }

  private shouldStartSnapshot(cur: StravaActivitiesCursor): boolean {
    if (!cur.lastSnapshotAt) return true;
    return Date.now() - new Date(cur.lastSnapshotAt).getTime() >= SNAPSHOT_INTERVAL_MS;
  }

  private shouldStartEditSweep(cur: StravaActivitiesCursor): boolean {
    if (!cur.lastEditSweepAt) return true;
    return Date.now() - new Date(cur.lastEditSweepAt).getTime() >= EDIT_SWEEP_INTERVAL_MS;
  }

  // ── Backfill ──────────────────────────────────────────────────────

  private async syncBackfill(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    const page = cur.backfillPage ?? 1;
    const before = cur.backfillBefore ?? Math.floor(Date.now() / 1000);
    const after = dataCutoffToUnix(this.dataCutoff);

    const activities = await this.client.listActivities({
      before,
      after,
      page,
      per_page: PAGE_SIZE,
    });
    // The page's gear stays unresolved: the catalogue is the refresh's, which
    // follows the backfill, and the detail tier after it names the gear of
    // every activity written here (see `catalogued`).
    const { records, documents, newestUnix } = this.buildOutputs(activities);

    const newLast = Math.max(cur.lastActivityTimestamp ?? 0, newestUnix ?? 0);
    const endOfBackfill = activities.length < PAGE_SIZE;

    const newCursor: StravaActivitiesCursor = endOfBackfill
      ? {
          // After backfill, chain through enrichment tiers (gateway-gated).
          // Without a gateway (unit tests), skip straight to incremental —
          // there's no analytics DB to query for pending rows.
          phase: this.analytics && this.athleteId !== undefined ? "athlete-refresh" : "incremental",
          lastActivityTimestamp: newLast > 0 ? newLast : undefined,
          // Backfill IS a full re-walk so it covers snapshot + edit-sweep
          // responsibilities. Stamp both.
          lastSnapshotAt: new Date().toISOString(),
          lastEditSweepAt: new Date().toISOString(),
        }
      : {
          ...cur,
          backfillBefore: before,
          backfillPage: page + 1,
          lastActivityTimestamp: newLast > 0 ? newLast : cur.lastActivityTimestamp,
        };

    log.info(`Backfill page ${page}: ${activities.length} activities (end=${endOfBackfill})`);

    const progress: SyncProgress = {
      phase: "bootstrap",
      processed: (page - 1) * PAGE_SIZE + activities.length,
    };

    return {
      analytics: { tableName: TABLE_NAME, records },
      documents,
      cursor: newCursor,
      hasMore: !endOfBackfill,
      progress,
    };
  }

  // ── Incremental ───────────────────────────────────────────────────

  private async syncIncremental(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    return (await this.listNew(cur)).result;
  }

  /** A page of the listing, and the ids of the activities it walked. */
  private async listNew(
    cur: StravaActivitiesCursor,
  ): Promise<{ result: StructuredSyncResult<StravaActivitiesCursor>; walked: string[] }> {
    // The listing keeps the source current and is what a refused enrichment
    // page falls back on, so it draws on the whole safety cap rather than
    // enrichment's share. When not even one call fits, it waits for one call,
    // the earliest anything here can run, not for a page.
    if (!this.client.quota.canMakeNCalls(1)) {
      throw quotaDeferral("Incremental", 1, this.client.quota);
    }
    const after = Math.max(cur.lastActivityTimestamp ?? 0, dataCutoffToUnix(this.dataCutoff) ?? 0);

    // Sent even when it is 0. Strava lists newest first unless it is given an
    // `after`, and this phase pages by moving its mark to the newest activity a
    // page holds, which steps forward only through a list that comes oldest
    // first. Newest first, the first page would move the mark past everything
    // the later pages hold, and an account whose backfill found nothing would
    // keep only the newest page of what arrived next.
    const activities = await this.client.listActivities({
      after,
      page: 1,
      per_page: PAGE_SIZE,
    });

    // Compared with the store like the edit sweep, because this phase can hand
    // back an activity it has already ingested: `after` is a second-resolution
    // high-water mark, so anything starting on that exact second comes round
    // again. Re-ingesting one costs more than a duplicate row — a summary
    // write carries no enrichment, so it clears the `*_fetched_at` stamps and
    // sends an already-enriched activity back for another detail fetch.
    // An activity that is genuinely new has no stored row and is emitted.
    const { records, documents, newestUnix } = await this.againstStore(cur, activities);
    const hasMore = activities.length === PAGE_SIZE;
    const newLast = Math.max(cur.lastActivityTimestamp ?? 0, newestUnix ?? 0);

    log.info(`Incremental: ${activities.length} activities (hasMore=${hasMore})`);

    const newCursor: StravaActivitiesCursor = {
      ...cur,
      phase: "incremental",
      lastActivityTimestamp: newLast > 0 ? newLast : cur.lastActivityTimestamp,
    };

    return {
      result: {
        analytics: { tableName: TABLE_NAME, records },
        documents,
        cursor: newCursor,
        hasMore,
        progress: { phase: "incremental", processed: activities.length },
      },
      walked: activities.map((a) => String(a.id)),
    };
  }

  // ── Snapshot rewalk ───────────────────────────────────────────────

  /**
   * Walks the whole history, pinned to the `before` it started at, so the
   * gateway learns which activities are gone, and writes what it reads that the
   * store lacks or holds differently.
   *
   * Strava's `after` filters on the start time, so the listing never sees an
   * activity uploaded with a start behind its mark — a watch synced after weeks
   * offline, a run logged by hand, a history imported from elsewhere — and the
   * edit sweep reaches back only so far; both reach the store through this walk
   * alone. It never moves the mark, which belongs to the listing: the walk
   * pages by number under its pinned `before`, not forward in start time.
   * Without a store to compare with, every activity would read as new on every
   * walk, so it only enumerates.
   *
   * One read per hundred activities, so its cost grows with the history. It is
   * drawn from enrichment's share of the budget rather than the listing's, and
   * on a day a backlog has spent that share it waits while the listing goes on.
   */
  private async syncSnapshotRewalk(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    const page = cur.snapshotPage ?? 1;
    requireEnrichmentBudget(`Snapshot rewalk page ${page}`, 1, this.client.quota);
    const before = cur.snapshotBefore ?? Math.floor(Date.now() / 1000);
    const after = dataCutoffToUnix(this.dataCutoff);

    const activities = await this.client.listActivities({
      before,
      after,
      page,
      per_page: PAGE_SIZE,
    });
    const { records, documents } = this.analytics
      ? await this.againstStore(cur, activities)
      : { records: [], documents: [] };
    const ids = activities.map((a) => String(a.id));
    const accumulated = [...(cur.snapshotIds ?? []), ...ids];
    const endOfRewalk = activities.length < PAGE_SIZE;

    if (endOfRewalk) {
      // One partition — the account's activity list. The rewalk ends on a short
      // page, which is also what a truncated page looks like; that ambiguity is
      // about magnitude, not about whether this read looked everywhere, so it
      // belongs to the gateway's absence handling rather than here. Withholding
      // on it would tell the gateway nothing and cancel the deletion outright.
      const snapshot = new SnapshotEnumeration(["activities"]);
      snapshot.cover("activities", accumulated);
      const presentExternalIds = snapshot.result();
      if (presentExternalIds === undefined) {
        log.warn(snapshot.withheldReason()!);
      } else {
        log.info(
          `Snapshot rewalk complete: page ${page}, ${accumulated.length} activities enumerated, ${records.length} written`,
        );
      }
      const newCursor: StravaActivitiesCursor = {
        ...cur,
        ...handBack(cur),
        lastSnapshotAt: new Date().toISOString(),
        snapshotBefore: undefined,
        snapshotPage: undefined,
        snapshotIds: undefined,
      };
      return {
        cursor: newCursor,
        hasMore: false,
        documents,
        ...(presentExternalIds !== undefined
          ? {
              presentExternalIds,
              issues: [],
              analytics: activitySchemas.map((schema) => ({
                tableName: schema.tableName,
                records: schema.tableName === TABLE_NAME ? records : [],
                presentKeys: presentExternalIds.map((id) => ({
                  [analyticsDeleteKey(schema)[0]!]: id,
                })),
              })),
            }
          : { analytics: { tableName: TABLE_NAME, records } }),
      };
    }

    log.info(`Snapshot rewalk page ${page}: ${activities.length} ids, ${records.length} written`);
    return {
      analytics: { tableName: TABLE_NAME, records },
      documents,
      cursor: {
        ...cur,
        snapshotBefore: before,
        snapshotPage: page + 1,
        snapshotIds: accumulated,
      },
      hasMore: true,
    };
  }

  // ── Edit sweep ────────────────────────────────────────────────────

  /**
   * Re-walks the last 30 days of activities and compares each with the row the
   * analytics DB holds for it (see `againstStore`): unchanged activities are
   * skipped entirely (no record, no document — a true no-op), an activity
   * whose counters alone moved goes back to the social tier only, and one
   * whose summary was edited is re-ingested with its four `*_fetched_at`
   * stamps cleared so it flows back through enrichment. The daily rewalk does
   * the same over the whole history; this walk finds recent changes sooner.
   *
   * Without a gateway we can't read the stored rows to diff against, so —
   * like the other enrichment phases — the sweep is a no-op that hands the
   * cursor back.
   *
   * Paced like the rewalk, from enrichment's share of the budget.
   */
  private async syncEditSweep(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    if (!this.analytics) {
      log.warn("Skipping edit-sweep (no analytics access)");
      return {
        cursor: {
          ...cur,
          ...handBack(cur),
          lastEditSweepAt: new Date().toISOString(),
          editSweepAfter: undefined,
          editSweepPage: undefined,
        },
        hasMore: false,
      };
    }

    const page = cur.editSweepPage ?? 1;
    requireEnrichmentBudget(`Edit sweep page ${page}`, 1, this.client.quota);
    const after = cur.editSweepAfter ?? Math.floor((Date.now() - EDIT_SWEEP_DEPTH_MS) / 1000);
    const dataAfter = dataCutoffToUnix(this.dataCutoff);
    const effectiveAfter = dataAfter !== undefined ? Math.max(after, dataAfter) : after;

    const activities = await this.client.listActivities({
      after: effectiveAfter,
      page,
      per_page: PAGE_SIZE,
    });

    const { records, documents } = await this.againstStore(cur, activities);
    const endOfSweep = activities.length < PAGE_SIZE;

    if (endOfSweep) {
      log.info(
        `Edit sweep complete: page ${page}, ${activities.length} walked, ${records.length} changed/re-ingested`,
      );
      const newCursor: StravaActivitiesCursor = {
        ...cur,
        ...handBack(cur),
        lastEditSweepAt: new Date().toISOString(),
        editSweepAfter: undefined,
        editSweepPage: undefined,
      };
      return {
        analytics: { tableName: TABLE_NAME, records },
        documents,
        cursor: newCursor,
        hasMore: false,
      };
    }

    log.info(`Edit sweep page ${page}: ${activities.length} walked, ${records.length} changed`);
    return {
      analytics: { tableName: TABLE_NAME, records },
      documents,
      cursor: { ...cur, editSweepAfter: after, editSweepPage: page + 1 },
      hasMore: true,
    };
  }

  // ── Enrichment-phase dispatchers (delegate to enrichment.ts) ──────

  private async dispatchDetail(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    if (!this.analytics || this.athleteId === undefined) {
      return this.skipEnrichment(cur);
    }
    const { result } = await syncDetailBackfill(cur, this.deps());
    return result;
  }

  private async dispatchSocial(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    if (!this.analytics || this.athleteId === undefined) return this.skipEnrichment(cur);
    const { result } = await syncSocialBackfill(cur, this.deps());
    return result;
  }

  private async dispatchZones(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    if (!this.analytics || this.athleteId === undefined) return this.skipEnrichment(cur);
    const { result } = await syncZonesBackfill(cur, this.deps());
    return result;
  }

  private async dispatchStreams(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    if (!this.analytics || this.athleteId === undefined) return this.skipEnrichment(cur);
    const { result } = await syncStreamsBackfill(cur, this.deps());
    return result;
  }

  private async dispatchEnrichPending(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    if (!this.analytics || this.athleteId === undefined) return this.skipEnrichment(cur);
    const { result } = await syncEnrichPending(cur, this.deps());
    return result;
  }

  private async dispatchAthleteRefresh(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    if (!this.analytics || this.athleteId === undefined) return this.skipEnrichment(cur);
    // Both entries arrive in `athlete-refresh`, so the phase cannot tell them
    // apart; the stamp can. A cursor that has never finished a refresh is a
    // first setup, such as the one a backfill just built, and chains into
    // enrichment. One that has is the weekly refresh from `incremental`, and
    // goes back there. The refresh stamps only on completion, so one spread
    // over several pages still knows its way back on the last of them.
    const nextPhase: StravaActivitiesCursor["phase"] =
      cur.lastAthleteRefreshAt === undefined ? "detail-backfill" : "incremental";
    return syncAthleteRefresh(cur, nextPhase, {
      analytics: this.analytics,
      client: this.client,
      athleteId: this.athleteId,
    });
  }

  /**
   * Used when the source was instantiated without a gateway/athleteId —
   * happens in unit tests. Without a gateway we can't query the analytics
   * DB to find pending-enrichment rows, so jump straight to `incremental`
   * (no enrichment is the cleanest fallback).
   */
  private skipEnrichment(
    cur: StravaActivitiesCursor,
  ): StructuredSyncResult<StravaActivitiesCursor> {
    log.warn(`Skipping ${cur.phase} (no analytics access)`);
    return {
      cursor: { ...cur, phase: "incremental" },
      hasMore: false,
    };
  }

  private deps() {
    return {
      analytics: this.analytics!,
      client: this.client,
      sourceId: this.sourceId,
      providerId: this.providerId,
      athleteName: this.athleteName,
      athleteId: this.athleteId!,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private buildOutputs(
    activities: StravaSummaryActivity[],
    opts: {
      /**
       * What the store holds of the page's activities, by id, passed by the
       * phases that can be handed an activity they have already ingested.
       */
      stored?: Map<number, Record<string, unknown>>;
      /** The catalogued gear the page's activities name, by gear id. */
      gear?: Map<string, ResolvedGear>;
      /** Activities whose social marks a later page still writes. */
      unmarked?: readonly string[];
    } = {},
  ): {
    records: Record<string, unknown>[];
    documents: DocumentInput[];
    newestUnix: number | undefined;
    /** The listing's counters for each stored activity whose counters alone moved. */
    recounted: Map<number, Record<string, unknown>>;
  } {
    const records: Record<string, unknown>[] = [];
    const documents: DocumentInput[] = [];
    const recounted = new Map<number, Record<string, unknown>>();
    let newestUnix: number | undefined;

    for (const a of activities) {
      // The high-water mark counts every activity **walked**, not every one
      // ingested, and the difference is the whole cursor.
      //
      // `syncIncremental` always asks for page 1 and paginates purely by moving
      // this mark, so a page whose activities were all skipped below would
      // leave the cursor exactly where it was while still reporting `hasMore`.
      // The next call would then ask the same question and get the same page,
      // with nothing in the loop able to notice — a spin at the speed of the
      // API rather than a sync.
      const unix = Math.floor(new Date(a.start_date).getTime() / 1000);
      if (!Number.isNaN(unix) && (newestUnix === undefined || unix > newestUnix)) {
        newestUnix = unix;
      }

      // Resolved here as well as by the refresh: the record replaces the whole
      // row, so without it a summary written again empties the gear columns,
      // and its document shows the bare gear id.
      const gear = a.gear_id ? opts.gear?.get(a.gear_id) : undefined;
      const record = activityToRecord(a, { summaryHash: computeSummaryHash(a), gear });

      // An activity the store holds unedited is not written again: a summary
      // write carries no enrichment, so it would clear the `*_fetched_at`
      // stamps and send an already-enriched activity back for another detail
      // fetch. Only a changed (or never-seen) summary is re-ingested — with its
      // four stamps left null, which is the signal `enrich-pending` looks for
      // and which `activityToRecord` writes by default. Counters that moved
      // are no edit, and go back to the social tier alone (`recountedRows`).
      const prior = opts.stored?.get(a.id);
      // Left to the next walk while its social mark is pending. The mark
      // re-reads the row and stamps it as it then stands, so a recount or an
      // edit written in between would be marked done with the social tier
      // never run for it, and the comments and kudos behind it not fetched
      // until a counter moved again. The row is unchanged meanwhile, so the
      // next walk finds the same difference. The detail tier's marks need no
      // such care: they land before a walk starts (see `dueWalk`), while the
      // social tier's wait for its next page, which the budget can hold back
      // for hours.
      if (prior !== undefined && opts.unmarked?.includes(String(a.id))) continue;
      if (prior !== undefined && !summaryEdited(prior, record)) {
        const counters = movedCounters(prior, record);
        if (counters) recounted.set(a.id, counters);
        continue;
      }

      records.push(record);
      documents.push(
        activityToDocument(a, this.providerId, this.sourceId, {
          athleteName: this.athleteName,
          gearName: gearDisplayName(gear),
        }),
      );
    }

    return { records, documents, newestUnix, recounted };
  }

  /**
   * A page of listed activities as the writes the store needs: a record and a
   * document for each activity it lacks or holds edited, and for each whose
   * counters alone moved, its stored row with the listing's counters.
   */
  private async againstStore(
    cur: StravaActivitiesCursor,
    activities: StravaSummaryActivity[],
  ): Promise<{
    records: Record<string, unknown>[];
    documents: DocumentInput[];
    newestUnix: number | undefined;
  }> {
    const { records, documents, newestUnix, recounted } = this.buildOutputs(activities, {
      stored: await this.storedSummaries(activities),
      gear: await this.catalogued(cur, activities),
      unmarked: cur.pendingSocialStamps,
    });
    return {
      records: [...records, ...(await this.recountedRows(recounted))],
      documents,
      newestUnix,
    };
  }

  /**
   * The catalogued gear a page's activities name, or none without a store to
   * read or before the first refresh. The refresh creates the catalogue, and
   * the gateway refuses, and logs as an error, a read of a table the source
   * has not created. Nothing is lost by not asking: every activity written
   * before the refresh has its details fetched after it, and the detail tier
   * names its gear then.
   */
  private async catalogued(
    cur: StravaActivitiesCursor,
    activities: StravaSummaryActivity[],
  ): Promise<Map<string, ResolvedGear>> {
    if (!this.analytics || this.athleteId === undefined || !cur.lastAthleteRefreshAt) {
      return new Map();
    }
    return storedGear(
      this.analytics,
      this.athleteId,
      activities.map((a) => a.gear_id),
    );
  }

  /**
   * What the store holds of the given activities, keyed by id: the columns
   * edit detection compares, not the whole row, since the daily rewalk reads
   * this for every activity of the history. An activity with no stored row is
   * absent from the map, and so treated as new.
   *
   * Unlike the enrichment reads, this one needs no owner filter: the ids come
   * from this athlete's own listing and Strava never reuses one across
   * athletes, so no sibling account's row can match.
   */
  private async storedSummaries(
    activities: StravaSummaryActivity[],
  ): Promise<Map<number, Record<string, unknown>>> {
    const map = new Map<number, Record<string, unknown>>();
    if (!this.analytics || activities.length === 0) return map;
    const ids = activityIdList(activities.map((a) => a.id));
    if (!ids) return map;
    const sql = `SELECT ${COMPARED_COLUMNS.join(", ")} FROM strava_activities WHERE id IN (${ids})`;
    const { rows } = await this.analytics.query(sql);
    for (const row of rows) map.set(Number(row.id), row);
    return map;
  }

  /**
   * The stored rows of activities whose counters alone moved, carrying the
   * listing's counters and no social mark.
   *
   * New kudos and comments are not an edit, so the detail, zones and streams
   * stand and keep their marks; only the social tier runs again, two reads,
   * fetching the comments and kudoers behind the counters and rendering the
   * document they appear in. No document here: one rendered from the summary
   * would drop the description, results and comments the tiers put in it.
   * The whole row, since a write replaces the whole row. Once written, the row
   * holds what the listing says, so the next walk finds nothing moved.
   */
  private async recountedRows(
    recounted: Map<number, Record<string, unknown>>,
  ): Promise<Record<string, unknown>[]> {
    const ids = activityIdList([...recounted.keys()]);
    if (!ids || !this.analytics) return [];
    const { rows } = await this.analytics.query(
      `SELECT * FROM strava_activities WHERE id IN (${ids})`,
    );
    return rows.map((row) => ({
      ...row,
      ...recounted.get(Number(row.id)),
      social_fetched_at: null,
    }));
  }
}

/** Convert an ISO data-cutoff string to unix seconds, or undefined. */
function dataCutoffToUnix(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 1000);
}

/**
 * The phase a walk that is ending hands the cursor back to: the one it
 * interrupted, or `incremental` for a walk begun before walks recorded it.
 */
function handBack(
  cur: StravaActivitiesCursor,
): Pick<StravaActivitiesCursor, "phase" | "resumePhase"> {
  return { phase: cur.resumePhase ?? "incremental", resumePhase: undefined };
}

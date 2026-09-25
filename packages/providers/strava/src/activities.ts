// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { analyticsDeleteKey, SnapshotEnumeration } from "@omnesis/source-sdk";
import { activitySchemas } from "./schemas.js";
import { activityToDocument, activityToRecord } from "./normalizer.js";
import { computeSummaryHash } from "./normalizer-detail.js";
import {
  syncDetailBackfill,
  syncSocialBackfill,
  syncZonesBackfill,
  syncStreamsBackfill,
  syncEnrichPending,
} from "./enrichment.js";
import { syncAthleteRefresh, shouldRefreshAthlete } from "./athlete-refresh.js";
import type {
  SourceAnalyticsAccess,
  StructuredSyncResult,
  SyncProgress,
  TableWrite,
} from "@omnesis/source-sdk";
import type { StravaActivitiesCursor, StravaSummaryActivity } from "./types.js";
import type { StravaClient } from "./client.js";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

const log = createLogger("source:strava-activities");

const PAGE_SIZE = 100;
const TABLE_NAME = "strava_activities";

/** 24h cadence for snapshot deletion-detection rewalk. */
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
    if (cur.phase === "snapshot-rewalk") return this.syncSnapshotRewalk(cur);
    if (cur.phase === "edit-sweep") return this.syncEditSweep(cur);
    if (cur.phase === "athlete-refresh") return this.dispatchAthleteRefresh(cur);
    if (cur.phase === "detail-backfill") return this.dispatchDetail(cur);
    if (cur.phase === "social-backfill") return this.dispatchSocial(cur);
    if (cur.phase === "zones-backfill") return this.dispatchZones(cur);
    if (cur.phase === "streams-backfill") return this.dispatchStreams(cur);
    if (cur.phase === "enrich-pending") return this.dispatchEnrichPending(cur);

    // `incremental` — priority chain.
    if (this.shouldStartSnapshot(cur)) {
      const entered: StravaActivitiesCursor = {
        ...cur,
        phase: "snapshot-rewalk",
        snapshotBefore: Math.floor(Date.now() / 1000),
        snapshotPage: 1,
        snapshotIds: [],
      };
      return this.syncSnapshotRewalk(entered);
    }
    if (this.shouldStartEditSweep(cur)) {
      const nowSec = Math.floor(Date.now() / 1000);
      const entered: StravaActivitiesCursor = {
        ...cur,
        phase: "edit-sweep",
        editSweepAfter: nowSec - Math.floor(EDIT_SWEEP_DEPTH_MS / 1000),
        editSweepPage: 1,
      };
      return this.syncEditSweep(entered);
    }
    if (this.analytics && this.athleteId !== undefined) {
      if (shouldRefreshAthlete(cur)) {
        return this.dispatchAthleteRefresh({ ...cur, phase: "athlete-refresh" });
      }
      // Nothing time-gated is due — opportunistically run enrich-pending.
      const enriched = await this.dispatchEnrichPending({ ...cur, phase: "enrich-pending" });
      // If nothing was pending, enrich-pending returns to incremental immediately.
      if (enriched.cursor.phase !== "incremental") return enriched;
    }
    return this.syncIncremental(cur);
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
    const after = Math.max(cur.lastActivityTimestamp ?? 0, dataCutoffToUnix(this.dataCutoff) ?? 0);

    const activities = await this.client.listActivities({
      after: after > 0 ? after : undefined,
      page: 1,
      per_page: PAGE_SIZE,
    });

    // Guarded like the edit sweep, because this phase can hand back an
    // activity it has already ingested: `after` is a second-resolution
    // high-water mark, so anything starting on that exact second comes round
    // again. Re-ingesting one costs more than a duplicate row — a summary
    // write carries no enrichment, so it clears the `*_fetched_at` stamps and
    // sends an already-enriched activity back for another detail fetch.
    // An activity that is genuinely new has no stored hash and is emitted.
    const storedHashes = await this.storedSummaryHashes(activities);
    const { records, documents, newestUnix } = this.buildOutputs(activities, { storedHashes });
    const hasMore = activities.length === PAGE_SIZE;
    const newLast = Math.max(cur.lastActivityTimestamp ?? 0, newestUnix ?? 0);

    log.info(`Incremental: ${activities.length} activities (hasMore=${hasMore})`);

    const newCursor: StravaActivitiesCursor = {
      ...cur,
      phase: "incremental",
      lastActivityTimestamp: newLast > 0 ? newLast : cur.lastActivityTimestamp,
    };

    return {
      analytics: { tableName: TABLE_NAME, records },
      documents,
      cursor: newCursor,
      hasMore,
      progress: { phase: "incremental", processed: activities.length },
    };
  }

  // ── Snapshot rewalk ───────────────────────────────────────────────

  private async syncSnapshotRewalk(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    const page = cur.snapshotPage ?? 1;
    const before = cur.snapshotBefore ?? Math.floor(Date.now() / 1000);
    const after = dataCutoffToUnix(this.dataCutoff);

    const activities = await this.client.listActivities({
      before,
      after,
      page,
      per_page: PAGE_SIZE,
    });
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
          `Snapshot rewalk complete: page ${page}, ${accumulated.length} activities enumerated`,
        );
      }
      const newCursor: StravaActivitiesCursor = {
        ...cur,
        phase: "incremental",
        lastSnapshotAt: new Date().toISOString(),
        snapshotBefore: undefined,
        snapshotPage: undefined,
        snapshotIds: undefined,
      };
      return {
        cursor: newCursor,
        hasMore: false,
        documents: [],
        ...(presentExternalIds !== undefined
          ? {
              presentExternalIds,
              issues: [],
              analytics: activitySchemas.map((schema) => ({
                tableName: schema.tableName,
                records: [],
                presentKeys: presentExternalIds.map((id) => ({
                  [analyticsDeleteKey(schema)[0]!]: id,
                })),
              })),
            }
          : {}),
      };
    }

    log.info(`Snapshot rewalk page ${page}: ${activities.length} ids`);
    return {
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
   * Re-walks the last 30 days of activities. For each one we recompute the
   * deterministic `summary_hash` and compare it to the value already stored
   * in the analytics DB: unchanged activities are skipped entirely (no
   * record, no document — a true no-op), and only activities whose summary
   * actually changed are re-ingested with their four `*_fetched_at` stamps
   * cleared so they flow back through enrichment.
   *
   * Without a gateway we can't read the stored hashes to diff against, so —
   * like the other enrichment phases — the sweep is a no-op that returns to
   * `incremental`.
   */
  private async syncEditSweep(
    cur: StravaActivitiesCursor,
  ): Promise<StructuredSyncResult<StravaActivitiesCursor>> {
    if (!this.analytics) {
      log.warn("Skipping edit-sweep (no analytics access)");
      return {
        cursor: { ...cur, phase: "incremental", lastEditSweepAt: new Date().toISOString() },
        hasMore: false,
      };
    }

    const page = cur.editSweepPage ?? 1;
    const after = cur.editSweepAfter ?? Math.floor((Date.now() - EDIT_SWEEP_DEPTH_MS) / 1000);
    const dataAfter = dataCutoffToUnix(this.dataCutoff);
    const effectiveAfter = dataAfter !== undefined ? Math.max(after, dataAfter) : after;

    const activities = await this.client.listActivities({
      after: effectiveAfter,
      page,
      per_page: PAGE_SIZE,
    });

    const storedHashes = await this.storedSummaryHashes(activities);
    const { records, documents } = this.buildOutputs(activities, { storedHashes });
    const endOfSweep = activities.length < PAGE_SIZE;

    if (endOfSweep) {
      log.info(
        `Edit sweep complete: page ${page}, ${activities.length} walked, ${records.length} changed/re-ingested`,
      );
      const newCursor: StravaActivitiesCursor = {
        ...cur,
        phase: "incremental",
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
    const nextPhase: StravaActivitiesCursor["phase"] =
      cur.phase === "athlete-refresh" && cur.lastActivityTimestamp === undefined
        ? "incremental" // Came from incremental-tick refresh; just go back.
        : "detail-backfill"; // Came after backfill; chain into enrichment.
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
    opts: { storedHashes?: Map<number, string | null> } = {},
  ): {
    records: Record<string, unknown>[];
    documents: DocumentInput[];
    newestUnix: number | undefined;
  } {
    const records: Record<string, unknown>[] = [];
    const documents: DocumentInput[] = [];
    let newestUnix: number | undefined;

    for (const a of activities) {
      const summaryHash = computeSummaryHash(a);

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

      // `storedHashes` is the prior `summary_hash` per activity id, passed by
      // the phases that can be handed an activity they have already ingested.
      // One whose hash is unchanged is a true no-op: skipping it avoids
      // re-rendering the document and, more importantly, avoids clearing the
      // enrichment stamps, since a summary write carries no enrichment and
      // would send an already-enriched activity back for another detail fetch.
      // Only a changed (or never-seen) summary is re-ingested — with its four
      // `*_fetched_at` stamps left null, which is the signal `enrich-pending`
      // looks for and which `activityToRecord` writes by default.
      if (opts.storedHashes) {
        const prior = opts.storedHashes.get(a.id);
        if (prior === summaryHash) continue;
      }

      records.push(activityToRecord(a, { summaryHash }));
      documents.push(
        activityToDocument(a, this.providerId, this.sourceId, {
          athleteName: this.athleteName,
        }),
      );
    }

    return { records, documents, newestUnix };
  }

  /**
   * Reads the currently-stored `summary_hash` for the given activities from
   * the analytics DB, keyed by activity id. Used by edit-sweep to detect
   * which activities actually changed since the last ingest. Activities with
   * no stored row are absent from the map (and so treated as changed).
   */
  private async storedSummaryHashes(
    activities: StravaSummaryActivity[],
  ): Promise<Map<number, string | null>> {
    const map = new Map<number, string | null>();
    if (!this.analytics || activities.length === 0) return map;
    // Activity ids are Strava-assigned integers; coerce defensively so the
    // interpolated `IN (...)` list can never carry anything but numerals.
    const ids = activities
      .map((a) => Math.trunc(Number(a.id)))
      .filter((id) => Number.isInteger(id))
      .join(",");
    if (ids.length === 0) return map;
    const sql = `SELECT id, summary_hash FROM strava_activities WHERE id IN (${ids})`;
    const { rows } = await this.analytics.query(sql);
    for (const row of rows) {
      const id = Number((row as { id: number | bigint }).id);
      const hash = (row as { summary_hash: string | null }).summary_hash ?? null;
      map.set(id, hash);
    }
    return map;
  }
}

/** Convert an ISO data-cutoff string to unix seconds, or undefined. */
function dataCutoffToUnix(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return undefined;
  return Math.floor(ms / 1000);
}

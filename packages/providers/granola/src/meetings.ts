// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, toErrorMessage } from "@omnesis/core";
import {
  SyncError,
  failureScopeOf,
  mayContinuePage,
  type ProviderId,
  type SourceId,
} from "@omnesis/types";
import { SnapshotEnumeration } from "@omnesis/source-sdk";
import { granolaMeetingsSchema } from "./schemas.js";
import { noteToDocument, noteToRecord } from "./normalizer.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";
import type { GranolaClient } from "./client.js";
import type { GranolaMeetingsCursor } from "./types.js";

const log = createLogger("provider:granola:meetings");

/** Notes per list page. Granola caps page_size at 30; 20 keeps us under the burst limit. */
const PAGE_SIZE = 20;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Defensive bounds, not a partial enumeration policy: exceeding either fails
// the page without advancing state or asserting absence.
const MAX_SNAPSHOT_ITEMS = 100_000;
const MAX_SWEEP_PAGES = 10_000;
const NOTES_PARTITION = "notes";

export interface GranolaMeetingsSourceOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  snapshotIntervalMs?: number;
  maxSnapshotItems?: number;
  maxSweepPages?: number;
}

/**
 * Hybrid source: each page emits `granola_meetings` rows AND searchable
 * documents (summary + transcript). The cursor walks every note once on the
 * first sweep (`backfill`), then polls changed notes (`incremental`) between
 * daily full rewalks (`snapshot`) that reconcile both output planes.
 */
export class GranolaMeetingsSource {
  private readonly now: () => string;
  private readonly snapshotIntervalMs: number;
  private readonly maxSnapshotItems: number;
  private readonly maxSweepPages: number;

  constructor(
    private readonly client: GranolaClient,
    private readonly providerId: ProviderId,
    private readonly sourceId: SourceId,
    private readonly dataCutoff: string | undefined,
    /** Stamped on every row so a sibling account's rows stay distinguishable. */
    private readonly accountId: string,
    opts: GranolaMeetingsSourceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.snapshotIntervalMs = opts.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS;
    this.maxSnapshotItems = opts.maxSnapshotItems ?? MAX_SNAPSHOT_ITEMS;
    this.maxSweepPages = opts.maxSweepPages ?? MAX_SWEEP_PAGES;
  }

  async syncStructured(
    cursor: GranolaMeetingsCursor | null,
  ): Promise<StructuredSyncResult<GranolaMeetingsCursor>> {
    const syncedAt = this.now();
    // Never change a query halfway through pagination: an installed cursor's
    // page token belongs to the old query, even when a rewalk is overdue.
    const due =
      !cursor?.lastSnapshotAt ||
      Date.parse(syncedAt) - Date.parse(cursor.lastSnapshotAt) >= this.snapshotIntervalMs;
    const phase =
      cursor?.phase === "incremental" && !cursor.pageCursor && due
        ? "snapshot"
        : (cursor?.phase ?? "backfill");
    const updatedAfter = phase === "incremental" ? cursor?.syncedUpTo : undefined;
    const enumeration =
      phase !== "incremental" && (!cursor?.pageCursor || cursor.snapshot !== undefined)
        ? SnapshotEnumeration.resume([NOTES_PARTITION], cursor?.snapshot)
        : undefined;
    const seenTokens = new Set(cursor?.pageCursors ?? []);
    if (cursor?.pageCursor) seenTokens.add(cursor.pageCursor);
    if (seenTokens.size >= this.maxSweepPages)
      throw new SyncError("unknown", "Granola sweep exceeded its safe page limit");

    const page = await this.client.listNotes({
      pageSize: PAGE_SIZE,
      cursor: cursor?.pageCursor ?? undefined,
      updatedAfter,
    });
    if (
      !page ||
      !Array.isArray(page.notes) ||
      typeof page.hasMore !== "boolean" ||
      page.notes.length > PAGE_SIZE
    ) {
      throw new SyncError("unknown", "Granola returned an invalid note listing");
    }
    if (
      page.hasMore &&
      (typeof page.cursor !== "string" ||
        page.cursor.length > 1024 ||
        !page.cursor ||
        seenTokens.has(page.cursor))
    ) {
      throw new SyncError(
        "unknown",
        "Granola pagination did not advance; withholding reconciliation",
      );
    }
    if (page.hasMore) seenTokens.add(page.cursor!);

    const records: Record<string, unknown>[] = [];
    const documents = [];
    let sweepMax = cursor?.sweepMaxUpdatedAt;

    for (const summary of page.notes) {
      if (
        !summary ||
        typeof summary.id !== "string" ||
        !summary.id ||
        summary.id.length > 128 ||
        typeof summary.created_at !== "string" ||
        !Number.isFinite(Date.parse(summary.created_at)) ||
        typeof summary.updated_at !== "string" ||
        !Number.isFinite(Date.parse(summary.updated_at))
      ) {
        throw new SyncError("unknown", "Granola returned an invalid note summary");
      }
      if (summary.updated_at > (sweepMax ?? "")) sweepMax = summary.updated_at;
      // Respect the history-import lower bound: notes created before the
      // cutoff are skipped before we spend a detail request on them.
      if (this.dataCutoff && summary.created_at < this.dataCutoff) continue;
      // Listing an item proves it is present even if its detail read fails.
      // In particular a detail 404 alone never authorizes deleting prior data.
      enumeration?.add(NOTES_PARTITION, [summary.id]);

      let detail;
      try {
        detail = await this.client.getNote(summary.id, { includeTranscript: true });
      } catch (err) {
        // A note the list page just named that 404s on its detail fetch was
        // deleted between the two calls: one item gone, not the account. The
        // rest of the page is still readable, so this is the one failure the
        // loop steps over rather than discarding the notes already collected.
        if (mayContinuePage(failureScopeOf(err))) {
          log.warn(`Skipping note ${summary.id}: ${toErrorMessage(err)}`);
          continue;
        }
        throw err;
      }
      records.push(noteToRecord(detail, syncedAt, this.accountId));
      documents.push(noteToDocument(detail, this.providerId, this.sourceId));
    }

    if (enumeration && enumeration.size > this.maxSnapshotItems) {
      throw new SyncError("unknown", "Granola snapshot exceeded its safe item limit");
    }

    const moreInSweep = page.hasMore && Boolean(page.cursor);
    if (moreInSweep) {
      return {
        analytics:
          records.length > 0 ? { tableName: granolaMeetingsSchema.tableName, records } : undefined,
        documents,
        cursor: {
          reconciliationVersion: 2,
          phase,
          pageCursor: page.cursor,
          syncedUpTo: cursor?.syncedUpTo,
          sweepMaxUpdatedAt: sweepMax,
          lastSnapshotAt: cursor?.lastSnapshotAt,
          snapshot: enumeration?.toLedger(),
          pageCursors: [...seenTokens],
        },
        hasMore: true,
      };
    }

    // Sweep complete — promote the watermark and switch to incremental.
    const syncedUpTo = maxIso(cursor?.syncedUpTo, sweepMax);
    const presentIds = enumeration?.cover(NOTES_PARTITION).result();
    if (phase === "backfill") {
      log.info(`Backfill complete; switching to incremental (watermark=${syncedUpTo ?? "none"})`);
    }
    return {
      analytics:
        records.length > 0 || presentIds !== undefined
          ? {
              tableName: granolaMeetingsSchema.tableName,
              records,
              ...(presentIds !== undefined ? { presentIds } : {}),
            }
          : undefined,
      documents,
      ...(presentIds !== undefined ? { presentExternalIds: presentIds, issues: [] } : {}),
      cursor: {
        reconciliationVersion: 2,
        phase: "incremental",
        pageCursor: null,
        syncedUpTo,
        sweepMaxUpdatedAt: undefined,
        lastSnapshotAt: presentIds !== undefined ? syncedAt : cursor?.lastSnapshotAt,
      },
      hasMore: false,
    };
  }
}

/** Return the later of two optional ISO timestamps. */
export function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Event time for the temporal lane: the documents the gateway's time index
 * places inside a query's windows — source-owned projections (calendar
 * events, bookings, workouts), date mentions read from document text, and the
 * background agent's annotations — read through the same temporal query the
 * agent's `temporal_query` tool uses, so the lane and the tool agree on what
 * a window holds.
 *
 * Only items anchored in a window count: an item that merely spans it (a
 * twenty-year loan, a multi-month warranty) says nothing about those days and
 * would put the same long-lived document in every window. The read skips the
 * coverage and counts the agents' tool reports, which the lane has no use for.
 *
 * Runs on the main thread, which owns `omnesis.db` and the analytics store;
 * the ids it returns travel to the candidate-generation core.
 */

import { createLogger } from "@omnesis/core";
import type { TemporalItem, TemporalQueryInput } from "@omnesis/core";
import type { TemporalWindow } from "./temporal-intent.js";

const log = createLogger("gateway:search");

/** The temporal read the lane needs — the gateway's temporal query service. */
export interface TemporalIndexReader {
  /** The first `input.limit` items anchored inside the window, in the query's order. */
  anchoredItems(
    input: TemporalQueryInput,
    execution?: { signal?: AbortSignal },
  ): Promise<TemporalItem[]>;
}

/**
 * Items read per window: one page of the temporal query, in its order (by
 * when each item starts). A narrow window ("tomorrow", "next week") fits
 * whole; a wide one ("last year") contributes its first page, and its
 * document time carries the rest.
 */
const ITEMS_PER_WINDOW = 100;
/**
 * Windows longer than this many days are not read for event time. A
 * quarter's worth of calendar events, bookings and mentions is already more
 * than one page holds, and a year ("invoices 2025") is answered by when its
 * documents were written; reading it would cost the main thread a scan of
 * the whole period for nothing the lane could use.
 */
const EVENT_WINDOW_MAX_DAYS = 92;
/** The event-time read is best effort: past this budget the lane uses what it has. */
const READ_BUDGET_MS = 500;

/**
 * Document ids the time index anchors inside `windows`, deduplicated, in the
 * index's order. `sourceIds` scopes the read to the sources the search may
 * return.
 */
export async function eventDocumentsInWindows(
  reader: TemporalIndexReader,
  windows: readonly TemporalWindow[],
  timeZone: string,
  sourceIds: readonly string[] | undefined,
): Promise<string[]> {
  const ids = new Set<string>();
  const signal = AbortSignal.timeout(READ_BUDGET_MS);
  try {
    for (const window of windows) {
      if (window.endExclusiveMs - window.startMs > EVENT_WINDOW_MAX_DAYS * 86_400_000) continue;
      const items = await reader.anchoredItems(
        {
          from: new Date(window.startMs).toISOString(),
          to: new Date(window.endExclusiveMs).toISOString(),
          timeZone,
          origins: ["projection", "annotation", "mention"],
          limit: ITEMS_PER_WINDOW,
          ...(sourceIds && sourceIds.length > 0 ? { sourceIds: [...sourceIds] } : {}),
        },
        { signal },
      );
      for (const item of items) for (const id of itemDocumentIds(item)) ids.add(id);
    }
  } catch (err) {
    log.warn(
      `Temporal lane: event-time read stopped early (${ids.size} documents): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return [...ids];
}

/** The documents an item is about. */
function itemDocumentIds(item: TemporalItem): string[] {
  if (item.mention) return [item.mention.documentId];
  if (item.projection?.documentId) return [item.projection.documentId];
  if (item.annotation) return item.annotation.documentIds;
  return [];
}

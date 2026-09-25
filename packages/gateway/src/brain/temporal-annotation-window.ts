// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Window assembly for the legacy annotation-only calendar endpoint. Selects
 * live temporal annotations overlapping the requested window and
 * resolves their grounding documents for display, in the same shape as the
 * feed's citations (`docId`/`title`/`providerId`/`sourceId` — clients key
 * source icons on `sourceId`). Read-only and db-direct, like the feed;
 * every temporal-annotation WRITE stays on the write gate.
 */

import {
  getTemporalAnnotationById,
  queryTemporalAnnotationWindow,
  TEMPORAL_ANNOTATION_READ_DEFAULT_LIMIT,
  TEMPORAL_ANNOTATION_READ_MAX_LIMIT,
  type TemporalAnnotation,
} from "../enrichment/temporal-annotations/storage.js";
import type { TemporalPrecision } from "@omnesis/core";
import type Database from "better-sqlite3";
import type { FeedCitation } from "./feed.js";

type Db = Database.Database;

/** One display-ready calendar entry: the stored entry + resolved documents. */
export interface TemporalAnnotationWindowEntry {
  id: string;
  intervalStartMs: number;
  intervalEndMs: number;
  precision: TemporalPrecision;
  canonical: string | null;
  sentence: string;
  kind: string | null;
  createdAt: number;
  updatedAt: number;
  documents: FeedCitation[];
}

/** Hard cap on a window's span — a year-plus view is a misuse, not a zoom. */
export const TEMPORAL_ANNOTATION_WINDOW_MAX_SPAN_MS = 400 * 24 * 60 * 60 * 1000;

/** One assembled window page. `truncated` = more live entries overlap the
 * window than `limit` allowed — the client narrows the window (or raises
 * `limit`) rather than trusting an invisibly clipped calendar. */
export interface TemporalAnnotationWindowPage {
  entries: TemporalAnnotationWindowEntry[];
  truncated: boolean;
}

/**
 * Live entries overlapping `[fromMs, toMs]`, chronological, documents
 * resolved. `kinds` optionally narrows to a kind set (the Upcoming rail).
 * Over-fetches one row past `limit` so truncation is detected exactly,
 * never inferred from a full page.
 */
export function buildTemporalAnnotationWindow(
  db: Db,
  opts: {
    fromMs: number;
    toMs: number;
    kinds?: readonly string[] | undefined;
    limit?: number | undefined;
  },
): TemporalAnnotationWindowPage {
  const limit = Math.min(
    Math.max(opts.limit ?? TEMPORAL_ANNOTATION_READ_DEFAULT_LIMIT, 1),
    TEMPORAL_ANNOTATION_READ_MAX_LIMIT,
  );
  const rows = queryTemporalAnnotationWindow(db, {
    startMs: opts.fromMs,
    endMs: opts.toMs,
    kinds: opts.kinds,
    limit: limit + 1,
  });
  const truncated = rows.length > limit;
  return { entries: withDocuments(db, truncated ? rows.slice(0, limit) : rows), truncated };
}

/** One live entry by id with resolved documents, or null. */
export function buildTemporalAnnotationEntry(
  db: Db,
  id: string,
): TemporalAnnotationWindowEntry | null {
  const entry = getTemporalAnnotationById(db, id);
  return entry ? withDocuments(db, [entry])[0]! : null;
}

function withDocuments(
  db: Db,
  entries: readonly TemporalAnnotation[],
): TemporalAnnotationWindowEntry[] {
  const allIds = [...new Set(entries.flatMap((e) => e.documentIds))];
  const docs = resolveDocuments(db, allIds);
  return entries.map(({ documentIds, createdByRun: _createdByRun, ...entry }) => ({
    ...entry,
    // A linked document that no longer exists (source removal, retention) is
    // dropped rather than rendered dead — mirroring feed citations. Privacy
    // deletes hard-purge the whole entry before this read can see it.
    documents: documentIds.flatMap((id) => {
      const doc = docs.get(id);
      return doc ? [doc] : [];
    }),
  }));
}

function resolveDocuments(db: Db, docIds: readonly string[]): Map<string, FeedCitation> {
  if (docIds.length === 0) return new Map();
  const placeholders = docIds.map(() => "?").join(", ");
  const rows = db
    .prepare<
      string[],
      { id: string; title: string; provider_id: string; source_id: string }
    >(`SELECT id, title, provider_id, source_id FROM documents WHERE id IN (${placeholders})`)
    .all(...docIds);
  return new Map(
    rows.map((r) => [
      r.id,
      { docId: r.id, title: r.title, providerId: r.provider_id, sourceId: r.source_id },
    ]),
  );
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The part of a temporal window read that lives in `omnesis.db`: document
 * projections, annotations and one page of mentions, each normalized into the
 * caller's time zone and keyed for the shared order. The gateway runs it on a
 * read worker (`io.temporalStoreWindow`), so a window's index walks and its
 * per-row normalization never hold the main event loop; the analytics
 * projections, which DuckDB reads asynchronously, stay with the query service.
 */

import {
  canonicalTemporalKind,
  createLogger,
  isTemporalModality,
  isTemporalStatus,
  intervalOverlapsWindow,
  MAX_TIME_ZONE_SHIFT_MS,
} from "@omnesis/core";
import { projectionRevision } from "../temporal-projections/derive.js";
import { readMentionPage, type MentionPage } from "./temporal-mentions.js";
import { annotationMatchesScope, normalizedAnnotationBounds } from "./annotation-scope.js";
import { resolveTemporalRange } from "./temporal-range.js";
import type Database from "better-sqlite3";
import type {
  TemporalItem,
  TemporalKind,
  TemporalModality,
  TemporalOrigin,
  TemporalPrecision,
  TemporalQueryInput,
  TemporalStatus,
} from "@omnesis/core";

const log = createLogger("gateway:temporal-query");

type Db = Database.Database;

/** An item's place in the shared order of a window, and the cursor's key. */
export interface TemporalSortKey {
  startMs: number;
  endExclusiveMs: number;
  originRank: number;
  id: string;
}

export interface RankedTemporalItem {
  item: TemporalItem;
  key: TemporalSortKey;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export function compareKeys(left: TemporalSortKey, right: TemporalSortKey): number {
  return (
    left.startMs - right.startMs ||
    left.endExclusiveMs - right.endExclusiveMs ||
    left.originRank - right.originRank ||
    left.id.localeCompare(right.id)
  );
}

/**
 * How an annotation that declares no kind reads.
 *
 * The annotation store accepts a null kind — an author may record what a time
 * means without classifying its nature. Both the SQL filter and the read below
 * resolve that null through this one constant, so a caller filtering on a kind
 * and the item it gets back can never disagree about which kind it is.
 */
const UNCLASSIFIED_ANNOTATION_KIND: TemporalKind = "event";

/**
 * Read a vocabulary value back out of our own storage.
 *
 * Retired spellings are accepted so a row written before a vocabulary change
 * still reads; anything else is corruption. Substituting a default here would
 * silently relabel the fact and make the constraint that produced it untestable.
 */
export function kind(value: string): TemporalKind {
  const resolved = canonicalTemporalKind(value);
  if (!resolved) throw new Error(`Stored temporal kind '${value}' is outside the vocabulary`);
  return resolved;
}

export function modality(value: string): TemporalModality {
  if (!isTemporalModality(value)) {
    throw new Error(`Stored temporal modality '${value}' is outside the vocabulary`);
  }
  return value;
}

export function status(value: string): TemporalStatus {
  if (!isTemporalStatus(value)) {
    throw new Error(`Stored temporal status '${value}' is outside the vocabulary`);
  }
  return value;
}

export function normalizedProjectionBounds(
  row: {
    precision: "instant" | "day";
    startCanonical: string;
    endCanonical: string;
    startMs: number;
    endExclusiveMs: number;
  },
  timeZone: string,
): { startMs: number; endExclusiveMs: number } {
  // The stored bounds were computed when the row was written and are always
  // usable, so they are the floor this function degrades to rather than the
  // value it improves on only when it can.
  const stored = { startMs: row.startMs, endExclusiveMs: row.endExclusiveMs };
  if (row.precision !== "day") return stored;
  try {
    const resolved = resolveTemporalRange({
      from: row.startCanonical,
      to: row.endCanonical,
      timeZone,
    });
    return { startMs: resolved.fromMs, endExclusiveMs: resolved.toExclusiveMs };
  } catch (error) {
    // A day-precision row resolves through local midnight, which does not
    // exist on a date whose zone springs forward at midnight (Chile, for
    // one). Re-anchoring is a refinement; failing it must cost this row a
    // little precision, never cost the caller the whole window — every call
    // site maps over a result set, so a throw here loses every other row too.
    // Logged rather than swallowed: a resolution that keeps failing for some
    // other reason should still be discoverable.
    log.warn(
      `Temporal projection kept its stored bounds (${row.startCanonical}..${row.endCanonical} in ${timeZone}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return stored;
  }
}

const overlaps = intervalOverlapsWindow;

function readDocumentProjections(
  db: Db,
  input: TemporalQueryInput,
  range: { fromMs: number; toExclusiveMs: number },
): RankedTemporalItem[] {
  const where = ["start_ms < ?", "end_exclusive_ms > ?"];
  const values: unknown[] = [
    range.toExclusiveMs + MAX_TIME_ZONE_SHIFT_MS,
    range.fromMs - MAX_TIME_ZONE_SHIFT_MS,
  ];
  const addIn = (column: string, selected: readonly string[] | undefined) => {
    if (!selected?.length) return;
    where.push(`${column} IN (${placeholders(selected)})`);
    values.push(...selected);
  };
  addIn("source_id", input.sourceIds);
  addIn("kind", input.kinds);
  addIn("modality", input.modalities);
  addIn("status", input.statuses);
  addIn("document_id", input.documentIds);
  if (input.documentIds && input.documentIds.length === 0) return [];
  if (input.entityIds) {
    if (input.entityIds.length === 0) return [];
    const selected = placeholders(input.entityIds);
    where.push(`(id IN (${selected}) OR document_id IN (${selected}))`);
    values.push(...input.entityIds, ...input.entityIds);
  }
  const rows = db
    .prepare(
      `SELECT * FROM document_temporal_projections
       WHERE ${where.join(" AND ")}
       ORDER BY start_ms, end_exclusive_ms, id`,
    )
    .all(...values) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const stored = {
      precision: String(row.precision) === "day" ? ("day" as const) : ("instant" as const),
      startCanonical: String(row.start_canonical),
      endCanonical: String(row.end_canonical),
      startMs: Number(row.start_ms),
      endExclusiveMs: Number(row.end_exclusive_ms),
    };
    const bounds = normalizedProjectionBounds(stored, input.timeZone);
    if (!overlaps(bounds, range)) return [];
    const id = String(row.id);
    const item: TemporalItem = {
      id,
      origin: "projection",
      start: new Date(bounds.startMs).toISOString(),
      endExclusive: new Date(bounds.endExclusiveMs).toISOString(),
      precision: stored.precision,
      allDay: Number(row.all_day) === 1,
      timeZone: row.time_zone == null ? input.timeZone : String(row.time_zone),
      label: String(row.label),
      kind: kind(String(row.kind)),
      modality: modality(String(row.modality)),
      status: status(String(row.status)),
      projection: {
        sourceId: String(row.source_id),
        slot: String(row.slot),
        documentId: String(row.document_id),
        documentExternalId: String(row.document_external_id),
        sourceUpdatedAt: row.source_updated_at == null ? undefined : String(row.source_updated_at),
        projectedAt: String(row.projected_at),
        revision: projectionRevision({
          startCanonical: stored.startCanonical,
          endCanonical: stored.endCanonical,
          label: String(row.label),
          kind: String(row.kind),
          modality: String(row.modality),
          status: String(row.status),
          sourceUpdatedAt: row.source_updated_at == null ? null : String(row.source_updated_at),
        }),
      },
    };
    return [{ item, key: { ...bounds, originRank: 0, id } }];
  });
}

function readAnnotations(
  db: Db,
  input: TemporalQueryInput,
  range: { fromMs: number; toExclusiveMs: number },
  anchoredOnly: boolean,
): RankedTemporalItem[] {
  // Coarse canonical periods are persisted on a UTC anchor and interpreted
  // in the caller's zone. Widen the storage prefilter before normalizing.
  const lowMs = range.fromMs - MAX_TIME_ZONE_SHIFT_MS;
  const highMs = range.toExclusiveMs + MAX_TIME_ZONE_SHIFT_MS;
  const where = ["e.invalidated_at IS NULL"];
  const values: unknown[] = [];
  if (anchoredOnly) {
    // Anchored means the normalized start lies in [from, to) or the normalized
    // exclusive end in (from, to]. Each normalized bound sits within the shift
    // of its stored one, and the stored end is inclusive, so these two index
    // ranges hold every annotation that can be anchored. A window over a
    // recent week then reads that week's annotations, not every one that
    // started before it. Spelled as a union of two index seeks: the planner
    // does not split an OR across the two partial indexes, and walks the
    // whole start index instead.
    where.push(
      `e.rowid IN (
        SELECT rowid FROM temporal_annotations
         WHERE invalidated_at IS NULL AND interval_start_ms >= ? AND interval_start_ms < ?
        UNION ALL
        SELECT rowid FROM temporal_annotations
         WHERE invalidated_at IS NULL AND interval_end_ms >= ? AND interval_end_ms < ?)`,
    );
    values.push(lowMs, highMs, lowMs - 1, highMs);
  } else {
    where.push("e.interval_start_ms < ?", "e.interval_end_ms >= ?");
    values.push(highMs, lowMs);
  }
  if (input.kinds?.length) {
    where.push(
      `COALESCE(e.kind, '${UNCLASSIFIED_ANNOTATION_KIND}') IN (${placeholders(input.kinds)})`,
    );
    values.push(...input.kinds);
  }
  if (input.modalities?.length && !input.modalities.includes("inferred")) return [];
  if (input.statuses?.length && !input.statuses.includes("active")) return [];
  if (input.documentIds) {
    if (input.documentIds.length === 0) return [];
    where.push(
      `e.id IN (
        SELECT d.annotation_id FROM temporal_annotation_documents d
        WHERE d.document_id IN (${placeholders(input.documentIds)})
      )`,
    );
    values.push(...input.documentIds);
  }
  if (input.sourceIds?.length) {
    where.push(
      `EXISTS (
        SELECT 1 FROM temporal_annotation_documents d
        JOIN documents doc ON doc.id = d.document_id
        WHERE d.annotation_id = e.id
          AND doc.source_id IN (${placeholders(input.sourceIds)})
      )`,
    );
    values.push(...input.sourceIds);
  }
  if (input.entityIds) {
    if (input.entityIds.length === 0) return [];
    const ids = input.entityIds;
    const inIds = placeholders(ids);
    where.push(
      `(e.id IN (${inIds})
        OR EXISTS (SELECT 1 FROM temporal_annotation_documents d
                   WHERE d.annotation_id = e.id AND d.document_id IN (${inIds}))
        OR EXISTS (SELECT 1 FROM temporal_annotation_people p
                   WHERE p.annotation_id = e.id AND p.person_id IN (${inIds}))
        OR EXISTS (SELECT 1 FROM temporal_annotation_loops l
                   WHERE l.annotation_id = e.id AND l.loop_id IN (${inIds}))
        OR EXISTS (SELECT 1 FROM temporal_annotation_projections p
                   WHERE p.annotation_id = e.id AND p.projection_id IN (${inIds})))`,
    );
    values.push(...ids, ...ids, ...ids, ...ids, ...ids);
  }
  const rows = db
    .prepare(
      `SELECT e.*,
         (SELECT json_group_array(doc.source_id) FROM temporal_annotation_documents ad JOIN documents doc ON doc.id=ad.document_id WHERE ad.annotation_id=e.id) AS source_ids,
         (SELECT json_group_array(d.document_id)
            FROM temporal_annotation_documents d WHERE d.annotation_id = e.id) AS document_ids,
         (SELECT json_group_array(p.person_id)
            FROM temporal_annotation_people p WHERE p.annotation_id = e.id) AS person_ids,
         (SELECT json_group_array(l.loop_id)
            FROM temporal_annotation_loops l WHERE l.annotation_id = e.id) AS loop_ids,
         (SELECT json_group_array(p.projection_id)
            FROM temporal_annotation_projections p WHERE p.annotation_id = e.id) AS projection_ids
       FROM temporal_annotations e
       WHERE ${where.join(" AND ")}
       ORDER BY e.interval_start_ms, e.interval_end_ms, e.id`,
    )
    .all(...values) as Array<Record<string, unknown>>;
  const parseIds = (value: unknown): string[] => {
    try {
      const parsed = JSON.parse(String(value ?? "[]"));
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string").sort()
        : [];
    } catch {
      return [];
    }
  };
  return rows.flatMap((row) => {
    const id = String(row.id);
    const storedStartMs = Number(row.interval_start_ms);
    const inclusiveEnd = Number(row.interval_end_ms);
    const storedEndExclusiveMs =
      inclusiveEnd < Number.MAX_SAFE_INTEGER ? inclusiveEnd + 1 : inclusiveEnd;
    const storedPrecision = String(row.precision);
    const bounds = normalizedAnnotationBounds(
      {
        precision: storedPrecision,
        canonical: row.canonical == null ? null : String(row.canonical),
        startMs: storedStartMs,
        endExclusiveMs: storedEndExclusiveMs,
      },
      input.timeZone,
    );
    if (
      !annotationMatchesScope(
        {
          id,
          intervalStartMs: storedStartMs,
          intervalEndMs: inclusiveEnd,
          precision: storedPrecision,
          canonical: row.canonical == null ? null : String(row.canonical),
          kind: row.kind == null ? null : String(row.kind),
          documentIds: parseIds(row.document_ids),
          sourceIds: parseIds(row.source_ids),
          personIds: parseIds(row.person_ids),
          loopIds: parseIds(row.loop_ids),
          projectionIds: parseIds(row.projection_ids),
        },
        { ...input, ...range },
        false,
        bounds,
      )
    )
      return [];
    const precision: TemporalPrecision =
      storedPrecision === "year" ||
      storedPrecision === "month" ||
      storedPrecision === "day" ||
      storedPrecision === "range"
        ? storedPrecision
        : "instant";
    const item: TemporalItem = {
      id,
      origin: "annotation",
      start: new Date(bounds.startMs).toISOString(),
      endExclusive: new Date(bounds.endExclusiveMs).toISOString(),
      precision,
      allDay: bounds.allDay,
      timeZone: input.timeZone,
      label: String(row.sentence),
      kind: kind(row.kind == null ? UNCLASSIFIED_ANNOTATION_KIND : String(row.kind)),
      modality: "inferred",
      status: "active",
      annotation: {
        documentIds: parseIds(row.document_ids),
        personIds: parseIds(row.person_ids),
        loopIds: parseIds(row.loop_ids),
        projectionIds: parseIds(row.projection_ids),
        createdByRun: String(row.created_by_run),
        revision: Number(row.revision),
        createdAt: new Date(Number(row.created_at)).toISOString(),
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
      },
    };
    return [
      {
        item,
        key: {
          startMs: bounds.startMs,
          endExclusiveMs: bounds.endExclusiveMs,
          originRank: 1,
          id,
        },
      },
    ];
  });
}

export interface TemporalStoreWindowRequest {
  /** The query with its statuses defaulted, as the service resolved it. */
  input: TemporalQueryInput;
  range: { fromMs: number; toExclusiveMs: number };
  /** The decoded cursor; mentions are paged past it. */
  after: TemporalSortKey | null;
  limit: number;
  origins: readonly TemporalOrigin[];
  /** Whether the mention worth gate applies to this read. */
  hideUnworthy: boolean;
  /**
   * Read only the annotations that may be anchored in the window: those whose
   * start or end falls inside it, widened by the time-zone shift. A reader
   * that keeps only anchored items gets exactly the items a full read would
   * have marked anchored, without reading every long-lived annotation that
   * merely spans the window.
   */
  anchoredOnly: boolean;
}

export interface TemporalStoreWindow {
  /** Document projections, then annotations, in the order each store returned them. */
  ranked: RankedTemporalItem[];
  /** One page of mentions past the cursor, or null when mentions were not asked for. */
  mentions: MentionPage | null;
}

export function readTemporalStoreWindow(
  db: Db,
  request: TemporalStoreWindowRequest,
): TemporalStoreWindow {
  const { input, range, after, limit, hideUnworthy, anchoredOnly } = request;
  const origins = new Set(request.origins);
  const ranked: RankedTemporalItem[] = [];
  if (origins.has("projection")) ranked.push(...readDocumentProjections(db, input, range));
  if (origins.has("annotation")) {
    ranked.push(...readAnnotations(db, input, range, anchoredOnly));
  }
  const mentions = origins.has("mention")
    ? readMentionPage(db, input, range, after, limit, compareKeys, { hideUnworthy })
    : null;
  return { ranked, mentions };
}

/**
 * The store half of a temporal window read. The gateway serves it from a read
 * worker; without one, {@link directTemporalStoreReads} runs it on the
 * caller's handle.
 */
export interface TemporalStoreReads {
  temporalStoreWindow(request: TemporalStoreWindowRequest): Promise<TemporalStoreWindow>;
}

/**
 * The same read on the caller's own handle, for runtimes without a read
 * worker. A failure rejects like the worker's would, rather than throwing
 * while the caller is still starting its other reads.
 */
export function directTemporalStoreReads(db: Db): TemporalStoreReads {
  return {
    temporalStoreWindow: (request) =>
      new Promise((resolve) => resolve(readTemporalStoreWindow(db, request))),
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  canonicalTemporalKind,
  createLogger,
  isTemporalModality,
  isTemporalStatus,
  intervalOverlapsWindow,
  MAX_TIME_ZONE_SHIFT_MS,
} from "@omnesis/core";
import { TEMPORAL_STATUSES } from "@omnesis/types";
import { projectionRevision } from "../temporal-projections/derive.js";
import { resolveTemporalRange } from "./temporal-range.js";
import type Database from "better-sqlite3";
import type {
  TemporalItem,
  TemporalKind,
  TemporalModality,
  TemporalOrigin,
  TemporalPrecision,
  TemporalQueryInput,
  TemporalQueryResult,
  TemporalStatus,
} from "@omnesis/core";
import type { AnalyticsDb } from "../../analytics-db.js";

const log = createLogger("gateway:temporal-query");

type Db = Database.Database;

interface CursorKey {
  startMs: number;
  endExclusiveMs: number;
  originRank: number;
  id: string;
}

interface CursorEnvelope {
  v: 1;
  fingerprint: string;
  key: CursorKey;
}

interface RankedTemporalItem {
  item: TemporalItem;
  key: CursorKey;
}

interface DocumentIdentity {
  id: string;
  sourceId: string;
  externalId: string;
}

/**
 * Query input the service cannot honour: an unparseable window, a time zone
 * that is not an IANA identifier, a cursor that does not belong to this query.
 *
 * The boundary maps this to a 400 and everything else to a 500, so the two
 * classes stay distinguishable without matching on messages. A failure the
 * caller cannot fix — a store that will not read, a stored canonical that will
 * not parse — is the gateway's own and must not wear a 4xx.
 */
export class TemporalQueryInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TemporalQueryInputError";
  }
}

/**
 * Resolve the window the caller asked for.
 *
 * `resolveTemporalRange` also runs over *stored* bounds while normalizing
 * day-precision rows, where a failure is nobody's request to fix and that row
 * simply keeps the bounds it was written with. It therefore cannot classify
 * its own failures, and only this call — the one reading the caller's
 * `from`/`to`/`timeZone`, where a failure genuinely is the request — relabels
 * them.
 */
function requestedRange(input: TemporalQueryInput): { fromMs: number; toExclusiveMs: number } {
  try {
    return resolveTemporalRange(input);
  } catch (error) {
    throw new TemporalQueryInputError(
      error instanceof Error ? error.message : "Invalid temporal query",
      { cause: error },
    );
  }
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function normalizeList(values: readonly string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  return [...new Set(values)].sort();
}

function normalizedFingerprintInput(
  input: TemporalQueryInput,
  range: { fromMs: number; toExclusiveMs: number },
): object {
  return {
    fromMs: range.fromMs,
    toExclusiveMs: range.toExclusiveMs,
    timeZone: input.timeZone,
    origins: normalizeList(input.origins),
    kinds: normalizeList(input.kinds),
    modalities: normalizeList(input.modalities),
    statuses: normalizeList(input.statuses),
    sourceIds: normalizeList(input.sourceIds),
    documentIds: normalizeList(input.documentIds),
    entityIds: normalizeList(input.entityIds),
  };
}

function fingerprint(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encodeCursor(fingerprintValue: string, key: CursorKey): string {
  const envelope: CursorEnvelope = { v: 1, fingerprint: fingerprintValue, key };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined, expectedFingerprint: string): CursorKey | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorEnvelope;
    if (
      parsed.v !== 1 ||
      parsed.fingerprint !== expectedFingerprint ||
      !Number.isFinite(parsed.key?.startMs) ||
      !Number.isFinite(parsed.key?.endExclusiveMs) ||
      (parsed.key?.originRank !== 0 && parsed.key?.originRank !== 1) ||
      typeof parsed.key?.id !== "string"
    ) {
      throw new Error("mismatch");
    }
    return parsed.key;
  } catch (error) {
    throw new TemporalQueryInputError("Invalid temporal cursor or cursor/query mismatch", {
      cause: error,
    });
  }
}

function compareKeys(left: CursorKey, right: CursorKey): number {
  return (
    left.startMs - right.startMs ||
    left.endExclusiveMs - right.endExclusiveMs ||
    left.originRank - right.originRank ||
    left.id.localeCompare(right.id)
  );
}

function parseJsonObject(
  raw: string | null,
): Record<string, string | number | boolean | null> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, string | number | boolean | null>)
      : undefined;
  } catch {
    return undefined;
  }
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
function kind(value: string): TemporalKind {
  const resolved = canonicalTemporalKind(value);
  if (!resolved) throw new Error(`Stored temporal kind '${value}' is outside the vocabulary`);
  return resolved;
}

function modality(value: string): TemporalModality {
  if (!isTemporalModality(value)) {
    throw new Error(`Stored temporal modality '${value}' is outside the vocabulary`);
  }
  return value;
}

function status(value: string): TemporalStatus {
  if (!isTemporalStatus(value)) {
    throw new Error(`Stored temporal status '${value}' is outside the vocabulary`);
  }
  return value;
}

function readDocumentIdentities(db: Db, documentIds: readonly string[]): DocumentIdentity[] {
  if (documentIds.length === 0) return [];
  return db
    .prepare(
      `SELECT id, source_id, external_id FROM documents
       WHERE id IN (${placeholders(documentIds)})`,
    )
    .all(...documentIds)
    .map((row) => {
      const value = row as { id: string; source_id: string; external_id: string };
      return { id: value.id, sourceId: value.source_id, externalId: value.external_id };
    });
}

function readDocumentIdsForExternalRefs(
  db: Db,
  refs: ReadonlyArray<{ sourceId: string; externalId: string }>,
): Map<string, string> {
  if (refs.length === 0) return new Map();
  const clauses = refs.map(() => "(source_id = ? AND external_id = ?)").join(" OR ");
  const values = refs.flatMap((ref) => [ref.sourceId, ref.externalId]);
  const rows = db
    .prepare(`SELECT id, source_id, external_id FROM documents WHERE ${clauses}`)
    .all(...values) as Array<{ id: string; source_id: string; external_id: string }>;
  return new Map(rows.map((row) => [`${row.source_id}\0${row.external_id}`, row.id]));
}

function normalizedProjectionBounds(
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

function normalizedAnnotationBounds(
  row: {
    precision: string;
    canonical: string | null;
    startMs: number;
    endExclusiveMs: number;
  },
  timeZone: string,
): { startMs: number; endExclusiveMs: number; allDay: boolean } {
  const fallback = {
    startMs: row.startMs,
    endExclusiveMs: row.endExclusiveMs,
    allDay: row.precision !== "instant",
  };
  if (!row.canonical || row.precision === "instant") return fallback;

  const resolve = (value: string) => {
    try {
      return resolveTemporalRange({ from: value.trim(), timeZone });
    } catch {
      return null;
    }
  };
  if (row.precision === "day" || row.precision === "month" || row.precision === "year") {
    const period = resolve(row.canonical);
    return period
      ? {
          startMs: period.fromMs,
          endExclusiveMs: period.toExclusiveMs,
          allDay: true,
        }
      : fallback;
  }
  if (row.precision === "range") {
    const tokens = row.canonical.split(" .. ");
    if (tokens.length !== 2) return fallback;
    const first = resolve(tokens[0]);
    const second = resolve(tokens[1]);
    if (!first || !second) return fallback;
    return {
      startMs: Math.min(first.fromMs, second.fromMs),
      endExclusiveMs: Math.max(first.toExclusiveMs, second.toExclusiveMs),
      allDay: !tokens.every((token) => token.includes("T")),
    };
  }
  return fallback;
}

const overlaps = intervalOverlapsWindow;

export class TemporalQueryService {
  constructor(
    private readonly db: Db,
    private readonly analyticsDb?: AnalyticsDb,
  ) {}

  /**
   * Resolve one live annotation through the same timezone-aware normalization
   * as a window query. The stored interval supplies only a narrow lookup range;
   * the returned item is still produced by `query`, keeping one wire shape and
   * one set of precision rules for list and deep-link reads.
   */
  async annotationById(id: string, timeZone: string): Promise<TemporalItem | null> {
    const stored = this.db
      .prepare(
        `SELECT interval_start_ms, interval_end_ms
           FROM temporal_annotations
          WHERE id = ? AND invalidated_at IS NULL`,
      )
      .get(id) as { interval_start_ms: number; interval_end_ms: number } | undefined;
    if (!stored) return null;

    const result = await this.query({
      from: new Date(stored.interval_start_ms - MAX_TIME_ZONE_SHIFT_MS).toISOString(),
      to: new Date(stored.interval_end_ms + MAX_TIME_ZONE_SHIFT_MS + 1).toISOString(),
      timeZone,
      origins: ["annotation"],
      statuses: ["active"],
      entityIds: [id],
      limit: 100,
    });
    const item =
      result.items.find((entry) => entry.origin === "annotation" && entry.id === id) ?? null;
    // `anchored` is defined relative to a caller's window; the lookup range
    // here is an internal artifact, so the flag would be noise.
    if (item) delete item.anchored;
    return item;
  }

  async query(
    input: TemporalQueryInput,
    execution?: { maxWindowMs?: number; signal?: AbortSignal },
  ): Promise<TemporalQueryResult> {
    if (execution?.signal?.aborted) throw execution.signal.reason;
    const effectiveInput: TemporalQueryInput = {
      ...input,
      statuses: input.statuses ?? [...TEMPORAL_STATUSES],
    };
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const range = requestedRange(effectiveInput);
    if (
      execution?.maxWindowMs !== undefined &&
      range.toExclusiveMs - range.fromMs > execution.maxWindowMs
    ) {
      throw new TemporalQueryInputError("Temporal query window exceeds the allowed maximum");
    }
    const fingerprintValue = fingerprint(normalizedFingerprintInput(effectiveInput, range));
    const after = decodeCursor(effectiveInput.cursor, fingerprintValue);
    const origins = new Set<TemporalOrigin>(effectiveInput.origins ?? ["projection", "annotation"]);
    const documentIdentities = readDocumentIdentities(this.db, effectiveInput.documentIds ?? []);
    const documentRefs =
      effectiveInput.documentIds === undefined
        ? undefined
        : documentIdentities.map((doc) => ({
            sourceId: doc.sourceId,
            externalId: doc.externalId,
          }));

    const ranked: RankedTemporalItem[] = [];
    if (origins.has("projection")) {
      if (this.analyticsDb) {
        ranked.push(...(await this.readAnalyticsProjections(effectiveInput, range, documentRefs)));
        if (execution?.signal?.aborted) throw execution.signal.reason;
      }
      ranked.push(...this.readDocumentProjections(effectiveInput, range));
    }
    if (origins.has("annotation")) {
      ranked.push(...this.readAnnotations(effectiveInput, range));
    }
    if (execution?.signal?.aborted) throw execution.signal.reason;

    // Every matching row is read and ordered here rather than paginated in the
    // stores, because a day-precision row's sort key is resolved in the
    // caller's time zone and so is not the key it was stored under. See #1518.
    ranked.sort((left, right) => compareKeys(left.key, right.key));
    // Anchored = the item starts or ends inside the window, so the window is
    // one of its own boundaries. A merely-spanning item (a long rental, a
    // multi-year warranty) says nothing about the window's days; the counts
    // cover every match so a paginated read still sees the whole picture.
    let anchoredCount = 0;
    for (const entry of ranked) {
      const { startMs, endExclusiveMs } = entry.key;
      const anchored =
        (startMs >= range.fromMs && startMs < range.toExclusiveMs) ||
        (endExclusiveMs > range.fromMs && endExclusiveMs <= range.toExclusiveMs);
      entry.item.anchored = anchored;
      if (anchored) anchoredCount += 1;
    }
    const visible = ranked.filter((entry) => !after || compareKeys(entry.key, after) > 0);
    const page = visible.slice(0, limit);
    const truncated = visible.length > limit;
    const coverage = await this.coverage(effectiveInput.sourceIds);
    return {
      type: "temporal.results",
      window: {
        start: new Date(range.fromMs).toISOString(),
        endExclusive: new Date(range.toExclusiveMs).toISOString(),
        timeZone: effectiveInput.timeZone,
      },
      items: page.map((entry) => entry.item),
      summary: { anchored: anchoredCount, spanning: ranked.length - anchoredCount },
      coverage,
      truncated,
      nextCursor:
        truncated && page.length > 0
          ? encodeCursor(fingerprintValue, page[page.length - 1].key)
          : undefined,
    };
  }

  private async readAnalyticsProjections(
    input: TemporalQueryInput,
    range: { fromMs: number; toExclusiveMs: number },
    documentRefs: Array<{ sourceId: string; externalId: string }> | undefined,
  ): Promise<RankedTemporalItem[]> {
    if (!this.analyticsDb) return [];
    const entityDocumentRefs =
      input.entityIds === undefined
        ? undefined
        : readDocumentIdentities(this.db, input.entityIds).map((doc) => ({
            sourceId: doc.sourceId,
            externalId: doc.externalId,
          }));
    const rows = await this.analyticsDb.queryTemporalProjections({
      fromMs: range.fromMs,
      toMs: range.toExclusiveMs,
      sourceIds: input.sourceIds,
      kinds: input.kinds,
      modalities: input.modalities,
      statuses: input.statuses,
      ids: input.entityIds,
      entityDocumentRefs,
      documentRefs,
    });
    const documentIds = readDocumentIdsForExternalRefs(
      this.db,
      rows.flatMap((row) =>
        row.documentExternalId
          ? [{ sourceId: row.sourceId, externalId: row.documentExternalId }]
          : [],
      ),
    );
    return rows.flatMap((row) => {
      const bounds = normalizedProjectionBounds(row, input.timeZone);
      if (!overlaps(bounds, range)) return [];
      const documentId = row.documentExternalId
        ? documentIds.get(`${row.sourceId}\0${row.documentExternalId}`)
        : undefined;
      const item: TemporalItem = {
        id: row.id,
        origin: "projection",
        start: new Date(bounds.startMs).toISOString(),
        endExclusive: new Date(bounds.endExclusiveMs).toISOString(),
        precision: row.precision,
        allDay: row.allDay,
        timeZone: row.timeZone ?? input.timeZone,
        label: row.label,
        kind: kind(row.kind),
        modality: modality(row.modality),
        status: status(row.status),
        projection: {
          sourceId: row.sourceId,
          slot: row.slot,
          tableName: row.tableName,
          recordKey: parseJsonObject(row.recordKey),
          documentId,
          documentExternalId: row.documentExternalId ?? undefined,
          correlationKeys: parseJsonObject(row.correlationKeys),
          sourceUpdatedAt: row.sourceUpdatedAt ?? undefined,
          projectedAt: row.projectedAt,
          revision: projectionRevision(row),
        },
      };
      return [{ item, key: { ...bounds, originRank: 0, id: row.id } }];
    });
  }

  private readDocumentProjections(
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
    const rows = this.db
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
          sourceUpdatedAt:
            row.source_updated_at == null ? undefined : String(row.source_updated_at),
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

  private readAnnotations(
    input: TemporalQueryInput,
    range: { fromMs: number; toExclusiveMs: number },
  ): RankedTemporalItem[] {
    const where = ["e.invalidated_at IS NULL", "e.interval_start_ms < ?", "e.interval_end_ms >= ?"];
    // Coarse canonical periods are persisted on a UTC anchor and interpreted
    // in the caller's zone. Widen the storage prefilter before normalizing.
    const values: unknown[] = [
      range.toExclusiveMs + MAX_TIME_ZONE_SHIFT_MS,
      range.fromMs - MAX_TIME_ZONE_SHIFT_MS,
    ];
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
        `EXISTS (
          SELECT 1 FROM temporal_annotation_documents d
          WHERE d.annotation_id = e.id
            AND d.document_id IN (${placeholders(input.documentIds)})
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
    const rows = this.db
      .prepare(
        `SELECT e.*,
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
      if (!overlaps(bounds, range)) return [];
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

  private async coverage(
    sourceFilter: readonly string[] | undefined,
  ): Promise<TemporalQueryResult["coverage"]> {
    const syncRows = this.db
      .prepare("SELECT source_id, last_synced_at FROM sync_state")
      .all() as Array<{ source_id: string; last_synced_at: string | null }>;
    const lastSync = new Map(
      syncRows.map((row) => [row.source_id, row.last_synced_at ?? undefined]),
    );
    const include = (sourceId: string) => !sourceFilter || sourceFilter.includes(sourceId);
    const projectionSources: TemporalQueryResult["coverage"]["projectionSources"] = [];
    for (const row of this.db
      .prepare(
        `SELECT source_id, slots_json, last_materialized_at, last_sync_at
         FROM document_temporal_projection_sources`,
      )
      .all() as Array<{
      source_id: string;
      slots_json: string;
      last_materialized_at: string | null;
      last_sync_at: string;
    }>) {
      if (!include(row.source_id)) continue;
      let slots: string[] = [];
      try {
        slots = JSON.parse(row.slots_json) as string[];
      } catch {
        // Coverage remains useful even if one optional slot list is corrupt.
      }
      projectionSources.push({
        sourceId: row.source_id,
        slots,
        lastMaterializedAt: row.last_materialized_at ?? undefined,
        lastSyncAt: row.last_sync_at,
      });
    }
    if (this.analyticsDb) {
      for (const row of await this.analyticsDb.getTemporalProjectionCoverage()) {
        if (!include(row.sourceId)) continue;
        projectionSources.push({
          sourceId: row.sourceId,
          tableName: row.tableName,
          slots: row.slots,
          lastMaterializedAt: row.lastMaterializedAt ?? undefined,
          lastSyncAt: lastSync.get(row.sourceId),
        });
      }
    }

    const projected = new Set(projectionSources.map((row) => row.sourceId));
    const analyticsSpecialists = this.analyticsDb
      ? await this.analyticsDb.getTemporalSpecialistSources()
      : [];
    const specialistSources: TemporalQueryResult["coverage"]["specialistSources"] = [];
    const seen = new Set<string>();
    for (const row of analyticsSpecialists) {
      if (!include(row.sourceId) || projected.has(row.sourceId) || seen.has(row.sourceId)) continue;
      seen.add(row.sourceId);
      specialistSources.push({
        sourceId: row.sourceId,
        queryVia: "analytics",
        reason: row.semanticTime ? "high-volume" : "timeless",
        lastSyncAt: lastSync.get(row.sourceId),
      });
    }
    for (const row of syncRows) {
      if (!include(row.source_id) || projected.has(row.source_id) || seen.has(row.source_id)) {
        continue;
      }
      specialistSources.push({
        sourceId: row.source_id,
        queryVia: "search",
        reason: "not-projected",
        lastSyncAt: row.last_synced_at ?? undefined,
      });
    }
    projectionSources.sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        (left.tableName ?? "").localeCompare(right.tableName ?? ""),
    );
    specialistSources.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    return { projectionSources, specialistSources, annotations: { selective: true } };
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { intervalOverlapsWindow, MAX_TIME_ZONE_SHIFT_MS } from "@omnesis/core";
import { TEMPORAL_STATUSES } from "@omnesis/types";
import { raceAbort } from "../../brain/decision-call.js";
import { countPendingDateExtraction } from "../dates/storage.js";
import { projectionRevision } from "../temporal-projections/derive.js";
import { MENTION_ORIGIN_RANK, readMentionPage } from "./temporal-mentions.js";
import {
  compareKeys,
  directTemporalStoreReads,
  kind,
  modality,
  normalizedProjectionBounds,
  status,
  type RankedTemporalItem,
  type TemporalSortKey as CursorKey,
  type TemporalStoreReads,
} from "./temporal-store-window.js";
import { resolveTemporalRange } from "./temporal-range.js";
import type Database from "better-sqlite3";
import type {
  TemporalItem,
  TemporalOrigin,
  TemporalQueryInput,
  TemporalQueryResult,
} from "@omnesis/core";
import type { AnalyticsDb } from "../../analytics-db.js";

type Db = Database.Database;

interface CursorEnvelope {
  v: 1;
  fingerprint: string;
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
      ![0, 1, MENTION_ORIGIN_RANK].includes(parsed.key?.originRank) ||
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

/** Layers read when a query names none. Mentions are asked for by name. */
const DEFAULT_ORIGINS: readonly TemporalOrigin[] = ["projection", "annotation"];

export interface TemporalQueryOptions {
  /**
   * True while the mention worth gate is active: mentions from email the
   * decision model judged not worth recording are left out.
   */
  hideUnworthyMentions?: () => boolean;
  /**
   * Where the `omnesis.db` half of a window is read — the gateway's read
   * worker. Absent, it is read on this service's own handle.
   */
  storeReads?: TemporalStoreReads;
}

export class TemporalQueryService {
  private readonly storeReads: TemporalStoreReads;

  constructor(
    private readonly db: Db,
    private readonly analyticsDb?: AnalyticsDb,
    private readonly options: TemporalQueryOptions = {},
  ) {
    this.storeReads = options.storeReads ?? directTemporalStoreReads(db);
  }

  /** Resolve a recognized date or annotation using the same live index rules as a window. */
  async itemById(id: string, timeZone: string): Promise<TemporalItem | null> {
    if (!/^dm_\d{16}$/.test(id)) return this.annotationById(id, timeZone);
    const rowId = Number(id.slice(3));
    if (!Number.isSafeInteger(rowId) || rowId < 1) return null;
    const stored = this.db
      .prepare(
        `SELECT document_id, mention_start_day, mention_end_day
           FROM document_extracted_dates WHERE id = ?`,
      )
      .get(rowId) as
      | { document_id: string; mention_start_day: string | null; mention_end_day: string | null }
      | undefined;
    if (!stored?.mention_start_day || !stored.mention_end_day) return null;
    const input: TemporalQueryInput = {
      from: stored.mention_start_day,
      to: stored.mention_end_day,
      timeZone,
      documentIds: [stored.document_id],
      origins: ["mention"],
    };
    const range = requestedRange(input);
    const page = readMentionPage(
      this.db,
      input,
      range,
      {
        startMs: range.fromMs,
        endExclusiveMs: range.toExclusiveMs,
        originRank: MENTION_ORIGIN_RANK,
        id: `dm_${String(rowId - 1).padStart(16, "0")}`,
      },
      1,
      compareKeys,
    );
    const item = page.items.find((entry) => entry.item.id === id)?.item ?? null;
    if (item) delete item.anchored;
    return item;
  }

  /** Live grounding quotes for the detail view; never included in window pages. */
  annotationEvidenceById(id: string): Array<{ documentId: string; quote: string }> {
    return this.db
      .prepare<[string], { documentId: string; quote: string }>(
        `SELECT v.document_id AS documentId, v.quote
           FROM temporal_annotation_evidence v
           JOIN temporal_annotations a ON a.id = v.annotation_id
          WHERE v.annotation_id = ? AND v.broken_at IS NULL
            AND a.invalidated_at IS NULL
          ORDER BY v.position`,
      )
      .all(id);
  }

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
    const read = await this.readWindow(input, execution);
    const { effectiveInput, range, limit, ranked, mentions, hideUnworthy } = read;
    // Anchored = the item starts or ends inside the window, so the window is
    // one of its own boundaries. A merely-spanning item (a long rental, a
    // multi-year warranty) says nothing about the window's days; the counts
    // cover every match so a paginated read still sees the whole picture.
    let anchoredCount = ranked.filter((entry) => entry.item.anchored).length;
    const visible = ranked.filter((entry) => !read.after || compareKeys(entry.key, read.after) > 0);
    if (mentions) {
      visible.push(...mentions.items);
      visible.sort((left, right) => compareKeys(left.key, right.key));
      anchoredCount += mentions.total;
    }
    const page = visible.slice(0, limit);
    const truncated = visible.length > limit;
    const coverage = await this.coverage(effectiveInput.sourceIds);
    if (mentions) {
      coverage.mentions = {
        pendingDocuments: countPendingDateExtraction(this.db, effectiveInput.sourceIds),
        ...(mentions.totalCapped ? { countCapped: true as const } : {}),
        ...(hideUnworthy && !effectiveInput.documentIds?.length && !effectiveInput.entityIds?.length
          ? { unworthyHidden: true as const }
          : {}),
      };
    }
    return {
      type: "temporal.results",
      window: {
        start: new Date(range.fromMs).toISOString(),
        endExclusive: new Date(range.toExclusiveMs).toISOString(),
        timeZone: effectiveInput.timeZone,
      },
      items: page.map((entry) => entry.item),
      summary: {
        anchored: anchoredCount,
        spanning: ranked.length + (mentions?.total ?? 0) - anchoredCount,
      },
      coverage,
      truncated,
      nextCursor:
        truncated && page.length > 0
          ? encodeCursor(read.fingerprint, page[page.length - 1].key)
          : undefined,
    };
  }

  /**
   * The first `limit` items anchored inside the window, in the query's order,
   * without the coverage, counts and cursor a reader of the whole window
   * needs; items that merely span the window, which {@link query} pages
   * through too, are left out. For callers that only want what a window
   * holds, such as search's temporal lane.
   */
  async anchoredItems(
    input: TemporalQueryInput,
    execution?: { signal?: AbortSignal },
  ): Promise<TemporalItem[]> {
    const { ranked, mentions, limit } = await this.readWindow(
      { ...input, cursor: undefined },
      execution,
      { anchoredOnly: true },
    );
    const anchored = ranked.filter((entry) => entry.item.anchored);
    if (mentions) anchored.push(...mentions.items);
    anchored.sort((left, right) => compareKeys(left.key, right.key));
    return anchored.slice(0, limit).map((entry) => entry.item);
  }

  /**
   * Every projection and annotation matching the window, ordered and marked
   * anchored or spanning, and one page of its mentions past the cursor. With
   * `anchoredOnly`, annotations that can only span the window are not read,
   * which leaves the anchored ones exactly as a full read marks them.
   */
  private async readWindow(
    input: TemporalQueryInput,
    execution?: { maxWindowMs?: number; signal?: AbortSignal },
    read: { anchoredOnly: boolean } = { anchoredOnly: false },
  ) {
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
    const origins = new Set<TemporalOrigin>(effectiveInput.origins ?? DEFAULT_ORIGINS);
    const documentIdentities = readDocumentIdentities(this.db, effectiveInput.documentIds ?? []);
    const documentRefs =
      effectiveInput.documentIds === undefined
        ? undefined
        : documentIdentities.map((doc) => ({
            sourceId: doc.sourceId,
            externalId: doc.externalId,
          }));

    // Read once so the page and its coverage agree on whether the gate applied.
    const hideUnworthy = this.options.hideUnworthyMentions?.() ?? false;
    // The analytics store and `omnesis.db` are read side by side. Mentions
    // arrive already paged past the cursor and anchored, with their
    // whole-window count alongside: the layer is too large to read in full.
    const [analyticsProjections, store] = await raceAbort(
      Promise.all([
        origins.has("projection") && this.analyticsDb
          ? this.readAnalyticsProjections(effectiveInput, range, documentRefs)
          : Promise.resolve([]),
        this.storeReads.temporalStoreWindow({
          input: effectiveInput,
          range,
          after,
          limit,
          origins: [...origins],
          hideUnworthy,
          anchoredOnly: read.anchoredOnly,
        }),
      ]),
      execution?.signal,
    );
    if (execution?.signal?.aborted) throw execution.signal.reason;
    const ranked: RankedTemporalItem[] = [...analyticsProjections, ...store.ranked];
    const mentions = store.mentions;

    // Every matching row is read and ordered here rather than paginated in the
    // stores, because a day-precision row's sort key is resolved in the
    // caller's time zone and so is not the key it was stored under. See #55.
    ranked.sort((left, right) => compareKeys(left.key, right.key));
    for (const entry of ranked) {
      const { startMs, endExclusiveMs } = entry.key;
      entry.item.anchored =
        (startMs >= range.fromMs && startMs < range.toExclusiveMs) ||
        (endExclusiveMs > range.fromMs && endExclusiveMs <= range.toExclusiveMs);
    }
    return {
      effectiveInput,
      range,
      limit,
      fingerprint: fingerprintValue,
      after,
      ranked,
      mentions,
      hideUnworthy,
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
      if (!intervalOverlapsWindow(bounds, range)) return [];
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

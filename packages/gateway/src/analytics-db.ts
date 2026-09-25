// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  ensureAnalyticsPageReceipts,
  type AnalyticsPageReceipt,
} from "./analytics/page-receipt-store.js";

/**
 * DuckDB-based analytics database for structured data (health metrics, etc.).
 *
 * `AnalyticsDb` is a thin façade over five collaborating sub-classes that
 * own one slice of the analytics layer each:
 *
 * - `AnalyticsConnectionPool` — DuckDB instance, pool, write queue,
 *   reader-writer lock, lifecycle (`open`/`close`).
 * - `AnalyticsCatalogStore` — every read/write of `_analytics_catalog`.
 * - `AnalyticsTableManager` — `ensureTable` + schema evolution + batch
 *   upsert + batch delete + snapshot reconciliation + per-source teardown.
 * - `AnalyticsTemporalProjectionStore` — internal projection DDL,
 *   connection-scoped materialization/retirement, coverage, and time queries.
 * - `AnalyticsQueryRunner` — the user-SQL sandbox plus the read-side
 *   helpers (`getTableInfo`, `getRecentRows`, `getTableActivity`).
 *
 * The façade keeps callers insulated from that split; read helpers may grow
 * additive options (for example the recent-row keyset cursor) without
 * exposing the collaborators themselves.
 */

import {
  AnalyticsConnectionPool,
  type AnalyticsConnectionPoolOptions,
} from "./analytics/connection-pool.js";
import { AnalyticsCatalogStore } from "./analytics/catalog-store.js";
import { AnalyticsTableManager, type AnalyticsReplicaHooks } from "./analytics/table-manager.js";
import {
  AnalyticsTemporalProjectionStore,
  type AnalyticsTemporalProjectionCoverageRow,
  type AnalyticsTemporalProjectionRow,
} from "./analytics/temporal-projection-store.js";
import {
  AnalyticsAbsenceStore,
  type AnalyticsAbsenceOutcome,
  type DueAnalyticsAbsence,
} from "./analytics/absence-store.js";
import { AnalyticsQueryRunner } from "./analytics/query-runner.js";
import {
  WatchAnalyticsOutboxStore,
  type WatchOutboxBatch,
  type WatchOutboxCursor,
  type WatchOutboxStats,
} from "./analytics/watch-outbox-store.js";
import { quoteIdent } from "./analytics/internal.js";
import type {
  RowKey,
  AnalyticsTableSchema,
  AnalyticsCatalogEntry,
  BoundDocumentSpec,
  ColumnDefinition,
  ColumnType,
  RecordDisplaySpec,
} from "@omnesis/source-sdk";
import type { SnapshotAbsencePolicy } from "./data/repositories/AbsenceRepository.js";
import type { AnalyticsRecentCursor } from "./analytics/query-runner.js";
import type { BoundDocumentBinding } from "./analytics/bound-documents.js";

/**
 * The full schema + identity of one analytics table, as the cite-record path
 * needs it: the persisted record-citation contract
 * (`semanticTimeColumn` + `record`), the column defs (for sensitive-column
 * redaction), the primary key, and the `boundDocument` binding (to resolve a
 * row back to its co-described document). A public projection of the internal
 * catalog row so the façade doesn't leak `CatalogSchemaJson`.
 */
export interface RecordTableSchema {
  tableName: string;
  displayName: string;
  sourceId: string;
  columns: ColumnDefinition[];
  primaryKey: string[];
  semanticTimeColumn: string | null;
  record?: RecordDisplaySpec;
  boundDocument?: BoundDocumentSpec;
  /** The table keys its rows by device stream; a cited row's key then carries its stream column. */
  streamKeyed: boolean;
}

export class AnalyticsDb {
  private readonly pool: AnalyticsConnectionPool;
  private readonly catalog: AnalyticsCatalogStore;
  private readonly tables: AnalyticsTableManager;
  private readonly temporalProjections: AnalyticsTemporalProjectionStore;
  private readonly absences: AnalyticsAbsenceStore;
  private readonly queries: AnalyticsQueryRunner;
  private readonly watchOutbox: WatchAnalyticsOutboxStore;
  private watchBackfill: ((sourceId: string) => boolean) | null = null;
  /**
   * Cached `boundDocument` registry, keyed by bare source type. Built
   * lazily from the catalog and invalidated on any catalog mutation
   * (`ensureTable` / source-id change / source removal). Read on the graph
   * walker's hot path, so it must not re-query DuckDB per walk.
   */
  private boundDocCache: Map<string, BoundDocumentBinding[]> | null = null;

  constructor(
    private dbPath: string,
    opts?: AnalyticsConnectionPoolOptions & {
      maxInlineStreamRekeyRows?: number;
    },
  ) {
    this.pool = new AnalyticsConnectionPool(dbPath, opts);
    this.catalog = new AnalyticsCatalogStore(this.pool);
    this.temporalProjections = new AnalyticsTemporalProjectionStore(this.pool);
    this.absences = new AnalyticsAbsenceStore(this.pool);
    this.watchOutbox = new WatchAnalyticsOutboxStore(this.pool);
    this.tables = new AnalyticsTableManager(
      this.pool,
      this.catalog,
      this.temporalProjections,
      this.absences,
      this.watchOutbox,
      opts?.maxInlineStreamRekeyRows,
    );
    this.queries = new AnalyticsQueryRunner(this.pool, this.catalog);
  }

  async open(): Promise<void> {
    await this.pool.open(async (conn) => {
      await this.catalog.ensureCatalogTable(conn);
      await this.temporalProjections.ensureTables(conn);
      await this.absences.ensureTables(conn);
      await this.watchOutbox.ensureTable(conn);
      await ensureAnalyticsPageReceipts(conn);
      await this.watchOutbox.pruneOnConnection(conn, Date.now() - 48 * 60 * 60 * 1_000);
    });
  }

  async close(opts?: { timeoutMs?: number }): Promise<void> {
    return this.pool.close(opts);
  }

  /**
   * Online copy of the live database into a fresh DuckDB file at
   * `destPath`. Used by the gateway's BackupService — see
   * `AnalyticsConnectionPool.backupTo` for why the copy must go through
   * this pool rather than a second DuckDB instance.
   */
  async backupTo(destPath: string): Promise<void> {
    return this.pool.backupTo(destPath);
  }

  /**
   * Export every analytics table to its own `<table>.csv` file under
   * `destDir`. Used by the gateway's ExportService for the portable
   * CSV export — see `AnalyticsConnectionPool.exportTablesToCsv` for why the
   * copies must go through this pool. Returns the table names written.
   */
  async exportTablesToCsv(destDir: string): Promise<string[]> {
    return this.pool.exportTablesToCsv(destDir);
  }

  // ── Table manager ────────────────────────────────────────────────

  async ensureTable(schema: AnalyticsTableSchema, sourceId: string): Promise<void> {
    await this.tables.ensureTable(schema, sourceId);
    // A schema change can add/remove/alter a boundDocument — drop the cache.
    this.boundDocCache = null;
  }

  async insertRecords(
    tableName: string,
    records: Record<string, unknown>[],
    primaryKey: string[],
  ): Promise<number> {
    return this.tables.insertRecords(tableName, records, primaryKey);
  }

  async deleteRecords(tableName: string, ids: string[], pkColumn: string): Promise<number> {
    return this.tables.deleteRecords(tableName, ids, pkColumn);
  }

  /** See `AnalyticsTableManager.rowKeyColumns`. */
  async rowKeyColumns(tableName: string, pageSchema?: AnalyticsTableSchema): Promise<string[]> {
    return this.tables.rowKeyColumns(tableName, pageSchema);
  }

  /** Canonical ledger keys using the table's effective declaration and SQL column types. */
  async pageRowKeys(page: Parameters<AnalyticsTableManager["pageRowKeys"]>[0]) {
    return this.tables.pageRowKeys(page);
  }

  async ingestPage(input: {
    receipt?: AnalyticsPageReceipt;
    tableName: string;
    records: Record<string, unknown>[];
    schema?: AnalyticsTableSchema;
    sourceId: string;
    deletedIds?: string[];
    deletedKeys?: RowKey[];
    /** See `AnalyticsIngestPage.ledgerDeletedKeys`. */
    ledgerDeletedKeys?: string[];
    deleteKeyColumn?: string;
    presentIds?: string[];
    presentKeys?: RowKey[];
    observationId?: string;
    absencePolicy?: SnapshotAbsencePolicy;
    streamId?: string;
    /** The replica deletion ledger, for a replicated member's page. */
    replica?: AnalyticsReplicaHooks;
    /** The member whose snapshot `presentIds` is, recorded on the absences it marks. */
    observedBy?: string;
  }): Promise<{ ingested: number; deleted: number; absence?: AnalyticsAbsenceOutcome }> {
    const { presentIds, presentKeys, absencePolicy, observationId, observedBy, ...dataInput } =
      input;
    const hasDataWork =
      dataInput.receipt !== undefined ||
      dataInput.schema !== undefined ||
      dataInput.records.length > 0 ||
      (dataInput.deletedIds?.length ?? 0) > 0 ||
      (dataInput.deletedKeys?.length ?? 0) > 0 ||
      (dataInput.ledgerDeletedKeys?.length ?? 0) > 0;
    const watchCapture =
      this.watchBackfill && dataInput.records.length > 0
        ? { observedAt: Date.now(), backfill: this.watchBackfill(dataInput.sourceId) }
        : undefined;
    const dataResult = hasDataWork
      ? await this.tables.ingestPage({ ...dataInput, watchCapture })
      : { ingested: 0, deleted: 0, streamRekeyed: false };
    const { streamRekeyed, ...result } = dataResult;
    const absence =
      (presentIds !== undefined || presentKeys !== undefined) && absencePolicy !== undefined
        ? await this.tables.reconcileSnapshot({
            tableName: input.tableName,
            sourceId: input.sourceId,
            deleteKeyColumn: input.deleteKeyColumn,
            presentIds,
            presentKeys,
            absencePolicy,
            streamId: input.streamId,
            observationId,
            observedBy,
          })
        : undefined;
    // A schema change evolves the table; a rekey changes how its rows are
    // addressed. Either way the bound-document bindings are stale.
    if (input.schema || streamRekeyed) this.boundDocCache = null;
    return { ...result, ...(absence ? { absence } : {}) };
  }

  /** Enable durable analytics capture for the experimental Watch runtime. */
  enableWatchOutbox(backfill: (sourceId: string) => boolean): void {
    this.watchBackfill = backfill;
  }

  disableWatchOutbox(): void {
    this.watchBackfill = null;
  }

  readWatchOutbox(cursor: WatchOutboxCursor, limit: number): Promise<WatchOutboxBatch> {
    return this.watchOutbox.read(cursor, limit);
  }

  pruneWatchOutbox(beforePageSeq: number, olderThanMs: number): Promise<void> {
    return this.watchOutbox.prune(beforePageSeq, olderThanMs);
  }

  acknowledgeWatchOutbox(beforePageSeq: number): Promise<void> {
    return this.watchOutbox.acknowledge(beforePageSeq);
  }

  watchOutboxStats(cursor: WatchOutboxCursor): Promise<WatchOutboxStats> {
    return this.watchOutbox.stats(cursor);
  }

  async deleteAnalyticsForSource(sourceId: string): Promise<string[]> {
    const dropped = await this.tables.deleteAnalyticsForSource(sourceId);
    this.boundDocCache = null;
    return dropped;
  }

  /** Call under source-exclusive authority before deleting source config or other stores. */
  prepareSourceRemoval(sourceId: string, streamId?: string): Promise<void> {
    return this.tables.prepareSourceRemoval(sourceId, streamId);
  }

  /**
   * The analytics rows whose absence from their source's snapshots has been
   * corroborated and has stood past its deadline. Read half of the absence
   * sweep's structured phase.
   */
  async dueAbsences(opts: {
    dueBefore: number;
    minObservations: number;
    limit: number;
  }): Promise<DueAnalyticsAbsence[]> {
    return this.absences.due(opts);
  }

  /**
   * Delete the rows an absence sweep named, with their temporal projections and
   * their absence records. Each writer transaction handles one bounded physical
   * row chunk for one logical absence; `judge` can still keep one, inside that
   * transaction, by answering `disputed`.
   */
  async deleteAbsentRecords(
    due: readonly DueAnalyticsAbsence[],
    judge?: (row: DueAnalyticsAbsence) => Promise<"delete" | "disputed">,
  ): Promise<{ deleted: number; disputed: number }> {
    return this.absences.deleteDue(
      due,
      (row, limit) => this.tables.planAbsentRecordDeletion(row, limit),
      (conn, row) => this.tables.absenceKeyIsCurrent(conn, row),
      (conn, row, plan) => this.tables.deleteAbsentRecordsOnConnection(conn, row, plan),
      judge,
    );
  }

  /** Detach a member from the absences its snapshots earned; see `AnalyticsAbsenceStore.forgetObserver`. */
  async forgetAbsenceObserver(sourceId: string, deviceId?: string): Promise<void> {
    await this.absences.forgetObserver(sourceId, deviceId);
  }

  /** Delete one device stream's rows and projections from every table the source writes. */
  async deleteAnalyticsStream(sourceId: string, streamId: string): Promise<string[]> {
    // The tables and their catalog rows stay, so the bound-document
    // bindings read from them are as valid after the delete as before.
    return this.tables.deleteAnalyticsStream(sourceId, streamId);
  }

  /** Adopt an exclusive source's analytics history into its owner's stream. */
  async adoptExclusiveToPartitioned(sourceId: string, ownerStreamId: string): Promise<string[]> {
    try {
      return await this.tables.adoptExclusiveToPartitioned(sourceId, ownerStreamId);
    } finally {
      // Each table commits independently. A later table may fail after an
      // earlier catalog entry and all of its bound-document keys were rekeyed.
      this.boundDocCache = null;
    }
  }

  /**
   * Batched primary-key lookup for the cross-store graph walker —
   * delegates to the read-side runner. See `AnalyticsQueryRunner.getRowsByKeys`.
   */
  async getRowsByKeys(
    tableName: string,
    keyColumns: { name: string; castType?: ColumnType }[],
    keyTuples: (string | number)[][],
    opts?: { projection?: string[] },
  ): Promise<Map<string, Record<string, unknown>>> {
    return this.queries.getRowsByKeys(tableName, keyColumns, keyTuples, opts);
  }

  /**
   * The cross-store `boundDocument` registry, keyed by bare source
   * type, cached until the next catalog mutation. The graph walker reads this
   * to decide which document vertices have a bound analytics row.
   */
  async getBoundDocumentBindings(): Promise<Map<string, BoundDocumentBinding[]>> {
    if (!this.boundDocCache) {
      this.boundDocCache = await this.catalog.getBoundDocumentBindings();
    }
    return this.boundDocCache;
  }

  // ── Query runner ─────────────────────────────────────────────────

  async executeQuery(
    sql: string,
    opts?: {
      limit?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
      params?: Record<string, string | number | boolean | null | Date>;
      permittedSourceIds?: ReadonlySet<string>;
    },
  ): Promise<{
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    timing: number;
    columnTypes: string[];
  }> {
    return this.queries.executeQuery(sql, opts);
  }

  async getTableInfo(tableName: string): Promise<{
    catalog: AnalyticsCatalogEntry;
    sampleRows: unknown[][];
    sampleColumns: string[];
  } | null> {
    return this.queries.getTableInfo(tableName);
  }

  async getRecentRows(
    tableName: string,
    limit: number,
    after?: AnalyticsRecentCursor,
  ): Promise<{
    columns: string[];
    rows: unknown[][];
    cursors: AnalyticsRecentCursor[];
  }> {
    return this.queries.getRecentRows(tableName, limit, after);
  }

  async getTableActivity(
    tableName: string,
    days: number,
  ): Promise<{ day: string; count: number }[]> {
    return this.queries.getTableActivity(tableName, days);
  }

  /**
   * Source ids whose analytics tables held a sample with a semantic
   * timestamp in `[fromMs, toMs)` — the analytics plane of the Briefs
   * daily-batch discovery. See `AnalyticsQueryRunner.listSourceIdsWithSamplesInRange`.
   */
  async listSourceIdsWithSamplesInRange(fromMs: number, toMs: number): Promise<string[]> {
    return this.queries.listSourceIdsWithSamplesInRange(fromMs, toMs);
  }

  async queryTemporalProjections(input: {
    fromMs: number;
    toMs: number;
    sourceIds?: string[];
    kinds?: string[];
    modalities?: string[];
    statuses?: string[];
    ids?: string[];
    entityDocumentRefs?: Array<{ sourceId: string; externalId: string }>;
    documentRefs?: Array<{ sourceId: string; externalId: string }>;
    after?: { startMs: number; endExclusiveMs: number; originRank: number; id: string };
    limit?: number;
  }): Promise<AnalyticsTemporalProjectionRow[]> {
    return this.temporalProjections.query(input);
  }

  async getTemporalProjectionCoverage(): Promise<AnalyticsTemporalProjectionCoverageRow[]> {
    return this.temporalProjections.getCoverage();
  }

  async getTemporalSpecialistSources(): Promise<
    Array<{ sourceId: string; tableName: string; semanticTime: boolean }>
  > {
    return this.temporalProjections.getSpecialistSources();
  }

  // ── Catalog store ────────────────────────────────────────────────

  async getPrimaryKey(tableName: string): Promise<string[]> {
    return this.catalog.getPrimaryKey(tableName);
  }

  async getCatalog(): Promise<AnalyticsCatalogEntry[]> {
    return this.catalog.getCatalog();
  }

  /**
   * Full schema + identity for one table, or `null` when the catalog
   * has no such row. Carries the persisted record-citation contract so the
   * cite-record path derives a record without any source-specific code. Older
   * catalog rows (written before the record-citation contract) read `semanticTimeColumn` as
   * `undefined`; this maps it to `null` (timeless until re-synced).
   */
  async getRecordTableSchema(tableName: string): Promise<RecordTableSchema | null> {
    const entry = await this.catalog.getTableSchema(tableName);
    if (!entry) return null;
    return {
      tableName: entry.tableName,
      displayName: entry.displayName,
      sourceId: entry.sourceId,
      columns: entry.schema.columns,
      primaryKey: entry.schema.primaryKey,
      semanticTimeColumn: entry.schema.semanticTimeColumn ?? null,
      record: entry.schema.record,
      boundDocument: entry.schema.boundDocument,
      streamKeyed: entry.streamKeyed,
    };
  }

  async updateCatalogStats(tableName: string): Promise<void> {
    return this.catalog.updateStats(tableName, quoteIdent(tableName));
  }

  async updateCatalogSourceId(tableName: string, sourceId: string): Promise<void> {
    await this.catalog.updateSourceId(tableName, sourceId);
    // The bare-type collapse changes which source-type a binding maps under.
    this.boundDocCache = null;
  }
}

export { InvalidAnalyticsRecentCursorError } from "./analytics/query-runner.js";
export type { AnalyticsRecentCursor } from "./analytics/query-runner.js";

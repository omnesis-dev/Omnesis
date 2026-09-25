// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `AnalyticsTableManager` — DDL/DML against the data tables (the ones
 * registered in `_analytics_catalog`). Schema evolution, batch upsert,
 * batch delete, snapshot reconciliation, and per-source teardown all funnel
 * through here. Catalog row reads/writes are delegated to
 * `AnalyticsCatalogStore`; deterministic time-fact materialization is
 * delegated to `AnalyticsTemporalProjectionStore`.
 */

import { createLogger } from "@omnesis/core";
import { sourceAccountOf, sourceTypeOf } from "@omnesis/types";
import {
  analyticsDeleteKey,
  analyticsSchemaUsesDynamicColumns,
  normalizeAnalyticsColumnType,
  normalizeAnalyticsSchemaColumnTypes,
  validateAnalyticsDeleteKeys,
  validateAnalyticsSchemasHavePrimaryKey,
  validateAnalyticsSchemasReserveLeadingUnderscore,
  validateAnalyticsSchemasReserveStreamColumn,
  validateBoundDocuments,
  validateRecordCitationContract,
  downgradeAmbiguousAnchor,
  normalizeSchemaProjectionFields,
  validateTemporalProjectionContracts,
  RowKeyError,
  normalizeTableKeys,
} from "@omnesis/source-sdk";
import {
  observationSpacingMs,
  type SnapshotAbsencePolicy,
} from "../data/repositories/AbsenceRepository.js";
import {
  readAnalyticsPageReceipt,
  recordAnalyticsPageReceipt,
  clearAnalyticsPageReceipts,
  type AnalyticsPageReceipt,
} from "./page-receipt-store.js";
import { escapeStr, formatValue, parseSchemaJson, quoteIdent, STREAM_COLUMN } from "./internal.js";
import { encodeTypedRowKeys, rowKeyExpr, rowKeySpace } from "./row-key-sql.js";
import {
  ANALYTICS_ABSENCE_OBSERVATIONS_TABLE,
  ANALYTICS_ABSENCE_SCOPES_TABLE,
  ANALYTICS_ABSENCES_TABLE,
  type AnalyticsAbsencePhysicalPlan,
  type AnalyticsAbsenceOutcome,
  type DueAnalyticsAbsence,
  type AnalyticsAbsenceStore,
} from "./absence-store.js";
import { TEMPORAL_PROJECTIONS_TABLE } from "./temporal-projection-store.js";
import { DEFAULT_ANALYTICS_STREAM_REKEY_MAX_ROWS } from "./settings.js";
import { AnalyticsAccountOwnership } from "./account-ownership.js";
import type { AnalyticsTableSchema, RowKey } from "@omnesis/source-sdk";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { AnalyticsConnectionPool } from "./connection-pool.js";
import type { AnalyticsCatalogStore } from "./catalog-store.js";
import type { AnalyticsTemporalProjectionStore } from "./temporal-projection-store.js";
import type { WatchAnalyticsOutboxStore, WatchOutboxCapture } from "./watch-outbox-store.js";

const log = createLogger("gateway:analytics:tables");

/** Absolute ceiling on ledger rows one analytics writer transaction may mutate. */
const ANALYTICS_ABSENCE_WRITER_CHUNK = 200;

/**
 * Prefix for an archived column — a dropped column or the old-typed form of
 * a column whose source type changed. Double underscore so a real source
 * column can't collide with the archive namespace.
 */
const ARCHIVE_PREFIX = "_archived__";

export interface AnalyticsIngestPage {
  receipt?: AnalyticsPageReceipt;
  tableName: string;
  records: Record<string, unknown>[];
  schema?: AnalyticsTableSchema;
  sourceId: string;
  /**
   * Rows to delete, as canonical row keys over the table's declared delete
   * key. `deletedKeys` says the same thing as records; the host encodes them
   * once the schema has said which columns address the table.
   */
  deletedIds?: string[];
  deletedKeys?: RowKey[];
  /**
   * @deprecated The delete key belongs to the table. A page naming a
   * different column is refused rather than addressing one table two ways.
   */
  deleteKeyColumn?: string;
  presentIds?: string[];
  presentKeys?: RowKey[];
  /**
   * Deletions the GATEWAY derived rather than the page named — a restorer's
   * omissions that matured into its own verdict. They come out of the replica
   * ledger, so they are already canonical row keys, and they join whatever
   * spelling the page used rather than competing with it.
   */
  ledgerDeletedKeys?: string[];
  /** Stable identity of the completed snapshot observation. */
  observationId?: string;
  /**
   * Thresholds an omitted row's absence must clear before it deletes. Required
   * alongside `presentIds`; a page without one records no absences, which is
   * the safe reading of a caller that did not state the policy.
   */
  absencePolicy?: SnapshotAbsencePolicy;
  /**
   * The device stream the page belongs to — the contributing device's id for
   * a partitioned source — or `""` for a source with one stream. Upserts,
   * deletes and the snapshot reconcile stay within it.
   */
  streamId?: string;
  /**
   * The replica deletion ledger, for a replicated member's page. Its hooks
   * run inside the page's transaction: a verdict is durable before the rows
   * it concerns change, and a failure rolls the page back.
   */
  replica?: AnalyticsReplicaHooks;
  /** Present only while the experimental Watch runtime is capturing rows. */
  watchCapture?: WatchOutboxCapture;
}

/** What a replicated member's page asks the replica deletion ledger, in page order. */
export interface AnalyticsReplicaHooks {
  /** The page holds these rows: a deleter withdraws, or a sibling's restore goes on record. */
  recordPresence(keyValues: string[]): Promise<void>;
  /**
   * Of the tombstoned key values that name a row the table holds, the ones
   * the page may delete: a fresh deletion the member is allowed to lead, or
   * one every restorer has agreed to. The rest stay.
   */
  judgeDeletions(existingIds: string[]): Promise<{ apply: string[]; deferred?: boolean }>;
}

export interface AnalyticsIngestPageResult {
  ingested: number;
  deleted: number;
  /** What the page's snapshot changed about this table's pending absences. */
  absence?: AnalyticsAbsenceOutcome;
  /** This page's device stream keyed the table by stream: the table was rebuilt around the stream column. */
  streamRekeyed: boolean;
}

/** AND together the scope predicates that apply; none when neither does. */
function joinScopes(...scopes: Array<string | undefined>): string | undefined {
  const present = scopes.filter((scope): scope is string => scope !== undefined);
  return present.length > 0 ? present.join(" AND ") : undefined;
}

/**
 * Canonicalize a DuckDB column type to the exact spelling
 * `information_schema.columns.data_type` returns, so a declared schema type
 * compares equal to the live column type without a spurious mismatch.
 *
 * The `ColumnType` strings the source SDK emits already match DuckDB's
 * canonical rendering (VARCHAR, BIGINT, DOUBLE, `DECIMAL(18,4)`, `VARCHAR[]`,
 * …) verbatim after `normalizeAnalyticsColumnType` — except `TIMESTAMPTZ`,
 * which `information_schema` renders as `TIMESTAMP WITH TIME ZONE`.
 */
function canonicalDuckType(type: string): string {
  const t = normalizeAnalyticsColumnType(type, "DuckDB catalog column type");
  if (t === "TIMESTAMPTZ") return "TIMESTAMP WITH TIME ZONE";
  return t;
}

export class AnalyticsTableManager {
  private readonly ownership: AnalyticsAccountOwnership;
  constructor(
    private readonly pool: AnalyticsConnectionPool,
    private readonly catalog: AnalyticsCatalogStore,
    private readonly temporalProjections: AnalyticsTemporalProjectionStore,
    private readonly absences: AnalyticsAbsenceStore,
    private readonly watchOutbox: WatchAnalyticsOutboxStore,
    private readonly maxInlineStreamRekeyRows = DEFAULT_ANALYTICS_STREAM_REKEY_MAX_ROWS,
  ) {
    this.ownership = new AnalyticsAccountOwnership(catalog);
  }

  private normalizeAndValidateSchema(
    schema: AnalyticsTableSchema,
    sourceId: string,
  ): AnalyticsTableSchema {
    // A device may push a schema whose anchor column cannot yield a stable
    // instant. Drop the anchor rather than failing the ingest; the rows still
    // land, they simply are not timeline-eligible.
    const normalizedSchema = downgradeAmbiguousAnchor(
      normalizeSchemaProjectionFields(
        normalizeAnalyticsSchemaColumnTypes(schema, `ensureTable('${sourceId}')`),
      ),
      (message) => log.warn(`ensureTable('${sourceId}'): ${message}`),
    );
    validateAnalyticsSchemasHavePrimaryKey([normalizedSchema], `ensureTable('${sourceId}')`);
    validateAnalyticsDeleteKeys([normalizedSchema], `ensureTable('${sourceId}')`);
    validateAnalyticsSchemasReserveStreamColumn([normalizedSchema], `ensureTable('${sourceId}')`);
    validateAnalyticsSchemasReserveLeadingUnderscore(
      [normalizedSchema],
      `ensureTable('${sourceId}')`,
    );
    validateBoundDocuments([normalizedSchema], `ensureTable('${sourceId}')`);
    validateRecordCitationContract([normalizedSchema], `ensureTable('${sourceId}')`, {
      requireRecord: false,
    });
    validateTemporalProjectionContracts([normalizedSchema], `ensureTable('${sourceId}')`);
    return normalizedSchema;
  }

  /**
   * Create a table if it doesn't exist and upsert its catalog entry.
   * Schema evolution (additive ALTER TABLE) runs in the same write
   * transaction so the new columns are visible before the subsequent
   * `INSERT INTO ... VALUES` lands.
   */
  async ensureTable(schema: AnalyticsTableSchema, sourceId: string): Promise<void> {
    const normalizedSchema = this.normalizeAndValidateSchema(schema, sourceId);
    // Reject dynamically-emitted schemas without a primary key at the
    // ingest boundary — per-page writes are at-least-once (a cursor-
    // write failure after `upsertDocuments` succeeded leaves the
    // docs/rows landed and the cursor stale, so the next cycle re-
    // upserts the same page). Document upserts absorb the retry via
    // the `(provider_id, source_id, external_id)` UNIQUE constraint;
    // analytics-row upserts only absorb the retry when the schema
    // declared a primary key. Without one, dupes accumulate. Static
    // schemas are caught at `defineSource` / `defineProvider` /
    // `defineStructuredSource` time; dynamic schemas (Notion's
    // `mapDatabaseToSchema` output) only reach the gateway, so the
    // boundary check is here.
    // Reject a malformed boundDocument at the same boundary, so dynamic
    // Notion schemas that declare one can't persist a binding the walker can't
    // invert into a unique row.
    // Validate the record-citation contract at the same boundary —
    // dynamic Notion schemas declare semanticTimeColumn + record spec at sync
    // time, so this is where they're checked. `requireRecord: false` keeps the
    // gateway backward-compatible: an older device client omits these
    // fields, and its rows must still ingest (the table is simply not citation-
    // eligible until the client is updated). A present-but-malformed contract is
    // still rejected.
    return this.pool.serializeWrite(() =>
      this.pool.withConn(async (p) => {
        await p.conn.run("BEGIN TRANSACTION");
        try {
          await this.ensureTableOnConnection(p.conn, normalizedSchema, sourceId);
          const effective = await this.readPersistedSchema(p.conn, schema.tableName);
          if (effective) await this.ownership.repair(p.conn, effective, sourceId);
          await p.conn.run("COMMIT");
        } catch (error) {
          try {
            await p.conn.run("ROLLBACK");
          } catch {
            /* Preserve the admission error. */
          }
          throw error;
        }
      }),
    );
  }

  private async ensureTableOnConnection(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
  ): Promise<void> {
    const owner = await this.catalog.readOwnerForTable(conn, schema.tableName);
    if (owner && sourceTypeOf(owner) !== sourceTypeOf(sourceId)) {
      throw new Error(
        `Analytics table ${schema.tableName} belongs to source type ${sourceTypeOf(owner)}, not ${sourceTypeOf(sourceId)}`,
      );
    }
    const previousSchema = await this.readPersistedSchema(conn, schema.tableName);
    if (
      previousSchema &&
      analyticsSchemaUsesDynamicColumns(previousSchema) &&
      !analyticsSchemaUsesDynamicColumns(schema) &&
      ((!previousSchema.sharedDiscriminatorColumn && schema.sharedDiscriminatorColumn) ||
        (!previousSchema.sharedDiscriminatorParent && schema.sharedDiscriminatorParent))
    )
      throw new RowKeyError(
        "Cannot introduce account ownership from a static schema into a dynamic analytics table; replay its complete dynamic schema first",
      );
    await this.ownership.validateRegistration(conn, schema, sourceId);
    const previousParent = previousSchema?.sharedDiscriminatorParent;
    const incomingParent = schema.sharedDiscriminatorParent;
    if (
      previousParent &&
      incomingParent &&
      (previousParent.table !== incomingParent.table ||
        previousParent.column !== incomingParent.column ||
        previousParent.parentColumn !== incomingParent.parentColumn)
    )
      throw new RowKeyError("An analytics ownership parent cannot be replaced");
    if (
      previousSchema?.sharedDiscriminatorColumn &&
      schema.sharedDiscriminatorColumn !== undefined &&
      schema.sharedDiscriminatorColumn !== previousSchema.sharedDiscriminatorColumn
    ) {
      throw new RowKeyError("An analytics account discriminator cannot be replaced");
    }
    const protectedColumns = new Set([
      previousSchema?.sharedDiscriminatorColumn,
      previousParent?.column,
    ]);
    for (const previous of previousSchema?.columns ?? []) {
      if (!protectedColumns.has(previous.name)) continue;
      const incoming = schema.columns.find((column) => column.name === previous.name);
      if (
        incoming &&
        normalizeAnalyticsColumnType(previous.type, "Ownership column") !==
          normalizeAnalyticsColumnType(incoming.type, "Ownership column")
      )
        throw new RowKeyError("An analytics account discriminator type cannot be replaced");
      if (
        previous.sourceColumnId &&
        schema.columns.some(
          (column) =>
            column.sourceColumnId === previous.sourceColumnId && column.name !== previous.name,
        )
      )
        throw new RowKeyError("An analytics ownership column cannot be renamed");
    }
    const colDefs = schema.columns.map((col) => {
      const nullable = col.nullable ? "" : " NOT NULL";
      return `${quoteIdent(col.name)} ${col.type}${nullable}`;
    });
    if (schema.primaryKey.length > 0) {
      colDefs.push(`PRIMARY KEY (${schema.primaryKey.map(quoteIdent).join(", ")})`);
    }
    await conn.run(
      `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema.tableName)} (${colDefs.join(", ")})`,
    );
    const addedColumns = await this.evolveTableSchema(conn, schema);
    await this.stampDiscriminatorOnLegacyRows(conn, schema, sourceId, addedColumns);
    await this.catalog.upsertEntry(conn, schema, sourceId);
    log.debug(`Ensured table ${schema.tableName} with ${schema.columns.length} columns`);
  }

  /**
   * Add any columns from the schema that don't exist in the table yet.
   * Handles schema evolution for dynamic sources (e.g., Notion databases
   * where users add new properties between syncs).
   *
   * Takes the conn from its caller — runs as part of `ensureTable`'s
   * single-checkout transaction so the new columns are visible before
   * the subsequent `INSERT INTO ... VALUES` lands.
   *
   * **Three-phase merge.** Runs in this order:
   *
   *   1. **Rename** — for every new
   *      column carrying `sourceColumnId`, look up the previously-
   *      persisted catalog row and find a column with the same
   *      `sourceColumnId` but a different name. If one exists, issue
   *      `ALTER TABLE RENAME COLUMN <old> TO <new>` so historical
   *      data stays under the new name. Notion property renames
   *      (property `id` is stable across rename) are the canonical
   *      case.
   *
   *   2. **Add** — every column in `schema.columns`
   *      that's still absent from the table after the rename pass
   *      gets an `ADD COLUMN`. Additive, preserves existing rows.
   *
   *   3. **Archive** — for a schema declaring `dynamicColumns`, every
   *      column present in the table but absent from the new schema (and not
   *      an existing `_archived__` entry) gets renamed to `_archived__<col>`.
   *      Historical values survive in the archived column; the
   *      original name is freed so a delete-then-re-add lands
   *      cleanly on the original slot.
   *
   * Archive collision: if `_archived__<col>` already exists from a
   * prior cycle, drop it first so we keep at most one archived copy
   * per name (the most recent). The dropped copy is the older
   * archive, so the user's "last known state" is what survives.
   *
   * System columns (id / created_time / last_edited_time on Notion,
   * primary keys on every table) are never archived — they're
   * structural and the schema mapper always includes them. The
   * archive prefix is `_archived__` (double underscore) so it can't
   * collide with a user-named Notion property (sanitizeColumnName
   * strips leading underscores).
   */
  /**
   * Fill a newly-added discriminator column on rows written before the source
   * became multi-account.
   *
   * A shared table is cleaned up per source by
   * `deleteAnalyticsForSource` case B, which deletes
   * `WHERE <discriminator> = '<account>'`. Rows predating the column sit at
   * NULL, so removing the account that wrote them would delete only its newer
   * rows and strand the rest permanently — case A's `DROP TABLE` no longer
   * applies once a sibling account exists, so nothing else would ever collect
   * them. They also cannot self-heal: these sources sync incrementally from a
   * cursor and never re-fetch history.
   *
   * Safe precisely because it runs while ownership is still exclusive: the
   * catalog still names one full `<type>:<account>` id, so every existing row
   * demonstrably belongs to that account. Once a sibling appears the catalog
   * collapses to the bare type and this stops firing, which is correct — at
   * that point a NULL is genuinely ambiguous.
   *
   * Runs once, on the call that adds the column, so it never touches a
   * steady-state sync.
   */
  private async stampDiscriminatorOnLegacyRows(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
    addedColumns: readonly string[],
  ): Promise<void> {
    const discriminator = schema.sharedDiscriminatorColumn;
    if (!discriminator) return;
    // Only on the call that introduced the column. That is the one moment the
    // pre-existing rows are known to predate it, and it keeps this off the
    // ingest path — every later sync would otherwise pay a full column scan,
    // since the discriminator is deliberately not part of any primary key and
    // therefore carries no index.
    if (!addedColumns.includes(discriminator)) return;
    const accountId = sourceAccountOf(sourceId);
    if (!accountId) return;

    const owner = await this.catalog.readOwnerForTable(conn, schema.tableName);
    // No catalog row yet → the table was just created and has no rows to
    // stamp. An owner other than this exact source → shared, so a NULL can no
    // longer be attributed.
    if (owner !== sourceId) return;

    const probe = await conn.runAndReadAll(
      `SELECT 1 FROM ${quoteIdent(schema.tableName)} WHERE ${quoteIdent(discriminator)} IS NULL LIMIT 1`,
    );
    if (probe.getRows().length === 0) return;

    await conn.run(
      `UPDATE ${quoteIdent(schema.tableName)} SET ${quoteIdent(discriminator)} = '${escapeStr(accountId)}' WHERE ${quoteIdent(discriminator)} IS NULL`,
    );
    log.info(
      `Stamped ${discriminator}='${accountId}' on pre-existing ${schema.tableName} rows while ${sourceId} still owns the table`,
    );
  }

  private async evolveTableSchema(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
  ): Promise<string[]> {
    const addedColumns: string[] = [];
    const result = await conn.runAndReadAll(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${escapeStr(schema.tableName)}'`,
    );
    const existingColumns = new Set<string>();
    // Actual DuckDB type of each live column, keyed by name. Used by the
    // type-change phase to spot a column whose source type was swapped
    // (e.g. a Notion property switched from text to number). The map is
    // kept in sync as Phase 1 renames move a column's type to its new name.
    const existingTypes = new Map<string, string>();
    for (const row of result.getRows()) {
      const name = String(row[0]);
      existingColumns.add(name);
      existingTypes.set(name, canonicalDuckType(String(row[1])));
    }

    // Read the previously-persisted schema_json so we can detect
    // renames by `sourceColumnId`. A missing or corrupt row means
    // we have no rename history — treat every disappeared column as
    // a delete (existing archive behaviour).
    const prevSchemaRow = await conn.runAndReadAll(
      `SELECT schema_json FROM _analytics_catalog WHERE table_name = '${escapeStr(schema.tableName)}'`,
    );
    const prevRows = prevSchemaRow.getRows() as unknown[][];
    const prevSchema =
      prevRows.length > 0 ? parseSchemaJson(String(prevRows[0][0]), schema.tableName) : null;
    const prevColumnsById = new Map<string, { name: string }>();
    if (prevSchema) {
      for (const col of prevSchema.columns) {
        if (col.sourceColumnId) prevColumnsById.set(col.sourceColumnId, { name: col.name });
      }
    }

    // Phase 1: detect renames via sourceColumnId stability. The set
    // of columns we've already mutated is tracked so the add-phase
    // doesn't re-add a renamed-into-place name.
    const renamedFrom = new Set<string>();
    const renamedTo = new Set<string>();
    for (const col of schema.columns) {
      if (!col.sourceColumnId) continue;
      const prev = prevColumnsById.get(col.sourceColumnId);
      if (!prev) continue;
      if (prev.name === col.name) continue;
      // Only act if the old name still exists on the table and the
      // new name doesn't — defends against partial-prior-state
      // (the rename was already applied to the table but not yet
      // mirrored into the catalog row, or vice versa).
      if (!existingColumns.has(prev.name)) continue;
      if (existingColumns.has(col.name)) continue;
      await conn.run(
        `ALTER TABLE ${quoteIdent(schema.tableName)} RENAME COLUMN ${quoteIdent(prev.name)} TO ${quoteIdent(col.name)}`,
      );
      log.info(
        `Renamed column ${prev.name} → ${col.name} on ${schema.tableName} (sourceColumnId=${col.sourceColumnId} stable across rename)`,
      );
      existingColumns.delete(prev.name);
      existingColumns.add(col.name);
      // A rename preserves the column's type — carry it to the new name so
      // the type-change phase below compares against the right type.
      const prevType = existingTypes.get(prev.name);
      if (prevType !== undefined) {
        existingTypes.set(col.name, prevType);
        existingTypes.delete(prev.name);
      }
      renamedFrom.add(prev.name);
      renamedTo.add(col.name);
    }

    // Phase 1.5: reconcile type changes. A source column whose type was
    // swapped (e.g. a Notion property changed from text to number) keeps
    // its name but its DuckDB column still has the old type, so the next
    // insert would coerce or reject the new-typed values. DuckDB can't
    // always cast the existing data losslessly (a text → number swap on
    // free-form text fails), so — matching the column-drop strategy — we
    // ARCHIVE the old column (preserving its historical values under
    // `_archived__<col>`) and let Phase 2 add a fresh column of the new
    // type. The current sync repopulates it on the same pass.
    for (const col of schema.columns) {
      if (!existingColumns.has(col.name)) continue;
      const currentType = existingTypes.get(col.name);
      if (currentType === undefined) continue;
      if (currentType === canonicalDuckType(col.type)) continue;
      await this.archiveColumn(conn, schema.tableName, col.name, existingColumns);
      existingTypes.delete(col.name);
      log.info(
        `Type change on ${schema.tableName}.${col.name}: ${currentType} → ${col.type}; archived old column, re-adding with new type`,
      );
    }

    // Phase 2: add new columns (including type-changed columns whose old
    // form was just archived above).
    for (const col of schema.columns) {
      if (existingColumns.has(col.name)) continue;
      await conn.run(
        `ALTER TABLE ${quoteIdent(schema.tableName)} ADD COLUMN ${quoteIdent(col.name)} ${col.type}`,
      );
      log.info(`Added column ${col.name} (${col.type}) to ${schema.tableName}`);
      addedColumns.push(col.name);
      existingColumns.add(col.name);
      existingTypes.set(col.name, canonicalDuckType(col.type));
    }

    // Fixed schemas are release-managed and additive. A separately deployed
    // older client may keep sending its old schema; it must not archive columns
    // a newer release introduced. Only explicitly dynamic upstream schemas may
    // interpret omission as a user deleting a column.
    if (!analyticsSchemaUsesDynamicColumns(schema, prevSchema)) return addedColumns;

    // Phase 3: archive columns that disappeared from a dynamic schema.
    const schemaColumnNames = new Set(schema.columns.map((c) => c.name));
    for (const existing of [...existingColumns]) {
      if (schemaColumnNames.has(existing)) continue;
      if (existing === STREAM_COLUMN) continue;
      if (existing === prevSchema?.sharedDiscriminatorColumn) continue;
      if (existing === prevSchema?.sharedDiscriminatorParent?.column) continue;
      if (existing.startsWith(ARCHIVE_PREFIX)) continue;
      // Phase-1 renamed-from names disappeared from existingColumns
      // already — defensive, no-op here.
      if (renamedFrom.has(existing)) continue;
      // Audit: surface `_2`-suffixed legacy columns from before the
      // rename detector existed. The user may want to manually
      // drop / merge these post-merge; the gateway doesn't auto-
      // migrate because the original property mapping isn't
      // recoverable from the column name alone.
      if (/_\d+$/.test(existing) && /^notion_/.test(schema.tableName)) {
        log.warn(
          `Notion table ${schema.tableName} has legacy suffixed column ${existing} — predates rename detection; manual review recommended.`,
        );
      }
      await this.archiveColumn(conn, schema.tableName, existing, existingColumns);
      log.info(`Archived column ${existing} on ${schema.tableName} (no longer in schema)`);
    }

    return addedColumns;
  }

  /**
   * Rename `column` to `_archived__<column>` so its historical values are
   * preserved out of the way of the live schema. Used for both column drops
   * (Phase 3) and type changes (Phase 1.5 — the old-typed column is archived
   * and a fresh one of the new type is added). Drops any pre-existing archive
   * of the same name first, keeping the archive set bounded to one entry per
   * original column, then updates `existingColumns` to reflect the rename.
   */
  private async archiveColumn(
    conn: DuckDBConnection,
    tableName: string,
    column: string,
    existingColumns: Set<string>,
  ): Promise<void> {
    const archived = `${ARCHIVE_PREFIX}${column}`;
    if (existingColumns.has(archived)) {
      await conn.run(`ALTER TABLE ${quoteIdent(tableName)} DROP COLUMN ${quoteIdent(archived)}`);
      existingColumns.delete(archived);
      log.info(`Dropped prior archive ${archived} on ${tableName} to make room for newer archive`);
    }
    await conn.run(
      `ALTER TABLE ${quoteIdent(tableName)} RENAME COLUMN ${quoteIdent(column)} TO ${quoteIdent(archived)}`,
    );
    existingColumns.delete(column);
    existingColumns.add(archived);
  }

  /**
   * One structured-source page is one DuckDB transaction. Projection
   * materialization is part of the row write, so a datum is never observable
   * without its source-owned time fact and a malformed fact lands neither.
   */
  async ingestPage(page: AnalyticsIngestPage): Promise<AnalyticsIngestPageResult> {
    const sourceId = page.sourceId || "unknown";
    const incomingSchema = page.schema
      ? this.normalizeAndValidateSchema(page.schema, sourceId)
      : undefined;

    return this.pool.serializeWrite(() =>
      this.pool.withConn(async (p) => {
        await p.conn.run("BEGIN TRANSACTION");
        try {
          if (page.receipt) {
            const committed = await readAnalyticsPageReceipt(
              p.conn,
              sourceId,
              page.streamId ?? "",
              page.receipt,
            );
            if (committed) {
              await p.conn.run("COMMIT");
              return committed;
            }
          }
          let receiptAllowed = true;
          const previousSchema = incomingSchema
            ? await this.readPersistedSchema(p.conn, page.tableName)
            : null;
          if (incomingSchema) {
            await this.ensureTableOnConnection(p.conn, incomingSchema, sourceId);
          }
          // The catalog merges declarations from older clients with persisted
          // key metadata. This page must use that same effective key.
          const schema = await this.readPersistedSchema(p.conn, page.tableName);
          if (!schema) {
            throw new Error(
              `Cannot ingest analytics table ${page.tableName}: no schema was supplied or registered`,
            );
          }
          await this.catalog.claimSource(p.conn, page.tableName, sourceId);
          if (incomingSchema) {
            await this.temporalProjections.retireChangedContract(
              p.conn,
              sourceId,
              page.tableName,
              previousSchema?.temporalProjection,
              incomingSchema.temporalProjection,
            );
          }

          const streamId = page.streamId ?? "";
          const { streamKeyed, rebuilt: streamRekeyed } = await this.ensureStreamScope(
            p.conn,
            schema,
            streamId,
          );
          await this.ownership.repair(p.conn, schema, sourceId);
          // With a stream column the row key is the declared key plus the
          // stream, so two devices' rows with the same declared key coexist.
          const primaryKey = streamKeyed
            ? [...schema.primaryKey, STREAM_COLUMN]
            : schema.primaryKey;
          // A temporal projection's key leaves the empty stream implicit, so
          // a projection derived before the table keyed by stream keeps its
          // key — and its id — when the row is written again.
          const projectionKey = streamId === "" ? schema.primaryKey : primaryKey;
          const streamScope = streamKeyed
            ? `${quoteIdent(STREAM_COLUMN)} = '${escapeStr(streamId)}'`
            : undefined;
          const scopedRecords = await this.ownership.scopeRecords(
            p.conn,
            schema,
            sourceId,
            page.records,
            streamScope,
          );
          const records: Record<string, unknown>[] = streamKeyed
            ? scopedRecords.map((record) => ({ ...record, [STREAM_COLUMN]: streamId }))
            : scopedRecords;
          const keyColumns = this.deleteKeyFor(page.tableName, schema, page.deleteKeyColumn);
          if (schema.deleteKey === undefined && page.deleteKeyColumn !== undefined) {
            await this.catalog.upsertEntry(p.conn, { ...schema, deleteKey: keyColumns }, sourceId);
          }
          const deletedKeys = [
            ...((await this.pageKeys(p.conn, schema, page, keyColumns)).deleted ?? []),
            ...(page.ledgerDeletedKeys ?? []),
          ];

          const ingested = await this.insertRecordsOnConnection(
            p.conn,
            page.tableName,
            records,
            primaryKey,
          );
          if (records.length > 0) {
            // A row that just arrived is present, whatever a snapshot said
            // before it: naming it here is what revokes a pending absence.
            const arrivalKeys = [
              ...new Set(
                await encodeTypedRowKeys(
                  p.conn,
                  schema,
                  keyColumns,
                  records
                    .filter((record) => keyColumns.every((column) => column in record))
                    .map((record) =>
                      Object.fromEntries(keyColumns.map((column) => [column, record[column]])),
                    ),
                  "record",
                ),
              ),
            ];
            await this.absences.forget(p.conn, {
              sourceId,
              tableName: page.tableName,
              streamId: streamKeyed ? streamId : "",
              keyValues: arrivalKeys,
            });
            if (page.replica) await page.replica.recordPresence(arrivalKeys);
          }
          await this.temporalProjections.replaceIncoming(
            p.conn,
            page.tableName,
            records,
            schema,
            sourceId,
            projectionKey,
          );

          let deleted = 0;
          if (deletedKeys.length > 0) {
            await this.ownership.assertResolved(
              p.conn,
              schema,
              joinScopes(
                `${rowKeyExpr(keyColumns)} IN (${deletedKeys.map((key) => `'${escapeStr(key)}'`).join(", ")})`,
                streamScope,
              ),
            );
            const scope = joinScopes(
              await this.sourceScopePredicate(p.conn, sourceId, page.tableName, schema),
              streamScope,
            );
            const keyOf = rowKeyExpr(keyColumns);
            const named = (ids: readonly string[]) =>
              `${keyOf} IN (${ids.map((id) => `'${escapeStr(id)}'`).join(", ")})`;
            // A replicated member's tombstones are verdicts on the rows the
            // table holds, and the ledger says which of them take effect; any
            // other page deletes what it names.
            let tombstones: readonly string[] = deletedKeys;
            if (page.replica) {
              const existing = await this.selectExistingKeys(
                p.conn,
                page.tableName,
                keyOf,
                deletedKeys,
                scope,
              );
              const judgement =
                existing.length > 0 ? await page.replica.judgeDeletions(existing) : { apply: [] };
              tombstones = judgement.apply;
              receiptAllowed = judgement.deferred !== true;
            }
            if (tombstones.length > 0) {
              const victimKeys = schema.temporalProjection
                ? await this.selectRecordKeysWhere(
                    p.conn,
                    page.tableName,
                    projectionKey,
                    joinScopes(named(tombstones), scope)!,
                  )
                : [];
              await this.temporalProjections.deleteKeys(
                p.conn,
                sourceId,
                page.tableName,
                victimKeys,
              );
              deleted = await this.deleteRecordsOnConnection(
                p.conn,
                page.tableName,
                [...tombstones],
                keyOf,
                scope,
              );
              // A tombstoned row leaves at once and takes any pending absence
              // with it, so a later snapshot cannot delete a key twice over.
              await this.absences.forget(p.conn, {
                sourceId,
                tableName: page.tableName,
                streamId: streamKeyed ? streamId : "",
                keyValues: tombstones,
              });
            }
          }
          await this.temporalProjections.recordCoverage(p.conn, sourceId, page.tableName, schema);
          await this.updateCatalogStatsOnConnection(p.conn, page.tableName);
          if (page.watchCapture) {
            await this.watchOutbox.append(p.conn, {
              table: page.tableName,
              sourceId,
              streamId,
              schema,
              records,
              capture: page.watchCapture,
            });
          }
          if (page.receipt && receiptAllowed)
            await recordAnalyticsPageReceipt(p.conn, sourceId, streamId, page.receipt, {
              ingested,
              deleted,
            });
          await p.conn.run("COMMIT");
          return { ingested, deleted, streamRekeyed };
        } catch (error) {
          try {
            await p.conn.run("ROLLBACK");
          } catch {
            // Preserve the original error; a failed rollback is secondary.
          }
          throw error;
        }
      }),
    );
  }

  /**
   * The columns this table is addressed by, for a caller that has to speak the
   * ledger's key language before a page reaches the writer.
   *
   * A page's own schema answers for a table that does not exist yet; otherwise
   * the persisted declaration does, which is the same one the write path will
   * use. Falls back to the primary key, as everything else does.
   */
  async rowKeyColumns(tableName: string, pageSchema?: AnalyticsTableSchema): Promise<string[]> {
    const stored = await this.pool.withConn(({ conn }) =>
      this.readPersistedSchema(conn, tableName),
    );
    return (
      pageSchema?.deleteKey ??
      stored?.deleteKey ??
      pageSchema?.primaryKey ??
      stored?.primaryKey ??
      []
    );
  }

  private async readPersistedSchema(
    conn: DuckDBConnection,
    tableName: string,
  ): Promise<AnalyticsTableSchema | null> {
    const reader = await conn.runAndReadAll(
      `SELECT display_name, description, schema_json
       FROM _analytics_catalog
       WHERE table_name = '${escapeStr(tableName)}'`,
    );
    const rows = reader.getRows() as unknown[][];
    if (rows.length === 0) return null;
    const stored = parseSchemaJson(String(rows[0][2]), tableName);
    if (!stored) return null;
    return {
      tableName,
      displayName: String(rows[0][0]),
      description: String(rows[0][1]),
      columns: stored.columns,
      dynamicColumns: stored.dynamicColumns,
      primaryKey: stored.primaryKey,
      deleteKey: stored.deleteKey,
      semanticTimeColumn: stored.semanticTimeColumn ?? null,
      record: stored.record ?? {
        titleColumns: [stored.primaryKey[0]],
        keyColumns: stored.primaryKey,
      },
      exampleQueries: stored.exampleQueries,
      sharedDiscriminatorColumn: stored.sharedDiscriminatorColumn,
      sharedDiscriminatorParent: stored.sharedDiscriminatorParent,
      boundDocument: stored.boundDocument,
      temporalProjection: stored.temporalProjection,
    };
  }

  /**
   * The columns that address a row of this table, and the check that a page
   * has not brought its own.
   *
   * A page naming a column is honoured only when it is the one the table
   * declares. Anything else is a second key space for one table, and the
   * ledgers built on these keys — pending absences, replica claims — would
   * then hold keys from both with nothing to tell them apart.
   */
  private deleteKeyFor(
    tableName: string,
    schema: AnalyticsTableSchema,
    requestedColumn: string | undefined,
  ): string[] {
    // A page that names a column for a table which declares no key of its own
    // is what fixes that table's key space. Producers written before the
    // declaration existed — a phone pushing fan-out rows keyed by their parent
    // record — keep working, and their first page is what the table adopts.
    // Adoption is recorded, so a later page naming a different column is
    // refused instead of silently opening a second key space.
    const keyColumns =
      schema.deleteKey === undefined && requestedColumn !== undefined
        ? [requestedColumn]
        : analyticsDeleteKey(schema);
    if (keyColumns.length === 0)
      throw new RowKeyError(`Cannot delete from ${tableName}: no primary key`);
    for (const column of keyColumns) {
      quoteIdent(column);
      if (!schema.columns.some((c) => c.name === column)) {
        throw new RowKeyError(
          `Cannot delete from ${tableName}: unknown delete key column ${column}`,
        );
      }
    }
    if (
      requestedColumn !== undefined &&
      !(keyColumns.length === 1 && keyColumns[0] === requestedColumn)
    ) {
      throw new RowKeyError(
        `Cannot delete from ${tableName}: the page is keyed on '${requestedColumn}', but the table ` +
          `is addressed by (${keyColumns.join(", ")}). The delete key belongs to the table.`,
      );
    }
    return keyColumns;
  }

  /**
   * The rows a page names, as canonical keys.
   *
   * Which rows a write names is the SDK's rule — one implementation, beside
   * the contract that states it — and this adds only the encoding, because the
   * ledgers on this side store the key as text.
   */
  async pageRowKeys(
    page: Pick<
      AnalyticsIngestPage,
      | "tableName"
      | "schema"
      | "deletedKeys"
      | "presentKeys"
      | "deletedIds"
      | "presentIds"
      | "deleteKeyColumn"
    >,
  ): Promise<{ deleted: string[] | undefined; present: string[] | undefined }> {
    return this.pool.withConn(async ({ conn }) => {
      const stored = await this.readPersistedSchema(conn, page.tableName);
      const schema = page.schema
        ? { ...page.schema, deleteKey: page.schema.deleteKey ?? stored?.deleteKey }
        : stored;
      if (!schema)
        throw new RowKeyError(
          `Cannot address analytics table ${page.tableName}: no schema was supplied or registered`,
        );
      return this.pageKeys(
        conn,
        schema,
        page,
        this.deleteKeyFor(page.tableName, schema, page.deleteKeyColumn),
      );
    });
  }

  private async pageKeys(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    page: Pick<
      AnalyticsIngestPage,
      "tableName" | "deletedKeys" | "presentKeys" | "deletedIds" | "presentIds" | "deleteKeyColumn"
    >,
    keyColumns: string[],
  ): Promise<{ deleted: string[] | undefined; present: string[] | undefined }> {
    const named = normalizeTableKeys(page, keyColumns);
    const encode = (keys: RowKey[] | undefined, legacy: boolean) =>
      keys === undefined
        ? undefined
        : encodeTypedRowKeys(conn, schema, keyColumns, keys, legacy ? "legacy" : "tuple");
    return {
      deleted: await encode(named.deletedKeys, page.deletedKeys === undefined),
      present: await encode(named.presentKeys, page.presentKeys === undefined),
    };
  }

  private async insertRecordsOnConnection(
    conn: DuckDBConnection,
    tableName: string,
    records: Record<string, unknown>[],
    primaryKey: string[],
  ): Promise<number> {
    if (records.length === 0) return 0;
    const columns = Object.keys(records[0]);
    for (const record of records) {
      const recordColumns = Object.keys(record);
      if (
        recordColumns.length !== columns.length ||
        recordColumns.some((column) => !columns.includes(column))
      ) {
        throw new Error(`Analytics page for ${tableName} must use one consistent record shape`);
      }
    }

    let deduped = records;
    if (primaryKey.length > 0) {
      const seen = new Map<string, Record<string, unknown>>();
      for (const record of records) {
        const key = primaryKey.map((column) => String(record[column])).join("\0");
        seen.set(key, record);
      }
      deduped = [...seen.values()];
    }

    const quotedTable = quoteIdent(tableName);
    const quotedColumns = columns.map(quoteIdent);
    const quotedPrimaryKey = primaryKey.map(quoteIdent);
    const chunkSize = 1000;
    for (let i = 0; i < deduped.length; i += chunkSize) {
      const chunk = deduped.slice(i, i + chunkSize);
      const valueRows = chunk.map(
        (record) => `(${columns.map((column) => formatValue(record[column])).join(", ")})`,
      );
      let sql =
        `INSERT INTO ${quotedTable} (${quotedColumns.join(", ")}) VALUES ` + valueRows.join(", ");
      if (primaryKey.length > 0) {
        const updateColumns = columns
          .filter((column) => !primaryKey.includes(column))
          .map((column) => {
            const quoted = quoteIdent(column);
            return `${quoted} = EXCLUDED.${quoted}`;
          });
        sql +=
          updateColumns.length > 0
            ? ` ON CONFLICT (${quotedPrimaryKey.join(", ")}) DO UPDATE SET ${updateColumns.join(", ")}`
            : ` ON CONFLICT (${quotedPrimaryKey.join(", ")}) DO NOTHING`;
      }
      await conn.run(sql);
    }
    return deduped.length;
  }

  /**
   * Batch insert records with ON CONFLICT upsert. On a table that keys its
   * rows by device stream the records land in the empty stream; a device's
   * page goes through `ingestPage`, which carries its stream.
   */
  async insertRecords(
    tableName: string,
    records: Record<string, unknown>[],
    primaryKey: string[],
  ): Promise<number> {
    if (records.length === 0) return 0;
    return this.pool.serializeWrite(() =>
      this.pool.withConn(async (p) => {
        const streamKeyed = await this.catalog.isStreamKeyed(p.conn, tableName);
        return this.insertRecordsOnConnection(
          p.conn,
          tableName,
          streamKeyed ? records.map((record) => ({ ...record, [STREAM_COLUMN]: "" })) : records,
          streamKeyed ? [...primaryKey, STREAM_COLUMN] : primaryKey,
        );
      }),
    );
  }

  /** Delete records by primary key values, across every stream and every source that shares the table. */
  async deleteRecords(tableName: string, ids: string[], pkColumn: string): Promise<number> {
    if (ids.length === 0) return 0;
    // Through `rowKeyExpr`, which quotes the identifier: this method's column
    // comes from a caller, and the private form below takes a built
    // expression rather than a name.
    const keyExpr = rowKeyExpr([pkColumn]);
    return this.pool.serializeWrite(() =>
      this.pool.withConn((p) => this.deleteRecordsOnConnection(p.conn, tableName, ids, keyExpr)),
    );
  }

  /**
   * Delete by canonical row key. `keyExpr` is a built expression, not a column
   * name — every caller goes through `rowKeyExpr`, which is where the
   * identifier is quoted.
   */
  private async deleteRecordsOnConnection(
    conn: DuckDBConnection,
    tableName: string,
    keys: string[],
    keyExpr: string,
    sourceScope?: string,
  ): Promise<number> {
    if (keys.length === 0) return 0;
    const keyList = keys.map((key) => `'${escapeStr(key)}'`).join(", ");
    // The rows removed, which DuckDB returns, rather than the keys named. A
    // key coarser than the primary key names a group, so the two numbers are
    // the same only for a table whose key identifies one row — and the count
    // is what an operator is shown.
    const reader = await conn.runAndReadAll(
      `DELETE FROM ${quoteIdent(tableName)}
       WHERE ${keyExpr} IN (${keyList})
         ${sourceScope ? `AND ${sourceScope}` : ""}`,
    );
    return Number((reader.getRows() as unknown[][])[0]?.[0] ?? 0);
  }

  /**
   * Scope a shared table mutation to the emitting source instance.
   *
   * The catalog keeps the full source id while a table has one owner and
   * collapses it to the bare source type when a sibling account writes the
   * same table. At that point snapshot/tombstone deletes are safe only through
   * the provider-declared discriminator.
   */
  private async sourceScopePredicate(
    conn: DuckDBConnection,
    sourceId: string,
    tableName: string,
    schema: AnalyticsTableSchema,
  ): Promise<string | undefined> {
    const ownerReader = await conn.runAndReadAll(
      `SELECT source_id FROM _analytics_catalog WHERE table_name = '${escapeStr(tableName)}'`,
    );
    const owner = String((ownerReader.getRows() as unknown[][])[0]?.[0] ?? "");
    if (owner === sourceId) return undefined;

    const discriminator = schema.sharedDiscriminatorColumn;
    if (!discriminator || !schema.columns.some((column) => column.name === discriminator)) {
      throw new Error(
        `Cannot mutate shared analytics table ${tableName} for ${sourceId}; ` +
          "schema must declare a valid sharedDiscriminatorColumn",
      );
    }
    const accountId = sourceAccountOf(sourceId);
    return `${quoteIdent(discriminator)} = '${escapeStr(accountId)}'`;
  }

  /** Device streams currently represented by rows in one table scope. */
  private async representedStreams(
    conn: DuckDBConnection,
    tableName: string,
    predicate?: string,
  ): Promise<string[]> {
    if (!(await this.catalog.isStreamKeyed(conn, tableName))) return [""];
    const reader = await conn.runAndReadAll(
      `SELECT DISTINCT ${quoteIdent(STREAM_COLUMN)} FROM ${quoteIdent(tableName)}` +
        (predicate ? ` WHERE ${predicate}` : ""),
    );
    return (reader.getRows() as unknown[][]).map((row) => String(row[0] ?? ""));
  }

  /**
   * Whether `schema.tableName` keys its rows by device stream, and whether
   * this call made it so. A table gains the stream column the first time a
   * device stream writes to it: DuckDB cannot add a column to a primary key
   * in place, so the table is rebuilt inside the page's transaction with
   * every column it carries — each at its live type and nullability, so a
   * column that schema evolution added (nullable, never backfilled) survives
   * as it is — plus the stream column and a primary key that ends with it;
   * every existing row joins the empty stream. The catalog records the rekey,
   * so every later page reads one catalog row instead of the table's columns.
   * A table only the empty stream ever wrote to is left as it is.
   *
   * An explicit exclusive→partitioned transition invokes
   * `adoptExclusiveToPartitioned`, which rekeys that source's existing empty
   * stream before its first partitioned page can write.
   */
  private async ensureStreamScope(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    streamId: string,
  ): Promise<{ streamKeyed: boolean; rebuilt: boolean }> {
    if (await this.catalog.isStreamKeyed(conn, schema.tableName)) {
      return { streamKeyed: true, rebuilt: false };
    }
    if (streamId === "") return { streamKeyed: false, rebuilt: false };

    const existing = await conn.runAndReadAll(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = '${escapeStr(schema.tableName)}' ORDER BY ordinal_position`,
    );
    const columns = (existing.getRows() as unknown[][]).map((row) => ({
      name: String(row[0]),
      type: String(row[1]),
      nullable: String(row[2]).toUpperCase() === "YES",
    }));
    const table = quoteIdent(schema.tableName);
    const countReader = await conn.runAndReadAll(`SELECT COUNT(*) FROM ${table}`);
    const rowCount = Number((countReader.getRows() as unknown[][])[0]?.[0] ?? 0);
    if (rowCount > this.maxInlineStreamRekeyRows) {
      throw new Error(
        `Cannot key analytics table ${schema.tableName} by device stream online: ` +
          `${rowCount} rows exceed the configured online limit of ${this.maxInlineStreamRekeyRows}; ` +
          "raise gateway.analyticsStreamRekeyMaxRows and restart the gateway during a maintenance window",
      );
    }
    const rebuilt = quoteIdent(`${schema.tableName}__streams`);
    const colDefs = columns.map(
      (column) => `${quoteIdent(column.name)} ${column.type}${column.nullable ? "" : " NOT NULL"}`,
    );
    colDefs.push(`${quoteIdent(STREAM_COLUMN)} VARCHAR NOT NULL DEFAULT ''`);
    if (schema.primaryKey.length > 0) {
      colDefs.push(
        `PRIMARY KEY (${[...schema.primaryKey, STREAM_COLUMN].map(quoteIdent).join(", ")})`,
      );
    }
    const copied = columns.map((column) => quoteIdent(column.name)).join(", ");
    await conn.run(`CREATE TABLE ${rebuilt} (${colDefs.join(", ")})`);
    await conn.run(
      `INSERT INTO ${rebuilt} (${copied}, ${quoteIdent(STREAM_COLUMN)}) SELECT ${copied}, '' FROM ${table}`,
    );
    await conn.run(`DROP TABLE ${table}`);
    await conn.run(`ALTER TABLE ${rebuilt} RENAME TO ${table}`);
    await this.catalog.markStreamKeyed(conn, schema.tableName);
    log.info(`Analytics table ${schema.tableName} now keys its rows by device stream`);
    return { streamKeyed: true, rebuilt: true };
  }

  /**
   * Record what a page's snapshot says is gone, without removing anything.
   *
   * Candidate discovery and diagnostics run on a reader. The writer receives
   * only bounded mark and recovery-clear batches, so a large snapshot cannot
   * hold the single writer while it scans or materialises a whole scope.
   */
  async reconcileSnapshot(args: {
    sourceId: string;
    tableName: string;
    /** What the page vouches for, as canonical keys or their older spelling. */
    presentIds?: string[];
    presentKeys?: RowKey[];
    /** @deprecated The key belongs to the table; a page naming another is refused. */
    deleteKeyColumn?: string;
    absencePolicy: SnapshotAbsencePolicy;
    streamId?: string;
    observationId?: string;
    /** The member whose snapshot this is, recorded on the absences it marks or corroborates. */
    observedBy?: string;
  }): Promise<AnalyticsAbsenceOutcome> {
    const sourceId = args.sourceId;
    const tableName = args.tableName;
    const policy = args.absencePolicy;
    const writerChunk = Math.min(policy.maxMarksPerSnapshot, ANALYTICS_ABSENCE_WRITER_CHUNK);
    const streamId = args.streamId ?? "";

    // Candidate discovery and exact diagnostics may inspect the whole data
    // table, but they do so on a reader. The serialized writer below receives
    // only one bounded mark chunk and one bounded recovery chunk.
    const plan = await this.pool.withConn(async ({ conn }) => {
      await conn.run("BEGIN TRANSACTION");
      try {
        const expectedScope = await this.absences.scope(conn, sourceId, tableName, streamId);
        const schema = await this.readPersistedSchema(conn, tableName);
        if (!schema) {
          throw new Error(`Cannot reconcile analytics table ${tableName}: no schema is registered`);
        }
        const keyColumns = this.deleteKeyFor(tableName, schema, args.deleteKeyColumn);
        const keySpace = rowKeySpace(keyColumns);
        // A snapshot fixes the table's key space just as a delete does: the
        // absences it is about to record are keyed this way, and the sweep
        // that acts on them reads the declaration back.
        if (schema.deleteKey === undefined && args.deleteKeyColumn !== undefined) {
          await this.catalog.upsertEntry(conn, { ...schema, deleteKey: keyColumns }, sourceId);
        }
        const named = (
          await this.pageKeys(
            conn,
            schema,
            {
              tableName,
              presentIds: args.presentIds,
              presentKeys: args.presentKeys,
              deleteKeyColumn: args.deleteKeyColumn,
            },
            keyColumns,
          )
        ).present;
        if (named === undefined) {
          throw new Error(`Cannot reconcile ${tableName}: the page names nothing as present`);
        }
        const presentIds = [...new Set(named)];
        // Keys recorded under another key space were written when this table
        // was addressed by other columns. They name nothing now, and sweeping
        // on them would delete by a key nobody wrote — so they go, and the
        // next snapshot re-marks whatever is genuinely absent.
        await conn.run(
          `DELETE FROM ${ANALYTICS_ABSENCES_TABLE}
            WHERE source_id = '${escapeStr(sourceId)}'
              AND table_name = '${escapeStr(tableName)}'
              AND stream_id = '${escapeStr(streamId)}'
              AND key_column <> '${escapeStr(keySpace)}'`,
        );
        const streamKeyed = await this.catalog.isStreamKeyed(conn, tableName);
        const streamScope = streamKeyed
          ? `${quoteIdent(STREAM_COLUMN)} = '${escapeStr(streamId)}'`
          : undefined;
        await this.ownership.assertResolved(conn, schema, streamScope);
        const sourceScope = joinScopes(
          await this.sourceScopePredicate(conn, sourceId, tableName, schema),
          streamScope,
        );
        // Let DuckDB do the set work on this reader: exact diagnostics may scan
        // the scope, while only the capped victim keys cross to the writer.
        const key = rowKeyExpr(keyColumns);
        const table = quoteIdent(tableName);
        const where = (extra?: string) => {
          const parts = [sourceScope, extra].filter(Boolean);
          return parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "";
        };
        const omitted =
          presentIds.length === 0
            ? "TRUE"
            : `${key} NOT IN (${presentIds.map((id) => `'${escapeStr(id)}'`).join(", ")})`;
        const scalar = async (sql: string): Promise<number> =>
          Number(((await conn.runAndReadAll(sql)).getRows() as unknown[][])[0]?.[0] ?? 0);
        const storedCount = await scalar(`SELECT COUNT(DISTINCT ${key}) FROM ${table}${where()}`);
        const absentCount = await scalar(
          `SELECT COUNT(DISTINCT ${key}) FROM ${table}${where(omitted)}`,
        );
        const heldFromSnapshot =
          presentIds.length === 0
            ? 0
            : await scalar(
                `SELECT COUNT(DISTINCT ${key}) FROM ${table}${where(`NOT (${omitted})`)}`,
              );
        // Unmarked omissions come first. Without this ordering, a capped snapshot
        // can keep selecting the already-pending first tranche; the later rows do
        // not even start their deadline until that tranche is eventually swept.
        const pendingScope =
          `source_id = '${escapeStr(sourceId)}'` +
          ` AND table_name = '${escapeStr(tableName)}'` +
          ` AND stream_id = '${escapeStr(streamId)}'`;
        const generation = await this.absences.generation(conn, sourceId, tableName, streamId);
        const pendingKeys =
          `SELECT key_value FROM ${ANALYTICS_ABSENCES_TABLE} WHERE ${pendingScope}` +
          ` AND generation = ${generation}`;
        const freshReader = await conn.runAndReadAll(
          `SELECT DISTINCT ${key} FROM ${table}${where(
            `${omitted} AND ${key} NOT IN (${pendingKeys})`,
          )} ORDER BY ${key} LIMIT ${writerChunk}`,
        );
        const absentKeys = (freshReader.getRows() as unknown[][]).map((row) => String(row[0]));
        const remaining = writerChunk - absentKeys.length;
        if (remaining > 0) {
          // Fill spare capacity with already-pending omissions so a spaced
          // corroboration still advances on a snapshot that has no new tranche.
          const pendingReader = await conn.runAndReadAll(
            `SELECT DISTINCT ${key} FROM ${table}${where(
              `${omitted} AND ${key} IN (${pendingKeys})`,
            )} ORDER BY ${key} LIMIT ${remaining}`,
          );
          absentKeys.push(...(pendingReader.getRows() as unknown[][]).map((row) => String(row[0])));
        }

        // Recovery is planned on the reader. At most one writer chunk of exact
        // keys crosses the boundary. If the scope contains more recoveries, the
        // writer advances its generation in O(1), invalidating every old mark
        // without a scope-wide DELETE.
        const clearKeys: string[] = [];
        let clearCount = 0;
        for (let i = 0; i < presentIds.length; i += 500) {
          const ids = presentIds.slice(i, i + 500);
          if (ids.length === 0) continue;
          const clearReader = await conn.runAndReadAll(
            `SELECT key_value FROM ${ANALYTICS_ABSENCES_TABLE}
            WHERE ${pendingScope}
              AND generation = ${generation}
              AND key_value IN (${ids.map((id) => `'${escapeStr(id)}'`).join(", ")})
            ORDER BY key_value`,
          );
          const recovered = (clearReader.getRows() as unknown[][]).map((row) => String(row[0]));
          clearCount += recovered.length;
          if (clearKeys.length < writerChunk) {
            clearKeys.push(...recovered.slice(0, writerChunk - clearKeys.length));
          }
        }
        const result = {
          keyColumn: keySpace,
          snapshotSize: presentIds.length,
          absentKeys,
          clearKeys,
          clearCount,
          expectedScope,
          counts: {
            stored: storedCount,
            absent: absentCount,
            missing: presentIds.length - heldFromSnapshot,
          },
        };
        await conn.run("COMMIT");
        return result;
      } catch (error) {
        try {
          await conn.run("ROLLBACK");
        } catch {
          // Preserve the planning error.
        }
        throw error;
      }
    });

    return this.pool.serializeWrite(() =>
      this.pool.withConn(async ({ conn }) => {
        await conn.run("BEGIN TRANSACTION");
        try {
          const outcome = await this.absences.reconcile(conn, {
            sourceId,
            tableName,
            streamId,
            keyColumn: plan.keyColumn,
            absentKeys: plan.absentKeys,
            clearKeys: plan.clearKeys,
            clearCount: plan.clearCount,
            snapshotSize: plan.snapshotSize,
            observationId: args.observationId,
            observedBy: args.observedBy ?? "",
            expectedGeneration: plan.expectedScope.generation,
            expectedRevision: plan.expectedScope.revision,
            counts: plan.counts,
            observationSpacingMs: observationSpacingMs(policy),
            now: Date.now(),
          });
          await conn.run("COMMIT");
          return outcome;
        } catch (error) {
          try {
            await conn.run("ROLLBACK");
          } catch {
            // Preserve the original failure.
          }
          throw error;
        }
      }),
    );
  }

  /**
   * Delete the analytics rows an absence sweep judged due, with their temporal
   * projections, on the sweep's connection and inside its transaction. The
   * reader resolves one fixed-size physical chunk to exact primary keys before
   * the writer starts.
   */
  async planAbsentRecordDeletion(
    row: DueAnalyticsAbsence,
    limit: number,
  ): Promise<AnalyticsAbsencePhysicalPlan> {
    return this.pool.withConn(async ({ conn }) => {
      const schema = await this.readPersistedSchema(conn, row.tableName);
      if (!schema || row.keyColumn !== rowKeySpace(analyticsDeleteKey(schema))) {
        return { predicate: "FALSE", recordKeys: [], recordCount: 0, exhausted: true };
      }
      const streamKeyed = await this.catalog.isStreamKeyed(conn, row.tableName);
      const recordKey =
        streamKeyed && row.streamId !== ""
          ? [...schema.primaryKey, STREAM_COLUMN]
          : schema.primaryKey;
      await this.ownership.assertResolved(
        conn,
        schema,
        joinScopes(
          `${rowKeyExpr(analyticsDeleteKey(schema))} = '${escapeStr(row.keyValue)}'`,
          streamKeyed ? `${quoteIdent(STREAM_COLUMN)} = '${escapeStr(row.streamId)}'` : undefined,
        ),
      );
      const scope = joinScopes(
        `${rowKeyExpr(analyticsDeleteKey(schema))} = '${escapeStr(row.keyValue)}'`,
        await this.sourceScopePredicate(conn, row.sourceId, row.tableName, schema),
        streamKeyed ? `${quoteIdent(STREAM_COLUMN)} = '${escapeStr(row.streamId)}'` : undefined,
      )!;
      const reader = await conn.runAndReadAll(
        `SELECT ${recordKey.map(quoteIdent).join(", ")}, ${rowKeyExpr(schema.primaryKey)}
           FROM ${quoteIdent(row.tableName)}
          WHERE ${scope}
          ORDER BY ${recordKey.map(quoteIdent).join(", ")}
          LIMIT ${limit + 1}`,
      );
      const rows = (reader.getRows() as unknown[][]).slice(0, limit);
      // Keep DuckDB's exact scalar spelling (including sub-millisecond timestamps)
      // rather than round-tripping driver wrapper objects through JavaScript.
      const exact = rows.map((values) => `'${escapeStr(String(values[recordKey.length]))}'`);
      const recordKeys = (schema.temporalProjection ? rows : []).map((values) => {
        const record: Record<string, unknown> = {};
        recordKey.forEach((column, index) => {
          const value = values[index];
          // DuckDB returns BIGINT cells as JS bigint; source records and the
          // temporal-key serializer use JSON numbers for the safe range.
          record[column] =
            typeof value === "bigint"
              ? Number.isSafeInteger(Number(value))
                ? Number(value)
                : String(value)
              : value;
        });
        return this.temporalProjections.serializeRecordKey(recordKey, record);
      });
      return {
        predicate:
          exact.length > 0
            ? `(${scope}) AND ${rowKeyExpr(schema.primaryKey)} IN (${exact.join(", ")})`
            : "FALSE",
        recordKeys,
        recordCount: rows.length,
        exhausted: (reader.getRows() as unknown[][]).length <= limit,
      };
    });
  }

  async absenceKeyIsCurrent(conn: DuckDBConnection, row: DueAnalyticsAbsence): Promise<boolean> {
    const schema = await this.readPersistedSchema(conn, row.tableName);
    return schema !== null && row.keyColumn === rowKeySpace(analyticsDeleteKey(schema));
  }

  async deleteAbsentRecordsOnConnection(
    conn: DuckDBConnection,
    row: DueAnalyticsAbsence,
    plan: AnalyticsAbsencePhysicalPlan,
  ): Promise<number> {
    if (plan.recordCount === 0) return 0;
    await this.temporalProjections.deleteKeys(conn, row.sourceId, row.tableName, plan.recordKeys);
    await conn.run(`DELETE FROM ${quoteIdent(row.tableName)} WHERE ${plan.predicate}`);
    await this.updateCatalogStatsOnConnection(conn, row.tableName);
    log.info(
      `Absence sweep removed ${plan.recordCount} row(s) from ${row.tableName} for ${row.sourceId}`,
    );
    return plan.recordCount;
  }

  /**
   * Which of `keys` the table actually holds, in bounded chunks.
   *
   * Matched on the key expression rather than on a raw column, so a wide key
   * and a one-column key are the same comparison and a value's SQL type
   * cannot change the answer: both sides are the canonical text form.
   */
  private async selectExistingKeys(
    conn: DuckDBConnection,
    tableName: string,
    keyExpr: string,
    keys: readonly string[],
    scope: string | undefined,
  ): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = [...new Set(keys.slice(i, i + 500))];
      const reader = await conn.runAndReadAll(
        `SELECT DISTINCT t.wire_value
           FROM (VALUES ${chunk.map((value) => `('${escapeStr(value)}')`).join(", ")}) AS t(wire_value)
          WHERE EXISTS (
            SELECT 1 FROM ${quoteIdent(tableName)}
             WHERE ${keyExpr} = t.wire_value${scope ? ` AND ${scope}` : ""}
          )
          ORDER BY t.wire_value`,
      );
      out.push(...(reader.getRows() as unknown[][]).map((row) => String(row[0])));
    }
    return out;
  }

  private async selectRecordKeysWhere(
    conn: DuckDBConnection,
    tableName: string,
    recordKey: readonly string[],
    predicate: string,
  ): Promise<string[]> {
    const reader = await conn.runAndReadAll(
      `SELECT ${recordKey.map(quoteIdent).join(", ")}
       FROM ${quoteIdent(tableName)}
       WHERE ${predicate}`,
    );
    return (reader.getRows() as unknown[][]).map((row) => {
      const record: Record<string, unknown> = {};
      recordKey.forEach((column, index) => {
        const value = row[index];
        // DuckDB returns BIGINT cells as JS bigint; source records and the
        // temporal-key serializer use JSON numbers for the safe range.
        record[column] =
          typeof value === "bigint"
            ? Number.isSafeInteger(Number(value))
              ? Number(value)
              : String(value)
            : value;
      });
      return this.temporalProjections.serializeRecordKey(recordKey, record);
    });
  }

  /**
   * Delete one device stream's rows from every table the source writes,
   * and the temporal projections derived from them. Only a table keyed by
   * stream holds such rows; a table the empty stream alone ever wrote to,
   * or one this stream never wrote to, is left as it is. The tables and
   * their catalog rows stay — the other streams are still writing them —
   * and a shared table is scoped by the account discriminator as well, so
   * a sibling account's namesake stream is untouched. Returns the names of
   * the tables the stream had rows in.
   */
  async deleteAnalyticsStream(sourceId: string, streamId: string): Promise<string[]> {
    return this.pool.serializeWrite(() =>
      this.pool.withConn(async (p) => {
        await p.conn.run("BEGIN TRANSACTION");
        try {
          const cleaned: string[] = [];
          const entries = await this.catalog.readEntriesForSource(p.conn, sourceId);
          const missing = new Set<string>();
          for (const entry of entries) {
            if (!(await this.physicalTableExists(p.conn, entry.tableName))) {
              missing.add(entry.tableName);
              continue;
            }
            if (!(await this.catalog.isStreamKeyed(p.conn, entry.tableName))) continue;
            const schema = await this.readPersistedSchema(p.conn, entry.tableName);
            if (!schema) throw new RowKeyError("Cannot remove analytics data without its schema");
            await this.ownership.repair(p.conn, schema, sourceId);
            await this.ownership.assertResolved(
              p.conn,
              schema,
              `${quoteIdent(STREAM_COLUMN)} = '${escapeStr(streamId)}'`,
            );
          }
          await this.watchOutbox.deleteStream(p.conn, sourceId, streamId);
          await clearAnalyticsPageReceipts(p.conn, sourceId, streamId);
          for (const entry of entries) {
            if (missing.has(entry.tableName)) {
              await this.catalog.deleteEntry(p.conn, entry.tableName);
              await this.absences.forgetScope(p.conn, { tableName: entry.tableName });
              continue;
            }
            if (!(await this.catalog.isStreamKeyed(p.conn, entry.tableName))) continue;
            const schema = await this.readPersistedSchema(p.conn, entry.tableName);
            if (!schema) {
              throw new Error(
                `Cannot clean stream ${streamId} of ${sourceId} from ${entry.tableName}: the catalog schema is unreadable`,
              );
            }
            const scope = joinScopes(
              await this.sourceScopePredicate(p.conn, sourceId, entry.tableName, schema),
              `${quoteIdent(STREAM_COLUMN)} = '${escapeStr(streamId)}'`,
            )!;
            // A projection's key names the stream unless it is the empty one
            // (see ingestPage): the same rule selects the keys to retract.
            const projectionKey =
              streamId === "" ? schema.primaryKey : [...schema.primaryKey, STREAM_COLUMN];
            const count = await p.conn.runAndReadAll(
              `SELECT COUNT(*) FROM ${quoteIdent(entry.tableName)} WHERE ${scope}`,
            );
            const victimCount = Number(count.getRows()[0]![0]);
            if (victimCount === 0) continue;
            const victimKeys = schema.temporalProjection
              ? await this.selectRecordKeysWhere(p.conn, entry.tableName, projectionKey, scope)
              : [];
            await this.temporalProjections.deleteKeys(
              p.conn,
              sourceId,
              entry.tableName,
              victimKeys,
            );
            await p.conn.run(`DELETE FROM ${quoteIdent(entry.tableName)} WHERE ${scope}`);
            // DuckDB has no cascade, so an absence outlives the row it was
            // recorded against unless it is dropped here — and a stream that is
            // gone will never send another snapshot to revoke it.
            await this.absences.forgetScope(p.conn, {
              sourceId,
              tableName: entry.tableName,
              streamId,
            });
            await this.updateCatalogStatsOnConnection(p.conn, entry.tableName);
            cleaned.push(entry.tableName);
            log.info(
              `Cleaned stream ${streamId} of ${sourceId} from ${entry.tableName}: ${victimCount} rows`,
            );
          }
          await p.conn.run("COMMIT");
          return cleaned;
        } catch (error) {
          try {
            await p.conn.run("ROLLBACK");
          } catch {
            // Preserve the original error; a failed rollback is secondary.
          }
          throw error;
        }
      }),
    );
  }

  /**
   * Commit one bounded repair per table before any source/stream teardown.
   * A refusal leaves config and all destructive planes untouched; repeated
   * admissions can finish large repairs without rolling progress back.
   */
  async prepareSourceRemoval(sourceId: string, streamId?: string): Promise<void> {
    return this.pool.serializeWrite(() =>
      this.pool.withConn(async ({ conn }) => {
        const schemas: AnalyticsTableSchema[] = [];
        for (const entry of await this.catalog.readEntriesForSource(conn, sourceId)) {
          if (streamId !== undefined && !(await this.catalog.isStreamKeyed(conn, entry.tableName)))
            continue;
          if (!(await this.physicalTableExists(conn, entry.tableName))) continue;
          const schema = await this.readPersistedSchema(conn, entry.tableName);
          if (!schema) throw new RowKeyError("Cannot remove analytics data without its schema");
          await this.ownership.repair(conn, schema, sourceId);
          schemas.push(schema);
        }
        for (const schema of schemas) {
          await this.ownership.assertResolved(
            conn,
            schema,
            streamId === undefined
              ? undefined
              : `${quoteIdent(STREAM_COLUMN)} = '${escapeStr(streamId)}'`,
          );
          await this.sourceScopePredicate(conn, sourceId, schema.tableName, schema);
        }
      }),
    );
  }

  private async physicalTableExists(conn: DuckDBConnection, tableName: string): Promise<boolean> {
    const reader = await conn.runAndReadAll(
      `SELECT 1 FROM information_schema.tables WHERE table_name = '${escapeStr(tableName)}' LIMIT 1`,
    );
    return reader.getRows().length > 0;
  }

  /**
   * Adopt one exclusive source's shared-stream analytics into its owner's
   * partitioned stream. One catalog table is one committed writer call, so a
   * large source cannot retain the analytics connection across unrelated
   * tables. The data table, its absence ledgers, and its temporal projection
   * identities move in the same transaction; committed tables are therefore
   * durable progress when a later table or SQLite finalization fails.
   */
  async adoptExclusiveToPartitioned(sourceId: string, ownerStreamId: string): Promise<string[]> {
    const entries = await this.pool.withConn(async ({ conn }) =>
      (await this.catalog.readEntriesForSource(conn, sourceId)).map((entry) => entry.tableName),
    );

    const adopted: string[] = [];
    for (const tableName of entries) {
      await this.pool.serializeWrite(() =>
        this.pool.withConn(async ({ conn }) => {
          await conn.run("BEGIN TRANSACTION");
          try {
            const schema = await this.readPersistedSchema(conn, tableName);
            if (!schema) {
              throw new Error(
                `Cannot adopt analytics table ${tableName} for ${sourceId}: the catalog schema is unreadable`,
              );
            }
            await this.assertAdoptionState(conn, sourceId, ownerStreamId, tableName, schema);
            await this.ensureStreamScope(conn, schema, ownerStreamId);
            const sourceScope = await this.sourceScopePredicate(conn, sourceId, tableName, schema);
            const sharedScope = joinScopes(sourceScope, `${quoteIdent(STREAM_COLUMN)} = ''`)!;
            await conn.run(
              `UPDATE ${quoteIdent(tableName)}
                  SET ${quoteIdent(STREAM_COLUMN)} = '${escapeStr(ownerStreamId)}'
                WHERE ${sharedScope}`,
            );

            const ownerJson = escapeStr(JSON.stringify(ownerStreamId));
            const recordKey =
              `left(record_key, length(record_key) - 1) || ` +
              `',"${STREAM_COLUMN}":' || '${ownerJson}' || '}'`;
            await conn.run(
              `UPDATE ${TEMPORAL_PROJECTIONS_TABLE}
                  SET record_key = ${recordKey},
                      id = 'tp_' || substr(sha256(
                        source_id || chr(0) || table_name || chr(0) ||
                        (${recordKey}) || chr(0) || slot
                      ), 1, 32)
                WHERE source_id = '${escapeStr(sourceId)}'
                  AND table_name = '${escapeStr(tableName)}'
                  AND json_extract_string(record_key, '$.${STREAM_COLUMN}') IS NULL`,
            );
            for (const ledger of [
              ANALYTICS_ABSENCES_TABLE,
              ANALYTICS_ABSENCE_SCOPES_TABLE,
              ANALYTICS_ABSENCE_OBSERVATIONS_TABLE,
            ]) {
              await conn.run(
                `UPDATE ${ledger} SET stream_id = '${escapeStr(ownerStreamId)}'
                  WHERE source_id = '${escapeStr(sourceId)}'
                    AND table_name = '${escapeStr(tableName)}'
                    AND stream_id = ''`,
              );
            }
            await this.updateCatalogStatsOnConnection(conn, tableName);
            await conn.run("COMMIT");
            adopted.push(tableName);
          } catch (error) {
            try {
              await conn.run("ROLLBACK");
            } catch {
              // Preserve the adoption failure.
            }
            throw error;
          }
        }),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return adopted;
  }

  private async assertAdoptionState(
    conn: DuckDBConnection,
    sourceId: string,
    ownerStreamId: string,
    tableName: string,
    schema: AnalyticsTableSchema,
  ): Promise<void> {
    const allowed = new Set(["", ownerStreamId]);
    const scopes: Array<{ label: string; sql: string }> = [];
    if (await this.catalog.isStreamKeyed(conn, tableName)) {
      const sourceScope = await this.sourceScopePredicate(conn, sourceId, tableName, schema);
      scopes.push({
        label: tableName,
        sql:
          `SELECT DISTINCT ${quoteIdent(STREAM_COLUMN)} FROM ${quoteIdent(tableName)}` +
          (sourceScope ? ` WHERE ${sourceScope}` : ""),
      });
    } else {
      scopes.push({ label: tableName, sql: "SELECT ''" });
    }
    for (const ledger of [
      ANALYTICS_ABSENCES_TABLE,
      ANALYTICS_ABSENCE_SCOPES_TABLE,
      ANALYTICS_ABSENCE_OBSERVATIONS_TABLE,
    ]) {
      scopes.push({
        label: ledger,
        sql: `SELECT DISTINCT stream_id FROM ${ledger}
               WHERE source_id = '${escapeStr(sourceId)}'
                 AND table_name = '${escapeStr(tableName)}'`,
      });
    }
    scopes.push({
      label: TEMPORAL_PROJECTIONS_TABLE,
      sql: `SELECT DISTINCT coalesce(json_extract_string(record_key, '$.${STREAM_COLUMN}'), '')
              FROM ${TEMPORAL_PROJECTIONS_TABLE}
             WHERE source_id = '${escapeStr(sourceId)}'
               AND table_name = '${escapeStr(tableName)}'`,
    });

    for (const scope of scopes) {
      const rows = await conn.runAndReadAll(`${scope.sql} LIMIT 3`);
      const streams = [
        ...new Set((rows.getRows() as unknown[][]).map((row) => String(row[0] ?? ""))),
      ];
      if (streams.some((stream) => !allowed.has(stream)) || streams.length > 1) {
        throw new Error(
          `Cannot adopt ${sourceId}: ambiguous analytics streams in ${scope.label} (${streams.join(", ")})`,
        );
      }
    }
  }

  private async updateCatalogStatsOnConnection(
    conn: DuckDBConnection,
    tableName: string,
  ): Promise<void> {
    const quotedTable = quoteIdent(tableName);
    const countReader = await conn.runAndReadAll(`SELECT COUNT(*) FROM ${quotedTable}`);
    const count = Number((countReader.getRows() as unknown[][])[0]?.[0] ?? 0);
    const now = new Date().toISOString();
    await conn.run(
      `UPDATE _analytics_catalog
       SET record_count = ${count}, updated_at = '${now}'
       WHERE table_name = '${escapeStr(tableName)}'`,
    );
  }

  /**
   * Drop every analytics table whose catalog entry's `source_id` matches
   * `sourceId` exactly, then remove those catalog rows. Used by
   * `DELETE /admin/sources/:id` so structured-source removal doesn't leak
   * orphan DuckDB tables.
   *
   * Catalog entries with a *bare-source-type* `source_id` (e.g.
   * `"browser-history"` for tables shared across `browser-history:chrome`
   * and `browser-history:safari`) are intentionally NOT touched here —
   * removing one of the two sources shouldn't drop a table the sibling is
   * still writing to. The `updateSourceId` path collapses
   * `source_id` to its bare type the moment a second source claims the
   * same table, so an exact-match filter is the right primitive.
   *
   * Returns the names of dropped tables, in order, for logging.
   */
  async deleteAnalyticsForSource(sourceId: string): Promise<string[]> {
    return this.pool.serializeWrite(() =>
      this.pool.withConn(async (p) => {
        // Parse `<type>:<accountId>` so we can match both the full id
        // (case A — exclusive ownership) and the bare type (case B — the
        // catalog row was collapsed when a sibling source claimed the
        // same table).
        const accountId = sourceAccountOf(sourceId);
        const entries = await this.catalog.readEntriesForSource(p.conn, sourceId);
        const missing = new Set<string>();
        // Resolve children while every parent still exists. Refuse ambiguous
        // ownership before deleting projections, receipts, or any data table.
        for (const entry of entries) {
          if (!(await this.physicalTableExists(p.conn, entry.tableName))) {
            missing.add(entry.tableName);
            continue;
          }
          const schema = await this.readPersistedSchema(p.conn, entry.tableName);
          if (!schema) throw new RowKeyError("Cannot remove analytics data without its schema");
          await this.ownership.repair(p.conn, schema, sourceId);
          await this.ownership.assertResolved(p.conn, schema);
          if (entry.sourceId !== sourceId)
            await this.sourceScopePredicate(p.conn, sourceId, entry.tableName, schema);
        }
        await this.temporalProjections.deleteForSource(p.conn, sourceId);
        await this.watchOutbox.deleteSource(p.conn, sourceId);
        await clearAnalyticsPageReceipts(p.conn, sourceId);
        if (entries.length === 0) return [];

        const droppedTables: string[] = [];
        const failures: string[] = [];
        for (const entry of entries) {
          if (missing.has(entry.tableName)) {
            await this.catalog.deleteEntry(p.conn, entry.tableName);
            await this.absences.forgetScope(p.conn, { tableName: entry.tableName });
            droppedTables.push(entry.tableName);
            continue;
          }
          // Case A: catalog source_id matches full id → exclusive ownership.
          // Drop the table and remove the catalog row.
          if (entry.sourceId === sourceId) {
            try {
              const representedStreams = await this.representedStreams(p.conn, entry.tableName);
              await p.conn.run(`DROP TABLE IF EXISTS ${quoteIdent(entry.tableName)}`);
              await this.absences.forgetScope(p.conn, { tableName: entry.tableName });
              for (const streamId of representedStreams) {
                await this.absences.forgetScope(p.conn, {
                  sourceId,
                  tableName: entry.tableName,
                  streamId,
                });
              }
              droppedTables.push(entry.tableName);
              await this.catalog.deleteEntry(p.conn, entry.tableName);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log.warn(
                `Failed to drop analytics table ${entry.tableName} for ${sourceId}: ${message}`,
              );
              failures.push(`${entry.tableName}: ${message}`);
            }
            continue;
          }

          // Case B: catalog source_id is the bare type → multiple
          // siblings share this table. Need a discriminator column to
          // delete only this source's rows. Read the column name from
          // the stored schema_json.
          const discriminator = entry.schema?.sharedDiscriminatorColumn;

          if (!discriminator || !accountId) {
            const message = !discriminator
              ? "schema has no `sharedDiscriminatorColumn`"
              : "source has no accountId";
            log.warn(
              `Cannot clean up shared analytics table ${entry.tableName} for ${sourceId}: ${message}`,
            );
            failures.push(`${entry.tableName}: ${message}`);
            continue;
          }

          try {
            const sourcePredicate = `${quoteIdent(discriminator)} = '${escapeStr(accountId)}'`;
            const representedStreams = await this.representedStreams(
              p.conn,
              entry.tableName,
              sourcePredicate,
            );
            await p.conn.run(`DELETE FROM ${quoteIdent(entry.tableName)} WHERE ${sourcePredicate}`);
            await this.absences.forgetScope(p.conn, {
              sourceId,
              tableName: entry.tableName,
            });
            for (const streamId of representedStreams) {
              await this.absences.forgetScope(p.conn, {
                sourceId,
                tableName: entry.tableName,
                streamId,
              });
            }
            log.info(
              `Cleaned shared analytics rows from ${entry.tableName} for ${sourceId} (WHERE ${discriminator} = '${accountId}')`,
            );
            // Catalog row stays — sibling sources still write to this table.
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn(
              `Failed to clean shared analytics table ${entry.tableName} for ${sourceId}: ${message}`,
            );
            failures.push(`${entry.tableName}: ${message}`);
          }
        }

        if (failures.length > 0) {
          throw new Error(`Analytics cleanup incomplete for ${sourceId}: ${failures.join("; ")}`);
        }
        if (droppedTables.length > 0) {
          log.info(
            `Removed analytics for ${sourceId}: ${droppedTables.length} table${droppedTables.length === 1 ? "" : "s"} (${droppedTables.join(", ")})`,
          );
        }
        return droppedTables;
      }),
    );
  }
}

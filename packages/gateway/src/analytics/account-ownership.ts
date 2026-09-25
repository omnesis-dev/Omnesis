// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeAnalyticsColumnType, RowKeyError } from "@omnesis/source-sdk";
import { sourceAccountOf, sourceTypeOf } from "@omnesis/types";
import { escapeStr, formatValue, parseSchemaJson, quoteIdent, STREAM_COLUMN } from "./internal.js";
import { encodeTypedRowKeys, rowKeyExpr } from "./row-key-sql.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { AnalyticsCatalogStore } from "./catalog-store.js";

/** Limits mutations, not the reader scan needed to find matched legacy rows. */
const OWNERSHIP_REPAIR_BATCH = 1000;

async function assertPhysicalPrimaryKey(
  conn: DuckDBConnection,
  tableName: string,
  primaryKey: readonly string[],
  streamKeyed: boolean,
): Promise<void> {
  const constraint = await conn.runAndReadAll(
    `SELECT constraint_column_names FROM duckdb_constraints() WHERE table_name = '${escapeStr(tableName)}' AND constraint_type = 'PRIMARY KEY'`,
  );
  const expected = [...primaryKey, ...(streamKeyed ? [STREAM_COLUMN] : [])];
  const physical = (constraint.getRows() as unknown[][])[0]?.[0] as
    | { items?: unknown[] }
    | undefined;
  if (!physical?.items || JSON.stringify(physical.items) !== JSON.stringify(expected))
    throw new RowKeyError("Analytics account ownership requires its declared physical primary key");
}

/** Durable, retryable attribution of legacy rows; never infer an owner from a roster. */
export class AnalyticsAccountOwnership {
  /** Apply account ownership at the gateway, including replay of older journal rows. */
  async scopeRecords(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
    records: Record<string, unknown>[],
    streamScope?: string,
  ): Promise<Record<string, unknown>[]> {
    const discriminator = schema.sharedDiscriminatorColumn;
    if (!discriminator || records.length === 0) return records;
    await assertPhysicalPrimaryKey(
      conn,
      schema.tableName,
      schema.primaryKey,
      await this.catalog.isStreamKeyed(conn, schema.tableName),
    );
    const account = sourceAccountOf(sourceId);
    if (!account) throw new RowKeyError("An account-scoped table requires a qualified source id");
    const [expected] = await encodeTypedRowKeys(
      conn,
      schema,
      [discriminator],
      [{ [discriminator]: account }],
    );
    const normalized = records.map((record) =>
      record[discriminator] === undefined ? { ...record, [discriminator]: account } : record,
    );
    const owners = await encodeTypedRowKeys(
      conn,
      schema,
      [discriminator],
      normalized.map((record) => ({ [discriminator]: record[discriminator] })),
    );
    if (owners.some((owner) => owner !== expected)) {
      throw new RowKeyError("An analytics record belongs to a different source account");
    }
    // A correctly labelled incoming record must not overwrite another account's
    // existing primary key. NULL historical owners can be established by an
    // explicit incoming record, never by absence or roster inference.
    // Compare native key columns, not their text encoding, so lookup can use
    // primary-key indexes rather than casting every stored row on the writer.
    const primaryColumns = schema.primaryKey.map((name) => {
      const column = schema.columns.find((entry) => entry.name === name);
      if (!column) throw new RowKeyError("Unknown analytics primary key column");
      return column;
    });
    for (let offset = 0; offset < normalized.length; offset += 500) {
      const named = normalized
        .slice(offset, offset + 500)
        .map(
          (record) =>
            `(${primaryColumns.map((column) => `CAST(${formatValue(record[column.name])} AS ${normalizeAnalyticsColumnType(column.type, "Ownership key")})`).join(", ")})`,
        )
        .join(", ");
      if (schema.sharedDiscriminatorParent) {
        // A legacy NULL may already have a sibling-owned parent outside this
        // admission's repair batch. A positive write cannot steal that key.
        await this.assertResolved(
          conn,
          schema,
          `(${schema.primaryKey.map(quoteIdent).join(", ")}) IN (${named})${streamScope ? ` AND ${streamScope}` : ""}`,
        );
      }
      const collision = await conn.runAndReadAll(
        `SELECT 1 FROM ${quoteIdent(schema.tableName)} WHERE (${schema.primaryKey.map(quoteIdent).join(", ")}) IN (${named})
         AND ${quoteIdent(discriminator)} IS NOT NULL
         AND ${rowKeyExpr([discriminator])} <> '${escapeStr(expected!)}'
         ${streamScope ? `AND ${streamScope}` : ""} LIMIT 1`,
      );
      if (collision.getRows().length > 0)
        throw new RowKeyError("An analytics primary key belongs to a different source account");
    }
    return normalized;
  }
  constructor(private readonly catalog: AnalyticsCatalogStore) {}

  async repair(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
  ): Promise<void> {
    return this.apply(conn, schema, sourceId, false);
  }

  async validateRegistration(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
  ): Promise<void> {
    return this.apply(conn, schema, sourceId, true);
  }

  private async apply(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
    validateOnly: boolean,
  ): Promise<void> {
    const discriminator = schema.sharedDiscriminatorColumn;
    if (!discriminator) return;
    const relation = schema.sharedDiscriminatorParent;
    const childColumn = (name: string) => schema.columns.find((column) => column.name === name);
    if (!childColumn(discriminator))
      throw new RowKeyError("Unknown analytics account discriminator");
    // Validate even after repair completed: declarations are an authority boundary.
    let join: string | undefined;
    let parentOwner: string | undefined;
    const streamKeyed = await this.catalog.isStreamKeyed(conn, schema.tableName);
    if (!validateOnly)
      await assertPhysicalPrimaryKey(conn, schema.tableName, schema.primaryKey, streamKeyed);
    if (relation) {
      if (relation.table === schema.tableName || !childColumn(relation.column))
        throw new RowKeyError("Invalid analytics ownership parent relation");
      const reader = await conn.runAndReadAll(
        `SELECT source_id, schema_json FROM _analytics_catalog WHERE table_name = '${escapeStr(relation.table)}'`,
      );
      const row = (reader.getRows() as unknown[][])[0];
      // Parent registration may arrive after its children. This cannot grant ownership.
      if (!row) return;
      const parent = parseSchemaJson(String(row[1]), relation.table);
      if (
        !parent ||
        sourceTypeOf(String(row[0])) !== sourceTypeOf(sourceId) ||
        parent.sharedDiscriminatorParent ||
        !parent.sharedDiscriminatorColumn ||
        parent.primaryKey.length !== 1 ||
        parent.primaryKey[0] !== relation.parentColumn
      )
        throw new RowKeyError(
          "Analytics ownership requires a same-source, one-hop uniquely keyed parent",
        );
      const parentKey = parent.columns.find((column) => column.name === relation.parentColumn);
      const ownerColumn = parent.columns.find(
        (column) => column.name === parent.sharedDiscriminatorColumn,
      );
      const sameType = (a: string, b: string) =>
        normalizeAnalyticsColumnType(a, "Ownership relation") ===
        normalizeAnalyticsColumnType(b, "Ownership relation");
      if (
        !parentKey ||
        !ownerColumn ||
        !sameType(childColumn(relation.column)!.type, parentKey.type) ||
        !sameType(childColumn(discriminator)!.type, ownerColumn.type)
      )
        throw new RowKeyError("Analytics ownership relation columns must have matching types");
      const parentStreamKeyed = await this.catalog.isStreamKeyed(conn, relation.table);
      // Never join a device-scoped row to another stream, or to an unscoped parent.
      if (parentStreamKeyed !== streamKeyed) return;
      const physicalParent = await conn.runAndReadAll(
        `SELECT 1 FROM information_schema.tables WHERE table_name = '${escapeStr(relation.table)}' LIMIT 1`,
      );
      // A stale catalog cannot prove ownership, but already-attributed children
      // remain safe to remove. The destructive preflight still refuses NULLs.
      if (physicalParent.getRows().length === 0) return;
      await assertPhysicalPrimaryKey(conn, relation.table, [relation.parentColumn], streamKeyed);
      join =
        `c.${quoteIdent(relation.column)} = p.${quoteIdent(relation.parentColumn)}` +
        (streamKeyed ? ` AND c.${quoteIdent(STREAM_COLUMN)} = p.${quoteIdent(STREAM_COLUMN)}` : "");
      parentOwner = `p.${quoteIdent(parent.sharedDiscriminatorColumn)}`;
    }
    if (validateOnly || !(await this.pending(conn, schema.tableName))) return;
    if (relation && join && parentOwner) {
      const keys = [...schema.primaryKey, ...(streamKeyed ? [STREAM_COLUMN] : [])];
      // LIMIT matched rows, not the first NULL rows: an orphan must not starve
      // later attributable rows. Each admission commits at most one batch.
      await conn.run(`UPDATE ${quoteIdent(schema.tableName)} AS target SET ${quoteIdent(discriminator)} = matched.__owner
        FROM (SELECT ${keys.map((key) => `c.${quoteIdent(key)}`).join(", ")}, ${parentOwner} AS __owner
          FROM ${quoteIdent(schema.tableName)} c JOIN ${quoteIdent(relation.table)} p ON ${join}
          WHERE c.${quoteIdent(discriminator)} IS NULL AND ${parentOwner} IS NOT NULL LIMIT ${OWNERSHIP_REPAIR_BATCH}) matched
        WHERE ${keys.map((key) => `target.${quoteIdent(key)} = matched.${quoteIdent(key)}`).join(" AND ")}
          AND target.${quoteIdent(discriminator)} IS NULL`);
    }
    const unresolved = await conn.runAndReadAll(
      `SELECT 1 FROM ${quoteIdent(schema.tableName)} WHERE ${quoteIdent(discriminator)} IS NULL LIMIT 1`,
    );
    if (unresolved.getRows().length === 0)
      await conn.run(
        `UPDATE _analytics_catalog SET ownership_backfill_pending = false WHERE table_name = '${escapeStr(schema.tableName)}'`,
      );
  }

  /** Before destructive effects, refuse only unresolved rows in the requested scope. */
  async assertResolved(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    target?: string,
  ): Promise<void> {
    if (!schema.sharedDiscriminatorColumn || !(await this.pending(conn, schema.tableName))) return;
    const unresolved = await conn.runAndReadAll(
      `SELECT 1 FROM ${quoteIdent(schema.tableName)} WHERE ${quoteIdent(schema.sharedDiscriminatorColumn)} IS NULL${target ? ` AND (${target})` : ""} LIMIT 1`,
    );
    if (unresolved.getRows().length > 0)
      throw new RowKeyError(
        "Analytics deletion withheld: legacy rows have unresolved account ownership. Sync the declared parent records and retry schema registration before deleting; do not discard the pending page.",
      );
  }

  private async pending(conn: DuckDBConnection, tableName: string): Promise<boolean> {
    const reader = await conn.runAndReadAll(
      `SELECT ownership_backfill_pending FROM _analytics_catalog WHERE table_name = '${escapeStr(tableName)}'`,
    );
    return (reader.getRows() as unknown[][])[0]?.[0] !== false;
  }
}

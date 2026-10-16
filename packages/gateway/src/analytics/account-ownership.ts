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

/**
 * The parent relation of a child table, resolved against the installed parent:
 * `join` relates a child row `c` to its parent row `p`, and `parentOwner` is
 * the parent's account column, qualified with `p`.
 */
interface ParentJoin {
  table: string;
  join: string;
  parentOwner: string;
}

/** Whether child row `c` has an owned parent row, which a repair will copy the owner from. */
function attributableByParent(parent: ParentJoin): string {
  return `EXISTS (SELECT 1 FROM ${quoteIdent(parent.table)} p WHERE ${parent.join} AND ${parent.parentOwner} IS NOT NULL)`;
}

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

/**
 * Durable, retryable attribution of the rows a shared table held before it
 * recorded which account wrote them (its account column is NULL there).
 *
 * Two facts can prove such a row's owner, and nothing else does. A table the
 * catalog records under one full `<type>:<account>` id has only ever been
 * claimed by that account — a sibling's claim collapses the owner to the bare
 * type for good — so every legacy row in it is that account's. A table with a
 * declared parent relation inherits each row's owner from its parent row. A
 * roster is never a proof: a removed account may have written legacy rows.
 *
 * A row neither fact reaches is left in place, owned by nobody, until an
 * incoming record re-emits its key with an owner or the operator settles it
 * (the table manager's claim or drop over {@link unattributedScope}). It never
 * refuses a page: a deletion scoped to one account cannot touch it, and
 * refusing would hold the source forever for a row no retry could attribute.
 */
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
    // A legacy NULL may already have a sibling-owned parent outside this
    // admission's repair batch. A positive write cannot steal that key.
    const guarded = await this.resolveSettlementGuard(conn, schema, sourceId);
    for (let offset = 0; offset < normalized.length; offset += 500) {
      const named = normalized
        .slice(offset, offset + 500)
        .map(
          (record) =>
            `(${primaryColumns.map((column) => `CAST(${formatValue(record[column.name])} AS ${normalizeAnalyticsColumnType(column.type, "Ownership key")})`).join(", ")})`,
        )
        .join(", ");
      if (guarded)
        await this.assertNoAttributableRows(
          conn,
          schema,
          guarded,
          `(${schema.primaryKey.map(quoteIdent).join(", ")}) IN (${named})${streamScope ? ` AND ${streamScope}` : ""}`,
        );
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

  /**
   * One bounded repair batch for a table whose ownership is still pending.
   * Returns how many rows it labelled; a full batch means more may remain.
   */
  async repair(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
  ): Promise<number> {
    return this.apply(conn, schema, sourceId, false);
  }

  async validateRegistration(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
  ): Promise<void> {
    await this.apply(conn, schema, sourceId, true);
  }

  private async apply(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
    validateOnly: boolean,
  ): Promise<number> {
    const discriminator = schema.sharedDiscriminatorColumn;
    if (!discriminator) return 0;
    if (!schema.columns.some((column) => column.name === discriminator))
      throw new RowKeyError("Unknown analytics account discriminator");
    const streamKeyed = await this.catalog.isStreamKeyed(conn, schema.tableName);
    if (!validateOnly)
      await assertPhysicalPrimaryKey(conn, schema.tableName, schema.primaryKey, streamKeyed);
    // Validate even after repair completed: declarations are an authority boundary.
    const parent = await this.resolveParentJoin(conn, schema, sourceId, streamKeyed);
    if (validateOnly || !(await this.pending(conn, schema.tableName))) return 0;
    const keys = [...schema.primaryKey, ...(streamKeyed ? [STREAM_COLUMN] : [])];
    let attributed = 0;
    if (await this.isExclusiveOwner(conn, schema.tableName, sourceId)) {
      attributed = await this.attributeBatch(
        conn,
        schema,
        sourceId,
        keys,
        `c.${quoteIdent(discriminator)} IS NULL`,
        OWNERSHIP_REPAIR_BATCH,
      );
    } else if (parent) {
      // LIMIT matched rows, not the first NULL rows: an orphan must not starve
      // later attributable rows. Each caller commits at most one batch.
      const updated =
        await conn.runAndReadAll(`UPDATE ${quoteIdent(schema.tableName)} AS target SET ${quoteIdent(discriminator)} = matched.__owner
        FROM (SELECT ${keys.map((key) => `c.${quoteIdent(key)}`).join(", ")}, ${parent.parentOwner} AS __owner
          FROM ${quoteIdent(schema.tableName)} c JOIN ${quoteIdent(parent.table)} p ON ${parent.join}
          WHERE c.${quoteIdent(discriminator)} IS NULL AND ${parent.parentOwner} IS NOT NULL LIMIT ${OWNERSHIP_REPAIR_BATCH}) matched
        WHERE ${keys.map((key) => `target.${quoteIdent(key)} = matched.${quoteIdent(key)}`).join(" AND ")}
          AND target.${quoteIdent(discriminator)} IS NULL`);
      attributed = Number((updated.getRows() as unknown[][])[0]?.[0] ?? 0);
    }
    await this.settlePending(conn, schema);
    return attributed;
  }

  /**
   * Validate a declared parent relation and resolve it against the installed
   * parent table. `undefined` when the table declares no parent, or when the
   * parent is not (yet) in a state that can prove anything: registration may
   * arrive after the children, a stale catalog may name a table that is gone,
   * and a device-scoped row never joins an unscoped parent or another stream.
   */
  private async resolveParentJoin(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
    streamKeyed: boolean,
  ): Promise<ParentJoin | undefined> {
    const relation = schema.sharedDiscriminatorParent;
    if (!relation) return undefined;
    const discriminator = schema.sharedDiscriminatorColumn!;
    const childColumn = (name: string) => schema.columns.find((column) => column.name === name);
    if (relation.table === schema.tableName || !childColumn(relation.column))
      throw new RowKeyError("Invalid analytics ownership parent relation");
    const reader = await conn.runAndReadAll(
      `SELECT source_id, schema_json FROM _analytics_catalog WHERE table_name = '${escapeStr(relation.table)}'`,
    );
    const row = (reader.getRows() as unknown[][])[0];
    if (!row) return undefined;
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
    if (parentStreamKeyed !== streamKeyed) return undefined;
    const physicalParent = await conn.runAndReadAll(
      `SELECT 1 FROM information_schema.tables WHERE table_name = '${escapeStr(relation.table)}' LIMIT 1`,
    );
    if (physicalParent.getRows().length === 0) return undefined;
    await assertPhysicalPrimaryKey(conn, relation.table, [relation.parentColumn], streamKeyed);
    return {
      table: relation.table,
      join:
        `c.${quoteIdent(relation.column)} = p.${quoteIdent(relation.parentColumn)}` +
        (streamKeyed ? ` AND c.${quoteIdent(STREAM_COLUMN)} = p.${quoteIdent(STREAM_COLUMN)}` : ""),
      parentOwner: `p.${quoteIdent(parent.sharedDiscriminatorColumn)}`,
    };
  }

  /**
   * Before a destructive effect, refuse the requested scope only while a
   * bounded repair would still attribute rows in it: a legacy row whose
   * parent is already owned will be labelled by a later admission, and a
   * deletion scoped to one account would otherwise miss it for good. A row
   * nothing can attribute never refuses — see the class comment — and a table
   * one account owns exclusively has nothing to protect, since that account's
   * deletions reach every row.
   */
  async assertRepairSettled(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
    target?: string,
  ): Promise<void> {
    const guarded = await this.resolveSettlementGuard(conn, schema, sourceId);
    if (guarded) await this.assertNoAttributableRows(conn, schema, guarded, target);
  }

  /**
   * The parent relation a destructive scope must be checked against, or
   * `undefined` when nothing in the table can still be attributed by a repair:
   * no account column or parent relation, attribution already settled, an
   * exclusive owner, or a parent not in a state that proves anything.
   */
  private async resolveSettlementGuard(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
  ): Promise<ParentJoin | undefined> {
    if (!schema.sharedDiscriminatorColumn || !schema.sharedDiscriminatorParent) return undefined;
    if (!(await this.pending(conn, schema.tableName))) return undefined;
    if (await this.isExclusiveOwner(conn, schema.tableName, sourceId)) return undefined;
    const streamKeyed = await this.catalog.isStreamKeyed(conn, schema.tableName);
    return this.resolveParentJoin(conn, schema, sourceId, streamKeyed);
  }

  private async assertNoAttributableRows(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    parent: ParentJoin,
    target?: string,
  ): Promise<void> {
    // The outer FROM names one table, so a target written against bare column
    // names resolves to the child without qualifying it.
    const attributable = await conn.runAndReadAll(
      `SELECT 1 FROM ${quoteIdent(schema.tableName)} c
        WHERE c.${quoteIdent(schema.sharedDiscriminatorColumn!)} IS NULL${target ? ` AND (${target})` : ""}
          AND ${attributableByParent(parent)}
        LIMIT 1`,
    );
    if (attributable.getRows().length > 0)
      throw new RowKeyError(
        `Analytics change withheld: legacy rows in its scope are still being attributed to their account from ${parent.table}. Retry once that repair has caught up; do not discard the pending page.`,
      );
  }

  /**
   * The predicate, over the table aliased `c`, that selects the legacy rows
   * nothing will attribute: owned by nobody, and without an owned parent row
   * when the table declares a parent relation. These are the rows an operator
   * may claim or drop.
   */
  async unattributedScope(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
  ): Promise<string> {
    const streamKeyed = await this.catalog.isStreamKeyed(conn, schema.tableName);
    const parent = await this.resolveParentJoin(conn, schema, sourceId, streamKeyed);
    return (
      `c.${quoteIdent(schema.sharedDiscriminatorColumn!)} IS NULL` +
      (parent ? ` AND NOT ${attributableByParent(parent)}` : "")
    );
  }

  /** The rows {@link unattributedScope} selects, or 0 once the table's attribution is settled. */
  async countUnattributed(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
  ): Promise<number> {
    if (!schema.sharedDiscriminatorColumn || !(await this.pending(conn, schema.tableName)))
      return 0;
    const reader = await conn.runAndReadAll(
      `SELECT COUNT(*) FROM ${quoteIdent(schema.tableName)} c WHERE ${await this.unattributedScope(conn, schema, sourceId)}`,
    );
    return Number((reader.getRows() as unknown[][])[0]?.[0] ?? 0);
  }

  /**
   * Label the named legacy rows as the source's account, on the operator's
   * word; returns how many rows changed. `keyExpr` is the text key expression
   * `keys` were read with, so the caller's victim selection and this write
   * name exactly the same rows.
   */
  async attributeNamed(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
    keyExpr: string,
    keys: readonly string[],
  ): Promise<number> {
    if (keys.length === 0) return 0;
    const owner = this.ownerLiteral(schema, sourceId);
    const discriminator = quoteIdent(schema.sharedDiscriminatorColumn!);
    const updated = await conn.runAndReadAll(
      `UPDATE ${quoteIdent(schema.tableName)} SET ${discriminator} = ${owner}
        WHERE ${keyExpr} IN (${keys.map((key) => `'${escapeStr(key)}'`).join(", ")})
          AND ${discriminator} IS NULL`,
    );
    return Number((updated.getRows() as unknown[][])[0]?.[0] ?? 0);
  }

  /** Label up to `limit` rows in `scope` (a predicate over alias `c`) as the source's account. */
  private async attributeBatch(
    conn: DuckDBConnection,
    schema: AnalyticsTableSchema,
    sourceId: string,
    keys: readonly string[],
    scope: string,
    limit: number,
  ): Promise<number> {
    const discriminator = schema.sharedDiscriminatorColumn!;
    const owner = this.ownerLiteral(schema, sourceId);
    const updated = await conn.runAndReadAll(
      `UPDATE ${quoteIdent(schema.tableName)} AS target SET ${quoteIdent(discriminator)} = ${owner}
        FROM (SELECT ${keys.map((key) => `c.${quoteIdent(key)}`).join(", ")} FROM ${quoteIdent(schema.tableName)} c
               WHERE ${scope} LIMIT ${limit}) matched
        WHERE ${keys.map((key) => `target.${quoteIdent(key)} = matched.${quoteIdent(key)}`).join(" AND ")}
          AND target.${quoteIdent(discriminator)} IS NULL`,
    );
    return Number((updated.getRows() as unknown[][])[0]?.[0] ?? 0);
  }

  /** The source's account as a literal of the account column's type. */
  private ownerLiteral(schema: AnalyticsTableSchema, sourceId: string): string {
    const account = sourceAccountOf(sourceId);
    if (!account) throw new RowKeyError("An account-scoped table requires a qualified source id");
    const column = schema.columns.find((entry) => entry.name === schema.sharedDiscriminatorColumn)!;
    return `CAST(${formatValue(account)} AS ${normalizeAnalyticsColumnType(column.type, "Ownership column")})`;
  }

  /**
   * Whether the catalog records the table under this source's full id: one
   * account alone has ever claimed it, because a sibling's claim collapses the
   * owner to the bare type permanently (see `mergeCatalogOwner`).
   */
  private async isExclusiveOwner(
    conn: DuckDBConnection,
    tableName: string,
    sourceId: string,
  ): Promise<boolean> {
    return (
      sourceAccountOf(sourceId) !== "" &&
      (await this.catalog.readOwnerForTable(conn, tableName)) === sourceId
    );
  }

  /** Clear the catalog's pending flag once no legacy row is left. */
  async settlePending(conn: DuckDBConnection, schema: AnalyticsTableSchema): Promise<void> {
    const unresolved = await conn.runAndReadAll(
      `SELECT 1 FROM ${quoteIdent(schema.tableName)} WHERE ${quoteIdent(schema.sharedDiscriminatorColumn!)} IS NULL LIMIT 1`,
    );
    if (unresolved.getRows().length === 0)
      await conn.run(
        `UPDATE _analytics_catalog SET ownership_backfill_pending = false WHERE table_name = '${escapeStr(schema.tableName)}'`,
      );
  }

  private async pending(conn: DuckDBConnection, tableName: string): Promise<boolean> {
    const reader = await conn.runAndReadAll(
      `SELECT ownership_backfill_pending FROM _analytics_catalog WHERE table_name = '${escapeStr(tableName)}'`,
    );
    return (reader.getRows() as unknown[][])[0]?.[0] !== false;
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The SQL half of an analytics row's name.
 *
 * Wire keys are validated as scalars by the SDK, then cast using the table's
 * declared SQL types before becoming ledger keys. The stored-row expression
 * must produce that same text: a difference silently loses deletes and
 * prevents arrivals from clearing pending absences.
 *
 * They agree on three things. A one-column key is the value cast to text, so
 * every key already in a ledger keeps its meaning. A wider key is a JSON array
 * of the values in the key's declared order, which distinguishes tuples a
 * joined string cannot. Stored NULLs retain their legacy empty-string spelling;
 * new wire keys reject null or missing values rather than aliasing them.
 */

import {
  encodeRowKey,
  normalizeAnalyticsColumnType,
  RowKeyError,
  type AnalyticsTableSchema,
  type RowKey,
} from "@omnesis/source-sdk";
import { formatValue, quoteIdent } from "./internal.js";
import type { DuckDBConnection } from "@duckdb/node-api";

/** Cast wire values exactly as ingestion does before recording their ledger keys. */
export async function encodeTypedRowKeys(
  conn: DuckDBConnection,
  schema: AnalyticsTableSchema,
  keyColumns: readonly string[],
  keys: readonly RowKey[],
  mode: "tuple" | "legacy" | "record" = "tuple",
): Promise<string[]> {
  const types = keyColumns.map((name) => {
    const column = schema.columns.find((entry) => entry.name === name);
    if (!column) throw new RowKeyError(`Unknown row key column ${name}`);
    return normalizeAnalyticsColumnType(column.type, `Row key ${name}`);
  });
  const encoded: string[] = [];
  // These aliases belong solely to this VALUES relation. Never reuse source
  // column names: a source may itself name a key `_key_position`.
  const aliases = keyColumns.map((_, index) => `_key_value_${index}`);
  for (let offset = 0; offset < keys.length; offset += 500) {
    const tuples = keys.slice(offset, offset + 500).map((key, index) => {
      // Incoming tuples must be scalar and exact. Record-derived keys are
      // already shaped by the schema and may contain nullable or JSON/list
      // columns; cast them just as the stored record is cast.
      if (mode !== "record") encodeRowKey(keyColumns, key);
      return `(${index}, ${keyColumns
        .map((column, i) => {
          const value = formatValue(key[column]);
          // Legacy string lists ignored values the column could not represent.
          // Keep those strings nonmatching while canonicalizing valid values.
          return mode === "legacy"
            ? `COALESCE(CAST(TRY_CAST(${value} AS ${types[i]}) AS VARCHAR), CAST(${value} AS VARCHAR))`
            : `CAST(CAST(${value} AS ${types[i]}) AS VARCHAR)`;
        })
        .join(", ")})`;
    });
    try {
      const result = await conn.runAndReadAll(
        `SELECT ${rowKeyExpr(aliases)} FROM (VALUES ${tuples.join(", ")}) AS named_keys(_key_position, ${aliases.map(quoteIdent).join(", ")}) ORDER BY _key_position`,
      );
      encoded.push(...result.getRows().map((row) => String(row[0])));
    } catch (error) {
      if (
        error instanceof Error &&
        /^(Conversion|Out of Range|Invalid Input) Error:/.test(error.message)
      ) {
        throw new RowKeyError(
          `Row key values cannot be represented by the declared columns (${keyColumns.join(", ")})`,
        );
      }
      throw error;
    }
  }
  return encoded;
}

/** The expression naming a stored row, for a table addressed by `keyColumns`. */
export function rowKeyExpr(keyColumns: readonly string[]): string {
  if (keyColumns.length === 0) {
    throw new Error("A table with no delete key cannot name a row");
  }
  const text = (column: string) => `COALESCE(CAST(${quoteIdent(column)} AS VARCHAR), '')`;
  if (keyColumns.length === 1) return text(keyColumns[0]!);
  return `CAST(to_json([${keyColumns.map(text).join(", ")}]) AS VARCHAR)`;
}

/**
 * The name a ledger row records its key space under.
 *
 * Stored so a table whose declared key changes can be told from one whose key
 * it still is: the keys under the old name mean nothing to the new one, and
 * sweeping on them would delete by a key nobody wrote.
 */
export function rowKeySpace(keyColumns: readonly string[]): string {
  return keyColumns.join(",");
}

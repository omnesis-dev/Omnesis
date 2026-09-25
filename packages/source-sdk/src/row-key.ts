// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How an analytics row is named, once, for everything that names one.
 *
 * A delete, a snapshot, the arrival that clears a pending absence, a replica's
 * verdict on a deletion — all four address a row, and three of them record
 * what they addressed in a ledger keyed by a single text column. So the key
 * has to be a string, it has to be the same string wherever it is derived, and
 * for the tables that have always had a one-column key it has to be the string
 * those ledgers already hold.
 *
 * Hence the two shapes below. A one-column key encodes to the bare value, so
 * every row already in a ledger keeps its meaning and no data migration is
 * owed. A multi-column key encodes to a JSON array in the key's declared
 * order, which is unambiguous where concatenation is not: `["a:b", "c"]` and
 * `["a", "b:c"]` are different keys and a joined string cannot say so.
 */

/** A row named by the columns its table declares as its delete key. */
export type RowKey = Record<string, unknown>;

/**
 * A caller named a row in a way the table cannot be addressed by.
 *
 * A distinct type rather than a bare `Error`, because the host has to answer a
 * client mistake as a bad request and not as an internal failure — and it used
 * to decide that by matching the start of the message, so a refusal phrased
 * any other way became a sanitized 500 with "unhandled error" in the
 * operator's journal. The class is the classification; the wording is free to
 * change.
 */
export class RowKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowKeyError";
  }
}

/**
 * Canonical text form of `key`, for a table addressed by `keyColumns`.
 *
 * Throws when the key does not name exactly those columns. A missing column
 * would otherwise encode as a key that matches nothing, and an extra one to a
 * key the ledger holds under a different name — both silent.
 */
export function encodeRowKey(keyColumns: readonly string[], key: RowKey): string {
  if (keyColumns.length === 0) {
    throw new RowKeyError("A table with no delete key cannot name a row");
  }
  const names = Object.keys(key);
  if (names.length !== keyColumns.length || !keyColumns.every((column) => column in key)) {
    throw new RowKeyError(
      `A row key for this table names (${keyColumns.join(", ")}); got (${names.join(", ") || "nothing"})`,
    );
  }
  if (keyColumns.length === 1) return encodeValue(key[keyColumns[0]!]);
  return JSON.stringify(keyColumns.map((column) => encodeValue(key[column])));
}

/**
 * The same canonical form, taken from a whole row rather than from a key.
 *
 * A stored row carries every column; the key is the declared subset of it.
 */
export function rowKeyOf(keyColumns: readonly string[], row: Record<string, unknown>): string {
  const key: RowKey = {};
  for (const column of keyColumns) key[column] = row[column];
  return encodeRowKey(keyColumns, key);
}

/** Scalar input only: coercing objects or missing values aliases unrelated keys. */
function encodeValue(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new RowKeyError(
    "A row key value must be a finite scalar, not null, missing, or structured data",
  );
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Telling a row that changed from a row that was merely rewritten.
 *
 * The ingest signal fires per submitted record on every sync page, so the same
 * row arrives again on every re-sync and again on every re-bootstrap. A
 * consumer that treated each delivery as news would wake once per delivery,
 * which is what happened on the shipped path: one activity re-woke a watch
 * twenty-two times in three and a half days.
 *
 * Comparing the whole row does not fix it. Sources rewrite rows for reasons of
 * their own — an enrichment pass clearing and repopulating a fetch stamp, an
 * internal digest recomputed — and those writes are real mutations of real
 * columns that mean nothing to anyone. So the comparison covers the columns the
 * source declared as meaning something, and skips the ones it declared as
 * bookkeeping.
 *
 * A column the schema does not mention at all is included. Absence is not a
 * declaration: a source that adds a column and forgets to describe it should
 * produce a spurious update rather than a silent omission, because a noisy
 * watch is a bug someone reports and a quiet one is a bug nobody sees.
 */

import { createHash } from "node:crypto";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/** The primary-key values of a row, as the journal carries them. */
export type RowKey = Record<string, string | number | boolean>;

/**
 * A row's primary key, or `null` when the schema's key is not fully present.
 *
 * Null rather than a partial key: two rows sharing "the half of the key that
 * happened to be there" would dedup against each other, which turns a missing
 * value into a dropped event. A row that cannot be identified is one the
 * journal has no honest way to deduplicate.
 */
export function primaryKeyOf(
  row: Readonly<Record<string, unknown>>,
  schema: Pick<AnalyticsTableSchema, "primaryKey">,
): RowKey | null {
  const columns = schema.primaryKey;
  if (!columns || columns.length === 0) return null;
  const key: RowKey = {};
  for (const column of columns) {
    const value = row[column];
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      key[column] = value;
    } else if (value instanceof Date) {
      key[column] = value.toISOString();
    } else {
      return null;
    }
  }
  return key;
}

/** A stable digest of a primary key. Key order never affects it. */
export function hashKey(key: RowKey): string {
  return digest(canonical(key));
}

/**
 * A digest over everything the source says carries meaning.
 *
 * Column order never affects it, and neither does the JSON spelling of a
 * value: a number arriving as `12` on one page and `12.0` on the next is the
 * same reading, and a redelivery that differed only in formatting would
 * otherwise read as a change.
 */
export function stableRowHash(
  row: Readonly<Record<string, unknown>>,
  schema: Pick<AnalyticsTableSchema, "columns"> | undefined,
): string {
  const volatileColumns = new Set(
    (schema?.columns ?? []).filter((c) => c.volatile === true).map((c) => c.name),
  );
  const meaningful: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    if (volatileColumns.has(name)) continue;
    meaningful[name] = value;
  }
  return digest(canonical(meaningful));
}

/**
 * A value's canonical spelling, with object keys sorted at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two objects holding the same
 * pairs in different orders produce different text — and a provider that
 * builds a row from an iteration whose order is not guaranteed would then
 * report a change on every page.
 */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A digest of a journal event's content, ignoring when it was processed.
 *
 * The document mirror of {@link stableRowHash}. Documents carry no declared
 * column set to separate meaning from bookkeeping, so the whole payload counts.
 * What is deliberately absent is the arrival stamp: it moves on every delivery
 * by definition, so including it would make every repeat look new, which is the
 * one thing this exists to prevent.
 *
 * The document's own clock needs no separate input — a document event carries
 * its `semanticTime` in the payload, so a document that moved in time already
 * hashes differently.
 */
export function stableEventHash(payload: unknown): string {
  return digest(canonical(payload));
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Request-body schemas for routes mounted in `routes/analytics.ts`.
 *
 * The `/sql` and `/analytics/sql` write-blocklist (INSERT/UPDATE/…) is NOT
 * encoded in the schema — it's a domain check that the route still does on
 * the validated `sql` string. The schema's job is to enforce the envelope.
 */
import { z } from "zod";
import {
  normalizeAnalyticsSchemaColumnTypes,
  type AnalyticsTableSchema,
} from "@omnesis/source-sdk";
import { nonEmptyString } from "./common.js";

// POST /sql and POST /analytics/sql — same envelope.
export const sqlBody = z.object({
  sql: nonEmptyString,
  limit: z.number().int().positive().optional(),
  /**
   * Ask on behalf of one source, narrowing the query to the tables that
   * source owns.
   *
   * A collector sets this for a read a source package asked for; the package
   * itself only ever hands over SQL, so it cannot widen its own scope. Absent,
   * the query reaches the whole analytics database, which is what the
   * operator's own SQL surfaces want.
   */
  sourceId: nonEmptyString.optional(),
});
export type SqlBody = z.infer<typeof sqlBody>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const analyticsTableSchemaBody = z.unknown().transform((value, ctx): AnalyticsTableSchema => {
  try {
    return normalizeAnalyticsSchemaColumnTypes(value, "POST /analytics/ingest");
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: errorMessage(error) });
    return z.NEVER;
  }
});

// POST /analytics/ingest — `schema` is `AnalyticsTableSchema` from core.
// Runtime JSON still crosses this boundary, so column types are normalized to
// the source-sdk allowlist before the service can build DuckDB DDL.
//
// A tombstone must propagate or a row the upstream deleted lives here forever,
// so a page may upsert `records`, name rows to delete, or both.
//
// Which columns name a row is the TABLE's declaration (`deleteKey`, defaulting
// to its primary key), not this page's: `deletedKeys` and `presentKeys` are
// records over those columns. The single-column `deletedIds` / `presentIds`
// spellings, and the `deleteKeyColumn` that goes with them, are what a producer
// written before the declaration sends; the gateway normalises them, adopts the
// column as the table's key when the table declares none, and refuses a page
// that names a different one rather than addressing one table two ways.
const rowKeyValue = z.union([z.string(), z.number().finite(), z.boolean()]);
export const analyticsIngestBody = z.object({
  tableName: nonEmptyString,
  records: z.array(z.record(z.string(), z.unknown())),
  schema: analyticsTableSchemaBody.optional(),
  sourceId: z.string().optional(),
  deletedIds: z.array(z.string()).optional(),
  /**
   * The same tombstones as keys over the table's declared delete key: one
   * record per row, naming exactly the columns the table is addressed by. A
   * table whose key is more than one column can only be addressed this way.
   */
  deletedKeys: z.array(z.record(z.string(), rowKeyValue)).optional(),
  /** The final-page snapshot in the same shape. */
  presentKeys: z.array(z.record(z.string(), rowKeyValue)).optional(),
  /**
   * Final-page snapshot of the rows currently present upstream, in the
   * single-column spelling. A row the snapshot omits is not deleted: its
   * absence is recorded with a deadline and only removed once several later
   * snapshots agree and enough time has passed. Omit the field for any page
   * that is not a complete enumeration.
   */
  presentIds: z.array(z.string()).optional(),
  writeEpoch: z.number().int().nonnegative().optional(),
  pendingPageId: z.string().uuid().optional(),
  writeOrdinal: z.number().int().nonnegative().optional(),
  /** Idempotency identity for one completed snapshot observation. */
  observationId: z.string().min(1).max(256).optional(),
  deleteKeyColumn: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .optional(),
});
export type AnalyticsIngestBody = z.infer<typeof analyticsIngestBody>;

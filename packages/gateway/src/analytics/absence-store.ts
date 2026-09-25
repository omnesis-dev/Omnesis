// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `AnalyticsAbsenceStore` — the analytics plane's half of the snapshot-absence
 * rule.
 *
 * `presentIds` on a structured page carries exactly the semantics
 * `presentExternalIds` carries for documents, and exactly the same exposure:
 * a source whose read came back impoverished sends a small snapshot, and every
 * row it fails to name would otherwise be deleted from DuckDB on the spot.
 * Apple Health, Calendar, Call Log, Screen Time, browser history, Plaid and
 * Coinbase all reach the corpus this way, so a fix that covered only documents
 * would leave half the exposure standing.
 *
 * So an omission is recorded here with the same two-currency deadline the
 * document plane uses — `minObservations` corroborating snapshots and `minAge`
 * of elapsed time — and the absence sweep deletes only what has spent both.
 * The marks live in DuckDB rather than SQLite because they describe DuckDB
 * rows. A snapshot observation is submitted only after the source cursor has
 * committed, then its bounded ledger changes commit in one DuckDB transaction.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { escapeStr } from "./internal.js";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { AnalyticsConnectionPool } from "./connection-pool.js";

const log = createLogger("gateway:analytics").child("absence");

export const ANALYTICS_ABSENCES_TABLE = "_analytics_absences";
export const ANALYTICS_ABSENCE_SCOPES_TABLE = "_analytics_absence_scopes";
export const ANALYTICS_ABSENCE_OBSERVATIONS_TABLE = "_analytics_absence_observations";
const OBSERVATION_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const ABSENCE_WRITER_CHUNK = 200;

/** One analytics row whose absence has spent its deadline. */
export interface DueAnalyticsAbsence {
  sourceId: string;
  tableName: string;
  streamId: string;
  keyColumn: string;
  keyValue: string;
  /** Identity of the uninterrupted absence this candidate was read from. */
  markId: string;
  /** The member whose snapshots earned the absence, or `''` when unattributed. */
  observedBy: string;
  /** Deadline used by the read; the write rechecks it atomically. */
  dueBefore: number;
  /** Corroboration floor used by the read; the write rechecks it atomically. */
  minObservations: number;
}

/** What one snapshot changed about a table's pending absences. */
export interface AnalyticsAbsenceOutcome {
  marked: number;
  cleared: number;
  absent: number;
  deferred: number;
  missing: number;
  stored: number;
  snapshot: number;
}

export interface AnalyticsAbsencePhysicalPlan {
  /** Exact primary-key predicate for at most one physical writer chunk. */
  predicate: string;
  /** Serialized primary keys whose temporal projections leave with the rows. */
  recordKeys: string[];
  /** Physical rows, including tables with no temporal projections. */
  recordCount: number;
  /** True when the reader proved this chunk reaches the end of the logical key. */
  exhausted: boolean;
}

/**
 * Values per `IN (...)` list. DuckDB has no bound-parameter path on this code's
 * connection API, so every list is inlined — chunking keeps one statement's
 * size a function of the batch rather than of the table.
 */
const ABSENCE_IN_LIST_CHUNK = 500;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${escapeStr(value)}'`).join(", ");
}

/**
 * Inline a number into SQL, refusing anything that is not one. Strings go
 * through `escapeStr`; this is the same discipline for the other half, so a
 * mis-resolved config value fails loudly here rather than silently producing a
 * predicate like `first_absent_at <= NaN` that quietly matches nothing.
 */
function num(value: number, what: string): string {
  if (!Number.isFinite(value)) throw new Error(`analytics absence: ${what} is not a number`);
  return String(Math.trunc(value));
}

/** Run `fn` over `values` in chunks, so no statement grows with the table. */
async function inChunks(
  values: readonly string[],
  fn: (chunk: readonly string[]) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < values.length; i += ABSENCE_IN_LIST_CHUNK) {
    await fn(values.slice(i, i + ABSENCE_IN_LIST_CHUNK));
  }
}

export class AnalyticsAbsenceStore {
  constructor(private readonly pool: AnalyticsConnectionPool) {}

  async scope(
    conn: DuckDBConnection,
    sourceId: string,
    tableName: string,
    streamId: string,
  ): Promise<{ generation: number; revision: number }> {
    const reader = await conn.runAndReadAll(
      `SELECT generation, revision FROM ${ANALYTICS_ABSENCE_SCOPES_TABLE}
        WHERE source_id = '${escapeStr(sourceId)}'
          AND table_name = '${escapeStr(tableName)}'
          AND stream_id = '${escapeStr(streamId)}'`,
    );
    const row = (reader.getRows() as unknown[][])[0];
    return { generation: Number(row?.[0] ?? 0), revision: Number(row?.[1] ?? 0) };
  }

  async generation(
    conn: DuckDBConnection,
    sourceId: string,
    tableName: string,
    streamId: string,
  ): Promise<number> {
    return (await this.scope(conn, sourceId, tableName, streamId)).generation;
  }

  /**
   * Idempotent DDL, called from the façade's `open()` under the pool's first
   * connection — every other method expects the table to exist. DuckDB has no
   * `user_version` chain, so the internal tables are declared here rather than
   * in the SQLite migration list.
   */
  async ensureTables(conn: DuckDBConnection): Promise<void> {
    await conn.run(`
      CREATE TABLE IF NOT EXISTS ${ANALYTICS_ABSENCES_TABLE} (
        source_id VARCHAR NOT NULL,
        table_name VARCHAR NOT NULL,
        stream_id VARCHAR NOT NULL,
        key_column VARCHAR NOT NULL,
        key_value VARCHAR NOT NULL,
        first_absent_at BIGINT NOT NULL,
        last_absent_at BIGINT NOT NULL,
        observations BIGINT NOT NULL,
        generation BIGINT NOT NULL DEFAULT 0,
        mark_id VARCHAR NOT NULL DEFAULT '',
        last_observation_id VARCHAR NOT NULL DEFAULT '',
        PRIMARY KEY (source_id, table_name, stream_id, key_value)
      )
    `);
    // A development database may already carry the pre-token shape. Empty is a
    // valid identity for those uninterrupted marks; once one is revoked, its
    // replacement is inserted with a fresh token below.
    await conn.run(
      `ALTER TABLE ${ANALYTICS_ABSENCES_TABLE} ADD COLUMN IF NOT EXISTS mark_id VARCHAR DEFAULT ''`,
    );
    await conn.run(
      `ALTER TABLE ${ANALYTICS_ABSENCES_TABLE} ADD COLUMN IF NOT EXISTS last_observation_id VARCHAR DEFAULT ''`,
    );
    await conn.run(
      `ALTER TABLE ${ANALYTICS_ABSENCES_TABLE} ADD COLUMN IF NOT EXISTS generation BIGINT DEFAULT 0`,
    );
    await conn.run(
      `ALTER TABLE ${ANALYTICS_ABSENCES_TABLE} ADD COLUMN IF NOT EXISTS observed_by VARCHAR DEFAULT ''`,
    );
    await conn.run(`
      CREATE TABLE IF NOT EXISTS ${ANALYTICS_ABSENCE_SCOPES_TABLE} (
        source_id VARCHAR NOT NULL,
        table_name VARCHAR NOT NULL,
        stream_id VARCHAR NOT NULL,
        generation BIGINT NOT NULL DEFAULT 0,
        revision BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, table_name, stream_id)
      )
    `);
    await conn.run(
      `ALTER TABLE ${ANALYTICS_ABSENCE_SCOPES_TABLE} ADD COLUMN IF NOT EXISTS revision BIGINT DEFAULT 0`,
    );
    await conn.run(`
      CREATE TABLE IF NOT EXISTS ${ANALYTICS_ABSENCE_OBSERVATIONS_TABLE} (
        source_id VARCHAR NOT NULL,
        table_name VARCHAR NOT NULL,
        stream_id VARCHAR NOT NULL,
        observation_id VARCHAR NOT NULL,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (source_id, table_name, stream_id, observation_id)
      )
    `);
    // No secondary index on either ledger. DuckDB's explicit non-unique ART
    // indexes can reach a stored state in which deleting a row through them
    // fails fatally and invalidates the whole store (duckdb/duckdb#23645), so
    // an ordinary source removal could take the gateway down. These ledgers
    // are small and their range filters (`created_at`, `first_absent_at`) are
    // served by DuckDB's per-block min/max statistics. A store may still carry
    // one of these indexes; dropping it also repairs one in that state.
    await conn.run(`DROP INDEX IF EXISTS idx_analytics_absence_observations_created`);
    await conn.run(`DROP INDEX IF EXISTS idx_analytics_absences_due`);
  }

  /**
   * Apply a snapshot's verdict to a table's pending absences: revoke the ones
   * the snapshot names again, record or corroborate the ones it omits. Runs on
   * the caller's connection, inside its dedicated reconciliation transaction.
   *
   * `absentKeys` is the caller's SQL-side read of the keys the snapshot omits,
   * already capped at the mark ceiling, taken under the same scope predicate a
   * delete would use. Candidate discovery can scan on a reader; the writer is
   * handed only these keys plus a separately capped recovery tranche.
   */
  async reconcile(
    conn: DuckDBConnection,
    args: {
      sourceId: string;
      tableName: string;
      streamId: string;
      keyColumn: string;
      absentKeys: readonly string[];
      clearKeys: readonly string[];
      snapshotSize: number;
      observationId?: string;
      /** The member whose snapshot this is; `''` leaves the attribution as it stands. */
      observedBy: string;
      expectedGeneration: number;
      expectedRevision: number;
      clearCount: number;
      counts: { stored: number; absent: number; missing: number };
      observationSpacingMs: number;
      now: number;
    },
  ): Promise<AnalyticsAbsenceOutcome> {
    // The read-side planner hands the writer at most one configured chunk of
    // marks and one of clears. Resolve state only for those keys: loading the
    // whole pending scope here would turn a mass recovery into an unbounded
    // writer transaction.
    const observationId = args.observationId ?? randomUUID();
    const scope =
      `source_id = '${escapeStr(args.sourceId)}'` +
      ` AND table_name = '${escapeStr(args.tableName)}'` +
      ` AND stream_id = '${escapeStr(args.streamId)}'`;
    const priorReceipt = await conn.runAndReadAll(
      `SELECT 1 FROM ${ANALYTICS_ABSENCE_OBSERVATIONS_TABLE}
        WHERE ${scope} AND observation_id = '${escapeStr(observationId)}' LIMIT 1`,
    );
    if ((priorReceipt.getRows() as unknown[][]).length > 0) {
      return {
        marked: 0,
        cleared: 0,
        absent: args.counts.absent,
        deferred: Math.max(0, args.counts.absent - args.absentKeys.length),
        missing: args.counts.missing,
        stored: args.counts.stored,
        snapshot: args.snapshotSize,
      };
    }
    await conn.run(
      `INSERT INTO ${ANALYTICS_ABSENCE_OBSERVATIONS_TABLE}
         (source_id, table_name, stream_id, observation_id, created_at)
       VALUES ('${escapeStr(args.sourceId)}', '${escapeStr(args.tableName)}', '${escapeStr(args.streamId)}', '${escapeStr(observationId)}', ${num(args.now, "observedAt")})`,
    );
    await conn.run(
      `DELETE FROM ${ANALYTICS_ABSENCE_OBSERVATIONS_TABLE}
        WHERE (source_id, table_name, stream_id, observation_id) IN (
          SELECT source_id, table_name, stream_id, observation_id
            FROM ${ANALYTICS_ABSENCE_OBSERVATIONS_TABLE}
           WHERE created_at < ${num(args.now - OBSERVATION_RECEIPT_RETENTION_MS, "receiptCutoff")}
           ORDER BY created_at LIMIT ${ABSENCE_WRITER_CHUNK}
        )`,
    );

    const currentScope = await this.scope(conn, args.sourceId, args.tableName, args.streamId);
    if (
      currentScope.generation !== args.expectedGeneration ||
      currentScope.revision !== args.expectedRevision
    ) {
      // The receipt is deliberately retained: observationId names the source
      // snapshot, not this particular writer attempt. Replanning the same old
      // omission after a newer row arrived would let it re-mark that arrival.
      // A later source observation carries a new identity and may add evidence.
      return {
        marked: 0,
        cleared: 0,
        absent: args.counts.absent,
        deferred: Math.max(0, args.counts.absent - args.absentKeys.length),
        missing: args.counts.missing,
        stored: args.counts.stored,
        snapshot: args.snapshotSize,
      };
    }

    let generation = currentScope.generation;
    if (args.clearCount > ABSENCE_WRITER_CHUNK) {
      generation += 1;
      await conn.run(
        `INSERT INTO ${ANALYTICS_ABSENCE_SCOPES_TABLE}
           (source_id, table_name, stream_id, generation, revision)
         VALUES ('${escapeStr(args.sourceId)}', '${escapeStr(args.tableName)}', '${escapeStr(args.streamId)}', ${num(generation, "generation")}, ${num(currentScope.revision + 1, "revision")})
         ON CONFLICT (source_id, table_name, stream_id)
         DO UPDATE SET generation = EXCLUDED.generation, revision = EXCLUDED.revision`,
      );
    } else {
      await conn.run(
        `INSERT INTO ${ANALYTICS_ABSENCE_SCOPES_TABLE}
           (source_id, table_name, stream_id, generation, revision)
         VALUES ('${escapeStr(args.sourceId)}', '${escapeStr(args.tableName)}', '${escapeStr(args.streamId)}', ${num(generation, "generation")}, ${num(currentScope.revision + 1, "revision")})
         ON CONFLICT (source_id, table_name, stream_id)
         DO UPDATE SET revision = EXCLUDED.revision`,
      );
    }
    const pending =
      args.clearCount > ABSENCE_WRITER_CHUNK
        ? new Map<string, { lastAbsentAt: number; lastObservationId: string }>()
        : await this.pendingForKeys(
            conn,
            args.sourceId,
            args.tableName,
            args.streamId,
            generation,
            [...args.absentKeys, ...args.clearKeys],
          );

    // A pending absence the snapshot names again has been revoked: the source
    // is reporting the row, and the clock stops. The test is against the
    // snapshot itself and not against `absentKeys`, which is capped — a mark
    // that fell outside the cap is still absent, and clearing it because the
    // page ran out of room would hand the deadline back for the wrong reason.
    // Only rows that already carry a mark are considered, so a healthy snapshot
    // of a table with nothing pending costs nothing at all.
    const clear =
      args.clearCount > ABSENCE_WRITER_CHUNK
        ? []
        : args.clearKeys.filter((key) => pending.has(key));
    const mark = args.absentKeys.filter((key) => {
      const state = pending.get(key);
      if (state?.lastObservationId === observationId) return false;
      const lastAbsentAt = state?.lastAbsentAt;
      // Corroborated recently enough that this snapshot adds no independent
      // evidence — see `observationSpacingMs` on the document plane.
      return lastAbsentAt === undefined || args.now - lastAbsentAt >= args.observationSpacingMs;
    });
    const deferred = Math.max(0, args.counts.absent - args.absentKeys.length);

    await inChunks(clear, async (chunk) => {
      await conn.run(
        `DELETE FROM ${ANALYTICS_ABSENCES_TABLE} WHERE ${scope}
          AND generation = ${num(generation, "generation")}
          AND key_value IN (${inList(chunk)})`,
      );
    });
    if (mark.length > 0) {
      // DuckDB has no upsert arm that can both increment and preserve the
      // origin stamp in one statement, so the corroboration is an UPDATE over
      // the keys already pending and the first sighting is an INSERT over the
      // rest. Both are scoped to this table's stream and run in the caller's
      // transaction.
      const known = mark.filter((key) => pending.has(key));
      const fresh = mark.filter((key) => !pending.has(key));
      const now = num(args.now, "observedAt");
      await inChunks(known, async (chunk) => {
        await conn.run(
          `UPDATE ${ANALYTICS_ABSENCES_TABLE}
              SET observations = observations + 1, last_absent_at = ${now}
                , last_observation_id = '${escapeStr(observationId)}'
                , observed_by = CASE WHEN '${escapeStr(args.observedBy)}' = '' THEN observed_by ELSE '${escapeStr(args.observedBy)}' END
            WHERE ${scope}
              AND generation = ${num(generation, "generation")}
              AND key_value IN (${inList(chunk)})`,
        );
      });
      await inChunks(fresh, async (chunk) => {
        const values = chunk
          .map(
            (key) =>
              `('${escapeStr(args.sourceId)}', '${escapeStr(args.tableName)}', '${escapeStr(args.streamId)}', '${escapeStr(args.keyColumn)}', '${escapeStr(key)}', ${now}, ${now}, 1, ${num(generation, "generation")}, '${randomUUID()}', '${escapeStr(observationId)}', '${escapeStr(args.observedBy)}')`,
          )
          .join(", ");
        await conn.run(
          `INSERT INTO ${ANALYTICS_ABSENCES_TABLE}
             (source_id, table_name, stream_id, key_column, key_value,
              first_absent_at, last_absent_at, observations, generation, mark_id, last_observation_id, observed_by)
           VALUES ${values}
           ON CONFLICT (source_id, table_name, stream_id, key_value)
           DO UPDATE SET key_column = EXCLUDED.key_column,
             first_absent_at = EXCLUDED.first_absent_at,
             last_absent_at = EXCLUDED.last_absent_at,
             observations = EXCLUDED.observations,
             generation = EXCLUDED.generation,
             mark_id = EXCLUDED.mark_id,
             last_observation_id = EXCLUDED.last_observation_id,
             observed_by = CASE WHEN EXCLUDED.observed_by = '' THEN observed_by ELSE EXCLUDED.observed_by END`,
        );
      });
    }

    return {
      marked: mark.length,
      cleared: args.clearCount > ABSENCE_WRITER_CHUNK ? args.clearCount : clear.length,
      absent: args.counts.absent,
      deferred,
      missing: args.counts.missing,
      stored: args.counts.stored,
      snapshot: args.snapshotSize,
    };
  }

  /** State for the bounded keys one writer transaction may touch. */
  private async pendingForKeys(
    conn: DuckDBConnection,
    sourceId: string,
    tableName: string,
    streamId: string,
    generation: number,
    keyValues: readonly string[],
  ): Promise<Map<string, { lastAbsentAt: number; lastObservationId: string }>> {
    if (keyValues.length === 0) return new Map();
    const reader = await conn.runAndReadAll(
      `SELECT key_value, last_absent_at, last_observation_id FROM ${ANALYTICS_ABSENCES_TABLE}
        WHERE source_id = '${escapeStr(sourceId)}'
          AND table_name = '${escapeStr(tableName)}'
          AND stream_id = '${escapeStr(streamId)}'
          AND generation = ${num(generation, "generation")}
          AND key_value IN (${inList([...new Set(keyValues)])})`,
    );
    const out = new Map<string, { lastAbsentAt: number; lastObservationId: string }>();
    for (const row of reader.getRows() as unknown[][]) {
      out.set(String(row[0]), {
        lastAbsentAt: Number(row[1]),
        lastObservationId: String(row[2] ?? ""),
      });
    }
    return out;
  }

  /** The absences whose deadline has passed, oldest first, capped at `limit`. */
  async due(opts: {
    dueBefore: number;
    minObservations: number;
    limit: number;
  }): Promise<DueAnalyticsAbsence[]> {
    return this.pool.withConn(async ({ conn }) => {
      const reader = await conn.runAndReadAll(
        `SELECT a.source_id, a.table_name, a.stream_id, a.key_column, a.key_value, a.mark_id,
                a.observed_by
           FROM ${ANALYTICS_ABSENCES_TABLE} AS a
           LEFT JOIN ${ANALYTICS_ABSENCE_SCOPES_TABLE} AS s
             ON s.source_id = a.source_id AND s.table_name = a.table_name
            AND s.stream_id = a.stream_id
          WHERE a.generation = COALESCE(s.generation, 0)
            AND a.first_absent_at <= ${num(opts.dueBefore, "dueBefore")}
            AND a.observations >= ${num(opts.minObservations, "minObservations")}
          -- Absences one snapshot marked share their first_absent_at; the key
          -- breaks the tie so the order, and where LIMIT cuts it, is stable.
          ORDER BY a.first_absent_at, a.source_id, a.table_name, a.stream_id, a.key_value
          LIMIT ${num(opts.limit, "limit")}`,
      );
      return (reader.getRows() as unknown[][]).map((row) => ({
        sourceId: String(row[0]),
        tableName: String(row[1]),
        streamId: String(row[2]),
        keyColumn: String(row[3]),
        keyValue: String(row[4]),
        markId: String(row[5]),
        observedBy: String(row[6] ?? ""),
        dueBefore: opts.dueBefore,
        minObservations: opts.minObservations,
      }));
    });
  }

  /** Drop the pending absences of rows that left through another path. */
  async forget(
    conn: DuckDBConnection,
    args: { sourceId: string; tableName: string; streamId?: string; keyValues: readonly string[] },
  ): Promise<void> {
    if (args.keyValues.length === 0) return;
    const streamScope =
      args.streamId === undefined ? "" : ` AND stream_id = '${escapeStr(args.streamId)}'`;
    await inChunks(args.keyValues, async (chunk) => {
      await conn.run(
        `DELETE FROM ${ANALYTICS_ABSENCES_TABLE}
          WHERE source_id = '${escapeStr(args.sourceId)}'
            AND table_name = '${escapeStr(args.tableName)}'${streamScope}
            AND key_value IN (${inList(chunk)})`,
      );
    });
    const scope = await this.scope(conn, args.sourceId, args.tableName, args.streamId ?? "");
    await conn.run(
      `INSERT INTO ${ANALYTICS_ABSENCE_SCOPES_TABLE}
         (source_id, table_name, stream_id, generation, revision)
       VALUES ('${escapeStr(args.sourceId)}', '${escapeStr(args.tableName)}', '${escapeStr(args.streamId ?? "")}', ${num(scope.generation, "generation")}, ${num(scope.revision + 1, "revision")})
       ON CONFLICT (source_id, table_name, stream_id)
       DO UPDATE SET revision = EXCLUDED.revision`,
    );
  }

  /** Drop every pending absence a source or one of its tables owns. */
  async forgetScope(
    conn: DuckDBConnection,
    args: { sourceId?: string; tableName?: string; streamId?: string },
  ): Promise<void> {
    const clauses: string[] = [];
    if (args.sourceId !== undefined) clauses.push(`source_id = '${escapeStr(args.sourceId)}'`);
    if (args.tableName !== undefined) clauses.push(`table_name = '${escapeStr(args.tableName)}'`);
    if (args.streamId !== undefined) clauses.push(`stream_id = '${escapeStr(args.streamId)}'`);
    if (clauses.length === 0) return;
    const where = clauses.join(" AND ");
    await conn.run(`DELETE FROM ${ANALYTICS_ABSENCES_TABLE} WHERE ${where}`);
    await conn.run(`DELETE FROM ${ANALYTICS_ABSENCE_OBSERVATIONS_TABLE} WHERE ${where}`);
    if (
      args.sourceId !== undefined &&
      args.tableName !== undefined &&
      args.streamId !== undefined
    ) {
      // Preserve an epoch even when this upgraded table has never created a
      // scope row. Otherwise a plan that read the implicit 0/0 scope before
      // cleanup can pass the same implicit 0/0 check afterwards (ABA).
      const scope = await this.scope(conn, args.sourceId, args.tableName, args.streamId);
      await conn.run(
        `INSERT INTO ${ANALYTICS_ABSENCE_SCOPES_TABLE}
           (source_id, table_name, stream_id, generation, revision)
         VALUES ('${escapeStr(args.sourceId)}', '${escapeStr(args.tableName)}', '${escapeStr(args.streamId)}', ${num(scope.generation + 1, "generation")}, ${num(scope.revision + 1, "revision")})
         ON CONFLICT (source_id, table_name, stream_id)
         DO UPDATE SET generation = EXCLUDED.generation, revision = EXCLUDED.revision`,
      );
    } else {
      await conn.run(
        `UPDATE ${ANALYTICS_ABSENCE_SCOPES_TABLE}
            SET generation = generation + 1, revision = revision + 1
          WHERE ${where}`,
      );
    }
  }

  /**
   * Delete the rows named by `due` and forget completed absences. Each logical
   * absence gets one bounded writer transaction so its physical rows and
   * projections never part company. `judge` has the last word on an absence
   * that is still due, inside that transaction and before its rows go: a
   * `disputed` answer keeps the rows and drops the absence instead. Returns
   * how many physical rows went and how many absences were left disputed.
   */
  async deleteDue(
    due: readonly DueAnalyticsAbsence[],
    planRows: (row: DueAnalyticsAbsence, limit: number) => Promise<AnalyticsAbsencePhysicalPlan>,
    keyIsCurrent: (conn: DuckDBConnection, row: DueAnalyticsAbsence) => Promise<boolean>,
    deleteRows: (
      conn: DuckDBConnection,
      row: DueAnalyticsAbsence,
      plan: AnalyticsAbsencePhysicalPlan,
    ) => Promise<number>,
    judge?: (row: DueAnalyticsAbsence) => Promise<"delete" | "disputed">,
  ): Promise<{ deleted: number; disputed: number }> {
    let deleted = 0;
    let disputed = 0;
    for (const row of due) {
      // Resolve the possibly one-to-many physical rows on a reader. The writer
      // receives only exact primary keys for one fixed-size chunk.
      const plan = await planRows(row, ABSENCE_WRITER_CHUNK);
      deleted += await this.pool.serializeWrite(() =>
        this.pool.withConn(async ({ conn }) => {
          await conn.run("BEGIN TRANSACTION");
          try {
            // The due read happened on another connection. A healthy snapshot
            // may have revoked an absence in the gap, and the same key may even
            // have become absent again. Re-read both its deadline and its mark
            // identity here so neither a stale candidate nor a clear/re-mark ABA
            // can remove the recovered row.
            const reader = await conn.runAndReadAll(
              `SELECT key_value, mark_id
                 FROM ${ANALYTICS_ABSENCES_TABLE}
                WHERE source_id = '${escapeStr(row.sourceId)}'
                  AND table_name = '${escapeStr(row.tableName)}'
                  AND stream_id = '${escapeStr(row.streamId)}'
                  AND key_column = '${escapeStr(row.keyColumn)}'
                  AND key_value = '${escapeStr(row.keyValue)}'
                  AND generation = COALESCE((
                    SELECT generation FROM ${ANALYTICS_ABSENCE_SCOPES_TABLE}
                     WHERE source_id = '${escapeStr(row.sourceId)}'
                       AND table_name = '${escapeStr(row.tableName)}'
                       AND stream_id = '${escapeStr(row.streamId)}'
                  ), 0)
                  AND first_absent_at <= ${num(row.dueBefore, "dueBefore")}
                  AND observations >= ${num(row.minObservations, "minObservations")}`,
            );
            const live = (reader.getRows() as unknown[][])[0];
            if (!live || String(live[1]) !== row.markId) {
              await conn.run("COMMIT");
              return 0;
            }
            // Schema changes are writes too: recheck after entering the writer
            // transaction and before recording any replica deletion verdict.
            if (!(await keyIsCurrent(conn, row))) {
              await this.forget(conn, {
                sourceId: row.sourceId,
                tableName: row.tableName,
                streamId: row.streamId,
                keyValues: [row.keyValue],
              });
              await conn.run("COMMIT");
              return 0;
            }
            if (judge && (await judge(row)) === "disputed") {
              await this.forget(conn, {
                sourceId: row.sourceId,
                tableName: row.tableName,
                streamId: row.streamId,
                keyValues: [row.keyValue],
              });
              disputed += 1;
              await conn.run("COMMIT");
              return 0;
            }
            const count = plan.recordCount > 0 ? await deleteRows(conn, row, plan) : 0;
            if (plan.exhausted) {
              await this.forget(conn, {
                sourceId: row.sourceId,
                tableName: row.tableName,
                streamId: row.streamId,
                keyValues: [row.keyValue],
              });
            }
            await conn.run("COMMIT");
            return count;
          } catch (error) {
            try {
              await conn.run("ROLLBACK");
            } catch {
              // Preserve the original error; a failed rollback is secondary.
            }
            throw error;
          }
        }),
      );
      log.debug(`Absence sweep checked ${row.keyValue} in ${row.tableName} for ${row.sourceId}`);
    }
    return { deleted, disputed };
  }

  /**
   * Detach a member from the absences its snapshots earned: a device that no
   * longer hosts the source must not leave a verdict behind when the sweep
   * acts on them. Without a device, every absence of the source is
   * unattributed.
   */
  async forgetObserver(sourceId: string, deviceId?: string): Promise<void> {
    const scope =
      deviceId === undefined
        ? `source_id = '${escapeStr(sourceId)}' AND observed_by != ''`
        : `source_id = '${escapeStr(sourceId)}' AND observed_by = '${escapeStr(deviceId)}'`;
    await this.pool.serializeWrite(() =>
      this.pool.withConn(({ conn }) =>
        conn.run(`UPDATE ${ANALYTICS_ABSENCES_TABLE} SET observed_by = '' WHERE ${scope}`),
      ),
    );
  }
}

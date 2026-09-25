// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `run_sql` — run a read-only SQL query against the analytics database
 * (DuckDB). Used when the answer requires structured aggregation or
 * trend analysis that the search/document tools can't deliver. The
 * tables exposed are declared by the installed provider packages; this
 * tool itself stays source-agnostic.
 *
 * Returns a `sql.rows` tool result. The portal renders rows as a
 * compact table with a "re-run in SQL view" link.
 *
 * The underlying SqlPort enforces read-only via the DuckDB engine
 * (`access_mode=READ_ONLY` + `enable_external_access=false`). Tools
 * don't second-guess with regex-based keyword bans.
 */

import { z } from "zod";
import { describeSqlGrantRefusal } from "@omnesis/core";

import { SqlPortNotPermittedError, SqlPortOverCapError, type SqlPort } from "./types.js";
import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";

export const runSqlArgsSchema = z.object({
  sql: z
    .string()
    .min(1)
    .max(8_000)
    .describe(
      "DuckDB-compatible SELECT/WITH query against analytics.db. " +
        "Read-only is enforced by the engine; DML/DDL/ATTACH are rejected.",
    ),
  maxRows: z
    .number()
    .int()
    .positive()
    .max(1_000)
    .optional()
    .describe(
      "Cap rows returned (default 200). The portal renders the table; " +
        "small caps keep the agent's working set readable.",
    ),
});

export type RunSqlArgs = z.infer<typeof runSqlArgsSchema>;

export interface RunSqlToolDeps {
  port: SqlPort;
  /** Override the default row cap (default 200). */
  defaultMaxRows?: number;
}

export function createRunSqlTool(deps: RunSqlToolDeps): ToolHandle {
  const defaultMaxRows = deps.defaultMaxRows ?? 200;
  return {
    name: "run_sql",
    description:
      "Run a read-only SQL query (DuckDB syntax) against the user's analytics " +
      "database. Use when the answer needs aggregation over structured data " +
      "the search tools can't compute (trends, time-bucketed comparisons, " +
      "per-category counts). The set of tables available is declared by the " +
      "installed sources and listed in the system prompt — always check the " +
      "schema there before writing the query, and probe with `SELECT * FROM " +
      "<table> LIMIT 1` when a column name is uncertain. Always wrap in " +
      "date-bounded GROUP BY / AVG queries rather than dumping raw rows. " +
      "The result table is shown inline and the user can re-open it in the " +
      "SQL view.",
    schema: runSqlArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      if (typeof a.sql !== "string") return undefined;
      return a.sql.slice(0, 80);
    },
    async invoke(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = runSqlArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const args = parsed.data;
      const maxRows = args.maxRows ?? defaultMaxRows;
      try {
        const result = await deps.port.run(args.sql, {
          maxRows,
          signal: ctx.abortSignal,
        });
        return {
          kind: "sql.rows",
          sql: result.sql,
          columns: [...result.columns],
          rows: result.rows.map((r) => [...r]),
          rowCount: result.rowCount,
          truncated: result.truncated,
          rowIdentities: result.rowIdentities
            ? result.rowIdentities.map((id) =>
                id
                  ? {
                      table: id.table,
                      recordKey: id.recordKey,
                      primaryKeyColumns: id.primaryKeyColumns.map((c) => ({ ...c })),
                    }
                  : null,
              )
            : undefined,
          durationMs: result.durationMs,
          sources: result.sources ? [...result.sources] : undefined,
          subjects: result.subjects ? [...result.subjects] : undefined,
        };
      } catch (err) {
        // Over-cap is a clean, actionable outcome — not a failure. Surface a
        // distinct code so the agent narrows the query rather than retrying
        // the same one (#757). Never a silently-truncated result.
        if (err instanceof SqlPortOverCapError) {
          return { kind: "error", code: "sql_over_cap", message: err.message };
        }
        // A source-restricted denial names the refused tables (the
        // caller's own SQL) so the agent drops them and re-queries within
        // its grant instead of retrying the same statement.
        if (err instanceof SqlPortNotPermittedError) {
          return {
            kind: "error",
            code: "sql_not_permitted",
            message: describeSqlGrantRefusal(err),
          };
        }
        return {
          kind: "error",
          code: "sql_failed",
          message: (err as Error).message ?? "sql query failed",
        };
      }
    },
  };
}

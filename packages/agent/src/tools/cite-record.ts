// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `cite_record` — cite a single DuckDB analytics row that materially informed
 * the agent's answer. The structured twin of `annotate`: where
 * `annotate` cites an unstructured document, `cite_record` cites one row — a
 * point-in-time **record** — so it appears in the conversation's
 * citations/timeline drawer chronologically alongside document citations.
 *
 * The agent passes the row's identity exactly as `run_sql` returned it
 * (`rowIdentities[i]` — a `RecordReference`) plus the row's column values it
 * saw (the snapshot). The gateway derives the human title, key fields, semantic
 * time, and the redacted snapshot from the table's declared contract, and
 * resolves the bound document id — clients never see raw column names. The
 * result is harvested into a `kind:'record'` citation edge during the
 * conversation upsert, keyed by `recordKey` so a re-cite is idempotent.
 *
 * Mirrors `annotate` 1:1 deliberately — it does NOT overload `annotate`, which
 * keeps its document contract clean.
 */

import { z } from "zod";

import { RecordPortError, type RecordPort } from "./types.js";
import type { ToolResult } from "@omnesis/core";

import type { ToolContext, ToolHandle } from "../backend.js";

export const citeRecordArgsSchema = z.object({
  /**
   * The row's identity, copied verbatim from a `run_sql` result's
   * `rowIdentities[i]` (or an `trace_connections` bound row). A `null`/omitted
   * identity means the row has no addressable source row (an aggregate or
   * join) and cannot be cited as a record.
   */
  reference: z
    .object({
      table: z.string().min(1),
      recordKey: z.string().min(1),
      primaryKeyColumns: z
        .array(
          z.object({
            name: z.string().min(1),
            value: z.string(),
            castType: z.string().optional(),
          }),
        )
        .min(1),
    })
    .describe(
      "The row's identity, copied verbatim from a run_sql result's " +
        "rowIdentities[i] (table + recordKey + primaryKeyColumns).",
    ),
  /**
   * The row's column values exactly as the agent saw them in the `run_sql`
   * result — the immutable snapshot persisted with the citation. Keys are
   * column names; values are scalars.
   */
  snapshot: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .describe(
      "The row's column values as you saw them (column name -> scalar). " +
        "Snapshotted immutably into the citation.",
    ),
});

export type CiteRecordArgs = z.infer<typeof citeRecordArgsSchema>;

export interface CiteRecordToolDeps {
  port: RecordPort;
}

export function createCiteRecordTool(deps: CiteRecordToolDeps): ToolHandle {
  return {
    name: "cite_record",
    mutates: true,
    description:
      "Cite a single analytics row (a record) that materially informed your " +
      "answer — the structured twin of `annotate` for one DuckDB row. Pass the " +
      "`reference` exactly as `run_sql` returned it in `rowIdentities[i]` (only " +
      "non-null entries are citable — aggregates and joins have no row identity) " +
      "plus the `snapshot` of the row's column values you saw. The record appears " +
      "in the citations/timeline drawer at its semantic time. A timeless row (a " +
      "table with no semantic time) cannot be cited as a record.",
    schema: citeRecordArgsSchema,
    summarize(args: unknown): string | undefined {
      if (!args || typeof args !== "object") return undefined;
      const a = args as Record<string, unknown>;
      const ref = a.reference as { table?: unknown; recordKey?: unknown } | undefined;
      const table = ref && typeof ref.table === "string" ? ref.table : "";
      const key = ref && typeof ref.recordKey === "string" ? ref.recordKey.slice(0, 40) : "";
      return table ? `${table}: ${key}` : key;
    },
    async invoke(rawArgs: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const parsed = citeRecordArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: parsed.error.issues[0]?.message ?? "invalid arguments",
        };
      }
      const args = parsed.data;
      let resolved;
      try {
        resolved = await deps.port.resolve({
          reference: args.reference,
          snapshot: args.snapshot,
        });
      } catch (err) {
        if (err instanceof RecordPortError) {
          return {
            kind: "error",
            code:
              err.rejection.reason === "unknown_table"
                ? "record_unknown_table"
                : "record_not_timeline_eligible",
            message: err.message,
          };
        }
        return {
          kind: "error",
          code: "cite_record_failed",
          message: (err as Error).message ?? "cite_record failed",
        };
      }
      return {
        kind: "cite_record.recorded",
        table: resolved.table,
        recordKey: resolved.recordKey,
        primaryKeyColumns: resolved.primaryKeyColumns.map((c) => ({ ...c })),
        title: resolved.title,
        keyFields: resolved.keyFields.map((f) => ({ ...f })),
        semanticTime: resolved.semanticTime,
        snapshot: { ...resolved.snapshot },
        sourceId: resolved.sourceId,
        sourceType: resolved.sourceType,
        tableDisplayName: resolved.tableDisplayName,
        boundDocumentId: resolved.boundDocumentId,
      };
    },
  };
}

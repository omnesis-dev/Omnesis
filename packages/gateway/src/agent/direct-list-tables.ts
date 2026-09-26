// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import {
  safeRetrievalCatalogTable,
  type RetrievalCatalogTable,
  type ToolHandle,
} from "@omnesis/agent";

const listTablesArgsSchema = z
  .object({
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

/** The callback supplies only this request's permitted catalog, never a cached grant. */
export function createDirectListTablesTool(
  catalog: () => Promise<readonly RetrievalCatalogTable[]>,
): ToolHandle {
  return {
    name: "list_tables",
    description:
      "Discover the live analytics tables and columns this connection may query with run_sql. " +
      "Read-only schema metadata, without row data. Start with {} and repeat with offset=nextOffset " +
      "until nextOffset is null. Pages default to 20 tables (limit 1–100). Catalog changes may require restarting at offset 0.",
    schema: listTablesArgsSchema,
    mutates: false,
    async invoke(rawArgs) {
      const parsed = listTablesArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          kind: "error",
          code: "invalid_args",
          message: "Invalid catalog paging arguments.",
        };
      }
      try {
        const { offset, limit } = parsed.data;
        // Names and types pass the same identifier filter the instruction
        // catalog applies, because both reach the agent's model.
        const tables = (await catalog())
          .map(safeRetrievalCatalogTable)
          .filter((table) => table !== null)
          .sort((a, b) => (a.tableName < b.tableName ? -1 : a.tableName > b.tableName ? 1 : 0));
        const page = tables.slice(offset, offset + limit).map((table) => ({
          tableName: table.tableName,
          columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
        }));
        return {
          kind: "structured",
          resultType: "analytics.tables",
          data: {
            tables: page,
            nextOffset: offset + page.length < tables.length ? offset + page.length : null,
          },
        };
      } catch {
        return {
          kind: "error",
          code: "catalog_failed",
          message: "The analytics catalog could not be read.",
        };
      }
    },
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { STREAM_COLUMN, quoteIdent } from "../analytics/internal.js";
import type { AnalyticsDb, RecordTableSchema } from "../analytics-db.js";

/** SQL projections are not evidence for URLs: re-read one exact, catalog-owned row. */
export async function hydrateBrowserRecord(
  analytics: AnalyticsDb,
  table: RecordTableSchema,
  primaryKeyColumns: ReadonlyArray<{ name: string; value: string }>,
): Promise<{ snapshot: Record<string, string | number | boolean | null>; urls: string[] }> {
  const empty = { snapshot: {}, urls: [] };
  const keys = [...table.primaryKey, ...(table.streamKeyed ? [STREAM_COLUMN] : [])];
  const values = new Map(primaryKeyColumns.map(({ name, value }) => [name, value]));
  if (values.size !== keys.length || keys.some((key) => !values.has(key))) return empty;
  const params: Record<string, string> = {};
  const conditions = keys.map((key, index) => {
    params[`key${index}`] = values.get(key)!;
    const type = table.columns.find((column) => column.name === key)?.type ?? "VARCHAR";
    return `${quoteIdent(key)} = CAST($key${index} AS ${type})`;
  });
  const result = await analytics.executeQuery(
    `SELECT * FROM ${quoteIdent(table.tableName)} WHERE ${conditions.join(" AND ")} LIMIT 1`,
    { params, limit: 1, timeoutMs: 5000 },
  );
  if (!result.rows[0]) return empty;
  const snapshot: Record<string, string | number | boolean | null> = {};
  result.columns.forEach((name, index) => {
    const value = result.rows[0]![index];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      snapshot[name] = value;
  });
  const urls = table.columns.flatMap((column) => {
    const value = snapshot[column.name];
    if (
      column.references !== "url" ||
      column.sensitive ||
      typeof value !== "string" ||
      value.length > 4096
    )
      return [];
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
        ? [url.href]
        : [];
    } catch {
      return [];
    }
  });
  return { snapshot, urls };
}

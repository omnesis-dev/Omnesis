// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { join } from "node:path";
import { produceEncryptedArtifact } from "@omnesis/core";
import type { DuckDBConnection } from "@duckdb/node-api";

export interface EncryptedAnalyticsExport {
  rootKey: string;
  scope: string;
}

function csvCell(value: unknown): string {
  if (value === null) return "";
  const text = String(value);
  return text === "" || /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Fetch bounded DuckDB chunks straight into ciphertext, without COPY's plaintext spill files. */
export async function exportEncryptedAnalyticsCsv(
  connection: DuckDBConnection,
  directory: string,
  tables: readonly string[],
  options: EncryptedAnalyticsExport,
): Promise<void> {
  for (const table of tables) {
    if (!table || table === "." || table === ".." || /[\\/:\u0000-\u001f\u007f]/.test(table))
      throw new Error("Analytics table name cannot be used as an export filename");
    const filename = `${table}.csv`;
    await produceEncryptedArtifact(
      join(directory, `${filename}.enc`),
      {
        rootKey: options.rootKey,
        scope: `${options.scope}:${filename}`,
      },
      async (body) => {
        const result = await connection.stream(`SELECT * FROM "${table.replaceAll('"', '""')}"`);
        const write = async (text: string) => {
          if (!body.write(text)) await once(body, "drain");
        };
        try {
          await write(result.columnNames().map(csvCell).join(",") + "\n");
          for (;;) {
            const chunk = await result.fetchChunk();
            if (!chunk || chunk.rowCount === 0) break;
            for (const row of chunk.getRows()) await write(row.map(csvCell).join(",") + "\n");
          }
        } catch (error) {
          connection.interrupt();
          throw error;
        }
      },
    );
  }
}

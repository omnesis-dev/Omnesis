// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Coverage for the `run_sql` tool's port-error mapping: a row-cap
 * overflow stays `sql_over_cap`, a source-restricted denial becomes the
 * actionable `sql_not_permitted` naming the refused tables (the caller's
 * own SQL), and anything else stays an opaque `sql_failed`.
 */

import { describe, expect, it } from "vitest";

import { createRunSqlTool } from "./run-sql.js";
import { SqlPortNotPermittedError, SqlPortOverCapError } from "./types.js";
import type { SqlPort, SqlPortResult } from "./types.js";

const CTX = { sessionId: "S", messageId: "M" } as const;

const ROWS: SqlPortResult = {
  sql: "SELECT 1 AS value",
  columns: ["value"],
  rows: [[1]],
  rowCount: 1,
  truncated: false,
  durationMs: 1,
};

function port(run: SqlPort["run"]): SqlPort {
  return { run };
}

describe("createRunSqlTool — port error mapping", () => {
  it("passes rows through", async () => {
    const tool = createRunSqlTool({ port: port(async () => ROWS) });
    const result = await tool.invoke({ sql: "SELECT 1 AS value" }, CTX);
    expect(result).toMatchObject({ kind: "sql.rows", columns: ["value"], rows: [[1]] });
  });

  it("maps a source-restricted denial to an actionable sql_not_permitted", async () => {
    const tool = createRunSqlTool({
      port: port(async () => {
        throw new SqlPortNotPermittedError({
          tables: ["other_store_events"],
          tableFunctions: [],
          shows: [],
          macros: [],
        });
      }),
    });
    const result = await tool.invoke({ sql: "SELECT * FROM other_store_events" }, CTX);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.code).toBe("sql_not_permitted");
    expect(result.message).toContain("other_store_events");
  });

  it("names refused table functions too", async () => {
    const tool = createRunSqlTool({
      port: port(async () => {
        throw new SqlPortNotPermittedError({
          tables: [],
          tableFunctions: ["pragma_table_info"],
          shows: [],
          macros: [],
        });
      }),
    });
    const result = await tool.invoke(
      { sql: "SELECT * FROM pragma_table_info('other_store_events')" },
      CTX,
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.code).toBe("sql_not_permitted");
    expect(result.message).toContain("pragma_table_info");
  });

  it("keeps over-cap and generic failures on their existing codes", async () => {
    const overCap = createRunSqlTool({
      port: port(async () => {
        throw new SqlPortOverCapError(200);
      }),
    });
    const capped = await overCap.invoke({ sql: "SELECT * FROM t" }, CTX);
    expect(capped).toMatchObject({ kind: "error", code: "sql_over_cap" });

    const failed = createRunSqlTool({
      port: port(async () => {
        throw new Error("no such table: t");
      }),
    });
    const result = await failed.invoke({ sql: "SELECT * FROM t" }, CTX);
    expect(result).toMatchObject({ kind: "error", code: "sql_failed" });
  });

  it("rejects an empty query as invalid args", async () => {
    const tool = createRunSqlTool({ port: port(async () => ROWS) });
    const result = await tool.invoke({ sql: "" }, CTX);
    expect(result).toMatchObject({ kind: "error", code: "invalid_args" });
  });
});

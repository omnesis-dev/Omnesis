// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  isJSON,
  gw,
  withSpinner,
  CliError,
  EXIT_USER_ERROR,
  EXIT_AUTH,
  EXIT_GATEWAY_ERROR,
  EXIT_FAILURE,
} from "../utils.js";

export const sqlCommand = defineCommand({
  meta: {
    name: "sql",
    description: "Run a read-only SQL query against the analytics or sqlite DB",
  },
  args: {
    query: {
      type: "positional",
      description: "SQL query to run",
      required: true,
    },
    db: {
      type: "enum",
      options: ["sqlite", "duckdb"],
      description: "which database to query (default: duckdb)",
      default: "duckdb",
    },
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run(ctx) {
    const { args } = ctx;
    // The `query` positional is `required: true`, so citty already gates the
    // command on it being non-empty; spreading `args._` into the join would
    // double the value because citty exposes named positionals in BOTH
    // `args.query` and `args._`.
    const sql = args.query;
    if (!sql) {
      throw new CliError(
        `${c.red}Usage: omnesis sql "<query>" [--db sqlite|duckdb]${c.reset}`,
        EXIT_USER_ERROR,
      );
    }

    const dbArg = args.db;
    const endpoint = dbArg === "sqlite" ? "/sql" : "/analytics/sql";

    const res = await withSpinner(`Running ${dbArg} query`, () =>
      gw(endpoint, {
        method: "POST",
        body: JSON.stringify({ sql }),
      }),
    );

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      const code =
        res.status === 401 || res.status === 403
          ? EXIT_AUTH
          : res.status >= 500
            ? EXIT_GATEWAY_ERROR
            : res.status >= 400
              ? EXIT_USER_ERROR
              : EXIT_FAILURE;
      throw new CliError(`${c.red}${data.error ?? `Query failed: ${res.status}`}${c.reset}`, code);
    }

    const data = (await res.json()) as {
      columns: string[];
      rows: unknown[][];
      rowCount: number;
      timing: number;
    };

    if (isJSON) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (data.rowCount === 0) {
      console.log(`${c.dim}No results${c.reset}`);
      return;
    }

    const widths = data.columns.map((col, i) => {
      const values = data.rows.map((row) => String(row[i] ?? "NULL"));
      return Math.max(col.length, ...values.map((v) => v.length));
    });

    console.log(
      `${c.bold}${data.columns.map((col, i) => col.padEnd(widths[i])).join("  ")}${c.reset}`,
    );
    console.log(widths.map((w) => "─".repeat(w)).join("──"));

    for (const row of data.rows) {
      console.log(row.map((val, i) => String(val ?? "NULL").padEnd(widths[i])).join("  "));
    }

    console.log(
      `\n${c.dim}${data.rowCount} row${data.rowCount !== 1 ? "s" : ""} (${data.timing}ms)${c.reset}`,
    );
  },
});

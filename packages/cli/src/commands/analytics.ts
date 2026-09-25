// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { c, isJSON, gw, withSpinner, CliError, EXIT_GATEWAY_ERROR } from "../utils.js";

const catalogCommand = defineCommand({
  meta: {
    name: "catalog",
    description: "List analytics tables and their record counts",
  },
  args: {
    json: {
      type: "boolean",
      description: "Machine-readable JSON output",
    },
  },
  async run() {
    const res = await withSpinner("Loading analytics catalog", () => gw("/analytics/catalog"));
    if (!res.ok) {
      throw new CliError(`${c.red}Failed to fetch analytics catalog${c.reset}`, EXIT_GATEWAY_ERROR);
    }

    const data = (await res.json()) as { tables: Array<Record<string, unknown>> };

    if (isJSON) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    if (data.tables.length === 0) {
      console.log(`${c.dim}No analytics tables. Import data first.${c.reset}`);
      return;
    }

    console.log(`\n${c.bold}Analytics Tables${c.reset}\n`);
    for (const t of data.tables) {
      console.log(`  ${c.cyan}${t.tableName}${c.reset}  ${c.dim}${t.displayName}${c.reset}`);
      console.log(`    ${t.description}`);
      console.log(`    ${c.dim}${(t.recordCount as number).toLocaleString()} records${c.reset}`);
      console.log();
    }
  },
});

export const analyticsCommand = defineCommand({
  meta: {
    name: "analytics",
    description: "Inspect analytics catalog and tables",
  },
  // Bare `omnesis analytics` falls through to `catalog` (preserves previous
  // behaviour where the bare command listed the catalog).
  default: "catalog",
  subCommands: {
    catalog: catalogCommand,
  },
});

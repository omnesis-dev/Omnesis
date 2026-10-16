// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  gatewayFetch,
  isJSON,
  withSpinner,
  pickGatewayExitCode,
  CliError,
  EXIT_CANCELLED,
  EXIT_USER_ERROR,
} from "../utils.js";
import { readGatewayError } from "./members.js";

const USAGE = "Usage: omnesis sources legacy-rows <source-id> [--claim | --drop] [--yes]";

/**
 * One table's share of a `/admin/sources/:id/legacy-rows` report or settlement:
 * the rows reported or changed, and the rows still unattributed afterwards.
 */
export interface LegacyRowsTable {
  tableName: string;
  rows: number;
  remaining: number;
}

export type LegacyRowsAction = "claim" | "drop";

const total = (tables: readonly LegacyRowsTable[]) =>
  tables.reduce((sum, table) => sum + table.rows, 0);

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The report: what remains unattributed in the source's shared tables, and the way out. */
export function renderLegacyRows(sourceId: string, tables: readonly LegacyRowsTable[]): string[] {
  if (tables.length === 0) {
    return [
      `${c.green}No unattributed rows:${c.reset} every row of ${sourceId}'s tables has an account.`,
    ];
  }
  return [
    `${c.bold}${plural(total(tables), "row")} of ${sourceId}'s shared tables belong to no account:${c.reset}`,
    ...tables.map(
      (table) => `  ${table.tableName}  ${c.dim}${plural(table.rows, "row")}${c.reset}`,
    ),
    `${c.dim}They were written before Omnesis recorded which account wrote them. An account labels the`,
    `ones it still holds whenever it syncs them again; what remains is held by no account that has`,
    `synced since.${c.reset}`,
    `Claim them for ${sourceId} with ${c.cyan}--claim${c.reset}, or delete them with ${c.cyan}--drop${c.reset}.`,
  ];
}

/** The confirmation question for an action over the rows the report found. */
export function confirmMessage(
  sourceId: string,
  action: LegacyRowsAction,
  tables: readonly LegacyRowsTable[],
): string {
  const scope = `${plural(total(tables), "unattributed row")} in ${plural(tables.length, "table")}`;
  return action === "claim"
    ? `Mark ${scope} as ${sourceId}'s? Another account that still holds one of them will have its sync of that row refused. Continue?`
    : `Delete ${scope}? Only a resync of the account that holds them can bring them back. Continue?`;
}

/** The lines printed once the gateway has settled the rows. */
export function renderSettled(
  sourceId: string,
  action: LegacyRowsAction,
  tables: readonly LegacyRowsTable[],
): string[] {
  const verb = action === "claim" ? "Claimed" : "Dropped";
  return [
    `${c.green}${verb} ${plural(total(tables), "row")} for ${sourceId}${c.reset}`,
    ...tables.map(
      (table) => `  ${table.tableName}  ${c.dim}${plural(table.rows, "row")}${c.reset}`,
    ),
  ];
}

/**
 * `omnesis sources legacy-rows <source-id> [--claim | --drop]` — the rows of
 * a source's shared analytics tables that belong to no account. Without a
 * flag it reports them; `--claim` marks them as the source's account and
 * `--drop` deletes them, each after confirmation (`--yes` in scripts).
 */
export const legacyRowsCommand = defineCommand({
  meta: {
    name: "legacy-rows",
    description: "Report, claim or drop a source's shared-table rows that belong to no account",
  },
  args: {
    sourceId: {
      type: "positional",
      description: "source ID (e.g. google-calendar:maya@example.com)",
      required: false,
    },
    claim: { type: "boolean", description: "Mark the rows as this source's account" },
    drop: { type: "boolean", description: "Delete the rows" },
    yes: { type: "boolean", alias: "y", description: "Skip the confirmation prompt" },
    json: { type: "boolean", description: "Print JSON" },
  },
  async run(ctx) {
    const sourceId = ctx.args.sourceId;
    if (!sourceId) {
      throw new CliError(
        `${c.red}${USAGE}${c.reset}\n\n` +
          `Reports the rows of the source's shared analytics tables that belong to no account —\n` +
          `rows written before Omnesis recorded which account wrote them. --claim marks them as\n` +
          `this source's; --drop deletes them.\n\n` +
          `Examples:\n` +
          `  ${c.cyan}omnesis sources legacy-rows google-calendar:maya@example.com${c.reset}          Report\n` +
          `  ${c.cyan}omnesis sources legacy-rows google-calendar:maya@example.com --claim${c.reset}  Claim them\n` +
          `  ${c.cyan}omnesis sources legacy-rows google-calendar:maya@example.com --drop${c.reset}   Delete them\n\n` +
          `Run ${c.cyan}omnesis sources${c.reset} to see available source IDs.`,
        EXIT_USER_ERROR,
      );
    }
    if (ctx.args.claim === true && ctx.args.drop === true) {
      throw new CliError(
        `${c.red}Pass --claim or --drop, not both.\n${USAGE}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const action: LegacyRowsAction | undefined =
      ctx.args.claim === true ? "claim" : ctx.args.drop === true ? "drop" : undefined;
    const json = ctx.args.json === true;
    const path = `/admin/sources/${encodeURIComponent(sourceId)}/legacy-rows`;

    const report = await withSpinner(`Checking ${sourceId}`, () => gatewayFetch(path));
    if (!report.ok) {
      const body = await readGatewayError(report);
      throw new CliError(`${c.red}${body.error}${c.reset}`, pickGatewayExitCode(report.status));
    }
    const { tables } = (await report.json()) as { tables: LegacyRowsTable[] };
    if (!action || tables.length === 0) {
      if (json) console.log(JSON.stringify({ sourceId, action, tables }));
      else for (const line of renderLegacyRows(sourceId, tables)) console.log(line);
      return;
    }

    // Confirm before changing rows — unless `--yes`. A non-interactive run
    // (piped or `--json`) never blocks on a prompt: it needs `--yes` so a
    // script cannot hang.
    if (ctx.args.yes !== true) {
      if (isJSON || !process.stdout.isTTY) {
        throw new CliError(
          `${c.red}Refusing to ${action} without confirmation. Re-run with --yes.${c.reset}`,
          EXIT_USER_ERROR,
        );
      }
      for (const line of renderLegacyRows(sourceId, tables).slice(0, tables.length + 1))
        console.log(line);
      const prompts = await import("@clack/prompts");
      const answer = await prompts.confirm({
        message: confirmMessage(sourceId, action, tables),
        initialValue: false,
      });
      if (prompts.isCancel(answer) || answer !== true) {
        prompts.cancel("Cancelled.");
        throw new CliError("", EXIT_CANCELLED);
      }
    }

    // Each call settles a bounded number of rows and reports what remains, so
    // the command repeats it until every table is done.
    const settled = new Map<string, LegacyRowsTable>();
    for (;;) {
      const res = await withSpinner(
        `${action === "claim" ? "Claiming" : "Dropping"} rows of ${sourceId}`,
        () => gatewayFetch(path, { method: "POST", body: JSON.stringify({ action }) }),
      );
      if (!res.ok) {
        const body = await readGatewayError(res);
        throw new CliError(
          `${c.red}Could not ${action} the rows of ${sourceId}: ${body.error}${c.reset}`,
          pickGatewayExitCode(res.status),
        );
      }
      const body = (await res.json()) as { tables: LegacyRowsTable[] };
      for (const table of body.tables) {
        const sum = settled.get(table.tableName);
        settled.set(table.tableName, {
          ...table,
          rows: (sum?.rows ?? 0) + table.rows,
        });
      }
      if (body.tables.every((table) => table.remaining === 0 || table.rows === 0)) break;
    }
    const result = [...settled.values()];
    if (json) {
      console.log(JSON.stringify({ sourceId, action, tables: result }));
      return;
    }
    for (const line of renderSettled(sourceId, action, result)) console.log(line);
  },
});

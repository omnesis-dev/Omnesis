// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  formatSize,
  formatDateShort,
  formatInterval,
  gatewayJson,
  buildCliFx,
  iconFor,
  withSpinner,
  CliError,
  EXIT_USER_ERROR,
  EXIT_FAILURE,
} from "../utils.js";

interface DebugResult {
  status?: {
    sourceId: string;
    state?: string;
    lastSyncAt?: string;
    syncIntervalMs?: number;
    lastError?: string;
    lastSyncStats?: { documents: number; deleted: number; pages: number; durationMs: number };
  } | null;
  cursor?: Record<string, unknown> | null;
  config?: Record<string, unknown>;
}

interface SourceStats {
  documentCount: number;
  earliestSourceDate: string | null;
  latestSourceDate: string | null;
  totalUnitCount: number | null;
  dataSizeBytes: number;
}

export const debugCommand = defineCommand({
  meta: {
    name: "debug",
    description: "Show sync cursor, status, and gateway storage stats for a source",
  },
  args: {
    sourceId: {
      type: "positional",
      description: "source ID (e.g. gmail:user@gmail.com)",
      required: false,
    },
  },
  async run(ctx) {
    const sourceId = ctx.args.sourceId;
    if (!sourceId) {
      throw new CliError(
        `${c.red}Usage: omnesis sources debug <source-id>${c.reset}\n\n` +
          `Examples:\n` +
          `  ${c.cyan}omnesis sources debug gmail:user@gmail.com${c.reset}     Gmail sync cursor\n\n` +
          `Run ${c.cyan}omnesis sources${c.reset} to see available source IDs.`,
        EXIT_USER_ERROR,
      );
    }

    // Two parallel calls: gateway dispatches debug to the collector via WS,
    // and we fetch storage-side stats from the gateway directly.
    let dbg: DebugResult;
    let stats: SourceStats | null;
    const fxPromise = buildCliFx();
    try {
      [dbg, stats] = await withSpinner(`Loading debug for ${sourceId}`, () =>
        Promise.all([
          gatewayJson<DebugResult>(`/admin/sources/${encodeURIComponent(sourceId)}/debug`),
          gatewayJson<SourceStats>(`/documents/stats/${encodeURIComponent(sourceId)}`).catch(
            () => null,
          ),
        ]),
      );
    } catch (err) {
      throw new CliError(
        `${c.red}Debug failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
        EXIT_FAILURE,
      );
    }
    const fx = await fxPromise;
    const srcIcon = iconFor(sourceId, fx);
    const srcIconPrefix = srcIcon ? `${srcIcon} ` : "";

    console.log(`\n${c.bold}Debug: ${srcIconPrefix}${sourceId}${c.reset}\n`);

    // Status (from collector via WS)
    const status = dbg.status;
    if (status) {
      const stateColor =
        status.state === "syncing"
          ? c.cyan
          : status.state === "paused"
            ? c.dim
            : status.state === "error"
              ? c.red
              : c.green;
      console.log(`${c.bold}Status${c.reset}`);
      console.log(`  State:          ${stateColor}${status.state ?? "?"}${c.reset}`);
      if (status.lastSyncAt) console.log(`  Last sync:      ${status.lastSyncAt}`);
      if (status.syncIntervalMs)
        console.log(`  Interval:       ${formatInterval(status.syncIntervalMs)}`);
      if (status.lastError) console.log(`  Last error:     ${c.red}${status.lastError}${c.reset}`);
      if (status.lastSyncStats) {
        const ls = status.lastSyncStats;
        console.log(
          `  Last sync:      ${ls.documents} docs, ${ls.deleted} deleted, ${ls.pages} pages, ${ls.durationMs}ms`,
        );
      }
    } else {
      console.log(`${c.dim}Source not currently registered in the collector.${c.reset}`);
    }

    // Stats (from gateway storage)
    if (stats) {
      console.log(`\n${c.bold}Gateway Stats${c.reset}`);
      console.log(`  Documents:      ${stats.documentCount}`);
      if (stats.totalUnitCount && stats.totalUnitCount !== stats.documentCount) {
        console.log(`  Unit count:     ${stats.totalUnitCount}`);
      }
      console.log(`  Size:           ${formatSize(stats.dataSizeBytes)}`);
      if (stats.earliestSourceDate && stats.latestSourceDate) {
        console.log(
          `  Date range:     ${formatDateShort(stats.earliestSourceDate)} → ${formatDateShort(stats.latestSourceDate)}`,
        );
      }
    }

    // Cursor (collector debug payload)
    console.log(`\n${c.bold}Sync Cursor${c.reset}`);
    if (!dbg.cursor) {
      console.log(`  ${c.dim}(no cursor — never synced or cursor not surfaced)${c.reset}`);
    } else {
      for (const [key, val] of Object.entries(dbg.cursor)) {
        const display = typeof val === "object" ? JSON.stringify(val, null, 2) : String(val);
        if (display.includes("\n")) {
          console.log(`  ${key}:`);
          for (const line of display.split("\n")) {
            console.log(`    ${c.dim}${line}${c.reset}`);
          }
        } else {
          console.log(`  ${key}: ${c.dim}${display}${c.reset}`);
        }
      }
    }

    // Source configuration
    if (dbg.config) {
      console.log(`\n${c.bold}Config${c.reset}`);
      console.log(
        `  ${c.dim}${JSON.stringify(dbg.config, null, 2).replace(/\n/g, "\n  ")}${c.reset}`,
      );
    }

    console.log();
  },
});

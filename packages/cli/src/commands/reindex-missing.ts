// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  cliConstants,
  gatewayFetch,
  withSpinner,
  CliError,
  EXIT_GATEWAY_ERROR,
  EXIT_FAILURE,
  pickGatewayExitCode,
} from "../utils.js";

/**
 * Manually trigger the indexer's "missing docs" repair pass instead of
 * waiting for the hourly timer. Useful after landing a chunker/embedder
 * fix to verify stuck docs clear without a 60-minute wait.
 */
export const reindexMissingCommand = defineCommand({
  meta: {
    name: "reindex-missing",
    description: "Trigger the indexer's missing-docs repair pass",
  },
  async run() {
    // Can legitimately take many minutes on a large backlog. Match the
    // server-side timeout in IndexerWorkerProxy (15 min) so we don't give
    // up early while the worker is still grinding.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cliConstants.INDEXER_WORKER_TIMEOUT_MS);

    try {
      const res = await withSpinner("Reindexing missing documents", () =>
        gatewayFetch("/admin/index/reindex-missing", {
          method: "POST",
          signal: controller.signal,
        }),
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new CliError(
          `${c.red}Failed (${res.status}): ${body.message ?? body.error ?? "unknown error"}${c.reset}`,
          pickGatewayExitCode(res.status),
        );
      }
      const body = (await res.json()) as { ok: boolean; indexed: number; errors: number };
      console.log(
        `${c.green}Done:${c.reset} ${c.bold}${body.indexed}${c.reset} indexed, ` +
          `${body.errors > 0 ? c.red : c.dim}${body.errors} errors${c.reset}`,
      );
    } catch (err) {
      if (err instanceof CliError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new CliError(`${c.red}Timed out after 16 minutes.${c.reset}`, EXIT_GATEWAY_ERROR);
      }
      throw new CliError(
        `${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`,
        EXIT_FAILURE,
      );
    } finally {
      clearTimeout(timer);
    }
  },
});

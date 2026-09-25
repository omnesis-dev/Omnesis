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
 * Rebuild the vector index, re-embedding every document under the currently
 * active embedding model. For bug recovery — e.g. after a chunker/embedder fix
 * that left existing chunks stale.
 *
 * Routes through the same gateway code path as a model swap (POST
 * /admin/index/rebuild → applyEmbedSwap), so behaviour and concurrency
 * guarantees match. Defaults to the graceful double-buffered rebuild (#1011):
 * search stays live on the existing index and switches automatically when the
 * new one is ready. `--hard` opts into an immediate cutover that wipes the
 * index now and accepts keyword-only search until the rebuild finishes.
 */
export const indexRebuildCommand = defineCommand({
  meta: {
    name: "rebuild",
    description: "Rebuild the vector index, re-embedding every document",
  },
  args: {
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip the confirmation prompt",
    },
    hard: {
      type: "boolean",
      description:
        "Immediate hard cutover: wipe the index now and drop to keyword-only search until the rebuild finishes (default is a graceful, zero-downtime rebuild)",
    },
  },
  async run(ctx) {
    const hard = ctx.args.hard === true;
    if (!ctx.args.yes) {
      const prompts = await import("@clack/prompts");
      const ok = await prompts.confirm({
        message: hard
          ? "Hard cutover: this immediately stops using the current embedder and wipes the vector index. Vector search drops to keyword-only until the rebuild finishes (can take hours on large corpora). Continue?"
          : "This rebuilds the vector index under the current model. Search stays live on the existing index and switches automatically when the rebuild finishes — no downtime. Continue?",
        initialValue: false,
      });
      if (prompts.isCancel(ok) || !ok) {
        prompts.cancel("Cancelled.");
        return;
      }
    }

    // The route returns once the swap has been kicked off; the rebuild itself
    // runs in the background. The route shouldn't block for long, but match the
    // reindex-missing timeout for safety.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cliConstants.INDEXER_WORKER_TIMEOUT_MS);

    try {
      const res = await withSpinner(
        hard ? "Hard cutover: wiping vector index and restarting indexer" : "Starting rebuild",
        () =>
          gatewayFetch("/admin/index/rebuild", {
            method: "POST",
            body: JSON.stringify({ mode: hard ? "hard" : "graceful" }),
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
      console.log(
        `${c.green}Done.${c.reset} ` +
          (hard
            ? "Hard cutover started — keyword-only search until the rebuild completes. "
            : "Graceful rebuild started — search stays live and switches automatically when ready. ") +
          `Watch progress with ${c.bold}omnesis status -w${c.reset}.`,
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

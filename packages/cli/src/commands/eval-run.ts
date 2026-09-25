// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { defineCommand } from "citty";
import {
  collectAllUrls,
  loadSuite,
  resolveSuite,
  resolveSuitePath,
  runBench,
  ProgressEmitter,
  type RunSummary,
  type SearchClient,
  type SearchResponseLite,
  type SystemSnapshot,
} from "@omnesis/eval";
import {
  c,
  CliError,
  EXIT_USER_ERROR,
  gatewayJson,
  isJSON,
  GATEWAY_REQUEST_URL,
} from "../utils.js";
import { buildContentHashSiblingsResolver } from "./eval-shared.js";

export const evalRunCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run an eval suite against the live gateway and write a run output",
  },
  args: {
    suite: {
      type: "positional",
      required: true,
      description: "Suite name or path to YAML file",
    },
    repeats: {
      type: "string",
      default: "3",
      description: "Timed repeats per query (warmup runs once, untimed)",
    },
    "warmup-queries": {
      type: "string",
      default: "0",
      description:
        "Pre-bench warmup: untimed search calls before the timed bench starts. " +
        "Use 1+ to absorb the cold embedder load outside the scored results.",
    },
    out: {
      type: "string",
      description: "Run output path. Defaults to ~/.config/omnesis/evals/runs/<run_id>.json",
    },
    json: { type: "boolean", description: "Machine-readable JSON summary" },
    "no-content-hash-expansion": {
      type: "boolean",
      description:
        "Skip auto-expansion of expected docs by content_hash siblings. By default, every " +
        "expected docId in the suite is unioned with every other indexed docId sharing its " +
        "content_hash (mirrors the search pipeline's dedupeByContentHash). Opt out here when " +
        "you want to test the suite as-written without sibling forgiveness.",
    },
  },
  async run(ctx) {
    const repeats = parseRepeats(ctx.args.repeats as string);
    const warmupQueries = parseNonNegativeInt(
      ctx.args["warmup-queries"] as string,
      "--warmup-queries",
    );
    const suitePath = resolveSuitePath(ctx.args.suite as string);

    let suite;
    try {
      suite = loadSuite(suitePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(`Failed to load suite ${suitePath}: ${msg}`, EXIT_USER_ERROR);
    }

    // Resolve URLs first — fail fast if the fixture is stale.
    const allUrls = collectAllUrls(suite);
    const { matches } = await gatewayJson<{ matches: Record<string, string[]> }>(
      "/documents/by-url",
      { method: "POST", body: JSON.stringify({ urls: allUrls }) },
    );
    const matchMap = new Map(Object.entries(matches));
    const expansionEnabled = !(
      ctx.args["no-content-hash-expansion"] === true || ctx.args["content-hash-expansion"] === false
    );
    const { resolvedDocIdGroups, unresolved } = await resolveSuite(
      suite,
      async (urls) => {
        const out = new Map<string, string[]>();
        for (const u of urls) {
          const ids = matchMap.get(u);
          if (ids && ids.length > 0) out.set(u, ids);
        }
        return out;
      },
      expansionEnabled ? buildContentHashSiblingsResolver() : undefined,
    );
    if (unresolved.length > 0) {
      throw new CliError(
        `Suite has ${unresolved.length} unresolved expected URL(s). Run ` +
          `\`omnesis eval doctor ${ctx.args.suite}\` to see which.`,
        EXIT_USER_ERROR,
      );
    }

    const evalsDir = join(
      process.env["OMNESIS_CONFIG_DIR"] ?? join(homedir(), ".config/omnesis"),
      "evals",
    );
    const runsDir = join(evalsDir, "runs");
    mkdirSync(runsDir, { recursive: true });

    const outPath = (ctx.args.out as string | undefined) ?? join(runsDir, "%RUN%.json");
    const progressJsonl = join(runsDir, "_progress.jsonl");
    const progressTxt = join(runsDir, "_progress.txt");

    const progress = new ProgressEmitter(progressJsonl, progressTxt);
    const client = buildClient();

    if (!isJSON) {
      const warmupSuffix =
        warmupQueries > 0
          ? `, ${warmupQueries} pre-bench warmup call${warmupQueries === 1 ? "" : "s"}`
          : "";
      console.log(
        `${c.bold}Running${c.reset} ${suite.queries.length} queries (${repeats} timed repeats each${warmupSuffix})`,
      );
      console.log(`${c.dim}Progress${c.reset}: tail -f ${progressJsonl}`);
      console.log(`${c.dim}Status${c.reset}: cat ${progressTxt}`);
    }

    const output = await runBench({
      suite,
      resolvedDocIdGroups,
      repeats,
      warmupQueries,
      client,
      progress,
    });
    await progress.close();

    const finalPath = outPath.replace("%RUN%", output.run_id);
    mkdirSync(dirname(finalPath), { recursive: true });
    writeFileSync(finalPath, JSON.stringify(output, null, 2));

    const failedCount = output.failed_queries?.length ?? 0;

    if (isJSON || ctx.args.json) {
      console.log(
        JSON.stringify({
          run_id: output.run_id,
          path: finalPath,
          failed_query_count: failedCount,
          summary: output.summary,
        }),
      );
      return;
    }

    console.log("");
    console.log(`${c.green}✓${c.reset} Run complete: ${finalPath}`);
    if (failedCount > 0) {
      // Failures are search-call errors (network/429/5xx), NOT genuine misses.
      // Surface them loudly — metrics computed over a run with failures
      // understate recall, so the comparison is not trustworthy.
      console.log(
        `${c.red}⚠ ${failedCount} search call${failedCount === 1 ? "" : "s"} failed after retries${c.reset} — metrics are CONTAMINATED (failed calls scored as zero-result). Re-run before trusting these numbers. See \`failed_queries\` in the run JSON.`,
      );
    }
    console.log("");
    printSummary(output.summary.overall);
  },
});

function parseRepeats(arg: string): number {
  const n = parseInt(arg, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw new CliError(`--repeats must be a positive integer; got ${arg}`, EXIT_USER_ERROR);
  }
  return n;
}

function parseNonNegativeInt(arg: string, flagName: string): number {
  const n = parseInt(arg, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new CliError(`${flagName} must be a non-negative integer; got ${arg}`, EXIT_USER_ERROR);
  }
  return n;
}

function buildClient(): SearchClient {
  return {
    async search(req): Promise<SearchResponseLite> {
      const body = {
        text: req.text,
        limit: req.limit,
        verbose: req.verbose,
      };
      const resp = await gatewayJson<SearchResponseLite>("/search", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return resp;
    },
    async getSystemSnapshot(): Promise<SystemSnapshot> {
      // Best-effort: /index/stats exists for everyone, /admin/system-info
      // and config endpoints may require admin scope. Skip on failure so
      // a read-token CLI can still run benches.
      let documentCount: number | undefined;
      let embeddingCount: number | undefined;
      try {
        const stats = await gatewayJson<{ totalIndexed?: number; totalChunks?: number }>(
          "/index/stats",
        );
        documentCount = stats.totalIndexed;
        embeddingCount = stats.totalChunks;
      } catch {
        /* ignore */
      }
      // `/config` is the read-scope config view, so a bench driven by a read
      // token still records the settings that produced its numbers. Take
      // `resolvedSearch` — the values the search pipeline actually runs with —
      // not the raw `config.search` overrides: an install that tunes nothing
      // has no `search` block at all, and two versions whose defaults differ
      // would then snapshot identically.
      //
      // A failure is reported rather than swallowed, so `null` in an artifact
      // always means "not captured" and never "nothing to capture" — a
      // snapshot that silently loses its config makes every run it stamps
      // unreproducible.
      let searchConfig: unknown = null;
      try {
        const { resolvedSearch } = await gatewayJson<{ resolvedSearch?: unknown }>("/config");
        searchConfig = resolvedSearch ?? null;
      } catch (err) {
        console.warn(
          `${c.dim}warn: could not read search config for the run snapshot: ${
            err instanceof Error ? err.message : String(err)
          }${c.reset}`,
        );
      }
      return {
        gateway: { url: GATEWAY_REQUEST_URL },
        search_config: searchConfig,
        index_snapshot: { document_count: documentCount, embedding_count: embeddingCount },
      };
    },
  };
}

function printSummary(overall: RunSummary): void {
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    `${c.bold}Summary${c.reset}  ${pad("hit@1", 6)} ${pad("hit@5", 6)} ${pad("hit@10", 7)} ${pad("recall", 6)} ${pad("mrr", 6)} ${pad("p50", 7)} ${pad("p95", 7)}`,
  );
  console.log(
    `         ${pct(overall.hit_at_1_mean)} ${pct(overall.hit_at_5_mean)} ${pct(overall.hit_at_10_mean)}  ` +
      `${pct(overall.recall_at_10_mean)} ${num(overall.mrr_mean)} ` +
      `${Math.round(overall.latency_p50)}ms  ${Math.round(overall.latency_p95)}ms`,
  );
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`.padEnd(6);
}
function num(v: number): string {
  return v.toFixed(2).padEnd(6);
}

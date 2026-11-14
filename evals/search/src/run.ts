// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `npm run search-eval:run` — score the real search engine on a prepared
 * dataset.
 *
 * It boots an isolated gateway from this checkout, pushes every passage through
 * `POST /documents` into one source, waits for the indexer to finish, and sends
 * each judged question to `POST /search`. Nothing is stubbed: chunking, the
 * keyword index, query compilation, fusion and the boost passes are the ones a
 * user gets. The corpus is a single mixed-language index, as a personal corpus
 * is, and every query searches all of it.
 *
 * `--mode lexical` assigns no embedder, so results are keyword search alone.
 * `--mode hybrid` assigns one embedder, which must be on this machine: the
 * eval never sends text to a remote model.
 *
 * Manual invocation only — never part of `npm run test`, CI or any hook.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  defaultDataDir,
  LANGUAGE_NAMES,
  parseLanguages,
  readManifest,
  readPassages,
  readQrels,
  readQueries,
  type Language,
} from "./dataset.js";
import { mean, percentile, scoreQuery } from "./metrics.js";
import {
  writeRun,
  type LanguageResult,
  type QueryRow,
  type RunMode,
  type RunSummary,
} from "./results.js";

const USAGE =
  "usage: search-eval:run -- --name <run-name> [--mode lexical|hybrid] [--data-dir <dir>] " +
  "[--languages ar,ko,…] [--max-passages N] [--max-queries N] [--embedder-url <loopback url>] " +
  "[--embedder-model <id>] [--allow-dirty]";

const SOURCE_ID = "synthetic:search-eval";
/** Every passage gets this date, so no query is ranked by recency. */
const PASSAGE_DATE = "2020-01-01T00:00:00.000Z";
const PUSH_BATCH = 500;
const QUERY_CONCURRENCY = 4;
const REQUEST_ATTEMPTS = 6;
/** Recall is measured over the first hundred results; the default pool is 50. */
const RESULT_DEPTH = 100;
const GATEWAY_CONFIG = { search: { params: { candidateLimit: RESULT_DEPTH } } };

interface SearchResponse {
  results?: Array<{ sourceUrl?: string | null }>;
  stages?: { bm25?: { engine?: string } };
}
interface IndexStats {
  totalIndexed?: number;
  totalChunks?: number;
  totalIndexErrors?: number;
  semanticSearch?: { state?: string };
}

function say(line: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function passageUrl(language: Language, docid: string): string {
  return `miracl://${language}/${docid}`;
}

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * The spawned gateway inherits this process's environment. Drop every Omnesis
 * setting so an operator's shell cannot point the run at a real install, a
 * keyring or a feature gate, then set the few the run needs.
 */
function isolateEnvironment(workDir: string): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OMNESIS_")) delete process.env[key];
  }
  process.env.OMNESIS_SYNTHETIC = "1";
  process.env.OMNESIS_SYNTH_PRE_DISCOVERED = "1";
  process.env.OMNESIS_SYNTH_AUTH_DELAY_MS = "50";
  process.env.OMNESIS_IO_CONCURRENCY = "4";
  process.env.OMNESIS_CPU_CONCURRENCY = "4";
  process.env.OMNESIS_SEARCH_WORKER_CONCURRENCY = String(QUERY_CONCURRENCY);
  process.env.OMNESIS_EMBED_BATCH_SIZE = "32";
  process.env.OMNESIS_EMBED_BULK_CONCURRENCY = "4";
  // The gateway's databases live under the system temp directory.
  process.env.TMPDIR = workDir;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  let allowDirty = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === "--allow-dirty") {
      allowDirty = true;
      continue;
    }
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined) throw new Error(USAGE);
    flags.set(flag, value);
    i += 1;
  }
  const name = flags.get("--name");
  if (!name || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(USAGE);
  const mode = (flags.get("--mode") ?? "lexical") as RunMode;
  if (mode !== "lexical" && mode !== "hybrid") throw new Error(USAGE);
  const dataDir = flags.get("--data-dir") ?? defaultDataDir();
  const maxPassages = Number(flags.get("--max-passages") ?? Infinity);
  const maxQueries = Number(flags.get("--max-queries") ?? Infinity);
  const embedderUrl = flags.get("--embedder-url") ?? "http://localhost:8001";
  const embedderModel = flags.get("--embedder-model") ?? "Qwen/Qwen3-Embedding-0.6B";
  if (mode === "hybrid" && !isLoopback(embedderUrl)) {
    throw new Error(
      `The embedder must run on this machine; ${embedderUrl} is not a loopback address`,
    );
  }

  const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
  if (dirty && !allowDirty) {
    throw new Error(
      "The checkout has uncommitted changes, so the result could not be tied to a commit. " +
        "Commit first, or pass --allow-dirty for a throwaway run.",
    );
  }
  const source = {
    commit: git("rev-parse", "HEAD"),
    dirty,
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
  };

  const manifest = readManifest(dataDir);
  const languages = parseLanguages(flags.get("--languages")).filter((language) => {
    const prepared = manifest.languages.some((l) => l.language === language);
    if (!prepared) say(`${language}: not in the prepared dataset, skipping`);
    return prepared;
  });
  if (languages.length === 0) throw new Error("No prepared language to run");

  const workDir = join(dataDir, "work");
  mkdirSync(workDir, { recursive: true });
  isolateEnvironment(workDir);
  const startedAt = new Date().toISOString();

  // Imported after the environment is set: the harness reads it at load.
  const { SyntheticE2EHarness } =
    await import("../../../packages/collector/src/e2e/synth-harness.js");
  const harness = new SyntheticE2EHarness({
    gatewayMode: "stable",
    universe: "e2e-minimal",
    extraGatewayConfig: GATEWAY_CONFIG,
    ...(mode === "hybrid"
      ? {
          extraInference: {
            backends: { localembed: { type: "http", url: embedderUrl } },
            assignments: { embedder: `localembed/${embedderModel}` },
          },
        }
      : {}),
  });

  const stop = async (): Promise<void> => {
    await harness.destroy();
  };
  /**
   * One request to the gateway. A dropped connection is retried: a run is
   * hours of work, and a gateway that is briefly not accepting must not end
   * it. A gateway that has gone away fails every attempt.
   */
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await harness.gatewayJson<T>(path, init);
      } catch (err) {
        const dropped = err instanceof TypeError && err.message === "fetch failed";
        if (!dropped || attempt === REQUEST_ATTEMPTS) throw err;
        say(`Request to ${path} failed (${String(err.cause ?? err.message)}); retrying`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  };
  process.once("SIGINT", () => void stop().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(143)));

  try {
    say(`Starting an isolated gateway (${mode}) from ${source.commit.slice(0, 9)}`);
    await harness.start();

    // ── ingest ────────────────────────────────────────────────────────────
    const ingestStart = Date.now();
    const passageCounts = new Map<Language, number>();
    let pushed = 0;
    for (const language of languages) {
      let batch: Array<Record<string, unknown>> = [];
      let count = 0;
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        await harness.pushDocuments(batch);
        pushed += batch.length;
        batch = [];
      };
      for await (const passage of readPassages(dataDir, language)) {
        if (count >= maxPassages) break;
        count += 1;
        batch.push({
          sourceId: SOURCE_ID,
          providerId: SOURCE_ID,
          externalId: `${language}/${passage.docid}`,
          title: passage.title,
          content: passage.text,
          metadata: { sourceUrl: passageUrl(language, passage.docid) },
          sourceCreatedAt: PASSAGE_DATE,
          sourceUpdatedAt: PASSAGE_DATE,
        });
        if (batch.length >= PUSH_BATCH) await flush();
      }
      await flush();
      passageCounts.set(language, count);
      say(`${language}: pushed ${count} passages (${pushed} total)`);
    }
    const ingestSeconds = (Date.now() - ingestStart) / 1000;

    // ── index ─────────────────────────────────────────────────────────────
    const indexStart = Date.now();
    let stats: IndexStats = {};
    let lastReport = 0;
    for (;;) {
      stats = await request<IndexStats>("/index/stats");
      const indexed = stats.totalIndexed ?? 0;
      const semanticReady = mode === "lexical" || stats.semanticSearch?.state === "ready";
      if (indexed >= pushed && semanticReady) break;
      if (Date.now() - lastReport > 60_000) {
        say(`Indexing: ${indexed}/${pushed} documents`);
        lastReport = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if ((stats.totalIndexErrors ?? 0) > 0) {
      throw new Error(`${stats.totalIndexErrors} documents failed to index; the run is not valid`);
    }
    await harness.refreshSearchSnapshot();
    const indexSeconds = (Date.now() - indexStart) / 1000;
    say(`Indexed ${pushed} documents into ${stats.totalChunks ?? 0} chunks`);

    // ── query ─────────────────────────────────────────────────────────────
    const queryStart = Date.now();
    const rows: QueryRow[] = [];
    const languageResults: LanguageResult[] = [];
    const latencies: number[] = [];
    const lexicalEngines: Record<string, number> = {};
    for (const language of languages) {
      const prefix = `miracl://${language}/`;
      const qrels = readQrels(dataDir, language);
      const queries = readQueries(dataDir, language).slice(0, maxQueries);
      const scored: QueryRow[] = [];
      let emptyResults = 0;
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < queries.length) {
          const query = queries[next]!;
          next += 1;
          const judged = qrels.get(query.id);
          const relevant = new Set(
            [...(judged ?? [])].filter(([, grade]) => grade > 0).map(([docid]) => docid),
          );
          if (relevant.size === 0) continue;
          const sent = Date.now();
          const res = await request<SearchResponse>("/search", {
            method: "POST",
            body: JSON.stringify({ text: query.text, limit: RESULT_DEPTH }),
          });
          latencies.push(Date.now() - sent);
          const engine = res.stages?.bm25?.engine ?? "none";
          lexicalEngines[engine] = (lexicalEngines[engine] ?? 0) + 1;
          const results = res.results ?? [];
          if (results.length === 0) emptyResults += 1;
          // A passage of another language is a wrong answer; keep its slot.
          const ranked = results.map((r, i) =>
            r.sourceUrl?.startsWith(prefix) ? r.sourceUrl.slice(prefix.length) : `other:${i}`,
          );
          scored.push({ language, queryId: query.id, ...scoreQuery(ranked, relevant) });
        }
      };
      await Promise.all(Array.from({ length: QUERY_CONCURRENCY }, worker));
      scored.sort((a, b) => (a.queryId < b.queryId ? -1 : 1));
      rows.push(...scored);
      const result: LanguageResult = {
        language,
        queries: scored.length,
        passages: passageCounts.get(language) ?? 0,
        emptyResults,
        ndcg10: mean(scored.map((s) => s.ndcg10)),
        recall100: mean(scored.map((s) => s.recall100)),
        mrr10: mean(scored.map((s) => s.mrr10)),
      };
      languageResults.push(result);
      say(
        `${LANGUAGE_NAMES[language].padEnd(11)} nDCG@10 ${result.ndcg10.toFixed(3)}  ` +
          `Recall@100 ${result.recall100.toFixed(3)}  (${result.queries} queries, ` +
          `${emptyResults} empty)`,
      );
    }

    const summary: RunSummary = {
      name,
      mode,
      startedAt,
      source,
      dataset: {
        name: manifest.dataset,
        poolSize: manifest.poolSize,
        revisions: manifest.revisions,
      },
      embedder: mode === "hybrid" ? embedderModel : null,
      gatewayConfig: GATEWAY_CONFIG,
      macro: {
        ndcg10: mean(languageResults.map((l) => l.ndcg10)),
        recall100: mean(languageResults.map((l) => l.recall100)),
        mrr10: mean(languageResults.map((l) => l.mrr10)),
      },
      languages: languageResults,
      totals: { passages: pushed, chunks: stats.totalChunks ?? 0, queries: rows.length },
      timing: {
        ingestSeconds: Math.round(ingestSeconds),
        indexSeconds: Math.round(indexSeconds),
        querySeconds: Math.round((Date.now() - queryStart) / 1000),
        queryMsP50: percentile(latencies, 0.5),
        queryMsP95: percentile(latencies, 0.95),
      },
      lexicalEngines,
    };
    writeRun(summary, rows);
    say(
      `Macro nDCG@10 ${summary.macro.ndcg10.toFixed(4)}  Recall@100 ` +
        `${summary.macro.recall100.toFixed(4)}  MRR@10 ${summary.macro.mrr10.toFixed(4)}`,
    );
    say(`Wrote evals/search/results/${name}.json`);
  } catch (err) {
    // The gateway's log goes with its temp directory; keep it for the post-mortem.
    const log = harness.getGatewayLogPath();
    if (existsSync(log)) {
      const kept = join(dataDir, `failed-${name}.gateway.log`);
      copyFileSync(log, kept);
      say(`The run failed; the gateway log is kept at ${kept}`);
    }
    throw err;
  } finally {
    await stop();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `npm run search-eval:run` — score the real search engine on a prepared
 * dataset.
 *
 * It boots an isolated gateway from this checkout, pushes every passage through
 * `POST /documents` into one source, waits for the indexer to finish, and sends
 * each judged question to `POST /search` once the in-memory keyword ranker
 * covers the corpus. Nothing is stubbed: chunking, the
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
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  defaultDataDir,
  LANGUAGE_NAMES,
  parseLanguages,
  passageUrl,
  poolFingerprint,
  rankedPassageIds,
  readManifest,
  readPassages,
  readQrels,
  readQueries,
  type Language,
} from "./dataset.js";
import { mean, percentile, scoreQuery } from "./metrics.js";
import {
  runExists,
  writeRun,
  type LanguageResult,
  type QueryRow,
  type RunMode,
  type RunSummary,
} from "./results.js";

const USAGE =
  "usage: search-eval:run -- --name <run-name> [--mode lexical|hybrid] [--data-dir <dir>] " +
  "[--languages ar,ko,…] [--max-passages N] [--max-queries N] [--embedder-url <loopback url>] " +
  "[--embedder-model <id>] [--allow-dirty] [--force]";
const VALUE_FLAGS = new Set([
  "--name",
  "--mode",
  "--data-dir",
  "--languages",
  "--max-passages",
  "--max-queries",
  "--embedder-url",
  "--embedder-model",
]);
const SWITCHES = new Set(["--allow-dirty", "--force"]);

const SOURCE_ID = "synthetic:search-eval";
/** Every passage gets this date, so none outranks another by recency. */
const PASSAGE_DATE = "2020-01-01T00:00:00.000Z";
const PUSH_BATCH = 500;
const QUERY_CONCURRENCY = 4;
const REQUEST_ATTEMPTS = 6;
/** Recall is measured over the first hundred results; the default pool is 50. */
const RESULT_DEPTH = 100;
/**
 * The settings a run changes from the gateway's defaults. The temporal lane is
 * off because it reads a question's dates against today's date and the
 * passages' one shared date, which would make a score depend on the day of the
 * run.
 */
const GATEWAY_CONFIG = {
  search: { params: { candidateLimit: RESULT_DEPTH }, temporal: { enabled: false } },
};
/**
 * A document only the eval's readiness probe matches. The in-memory keyword
 * ranker is rebuilt in the background after a bulk load, and until it covers
 * the corpus the gateway ranks with its FTS5 fallback; a run waits for the
 * ranker a settled install serves from.
 */
const PROBE_WORD = "omnesissearchevalprobe";
const PROBE_ANSWERS = 16;
const INDEX_STALL_MS = 30 * 60_000;
const RANKER_WAIT_MS = 90 * 60_000;

interface SearchResponse {
  results?: Array<{
    sourceUrl?: string | null;
    scoreBreakdown?: { bm25Rank?: number; vectorRank?: number };
  }>;
  stages?: { bm25?: { engine?: string } };
}
interface IndexStats {
  totalIndexed?: number;
  totalIndexErrors?: number;
  totalChunks?: number;
  bySource?: Record<string, { indexedDocs?: number; indexErrors?: number }>;
  semanticSearch?: { state?: string };
}

function say(line: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function parseArgs(argv: readonly string[]): { flags: Map<string, string>; on: Set<string> } {
  const flags = new Map<string, string>();
  const on = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (SWITCHES.has(flag)) {
      on.add(flag);
      continue;
    }
    const value = argv[i + 1];
    if (!VALUE_FLAGS.has(flag) || value === undefined) {
      throw new Error(`Unknown or incomplete argument "${flag}".\n${USAGE}`);
    }
    flags.set(flag, value);
    i += 1;
  }
  return { flags, on };
}

/** A cap flag: a positive whole number, or null when absent. */
function cap(flags: Map<string, string>, flag: string): number | null {
  const value = flags.get(flag);
  if (value === undefined) return null;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} takes a positive whole number`);
  return Number(value);
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
  const { flags, on } = parseArgs(process.argv.slice(2));
  const name = flags.get("--name");
  if (!name || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(USAGE);
  const mode = flags.get("--mode") ?? "lexical";
  if (mode !== "lexical" && mode !== "hybrid") throw new Error(USAGE);
  const runMode: RunMode = mode;
  const dataDir = flags.get("--data-dir") ?? defaultDataDir();
  const maxPassages = cap(flags, "--max-passages");
  const maxQueries = cap(flags, "--max-queries");
  const embedderUrl = flags.get("--embedder-url") ?? "http://localhost:8001";
  const embedderModel = flags.get("--embedder-model") ?? "Qwen/Qwen3-Embedding-0.6B";
  if (runMode === "hybrid" && !isLoopback(embedderUrl)) {
    throw new Error(
      `The embedder must run on this machine; ${embedderUrl} is not a loopback address`,
    );
  }
  if (runExists(name) && !on.has("--force")) {
    throw new Error(`A run named "${name}" is already recorded. Pass --force to replace it.`);
  }

  // Recorded runs and the page generated from them are the eval's output, not
  // part of what is measured, so a run may follow another before either is
  // committed.
  const dirty =
    git(
      "status",
      "--porcelain",
      "--",
      ".",
      ":(exclude)evals/search/results",
      ":(exclude)evals/search/RESULTS.md",
    ) !== "";
  if (dirty && !on.has("--allow-dirty")) {
    throw new Error(
      "The checkout has uncommitted or untracked changes, so the result could not be tied to " +
        "a commit. Commit first, or pass --allow-dirty for a throwaway run.",
    );
  }
  const source = {
    commit: git("rev-parse", "HEAD"),
    packagesTree: git("rev-parse", "HEAD:packages"),
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

  // One directory per run name: a run killed before it could clean up leaves
  // its databases here, and the next run of that name clears them.
  const workDir = join(dataDir, "work", name);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  isolateEnvironment(workDir);
  const startedAt = new Date().toISOString();

  // A dynamic import, because the harness reads the environment when it loads
  // and the lint rule against reaching into another package covers static
  // imports only. The harness is the repository's one way to boot a real
  // gateway on an isolated config directory.
  const { SyntheticE2EHarness } =
    await import("../../../packages/collector/src/e2e/synth-harness.js");
  const harness = new SyntheticE2EHarness({
    gatewayMode: "stable",
    universe: "e2e-minimal",
    extraGatewayConfig: GATEWAY_CONFIG,
    ...(runMode === "hybrid"
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
    rmSync(workDir, { recursive: true, force: true });
  };
  /**
   * One call to the gateway. A dropped connection is retried: a run is hours
   * of work, and a gateway that is briefly not accepting must not end it. A
   * gateway that has gone away fails every attempt.
   */
  const retrying = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call();
      } catch (err) {
        const dropped = err instanceof TypeError && err.message === "fetch failed";
        if (!dropped || attempt === REQUEST_ATTEMPTS) throw err;
        say(`${what} failed (${String(err.cause ?? err.message)}); retrying`);
        await sleep(10_000);
      }
    }
  };
  const search = (text: string, limit: number): Promise<SearchResponse> =>
    harness.gatewayJson<SearchResponse>("/search", {
      method: "POST",
      body: JSON.stringify({ text, limit }),
    });
  process.once("SIGINT", () => void stop().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void stop().finally(() => process.exit(143)));

  try {
    say(`Starting an isolated gateway (${runMode}) from ${source.commit.slice(0, 9)}`);
    await harness.start();

    // ── ingest ────────────────────────────────────────────────────────────
    const ingestStart = Date.now();
    const passageCounts = new Map<Language, number>();
    const push = (documents: Array<Record<string, unknown>>): Promise<void> =>
      // A repeated push is harmless: the gateway upserts on the external id.
      retrying("Pushing passages", () => harness.pushDocuments(documents));
    const document = (externalId: string, title: string, content: string, url: string) => ({
      sourceId: SOURCE_ID,
      providerId: SOURCE_ID,
      externalId,
      title,
      content,
      metadata: { sourceUrl: url },
      sourceCreatedAt: PASSAGE_DATE,
      sourceUpdatedAt: PASSAGE_DATE,
    });
    await push([document("probe", PROBE_WORD, PROBE_WORD, "miracl://probe")]);
    let pushed = 1;
    for (const language of languages) {
      let batch: Array<Record<string, unknown>> = [];
      let count = 0;
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        await push(batch);
        pushed += batch.length;
        batch = [];
      };
      for await (const passage of readPassages(dataDir, language)) {
        if (maxPassages !== null && count >= maxPassages) break;
        count += 1;
        batch.push(
          document(
            `${language}/${passage.docid}`,
            passage.title,
            passage.text,
            passageUrl(language, passage.docid),
          ),
        );
        if (batch.length >= PUSH_BATCH) await flush();
      }
      await flush();
      passageCounts.set(language, count);
      say(`${language}: pushed ${count} passages (${pushed - 1} total)`);
    }
    const ingestSeconds = (Date.now() - ingestStart) / 1000;

    // ── index ─────────────────────────────────────────────────────────────
    const indexStart = Date.now();
    let stats: IndexStats = {};
    let lastReport = 0;
    let lastIndexed = -1;
    let lastProgress = Date.now();
    for (;;) {
      stats = await retrying("Reading index progress", () =>
        harness.gatewayJson<IndexStats>("/index/stats"),
      );
      // A gateway without an embedder reports totals only.
      const mine = stats.bySource?.[SOURCE_ID];
      const indexed = stats.bySource ? (mine?.indexedDocs ?? 0) : (stats.totalIndexed ?? 0);
      const failed = stats.bySource ? (mine?.indexErrors ?? 0) : (stats.totalIndexErrors ?? 0);
      if (failed > 0) throw new Error(`${failed} passages failed to index; the run is not valid`);
      const semanticReady = runMode === "lexical" || stats.semanticSearch?.state === "ready";
      if (indexed >= pushed && semanticReady) break;
      if (indexed !== lastIndexed) {
        lastIndexed = indexed;
        lastProgress = Date.now();
      } else if (indexed < pushed && Date.now() - lastProgress > INDEX_STALL_MS) {
        throw new Error(`Indexing stopped at ${indexed} of ${pushed} documents`);
      }
      if (Date.now() - lastReport > 60_000) {
        say(`Indexing: ${indexed}/${pushed} documents`);
        lastReport = Date.now();
      }
      await sleep(3000);
    }
    await harness.refreshSearchSnapshot();
    say(`Indexed ${pushed - 1} passages into ${stats.totalChunks ?? 0} chunks`);

    // Every search worker attaches the rebuilt ranker on its own, so one
    // answer from it does not mean the next will be.
    const rankerStart = Date.now();
    for (let answers = 0; answers < PROBE_ANSWERS;) {
      const res = await retrying("Probing the keyword ranker", () => search(PROBE_WORD, 1));
      if (res.results?.[0]?.sourceUrl !== "miracl://probe") {
        throw new Error("The probe document is not searchable; the index is not complete");
      }
      if (res.stages?.bm25?.engine === "memory") {
        answers += 1;
        continue;
      }
      answers = 0;
      if (Date.now() - rankerStart > RANKER_WAIT_MS) {
        throw new Error("The in-memory keyword ranker did not come up after the bulk load");
      }
      if (Date.now() - lastReport > 60_000) {
        say("Waiting for the in-memory keyword ranker to cover the corpus");
        lastReport = Date.now();
      }
      await sleep(5000);
    }
    const indexSeconds = (Date.now() - indexStart) / 1000;

    // ── query ─────────────────────────────────────────────────────────────
    const queryStart = Date.now();
    const rows: QueryRow[] = [];
    const languageResults: LanguageResult[] = [];
    const latencies: number[] = [];
    for (const language of languages) {
      const qrels = readQrels(dataDir, language);
      const all = readQueries(dataDir, language);
      const queries = maxQueries === null ? all : all.slice(0, maxQueries);
      const scored: QueryRow[] = [];
      const lexicalEngines: Record<string, number> = {};
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
          let ms = 0;
          const res = await retrying("A search", async () => {
            const sent = Date.now();
            const answer = await search(query.text, RESULT_DEPTH);
            ms = Date.now() - sent;
            return answer;
          });
          latencies.push(ms);
          const engine = res.stages?.bm25?.engine ?? "none";
          lexicalEngines[engine] = (lexicalEngines[engine] ?? 0) + 1;
          const results = res.results ?? [];
          if (results.length === 0) emptyResults += 1;
          const ranked = rankedPassageIds(results, language);
          let bm25Rank: number | null = null;
          let vectorRank: number | null = null;
          results.forEach((result, i) => {
            if (!relevant.has(ranked[i]!)) return;
            const lanes = result.scoreBreakdown;
            if (lanes?.bm25Rank) bm25Rank = Math.min(bm25Rank ?? Infinity, lanes.bm25Rank);
            if (lanes?.vectorRank) vectorRank = Math.min(vectorRank ?? Infinity, lanes.vectorRank);
          });
          scored.push({
            language,
            queryId: query.id,
            ...scoreQuery(ranked, relevant),
            bm25Rank,
            vectorRank,
          });
        }
      };
      await Promise.all(Array.from({ length: QUERY_CONCURRENCY }, worker));
      if (scored.length === 0) throw new Error(`No ${language} question has a relevant passage`);
      scored.sort((a, b) => (a.queryId < b.queryId ? -1 : 1));
      rows.push(...scored);
      const result: LanguageResult = {
        language,
        queries: scored.length,
        passages: passageCounts.get(language) ?? 0,
        emptyResults,
        lexicalEngines,
        pool: poolFingerprint(manifest.languages.find((l) => l.language === language)!),
        hit10: mean(scored.map((s) => s.hit10)),
        ndcg10: mean(scored.map((s) => s.ndcg10)),
        recall100: mean(scored.map((s) => s.recall100)),
        mrr10: mean(scored.map((s) => s.mrr10)),
      };
      languageResults.push(result);
      say(
        `${LANGUAGE_NAMES[language].padEnd(11)} Hit@10 ${result.hit10.toFixed(3)}  ` +
          `nDCG@10 ${result.ndcg10.toFixed(3)}  ` +
          `Recall@100 ${result.recall100.toFixed(3)}  (${result.queries} queries, ` +
          `${emptyResults} empty, ${lexicalEngines.memory ?? 0} by the in-memory ranker)`,
      );
    }

    const summary: RunSummary = {
      name,
      mode: runMode,
      startedAt,
      source,
      dataset: {
        name: manifest.dataset,
        poolSize: manifest.poolSize,
        revisions: manifest.revisions,
      },
      limits: { maxPassages, maxQueries },
      embedder: runMode === "hybrid" ? embedderModel : null,
      gatewayConfig: GATEWAY_CONFIG,
      macro: {
        hit10: mean(languageResults.map((l) => l.hit10)),
        ndcg10: mean(languageResults.map((l) => l.ndcg10)),
        recall100: mean(languageResults.map((l) => l.recall100)),
        mrr10: mean(languageResults.map((l) => l.mrr10)),
      },
      languages: languageResults,
      totals: { passages: pushed - 1, chunks: stats.totalChunks ?? 0, queries: rows.length },
      timing: {
        ingestSeconds: Math.round(ingestSeconds),
        indexSeconds: Math.round(indexSeconds),
        querySeconds: Math.round((Date.now() - queryStart) / 1000),
        queryMsP50: percentile(latencies, 0.5),
        queryMsP95: percentile(latencies, 0.95),
      },
    };
    writeRun(summary, rows);
    say(
      `Macro Hit@10 ${summary.macro.hit10.toFixed(4)}  nDCG@10 ${summary.macro.ndcg10.toFixed(4)}  Recall@100 ` +
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

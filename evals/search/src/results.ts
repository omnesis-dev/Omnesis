// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The committed record of one eval run: a summary (`<name>.json`) and one row
 * per scored query (`<name>.queries.tsv`), which is what lets two runs be
 * compared query by query.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Language } from "./dataset.js";
import type { QueryScore } from "./metrics.js";

export const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "results");

/** `lexical`: no embedder, keyword search only. `hybrid`: keyword + local embeddings. */
export type RunMode = "lexical" | "hybrid";

export interface LanguageResult extends QueryScore {
  language: Language;
  /** Queries scored: those with at least one passage judged relevant. */
  queries: number;
  passages: number;
  /** Queries the search returned nothing for. */
  emptyResults: number;
  /** How many queries each keyword ranker served: `memory`, or the `fts5` fallback. */
  lexicalEngines: Record<string, number>;
  /** Fingerprint of the pool the language was scored on. */
  pool: string;
}

export interface RunSummary {
  name: string;
  mode: RunMode;
  startedAt: string;
  /** What the gateway under test was built from. */
  source: {
    commit: string;
    /** Tree of `packages/` at that commit, which a squash merge keeps. */
    packagesTree: string;
    dirty: boolean;
    branch: string;
  };
  dataset: { name: string; poolSize: number; revisions: { topics: string; corpus: string } };
  /** Caps of a partial run; both null for a full one. */
  limits: { maxPassages: number | null; maxQueries: number | null };
  /** Embedding model in `hybrid` mode. */
  embedder: string | null;
  /** Settings the run changes from the gateway's defaults. */
  gatewayConfig: Record<string, unknown>;
  /** Each language weighted equally. */
  macro: QueryScore;
  languages: LanguageResult[];
  totals: { passages: number; chunks: number; queries: number };
  timing: {
    ingestSeconds: number;
    indexSeconds: number;
    querySeconds: number;
    queryMsP50: number;
    queryMsP95: number;
  };
}

export interface QueryRow extends QueryScore {
  language: Language;
  queryId: string;
  /**
   * Best rank any returned relevant passage holds in the keyword lane's own
   * list, before fusion; null when none is in that list.
   */
  bm25Rank: number | null;
  /** The same for the semantic lane; always null in a `lexical` run. */
  vectorRank: number | null;
}

const QUERY_HEADER = "language\tquery\thit10\tndcg10\trecall100\tmrr10\tbm25Rank\tvectorRank";

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function writeRun(summary: RunSummary, rows: readonly QueryRow[], dir = RESULTS_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${summary.name}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  const lines = rows.map(
    (r) =>
      `${r.language}\t${r.queryId}\t${r.hit10}\t${round(r.ndcg10)}\t${round(r.recall100)}\t${round(r.mrr10)}\t${r.bm25Rank ?? ""}\t${r.vectorRank ?? ""}`,
  );
  writeFileSync(
    join(dir, `${summary.name}.queries.tsv`),
    `${[QUERY_HEADER, ...lines].join("\n")}\n`,
  );
}

export function runExists(name: string, dir = RESULTS_DIR): boolean {
  return existsSync(join(dir, `${name}.json`));
}

export function listRuns(dir = RESULTS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

export function readSummary(name: string, dir = RESULTS_DIR): RunSummary {
  const path = join(dir, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`No run named "${name}". Known runs: ${listRuns(dir).join(", ") || "none"}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as RunSummary;
}

export function readQueryRows(name: string, dir = RESULTS_DIR): QueryRow[] {
  const lines = readFileSync(join(dir, `${name}.queries.tsv`), "utf8")
    .split("\n")
    .filter(Boolean);
  return lines.slice(1).map((line) => {
    const [language, queryId, hit10, ndcg10, recall100, mrr10, bm25Rank, vectorRank] =
      line.split("\t");
    return {
      language: language as Language,
      queryId: queryId!,
      hit10: Number(hit10),
      ndcg10: Number(ndcg10),
      recall100: Number(recall100),
      mrr10: Number(mrr10),
      bm25Rank: bm25Rank ? Number(bm25Rank) : null,
      vectorRank: vectorRank ? Number(vectorRank) : null,
    };
  });
}

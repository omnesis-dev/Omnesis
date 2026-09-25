// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { hostname, platform, arch, cpus, totalmem } from "node:os";
import { assertionsHeld, mean, median, percentile, scoreQuery } from "./metrics.js";
import { events } from "./progress.js";
import type { ProgressEmitter } from "./progress.js";
import type {
  Difficulty,
  QueryMetrics,
  QueryResult,
  QueryRunResult,
  QueryType,
  RetrievedDoc,
  RunOutput,
  RunSummary,
  StageCandidates,
  StageTimings,
  Suite,
  SuiteQuery,
} from "./types.js";

/** Result returned from a single `/search` call. The runner consumes only the load-bearing fields. */
export interface SearchResponseLite {
  results: Array<{
    documentId: string;
    sourceUrl?: string;
    sourceId?: string;
    score?: number;
    /** Full ScoreBreakdown from the search pipeline — bm25 rank, vector rank, RRF, bonuses, boosts. */
    scoreBreakdown?: Record<string, number | undefined>;
    title?: string;
    chunkText?: string;
    documentType?: string;
  }>;
  query?: {
    original?: string;
    effectiveText?: string;
  };
  timing: {
    totalMs: number;
    bm25Ms?: number;
    vectorMs?: number;
    bm25Candidates?: number;
    vectorCandidates?: number;
  };
  stages?: Record<string, unknown>;
  debug?: {
    modelState?: { vector?: "ready" | "unavailable" };
    query?: {
      inputLength?: number;
    };
  };
}

export interface SearchClient {
  search(req: { text: string; limit: number; verbose: boolean }): Promise<SearchResponseLite>;
  getSystemSnapshot(): Promise<SystemSnapshot>;
}

export interface SystemSnapshot {
  gateway: { url: string; version?: string; git_sha?: string };
  search_config: unknown;
  index_snapshot: {
    document_count?: number;
    embedding_count?: number;
    db_size_bytes?: number;
  };
}

/**
 * Transient-failure retry policy for search calls. A failed call (network
 * blip, rate-limit 429, 5xx) is retried with exponential backoff up to
 * `attempts` times; only if every attempt fails is the query recorded as a
 * measurement failure rather than a zero-result query.
 */
export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseDelayMs: 250 };

/** Upper bound on a single exponential-backoff wait between retries. */
const RETRY_MAX_BACKOFF_MS = 4_000;

export interface RunOptions {
  suite: Suite;
  resolvedDocIdGroups: string[][][];
  repeats: number;
  /** Override the transient-failure retry policy (tests use a fast one). */
  retry?: RetryPolicy;
  /**
   * Pre-bench warmup. When > 0, the runner makes this many untimed
   * search calls before the timed bench begins, using the first
   * `warmupQueries` queries from the suite (cycled if N exceeds the suite
   * size). Use this to amortize cold model loads — the first call pays the
   * embedder's load cost, which otherwise lands inside the timed results
   * for whichever query happened to go first.
   */
  warmupQueries?: number;
  client: SearchClient;
  progress: ProgressEmitter;
}

/**
 * Run an eval suite end-to-end. Each query is searched once on the single
 * search pipeline:
 *   1. One warmup call (untimed, used to seed caches).
 *   2. N timed repeats — the LAST run's results are scored, the median
 *      of all `total_ms` is reported as `latency_ms`.
 *
 * The runner is pure orchestration; persistence is the caller's job
 * (CLI writes `RunOutput` JSON to disk).
 */
export async function runBench(opts: RunOptions): Promise<RunOutput> {
  const { suite, resolvedDocIdGroups, repeats, client, progress } = opts;
  const warmupQueries = opts.warmupQueries ?? 0;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const runId = makeRunId();
  const startedAt = new Date();
  const runStart = Date.now();

  const snapshot = await client.getSystemSnapshot();

  progress.emit(events.runStarted(runId, suite.queries.length));

  if (warmupQueries > 0) {
    await runWarmup({ suite, warmupQueries, client, progress, retry });
  }

  const queries: QueryResult[] = [];
  const failedQueries: Array<{ query_id: string }> = [];
  for (let i = 0; i < suite.queries.length; i++) {
    const q = suite.queries[i]!;
    const groups = resolvedDocIdGroups[i] ?? [];
    progress.emit(events.queryStarted(i, q.id));
    const queryStartMs = Date.now();

    const { result, failed } = await runOneQuery({ query: q, repeats, groups, client, retry });
    if (failed) failedQueries.push({ query_id: q.id });

    queries.push({
      id: q.id,
      query_text: q.query,
      type: q.type,
      difficulty: q.difficulty,
      notes: q.notes,
      expected_url_groups: q.expectedDocs.map((d) => d.urls),
      resolved_doc_id_groups: groups,
      unexpected_urls: q.unexpectedUrls,
      must_rank_above: q.mustRankAbove,
      result,
    });

    const elapsedMs = Date.now() - queryStartMs;
    progress.emit(events.queryCompleted(i, q.id, elapsedMs));
  }

  const completedAt = new Date();
  const durationMs = Date.now() - runStart;
  progress.emit(events.runCompleted(runId, durationMs));

  return {
    run_id: runId,
    fixture_path: suite.sourcePath,
    fixture_sha256: suite.sha256,
    gateway: snapshot.gateway,
    machine: buildMachineSnapshot(),
    search_config: snapshot.search_config,
    index_snapshot: snapshot.index_snapshot,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: durationMs,
    repeats,
    queries,
    failed_queries: failedQueries.length > 0 ? failedQueries : undefined,
    summary: buildSummary(queries, new Set(failedQueries.map((f) => f.query_id))),
  };
}

/**
 * Pre-bench warmup. Untimed, not scored — its job is to absorb the cold
 * embedder load so the first scored query doesn't carry a one-time tax, and
 * so the cold-load cost is amortized across all subsequent timed queries.
 */
async function runWarmup(args: {
  suite: Suite;
  warmupQueries: number;
  client: SearchClient;
  progress: ProgressEmitter;
  retry: RetryPolicy;
}): Promise<void> {
  const { suite, warmupQueries, client, progress, retry } = args;
  const start = Date.now();
  progress.emit(events.warmupStarted(warmupQueries));
  for (let i = 0; i < warmupQueries; i++) {
    const q = suite.queries[i % suite.queries.length]!;
    await safeSearch(client, { text: q.query, limit: Math.max(q.topK, 10), verbose: true }, retry);
  }
  progress.emit(events.warmupCompleted(Date.now() - start));
}

async function runOneQuery(args: {
  query: SuiteQuery;
  repeats: number;
  groups: string[][];
  client: SearchClient;
  retry: RetryPolicy;
}): Promise<{ result: QueryRunResult; failed: boolean }> {
  const { query, repeats, groups, client, retry } = args;
  const limit = Math.max(query.topK, 10);

  // Warmup (untimed). Catches cold model loads etc. so the first timed
  // run is on a warm cache. Failure is logged through the response
  // (zero results) but doesn't abort the bench — the gateway degrades
  // gracefully when a pipeline stage is unavailable.
  const warmupStart = Date.now();
  await safeSearch(client, { text: query.query, limit, verbose: true }, retry);
  const warmupMs = Date.now() - warmupStart;

  const repeatRuns: Array<{ total_ms: number; warmup: boolean }> = [
    { total_ms: warmupMs, warmup: true },
  ];

  let lastResponse: SearchResponseLite | null = null;
  let anyTimedFailed = false;
  const timedMs: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const start = Date.now();
    const { resp, failed } = await safeSearch(
      client,
      { text: query.query, limit, verbose: true },
      retry,
    );
    const elapsed = Date.now() - start;
    timedMs.push(elapsed);
    repeatRuns.push({ total_ms: elapsed, warmup: false });
    lastResponse = resp;
    if (failed) anyTimedFailed = true;
  }

  const retrieved: RetrievedDoc[] = (lastResponse?.results ?? []).map((r, idx) => ({
    rank: idx + 1,
    document_id: r.documentId,
    source_url: r.sourceUrl,
    source_id: r.sourceId,
    score: r.score,
    score_breakdown: r.scoreBreakdown,
    title: r.title,
    chunk_text: r.chunkText,
    document_type: r.documentType,
  }));

  const latencyMs = median(timedMs);
  const scored = scoreQuery(retrieved, groups, latencyMs);
  const stageTimings = extractStageTimings(lastResponse);
  const stageCandidates = extractStageCandidates(lastResponse);

  // The assertions object is computed for future surfacing; v1 doesn't
  // promote it to a hard run failure but does record it on the
  // QueryRunResult-side metric block via best_rank.
  void assertionsHeld(query, scored.best_rank);

  const modelState = lastResponse?.debug?.modelState;
  const debugQuery = lastResponse?.debug?.query;
  const result: QueryRunResult = {
    retrieved,
    metrics: {
      hit_at_1: scored.hit_at_1,
      hit_at_5: scored.hit_at_5,
      hit_at_10: scored.hit_at_10,
      recall_at_10: scored.recall_at_10,
      mrr: scored.mrr,
      latency_ms: scored.latency_ms,
      recall_at_k: scored.recall_at_k,
      context_tokens_to_hit: scored.context_tokens_to_hit,
      context_tokens_at_10: scored.context_tokens_at_10,
    },
    stage_timings: stageTimings,
    stage_candidates: stageCandidates,
    repeats: repeatRuns,
    model_state: modelState
      ? {
          vector: modelState.vector,
        }
      : undefined,
    query_lengths: debugQuery
      ? {
          input: debugQuery.inputLength ?? query.query.length,
        }
      : undefined,
    hit_any: scored.hit_any,
    best_rank: scored.best_rank,
  };
  return { result, failed: anyTimedFailed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Issue a search, retrying transient failures (network blips, rate-limit
 * 429s, 5xx) with exponential backoff. Returns `failed: true` only after
 * every attempt is exhausted. The caller records that as a measurement
 * FAILURE — never as a legitimate zero-result query — so a contaminated run
 * can't masquerade as a run full of misses (the silent-`catch`-as-empty trap
 * that hid a whole rate-limited tail of a run before this existed).
 */
async function safeSearch(
  client: SearchClient,
  req: { text: string; limit: number; verbose: boolean },
  retry: RetryPolicy,
): Promise<{ resp: SearchResponseLite; failed: boolean }> {
  const attempts = Math.max(1, retry.attempts);
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return { resp: await client.search(req), failed: false };
    } catch {
      if (attempt < attempts - 1) {
        await sleep(Math.min(retry.baseDelayMs * 2 ** attempt, RETRY_MAX_BACKOFF_MS));
      }
    }
  }
  return { resp: { results: [], timing: { totalMs: 0 } }, failed: true };
}

function extractStageTimings(resp: SearchResponseLite | null): StageTimings {
  const t = resp?.timing;
  if (!t) return { total_ms: 0 };
  const stages = (resp?.stages ?? {}) as Record<
    string,
    { durationMs?: number; embedMs?: number; sqlMs?: number }
  >;
  return {
    total_ms: t.totalMs,
    bm25_ms: t.bm25Ms,
    vector_ms: t.vectorMs,
    vector_embed_ms: stages["vector"]?.embedMs,
    vector_sql_ms: stages["vector"]?.sqlMs,
    fusion_ms: stages["fusion"]?.durationMs,
    boost_ms: stages["boost"]?.durationMs,
    ref_count_ms: stages["refCount"]?.durationMs,
  };
}

function extractStageCandidates(resp: SearchResponseLite | null): StageCandidates {
  const t = resp?.timing;
  const stages = (resp?.stages ?? {}) as Record<string, { resultCount?: number }>;
  return {
    bm25: t?.bm25Candidates,
    vector: t?.vectorCandidates,
    fused: stages["fusion"]?.resultCount,
  };
}

function buildSummary(
  queries: QueryResult[],
  failedSet: ReadonlySet<string>,
): RunOutput["summary"] {
  const overall = aggregate(queries, failedSet);

  const byTypeKeys = new Set<QueryType>(
    queries.map((q) => q.type).filter((t): t is QueryType => !!t),
  );
  const byType: Record<string, RunSummary> = {};
  for (const t of byTypeKeys) {
    byType[t] = aggregate(
      queries.filter((q) => q.type === t),
      failedSet,
    );
  }

  const byDifficultyKeys = new Set<Difficulty>(
    queries.map((q) => q.difficulty).filter((d): d is Difficulty => !!d),
  );
  const byDifficulty: Record<string, RunSummary> = {};
  for (const d of byDifficultyKeys) {
    byDifficulty[d] = aggregate(
      queries.filter((q) => q.difficulty === d),
      failedSet,
    );
  }

  return {
    overall,
    by_type: byTypeKeys.size > 0 ? byType : undefined,
    by_difficulty: byDifficultyKeys.size > 0 ? byDifficulty : undefined,
  };
}

function aggregate(queries: QueryResult[], failedSet: ReadonlySet<string>): RunSummary {
  const metrics: QueryMetrics[] = [];
  const stageTimings: StageTimings[] = [];
  for (const q of queries) {
    // A query whose search call ultimately failed is recorded in
    // `failed_queries` (a measurement gap) — exclude it from the means so a
    // rate-limited/transient failure doesn't depress recall as if it were a
    // genuine miss. `query_count` then reflects scored queries only.
    if (failedSet.has(q.id)) continue;
    metrics.push(q.result.metrics);
    stageTimings.push(q.result.stage_timings);
  }
  return {
    hit_at_1_mean: mean(metrics.map((m) => m.hit_at_1)),
    hit_at_5_mean: mean(metrics.map((m) => m.hit_at_5)),
    hit_at_10_mean: mean(metrics.map((m) => m.hit_at_10)),
    recall_at_10_mean: mean(metrics.map((m) => m.recall_at_10)),
    mrr_mean: mean(metrics.map((m) => m.mrr)),
    latency_p50: percentile(
      metrics.map((m) => m.latency_ms),
      50,
    ),
    latency_p95: percentile(
      metrics.map((m) => m.latency_ms),
      95,
    ),
    latency_p99: percentile(
      metrics.map((m) => m.latency_ms),
      99,
    ),
    stage_latency_p50: stagePercentiles(stageTimings, 50),
    query_count: metrics.length,
    context_tokens_to_hit_mean: meanOfHits(metrics.map((m) => m.context_tokens_to_hit)),
  };
}

/** Mean over the non-null entries (queries that hit); null when none hit. */
function meanOfHits(values: Array<number | null | undefined>): number | null {
  const hits = values.filter((v): v is number => v != null);
  return hits.length > 0 ? mean(hits) : null;
}

function stagePercentiles(ts: StageTimings[], p: number): StageTimings {
  const pick = (key: keyof StageTimings) =>
    percentile(
      ts.map((t) => t[key]).filter((v): v is number => typeof v === "number"),
      p,
    );
  return {
    total_ms: pick("total_ms"),
    bm25_ms: pick("bm25_ms"),
    vector_ms: pick("vector_ms"),
    vector_embed_ms: pick("vector_embed_ms"),
    vector_sql_ms: pick("vector_sql_ms"),
    fusion_ms: pick("fusion_ms"),
    boost_ms: pick("boost_ms"),
    ref_count_ms: pick("ref_count_ms"),
  };
}

function makeRunId(): string {
  const d = new Date();
  const iso = d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${iso}_${rand}`;
}

function buildMachineSnapshot(): RunOutput["machine"] {
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpu_count: cpus().length,
    total_ram_bytes: totalmem(),
  };
}

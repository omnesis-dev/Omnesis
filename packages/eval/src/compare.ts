// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { QueryResult, RunOutput, RunSummary } from "./types.js";

/** Per-metric delta for one query. b - a; positive = improvement except latency. */
export interface MetricDelta {
  hit_at_1: number;
  hit_at_5: number;
  hit_at_10: number;
  recall_at_10: number;
  mrr: number;
  latency_ms: number;
  best_rank_a: number | null;
  best_rank_b: number | null;
}

export interface QueryDelta {
  query_id: string;
  query_text: string;
  type?: string;
  difficulty?: string;
  metrics: MetricDelta;
}

export interface SummaryDelta {
  hit_at_1_mean: number;
  hit_at_5_mean: number;
  hit_at_10_mean: number;
  recall_at_10_mean: number;
  mrr_mean: number;
  latency_p50: number;
  latency_p95: number;
  latency_p99: number;
  /**
   * Delta in mean context-token cost to surface the answer (b - a). Negative
   * means run B reached the answer in *fewer* context tokens — the win
   * condition for a retrieval change in an agent pipeline. `null` when either
   * run lacked the metric (pre-existing runs) or had no hits.
   */
  context_tokens_to_hit_mean: number | null;
}

export interface CompareReport {
  run_a: { run_id: string; path?: string };
  run_b: { run_id: string; path?: string };
  fixture_match: boolean;
  /** Per-query metric deltas, only for queries present in both runs. */
  queries: QueryDelta[];
  /** Overall summary delta across the whole judged set. */
  overall: SummaryDelta;
  /** Queries dropped (present in only one side). */
  only_in_a: string[];
  only_in_b: string[];
}

/**
 * Pure diff. Two runs against the same fixture (recommended — we warn if
 * sha256 mismatches), comparing per-query and aggregate metrics. Sign
 * convention: `b - a` for everything; positive means run B improved
 * relative to run A — *except for latency*, where positive means run B
 * got slower. Callers render with explicit "↑ improved / ↓ regressed"
 * arrows that flip on latency.
 */
export function compareRuns(
  a: RunOutput,
  b: RunOutput,
  paths?: { a?: string; b?: string },
): CompareReport {
  const aQueriesById = new Map(a.queries.map((q) => [q.id, q]));
  const bQueriesById = new Map(b.queries.map((q) => [q.id, q]));

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  for (const id of aQueriesById.keys()) {
    if (!bQueriesById.has(id)) onlyInA.push(id);
  }
  for (const id of bQueriesById.keys()) {
    if (!aQueriesById.has(id)) onlyInB.push(id);
  }

  const queries: QueryDelta[] = [];
  for (const id of aQueriesById.keys()) {
    const aq = aQueriesById.get(id)!;
    const bq = bQueriesById.get(id);
    if (!bq) continue;
    queries.push(buildQueryDelta(aq, bq));
  }

  return {
    run_a: { run_id: a.run_id, path: paths?.a },
    run_b: { run_id: b.run_id, path: paths?.b },
    fixture_match: a.fixture_sha256 === b.fixture_sha256,
    queries,
    overall: diffSummary(a.summary.overall, b.summary.overall),
    only_in_a: onlyInA,
    only_in_b: onlyInB,
  };
}

function buildQueryDelta(aq: QueryResult, bq: QueryResult): QueryDelta {
  const ar = aq.result;
  const br = bq.result;
  return {
    query_id: aq.id,
    query_text: aq.query_text,
    type: aq.type,
    difficulty: aq.difficulty,
    metrics: {
      hit_at_1: br.metrics.hit_at_1 - ar.metrics.hit_at_1,
      hit_at_5: br.metrics.hit_at_5 - ar.metrics.hit_at_5,
      hit_at_10: br.metrics.hit_at_10 - ar.metrics.hit_at_10,
      recall_at_10: br.metrics.recall_at_10 - ar.metrics.recall_at_10,
      mrr: br.metrics.mrr - ar.metrics.mrr,
      latency_ms: br.metrics.latency_ms - ar.metrics.latency_ms,
      best_rank_a: ar.best_rank,
      best_rank_b: br.best_rank,
    },
  };
}

function diffSummary(a: RunSummary, b: RunSummary): SummaryDelta {
  return {
    hit_at_1_mean: b.hit_at_1_mean - a.hit_at_1_mean,
    hit_at_5_mean: b.hit_at_5_mean - a.hit_at_5_mean,
    hit_at_10_mean: b.hit_at_10_mean - a.hit_at_10_mean,
    recall_at_10_mean: b.recall_at_10_mean - a.recall_at_10_mean,
    mrr_mean: b.mrr_mean - a.mrr_mean,
    latency_p50: b.latency_p50 - a.latency_p50,
    latency_p95: b.latency_p95 - a.latency_p95,
    latency_p99: b.latency_p99 - a.latency_p99,
    context_tokens_to_hit_mean:
      a.context_tokens_to_hit_mean != null && b.context_tokens_to_hit_mean != null
        ? b.context_tokens_to_hit_mean - a.context_tokens_to_hit_mean
        : null,
  };
}

/**
 * Pick out queries whose hit@10 or recall@10 regressed (B < A), for the
 * human-readable "regressions" section of the compare report. Latency
 * regressions are intentionally separate — they don't gate "did search get
 * worse" for quality.
 */
export function pickRegressions(report: CompareReport): QueryDelta[] {
  return report.queries.filter(
    (q) => q.metrics.hit_at_10 < 0 || q.metrics.recall_at_10 < -1e-9 || q.metrics.mrr < -1e-9,
  );
}

export function pickImprovements(report: CompareReport): QueryDelta[] {
  return report.queries.filter(
    (q) => q.metrics.hit_at_10 > 0 || q.metrics.recall_at_10 > 1e-9 || q.metrics.mrr > 1e-9,
  );
}

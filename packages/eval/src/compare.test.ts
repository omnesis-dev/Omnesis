// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { compareRuns, pickRegressions, pickImprovements } from "./compare.js";
import type { QueryResult, QueryRunResult, RunOutput } from "./types.js";

function queryRunResult(p: {
  hit1?: number;
  recall?: number;
  mrr?: number;
  latency?: number;
  rank?: number | null;
}): QueryRunResult {
  return {
    retrieved: [],
    metrics: {
      hit_at_1: p.hit1 ?? 0,
      hit_at_5: p.hit1 ?? 0,
      hit_at_10: p.hit1 ?? 0,
      recall_at_10: p.recall ?? 0,
      mrr: p.mrr ?? 0,
      latency_ms: p.latency ?? 100,
    },
    stage_timings: { total_ms: p.latency ?? 100 },
    stage_candidates: {},
    repeats: [],
    hit_any: (p.hit1 ?? 0) > 0,
    best_rank: p.rank ?? null,
  };
}

function makeRun(
  id: string,
  queries: Array<{ id: string; result: QueryRunResult; type?: string }>,
): RunOutput {
  return {
    run_id: id,
    fixture_path: "/tmp/x.yaml",
    fixture_sha256: "0".repeat(64),
    gateway: { url: "http://localhost" },
    machine: { hostname: "h", platform: "darwin", arch: "arm64", cpu_count: 1, total_ram_bytes: 1 },
    search_config: null,
    index_snapshot: {},
    started_at: "2026-05-12T14:00:00Z",
    completed_at: "2026-05-12T14:01:00Z",
    duration_ms: 60000,
    repeats: 1,
    queries: queries.map<QueryResult>((q) => ({
      id: q.id,
      query_text: q.id,
      type: q.type as QueryResult["type"],
      expected_url_groups: [["https://x/a"]],
      resolved_doc_id_groups: [["doc-a"]],
      unexpected_urls: [],
      result: q.result,
    })),
    summary: {
      overall: {
        hit_at_1_mean: avg(queries.map((q) => q.result.metrics.hit_at_1)),
        hit_at_5_mean: avg(queries.map((q) => q.result.metrics.hit_at_5)),
        hit_at_10_mean: avg(queries.map((q) => q.result.metrics.hit_at_10)),
        recall_at_10_mean: avg(queries.map((q) => q.result.metrics.recall_at_10)),
        mrr_mean: avg(queries.map((q) => q.result.metrics.mrr)),
        latency_p50: avg(queries.map((q) => q.result.metrics.latency_ms)),
        latency_p95: avg(queries.map((q) => q.result.metrics.latency_ms)),
        latency_p99: avg(queries.map((q) => q.result.metrics.latency_ms)),
        stage_latency_p50: { total_ms: 0 },
        query_count: queries.length,
      },
    },
  };
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

describe("compareRuns", () => {
  it("computes b - a per metric per query", () => {
    const a = makeRun("a", [
      { id: "q1", result: queryRunResult({ hit1: 1, mrr: 1, latency: 100, rank: 1 }) },
    ]);
    const b = makeRun("b", [
      { id: "q1", result: queryRunResult({ hit1: 0, mrr: 0, latency: 50, rank: null }) },
    ]);
    const r = compareRuns(a, b);
    const d = r.queries[0]!.metrics;
    expect(d.hit_at_1).toBe(-1);
    expect(d.mrr).toBe(-1);
    expect(d.latency_ms).toBe(-50);
    expect(d.best_rank_a).toBe(1);
    expect(d.best_rank_b).toBeNull();
    expect(r.overall.hit_at_1_mean).toBe(-1);
    expect(r.fixture_match).toBe(true);
  });

  it("flags only_in_a / only_in_b queries", () => {
    const a = makeRun("a", [
      { id: "q1", result: queryRunResult({}) },
      { id: "q2", result: queryRunResult({}) },
    ]);
    const b = makeRun("b", [
      { id: "q2", result: queryRunResult({}) },
      { id: "q3", result: queryRunResult({}) },
    ]);
    const r = compareRuns(a, b);
    expect(r.only_in_a).toEqual(["q1"]);
    expect(r.only_in_b).toEqual(["q3"]);
    expect(r.queries).toHaveLength(1);
  });

  it("pickRegressions surfaces queries where quality dropped", () => {
    const a = makeRun("a", [
      { id: "q1", result: queryRunResult({ hit1: 1, mrr: 1 }) },
      { id: "q2", result: queryRunResult({ hit1: 1, mrr: 1 }) },
    ]);
    const b = makeRun("b", [
      { id: "q1", result: queryRunResult({ hit1: 0, mrr: 0 }) },
      { id: "q2", result: queryRunResult({ hit1: 1, mrr: 1 }) },
    ]);
    const r = compareRuns(a, b);
    expect(pickRegressions(r)).toHaveLength(1);
    expect(pickRegressions(r)[0]!.query_id).toBe("q1");
    expect(pickImprovements(r)).toHaveLength(0);
  });

  it("flags fixture_sha256 mismatch", () => {
    const a = makeRun("a", [{ id: "q1", result: queryRunResult({}) }]);
    const b = makeRun("b", [{ id: "q1", result: queryRunResult({}) }]);
    (b as RunOutput).fixture_sha256 = "1".repeat(64);
    expect(compareRuns(a, b).fixture_match).toBe(false);
  });
});

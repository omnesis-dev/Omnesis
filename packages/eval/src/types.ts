// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";

// Categorical labels used to slice metrics in reports. Optional on every query.
export const QueryType = z.enum(["exact", "semantic", "topical", "cross-domain", "alias"]);
export type QueryType = z.infer<typeof QueryType>;

export const Difficulty = z.enum(["easy", "medium", "hard"]);
export type Difficulty = z.infer<typeof Difficulty>;

// One entry in `expected_urls`: either a bare URL string (one document, one
// URL form) or an aliases group (one document, several equivalent URL forms).
const ExpectedDocEntry = z.union([
  z.string().min(1),
  z.object({ aliases: z.array(z.string().min(1)).nonempty() }).strict(),
]);

// Raw suite query as it appears in YAML, before normalization. Validation
// of the "exactly one of expected_url / expected_urls" invariant happens in
// suite.ts (Phase 3) so errors can name the offending query id.
export const SuiteQueryRaw = z
  .object({
    id: z.string().min(1),
    query: z.string().min(1),
    expected_url: z.string().min(1).optional(),
    expected_urls: z.array(ExpectedDocEntry).nonempty().optional(),
    type: QueryType.optional(),
    difficulty: Difficulty.optional(),
    notes: z.string().optional(),
    top_k: z.number().int().positive().optional(),
    must_rank_above: z.number().int().positive().optional(),
    unexpected_urls: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type SuiteQueryRaw = z.infer<typeof SuiteQueryRaw>;

export const SuiteRaw = z
  .object({
    description: z.string(),
    version: z.literal(1),
    default_top_k: z.number().int().positive().default(10),
    queries: z.array(SuiteQueryRaw).nonempty(),
  })
  .strict();
export type SuiteRaw = z.infer<typeof SuiteRaw>;

// Normalized runtime form. One ExpectedDoc represents one ground-truth
// document; `urls` lists its equivalent URL forms (length >= 1).
export interface ExpectedDoc {
  urls: string[];
}

export interface SuiteQuery {
  id: string;
  query: string;
  expectedDocs: ExpectedDoc[];
  unexpectedUrls: string[];
  type?: QueryType;
  difficulty?: Difficulty;
  notes?: string;
  topK: number;
  mustRankAbove?: number;
}

export interface Suite {
  description: string;
  version: 1;
  defaultTopK: number;
  queries: SuiteQuery[];
  sourcePath: string;
  sha256: string;
}

// --- Run output ----------------------------------------------------------

// Metrics for a single query. Binary relevance: a doc "hits" if any of its
// alias URLs appears in the top-k. recall_at_10 is the fraction of distinct
// ground-truth docs hit within top-10.
export const QueryMetrics = z.object({
  hit_at_1: z.number(),
  hit_at_5: z.number(),
  hit_at_10: z.number(),
  recall_at_10: z.number(),
  mrr: z.number(),
  latency_ms: z.number(),
  /**
   * Recall@k curve — fraction of expected-doc groups hit within the top-k —
   * for a fixed set of cut-offs (1, 3, 5, 10, 20). `recall_at_10` above is the
   * same value at k=10. The curve is what makes "how small a k still finds the
   * answer" measurable, which is the agent-relevant question: an agent feeds
   * the top-k snippets into its context and re-judges them, so the lever that
   * matters is whether the answer is *in* the window, not its exact ordinal.
   * Optional for back-compat with runs recorded before this field existed.
   */
  recall_at_k: z.record(z.string(), z.number()).optional(),
  /**
   * Context-token cost the consumer pays to have the answer in front of it:
   * the summed token cost of every retrieved snippet ranked at-or-above the
   * first matching expected doc (`null` when nothing matched). Tokens are a
   * `chars/4` proxy over each result's `chunk_text` — the same cheap proxy
   * the `query_lengths` field uses. This is the key metric for an agent
   * consumer: the goal is "same recall at fewer context tokens", and this
   * number drops when a change promotes the answer toward the top.
   */
  context_tokens_to_hit: z.number().nullable().optional(),
  /**
   * Total context-token cost of feeding the top-10 snippets (the fixed
   * window budget), as a `chars/4` proxy over `chunk_text`. Lets a comparator
   * report "recall@k per context token" across two runs.
   */
  context_tokens_at_10: z.number().optional(),
});
export type QueryMetrics = z.infer<typeof QueryMetrics>;

export const StageTimings = z.object({
  total_ms: z.number(),
  bm25_ms: z.number().optional(),
  vector_ms: z.number().optional(),
  vector_embed_ms: z.number().optional(),
  vector_sql_ms: z.number().optional(),
  fusion_ms: z.number().optional(),
  boost_ms: z.number().optional(),
  ref_count_ms: z.number().optional(),
});
export type StageTimings = z.infer<typeof StageTimings>;

export const StageCandidates = z.object({
  bm25: z.number().optional(),
  vector: z.number().optional(),
  fused: z.number().optional(),
});
export type StageCandidates = z.infer<typeof StageCandidates>;

export const RetrievedDoc = z.object({
  rank: z.number().int().positive(),
  document_id: z.string(),
  source_url: z.string().optional(),
  source_id: z.string().optional(),
  score: z.number().optional(),
  /**
   * Full score breakdown from the search pipeline (bm25 rank, vector rank,
   * RRF score, rank bonus, temporal/type/relevance boosts, final score).
   * Captured verbatim from the gateway response so `omnesis eval show` can
   * explain why a doc ended up at the rank it did.
   */
  score_breakdown: z.record(z.string(), z.number().optional()).optional(),
  /** Doc title — useful for human inspection when debugging a miss. */
  title: z.string().optional(),
  /** First retrieved chunk's text (truncated by the gateway). */
  chunk_text: z.string().optional(),
  document_type: z.string().optional(),
});
export type RetrievedDoc = z.infer<typeof RetrievedDoc>;

export const RepeatRun = z.object({
  total_ms: z.number(),
  warmup: z.boolean(),
});

/** Everything measured for one judged query on the single search pipeline. */
export const QueryRunResult = z.object({
  retrieved: z.array(RetrievedDoc),
  metrics: QueryMetrics,
  stage_timings: StageTimings,
  stage_candidates: StageCandidates,
  repeats: z.array(RepeatRun),
  model_state: z
    .object({
      vector: z.enum(["ready", "cold", "unavailable"]).optional(),
    })
    .optional(),
  /**
   * Best-effort character-length stat for the query as issued — what the
   * gateway's verbose debug block exposes. Cheap proxy for token cost when
   * comparing two runs of the same query.
   */
  query_lengths: z
    .object({
      input: z.number(),
    })
    .optional(),
  // True if any retrieved doc matched any expected_url for this query.
  hit_any: z.boolean(),
  // Rank of the best-matched expected doc, 1-indexed, or null if none hit.
  best_rank: z.number().int().positive().nullable(),
});
export type QueryRunResult = z.infer<typeof QueryRunResult>;

export const QueryResult = z.object({
  id: z.string(),
  query_text: z.string(),
  type: QueryType.optional(),
  difficulty: Difficulty.optional(),
  notes: z.string().optional(),
  // The expected URL set as alias groups: outer = distinct docs, inner = alias URLs.
  expected_url_groups: z.array(z.array(z.string())),
  // Resolved documentIds per alias group, parallel to expected_url_groups.
  // Empty inner array = doc not found in index at suite-load time.
  resolved_doc_id_groups: z.array(z.array(z.string())),
  unexpected_urls: z.array(z.string()),
  must_rank_above: z.number().int().positive().optional(),
  result: QueryRunResult,
});
export type QueryResult = z.infer<typeof QueryResult>;

export const RunSummary = z.object({
  hit_at_1_mean: z.number(),
  hit_at_5_mean: z.number(),
  hit_at_10_mean: z.number(),
  recall_at_10_mean: z.number(),
  mrr_mean: z.number(),
  latency_p50: z.number(),
  latency_p95: z.number(),
  latency_p99: z.number(),
  stage_latency_p50: StageTimings.partial(),
  query_count: z.number(),
  /**
   * Mean context-token cost to surface the answer (`context_tokens_to_hit`),
   * averaged over the queries that hit (null when none hit). The headline
   * "context efficiency" number: lower means the consumer pays fewer context
   * tokens to have the answer in front of it. Optional for back-compat.
   */
  context_tokens_to_hit_mean: z.number().nullable().optional(),
});
export type RunSummary = z.infer<typeof RunSummary>;

const RunOutputBody = z.object({
  run_id: z.string(),
  fixture_path: z.string(),
  fixture_sha256: z.string(),
  gateway: z.object({
    url: z.string(),
    version: z.string().optional(),
    git_sha: z.string().optional(),
  }),
  machine: z.object({
    hostname: z.string(),
    platform: z.string(),
    arch: z.string(),
    cpu_count: z.number(),
    total_ram_bytes: z.number(),
  }),
  // Effective `search` config snapshot read from gateway at run start, kept
  // as-is so downstream comparators can hash or diff without our schema
  // dictating every field.
  search_config: z.unknown(),
  index_snapshot: z.object({
    document_count: z.number().optional(),
    embedding_count: z.number().optional(),
    db_size_bytes: z.number().optional(),
  }),
  started_at: z.string(),
  completed_at: z.string(),
  duration_ms: z.number(),
  repeats: z.number().int().positive(),
  queries: z.array(QueryResult),
  /**
   * Queries whose search call failed (after retries) — a network error, a
   * rate-limit 429, or a 5xx. Recorded so a contaminated run can never be
   * silently scored as a run full of genuine misses: a failed call is a
   * measurement gap, not a zero-result query. Empty/absent = clean.
   */
  failed_queries: z.array(z.object({ query_id: z.string() })).optional(),
  summary: z.object({
    overall: RunSummary,
    by_type: z.record(z.string(), RunSummary).optional(),
    by_difficulty: z.record(z.string(), RunSummary).optional(),
  }),
});

/**
 * Run JSON written before search collapsed to a single pipeline keyed every
 * measurement by an ablation lane (`bm25` / `vector` / `hybrid`) under
 * `queries[].backends`, and listed the lanes it ran in a top-level `stages`
 * array. Those lanes no longer exist, so the numbers in such a file cannot be
 * mapped onto the current single-series shape — the reader rejects them.
 * Detecting the shape up front turns what would otherwise be a wall of
 * "expected object, received undefined" issues into one sentence a human can
 * act on.
 */
function isMultiLaneRun(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r["stages"])) return true;
  const queries = r["queries"];
  return (
    Array.isArray(queries) &&
    queries.some((q) => typeof q === "object" && q !== null && "backends" in q)
  );
}

const MULTI_LANE_RUN_MESSAGE =
  "This run output was recorded by a multi-lane eval build: its results are keyed by " +
  "search backend (bm25/vector/hybrid), lanes that no longer exist now that search runs a " +
  "single pipeline. Archived multi-lane runs are not readable and cannot be compared against " +
  "current runs — re-run the suite to produce a comparable baseline.";

export const RunOutput = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (isMultiLaneRun(raw)) {
      ctx.addIssue({ code: "custom", message: MULTI_LANE_RUN_MESSAGE });
    }
  })
  .pipe(RunOutputBody);
export type RunOutput = z.infer<typeof RunOutputBody>;

// --- Progress events (one per JSONL line) --------------------------------

export const ProgressEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("run_started"),
    ts: z.string(),
    run_id: z.string(),
    total_queries: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("warmup_started"),
    ts: z.string(),
    warmup_calls: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("warmup_completed"),
    ts: z.string(),
    elapsed_ms: z.number(),
  }),
  z.object({
    type: z.literal("query_started"),
    ts: z.string(),
    query_idx: z.number().int().nonnegative(),
    query_id: z.string(),
  }),
  z.object({
    type: z.literal("query_completed"),
    ts: z.string(),
    query_idx: z.number().int().nonnegative(),
    query_id: z.string(),
    elapsed_ms: z.number(),
    eta_ms: z.number().optional(),
  }),
  z.object({
    type: z.literal("run_completed"),
    ts: z.string(),
    run_id: z.string(),
    duration_ms: z.number(),
  }),
]);
export type ProgressEvent = z.infer<typeof ProgressEvent>;

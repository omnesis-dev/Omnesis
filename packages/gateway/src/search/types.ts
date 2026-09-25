// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search engine types — all interfaces for the hybrid search pipeline.
 */

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface SearchFilters {
  sourceIds?: string[];
  documentTypes?: string[];
  /**
   * When true, the hidden cognitive mirrors (open loops) are NOT excluded from
   * this search — the understanding layer becomes searchable. Set by the
   * pipeline from a request's `cognitiveProjection` under experimental mode;
   * both hybrid lanes (BM25 + vector) read it via `hiddenSourceIdsToExclude`.
   */
  includeHidden?: boolean;
  dateFrom?: string; // ISO 8601
  dateTo?: string; // ISO 8601
  tags?: string[];
  /**
   * Person filters extracted by the query parser. Each entry comes
   * from a distinct filter intent — `from:`/`by:` produce one entry
   * with sender/author/owner roles, `to:` produces one with
   * recipient/attendee,
   * `with:` produces one with no role constraint. Refs within a single
   * entry are OR'd; multiple entries are AND'd, so `from:alice to:bob`
   * resolves to "docs where alice is a sender AND bob is a recipient"
   * rather than collapsing both refs into a shared role bucket.
   */
  personFilters?: PersonFilter[];
}

/**
 * One person-filter clause. `refs` are raw user-supplied references
 * (names, emails, phones, or the literal `me`) which the pipeline
 * resolves to canonical person IDs at query time. `roles` constrains
 * the `document_people.role` join — undefined means "any role".
 */
export interface PersonFilter {
  refs: string[];
  roles?: readonly string[];
}

/**
 * One feedback line about how a query was interpreted. Emitted by the
 * parser and pipeline so the caller can tell, for instance, that
 * `after:tomorrow` was silently dropped, that `source:nope` matched
 * no configured source, or that `from:typo` resolved to zero people.
 * Surfaced under `SearchResponse.notices` so the UI can render them
 * as inline hints.
 */
export interface SearchNotice {
  /** Which filter family the notice is about. */
  filter: "date" | "person" | "source" | "tag" | "type" | "text";
  /**
   * Severity:
   *   - `error`: the token's intent could not be honored at all (invalid
   *     date silently dropped, person ref resolved to zero people →
   *     zero results, source value matches no configured source).
   *   - `warning`: the token was honored but with a non-obvious twist
   *     (e.g. FTS sanitizer dropped an operator-shaped term).
   *   - `info`: purely informational (e.g. bare-prefix expansion
   *     produced 4 source IDs).
   */
  level: "error" | "warning" | "info";
  /** Raw token from the query, when one can be pinpointed. */
  token?: string;
  /** One-line human-readable message. */
  message: string;
}

// ---------------------------------------------------------------------------
// Query / Response
// ---------------------------------------------------------------------------

export interface SearchQuery {
  text: string;
  filters?: SearchFilters;
  limit?: number;
  /** Per-request override of `SearchConfig.vector` (e.g. `hnswOverFetch`). */
  vector?: SearchVectorConfig;
  /**
   * When true the response includes a `debug` block with model
   * readiness state and query-length proxies. `timing` and `stages`
   * are always populated regardless of this flag; `debug` carries the
   * fields that are only ever interesting in verbose/eval contexts.
   * The portal verbose checkbox sets this; the eval toolkit sets it
   * unconditionally.
   */
  verbose?: boolean;
  /**
   * When true, a hit whose source declares a `boundDocument` carries
   * its co-described DuckDB analytics row in `boundRow`. Opt-in because it
   * costs one batched DuckDB lookup per table on the result frame — default
   * searches don't pay it. This is what lets a BM25/vector hit on a Strava or
   * Notion document surface its structured fields without a client-side join.
   */
  includeBoundRow?: boolean;
  /**
   * Opt-in cognitive projection (experimental): surface the hidden cognitive
   * mirrors (open loops) alongside documents, so the agent's ordinary search
   * reaches the understanding layer the background agent maintains. Honoured
   * only under experimental mode (the pipeline gates it); the surfaced mirrors
   * are down-weighted so they don't crowd out the real documents.
   */
  cognitiveProjection?: boolean;
}

/**
 * The DuckDB analytics row a search-hit document co-describes — attached
 * post-fusion when the source declares a `boundDocument` and the request sets
 * `includeBoundRow`. A bounded projection, never the full (possibly wide) row.
 */
export interface BoundRowRef {
  /** Analytics table the row lives in. */
  tableName: string;
  /** Human-readable table name from the analytics catalog. */
  tableDisplayName: string;
  /** `:`-joined primary-key value — the row's identity within the table. */
  primaryKey: string;
  /** Projected columns of the row. */
  row: Record<string, unknown>;
}

export interface SearchResultItem {
  documentId: string;
  /** Internal chunk rowid for post-fusion content hydration. */
  chunkRowid?: number;
  sourceId: string;
  documentType: string;
  title: string;
  sourceUrl?: string;
  appUrl?: string;
  /**
   * MIME type from `metadata.extra.mimeType`, batch-hydrated post-fusion
   * (the denormalized `chunks` table doesn't carry it). Drives file-type
   * iconography on clients and rides through to the agent's `DocRef`.
   */
  mimeType?: string;
  sourceCreatedAt: string;
  author?: string;
  chunkText: string;
  score: number;
  scoreBreakdown?: ScoreBreakdown;
  relevanceScore?: number;
  refCount?: number;
  /**
   * The analytics row this document co-describes — present only when the
   * request set `includeBoundRow` and the source declares a `boundDocument`.
   *The cross-store half of the result.
   */
  boundRow?: BoundRowRef;
}

export interface ScoreBreakdown {
  bm25Rank?: number;
  vectorRank?: number;
  /** RRF score BEFORE the top-rank bonus is applied (raw fused value). */
  rrfScore?: number;
  /**
   * Top-rank bonus added by the fusion stage to results at ranks 1–3
   * (per `search.params.topRankBonus` / `nearTopRankBonus`). Surfaced
   * separately so the portal score breakdown adds up to `finalScore`
   * without leaking the bonus inside `rrfScore`.
   */
  rankBonus?: number;
  typeBoost?: number;
  relevanceBoost?: number;
  /**
   * Additive adjustment applied by the source-prior stage based on the
   * candidate's source-id prefix (see `SearchConfig.sourcePriors`).
   * Negative values downweight bulky / low-signal source types; positive
   * values upweight. Omitted when the feature is off; set to `0` when
   * the feature is on but no prefix matched OR the candidate's BM25
   * rank was strong enough to bypass the adjustment.
   */
  sourcePrior?: number;
  finalScore?: number;
}

/**
 * Per-stage execution report. Emitted for every stage the pipeline
 * *could* run, even if it was skipped — so the portal's pipeline view
 * can show "Vector: skipped — embedder still loading" instead of
 * silently omitting the row and looking like the stage was never part of
 * the pipeline.
 */
export interface SearchStageReport {
  /** "ran" = produced output, "skipped" = prerequisites missing (e.g. no embedder yet). */
  status: "ran" | "skipped";
  /** Human-readable reason when `status === "skipped"`. */
  reason?: string;
  /** Wall-clock duration in ms for this stage. */
  durationMs?: number;
  /** Number of candidates produced (bm25 / vector stages). */
  candidates?: number;
  /** Fusion method, present only on the fusion stage. */
  method?: "rrf" | "bm25-only";
  rrfK?: number;
  bm25Weight?: number;
  vectorWeight?: number;
  /** Number of fused rows after the stage. */
  resultCount?: number;
  /** Effective KNN k after applying over-fetch (vector stage only). */
  effectiveK?: number;
  /** ms spent in `embedder.embedQuery` (vector stage only). */
  embedMs?: number;
  /** ms spent in the HNSW search + JOIN SQL (vector stage only). */
  sqlMs?: number;
  /** Vector engine used (always "hnsw"). */
  engine?: string;
  /** Tokens dropped from BM25 MATCH for exceeding the common-token threshold. */
  droppedTokens?: string[];
}

/**
 * Vector-stage configuration. Loaded from `search.vector` in
 * `omnesis.json` (see `search-config.ts` for defaults).
 */
export interface SearchVectorConfig {
  hnswOverFetch?: number;
  /**
   * Apply the `hnswOverFetch` multiplier to every query, not just filtered
   * ones, so an unfiltered query also over-fetches and the fusion doc-dedup
   * has headroom to reach `candidateLimit` distinct documents. On by default;
   * set false to over-fetch only when a filter is present.
   */
  alwaysOverFetch?: boolean;
}

/**
 * Per-source-type score prior applied in the boost stage. Loaded from
 * `search.sourcePriors` in `omnesis.json`.
 *
 *   - `weights`: map of source-id prefix → additive adjustment on the
 *     post-fusion score. Matched by `startsWith`, so configuring
 *     `"browser-history"` covers both `browser-history:chrome` and
 *     `browser-history:safari` without enumerating each. Negative values
 *     downweight (typical use: bulky-but-low-signal sources like captured
 *     web pages and browser history); positive values upweight. Cosine
 *     differences between competing results are often <0.1, so even
 *     `-0.04` is a meaningful nudge.
 *   - `bm25BypassRank`: when a candidate's BM25 rank is `<=` this value,
 *     the prior is skipped — i.e. if the user typed a rare token that
 *     happens to match a captured page, the SEO-density tax shouldn't
 *     suppress it. Set to `0` to disable the bypass and always apply
 *     priors. Default `3`.
 *
 * Empty `weights` (or missing) means the feature is off — every
 * candidate passes through unchanged.
 */
export interface SearchSourcePriorsConfig {
  weights?: Record<string, number>;
  bm25BypassRank?: number;
  /**
   * Automatic inverse-source-frequency priors. When enabled, a prior is
   * derived for every source from its live document frequency (no source is
   * named, no constant is hand-tuned) and merged into `weights`, counteracting
   * a high-volume source crowding rarer ones out of the top-k. The derived
   * priors are positive boosts on rarer sources, scaled to the RRF score; see
   * `source-isf-prior.ts`. Explicit `weights` keys still take precedence.
   */
  autoInverseFrequency?: {
    enabled?: boolean;
    /** Dimensionless strength multiplier on the derived prior. Default 1. */
    strength?: number;
  };
}

/**
 * Resolved source-prior config: defaults filled in, suitable for use
 * inside the boost stage. `weights` is always a (possibly empty) object;
 * `bm25BypassRank` is always a number.
 */
export interface ResolvedSourcePriorsConfig {
  weights: Record<string, number>;
  bm25BypassRank: number;
}

export interface SearchResponse {
  results: SearchResultItem[];
  /** Per-stage model identifiers for display in the pipeline debug tree. */
  models?: {
    /** Embedding model id used by the vector stage (indexer-side). */
    embedding?: string;
  };
  query: {
    original: string;
    parsedFilters?: SearchFilters;
    effectiveText?: string;
  };
  timing: {
    totalMs: number;
    bm25Ms?: number;
    vectorMs?: number;
    bm25Candidates?: number;
    vectorCandidates?: number;
  };
  /**
   * Structured report for each stage that could have run. On the hybrid
   * path `bm25`, `vector` and `fusion` are always present — `vector`
   * reports `status: "skipped"` with a reason when the embedder or the
   * HNSW index isn't ready, rather than being omitted. A missing `vector`
   * entry therefore means the query took the browse path, where the
   * bm25/vector/fusion lanes never apply and only `browse` is reported.
   */
  stages?: {
    bm25?: SearchStageReport;
    vector?: SearchStageReport;
    fusion?: SearchStageReport;
    boost?: SearchStageReport;
    // Post-fusion per-source diversity / MMR. On by default; present whenever
    // the stage runs (a mechanism is configured — MMR by default), omitted
    // when it is explicitly disabled or there is nothing to diversify.
    diversity?: SearchStageReport;
    refCount?: SearchStageReport;
    // Restrictor-only queries (a person/source/type/date filter but no
    // free-text terms) are answered by a recency browse instead of the
    // bm25/vector/fusion path; this reports on that branch when taken.
    browse?: SearchStageReport;
    // Note: `personFilter` was removed — the filter is
    // now pushed into the BM25 + vector candidate SQL, so there's no
    // post-fusion stage to report on.
  };
  facets?: SearchFacets;
  /**
   * Per-query feedback the parser and pipeline emit about how the
   * filter tokens were interpreted: invalid dates that were dropped,
   * person refs that resolved to no canonical person, source values
   * that matched no configured source, FTS-special terms the
   * sanitizer rewrote. Omitted when nothing of note happened so
   * clean queries don't carry an empty array around.
   */
  notices?: SearchNotice[];
  /**
   * Verbose-only block. Present when the request set `verbose: true`.
   * Carries data that isn't useful to the default search UI: per-model
   * readiness state and query-length proxies (we don't run a real
   * tokenizer — character counts are a cheap signal good enough for
   * comparing two runs of the same query).
   */
  debug?: SearchDebug;
}

export interface SearchDebug {
  modelState: {
    vector: "ready" | "unavailable";
  };
  query: {
    inputLength: number;
  };
}

export interface SearchFacets {
  byType?: Record<string, number>;
  bySource?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export interface SearchParams {
  candidateLimit: number; // per-stage before fusion (default 50)
  resultLimit: number; // final results (default 10)
  rrfK: number; // RRF constant (default 60)
  bm25Weight: number; // RRF weight for BM25 list (default 1.0)
  vectorWeight: number; // RRF weight for vector list (default 1.0)
  /**
   * Bonus added to the rank-1 fused result's RRF score. Default 0.05.
   * Set to 0 to disable. Surfaced in `ScoreBreakdown.rankBonus`
   * At RRF k=60 the per-position increment is
   * ~1/(60+1) ≈ 0.0164, so a 0.05 bonus is roughly 3 ranks of
   * separation — large enough to flip rank-2 ↔ rank-1 when the raw
   * scores are close.
   */
  topRankBonus: number;
  /**
   * Bonus added to fused results at ranks 2–3. Default 0.02. Set to
   * 0 to disable. Same surfacing as `topRankBonus`.
   */
  nearTopRankBonus: number;
}

export interface SearchBoosts {
  typeBoosts?: Record<string, number>;
  relevanceBoostWeight?: number;
}

// ---------------------------------------------------------------------------
// Injection ports
// ---------------------------------------------------------------------------

/**
 * Resolves people-graph queries on behalf of the search pipeline. The
 * concrete impl lives outside `search/` (built from `people.ts` in
 * `index.ts`), so the pipeline doesn't have a compile-time edge into
 * the people subsystem.
 */
export interface QueryEnricher {
  /** Resolve a free-text author/person token to canonical person IDs. */
  resolvePersonIds(text: string): readonly string[];
  /** Canonical "self" person ID, or null when no self has been elected. */
  getSelfPersonId(): string | null;
}

/**
 * Inbound-reference counts for the post-fusion `RefCountStage`. The
 * concrete impl is built from `links.ts` in `index.ts`.
 */
export interface LinkRefSource {
  getInboundRefCounts(documentIds: readonly string[]): Map<string, number>;
}

// ---------------------------------------------------------------------------
// Internal candidates (used between pipeline stages)
// ---------------------------------------------------------------------------

export interface SearchCandidate {
  documentId: string;
  chunkRowid: number;
  sourceId: string;
  documentType: string;
  title: string;
  sourceUrl: string | null;
  sourceCreatedAt: string;
  author: string | null;
  tags: string | null;
  chunkText: string;
  score: number; // stage-specific score (bm25 or cosine)
  rank?: number; // rank within its stage
  relevanceScore: number | null;
}

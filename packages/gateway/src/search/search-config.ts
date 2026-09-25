// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search configuration — the operator-tunable knobs behind the one search
 * pipeline, resolved from `omnesis.json` onto defaults.
 */

import { computeIsfPriors, type SourceDocCount } from "./source-isf-prior.js";
import type {
  ResolvedSourcePriorsConfig,
  SearchBoosts,
  SearchFilters,
  SearchParams,
  SearchSourcePriorsConfig,
  SearchVectorConfig,
} from "./types.js";

/**
 * Fusion + limit defaults. Every one is overridable under `search.params`
 * in `omnesis.json`; `resolveSearchSettings` layers the operator's values
 * on top of these.
 */
export const DEFAULT_SEARCH_PARAMS: SearchParams = {
  candidateLimit: 50,
  resultLimit: 10,
  rrfK: 60,
  bm25Weight: 1.0,
  vectorWeight: 1.0,
  // Nudge the head so near-tied fusion scores don't reorder arbitrarily
  // between queries. Set either to 0 under `search.params` to disable.
  topRankBonus: 0.05,
  nearTopRankBonus: 0.02,
};

/** Score-boost defaults, overridable under `search.boosts`. */
export const DEFAULT_SEARCH_BOOSTS: SearchBoosts = { relevanceBoostWeight: 0.3 };

/**
 * Defaults applied when `search.vector` is absent or partially set in
 * `omnesis.json`. `alwaysOverFetch` is ON by default: usearch returns chunks
 * and fusion dedups to distinct documents, so without over-fetching every
 * query the distinct-document candidate pool falls well short of
 * `candidateLimit`. Over-fetching closes that gap and measurably lifts
 * recall@10 at negligible latency cost; set `alwaysOverFetch: false` to revert
 * to over-fetching only on filtered queries.
 */
export const DEFAULT_VECTOR_CONFIG: Required<SearchVectorConfig> = {
  hnswOverFetch: 10,
  alwaysOverFetch: true,
};

/**
 * Default `bm25BypassRank` for the source-prior stage. A candidate
 * with `bm25Rank <= 3` is treated as a strong rare-token hit; the
 * source-prior adjustment is skipped so explicit user keywords still
 * win against the per-source-type downweight.
 */
export const DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK = 3;

/**
 * Automatic inverse-source-frequency priors are ON by default. They derive a
 * per-source prior from corpus document frequency (naming no source, tuning no
 * constant) and lift recall@10 on multi-source corpora; on a single-source
 * corpus there is nothing to diversify, so `computeIsfPriors` returns no
 * weights and the feature is inert. Set
 * `search.sourcePriors.autoInverseFrequency.enabled: false` to disable.
 */
export const DEFAULT_AUTO_ISF_ENABLED = true;

/**
 * Merge source-advertised defaults with user-supplied `sourcePriors`
 * config. Two layers, in order of precedence (later wins per key):
 *
 *   1. `defaults` — source-advertised defaults pushed by the collector
 *      from each source's `defaultSourcePrior` field (`defineSource`),
 *      plus gateway-hosted defaults. Lets each source
 *      ship a sane default without hard-coding it in the gateway.
 *   2. `config.sourcePriors.weights` — explicit user overrides from
 *      `omnesis.json`. Wins on conflict.
 *
 * Empty merged `weights` means "feature off". Undefined args also
 * resolve to the off state.
 */
export function resolveSourcePriorsConfig(
  config?: SearchConfig,
  defaults?: Record<string, number>,
  auto?: { docCounts: readonly SourceDocCount[]; rrfK: number },
): ResolvedSourcePriorsConfig {
  const userWeights = config?.sourcePriors?.weights ?? {};
  // Layering, weakest first: source-advertised/static defaults, then the
  // automatic inverse-source-frequency priors (corpus-derived), then explicit
  // user `weights` — so a hand-set weight always wins over the auto prior.
  const autoCfg = config?.sourcePriors?.autoInverseFrequency;
  const autoEnabled = autoCfg?.enabled ?? DEFAULT_AUTO_ISF_ENABLED;
  const isfWeights =
    autoEnabled && auto
      ? computeIsfPriors(auto.docCounts, { strength: autoCfg?.strength, rrfK: auto.rrfK })
      : {};
  const mergedWeights = { ...(defaults ?? {}), ...isfWeights, ...userWeights };
  return {
    weights: mergedWeights,
    bm25BypassRank: config?.sourcePriors?.bm25BypassRank ?? DEFAULT_SOURCE_PRIORS_BM25_BYPASS_RANK,
  };
}

/**
 * Resolved post-fusion diversity config: defaults filled in, suitable for
 * the `DiversityStage`. `enabled` is always a boolean; `bucketBy` always a
 * concrete granularity. The three tuning knobs stay `undefined` when unset
 * — undefined `topK` falls back to `candidateLimit` inside the stage, and an
 * unset `maxPerSourceInTopK` / `lambda` means that mechanism is off.
 */
export interface ResolvedDiversityConfig {
  enabled: boolean;
  bucketBy: "type" | "sourceId";
  topK?: number;
  maxPerSourceInTopK?: number;
  lambda?: number;
}

/** Default bucketing granularity for the diversity stage. */
export const DEFAULT_DIVERSITY_BUCKET_BY = "type" as const;

/** Diversity is ON by default — it lifts recall@10 by spreading the top-k
 * across source types instead of letting one high-volume source monopolize
 * it. Single-source corpora degrade to a no-op (one bucket = uniform
 * redundancy = relevance order). */
export const DEFAULT_DIVERSITY_ENABLED = true;

/**
 * Default MMR tradeoff: 0.7 relevance / 0.3 source-diversity. A moderate
 * default that diversifies multi-source corpora without over-spreading and
 * is a no-op on single-source corpora.
 */
export const DEFAULT_DIVERSITY_LAMBDA = 0.7;

/**
 * Merge user-supplied diversity config onto the defaults. ON by default via
 * MMR (`lambda`); `search.diversity.enabled: false` disables it entirely. The
 * stage's `isEnabled` requires a mechanism (`lambda` or `maxPerSourceInTopK`)
 * to be present, which the default `lambda` satisfies.
 */
export function resolveDiversityConfig(config?: SearchConfig): ResolvedDiversityConfig {
  const d = config?.diversity;
  return {
    enabled: d?.enabled ?? DEFAULT_DIVERSITY_ENABLED,
    bucketBy: d?.bucketBy ?? DEFAULT_DIVERSITY_BUCKET_BY,
    topK: d?.topK,
    maxPerSourceInTopK: d?.maxPerSourceInTopK,
    // Default to MMR unless the user set an explicit mechanism. If they
    // configured only a hard quota, respect that and leave MMR off.
    lambda: d?.lambda ?? (d?.maxPerSourceInTopK != null ? undefined : DEFAULT_DIVERSITY_LAMBDA),
  };
}

/** Merge user-supplied vector config onto the defaults. */
export function resolveVectorConfig(config?: SearchConfig): Required<SearchVectorConfig> {
  const user = config?.vector ?? {};
  return {
    hnswOverFetch: user.hnswOverFetch ?? DEFAULT_VECTOR_CONFIG.hnswOverFetch,
    alwaysOverFetch: user.alwaysOverFetch ?? DEFAULT_VECTOR_CONFIG.alwaysOverFetch,
  };
}

export interface SearchConfig {
  /** Fusion + limit tunables; see {@link DEFAULT_SEARCH_PARAMS}. */
  params?: Partial<SearchParams>;
  /** Per-type and relevance score boosts; see {@link DEFAULT_SEARCH_BOOSTS}. */
  boosts?: SearchBoosts;
  /** Filters applied to every query unless the caller overrides them. */
  defaultFilters?: SearchFilters;
  /** Vector-stage knobs. */
  vector?: SearchVectorConfig;
  bm25?: { commonTokenThreshold?: number };
  /**
   * Snapshot isolation for the search-handle index.db connection.
   * When enabled, search reads run through a dedicated long-lived
   * `BEGIN` transaction so the per-connection page cache isn't
   * invalidated by concurrent indexer writes. The snapshot is
   * advanced periodically (`refreshIntervalMs`); fresh writes become
   * visible to search within that window.
   *
   *   - `enabled`: opt-in, default `false`.
   *   - `refreshIntervalMs`: how often to `COMMIT; BEGIN;` on the
   *     handle. Default 600000 (10 min). Smaller = fresher results
   *     but more cache churn; larger = stale-er search reads.
   */
  snapshot?: {
    enabled?: boolean;
    refreshIntervalMs?: number;
  };
  /**
   * Tunables for the read-only `index.db` handle that serves search.
   *
   *   - `mmapBytes`: applied as `PRAGMA mmap_size = <bytes>`. Enables
   *     mmap on the snapshot reader so SQLite can satisfy page reads
   *     from the OS unified cache rather than its private pcache.
   *     The Phase-0 measurement gate showed this is the dominant
   *     lever for tail latency under live ingest. Default 1 GiB. Set
   *     to 0 to disable. Only applied to read-only handles — writer-
   *     side mmap is the SIGBUS class and stays off.
   *   - `cacheSizeBytes`: positive bytes applied as
   *     `PRAGMA cache_size = -<KiB>`. With mmap on, the pcache is
   *     mostly redundant; a small value (~2 MiB) is sufficient for
   *     prepared-statement plans + transaction state. Default 1 GiB
   *     pending E8b measurement.
   */
  readHandle?: {
    mmapBytes?: number;
    cacheSizeBytes?: number;
  };
  /**
   * Per-source-type score prior applied in the boost stage. When
   * `weights` is empty (or omitted) the feature is off; otherwise each
   * post-fusion candidate whose `sourceId` starts with one of the
   * configured prefixes has the matching weight added to its score,
   * UNLESS the candidate has a strong BM25 hit (rank <= `bm25BypassRank`,
   * default 3).
   *
   * Example:
   *
   * ```jsonc
   * {
   *   "search": {
   *     "sourcePriors": {
   *       "weights": {
   *         "web": -0.04,
   *         "browser-history": -0.04
   *       },
   *       "bm25BypassRank": 3
   *     }
   *   }
   * }
   * ```
   */
  sourcePriors?: SearchSourcePriorsConfig;
  /**
   * Post-fusion per-source diversity / MMR re-ranking. Re-orders the
   * post-boost candidate pool so a single source type can't monopolise
   * the top-k. On by default (MMR λ=0.7); see `resolveDiversityConfig` +
   * the `DiversityStage`.
   */
  diversity?: {
    enabled?: boolean;
    bucketBy?: "type" | "sourceId";
    topK?: number;
    maxPerSourceInTopK?: number;
    lambda?: number;
  };
  /**
   * Family-aware task prefixes for the embedder. When `enabled: true`,
   * the indexer worker prepends the model-card-recommended prefix per
   * embedder family on both indexing and querying paths (nomic gets
   * `search_query: ` / `search_document: `; BGE gets the long query
   * prefix and no doc prefix; unknown families are a no-op). Off by
   * default. Enabling on an existing install requires rebuilding the
   * vector index — see `embedder-prefixes.ts`.
   */
  embedderPrefixes?: {
    enabled?: boolean;
  };
}

/**
 * Default mmap_size on the read-only snapshot handle. Disabled (0).
 * With mmap enabled, the OS manages page residency and background
 * worker scans evict search-hot pages. Disabled so all reads go
 * through SQLite's per-connection page cache (3 GiB), which SQLite
 * controls and won't evict. Override via `search.readHandle.mmapBytes`.
 */
export const DEFAULT_SEARCH_READ_MMAP_BYTES = 0;

/**
 * Default `cache_size` on the read-only snapshot handle. 3 GiB —
 * sized to hold the `chunks` table (2 GB content+metadata) and
 * `chunks_fts_data` (445 MB inverted index) in the per-connection
 * page cache. Without this, BM25 JOINs to `chunks` cause random
 * disk reads on every search.
 */
export const DEFAULT_SEARCH_READ_CACHE_BYTES = 3 * 1024 * 1024 * 1024;

/**
 * The tunables the pipeline runs with: defaults layered under whatever the
 * operator set in `omnesis.json`. Resolved once per search.
 */
export interface ResolvedSearchSettings {
  params: SearchParams;
  boosts: SearchBoosts;
  /** Filters applied to every query unless the caller overrides them. */
  defaultFilters?: SearchFilters;
}

/** Layer `search.params` / `search.boosts` / `search.defaultFilters` onto the defaults. */
export function resolveSearchSettings(config?: SearchConfig): ResolvedSearchSettings {
  return {
    params: { ...DEFAULT_SEARCH_PARAMS, ...config?.params },
    boosts: { ...DEFAULT_SEARCH_BOOSTS, ...config?.boosts },
    defaultFilters: config?.defaultFilters,
  };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SearchStage — abstraction for an orchestratable search-pipeline stage.
 *
 * Stages share a single `SearchStageContext` instance per query. Each
 * stage reads from prior-stage outputs on the context and writes its
 * own outputs (candidates, results, timings, stage reports) back to it.
 * The pipeline runs stages sequentially; each stage decides whether it
 * runs by inspecting `isEnabled(ctx)`.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import type { ResolvedDiversityConfig, ResolvedSearchSettings } from "../search-config.js";
import type {
  LinkRefSource,
  ResolvedSourcePriorsConfig,
  SearchCandidate,
  SearchFilters,
  SearchQuery,
  SearchResponse,
  SearchResultItem,
  SearchStageReport,
  SearchVectorConfig,
} from "../types.js";

export interface SearchStageDeps {
  indexDb: Db;
  gatewayDb?: Db;
  /**
   * Inbound-ref source for the post-fusion `RefCountStage`. Injected
   * from above so `search/` doesn't compile-time-depend on `links.ts`
   * Stage runs only when this is set.
   */
  linkRefSource?: LinkRefSource;
  // The embedder + usearch read source are not in the stage-deps bag: BM25 /
  // vector / fusion live in `runCandidateGen`, which takes those resources
  // directly. The one remaining main-thread stage (ref-count) reads only
  // indexDb / gatewayDb / linkRefSource.
}

export interface SearchStageContext {
  query: SearchQuery;
  effectiveText: string;
  parsedFilters: SearchFilters;
  filters: SearchFilters;
  settings: ResolvedSearchSettings;
  limit: number;
  candidateLimit: number;

  /**
   * When the parsed query carried a person filter (`from:`/`to:`/
   * `with:`) and the gatewayDb resolved it to a non-trivial doc set,
   * `allowedDocumentIds` carries those IDs. BM25 + vector stages use
   * it as a pre-filter so the result limit is applied AFTER the
   * person filter. `undefined` means "no person filter
   * active"; an empty array means "person filter resolved to zero
   * docs" — the stages short-circuit to no candidates.
   */
  allowedDocumentIds?: readonly string[];

  bm25Candidates?: SearchCandidate[];
  vectorCandidates?: SearchCandidate[];
  results: SearchResultItem[];

  /**
   * Resolved vector-stage config for this request. Pipeline merges
   * `SearchConfig.vector` onto `DEFAULT_VECTOR_CONFIG` once at request
   * start; the vector stage reads it from here rather than re-resolving.
   */
  vectorConfig: Required<SearchVectorConfig>;

  /**
   * Resolved per-source-type score prior config for this request.
   * Pipeline merges `SearchConfig.sourcePriors` onto its defaults once
   * at request start; the boost stage reads it from here. When
   * `weights` is empty the feature is off and the stage is a no-op.
   */
  sourcePriors: ResolvedSourcePriorsConfig;

  /**
   * Resolved post-fusion diversity config for this request. Pipeline
   * resolves `SearchConfig.diversity` once at request start; the
   * `DiversityStage` reads it from here. When `enabled` is false (the
   * default) the stage never runs.
   */
  diversity: ResolvedDiversityConfig;

  /** BM25 common-token threshold (0..1). Tokens with doc frequency above
   * this fraction are dropped from the MATCH query. 0 = disabled. */
  commonTokenThreshold: number;

  timing: SearchResponse["timing"];
  stageReports: NonNullable<SearchResponse["stages"]>;

  deps: SearchStageDeps;
}

export interface SearchStage {
  readonly name: string;
  isEnabled(ctx: SearchStageContext): boolean;
  execute(ctx: SearchStageContext): Promise<void>;
}

/** Helper for stages that need to record a skipped status. */
export function reportSkipped(reason: string): SearchStageReport {
  return { status: "skipped", reason };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * runCandidateGen — the synchronous candidate-generation core of the search
 * pipeline.
 *
 * This is the extraction seam for the search-worker relocation (Slice 3B): the
 * heavy, blocking part of a search — BM25 over FTS5, native usearch over the
 * HNSW index, the candidate fetch from `index.db`, and the pure-JS
 * fusion / boost / diversity that shapes the pool — is pulled into one pure
 * function so that both the main thread (today) and a worker thread (a later
 * slice) can call it over byte-identical inputs. Parity with the pre-extraction
 * pipeline is structural, not lucky: this function calls the very same
 * `bm25Search`, `hnswSearchCandidates`, `rrfFuse` / `singleStageFuse`,
 * `applyBoostPass`, and `diversityReorder` the stages called, in the same order.
 *
 * It touches only `index.db` (a read handle) and the usearch registry — never
 * the embedder (the query is embedded on the main thread and the vector is
 * passed in) and never `omnesis.db` (person-filter resolution and metadata
 * hydration stay on the main thread). It also hydrates the chunk text of the
 * ENTIRE returned pool and fetches the content-hash map, so the finalize path
 * on the main thread issues zero further `index.db` reads.
 *
 * Everything after the pool is produced — ref-count (`omnesis.db`), the
 * content-hash dedupe, metadata + bound-row hydration — stays on the caller's
 * thread, after this returns.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import { createLogger } from "@omnesis/core";
import { bm25Search } from "./bm25.js";
import { browseByRecency } from "./browse.js";
import { fetchContentHashByDoc } from "./dedupe.js";
import { rrfFuse, singleStageFuse } from "./fusion.js";
import { hydrateChunkText } from "./hydrate-chunks.js";
import { applyBoostPass } from "./stages/boost-stage.js";
import { diversityIsEnabled, diversityReorder } from "./stages/diversity-stage.js";
import { hnswSearchCandidates } from "./vector-hnsw.js";
import type { VectorReadSource } from "../indexer/usearch-index.js";
import type { ResolvedDiversityConfig, ResolvedSearchSettings } from "./search-config.js";
import type {
  ResolvedSourcePriorsConfig,
  SearchCandidate,
  SearchFilters,
  SearchNotice,
  SearchResponse,
  SearchResultItem,
  SearchVectorConfig,
} from "./types.js";

const log = createLogger("gateway:search");

// Vector-stage skip reasons (relocated verbatim from the deleted VectorStage).
// The wording is surfaced on `stages.vector.reason`, so it is part of the
// response contract and must stay byte-identical.
const SKIP_REASON_NO_EMBEDDER =
  "No embedder attached — the indexer worker is still loading its embedding model, or failed to start. Results fall back to BM25-only.";
const SKIP_REASON_NO_INDEX =
  "HNSW index not available — the indexer is still building the initial index. Results fall back to BM25-only.";
const SKIP_REASON_REINDEXING =
  "HNSW index is being rebuilt (embedder swap in progress). Results fall back to BM25-only.";

/** Per-stage report bag — the same shape the pipeline maps onto the response. */
type StageReports = NonNullable<SearchResponse["stages"]>;

/**
 * Read-side substrate for candidate generation. Deliberately narrow: an
 * `index.db` read handle and the usearch read source. No embedder (the query is
 * embedded upstream) and no `omnesis.db` (pre-stage + metadata stay upstream).
 */
export interface CandidateGenResources {
  indexDb: Db;
  usearchRead?: VectorReadSource;
}

/**
 * Everything the candidate-generation block needs, all computed on the caller's
 * thread. Structured-clone-safe by construction, so a later slice can post it
 * to a worker unchanged.
 */
export interface CandidateGenRequest {
  /** `browse` lists documents newest-first; `hybrid` runs bm25 + vector. */
  mode: "hybrid" | "browse";
  /** MATCH text for BM25. */
  bm25Text: string;
  /** Whether an embedder is attached; the vector lane runs only when it is. */
  embedderPresent: boolean;
  /** Query embedding at the current model's dim; null ⇒ vector is skipped. */
  queryVector: Float32Array | null;
  /** ms the caller spent in `embedder.embedQuery` — folded into the vector report. */
  embedMs: number;
  /**
   * Identifier of the model that embedded the query, or null when unknown. When
   * both this and the active generation's model are known and differ, the
   * vector lane degrades to BM25 even if the dims agree — a same-dimension swap
   * would otherwise rank against the wrong generation's vectors without
   * `usearch.search` ever throwing.
   */
  queryModelId: string | null;
  filters: SearchFilters;
  allowedDocumentIds: readonly string[] | undefined;
  candidateLimit: number;
  limit: number;
  settings: ResolvedSearchSettings;
  vectorConfig: Required<SearchVectorConfig>;
  sourcePriors: ResolvedSourcePriorsConfig;
  diversity: ResolvedDiversityConfig;
  commonTokenThreshold: number;
}

export interface CandidateGenResult {
  /**
   * The full candidate pool (capped at `candidateLimit`) in post-diversity
   * order — NOT sliced to `limit`. Every member carries its hydrated
   * `chunkText`, so the downstream dedupe needs no further `index.db` read.
   */
  results: SearchResultItem[];
  /**
   * `document_id → content_hash` for the whole pool, so the caller's dedupe
   * runs without touching `index.db`. Null-prototype object.
   */
  contentHashByDoc: Record<string, string>;
  /** Reports for the stages this core ran (browse OR bm25/vector/fusion/boost/diversity). */
  stageReports: StageReports;
  /** Timings the caller merges into the response (SQL-only for vector). */
  timing: {
    bm25Ms?: number;
    bm25Candidates?: number;
    vectorMs?: number;
    vectorCandidates?: number;
  };
  /** The vector lane degraded to BM25 via a dim/model mismatch. */
  vectorDegraded: boolean;
  /** Feedback lines produced here (v1: none — bm25 dropped tokens ride the stage report). */
  notices: SearchNotice[];
}

export function runCandidateGen(
  res: CandidateGenResources,
  req: CandidateGenRequest,
): CandidateGenResult {
  const stageReports: StageReports = {};
  const notices: SearchNotice[] = [];
  const timing: CandidateGenResult["timing"] = {};
  let vectorDegraded = false;
  let results: SearchResultItem[];

  if (req.mode === "browse") {
    // Restrictor-only query (e.g. `with:Maya`, `source:whatsapp-messages`):
    // no MATCH terms and no meaningful embedding, so list the matching
    // documents newest-first. Recency order is the answer here, so boost /
    // diversity are skipped (they'd re-rank by priors) — the caller only
    // enriches ref counts afterward.
    const start = Date.now();
    const candidates = browseByRecency(
      res.indexDb,
      req.filters,
      req.allowedDocumentIds,
      req.candidateLimit,
    );
    results = singleStageFuse(candidates, req.candidateLimit);
    stageReports.browse = {
      status: "ran",
      durationMs: Date.now() - start,
      resultCount: results.length,
    };
  } else {
    // BM25 lane — always runs.
    const start = Date.now();
    const { candidates, droppedTokens } = bm25Search(
      res.indexDb,
      req.bm25Text,
      req.filters,
      req.candidateLimit,
      {
        documentIds: req.allowedDocumentIds,
        commonTokenThreshold: req.commonTokenThreshold,
      },
    );
    const bm25Candidates = candidates;
    const durationMs = Date.now() - start;
    timing.bm25Ms = durationMs;
    timing.bm25Candidates = candidates.length;
    stageReports.bm25 = {
      status: "ran",
      durationMs,
      candidates: candidates.length,
      droppedTokens: droppedTokens.length > 0 ? droppedTokens : undefined,
    };

    // Vector lane. bm25 || usearch are both synchronous, so — inside one
    // thread — they run sequentially; there is no real parallelism to preserve.
    // Always call: with no embedder (or no index) `runVector` records why the
    // lane was skipped, which is what the pipeline debug panel surfaces.
    const vectorRun = runVector(res, req, stageReports, timing);
    const vectorCandidates = vectorRun.candidates;
    if (vectorRun.degraded) vectorDegraded = true;

    // Fusion → Boost → Diversity, exactly as the post-fusion stages ran.
    results = fuse(req, bm25Candidates, vectorCandidates, stageReports);

    // Boost always runs (its stage's `isEnabled` was unconditionally true): even
    // without settings boosts it applies source priors + the mirror down-weight and
    // performs the final score sort.
    const boostStart = Date.now();
    applyBoostPass(results, req.settings, req.sourcePriors);
    stageReports.boost = {
      status: "ran",
      durationMs: Date.now() - boostStart,
      resultCount: results.length,
    };

    if (diversityIsEnabled(req.diversity, results.length)) {
      const divStart = Date.now();
      results = diversityReorder(results, req.diversity, req.candidateLimit);
      stageReports.diversity = {
        status: "ran",
        durationMs: Date.now() - divStart,
        resultCount: results.length,
      };
    }
  }

  // Hydrate the chunk text of the WHOLE pool and fetch the content-hash map, so
  // the caller's dedupe and finalize need no further `index.db` read.
  // `hydrateChunkText` is idempotent, so a caller that re-hydrates is a no-op.
  hydrateChunkText(res.indexDb, results);
  const contentHashByDoc = fetchContentHashByDoc(
    res.indexDb,
    results.map((r) => r.documentId),
  );

  return { results, contentHashByDoc, stageReports, timing, vectorDegraded, notices };
}

/**
 * The vector lane: skip-report assembly + the dim/model degrade guard + the
 * usearch search. Relocated wholesale from the deleted `VectorStage` (only the
 * embed call left, now done upstream), so the skip reasons, the try/catch
 * degrade, and the report shape are byte-identical.
 */
function runVector(
  res: CandidateGenResources,
  req: CandidateGenRequest,
  stageReports: StageReports,
  timing: CandidateGenResult["timing"],
): { candidates: SearchCandidate[]; degraded: boolean } {
  if (req.queryVector === null) {
    // The caller has no embedder attached (so it could not embed the query).
    const reason = SKIP_REASON_NO_EMBEDDER;
    stageReports.vector = { status: "skipped", reason };
    log.debug("Vector: skipped (no embedder)");
    return { candidates: [], degraded: false };
  }

  if (!res.usearchRead) {
    const reason = SKIP_REASON_NO_INDEX;
    stageReports.vector = { status: "skipped", reason };
    log.debug("Vector: skipped (HNSW index not available)");
    return { candidates: [], degraded: false };
  }

  const { hnswOverFetch, alwaysOverFetch } = req.vectorConfig;
  const sqlStart = Date.now();
  let candidates: SearchCandidate[];
  try {
    // Follow the active generation BEFORE comparing model identities. If the
    // pointer just flipped, checking the old handle first would report a model
    // mismatch and return without ever giving the registry a chance to adopt
    // the completed generation. Refresh is inside this degradation boundary
    // because an in-place native re-view can throw on a bad replacement; that
    // request falls back to BM25 and the next one retries.
    res.usearchRead.maybeRefresh();

    // Same-dimension embedder-swap guard. Two models sharing a dimension do NOT
    // make `usearch.search` throw, so a query embedded by the new model while
    // the active generation is still the old one would otherwise rank against
    // incompatible vectors.
    const activeModelId = res.usearchRead.activeModelId?.() ?? null;
    if (req.queryModelId != null && activeModelId != null && req.queryModelId !== activeModelId) {
      const reason = SKIP_REASON_REINDEXING;
      stageReports.vector = { status: "skipped", reason };
      log.warn(
        `Vector: skipped (query model "${req.queryModelId}" != active generation "${activeModelId}", mid-embedder-swap)`,
      );
      return { candidates: [], degraded: true };
    }

    candidates = hnswSearchCandidates(
      res.usearchRead,
      res.indexDb,
      req.queryVector,
      req.filters,
      req.candidateLimit,
      {
        documentIds: req.allowedDocumentIds,
        hnswOverFetch,
        alwaysOverFetch,
      },
    );
  } catch (err) {
    // A refresh failure or query/index dimension mismatch during an embedder
    // swap degrades to BM25 rather than failing the request. The registry does
    // not stamp a failed target/signature, so the next search retries it.
    const reason = SKIP_REASON_REINDEXING;
    stageReports.vector = { status: "skipped", reason };
    log.warn(
      `Vector: skipped (HNSW refresh/search failed, likely mid-embedder-swap): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { candidates: [], degraded: true };
  }

  const sqlMs = Date.now() - sqlStart;
  // The embed happens upstream; the reported `durationMs` recombines the
  // caller's embed time with this SQL time, so the vector report matches the
  // pre-extraction single-stage measurement.
  const durationMs = req.embedMs + sqlMs;
  timing.vectorMs = durationMs;
  timing.vectorCandidates = candidates.length;
  stageReports.vector = {
    status: "ran",
    durationMs,
    candidates: candidates.length,
    effectiveK: req.candidateLimit * hnswOverFetch,
    embedMs: req.embedMs,
    sqlMs,
    engine: "hnsw",
  };
  log.info(
    `Vector: ${candidates.length} candidates in ${durationMs}ms ` +
      `(embed=${req.embedMs}ms sql=${sqlMs}ms engine=hnsw)`,
  );
  return { candidates, degraded: false };
}

/**
 * Fusion: relocated verbatim from the deleted `FusionStage`. Fuses up to
 * `candidateLimit` rows (headroom for the later content-hash dedupe), branching
 * on whether an embedder is attached to serve the vector lane.
 */
function fuse(
  req: CandidateGenRequest,
  bm25Candidates: SearchCandidate[],
  vectorCandidates: SearchCandidate[],
  stageReports: StageReports,
): SearchResultItem[] {
  const poolLimit = req.candidateLimit;

  // Always fuse through RRF, even when the vector lane contributed nothing.
  // The fused score family is what the rest of the pipeline is calibrated to:
  // source priors are additive at the RRF scale, and the rank bonuses only
  // mean anything against RRF-shaped scores. Falling back to raw BM25 scores
  // here would silently neutralise both. Only the reported method reflects
  // whether the vector lane actually ran.
  const fused = rrfFuse(bm25Candidates, vectorCandidates, {
    k: req.settings.params.rrfK,
    bm25Weight: req.settings.params.bm25Weight,
    vectorWeight: req.settings.params.vectorWeight,
    limit: poolLimit,
    topRankBonus: req.settings.params.topRankBonus,
    nearTopRankBonus: req.settings.params.nearTopRankBonus,
  });
  stageReports.fusion = req.embedderPresent
    ? {
        status: "ran",
        method: "rrf",
        rrfK: req.settings.params.rrfK,
        bm25Weight: req.settings.params.bm25Weight,
        vectorWeight: req.settings.params.vectorWeight,
        resultCount: fused.length,
      }
    : { status: "ran", method: "bm25-only", resultCount: fused.length };
  return fused;
}

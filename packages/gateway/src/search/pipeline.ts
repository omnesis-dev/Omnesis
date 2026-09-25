// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SearchPipeline — orchestrates the search stages.
 *
 * Orchestration: the heavy candidate-generation block — BM25, vector, fusion,
 * boost, and diversity — lives in the synchronous `runCandidateGen` core
 * (`./candidate-gen.ts`), which both this pipeline and (a later slice) a search
 * worker call over byte-identical inputs. The pipeline runs the async / cross-
 * store work that must stay on the caller's thread around that core: it
 * assembles a shared `SearchStageContext`, embeds the query, delegates to
 * `runCandidateGen`, then runs RefCount and the bounded finalize, and maps the
 * context onto the response.
 *
 * The orchestrator class is the only thing that
 * lives here; filter merging is in `./filters.ts` and facet building
 * in `./facets.ts`.
 *
 * The `from:`/`to:` person filter is now resolved to
 * a docId set BEFORE the candidate stages run — so the
 * `resultLimit` contract holds even on selective person filters.
 * `PersonFilterStage` is gone; BM25 + vector apply the docId
 * restriction in their candidate SQL directly.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createLogger,
  experimentalVisible,
  parseSourceKey,
  resolveSourcePatterns,
} from "@omnesis/core";
import { getSourcePriorDefaults } from "../source-prior-defaults.js";
import {
  canonicalRowKey,
  reconstructRowKey,
  type BoundDocumentBinding,
  type BoundRowKey,
  type BoundRowResolver,
} from "../analytics/bound-documents.js";
import {
  resolveSearchSettings,
  resolveDiversityConfig,
  resolveSourcePriorsConfig,
  resolveVectorConfig,
} from "./search-config.js";
import { parseQuery, pillTokenForRoles } from "./query-parser.js";
import { resolvePersonDocIds } from "./person-filter.js";
import { shouldBrowse } from "./browse.js";
import { mergeFilters } from "./filters.js";
import { buildFacets } from "./facets.js";
import { dedupeByContentHashWith } from "./dedupe.js";
import { describeQuery } from "./query-log.js";
import { runCandidateGen } from "./candidate-gen.js";
import { RefCountStage, type SearchStageContext } from "./stages/index.js";
import type { SearchWorkerPool } from "../workers/search-pool.js";
import type {
  CandidateGenRequest,
  CandidateGenResources,
  CandidateGenResult,
} from "./candidate-gen.js";
import type { Embedder } from "../indexer/types.js";
import type { SearchConfig } from "./search-config.js";
import type { SourceDocCount } from "./source-isf-prior.js";
import type {
  SearchResultItem,
  LinkRefSource,
  QueryEnricher,
  SearchFilters,
  SearchNotice,
  SearchQuery,
  SearchResponse,
} from "./types.js";

const log = createLogger("gateway:search");

/** Default column cap for a search hit's `boundRow` projection — rows
 * can be wide; surface a headline subset, never the whole row. */
const BOUND_ROW_COLUMNS = 12;

export interface SearchPipelineOptions {
  indexDb: Db;
  embedder?: Embedder;
  usearchRead?: import("../indexer/usearch-index.js").VectorReadSource;
  searchConfig?: SearchConfig;
  /** Model identifier for the embedder — surfaced in SearchResponse.models.embedding. */
  embeddingModelId?: string;
  /**
   * People-graph resolver for `from:`/`to:`/`me` token resolution
   * Concrete impl built from `people.ts` in `index.ts`
   * — `search/` has no compile-time edge into the people subsystem.
   * When omitted, `from:`/`to:` filters fall through silently (test
   * path that doesn't wire a gateway DB).
   */
  queryEnricher?: QueryEnricher;
  /**
   * Inbound-ref source for the post-fusion `RefCountStage`
   * Concrete impl built from `links.ts` in `index.ts`.
   * Stage stays disabled when omitted.
   */
  linkRefSource?: LinkRefSource;
  /**
   * Optional scheduler-introspection callback. When provided, the
   * pipeline calls it at the start of every search and emits an
   * inflight summary on the slow-search log line. Used to attribute
   * slow searches to concurrent writer / background work.
   */
  inflightSummary?: () => Array<{
    runner: string;
    tasks: Array<{ name: string; priority: string; ageMs: number }>;
  }>;
  /**
   * Reader for source-advertised default score priors. Each entry maps
   * a source-type prefix to an additive search-score adjustment.
   * Merged into the resolved sourcePriors config — user
   * `search.sourcePriors.weights` from `omnesis.json` still wins per
   * key. Defaults to the gateway's process-level registry; tests can
   * inject a fixed map.
   */
  getSourcePriorDefaults?: () => Record<string, number>;
  /**
   * Live per-source document counts, used to derive automatic
   * inverse-source-frequency priors when `search.sourcePriors.
   * autoInverseFrequency.enabled` is set. Defaults to none (the auto prior is
   * inert); the gateway injects a cached reader over `source_stats`.
   */
  getSourceDocCounts?: () => readonly SourceDocCount[];
}

export class SearchPipeline {
  private indexDb: Db;
  private embedder?: Embedder;
  private searchConfig?: SearchConfig;
  private gatewayDb?: Db;
  private embeddingModelId?: string;
  private queryEnricher?: QueryEnricher;
  private linkRefSource?: LinkRefSource;
  private usearchRead?: import("../indexer/usearch-index.js").VectorReadSource;
  private inflightSummary?: SearchPipelineOptions["inflightSummary"];
  private getSourcePriorDefaults: () => Record<string, number>;
  private getSourceDocCounts: () => readonly SourceDocCount[];
  private boundRowResolver?: BoundRowResolver;
  /**
   * The one stage the pipeline still orchestrates on the caller's thread: a
   * cross-store `omnesis.db` enrichment that runs AFTER candidate generation
   * and never re-sorts, so the pool order the core produced survives it.
   * BM25, vector, fusion, boost, and diversity all live in the synchronous
   * candidate-generation core (`runCandidateGen`), and the person filter is
   * pushed into the candidate SQL via `allowedDocumentIds`.
   */
  private readonly refCountStage = new RefCountStage();
  /**
   * Optional dedicated search-worker pool. When wired, ready, and not
   * saturated, candidate generation runs OFF the main event loop on a worker
   * thread; on any worker problem the pipeline degrades to the identical
   * `runCandidateGen` inline on main (byte-identical result). `undefined` (the
   * test path and `gateway.searchWorker.concurrency: 0`) means pure main-thread
   * candidate-gen — the pre-Slice-3B behaviour.
   */
  private searchWorkerPool?: SearchWorkerPool;
  /**
   * Why candidate generation fell back to the main thread, for benchmark
   * observability. `saturated`: pool present but at/over its inflight ceiling
   * (or not-yet-ready/disposed); `error`: a worker call rejected; `unconfigured`:
   * no pool wired. Never surfaced in the response — a counters snapshot for the
   * bench harness / a future /admin/metrics line.
   */
  private searchWorkerFallbacks = { saturated: 0, error: 0, unconfigured: 0 };

  constructor(opts: SearchPipelineOptions) {
    this.indexDb = opts.indexDb;
    this.embedder = opts.embedder;
    this.searchConfig = opts.searchConfig;
    this.embeddingModelId = opts.embeddingModelId;
    this.queryEnricher = opts.queryEnricher;
    this.linkRefSource = opts.linkRefSource;
    this.usearchRead = opts.usearchRead;
    this.inflightSummary = opts.inflightSummary;
    this.getSourcePriorDefaults = opts.getSourcePriorDefaults ?? getSourcePriorDefaults;
    this.getSourceDocCounts = opts.getSourceDocCounts ?? (() => []);
  }

  /** Inject (or replace) the people-graph resolver. */
  setQueryEnricher(enricher: QueryEnricher): void {
    this.queryEnricher = enricher;
  }

  /** Inject (or replace) the link-ref source. */
  setLinkRefSource(source: LinkRefSource): void {
    this.linkRefSource = source;
  }

  /** Attach the gateway database for ref count lookups in search results. */
  setGatewayDb(db: Db): void {
    this.gatewayDb = db;
  }

  /**
   * Attach the cross-store resolver (the `AnalyticsDb`) so that, when a request
   * sets `includeBoundRow`, hits whose source declares a `boundDocument`
   * carry their co-described analytics row. No-op until set (test path).
   */
  setBoundRowResolver(resolver: BoundRowResolver): void {
    this.boundRowResolver = resolver;
  }

  /**
   * Attach (or clear) the query embedder after construction. Attaching happens
   * once the indexer loads the model and on every atomic flip. Clearing
   * (`undefined`) is the immediate hard-cutover step: it stops query
   * embedding from calling the old model the instant a hard cutover is
   * confirmed, so vector search degrades cleanly to BM25-only for the
   * documented downtime window instead of embedding queries with a now-invalid
   * old-dimension model against a wiped/new index.
   */
  setEmbedder(embedder: Embedder | undefined): void {
    this.embedder = embedder;
    log.info(
      embedder
        ? "Search pipeline: embedder attached, vector search enabled"
        : "Search pipeline: embedder cleared, vector search degraded to BM25-only",
    );
  }

  /**
   * Attach (or clear) the dedicated search-worker pool. Wired at boot when
   * `gateway.searchWorker.concurrency > 0`. Clearing (`undefined`) reverts to
   * pure main-thread candidate generation.
   */
  setSearchPool(pool: SearchWorkerPool | undefined): void {
    this.searchWorkerPool = pool;
    log.info(
      pool
        ? "Search pipeline: worker pool attached — candidate generation runs off the main thread when the pool has headroom"
        : "Search pipeline: worker pool cleared — candidate generation runs inline on the main thread",
    );
  }

  /** Fallback-reason counters (benchmark observability). Returns a snapshot copy. */
  getSearchWorkerFallbacks(): { saturated: number; error: number; unconfigured: number } {
    return { ...this.searchWorkerFallbacks };
  }

  /** The main-thread candidate-gen substrate — the fallback for a worker fault. */
  private mainResources(): CandidateGenResources {
    return { indexDb: this.indexDb, usearchRead: this.usearchRead };
  }

  /**
   * Delegate-or-fallback gate for candidate generation (mirrors the io-pool
   * posture). Delegates to the worker while the pool is wired, ready, not
   * disposed, and below its inflight ceiling; otherwise — or on any worker
   * rejection — runs the IDENTICAL `runCandidateGen` inline on the main thread.
   * The fallback is byte-identical because it is the same function over the same
   * `index.db` + usearch read handle; the only observable difference is that
   * main's event loop blocks for that one query. Search is therefore never
   * failed by a worker problem — it degrades to pre-Slice-3B behaviour.
   */
  private async candidateGen(req: CandidateGenRequest): Promise<CandidateGenResult> {
    const pool = this.searchWorkerPool;
    if (pool && pool.isReady && pool.inflightCount < pool.maxInflightBeforeFallback) {
      try {
        return await pool.candidateGen(req);
      } catch (err) {
        // Worker crashed / exited / init-failed / call rejected. Never fail the
        // search on a dead worker — degrade to the identical main-thread code.
        this.searchWorkerFallbacks.error += 1;
        log.warn(
          `search-worker candidate-gen failed, running on main: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return runCandidateGen(this.mainResources(), req);
      }
    }
    // Saturated (or not-yet-ready / disposed) pool, or no pool at all.
    this.searchWorkerFallbacks[pool ? "saturated" : "unconfigured"] += 1;
    return runCandidateGen(this.mainResources(), req);
  }

  async search(
    query: SearchQuery,
    authorization?: { readonly sourceIds: readonly string[] },
  ): Promise<SearchResponse> {
    const startMs = Date.now();
    // Capture the scheduler's inflight state at search start so we can
    // attribute a slow search to whatever writer / background work was
    // concurrent. Empty array when no scheduler is wired (test path) or
    // when no tasks are in flight (quiet gateway).
    const inflightAtStart = this.inflightSummary?.() ?? [];

    const parsed = parseQuery(query.text);
    const effectiveText = parsed.text;
    const filters = mergeFilters(parsed.filters, query.filters);
    // Pipeline collects its own notices alongside the parser's so
    // the response carries one merged feedback channel.
    const notices: SearchNotice[] = [...parsed.notices];
    log.debug(
      `Query parsed: text=${describeQuery(effectiveText)}, filterKeys=${Object.keys(parsed.filters).join(",")}`,
    );

    const settings = resolveSearchSettings(this.searchConfig);
    // BM25 always runs. The vector lane joins it once an embedder is
    // attached; until then — a cold install, a model swap, an index still
    // warming — keyword matching serves the query on its own.
    log.debug(`Search lanes: bm25=true, vector=${!!this.embedder}`);

    if (settings.defaultFilters) {
      const merged = mergeFilters(settings.defaultFilters, filters);
      Object.assign(filters, merged);
    }

    // Cognitive projection (experimental, opt-in): surface the hidden cognitive
    // mirrors (open loops) in ordinary search so the understanding layer is
    // searchable. Gated on experimental — a non-experimental gateway can never
    // set it, so its search is byte-identical to before this flag existed. The
    // The boost pass down-weights the surfaced mirrors so they don't crowd out docs.
    if (query.cognitiveProjection && experimentalVisible()) {
      filters.includeHidden = true;
    }

    // Expand user-facing source filters into the concrete configured
    // source IDs they cover. Handles four shapes: exact source ID
    // (`gmail:alice@x.com`), bare source type (`gmail`), exact provider
    // ID (`google:alice@x.com`), bare provider type (`google`). Values
    // that don't match any configured source are preserved verbatim so
    // the downstream IN-clause resolves to zero rows; the expansion
    // pushes a `source` notice for each one so the caller learns why.
    this.expandSourcePatterns(filters, notices);

    // A corpus authorization is a hard server-derived boundary, not another
    // user/config filter. Apply it only after all ordinary source patterns and
    // defaults have been expanded, and before either candidate lane runs.
    // Empty intersections deliberately become an impossible source id because
    // an empty sourceIds array means "unfiltered" to the search stages.
    if (authorization) {
      const permitted = new Set(authorization.sourceIds);
      const intersection = filters.sourceIds
        ? filters.sourceIds.filter((sourceId) => permitted.has(sourceId))
        : [...permitted];
      filters.sourceIds =
        intersection.length > 0 ? intersection : ["\u0000omnesis:no-authorized-source"];
    }

    // Resolve every `from:`/`to:`/`with:` PersonFilter to a docId
    // set BEFORE the candidate stages run, so BM25 + vector apply
    // the restriction in their SQL and the limit is enforced AFTER
    // the filter. `undefined` means "no person filter active"; an
    // empty array means "person filter resolved to zero docs" —
    // stages short-circuit to no candidates. Multiple PersonFilters
    // intersect, so `from:alice to:bob` yields docs where alice
    // sends AND bob receives rather than collapsing both refs into
    // the same role bucket. Unresolved person refs (`from:typo`) push
    // a `person` notice so the caller learns why the result set is
    // empty rather than guessing.
    const allowedDocumentIds = this.resolveAllowedDocumentIds(filters, notices);

    const ctx: SearchStageContext = {
      query,
      effectiveText,
      parsedFilters: parsed.filters,
      filters,
      settings,
      limit: query.limit ?? settings.params.resultLimit,
      candidateLimit: settings.params.candidateLimit,
      allowedDocumentIds,
      vectorConfig: resolveVectorConfig({
        ...this.searchConfig,
        vector: { ...this.searchConfig?.vector, ...query.vector },
      }),
      sourcePriors: resolveSourcePriorsConfig(this.searchConfig, this.getSourcePriorDefaults(), {
        docCounts: this.getSourceDocCounts(),
        rrfK: settings.params.rrfK,
      }),
      diversity: resolveDiversityConfig(this.searchConfig),
      commonTokenThreshold: this.searchConfig?.bm25?.commonTokenThreshold ?? 0.1,
      results: [],
      timing: { totalMs: 0 },
      stageReports: {},
      deps: {
        indexDb: this.indexDb,
        gatewayDb: this.gatewayDb,
        linkRefSource: this.linkRefSource,
      },
    };

    // Orchestration:
    //   1. Pre-stage (done above, on this thread): parse, filter merge,
    //      settings resolve, source-pattern expand, person-filter resolve.
    //   2. Embed the query on this thread — the candidate-gen core is embedder-
    //      agnostic, so the caller owns the model. Hybrid path only.
    //   3. Candidate generation (`runCandidateGen`, synchronous): browse OR
    //      bm25 + vector + fusion + boost + diversity, plus full-pool chunk-text
    //      hydration and the content-hash map. This is the heavy block a later
    //      slice relocates to a worker; today it runs inline.
    //   4. RefCount (this thread), then the bounded finalize.

    const mode: "browse" | "hybrid" = shouldBrowse(effectiveText, allowedDocumentIds, filters)
      ? "browse"
      : "hybrid";

    let queryVector: Float32Array | null = null;
    let embedMs = 0;
    if (mode === "hybrid") {
      // Embed on this thread, only when an embedder is attached; otherwise
      // `queryVector` stays null and the core records the vector-skip reason.
      // An embed throw propagates (the search fails rather than silently
      // degrading) — only the usearch dimension mismatch degrades to BM25,
      // inside the core.
      if (this.embedder) {
        const embedStart = Date.now();
        queryVector = await this.embedder.embedQuery(effectiveText);
        embedMs = Date.now() - embedStart;
      }
    }

    const cg = await this.candidateGen({
      mode,
      bm25Text: effectiveText,
      embedderPresent: !!this.embedder,
      queryVector,
      embedMs,
      // The query-model / active-generation compare that closes the
      // same-dimension embedder-swap hole is wired through the core (see
      // `runVector`), but stays inert here: the pipeline's `embeddingModelId`
      // is the catalog id, while the active generation's `embed_model` is the
      // canonical `(name, dim)` stamp (a file name for a local model) — two
      // namespaces that do not compare equal even in the healthy steady
      // state, so passing it would false-positive-degrade a healthy embedder.
      // Plumbing the canonical query-model identity (including across
      // `setEmbedder` swaps) belongs with a later slice; until then this
      // is null and the compare is a no-op.
      queryModelId: null,
      filters,
      allowedDocumentIds,
      candidateLimit: ctx.candidateLimit,
      limit: ctx.limit,
      settings,
      vectorConfig: ctx.vectorConfig,
      sourcePriors: ctx.sourcePriors,
      diversity: ctx.diversity,
      commonTokenThreshold: ctx.commonTokenThreshold,
    });

    // Merge the core's outputs back onto the shared context so the downstream
    // main-thread stages and the response mapping see them as if the stages had
    // run inline.
    ctx.results = cg.results;
    Object.assign(ctx.stageReports, cg.stageReports);
    if (cg.timing.bm25Ms !== undefined) ctx.timing.bm25Ms = cg.timing.bm25Ms;
    if (cg.timing.bm25Candidates !== undefined)
      ctx.timing.bm25Candidates = cg.timing.bm25Candidates;
    if (cg.timing.vectorMs !== undefined) ctx.timing.vectorMs = cg.timing.vectorMs;
    if (cg.timing.vectorCandidates !== undefined)
      ctx.timing.vectorCandidates = cg.timing.vectorCandidates;
    for (const notice of cg.notices) notices.push(notice);

    // RefCount enriches both paths and never re-sorts, so the pool order the
    // core produced is what the finalize slices.
    if (this.refCountStage.isEnabled(ctx)) {
      await this.refCountStage.execute(ctx);
    }

    // Final pass: collapse byte-identical documents (Drive re-uploads,
    // duplicate page captures, etc.) so a top-k frame of all-duplicates doesn't
    // drown out a single distinct answer. Fusion already dedupes by
    // `document_id`; this pass dedupes by `content_hash` — consuming the map
    // the core fetched, so finalize issues no `index.db` read. It operates on
    // the full pool (capped at `candidateLimit`) and slices to `limit`. The
    // final chunk-text hydration the pipeline used to do here is gone: the core
    // hydrated the whole pool, so every survivor already carries its text.
    // Facets are built off the deduped frame so the counts match what the
    // caller sees.
    ctx.results = dedupeByContentHashWith(cg.contentHashByDoc, ctx.results, ctx.limit);
    this.hydrateMetadataFields(ctx.results);
    if (query.includeBoundRow) await this.hydrateBoundRows(ctx.results);

    const facets = buildFacets(ctx.results);
    ctx.timing.totalMs = Date.now() - startMs;

    log.info(
      `Search ${describeQuery(query.text)}: ${ctx.results.length} results in ${ctx.timing.totalMs}ms`,
    );

    // Slow-search diagnostic. Phase-0 instrumentation: when a search
    // exceeds the soft threshold, dump per-stage timings (with the
    // vector stage's embed/sql split) and the scheduler's inflight
    // tasks at search start. The inflight summary is what tells us
    // whether the stall coincided with a writer-worker upsert, an
    // indexer batch, a backfill drip, etc.
    const SLOW_THRESHOLD_MS = 1000;
    if (ctx.timing.totalMs > SLOW_THRESHOLD_MS) {
      const stageSummary = Object.entries(ctx.stageReports)
        .map(([name, r]) => {
          if (!r) return `${name}=skip`;
          if (r.status === "skipped") return `${name}=skip`;
          if (name === "vector") {
            return `vector=${r.durationMs}ms[embed=${r.embedMs ?? "?"}ms,sql=${r.sqlMs ?? "?"}ms]`;
          }
          return `${name}=${r.durationMs ?? "?"}ms`;
        })
        .join(" ");
      const inflightSummary =
        inflightAtStart.length === 0
          ? "idle"
          : inflightAtStart
              .map((r) => {
                const taskList = r.tasks
                  .map((t) => `${t.name}@${t.priority}/${t.ageMs}ms`)
                  .join(",");
                return `${r.runner}=[${taskList}]`;
              })
              .join(" ");
      log.warn(
        `Slow search ${describeQuery(query.text)} ${ctx.timing.totalMs}ms ` +
          `stages=${stageSummary} inflightAtStart=${inflightSummary}`,
      );
    }

    return {
      results: ctx.results,
      models: {
        embedding: this.embedder ? this.embeddingModelId : undefined,
      },
      query: {
        original: query.text,
        parsedFilters: Object.keys(parsed.filters).length > 0 ? parsed.filters : undefined,
        effectiveText: effectiveText !== query.text ? effectiveText : undefined,
      },
      timing: ctx.timing,
      stages: Object.keys(ctx.stageReports).length > 0 ? ctx.stageReports : undefined,
      facets,
      notices: notices.length > 0 ? notices : undefined,
      debug: query.verbose ? this.buildDebug(query) : undefined,
    };
  }

  private buildDebug(query: SearchQuery): import("./types.js").SearchDebug {
    return {
      modelState: {
        vector: this.embedder ? "ready" : "unavailable",
      },
      query: {
        inputLength: query.text.length,
      },
    };
  }

  /**
   * Resolve each PersonFilter to a concrete set of allowed
   * `document_id` values via `document_people`, then intersect across
   * filters. Two PersonFilters AND together (one bucket per filter
   * intent — `from:`/`to:`/`with:` — so the user can express
   * "alice sends AND bob receives" rather than collapsing both refs
   * into a single role bucket).
   *
   * Returns:
   *   - `undefined` when no person filter is active, so candidate
   *     stages skip the docId restriction entirely.
   *   - `[]` when any PersonFilter resolves to zero docs (or when no
   *     ref in a bucket found a canonical person) — every candidate
   *     stage short-circuits to no candidates, matching the documented
   *     contract that `from:nobody-real` returns zero results rather
   *     than silently widening to a plain-text search.
   *
   * A ref that resolves to nobody pushes a `person` notice either way,
   * at the level its consequence earns: `error` when it left its bucket
   * empty and the response therefore carries no results, `warning` when
   * a sibling ref in the same OR bucket still resolved.
   */
  private resolveAllowedDocumentIds(
    filters: SearchFilters,
    notices: SearchNotice[],
  ): readonly string[] | undefined {
    const personFilters = filters.personFilters;
    if (!personFilters || personFilters.length === 0) return undefined;
    if (!this.queryEnricher) return undefined;
    const enricher = this.queryEnricher;

    // Resolve every ref before short-circuiting. Running the enricher
    // for each ref (instead of returning early on the first
    // empty-resolve) lets test doubles and instrumentation pin the
    // parser-to-enricher contract: a query like `from:alice to:bob`
    // ALWAYS asks the enricher about both alice and bob, even if
    // alice is unknown. Refs that don't resolve push a `person`
    // notice so the caller learns what the filter did with them.
    const resolvedPerBucket: string[][] = personFilters.map((pf) => {
      const ids: string[] = [];
      // Held back rather than pushed where they are found. Refs inside one
      // bucket OR together (`from:maya from:jamie` means either), so whether
      // an unresolved ref killed the filter or merely narrowed it is not
      // knowable until every ref in the bucket has been tried — and an
      // `error` saying the filter resolves to zero docs, shipped in the same
      // body as the documents a sibling ref matched, contradicts itself.
      const unresolved: { token: string; reason: string }[] = [];
      for (const ref of pf.refs) {
        if (ref.toLowerCase() === "me") {
          const selfId = enricher.getSelfPersonId();
          if (selfId) ids.push(selfId);
          else {
            unresolved.push({
              token: `${pillTokenForRoles(pf.roles)}:me`,
              reason:
                "`me` resolves to the self-person, but no self-person is elected on this gateway.",
            });
          }
        } else {
          const matched = enricher.resolvePersonIds(ref);
          if (matched.length === 0) {
            unresolved.push({
              token: `${pillTokenForRoles(pf.roles)}:${ref}`,
              reason: `No person in the people graph matches "${ref}" (tried email, phone, name LIKE).`,
            });
          }
          ids.push(...matched);
        }
      }
      // Nothing in the bucket resolved, so this filter is what empties the
      // result set; anything else and the query still runs, restricted to
      // whichever refs did resolve.
      const emptiedTheFilter = ids.length === 0;
      for (const { token, reason } of unresolved) {
        notices.push({
          filter: "person",
          level: emptiedTheFilter ? "error" : "warning",
          token,
          message: emptiedTheFilter
            ? `${reason} Filter resolves to zero docs.`
            : `${reason} The filter still resolves through the other ref(s) it names.`,
        });
      }
      return ids;
    });

    // Any bucket whose refs resolve to no canonical person → the
    // AND intersection is empty, regardless of the other buckets.
    if (resolvedPerBucket.some((ids) => ids.length === 0)) return [];

    // Without a gateway DB we can't translate personIds → docIds.
    // Leave the candidate stages unrestricted so test paths that
    // skip the people-graph wiring still return results.
    if (!this.gatewayDb) return undefined;

    let intersection: Set<string> | undefined;
    for (let i = 0; i < personFilters.length; i++) {
      const docIds = resolvePersonDocIds(
        this.gatewayDb,
        resolvedPerBucket[i],
        personFilters[i].roles,
      );
      if (docIds.length === 0) {
        // Person(s) resolved but have zero documents in the requested
        // role — push an info notice so the caller understands why the
        // result set is empty rather than guessing.
        const pf = personFilters[i];
        const refStr = pf.refs.join(", ");
        const roleDesc = pf.roles ? pf.roles.join("/") : "any";
        notices.push({
          filter: "person",
          level: "info",
          token: `${pillTokenForRoles(pf.roles)}:${pf.refs[0]}`,
          message: `Person "${refStr}" was found but has no documents with role ${roleDesc}. Filter resolves to zero docs.`,
        });
        return [];
      }
      if (intersection === undefined) {
        intersection = new Set(docIds);
      } else {
        const next = new Set<string>();
        for (const id of docIds) if (intersection.has(id)) next.add(id);
        intersection = next;
        if (intersection.size === 0) return [];
      }
    }
    return intersection ? [...intersection] : undefined;
  }

  /**
   * Expand user-facing `source:<value>` filter tokens to the concrete
   * set of configured source IDs they cover. Routes through
   * `resolveSourcePatterns` from `@omnesis/core` so the CLI (`sync`,
   * `add`, …) and the search filter share one grammar: source ID,
   * source type, provider ID, and provider type all work, with or
   * without trailing colon / `*` wildcard. The mapping it matches
   * against is the (`provider_id`, `source_id`) pairs that appear in
   * the gateway's `documents` table — that's the authoritative source
   * of "which sources actually exist," and the compound
   * `(provider_id, source_id)` index makes the DISTINCT scan cheap.
   *
   * Returns the unique-but-set-deduped expansion. A value that
   * resolves to no entries is preserved verbatim so the downstream
   * `source_id IN (?)` clause produces zero rows, matching the
   * `source:nope` contract.
   */
  private expandSourcePatterns(filters: SearchFilters, notices: SearchNotice[]): void {
    if (!filters.sourceIds || filters.sourceIds.length === 0) return;
    if (!this.gatewayDb) return;
    const entries = this.gatewayDb
      .prepare<[], { provider_id: string; source_id: string }>(
        `SELECT DISTINCT provider_id, source_id FROM documents`,
      )
      .all()
      .map((r) => ({ id: r.source_id, providerId: r.provider_id }));

    const expanded: string[] = [];
    let anyExpansion = false;
    const seen = new Set<string>();
    for (const raw of filters.sourceIds) {
      const matches = resolveSourcePatterns([raw], entries);
      if (matches.length === 0) {
        notices.push({
          filter: "source",
          level: "error",
          token: `source:${raw}`,
          message: `No configured source matches "${raw}". Filter resolves to zero docs (accepted forms: full source ID like \`gmail:user@x.com\`, bare source type like \`gmail\`, provider ID like \`google:user@x.com\`, bare provider type like \`google\`).`,
        });
        if (!seen.has(raw)) {
          expanded.push(raw);
          seen.add(raw);
        }
        continue;
      }
      if (matches.length === 1 && matches[0] === raw) {
        if (!seen.has(raw)) {
          expanded.push(raw);
          seen.add(raw);
        }
        continue;
      }
      anyExpansion = true;
      notices.push({
        filter: "source",
        level: "info",
        token: `source:${raw}`,
        message: `Expanded "${raw}" to ${matches.length} source${matches.length === 1 ? "" : "s"}: ${matches.join(", ")}.`,
      });
      for (const m of matches) {
        if (!seen.has(m)) {
          expanded.push(m);
          seen.add(m);
        }
      }
    }
    if (anyExpansion) filters.sourceIds = expanded;
  }

  /**
   * Batch-hydrate the openable links (`sourceUrl`, `appUrl`) and `mimeType`
   * from the gateway DB's `documents.metadata` JSON blob onto search
   * results, in a single query over the final result set. The denormalized
   * `chunks` table carries no `appUrl`, and its `source_url` can hold the
   * canonical form used for link matching (lowercased deep links, Gmail's
   * `#message/` key), which is not a link a client can open.
   */
  private hydrateMetadataFields(results: import("./types.js").SearchResultItem[]): void {
    if (!this.gatewayDb || results.length === 0) return;
    const ids = results.map((r) => r.documentId);
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.gatewayDb
      .prepare<
        string[],
        { id: string; source_url: string | null; app_url: string | null; mime_type: string | null }
      >(
        `SELECT id,
                json_extract(metadata, '$.sourceUrl') as source_url,
                json_extract(metadata, '$.appUrl') as app_url,
                json_extract(metadata, '$.extra.mimeType') as mime_type
         FROM documents WHERE id IN (${placeholders})`,
      )
      .all(...ids);
    const map = new Map(rows.map((r) => [r.id, r]));
    for (const result of results) {
      const row = map.get(result.documentId);
      if (!row) continue;
      result.sourceUrl = row.source_url ?? undefined;
      if (row.app_url) result.appUrl = row.app_url;
      if (row.mime_type) result.mimeType = row.mime_type;
    }
  }

  /**
   * Post-fusion cross-store hydration. For each result document whose
   * source declares a `boundDocument`, look up its co-described DuckDB row and
   * attach a bounded projection as `boundRow` — the structural answer to "BM25
   * can't reach analytics rows": a hit on the Strava/Notion/finance document
   * now carries its row. One batched DuckDB lookup per table over the final,
   * already-sliced result frame. A missing row attaches nothing (the binding
   * self-heals across the storage boundary); a lookup error is swallowed so a
   * cross-store hiccup never breaks search.
   */
  private async hydrateBoundRows(results: import("./types.js").SearchResultItem[]): Promise<void> {
    const resolver = this.boundRowResolver;
    if (!resolver || !this.gatewayDb || results.length === 0) return;

    const bindings = await resolver.getBoundDocumentBindings();
    if (bindings.size === 0) return;

    // external_id isn't denormalized into the chunk index — batch-fetch it.
    const ids = results.map((r) => r.documentId);
    const placeholders = ids.map(() => "?").join(",");
    const extRows = this.gatewayDb
      .prepare<
        string[],
        { id: string; external_id: string | null; stream_id: string }
      >(`SELECT id, external_id, stream_id FROM documents WHERE id IN (${placeholders})`)
      .all(...ids);
    const externalById = new Map(
      extRows.map((r) => [r.id, { externalId: r.external_id, streamId: r.stream_id }]),
    );

    interface Cand {
      result: import("./types.js").SearchResultItem;
      binding: BoundDocumentBinding;
      key: BoundRowKey;
    }
    const byTable = new Map<string, Cand[]>();
    for (const result of results) {
      const ident = externalById.get(result.documentId);
      if (ident?.externalId == null) continue;
      const externalId = ident.externalId;
      const tableBindings = bindings.get(parseSourceKey(result.sourceId).sourceType);
      if (!tableBindings) continue;
      for (const binding of tableBindings) {
        const key = reconstructRowKey(
          { externalId, sourceId: result.sourceId, streamId: ident.streamId },
          binding,
        );
        if (!key) continue;
        const list = byTable.get(binding.tableName);
        if (list) list.push({ result, binding, key });
        else byTable.set(binding.tableName, [{ result, binding, key }]);
      }
    }
    if (byTable.size === 0) return;

    for (const [tableName, cands] of byTable) {
      const binding = cands[0].binding;
      const projection = binding.columns.slice(0, BOUND_ROW_COLUMNS);
      const tuples = cands.map((c) => c.key.keyValues);
      let rows: Map<string, Record<string, unknown>>;
      try {
        rows = await resolver.getRowsByKeys(tableName, cands[0].key.keyColumns, tuples, {
          projection,
        });
      } catch {
        continue; // best-effort — a cross-store lookup failure never breaks search
      }
      for (const c of cands) {
        const row = rows.get(canonicalRowKey(c.key.keyValues));
        if (!row) continue;
        c.result.boundRow = {
          tableName,
          tableDisplayName: binding.tableDisplayName,
          primaryKey: c.key.pkString,
          row,
        };
      }
    }
  }
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { SCOPE_ADMIN, SCOPE_READ, scopeSatisfies } from "@omnesis/types";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { agentSearchContextBody, searchBody } from "../schemas/index.js";
import { BadRequestError, ForbiddenError, ServiceUnavailableError } from "../errors.js";
import { searchRateLimiter } from "../../rate-limit.js";
import { hiddenSourceIdsToExclude } from "../../search/hidden-sources.js";
import { likeSearchDocuments } from "../../search/like-search.js";
import { clientIp, isLoopbackRequest } from "./admin/internals.js";
import type { RouteApp } from "./types.js";
import type { SearchQuery } from "../../search/types.js";
import type { SearchPipeline } from "../../search/pipeline.js";
import type { LikeSearchArgs, LikeSearchRow } from "../../search/like-search.js";
import type Database from "better-sqlite3";
import type { SearchPort } from "@omnesis/agent";

type Db = Database.Database;

/** The read-worker capability the legacy LIKE search delegates to. */
export interface SearchIoGate {
  likeSearchDocuments(args: LikeSearchArgs): Promise<LikeSearchRow[]>;
}

const log = createLogger("gateway:http").child("routes:search");

export interface SearchRoutesDeps {
  db: Db;
  searchPipeline?: SearchPipeline;
  /** Canonical unrestricted agent projection; omitted unless search v2 is enabled. */
  agentSearchPort?: SearchPort;
  indexerReadiness?: () =>
    | { status: "spawning"; message?: string }
    | { status: "loading-model"; message?: string; stage?: string; progress?: number }
    | { status: "ready" }
    | { status: "failed"; reason: string }
    | { status: "disabled"; reason: string };
  /** Read-worker gate — when wired, the legacy LIKE scan runs off the main
   *  event loop; absent, it falls back to a synchronous main-thread read. */
  ioGate?: SearchIoGate;
}

/**
 * Hybrid search + readiness endpoints. Registered between /documents/exists
 * and the legacy /documents/search GET.
 */
export function mountSearchRoutes(app: RouteApp, deps: SearchRoutesDeps): void {
  const { db, searchPipeline, indexerReadiness } = deps;
  const searchLimiter = searchRateLimiter();

  if (deps.agentSearchPort) {
    const agentSearchPort = deps.agentSearchPort;
    app.post(
      "/admin/search/agent-context",
      scope.admin(),
      scope.read(),
      validateJson(agentSearchContextBody),
      async (c) => {
        if (c.get("auth").authMethod === "principal-oauth") {
          throw new ForbiddenError("Operator credentials required for agent search context");
        }
        if (!isLoopbackRequest(c) && searchLimiter.consume(clientIp(c))) {
          return c.json({ error: "Too many search requests — try again later" }, 429, {
            "Retry-After": "60",
          });
        }
        const body = c.req.valid("json");
        const signal = c.req.raw.signal;
        signal.throwIfAborted();
        const result = await agentSearchPort.search(
          { query: body.text, limit: body.limit },
          signal,
        );
        signal.throwIfAborted();
        return c.json({
          kind: "search.results" as const,
          query: result.query,
          durationMs: result.durationMs,
          candidates: result.totalCandidates,
          results: result.results,
        });
      },
    );
  }

  app.get("/search/readiness", scope.read(), (c) => {
    const indexer = indexerReadiness?.() ?? { status: "ready" as const };
    const auth = c.get("auth");
    const agentContextAvailable =
      !!deps.agentSearchPort &&
      auth.authMethod !== "principal-oauth" &&
      scopeSatisfies(auth.scopes, SCOPE_ADMIN) &&
      scopeSatisfies(auth.scopes, SCOPE_READ);
    // Bearer and portal read scopes cover all sources. OAuth principals use
    // separately scoped grants and must never receive this unrestricted graph.
    const graphContextAvailable =
      !!searchPipeline?.agentSearchV2Enabled && auth.authMethod !== "principal-oauth";
    return c.json({
      indexer,
      ...(agentContextAvailable ? { agentContextAvailable: true } : {}),
      ...(graphContextAvailable ? { graphContextAvailable: true } : {}),
    });
  });

  app.post("/search", scope.read(), validateJson(searchBody), async (c) => {
    // Per-IP rate limit: defence-in-depth against a runaway/abusive
    // client pinning the search pipeline on an exposed gateway. Loopback is
    // exempt — a same-host client already has full local access, so the limit
    // buys nothing there, and throttling it would break local automation like
    // the eval harness (which fires hundreds of queries back-to-back). The
    // exemption checks the raw socket, so a forwarded `127.0.0.1` can't spoof
    // it.
    if (!isLoopbackRequest(c) && searchLimiter.consume(clientIp(c))) {
      return c.json({ error: "Too many search requests — try again later" }, 429, {
        "Retry-After": "60",
      });
    }
    if (!searchPipeline) {
      throw new ServiceUnavailableError("Search pipeline not available");
    }

    const validated = c.req.valid("json");
    const { includeGraphContext, ...body } = validated as typeof validated & SearchQuery;
    // `cognitiveProjection` is an AGENT-internal knob (the agent search port sets
    // it in-process under experimental mode). The body schema is passthrough, so
    // strip it here to keep the public /search route byte-identical — a client
    // can never surface the hidden cognitive mirrors through unscoped search.
    delete body.cognitiveProjection;

    try {
      const graphContext =
        includeGraphContext === true &&
        searchPipeline.agentSearchV2Enabled &&
        c.get("auth").authMethod !== "principal-oauth";
      const response = graphContext
        ? await searchPipeline.search(body, undefined, { graphContext: true })
        : await searchPipeline.search(body);
      return c.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Search failed: ${message}`);
      throw err;
    }
  });

  // Legacy LIKE search (registered immediately after the new /search POST in
  // the original — server.ts:2671). Lives on /documents/search so it sits
  // before the greedy /documents/:id catch-all. The unindexable leading-wildcard
  // scan runs on the read-worker pool when a gate is wired; the source-registry
  // read (`hiddenSourceIdsToExclude`) stays on the main thread and is passed in.
  app.get("/documents/search", scope.read(), async (c) => {
    const query = c.req.query("q");
    const sourcesParam = c.req.query("sources");
    const limitStr = c.req.query("limit");
    const limit = limitStr ? parseInt(limitStr, 10) : 50;

    if (!query) {
      throw new BadRequestError("q parameter required");
    }

    const sourceIds = sourcesParam ? sourcesParam.split(",") : undefined;
    // Hidden-from-general-search system sources (see search/hidden-sources.ts).
    const hiddenSourceIds = hiddenSourceIdsToExclude({ sourceIds });
    const args: LikeSearchArgs = {
      query,
      ...(sourceIds ? { sourceIds } : {}),
      hiddenSourceIds,
      limit,
    };

    const rows = deps.ioGate
      ? await deps.ioGate.likeSearchDocuments(args)
      : likeSearchDocuments(db, args);

    return c.json({ results: rows, total: rows.length });
  });
}

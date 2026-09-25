// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `POST /graph/walk` — the unified graph-traversal endpoint. Thin route
 * adapter over `domain/graph-walk.ts` `graphWalk`: validate the body, run the
 * walk, return the `DocumentGraph`. The per-entity graph endpoints
 * (`GET /documents/:id/graph`, `/trail`) compose over the same primitive.
 */

import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import { graphWalkBody } from "../schemas/graph.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { graphWalk, GraphWalkInputError } from "../../domain/graph-walk.js";
import { resolveDocId } from "./resolve-doc-id.js";
import type { BoundRowResolver } from "../../domain/DocumentGraphService.js";
import type { RouteApp } from "./types.js";
import type { GraphEdgeType } from "@omnesis/core";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface GraphWalkRouteDeps {
  db: Db;
  /** Analytics store as a bound-row resolver — enables `includeBoundRows` (#450). */
  analyticsDb?: BoundRowResolver;
}

export function mountGraphWalkRoute(app: RouteApp, deps: GraphWalkRouteDeps): void {
  const { db, analyticsDb } = deps;

  app.post("/graph/walk", scope.read(), validateJson(graphWalkBody), async (c) => {
    const body = c.req.valid("json");
    // Prefix-resolve document seeds (same UX as /documents/:id/graph). Non-doc
    // kinds pass through for graphWalk to reject with a clear message.
    const start = body.start.map((ref) =>
      ref.kind === "document" ? { kind: "document" as const, id: resolveDocId(db, ref.id) } : ref,
    );
    try {
      const graph = await graphWalk(db, analyticsDb, {
        start,
        edgeTypes: body.edgeTypes as GraphEdgeType[] | undefined,
        vertexTypes: body.vertexTypes,
        maxHops: body.maxHops,
        maxResults: body.maxResults,
        fanoutCap: body.fanoutCap,
        provenanceKinds: body.provenanceKinds,
        minScore: body.minScore,
        includeBoundRows: body.includeBoundRows,
      });
      return c.json(graph);
    } catch (err) {
      if (err instanceof GraphWalkInputError) throw new BadRequestError(err.message);
      if (err instanceof Error && err.message.startsWith("seed not found")) {
        throw new NotFoundError(err.message);
      }
      throw err;
    }
  });
}

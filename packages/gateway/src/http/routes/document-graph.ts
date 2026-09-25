// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `GET /documents/:id/graph` — multi-edge-type subgraph around one or
 * more seed documents, used by the portal's graph-debug page. The walk
 * algorithm lives in `domain/DocumentGraphService.ts`; this file is a
 * thin route adapter (parse params, prefix-resolve each seed, call the
 * service, return JSON).
 *
 * The path's `:id` is always the FIRST seed. The optional `?seeds=`
 * query param adds additional comma-separated seed ids (each may be a
 * full id or a unique prefix — same resolution rules as the path id).
 */

import { scope } from "../scope.js";
import { graphWalk } from "../../domain/graph-walk.js";
import { resolveSeeds, parseIntParam } from "./resolve-doc-id.js";
import type { BoundRowResolver } from "../../domain/DocumentGraphService.js";
import type { RouteApp } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface DocumentGraphRouteDeps {
  db: Db;
  /**
   * The analytics store, as a bound-row resolver. When present, the subgraph
   * includes the synthesized `same-entity` edge to each document's
   * co-described DuckDB row. Optional so test/headless mounts that have
   * no analytics DB still serve the document-only graph.
   */
  analyticsDb?: BoundRowResolver;
}

export function mountDocumentGraphRoute(app: RouteApp, deps: DocumentGraphRouteDeps): void {
  const { db, analyticsDb } = deps;

  app.get("/documents/:id/graph", scope.read(), async (c) => {
    const seedIds = resolveSeeds(db, c.req.param("id"), c.req.query("seeds") ?? "");
    // Composes over the unified graph.walk() primitive: a document-seed
    // walk with no filters, attaching cross-store rows when an analytics store
    // is wired. Behaviour is identical to the prior direct buildDocumentGraph
    // call — graph.walk() is the single home for the traversal.
    const graph = await graphWalk(db, analyticsDb, {
      start: seedIds.map((id) => ({ kind: "document" as const, id })),
      maxHops: parseIntParam(c.req.query("depth")),
      fanoutCap: parseIntParam(c.req.query("fanoutCap")),
      maxResults: parseIntParam(c.req.query("maxVertices")),
      includeBoundRows: analyticsDb !== undefined,
    });
    return c.json(graph);
  });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `GET /documents/:id/trail` — chronologically-ordered event trail around
 * one or more seed documents.  Wraps the same `buildDocumentGraph` +
 * `eventTrailFromGraph` pipeline the agent's `trace_connections` tool uses,
 * so CLI / portal consumers get an identical payload shape.
 *
 * The path `:id` is always the first seed.  Optional `?seeds=` adds
 * additional comma-separated seed ids (each may be a full id or a
 * unique prefix — same resolution as `/documents/:id/graph`).
 */

import { scope } from "../scope.js";
import { buildDocumentGraph } from "../../domain/DocumentGraphService.js";
import { eventTrailFromGraph } from "../../domain/buildTimeline.js";
import { resolveSeeds, parseIntParam } from "./resolve-doc-id.js";
import type { RouteApp } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface DocumentTrailRouteDeps {
  db: Db;
}

export function mountDocumentTrailRoute(app: RouteApp, deps: DocumentTrailRouteDeps): void {
  const { db } = deps;

  app.get("/documents/:id/trail", scope.read(), (c) => {
    const seedIds = resolveSeeds(db, c.req.param("id"), c.req.query("seeds") ?? "");
    const depth = parseIntParam(c.req.query("depth"));
    const fanoutCap = parseIntParam(c.req.query("fanoutCap"));

    const graph = buildDocumentGraph(db, seedIds, { depth, fanoutCap });
    const trail = eventTrailFromGraph(graph);
    return c.json(trail);
  });
}

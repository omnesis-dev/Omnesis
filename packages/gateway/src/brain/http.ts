// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Product HTTP surface over open loops: `/loops*` list and detail reads.
 * Mounted unconditionally (so the gate flips live, like `/status`), but
 * every route re-checks the Brain's feature gate per request.
 *
 * Routes are `scope.admin()` like the rest of the agent surface. The time index — projections, mentions and annotations — is
 * read through the ungated `/temporal/*` routes (`http/routes/temporal.ts`).
 * The other operator/debug surfaces over the same tables live in
 * admin-http.ts.
 */

import { buildPage, clampLimit } from "@omnesis/types";
import { scope } from "../http/scope.js";
import { NotFoundError, StalePageCursorError } from "../http/errors.js";
import {
  nextProductLoopPageCursor,
  parseProductLoopFilter,
  parseProductLoopPageCursor,
  productLoopStates,
} from "./product-pagination.js";
import { ProductLoopQueryService } from "./product-loop-query-service.js";
import type Database from "better-sqlite3";
import type { OpenLoopRow } from "./storage/types.js";
import type { BriefsFeatureStatus } from "./feature-gate.js";
import type { RouteApp } from "../http/routes/types.js";

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * A loop as the product surface serializes it — the user-meaningful
 * fields only. Engine bookkeeping (creating run, decay-check counters)
 * and the operator joins (linked docs, attached observations, scheduled
 * checks) stay on the /admin/brain surface. `deadline` passes through
 * as the agent-owned opaque JSON; clients parse the recommended
 * `{ type, date?, note? }` shape leniently. `importance` (0-1) is the
 * agent's own weight — the Radar surface ranks by it.
 */
function loopDto(loop: OpenLoopRow) {
  return {
    id: loop.id,
    state: loop.state,
    title: loop.title,
    description: loop.description,
    importance: loop.importance,
    deadline: loop.deadline,
    createdAt: iso(loop.createdAt),
    lastUpdate: iso(loop.lastUpdate),
  };
}

export interface MountLoopRoutesOpts {
  db: Database.Database;
  /** Live feature-gate verdict; absent ⇒ the routes always 404. */
  getStatus?: (() => BriefsFeatureStatus) | undefined;
  /** Decision clock. Defaults to the wall clock; the backtest mirror passes its virtual clock. */
  clock?: (() => number) | undefined;
}

export function mountLoopRoutes(app: RouteApp, opts: MountLoopRoutesOpts): void {
  const productLoops = new ProductLoopQueryService(opts.db);
  const requireActive = (): void => {
    if (!opts.getStatus?.().active) throw new NotFoundError("Not found");
  };

  // The Radar screen list — importance-ranked (ties break by most-recently
  // updated, then id). `state=active|resolved` matches the two product tabs;
  // omitted/`all` preserves the older all-state contract. Each page carries the
  // signals the client groups by: actors (with isSelf), involved, blockers and
  // deadline. The opaque cursor binds the state filter and full sort tuple.
  app.get("/loops", scope.admin(), (c) => {
    requireActive();
    const state = parseProductLoopFilter(c.req.query("state"));
    const limit = clampLimit(c.req.query("limit"), { default: 50, max: 100 });
    const revision = productLoops.paginationRevision();
    const cursor = parseProductLoopPageCursor(c.req.query("cursor"), state, revision);
    const states = productLoopStates(state);
    const probe = productLoops.list({
      ...(states ? { states } : {}),
      orderBy: "importance",
      limit: limit + 1,
      ...(cursor ? { afterImportance: cursor } : {}),
    });
    if (productLoops.paginationRevision() !== revision) throw new StalePageCursorError();
    const hasMore = probe.length > limit;
    const page = hasMore ? probe.slice(0, limit) : probe;
    const last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? nextProductLoopPageCursor(state, revision, {
            importance: last.row.importance,
            lastUpdate: last.row.lastUpdate,
            id: last.row.id,
          })
        : undefined;
    const loops = page.map((loop) => ({
      ...loopDto(loop.row),
      actors: loop.actors,
      involved: loop.involved,
      blockedBy: loop.blockedBy,
    }));
    return c.json({
      loops,
      pageInfo: buildPage([], { hasMore, limit, nextCursor }).pageInfo,
    });
  });

  // One loop for the detail sheet: the product fields plus person refs
  // enriched to `{ id, name }` (a legacy raw ref matching no person keeps its
  // raw value with `name: null`). The legacy inline ledger is bounded to its
  // first 50 newest notes; current clients use the dedicated paginated admin
  // ledger route and can request `includeChildren=0` here.
  app.get("/loops/:id", scope.admin(), (c) => {
    requireActive();
    const loop = productLoops.get(c.req.param("id"));
    if (!loop) throw new NotFoundError("Loop not found");
    const includeChildren = c.req.query("includeChildren") !== "0";
    const ledgerLimit = 50;
    const ledgerProbe = includeChildren
      ? productLoops.listLedger(loop.row.id, {
          order: "desc",
          limit: ledgerLimit + 1,
        })
      : [];
    const ledgerHasMore = ledgerProbe.length > ledgerLimit;
    const ledger = ledgerHasMore ? ledgerProbe.slice(0, ledgerLimit) : ledgerProbe;
    return c.json({
      loop: {
        ...loopDto(loop.row),
        actors: loop.actors,
        involved: loop.involved,
        blockedBy: loop.blockedBy,
      },
      ...(includeChildren
        ? {
            ledger: ledger.map((entry) => ({
              seq: entry.seq,
              at: iso(entry.at),
              note: entry.note,
            })),
            ledgerTruncated: ledgerHasMore,
          }
        : {}),
    });
  });
}

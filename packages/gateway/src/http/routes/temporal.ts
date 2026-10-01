// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The time index over HTTP: the portal's Calendar reads it here.
 *
 * One ordered, cursor-paginated window over every temporal origin — source
 * projections, date mentions and, when the Brain has written them, its
 * annotations — through the same `TemporalQueryService` the agents'
 * `temporal_query` tool reads, so the portal and the agent see one index.
 * Callers use unix-ms bounds; the service normalizes them into the tool's
 * half-open, time-zone-aware contract. An annotation or recognized date is also
 * addressable on its own, through the same service.
 *
 * Not gated on experimental mode or the Brain: projections and mentions exist
 * on every install. Admin-scoped like the rest of the operator surface.
 */

import {
  ACCEPTED_TEMPORAL_KINDS,
  canonicalTemporalKind,
  TEMPORAL_MODALITIES,
  TEMPORAL_ORIGINS,
  TEMPORAL_STATUSES,
} from "@omnesis/core";
import {
  TemporalQueryInputError,
  TemporalQueryService,
  type TemporalQueryOptions,
} from "../../enrichment/temporal/temporal-query-service.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { scope } from "../scope.js";
import { parseCsvFacet, parseTemporalWindowMs } from "../temporal-query-params.js";
import type Database from "better-sqlite3";
import type { TemporalKind, TemporalModality, TemporalOrigin, TemporalStatus } from "@omnesis/core";
import type { AnalyticsDb } from "../../analytics-db.js";
import type { RouteApp } from "./types.js";

export interface TemporalRoutesDeps {
  db: Database.Database;
  /** Analytics projections; absent in lightweight tests, where document projections still work. */
  analyticsDb?: AnalyticsDb | undefined;
  /** Whether the mention worth gate is active, so the window hides unworthy mentions as the agent does. */
  hideUnworthyMentions?: (() => boolean) | undefined;
  clock?: (() => number) | undefined;
}

/** A page is at most this many items. */
const MAX_PAGE_LIMIT = 100;

export function mountTemporalRoutes(app: RouteApp, deps: TemporalRoutesDeps): void {
  const options: TemporalQueryOptions = deps.hideUnworthyMentions
    ? { hideUnworthyMentions: deps.hideUnworthyMentions }
    : {};
  const service = (): TemporalQueryService =>
    new TemporalQueryService(deps.db, deps.analyticsDb, options);
  const now = (): number => (deps.clock ?? Date.now)();
  const toBadRequest = (error: unknown): never => {
    if (error instanceof TemporalQueryInputError) throw new BadRequestError(error.message);
    throw error;
  };
  const requireTimeZone = (raw: string | undefined): string => {
    if (!raw?.trim()) throw new BadRequestError('"timeZone" must be an IANA time zone');
    return raw;
  };

  app.get("/temporal/window", scope.admin(), async (c) => {
    const { fromMs, toMs } = parseTemporalWindowMs(c);
    const timeZone = requireTimeZone(c.req.query("timeZone"));
    const origins = parseCsvFacet<TemporalOrigin>(
      c.req.query("origins"),
      new Set(TEMPORAL_ORIGINS),
      "origins",
    );
    // Kinds are the one facet with retired spellings still on the wire: accept
    // them from older clients and resolve each to its canonical kind here, so
    // nothing below this boundary sees more than one name for a kind.
    const kinds = parseCsvFacet<TemporalKind>(
      c.req.query("kinds"),
      new Set(ACCEPTED_TEMPORAL_KINDS),
      "kinds",
      canonicalTemporalKind,
    );
    const modalities = parseCsvFacet<TemporalModality>(
      c.req.query("modalities"),
      new Set(TEMPORAL_MODALITIES),
      "modalities",
    );
    const statuses = parseCsvFacet<TemporalStatus>(
      c.req.query("statuses"),
      new Set(TEMPORAL_STATUSES),
      "statuses",
    );
    const limitRaw = c.req.query("limit");
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_LIMIT) {
        throw new BadRequestError(`"limit" must be an integer 1..${MAX_PAGE_LIMIT}`);
      }
      limit = parsed;
    }
    // Only a TemporalQueryInputError is the caller's to fix. Everything else is
    // the gateway's own and propagates to the sanitized, logged 500 in
    // `app.onError`, which is where an internal fault belongs.
    const cursor = c.req.query("cursor");
    const page = await service()
      .query({
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        timeZone,
        ...(origins ? { origins } : {}),
        ...(kinds ? { kinds } : {}),
        ...(modalities ? { modalities } : {}),
        ...(statuses ? { statuses } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      })
      .catch(toBadRequest);
    return c.json({
      nowMs: now(),
      window: page.window,
      items: page.items,
      coverage: page.coverage,
      truncated: page.truncated,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  });

  // An annotation opened directly reads through the same time-zone-aware
  // service as the window, so a coarse date cannot shift merely because its
  // stored anchor was written in another zone.
  app.get("/temporal/annotations/:id", scope.admin(), async (c) => {
    const timeZone = requireTimeZone(c.req.query("timeZone"));
    const item = await service().annotationById(c.req.param("id"), timeZone).catch(toBadRequest);
    if (!item) throw new NotFoundError("Temporal annotation not found");
    return c.json({ item });
  });

  app.get("/temporal/items/:id", scope.admin(), async (c) => {
    const timeZone = requireTimeZone(c.req.query("timeZone"));
    const item = await service().itemById(c.req.param("id"), timeZone).catch(toBadRequest);
    if (!item) throw new NotFoundError("Temporal item not found");
    return c.json({ item });
  });
}

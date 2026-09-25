// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Cognition telemetry routes — the per-mechanism spend breakdown and the
 * read-only calibration report.
 *
 * Deliberately NOT gated on the Briefs feature gate: spend recording is
 * passive accounting that exists (and keeps its history) whether or not
 * the briefs surfaces are active, so the operator can always audit what
 * the cognitive mechanisms cost — and calibration is a pure measurement
 * over the same durable stores. Admin-scoped like the rest of the
 * operator inspection surface.
 */

import { z } from "zod";
import { buildPage, clampLimit } from "@omnesis/types";
import { CALIBRATION_FAMILIES } from "../../brain/calibration.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { decodePageCursor, encodePageCursor } from "../pagination-cursor.js";
import { validateQuery } from "../validate.js";
import { scope } from "../scope.js";
import type { RouteApp } from "./types.js";
import type { CognitionQueryService } from "../services/CognitionQueryService.js";

export interface CognitionRoutesDeps {
  query: CognitionQueryService;
}

// `days` clamps to the 365 ceiling instead of rejecting, and floors a
// fractional value — the same forgiving semantics /admin/brain/spend's
// limitParam applies, so one CLI flag drives both endpoints identically.
const spendQuery = z.object({
  days: z.coerce
    .number()
    .min(1)
    .default(30)
    .transform((n) => Math.min(Math.floor(n), 365)),
});

// `sinceDays` mirrors the spend route's forgiving `days` semantics (clamp
// the ceiling, floor fractions, reject non-positive). Omitted = full history.
const calibrationQuery = z.object({
  family: z.enum(CALIBRATION_FAMILIES).optional(),
  sinceDays: z.coerce
    .number()
    .min(1)
    .transform((n) => Math.min(Math.floor(n), 3650))
    .optional(),
});

export function mountCognitionRoutes(app: RouteApp, deps: CognitionRoutesDeps): void {
  // Per-(day, mechanism, model) token totals for the most recent `days`
  // recorded days, newest day first. Tracking only — no cap anywhere.
  //
  // Each row carries the mechanism's display label so every client renders
  // one vocabulary without keeping its own copy; an id this build does not
  // know (a newer workflow, a mechanism from an older schema) labels as
  // itself rather than disappearing.
  app.get("/admin/cognition/spend", scope.admin(), validateQuery(spendQuery), (c) => {
    const { days } = c.req.valid("query");
    return c.json({ rows: deps.query.listSpend(days) });
  });

  // The measurement-only calibration report: per-family reliability bins +
  // ECE over the confidence-carrying artifacts. Pure read — nothing here
  // (or anywhere) recalibrates or mutates a confidence based on it.
  app.get("/admin/cognition/calibration", scope.admin(), validateQuery(calibrationQuery), (c) => {
    const { family, sinceDays } = c.req.valid("query");
    return c.json(
      deps.query.calibration({
        ...(family !== undefined ? { family } : {}),
        ...(sinceDays !== undefined ? { sinceDays } : {}),
        // Injected here — the briefs subsystem never reads the wall clock
        // on its own (clock discipline for virtual replay).
        now: Date.now(),
      }),
    );
  });

  // The LIVE dependents of one annotation prior — the briefs/loops recorded
  // as built on it (consumption provenance), title-enriched. Not briefs-gated
  // for the same reason as spend: the edges are passive bookkeeping that
  // keeps its history whether or not the briefs surfaces are active.
  app.get("/admin/cognition/annotations/:store/:id/dependents", scope.admin(), (c) => {
    const store = c.req.param("store");
    if (store !== "doc" && store !== "person") {
      throw new BadRequestError("store must be 'doc' or 'person'");
    }
    const id = c.req.param("id");
    const limit = clampLimit(c.req.query("limit"), { default: 50, max: 200 });
    const cursor = decodePageCursor(c.req.query("cursor"), "annotation-dependents", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const value = payload as Record<string, unknown>;
      if (
        value.store !== store ||
        value.annotationId !== id ||
        typeof value.createdAt !== "number" ||
        !Number.isFinite(value.createdAt) ||
        (value.kind !== "brief" && value.kind !== "loop") ||
        typeof value.id !== "string"
      ) {
        return null;
      }
      return {
        createdAt: value.createdAt,
        kind: value.kind as "brief" | "loop",
        id: value.id,
      };
    });
    const probe = deps.query.listAnnotationDependents(store, id, {
      limit: limit + 1,
      ...(cursor ? { before: cursor } : {}),
    });
    if (!probe) throw new NotFoundError("Annotation not found");
    const hasMore = probe.length > limit;
    const rows = hasMore ? probe.slice(0, limit) : probe;
    const last = rows.at(-1);
    const nextCursor =
      hasMore && last
        ? encodePageCursor("annotation-dependents", {
            store,
            annotationId: id,
            createdAt: last.createdAt,
            kind: last.kind,
            id: last.id,
          })
        : undefined;
    return c.json(
      buildPage(
        rows.map((d) => ({
          kind: d.kind,
          id: d.id,
          title: d.title,
          runId: d.runId,
          createdAt: new Date(d.createdAt).toISOString(),
        })),
        { hasMore, limit, nextCursor },
      ),
    );
  });
}

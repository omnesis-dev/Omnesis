// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { BadRequestError, NotFoundError, StalePageCursorError } from "../http/errors.js";
import { decodePageCursor, encodePageCursor } from "../http/pagination-cursor.js";
import { scope } from "../http/scope.js";
import {
  iso,
  limitParam,
  listPageInfo,
  type CognitionAdminRouteContext,
} from "./admin-http-shared.js";
import { cognitionMechanismLabel } from "./cognition/workflows.js";
import { asMutableClock } from "./virtual-clock.js";
import type { Clock } from "./storage/types.js";
import type {
  BootstrapBacklog,
  BootstrapBacklogProbe,
  BootstrapTimeline,
  BootstrapTimelineProbe,
  BootstrapSettingsView,
  BootstrapStatus,
} from "./bootstrap-status.js";
import type { CognitionBudgetSettings } from "./cognition/budget.js";

/**
 * Wire shape for the lane's status. Timestamps become ISO like everywhere
 * else on this surface, and the resolved knobs ride along because they are not
 * fetchable anywhere: the config routes serve an operator's OVERRIDES, so an
 * untouched `maxRunsPerDay` — the number that decides what the lane costs per
 * day — reads as absent on the wire.
 */
function bootstrapStatusDto(s: BootstrapStatus) {
  return {
    state: s.state,
    reason: s.reason,
    settings: s.settings,
    holdSince: iso(s.holdSince),
    holdEndsAt: iso(s.holdEndsAt),
    drainedDay: s.drainedDay,
    drainedSourceWatermark: iso(s.drainedSourceWatermark),
    sourceWatermark: iso(s.sourceWatermark),
    day: s.day,
    enqueuedToday: s.enqueuedToday,
    totalEnqueued: s.totalEnqueued,
    runs: s.runs,
    completedLast24h: s.completedLast24h,
    blockedByHigherPriority: s.blockedByHigherPriority,
    processedDocs: s.processedDocs,
    recencyFloor: s.recencyFloor,
    providerOutage:
      s.providerOutage === null
        ? null
        : {
            openUntil: iso(s.providerOutage.openUntil),
            consecutiveFailures: s.providerOutage.consecutiveFailures,
            lastError: s.providerOutage.lastError,
          },
  };
}

/**
 * The timeline, dated like every other scan.
 *
 * `computedAt` goes out as an ISO instant, matching `backlogDto` — the two
 * routes are siblings serving snapshots of the same population, and a client
 * comparing their stamps to tell how far apart the snapshots are should not
 * have to know that one speaks epoch milliseconds and the other does not.
 */
function timelineDto(t: BootstrapTimeline) {
  return { pending: false, months: t.months, computedAt: iso(t.computedAt) };
}

function backlogDto(b: BootstrapBacklog, ttlMs: number) {
  return {
    pending: false,
    remaining: b.remaining,
    dateScanPending: b.dateScanPending,
    dateScanned: b.dateScanned,
    computedAt: iso(b.computedAt),
    // When asking again would actually recompute. Served rather than left for
    // the client to infer, so a surface cannot offer a refresh that silently
    // returns the same snapshot it already has.
    staleAfter: iso(b.computedAt + ttlMs),
  };
}

export function mountCognitionListAdminRoutes(
  ctx: CognitionAdminRouteContext,
  options: {
    clock?: (() => number) | undefined;
    writeGate: { wipeCognitionNotes(now: number): Promise<void> };
    /**
     * The resolved bootstrap knobs, read live. Absent in storage-only
     * compositions, which then serve no lane status rather than inventing
     * defaults that would misreport what the engine is actually running.
     */
    getBootstrapSettings?: (() => BootstrapSettingsView) | undefined;
    /** The resolved budget ceilings, read live. */
    getBudgetSettings?: (() => CognitionBudgetSettings) | undefined;
    /** Records the operator's decision to begin; resolves to the start instant. */
    startBootstrap?: ((now: number) => Promise<number>) | undefined;
    /** Shared cache for the expensive month-by-month scan. */
    timelineProbe?: BootstrapTimelineProbe | undefined;
    /** Shared cache for the expensive backlog probe. */
    backlogProbe?: BootstrapBacklogProbe | undefined;
  },
): void {
  const { app, query, requireActive, requireVisible, now } = ctx;
  const mutableClock = asMutableClock(options.clock as Clock | undefined);

  app.get("/admin/brain/clock", scope.admin(), (c) => {
    requireVisible();
    return c.json({ virtual: mutableClock !== null, now: new Date(now()).toISOString() });
  });

  app.post("/admin/brain/clock", scope.admin(), async (c) => {
    requireActive();
    if (mutableClock === null) {
      throw new BadRequestError(
        "virtual clock not enabled — start the gateway with OMNESIS_BRIEFS_VIRTUAL_CLOCK=1 (backtest mirror only)",
      );
    }
    const body = (await c.req.json().catch(() => null)) as { now?: unknown } | null;
    const raw = body?.now;
    const ms =
      typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(ms)) {
      throw new BadRequestError('body must be {"now": <unix-ms | ISO 8601>}');
    }
    mutableClock.set(ms);
    return c.json({ virtual: true, now: new Date(ms).toISOString() });
  });

  app.get("/admin/brain/spend", scope.admin(), (c) => {
    requireVisible();
    const days = limitParam(c.req.query("days"), "days", 30, 365);
    return c.json({ items: query.listSpend({ limit: days }) });
  });

  // What the Brain has spent today against whatever ceiling is set. Tokens and
  // runs only — the Brain reports no figure in currency anywhere, because no
  // inference API it talks to exposes a price and an unverifiable estimate is
  // a poor thing to stand between an operator and a large spend.
  app.get("/admin/brain/budget", scope.admin(), (c) => {
    requireVisible();
    const settings = options.getBudgetSettings?.();
    if (!settings) throw new NotFoundError("Not found");
    const b = query.budget(settings, now());
    return c.json({
      day: b.day,
      usedTokens: b.usedTokens,
      usedRuns: b.usedRuns,
      // The same spend split by what it costs. `cacheRead` is a subset of
      // `prompt`; `fresh` is the remainder. Enforcement still uses the flat
      // `usedTokens` above — this is for the operator, not the gate.
      breakdown: b.breakdown,
      dailyTokens: b.settings.dailyTokens,
      dailyRuns: b.settings.dailyRuns,
      // Null when spending freely; the drainer's own pause reason otherwise,
      // so the surface never paraphrases the engine.
      exhausted: b.verdict.exhausted
        ? {
            dimension: b.verdict.dimension,
            used: b.verdict.used,
            limit: b.verdict.limit,
            reason: b.verdict.reason,
          }
        : null,
    });
  });

  // Begin the backfill. Idempotent: a lane already started keeps its original
  // start time, so a double-click cannot restate when the operator decided.
  app.post("/admin/brain/bootstrap/start", scope.admin(), async (c) => {
    requireActive();
    const startedAt = await options.startBootstrap?.(now());
    if (startedAt === undefined) throw new NotFoundError("Not found");
    return c.json({ startedAt: new Date(startedAt).toISOString() });
  });

  // The corpus month by month — the picture of how far back the lane has read.
  // Expensive in exactly the way the backlog is, and cached the same way.
  app.get("/admin/brain/bootstrap/timeline", scope.admin(), async (c) => {
    requireVisible();
    const probe = options.timelineProbe;
    if (!probe) throw new NotFoundError("Not found");
    if (c.req.query("cached") === "1") {
      const peeked = probe.peek();
      return c.json(peeked ? timelineDto(peeked) : { pending: true });
    }
    return c.json(timelineDto(await probe.get()));
  });

  // The retrospective lane's own state. Everything here is a key read, an
  // indexed count, or a grouped count over the bootstrap runs — cheap enough
  // for a surface to poll. The backlog deliberately is NOT here; see below.
  app.get("/admin/brain/bootstrap", scope.admin(), (c) => {
    requireVisible();
    const settings = options.getBootstrapSettings?.();
    if (!settings) throw new NotFoundError("Not found");
    return c.json(bootstrapStatusDto(query.bootstrapStatus(settings, now())));
  });

  // The backlog, served from a cache and dated.
  //
  // Counting what the lane still owes is a scan of the unprocessed half of
  // `documents` with a correlated subquery per surviving row — seconds, not
  // milliseconds, on a real corpus. It is split from the status above so a
  // polling surface cannot pay for it by accident, and the response carries
  // `computedAt` so a client dates the figure instead of implying it is live.
  app.get("/admin/brain/bootstrap/backlog", scope.admin(), async (c) => {
    requireVisible();
    const probe = options.backlogProbe;
    if (!probe) throw new NotFoundError("Not found");
    // `cached=1` returns only what is already in hand — the polling half of a
    // surface that shows the backlog without ever triggering the scan itself.
    if (c.req.query("cached") === "1") {
      const peeked = probe.peek();
      return c.json(peeked ? backlogDto(peeked, probe.ttlMs) : { pending: true });
    }
    return c.json(backlogDto(await probe.get(), probe.ttlMs));
  });

  app.get("/admin/brain/coverage", scope.admin(), (c) => {
    requireVisible();
    const limit = limitParam(c.req.query("limit"), "limit", 100, 500);
    const revision = query.paginationRevision("cognition-coverage");
    const cursor = decodePageCursor(c.req.query("cursor"), "cognition-coverage", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const value = payload as Record<string, unknown>;
      if (
        typeof value.lastProgressAt !== "number" ||
        !Number.isFinite(value.lastProgressAt) ||
        typeof value.sourceId !== "string" ||
        typeof value.workflowId !== "string" ||
        typeof value.workflowVersion !== "number" ||
        !Number.isSafeInteger(value.workflowVersion) ||
        typeof value.revision !== "number" ||
        !Number.isSafeInteger(value.revision)
      ) {
        return null;
      }
      if (value.revision !== revision) throw new StalePageCursorError();
      return {
        lastProgressAt: value.lastProgressAt,
        sourceId: value.sourceId,
        workflowId: value.workflowId,
        workflowVersion: value.workflowVersion,
      };
    });
    if (query.paginationRevision("cognition-coverage") !== revision)
      throw new StalePageCursorError();
    const probe = query.listCoverage({
      limit: limit + 1,
      ...(cursor ? { before: cursor } : {}),
    });
    const hasMore = probe.length > limit;
    const rows = hasMore ? probe.slice(0, limit) : probe;
    const last = rows.at(-1);
    const nextCursor =
      hasMore && last
        ? encodePageCursor("cognition-coverage", {
            lastProgressAt: last.lastProgressAt,
            sourceId: last.sourceId,
            workflowId: last.workflowId,
            workflowVersion: last.workflowVersion,
            revision,
          })
        : undefined;
    return c.json({
      bootstrapProcessedDocs: query.bootstrapProcessedCount(),
      items: rows.map((row) => ({
        sourceId: row.sourceId,
        sourceType: query.sourceType(row.sourceId),
        workflowId: row.workflowId,
        workflowLabel: cognitionMechanismLabel(row.workflowId),
        workflowVersion: row.workflowVersion,
        eligible: row.eligible,
        processed: row.processed,
        skipped: row.skipped,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        lastProgressAt: iso(row.lastProgressAt),
        status: row.status,
      })),
      pageInfo: listPageInfo(hasMore, limit, nextCursor),
    });
  });

  for (const route of ["/admin/brain/temporal-annotations", "/admin/brain/time-index"] as const) {
    app.get(route, scope.admin(), (c) => {
      requireVisible();
      const limit = limitParam(c.req.query("limit"), "limit", 300, 500);
      const order = c.req.query("order") === "desc" ? "desc" : "asc";
      const upcoming = c.req.query("upcoming") === "1";
      const cursor = decodePageCursor(
        c.req.query("cursor"),
        "cognition-temporal-annotations",
        (payload) => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
          const value = payload as Record<string, unknown>;
          if (
            value.order !== order ||
            value.upcoming !== upcoming ||
            typeof value.intervalStartMs !== "number" ||
            !Number.isSafeInteger(value.intervalStartMs) ||
            typeof value.id !== "string" ||
            value.id.length === 0 ||
            (upcoming && (typeof value.fromMs !== "number" || !Number.isFinite(value.fromMs))) ||
            (!upcoming && value.fromMs !== null)
          ) {
            return null;
          }
          return {
            after: { intervalStartMs: value.intervalStartMs, id: value.id },
            fromMs: upcoming ? (value.fromMs as number) : undefined,
          };
        },
      );
      const fromMs = upcoming ? (cursor?.fromMs ?? now()) : undefined;
      const entries = query.listTemporal({
        limit: limit + 1,
        after: cursor?.after,
        order,
        ...(fromMs !== undefined ? { fromMs } : {}),
      });
      const hasMore = entries.length > limit;
      const page = hasMore ? entries.slice(0, limit) : entries;
      const refs = new Map(
        query
          .documentRefs([...new Set(page.flatMap((entry) => entry.documentIds))])
          .map((ref) => [ref.id, ref]),
      );
      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? encodePageCursor("cognition-temporal-annotations", {
              order,
              upcoming,
              fromMs: fromMs ?? null,
              intervalStartMs: last.intervalStartMs,
              id: last.id,
            })
          : undefined;
      return c.json({
        stats: query.temporalStats(),
        items: page.map(({ documentIds, ...entry }) => ({
          ...entry,
          documents: documentIds.map((id) => refs.get(id) ?? { id, title: null, sourceType: null }),
        })),
        pageInfo: listPageInfo(hasMore, limit, nextCursor),
      });
    });
  }

  app.get("/admin/brain/notes", scope.admin(), (c) => {
    requireVisible();
    return c.json({ content: query.readNotes() });
  });

  app.post("/admin/brain/notes/wipe", scope.admin(), async (c) => {
    requireActive();
    await options.writeGate.wipeCognitionNotes(now());
    return c.json({ ok: true });
  });
}

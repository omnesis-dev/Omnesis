// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildPage } from "@omnesis/types";
import { NotFoundError, StalePageCursorError } from "../http/errors.js";
import { decodePageCursor, encodePageCursor } from "../http/pagination-cursor.js";
import { scope } from "../http/scope.js";
import {
  briefSummaryDto,
  enumParam,
  limitParam,
  listPageInfo,
  loopDto,
  retiredLoopDto,
  scheduledDto,
  timedCursor,
  timedNextCursor,
  type CognitionAdminRouteContext,
} from "./admin-http-shared.js";
import type { OpenLoopState } from "./storage/types.js";

const OPEN_LOOP_STATES: readonly OpenLoopState[] = ["open", "snoozed", "done", "dismissed"];
const OPEN_LOOP_STATE_FILTERS = [...OPEN_LOOP_STATES, "active", "resolved"] as const;

function statesForFilter(
  state: (typeof OPEN_LOOP_STATE_FILTERS)[number] | undefined,
): readonly OpenLoopState[] | undefined {
  if (state === "active") return ["open", "snoozed"];
  if (state === "resolved") return ["done", "dismissed"];
  return state ? [state] : undefined;
}

export function mountCognitionLoopAdminRoutes(ctx: CognitionAdminRouteContext): void {
  const { app, query, requireVisible } = ctx;

  app.get("/admin/brain/loops", scope.admin(), (c) => {
    requireVisible();
    const state = enumParam(c.req.query("state"), "state", OPEN_LOOP_STATE_FILTERS);
    const limit = limitParam(c.req.query("limit"), "limit", 100, 500);
    const filters = { state: state ?? null };
    const revision = query.paginationRevision("product-loops");
    const cursor = timedCursor(c.req.query("cursor"), "cognition-loops", filters, revision);
    const probe = query.listLoops({
      ...(state ? { states: statesForFilter(state) } : {}),
      ...(cursor ? { beforeLastUpdate: { lastUpdate: cursor.at, id: cursor.id } } : {}),
      limit: limit + 1,
    });
    if (query.paginationRevision("product-loops") !== revision) throw new StalePageCursorError();
    const hasMore = probe.length > limit;
    const loops = hasMore ? probe.slice(0, limit) : probe;
    const last = loops.at(-1);
    const nextCursor = timedNextCursor(
      "cognition-loops",
      hasMore && last ? { at: last.lastUpdate, id: last.id } : undefined,
      filters,
      revision,
    );
    return c.json({
      items: loops.map(loopDto),
      pageInfo: listPageInfo(hasMore, limit, nextCursor),
    });
  });

  app.get("/admin/brain/loops/:id", scope.admin(), (c) => {
    requireVisible();
    const id = c.req.param("id");
    const loop = query.getLoop(id);
    if (!loop) throw new NotFoundError("Open loop not found");
    const includeChildren = c.req.query("includeChildren") !== "0";
    const ledger = includeChildren
      ? query.listLoopLedger(id).map((entry) => ({
          seq: entry.seq,
          runId: entry.runId,
          at: new Date(entry.at).toISOString(),
          note: entry.note,
        }))
      : undefined;
    const briefs = includeChildren ? query.listLoopBriefs(id).map(briefSummaryDto) : undefined;
    const scheduledRuns = includeChildren
      ? query
          .listRuns({
            kinds: ["time_based"],
            statuses: ["pending"],
            loopId: id,
            order: "asc",
            orderBy: "nextAttemptAt",
            limit: 50,
          })
          .map(scheduledDto)
      : undefined;
    return c.json({
      loop: {
        ...loopDto(loop),
        docs: query.documentRefs(loop.docs),
        actors: query.personRefs(loop.actors),
        involved: query.personRefs(loop.involved),
      },
      ...(includeChildren ? { ledger, briefs, scheduledRuns } : {}),
      provenance: query.provenance(loop.createdByRun),
    });
  });

  app.get("/admin/brain/loops/:id/ledger", scope.admin(), (c) => {
    requireVisible();
    const id = c.req.param("id");
    if (!query.getLoop(id)) throw new NotFoundError("Open loop not found");
    const limit = limitParam(c.req.query("limit"), "limit", 50, 200);
    const cursor = decodePageCursor(c.req.query("cursor"), "cognition-loop-ledger", (payload) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
      const value = payload as Record<string, unknown>;
      return value.loopId === id &&
        typeof value.seq === "number" &&
        Number.isSafeInteger(value.seq) &&
        value.seq > 0
        ? value.seq
        : null;
    });
    const probe = query.listLoopLedger(id, {
      order: "desc",
      limit: limit + 1,
      ...(cursor !== null ? { beforeSeq: cursor } : {}),
    });
    const hasMore = probe.length > limit;
    const entries = hasMore ? probe.slice(0, limit) : probe;
    const last = entries.at(-1);
    const nextCursor =
      hasMore && last
        ? encodePageCursor("cognition-loop-ledger", { loopId: id, seq: last.seq })
        : undefined;
    return c.json(
      buildPage(
        entries.map((entry) => ({
          seq: entry.seq,
          runId: entry.runId,
          at: new Date(entry.at).toISOString(),
          note: entry.note,
        })),
        { hasMore, limit, nextCursor },
      ),
    );
  });

  app.get("/admin/brain/loops/:id/briefs", scope.admin(), (c) => {
    requireVisible();
    const id = c.req.param("id");
    if (!query.getLoop(id)) throw new NotFoundError("Open loop not found");
    const limit = limitParam(c.req.query("limit"), "limit", 50, 200);
    const filters = { loopId: id };
    const cursor = timedCursor(c.req.query("cursor"), "cognition-loop-briefs", filters);
    const probe = query.listLoopBriefs(id, {
      limit: limit + 1,
      ...(cursor ? { beforeCreated: { createdAt: cursor.at, id: cursor.id } } : {}),
    });
    const hasMore = probe.length > limit;
    const briefs = hasMore ? probe.slice(0, limit) : probe;
    const last = briefs.at(-1);
    const nextCursor = timedNextCursor(
      "cognition-loop-briefs",
      hasMore && last ? { at: last.createdAt, id: last.id } : undefined,
      filters,
    );
    return c.json(buildPage(briefs.map(briefSummaryDto), { hasMore, limit, nextCursor }));
  });

  app.get("/admin/brain/loops/:id/scheduled", scope.admin(), (c) => {
    requireVisible();
    const id = c.req.param("id");
    if (!query.getLoop(id)) throw new NotFoundError("Open loop not found");
    const limit = limitParam(c.req.query("limit"), "limit", 25, 100);
    const filters = { loopId: id };
    const revision = query.paginationRevision("cognition-runs");
    const cursor = timedCursor(
      c.req.query("cursor"),
      "cognition-loop-scheduled",
      filters,
      revision,
    );
    const probe = query.listRuns({
      kinds: ["time_based"],
      statuses: ["pending"],
      loopId: id,
      order: "asc",
      orderBy: "nextAttemptAt",
      limit: limit + 1,
      ...(cursor ? { afterSort: { at: cursor.at, id: cursor.id } } : {}),
    });
    if (query.paginationRevision("cognition-runs") !== revision) throw new StalePageCursorError();
    const hasMore = probe.length > limit;
    const runs = hasMore ? probe.slice(0, limit) : probe;
    const last = runs.at(-1);
    const nextCursor = timedNextCursor(
      "cognition-loop-scheduled",
      hasMore && last ? { at: last.nextAttemptAt, id: last.id } : undefined,
      filters,
      revision,
    );
    return c.json(buildPage(runs.map(scheduledDto), { hasMore, limit, nextCursor }));
  });

  app.get("/admin/brain/retired-loops", scope.admin(), (c) => {
    requireVisible();
    const limit = limitParam(c.req.query("limit"), "limit", 100, 500);
    const cursor = timedCursor(c.req.query("cursor"), "cognition-retired-loops", {});
    const probe = query.listRetiredLoops({
      limit: limit + 1,
      ...(cursor ? { beforeRetired: { retiredAt: cursor.at, id: cursor.id } } : {}),
    });
    const hasMore = probe.length > limit;
    const rows = hasMore ? probe.slice(0, limit) : probe;
    const last = rows.at(-1);
    const nextCursor = timedNextCursor(
      "cognition-retired-loops",
      hasMore && last ? { at: last.retiredAt, id: last.id } : undefined,
      {},
    );
    return c.json({
      items: rows.map(retiredLoopDto),
      pageInfo: listPageInfo(hasMore, limit, nextCursor),
    });
  });
}

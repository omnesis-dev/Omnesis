// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildPage } from "@omnesis/types";
import { NotFoundError, StalePageCursorError } from "../http/errors.js";
import { scope } from "../http/scope.js";
import {
  enumParam,
  limitParam,
  listPageInfo,
  runDto,
  scheduledDto,
  timedCursor,
  timedNextCursor,
  transcriptRefDto,
  type CognitionAdminRouteContext,
} from "./admin-http-shared.js";
import { COGNITION_RUN_KIND_DEFINITIONS, COGNITION_RUN_KINDS } from "./storage/types.js";
import type { CognitionRunKind, CognitionRunStatus } from "./storage/types.js";

const RUN_KINDS: readonly CognitionRunKind[] = COGNITION_RUN_KINDS;
const RUN_STATUSES: readonly CognitionRunStatus[] = ["pending", "completed", "failed"];

export function mountCognitionRunAdminRoutes(ctx: CognitionAdminRouteContext): void {
  const { app, query, requireVisible } = ctx;

  app.get("/admin/brain/pulse", scope.admin(), (c) => {
    requireVisible();
    const pulse = query.pulse(ctx.now());
    const activity = query.activityReader();
    return c.json({
      counts: pulse.counts,
      runningRuns: pulse.runningRows.map((run) => runDto(run, activity)),
      upcomingRuns: pulse.upcomingRuns.map(scheduledDto),
      recentSettledRuns: pulse.recentSettledRuns.map((run) => runDto(run, activity)),
    });
  });

  app.get("/admin/brain/run-kinds", scope.admin(), (c) => {
    requireVisible();
    return c.json({ items: COGNITION_RUN_KIND_DEFINITIONS });
  });

  app.get("/admin/brain/runs", scope.admin(), (c) => {
    requireVisible();
    const kind = enumParam(c.req.query("kind"), "kind", RUN_KINDS);
    const status = enumParam(c.req.query("status"), "status", RUN_STATUSES);
    const order =
      enumParam(c.req.query("order"), "order", ["asc", "desc", "nextAttemptAt"] as const) ?? "desc";
    const direction = order === "asc" || order === "nextAttemptAt" ? "asc" : "desc";
    const orderBy = order === "nextAttemptAt" ? "nextAttemptAt" : "enqueuedAt";
    const limit = limitParam(c.req.query("limit"), "limit", 50, 500);
    const filters = { kind: kind ?? null, status: status ?? null, order };
    const revision = query.paginationRevision("cognition-runs");
    const cursor = timedCursor(c.req.query("cursor"), "cognition-runs", filters, revision);
    const probe = query.listRuns({
      ...(kind ? { kinds: [kind] } : {}),
      ...(status ? { statuses: [status] } : {}),
      ...(cursor ? { afterSort: { at: cursor.at, id: cursor.id } } : {}),
      order: direction,
      orderBy,
      limit: limit + 1,
    });
    if (query.paginationRevision("cognition-runs") !== revision) throw new StalePageCursorError();
    const hasMore = probe.length > limit;
    const runs = hasMore ? probe.slice(0, limit) : probe;
    const last = runs.at(-1);
    const nextCursor = timedNextCursor(
      "cognition-runs",
      hasMore && last
        ? {
            at: orderBy === "nextAttemptAt" ? last.nextAttemptAt : last.enqueuedAt,
            id: last.id,
          }
        : undefined,
      filters,
      revision,
    );
    return c.json({
      items: runs.map((run) => runDto(run, query.activityReader())),
      pageInfo: listPageInfo(hasMore, limit, nextCursor),
    });
  });

  app.get("/admin/brain/runs/:id", scope.admin(), async (c) => {
    requireVisible();
    const id = c.req.param("id");
    const run = query.getRun(id);
    const transcriptPage = await query.listTranscriptsForRun(id);
    const refs = transcriptPage.items;
    if (!run && refs.length === 0 && transcriptPage.indexComplete) {
      throw new NotFoundError("Run not found");
    }
    const dto = run ? runDto(run, query.activityReader()) : null;
    const enriched =
      dto &&
      (dto.trigger?.type === "data" || dto.trigger?.type === "bootstrap") &&
      dto.trigger.docId
        ? { ...dto, trigger: { ...dto.trigger, doc: query.documentRefs([dto.trigger.docId])[0] } }
        : dto;
    return c.json({
      run: enriched,
      transcripts: refs.map(transcriptRefDto),
      rebuilding: !transcriptPage.indexComplete,
      ...(!transcriptPage.indexComplete ? { retryAfterMs: 100 } : {}),
    });
  });

  app.get("/admin/brain/scheduled", scope.admin(), (c) => {
    requireVisible();
    const limit = limitParam(c.req.query("limit"), "limit", 100, 500);
    const revision = query.paginationRevision("cognition-runs");
    const cursor = timedCursor(c.req.query("cursor"), "cognition-scheduled", {}, revision);
    const probe = query.listRuns({
      kinds: ["time_based"],
      statuses: ["pending"],
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
      "cognition-scheduled",
      hasMore && last ? { at: last.nextAttemptAt, id: last.id } : undefined,
      {},
      revision,
    );
    return c.json(buildPage(runs.map(scheduledDto), { hasMore, limit, nextCursor }));
  });
}

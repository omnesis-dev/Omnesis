// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { NotFoundError } from "../http/errors.js";
import { scope } from "../http/scope.js";
import {
  decisionDto,
  enumParam,
  iso,
  limitParam,
  listPageInfo,
  observationFullDto,
  timedCursor,
  timedNextCursor,
  type CognitionAdminRouteContext,
} from "./admin-http-shared.js";
import { OBSERVATION_STATES, type ObservationState } from "./storage/types.js";

const OBSERVATION_STATE_FILTERS = [...OBSERVATION_STATES, "open"] as const;

function statesForFilter(
  state: (typeof OBSERVATION_STATE_FILTERS)[number] | undefined,
): readonly ObservationState[] | undefined {
  if (state === "open") return ["live", "held"];
  return state ? [state] : undefined;
}

/** Operator reads over observations, the "would have pushed" log and sent morning briefs. */
export function mountCognitionObservationAdminRoutes(ctx: CognitionAdminRouteContext): void {
  const { app, query, requireVisible } = ctx;

  app.get("/admin/brain/observations", scope.admin(), (c) => {
    requireVisible();
    const state = enumParam(c.req.query("state"), "state", OBSERVATION_STATE_FILTERS);
    const limit = limitParam(c.req.query("limit"), "limit", 100, 500);
    const filters = { state: state ?? null };
    const cursor = timedCursor(c.req.query("cursor"), "cognition-observations", filters);
    const states = statesForFilter(state);
    const probe = query.listObservations({
      ...(states ? { states } : {}),
      ...(cursor ? { beforeCreated: { createdAt: cursor.at, id: cursor.id } } : {}),
      limit: limit + 1,
    });
    const hasMore = probe.length > limit;
    const observations = hasMore ? probe.slice(0, limit) : probe;
    const last = observations.at(-1);
    const nextCursor = timedNextCursor(
      "cognition-observations",
      hasMore && last ? { at: last.createdAt, id: last.id } : undefined,
      filters,
    );
    return c.json({
      items: observations.map((observation) => observationFullDto(observation)),
      pageInfo: listPageInfo(hasMore, limit, nextCursor),
    });
  });

  app.get("/admin/brain/observations/would-push", scope.admin(), (c) => {
    requireVisible();
    const limit = limitParam(c.req.query("limit"), "limit", 100, 500);
    return c.json({
      items: query.wouldPushLog(limit).map((entry) => ({
        ...entry,
        createdAt: iso(entry.createdAt),
        wouldPushAt: iso(entry.wouldPushAt),
        shippedAt: iso(entry.shippedAt),
        relevantUntil: iso(entry.relevantUntil),
      })),
    });
  });

  app.get("/admin/brain/observations/outcomes", scope.admin(), (c) => {
    requireVisible();
    const limit = limitParam(c.req.query("limit"), "limit", 100, 500);
    return c.json({
      items: query.observationOutcomes(limit).map((outcome) => ({
        ...outcome,
        createdAt: iso(outcome.createdAt),
        closedAt: iso(outcome.closedAt),
        prunedAt: iso(outcome.prunedAt),
      })),
    });
  });

  app.get("/admin/brain/observations/:id", scope.admin(), (c) => {
    requireVisible();
    const observation = query.getObservation(c.req.param("id"));
    if (!observation) throw new NotFoundError("Observation not found");
    return c.json({
      observation: observationFullDto(observation, query.documentRefs(observation.citations)),
      relatedLoops: observation.relatedLoopIds.map((id) => {
        const loop = query.getLoop(id);
        return { id, title: loop?.title ?? null, state: loop?.state ?? null };
      }),
      decisions: query
        .observationDecisions(observation.id)
        .map((decision) => decisionDto(decision, undefined)),
      provenance: query.provenance(observation.createdByRun),
    });
  });

  app.get("/admin/brain/morning-brief", scope.admin(), (c) => {
    requireVisible();
    const day = c.req.query("day");
    const brief = query.morningBrief(day && day.length > 0 ? day : undefined);
    return c.json({
      sent: brief.sent ? { ...brief.sent, sentAt: iso(brief.sent.sentAt) } : null,
      items: brief.items.map((item) => ({
        rank: item.rank,
        observationId: item.observationId,
        runId: item.runId,
        messageId: item.messageId,
        observation: item.observation ? observationFullDto(item.observation) : null,
      })),
    });
  });
}

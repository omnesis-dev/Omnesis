// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { NotFoundError } from "../http/errors.js";
import { scope } from "../http/scope.js";
import {
  briefFullDto,
  enumParam,
  FEED_TIER_LABEL,
  iso,
  limitParam,
  listPageInfo,
  timedCursor,
  timedNextCursor,
  type CognitionAdminRouteContext,
} from "./admin-http-shared.js";
import { briefFeedTier } from "./ranking.js";
import type { BriefState, OpenLoopRow } from "./storage/types.js";

const BRIEF_STATES: readonly BriefState[] = [
  "unread",
  "read",
  "dismissed_snoozed",
  "dismissed_already_handled",
  "dismissed_acknowledged",
  "dismissed_not_relevant",
  "dismissed_wrong",
  "retired",
];
const BRIEF_STATE_FILTERS = [...BRIEF_STATES, "snoozed", "dismissed"] as const;

function statesForFilter(
  state: (typeof BRIEF_STATE_FILTERS)[number] | undefined,
): readonly BriefState[] | undefined {
  if (state === "snoozed") return ["dismissed_snoozed"];
  if (state === "dismissed") {
    return [
      "dismissed_already_handled",
      "dismissed_acknowledged",
      "dismissed_not_relevant",
      "dismissed_wrong",
    ];
  }
  return state ? [state] : undefined;
}

export function mountCognitionBriefAdminRoutes(ctx: CognitionAdminRouteContext): void {
  const { app, query, requireVisible, now } = ctx;

  app.get("/admin/brain/briefs", scope.admin(), (c) => {
    requireVisible();
    const state = enumParam(c.req.query("state"), "state", BRIEF_STATE_FILTERS);
    const limit = limitParam(c.req.query("limit"), "limit", 100, 500);
    const filters = { state: state ?? null };
    const cursor = timedCursor(c.req.query("cursor"), "cognition-briefs", filters);
    const probe = query.listBriefs({
      ...(state ? { states: statesForFilter(state) } : {}),
      ...(cursor ? { beforeCreated: { createdAt: cursor.at, id: cursor.id } } : {}),
      limit: limit + 1,
    });
    const hasMore = probe.length > limit;
    const briefs = hasMore ? probe.slice(0, limit) : probe;
    const last = briefs.at(-1);
    const nextCursor = timedNextCursor(
      "cognition-briefs",
      hasMore && last ? { at: last.createdAt, id: last.id } : undefined,
      filters,
    );
    return c.json({
      items: briefs.map((brief) => briefFullDto(brief)),
      pageInfo: listPageInfo(hasMore, limit, nextCursor),
    });
  });

  app.get("/admin/brain/briefs/:id", scope.admin(), (c) => {
    requireVisible();
    const brief = query.getBrief(c.req.param("id"));
    if (!brief) throw new NotFoundError("Brief not found");
    const openDeadlines = brief.relatedLoopIds
      .map((loopId) => query.getLoop(loopId))
      .filter((loop): loop is OpenLoopRow => loop !== null && loop.state === "open")
      .map((loop) => loop.deadline);
    const tier = briefFeedTier(brief, openDeadlines, now());
    return c.json({
      brief: briefFullDto(brief, query.documentRefs(brief.citations)),
      feedTier: { rank: tier, label: FEED_TIER_LABEL[tier] },
      claims: query.briefClaims(brief.id).map(({ claim, evidenceDoc }) => ({
        id: claim.id,
        claimText: claim.claimText,
        claimBasis: claim.claimBasis,
        confidence: claim.confidence,
        verificationState: claim.verificationState,
        evidenceQuote: claim.evidenceQuote,
        evidenceDoc,
        createdAt: iso(claim.createdAt),
      })),
      provenance: query.provenance(brief.createdByRun),
    });
  });
}

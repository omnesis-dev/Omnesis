// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildPage } from "@omnesis/types";
import { NotFoundError } from "../http/errors.js";
import { scope } from "../http/scope.js";
import {
  limitParam,
  timedCursor,
  timedNextCursor,
  transcriptRefDto,
  type CognitionAdminRouteContext,
} from "./admin-http-shared.js";
import { summarizeCognitionTranscript, type CognitionRunDecision } from "./decision-view.js";
import type { CognitionTranscriptRef } from "./transcripts.js";

function transcriptCursor(
  raw: string | undefined,
  scopeName: string,
  filters: Record<string, string | null>,
) {
  const cursor = timedCursor(raw, scopeName, filters);
  return cursor ? { finishedAt: cursor.at, fileName: cursor.id } : undefined;
}

export function mountCognitionTranscriptAdminRoutes(ctx: CognitionAdminRouteContext): void {
  const { app, query, requireVisible } = ctx;

  app.get("/admin/brain/transcripts", scope.admin(), async (c) => {
    requireVisible();
    const runId = c.req.query("runId") || null;
    const limit = limitParam(c.req.query("limit"), "limit", 50, 500);
    const filters = { runId };
    const cursor = transcriptCursor(c.req.query("cursor"), "cognition-transcripts", filters);
    const probePage = await query.listTranscripts({
      limit: limit + 1,
      ...(runId ? { runId } : {}),
      ...(cursor ? { before: cursor } : {}),
    });
    const probe = probePage.items;
    const hasMore = probePage.indexComplete && probe.length > limit;
    const refs = probe.slice(0, limit);
    const last = refs.at(-1);
    const nextCursor = timedNextCursor(
      "cognition-transcripts",
      hasMore && last ? { at: last.finishedAt, id: last.fileName } : undefined,
      filters,
    );
    return c.json({
      ...buildPage(refs.map(transcriptRefDto), { hasMore, limit, nextCursor }),
      rebuilding: !probePage.indexComplete,
      ...(!probePage.indexComplete ? { retryAfterMs: 100 } : {}),
    });
  });

  app.get("/admin/brain/transcripts/:fileName", scope.admin(), async (c) => {
    requireVisible();
    const fileName = c.req.param("fileName");
    const ref = query.transcriptRef(fileName);
    if (!ref) throw new NotFoundError("Transcript not found");
    try {
      return c.json({ transcript: await query.loadTranscript(ref.fileName) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new NotFoundError("Transcript not found");
      }
      throw err;
    }
  });

  app.get("/admin/brain/decisions", scope.admin(), async (c) => {
    requireVisible();
    const doc = c.req.query("doc") || null;
    const limit = limitParam(c.req.query("limit"), "limit", 20, 200);
    const filters = { doc };
    const cursor = transcriptCursor(c.req.query("cursor"), "cognition-decisions", filters);
    const matches: Array<{ decision: CognitionRunDecision; ref: CognitionTranscriptRef }> = [];
    let scanBoundary: CognitionTranscriptRef | undefined;
    const scanPageSize = doc ? Math.max(100, Math.min(500, (limit + 1) * 4)) : limit + 1;
    const probePage = await query.listTranscripts({
      limit: scanPageSize + 1,
      ...(cursor ? { before: cursor } : {}),
    });
    const probe = probePage.items;
    const hasUnscannedRefs = probePage.indexComplete && probe.length > scanPageSize;
    for (const ref of probe.slice(0, scanPageSize)) {
      scanBoundary = ref;
      let decision: CognitionRunDecision;
      try {
        decision = summarizeCognitionTranscript(await query.loadTranscript(ref.fileName));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (doc && decision.docId !== doc) continue;
      matches.push({ decision, ref });
      if (matches.length >= limit + 1) break;
    }
    const hasMore =
      probePage.indexComplete &&
      (matches.length > limit || (matches.length <= limit && hasUnscannedRefs));
    const page = hasMore ? matches.slice(0, limit) : matches;
    const boundary = matches.length > limit ? page.at(-1)?.ref : scanBoundary;
    const nextCursor = timedNextCursor(
      "cognition-decisions",
      hasMore && boundary ? { at: boundary.finishedAt, id: boundary.fileName } : undefined,
      filters,
    );
    return c.json({
      ...buildPage(
        page.map(({ decision }) => decision),
        { hasMore, limit, nextCursor },
      ),
      rebuilding: !probePage.indexComplete,
      ...(!probePage.indexComplete ? { retryAfterMs: 100 } : {}),
    });
  });
}

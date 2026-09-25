// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildPage } from "@omnesis/types";
import { BadRequestError, StalePageCursorError } from "../http/errors.js";
import { decodePageCursor, encodePageCursor } from "../http/pagination-cursor.js";
import { decodeRunTrigger } from "./run-payload-view.js";
import { runScopeLoopId } from "./run-payloads.js";
import { FEED_TIER, type FeedTier } from "./ranking.js";
import type {
  CognitionAdminDocumentRef,
  CognitionAdminQueryService,
  RunActivityReader,
} from "./cognition-admin-query-service.js";
import type { BriefRow, CognitionRunRow, OpenLoopRow, RetiredLoopRow } from "./storage/types.js";
import type { CognitionTranscriptRef } from "./transcripts.js";
import type { RouteApp } from "../http/routes/types.js";

export interface CognitionAdminRouteContext {
  app: RouteApp;
  query: CognitionAdminQueryService;
  requireActive(): void;
  /**
   * Read-only history stays servable while the Brain is visible but not
   * running (experimental on, no model assigned): past loops, runs, briefs
   * and spend are audit history, not live engine state. Hidden entirely
   * only when the feature is not visible at all.
   */
  requireVisible(): void;
  now(): number;
}

export const FEED_TIER_LABEL: Record<FeedTier, string> = {
  [FEED_TIER.nextHour]: "next-hour",
  [FEED_TIER.today]: "today",
  [FEED_TIER.dueLoop]: "due-loop",
  [FEED_TIER.otherLoop]: "other-loop",
  [FEED_TIER.ambientInfo]: "ambient-info",
};

export const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

export function limitParam(
  raw: string | undefined,
  name: string,
  fallback: number,
  max: number,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new BadRequestError(`${name} must be a positive integer`);
  }
  return Math.min(n, max);
}

export function enumParam<T extends string>(
  raw: string | undefined,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new BadRequestError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

export interface TimedCursor {
  at: number;
  id: string;
}

export function timedCursor(
  raw: string | undefined,
  scopeName: string,
  filters: Record<string, string | number | boolean | null>,
  revision?: number,
): TimedCursor | null {
  return decodePageCursor(raw, scopeName, (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const value = payload as Record<string, unknown>;
    if (
      typeof value.at !== "number" ||
      !Number.isFinite(value.at) ||
      typeof value.id !== "string"
    ) {
      return null;
    }
    for (const [key, expected] of Object.entries(filters)) {
      if (value[key] !== expected) return null;
    }
    if (revision !== undefined) {
      if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision)) return null;
      if (value.revision !== revision) throw new StalePageCursorError();
    }
    return { at: value.at, id: value.id };
  });
}

export function timedNextCursor(
  scopeName: string,
  key: TimedCursor | undefined,
  filters: Record<string, string | number | boolean | null>,
  revision?: number,
): string | undefined {
  return key
    ? encodePageCursor(scopeName, {
        ...filters,
        ...(revision !== undefined ? { revision } : {}),
        ...key,
      })
    : undefined;
}

export function listPageInfo(hasMore: boolean, limit: number, nextCursor?: string) {
  return buildPage([], { hasMore, limit, nextCursor }).pageInfo;
}

export function loopDto(loop: OpenLoopRow) {
  return {
    id: loop.id,
    createdByRun: loop.createdByRun,
    state: loop.state,
    confidence: loop.confidence,
    importance: loop.importance,
    title: loop.title,
    description: loop.description,
    deadline: loop.deadline,
    actors: loop.actors,
    involved: loop.involved,
    docs: loop.docs,
    blockedBy: loop.blockedBy,
    createdAt: iso(loop.createdAt),
    lastUpdate: iso(loop.lastUpdate),
    lastDecayCheck: iso(loop.lastDecayCheck),
    decayCheckCount: loop.decayCheckCount,
  };
}

export function briefSummaryDto(brief: BriefRow) {
  return {
    id: brief.id,
    kind: brief.kind,
    state: brief.state,
    title: brief.title,
    createdAt: iso(brief.createdAt),
  };
}

export function briefFullDto(brief: BriefRow, citations?: CognitionAdminDocumentRef[]) {
  return {
    id: brief.id,
    createdByRun: brief.createdByRun,
    kind: brief.kind,
    state: brief.state,
    title: brief.title,
    description: brief.description,
    body: brief.body,
    citations: citations ?? brief.citations,
    relatedLoopIds: brief.relatedLoopIds,
    confidence: brief.confidence,
    urgency: brief.urgency,
    relevantUntil: iso(brief.relevantUntil),
    nextShow: iso(brief.nextShow),
    eventAt: iso(brief.eventAt),
    userFeedback: brief.userFeedback,
    createdAt: iso(brief.createdAt),
    updatedAt: iso(brief.updatedAt),
    threadConversationId: brief.threadConversationId,
  };
}

export function scheduledDto(run: CognitionRunRow) {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    attempts: run.attempts,
    loopId: runScopeLoopId(run.payload) ?? null,
    trigger: decodeRunTrigger(run.kind, run.payload, run.dedupeKey),
    fireAt: iso(run.nextAttemptAt),
    enqueuedAt: iso(run.enqueuedAt),
  };
}

export function runDto(run: CognitionRunRow, activity: RunActivityReader | undefined) {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    running: run.status === "pending" && (activity?.startedAtMs(run.id) ?? null) !== null,
    attempts: run.attempts,
    dedupeKey: run.dedupeKey,
    loopId: runScopeLoopId(run.payload) ?? null,
    trigger: decodeRunTrigger(run.kind, run.payload, run.dedupeKey),
    lastError: run.lastError,
    failureCode: run.failureCode,
    enqueuedAt: iso(run.enqueuedAt),
    nextAttemptAt: iso(run.nextAttemptAt),
    lastAttemptAt: iso(run.lastAttemptAt),
    completedAt: iso(run.completedAt),
    usage: run.usage,
  };
}

export function transcriptRefDto(ref: CognitionTranscriptRef) {
  return {
    fileName: ref.fileName,
    runId: ref.runId,
    attempt: ref.attempt,
    finishedAt: iso(ref.finishedAt),
  };
}

export function retiredLoopDto(loop: RetiredLoopRow) {
  return {
    id: loop.id,
    title: loop.title,
    titleNorm: loop.titleNorm,
    description: loop.description,
    actors: loop.actors,
    involved: loop.involved,
    outcome: loop.outcome,
    importance: loop.importance,
    deadline: loop.deadline,
    createdAt: iso(loop.createdAt),
    retiredAt: iso(loop.retiredAt),
    cadenceDays: loop.cadenceDays,
    recurrenceCount: loop.recurrenceCount,
  };
}

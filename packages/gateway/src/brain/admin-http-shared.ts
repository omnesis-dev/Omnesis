// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { buildPage } from "@omnesis/types";
import { BadRequestError, StalePageCursorError } from "../http/errors.js";
import { decodePageCursor, encodePageCursor } from "../http/pagination-cursor.js";
import { decodeRunTrigger } from "./run-payload-view.js";
import { parseCognitionSynthesisRunPayload, runScopeLoopId } from "./run-payloads.js";
import type {
  CognitionAdminDocumentRef,
  CognitionAdminQueryService,
  RunActivityReader,
} from "./cognition-admin-query-service.js";
import type {
  CognitionRunRow,
  ObservationRow,
  OpenLoopRow,
  RetiredLoopRow,
} from "./storage/types.js";
import type { CognitionTranscriptRef } from "./transcripts.js";
import type { CognitionDecisionRecord } from "./storage/decisions.js";
import type { RouteApp } from "../http/routes/types.js";

export interface CognitionAdminRouteContext {
  app: RouteApp;
  query: CognitionAdminQueryService;
  requireActive(): void;
  /**
   * Read-only history stays servable while the Brain is visible but not
   * running (experimental on, no model assigned): past loops, runs, observations
   * and spend are audit history, not live engine state. Hidden entirely
   * only when the feature is not visible at all.
   */
  requireVisible(): void;
  now(): number;
}

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

export function observationFullDto(
  observation: ObservationRow,
  citations?: CognitionAdminDocumentRef[],
) {
  return {
    id: observation.id,
    createdByRun: observation.createdByRun,
    state: observation.state,
    closeReason: observation.closeReason,
    summary: observation.summary,
    why: observation.why,
    userAuthored: observation.userAuthored,
    windowStart: iso(observation.windowStart),
    relevantUntil: iso(observation.relevantUntil),
    citations: citations ?? observation.citations,
    relatedLoopIds: observation.relatedLoopIds,
    claims: observation.claims,
    notedScores: observation.notedScores,
    scores: observation.scores,
    wouldPushAt: iso(observation.wouldPushAt),
    shippedAt: iso(observation.shippedAt),
    shippedConversationId: observation.shippedConversationId,
    shippedMessageId: observation.shippedMessageId,
    userAction: observation.userAction,
    createdAt: iso(observation.createdAt),
    updatedAt: iso(observation.updatedAt),
    closedAt: iso(observation.closedAt),
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
    usage: runUsageDto(run.usage),
    context: runContextDto(run),
  };
}

/** Spend only; context occupancy is served beside it as `context`. */
function runUsageDto(usage: CognitionRunRow["usage"]) {
  if (!usage) return null;
  const { context: _context, ...spend } = usage;
  return spend;
}

/**
 * How much of its model's context window a run's conversation filled, and why
 * it handed its work to a successor if it did. Null when the backend reported
 * no input sizes and the run did not hand off.
 */
function runContextDto(run: CognitionRunRow) {
  const usage = run.usage?.context;
  const handoffReason =
    run.kind === "synthesis"
      ? (parseCognitionSynthesisRunPayload(run.payload)?.handoffReason ?? null)
      : null;
  if (!usage && handoffReason === null) return null;
  return {
    peakInputTokens: usage?.peakInputTokens ?? null,
    lastInputTokens: usage?.lastInputTokens ?? null,
    contextWindowTokens: usage?.contextWindowTokens ?? null,
    handoffReason,
  };
}

/**
 * One decision-model judgement as the runs page shows it: what was asked
 * (the exact state and questions sent), what came back, and the verdict it
 * produced. A reused judgement carries no request of its own — it points at
 * the decision it repeated.
 */
export function decisionDto(
  decision: CognitionDecisionRecord,
  subjectDoc: CognitionAdminDocumentRef | undefined,
) {
  return {
    id: decision.id,
    runId: decision.runId,
    purpose: decision.purpose,
    lane: decision.lane,
    verdict: decision.verdict,
    score: decision.score,
    threshold: decision.threshold,
    modelId: decision.modelId,
    rubricVersion: decision.rubricVersion,
    documentId: decision.documentId,
    subjectDocumentId: decision.subjectDocumentId,
    inheritedFromParent: decision.subjectDocumentId !== decision.documentId,
    subjectDoc: subjectDoc ?? null,
    reusedFrom: decision.reusedFrom,
    recordId: decision.recordId,
    enforced: decision.enforced,
    error: decision.error,
    latencyMs: decision.latencyMs,
    inputTokens: decision.inputTokens,
    createdAt: iso(decision.createdAt),
    request: parseJsonOrNull(decision.requestJson),
    response: parseJsonOrNull(decision.responseJson),
    // The inspection endpoint serves the exact payload where one was captured
    // and the row's own retained copy otherwise.
    inputInspection: true,
  };
}

function parseJsonOrNull(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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

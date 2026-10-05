// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AgentEvent, RateLimitPatience } from "@omnesis/core";

/** Bounded structured destinations per ephemeral Browser Find agent task. */
export const BROWSER_FIND_AGENT_RESULT_LIMIT = 30;

/** How long one Browser Find search may run before its stream reports a timeout. */
export const BROWSER_FIND_TIMEOUT_MS = 180_000;

/**
 * How long a Browser Find agent task waits out a provider rate limit. A search
 * is one task the user cannot reply to, so a per-minute token quota that resets
 * within a minute should delay it rather than fail it and throw away its
 * research. The wait is capped at half the search deadline so the turn still
 * has time to finish once the quota resets.
 */
export const BROWSER_FIND_RATE_LIMIT_PATIENCE: Readonly<Required<RateLimitPatience>> = {
  maxAttempts: 4,
  maxTotalDelayMs: BROWSER_FIND_TIMEOUT_MS / 2,
};

export interface FindSearchInput {
  text: string;
  /** Omitted selects automatic routing; explicit modes bypass the routing model. */
  mode?: "direct" | "agentic";
  limit?: number;
  timeZone?: string;
}
export interface FindEvidence {
  documentId: string;
  title: string;
  sourceUrl?: string;
}
export interface FindSearchResult {
  /** Stable identity of the destination, distinct from its evidence document. */
  id: string;
  documentId?: string;
  title: string;
  sourceUrl?: string;
  sourceId: string;
  chunkText: string;
  sourceCreatedAt?: string;
  evidence?: FindEvidence[];
}
export interface FindDecision {
  mode: "direct" | "agentic";
  status: "decided" | "not_configured" | "unavailable";
  reason: string;
  model?: string;
  confidence?: number;
  requested?: boolean;
}
export type FindStreamEvent =
  | AgentEvent
  | { type: "find.decision"; payload: FindDecision }
  | {
      type: "find.results";
      payload: { results: FindSearchResult[]; complete: boolean; hasMore?: boolean };
    }
  | { type: "find.complete"; payload: { mode: "direct" | "agentic" } }
  | { type: "find.error"; payload: { message: string; code?: string } };
export interface FindSearchExecution {
  /** Recheck caller authority immediately before each paid model pass. */
  beforeModelCall?: () => void;
  signal: AbortSignal;
  emit(event: FindStreamEvent): void;
}

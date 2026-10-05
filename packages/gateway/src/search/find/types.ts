// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AgentEvent } from "@omnesis/core";

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

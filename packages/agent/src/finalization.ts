// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AgentEvent } from "@omnesis/core";

/** Optional host policy. Observations are private, never ordinary transcript text. */
export interface TurnFinalizer {
  observe(event: AgentEvent): void;
  finalize(input: { draft: string; overflow: boolean; signal: AbortSignal }): Promise<string>;
}

export type TurnFinalizerFactory = (input: {
  sessionId: string;
  messageId: string;
  question: string;
  priorUserStatements?: readonly string[];
}) => TurnFinalizer;

/** Bound private candidate buffering independently of a provider's output limit. */
export const FINALIZATION_DRAFT_LIMIT = 65_536;

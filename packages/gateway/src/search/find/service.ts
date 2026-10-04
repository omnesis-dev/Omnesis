// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { decideFindRoute } from "./decision.js";
import { buildBrowserFindRuntime } from "./runtime.js";
import type { DecisionCapability } from "@omnesis/core";
import type { AgentService } from "../../agent/service.js";
import type { SearchPipeline } from "../pipeline.js";
import type { FindSearchExecution, FindSearchInput, FindSearchResult } from "./types.js";

/** A fresh, read-only search task; it never creates a conversation or follow-up session. */
export class FindSearchService {
  constructor(
    private readonly deps: {
      searchPipeline?: Pick<SearchPipeline, "search">;
      getDecision: () => DecisionCapability | null;
      recordDecisionSpend?: (modelId: string, inputTokens: number) => Promise<void>;
      getAgentService: () => AgentService | null;
    },
  ) {}

  async search(input: FindSearchInput, execution: FindSearchExecution): Promise<void> {
    const { signal, emit } = execution;
    signal.throwIfAborted();
    execution.beforeModelCall?.();
    signal.throwIfAborted();
    const decision = await decideFindRoute(
      input,
      this.deps.getDecision,
      signal,
      this.deps.recordDecisionSpend,
    );
    signal.throwIfAborted();
    emit({ type: "find.decision", payload: decision });
    try {
      if (decision.mode === "direct") {
        if (!this.deps.searchPipeline) throw new Error("The search index is unavailable.");
        const response = await this.deps.searchPipeline.search({
          text: input.text,
          limit: input.limit ?? 25,
        });
        signal.throwIfAborted();
        const results: FindSearchResult[] = response.results.map((hit) => ({
          id: hit.documentId,
          documentId: hit.documentId,
          title: hit.title,
          sourceUrl: hit.sourceUrl,
          sourceId: hit.sourceId,
          chunkText: hit.chunkText,
          sourceCreatedAt: hit.sourceCreatedAt,
        }));
        emit({
          type: "find.results",
          payload: {
            results,
            complete: true,
            hasMore: results.length >= (input.limit ?? 25) && (input.limit ?? 25) < 200,
          },
        });
      } else {
        const agent = this.deps.getAgentService();
        if (!agent)
          throw new Error(
            "Agentic search was selected, but no agent model is available. Configure an agent model in the gateway.",
          );
        const result = await buildBrowserFindRuntime({
          agent,
          limit: Math.min(input.limit ?? 20, 20),
          query: input.text,
          beforeModelCall: execution.beforeModelCall,
          timeZone: input.timeZone,
          signal,
          onEvent: (event) => {
            signal.throwIfAborted();
            emit(event);
          },
          onResults: (results) => {
            signal.throwIfAborted();
            emit({ type: "find.results", payload: { results, complete: false } });
          },
        });
        signal.throwIfAborted();
        if (!result.presented)
          throw new Error(
            "The agent finished without presenting search results. Try the search again.",
          );
      }
      emit({ type: "find.complete", payload: { mode: decision.mode } });
    } catch (error) {
      signal.throwIfAborted();
      emit({
        type: "find.error",
        payload: { message: error instanceof Error ? error.message : "Search failed. Try again." },
      });
    }
  }
}

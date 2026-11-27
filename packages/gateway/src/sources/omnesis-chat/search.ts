// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Conversation search for the Ask list, on the index this source already
 * keeps. The query runs through the ordinary search pipeline restricted to
 * this source, keeping the hits its keyword lane found, and each hit's
 * document is mapped back to its conversation through `external_id`, which
 * is the conversation id.
 */

import { OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID } from "./ids.js";
import { stripDialogueMarkup } from "./render.js";
import type Database from "better-sqlite3";

import type { ConversationSearch, ConversationSearchHit } from "../../agent/conversation-search.js";
import type { SearchPipeline } from "../../search/pipeline.js";

/** Index passages to rank; conversations come out fewer, one per document. */
const PASSAGE_LIMIT = 100;

export function createConversationSearch(deps: {
  pipeline: Pick<SearchPipeline, "search">;
  /** Read handle on `omnesis.db`. */
  db: Database.Database;
}): ConversationSearch {
  return async (query) => {
    const response = await deps.pipeline.search({
      text: query,
      filters: { sourceIds: [OMNESIS_CHAT_SOURCE_ID] },
      limit: PASSAGE_LIMIT,
    });
    const best = new Map<string, string>();
    for (const result of response.results) {
      // The query text may name other sources; only this one's hits count.
      if (result.sourceId !== OMNESIS_CHAT_SOURCE_ID || best.has(result.documentId)) continue;
      // The vector lane ranks every conversation, related or not, so a hit
      // counts only when the keyword lane found the query's words in it.
      if (result.scoreBreakdown?.bm25Rank === undefined) continue;
      best.set(result.documentId, result.chunkText);
    }
    if (best.size === 0) return [];
    const ids = [...best.keys()];
    const rows = deps.db
      .prepare<string[], { id: string; external_id: string }>(
        `SELECT id, external_id FROM documents
         WHERE provider_id = ? AND source_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
      )
      .all(OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID, ...ids);
    const conversationOf = new Map(rows.map((row) => [row.id, row.external_id]));
    const hits: ConversationSearchHit[] = [];
    for (const [documentId, text] of best) {
      const conversationId = conversationOf.get(documentId);
      if (conversationId) hits.push({ conversationId, text: stripDialogueMarkup(text) });
    }
    return hits;
  };
}

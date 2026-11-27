// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** How long typing must pause before the sidebar asks the gateway. */
export const CONVERSATION_SEARCH_DEBOUNCE_MS = 250;

/** The gateway's bound on a conversation search query. */
export const MAX_CONVERSATION_QUERY_LENGTH = 200;

/** What the sidebar searches for, or "" for the plain list. */
export function normalizeConversationQuery(input) {
  return String(input ?? "").trim().slice(0, MAX_CONVERSATION_QUERY_LENGTH);
}

/** One page of the sidebar list: the plain list, or the matches for a query. */
export function conversationListPath({ limit, cursor, query }) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set("q", query);
  else if (cursor) params.set("cursor", cursor);
  return `/agent/conversations?${params}`;
}

/**
 * Rows in display order. The plain list puts pinned conversations first,
 * keeping the gateway's newest-first order within each group, so an
 * optimistic pin toggle stays on top until the refetch lands. Search results
 * keep the gateway's relevance order.
 */
export function orderSidebarConversations(conversations, query) {
  if (query) return conversations;
  return [...conversations].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

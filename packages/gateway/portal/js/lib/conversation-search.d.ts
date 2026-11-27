// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const CONVERSATION_SEARCH_DEBOUNCE_MS: number;
export const MAX_CONVERSATION_QUERY_LENGTH: number;

export function normalizeConversationQuery(input: unknown): string;

export function conversationListPath(input: {
  limit: number;
  cursor?: string | null;
  query?: string | null;
}): string;

export function orderSidebarConversations<T extends { pinned?: boolean }>(
  conversations: T[],
  query: string | null | undefined,
): T[];

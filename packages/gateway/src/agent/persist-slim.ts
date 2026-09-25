// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Slim heavy tool results before a conversation is persisted.
 *
 * The `trace_connections` tool returns an `event_trail.built` result whose
 * `events[]` array can hold dozens to hundreds of documents (a full graph
 * walk — in real usage a median of ~54, up to ~250). That payload is the
 * agent's working memory for the turn; it is NOT a user-facing surface (the
 * Timeline is fed only by `annotate`). Keeping it in the persisted record
 * bloats storage and re-bills into the model's context on every resumed turn,
 * for no benefit.
 *
 * {@link slimPersistedHistory} empties the `events[]` array (to `[]`, not
 * dropped — so the result still decodes against the wire schema on every
 * client) while keeping `seeds` / `truncated` / `stats`. Those scalars are
 * retained for the MODEL's resumed context, not for any UI: on reload the
 * model still sees that a walk ran over which seeds, at what scale, and
 * whether it truncated — enough to decide whether to re-walk — without the
 * heavy document list. (The client's `trace_connections` card is ephemeral:
 * it is dropped from resumed transcripts, so the emptied `events[]` never
 * renders.) It runs at persist time only and CLONES the affected message +
 * part rather than mutating them, so the live in-memory history and the
 * already-broadcast SSE payload — which share the same result reference —
 * keep the full trail for the current session's subsequent turns and the
 * live client render.
 */

import type { ChatMessage } from "@omnesis/agent";

/**
 * Return a copy of `messages` with every `event_trail.built` tool result's
 * `events[]` emptied. Only the messages/parts actually changed are cloned;
 * everything else passes through by reference.
 */
export function slimPersistedHistory(messages: ReadonlyArray<ChatMessage>): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (
        part.kind === "tool_result" &&
        part.result.kind === "event_trail.built" &&
        part.result.events.length > 0
      ) {
        changed = true;
        return { ...part, result: { ...part.result, events: [] } };
      }
      return part;
    });
    return changed ? { ...message, parts } : message;
  });
}

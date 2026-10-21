// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Where a conversation opens: the reading anchor.
 *
 * After a load, when the agent is idle and the transcript ends on an
 * assistant reply the reader has not yet been positioned on, the transcript
 * opens with that reply's top at the top of the view, so the reader starts
 * at the beginning of what they have not read. Otherwise — a reply pending
 * after the owner's message, a turn in flight, a reply already read — it
 * follows the bottom.
 *
 * A finished reply is identified by its conversation and the conversation's
 * message count, both fixed once the reply has ended. `seen` records the reply
 * the reader was last positioned on, `{ reply }`, or that a reply finished
 * streaming while they watched, `{ watchedSessionId }`; the next load of that
 * conversation then names the watched reply and leaves the view at the bottom.
 */
export function readingAnchor({ sessionId, busy, turns, messageCount }, seen) {
  const last = turns?.[turns.length - 1];
  if (busy || !sessionId || last?.role !== "assistant") return { turnId: null, seen };
  const reply = `${sessionId}#${messageCount ?? turns.length}`;
  if (seen?.reply === reply) return { turnId: null, seen };
  if (seen?.watchedSessionId === sessionId) return { turnId: null, seen: { reply } };
  return { turnId: last.id, seen: { reply } };
}

/**
 * The `seen` record once a reply finishes streaming: watched when the page was
 * on screen, unread when it ended in a background tab.
 */
export function replyEnded(sessionId, visible) {
  return visible ? { watchedSessionId: sessionId } : null;
}

/**
 * The scroll offset that puts `target`'s top `gap` pixels below the top of the
 * scrolling `container`. The browser clamps it when the target is too close
 * to the end to reach the top.
 */
export function anchorScrollTop(container, target, gap = 8) {
  const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
  return Math.max(0, container.scrollTop + offset - gap);
}

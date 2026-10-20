// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export function newQueueHandoffIds(hiddenIds, requestedIds, consumedIds) {
  return [...new Set(requestedIds)].filter((id) => !hiddenIds?.has(id) && !consumedIds?.has(id));
}

/** Presentation-only handoff: retain durable receipts, including failures. */
export function visibleQueueControls(controls, hiddenIds, consumedIds) {
  if (!controls || (!hiddenIds?.size && !consumedIds?.size)) return controls;
  return {
    ...controls,
    queuedMessages: controls.queuedMessages?.filter(
      (message) => message.status !== "queued" || (!hiddenIds?.has(message.id) && !consumedIds?.has(message.id)),
    ),
  };
}

/** An emitted user turn consumes exact receipts independently of a Send now request. */
export function recordConsumedQueueReceipts(bySession, action) {
  if (action.kind !== "agent.user.message") return bySession;
  const { sessionId, submissionIds } = action.payload ?? {};
  if (typeof sessionId !== "string" || !sessionId || !Array.isArray(submissionIds)) return bySession;
  const ids = submissionIds.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 128);
  const previous = bySession.get(sessionId);
  if (!ids.some((id) => !previous?.has(id))) return bySession;
  const next = new Map(bySession);
  next.set(sessionId, new Set([...(previous ?? []), ...ids]));
  return next;
}

/** Hide before the HTTP/SSE race; restore only this attempt on failure. */
export async function handoffQueuedMessages({ send, hide, restore, isCurrent, refresh, onError }) {
  hide();
  try {
    await send();
  } catch (error) {
    // Restoration is scoped to the captured session/receipt IDs, so returning
    // to it later must not retain a mask for an unsuccessful request.
    restore();
    if (isCurrent()) {
      onError(error);
      await refresh();
    }
    return;
  }
  // A successful response can still say queued while cancellation unwinds.
  // Keep the mask until the view is replaced, even across stale GET responses.
  if (isCurrent()) await refresh();
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** How long a hidden portal keeps the exact Ask destination warm. */
export const AGENT_RETURN_WINDOW_MS = 3_600_000; // PARITY:agent-return-window-ms

export const AGENT_RETURN_STATE_KEY = "omnesis.agent-return-state";

export function freshAgentTarget() {
  return { kind: "fresh" };
}

export function conversationAgentTarget(id) {
  return { kind: "conversation", id };
}

/**
 * Decide what a bare Ask route should show when the portal opens or returns.
 * An addressed conversation is an explicit deep link and always wins. A
 * stored target is reusable only while its last-visible timestamp is less
 * than one hour old; invalid/future timestamps fail closed to a fresh draft.
 */
export function resolveAgentReturnTarget({ directConversationId, saved, now }) {
  if (directConversationId) return conversationAgentTarget(directConversationId);
  if (!isAgentReturnStateRecent(saved, now)) return freshAgentTarget();
  return saved.target;
}

export function isAgentReturnStateRecent(saved, now) {
  if (!saved || !Number.isFinite(saved.lastVisibleAt)) return false;
  const elapsed = now - saved.lastVisibleAt;
  return elapsed >= 0 && elapsed < AGENT_RETURN_WINDOW_MS;
}

export function readAgentReturnState(
  storage = globalThis.sessionStorage,
  fallbackStorage = globalThis.localStorage,
) {
  const primary = readStoredAgentReturnState(storage);
  return primary ?? readStoredAgentReturnState(fallbackStorage);
}

function readStoredAgentReturnState(storage) {
  try {
    const raw = storage?.getItem(AGENT_RETURN_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Number.isFinite(parsed?.lastVisibleAt)) return null;
    if (parsed?.target?.kind === "fresh") {
      return { lastVisibleAt: parsed.lastVisibleAt, target: freshAgentTarget() };
    }
    if (
      parsed?.target?.kind === "conversation" &&
      typeof parsed.target.id === "string" &&
      parsed.target.id.length > 0
    ) {
      return {
        lastVisibleAt: parsed.lastVisibleAt,
        target: conversationAgentTarget(parsed.target.id),
      };
    }
  } catch {
    // Storage can be disabled or contain a partial write. A fresh composer is
    // the safe fallback; the next successful save repairs the value.
  }
  return null;
}

export function writeAgentReturnState(
  target,
  now = Date.now(),
  storage = globalThis.sessionStorage,
  fallbackStorage = globalThis.localStorage,
) {
  const value = JSON.stringify({ lastVisibleAt: now, target });
  for (const destination of new Set([storage, fallbackStorage])) {
    try {
      destination?.setItem(AGENT_RETURN_STATE_KEY, value);
    } catch {
      // Best effort: private browsing must not make the Ask surface unusable.
    }
  }
}

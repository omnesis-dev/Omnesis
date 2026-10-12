// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a conversation can be deleted. The standing Morning brief
 * conversation (`origin.kind === "daily_brief"`) cannot: the gateway
 * answers 409, so no client offers Delete for it.
 */
export function canDeleteConversation(conversation) {
  return conversation?.origin?.kind !== "daily_brief";
}

/**
 * Hide a sidebar conversation immediately, then commit or roll back the
 * local tombstone when the authoritative deletion settles.
 */
export async function deleteSidebarConversation({
  id,
  activeConversationId,
  request,
  removeConversation,
  restoreConversation,
  onActiveDeleted,
}) {
  // Hide immediately after confirmation. The server also omits conversations
  // whose authoritative deletion is still running, so a refresh cannot bring
  // the row back during a slow index cleanup.
  removeConversation(id);
  try {
    const res = await request(`/agent/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    restoreConversation(id);
    throw err;
  }

  if (activeConversationId === id) onActiveDeleted();
}

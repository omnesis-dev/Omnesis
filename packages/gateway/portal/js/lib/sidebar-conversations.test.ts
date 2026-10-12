// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";

// @ts-expect-error — portal modules are plain JS.
import { canDeleteConversation, deleteSidebarConversation } from "./sidebar-conversations.js";

describe("canDeleteConversation", () => {
  test("offers Delete for every conversation except the standing Morning brief", () => {
    expect(canDeleteConversation({ id: "s_plain" })).toBe(true);
    expect(
      canDeleteConversation({ id: "s_watch", origin: { kind: "watch_firing", firingId: "f", runId: "f", watchId: "w" } }),
    ).toBe(true);
    expect(
      canDeleteConversation({ id: "s_morning", origin: { kind: "daily_brief", runId: "run_1", briefs: [] } }),
    ).toBe(false);
  });
});

describe("deleteSidebarConversation", () => {
  test("removes a conversation before the authoritative deletion settles", async () => {
    let resolveRequest!: (response: { ok: boolean; status: number }) => void;
    const response = new Promise<{ ok: boolean; status: number }>((resolve) => {
      resolveRequest = resolve;
    });
    const request = vi.fn().mockReturnValue(response);
    const removeConversation = vi.fn();
    const restoreConversation = vi.fn();
    const onActiveDeleted = vi.fn();

    const deletion = deleteSidebarConversation({
      id: "conversation-a",
      activeConversationId: "conversation-a",
      request,
      removeConversation,
      restoreConversation,
      onActiveDeleted,
    });

    expect(removeConversation).toHaveBeenCalledWith("conversation-a");
    expect(onActiveDeleted).not.toHaveBeenCalled();
    resolveRequest({ ok: true, status: 200 });
    await deletion;

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("/agent/conversations/conversation-a", {
      method: "DELETE",
    });
    expect(restoreConversation).not.toHaveBeenCalled();
    expect(onActiveDeleted).toHaveBeenCalledOnce();
  });

  test("restores the conversation when deletion fails", async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, status: 409 });
    const removeConversation = vi.fn();
    const restoreConversation = vi.fn().mockResolvedValue(undefined);
    const onActiveDeleted = vi.fn();

    await expect(deleteSidebarConversation({
      id: "conversation-a",
      activeConversationId: "conversation-a",
      request,
      removeConversation,
      restoreConversation,
      onActiveDeleted,
    })).rejects.toThrow("HTTP 409");

    expect(removeConversation).toHaveBeenCalledWith("conversation-a");
    expect(restoreConversation).toHaveBeenCalledWith("conversation-a");
    expect(onActiveDeleted).not.toHaveBeenCalled();
  });

  test("does not navigate when deleting an inactive conversation", async () => {
    const removeConversation = vi.fn();
    const onActiveDeleted = vi.fn();

    await deleteSidebarConversation({
      id: "conversation-a",
      activeConversationId: "conversation-b",
      request: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      removeConversation,
      restoreConversation: vi.fn(),
      onActiveDeleted,
    });

    expect(removeConversation).toHaveBeenCalledWith("conversation-a");
    expect(onActiveDeleted).not.toHaveBeenCalled();
  });
});

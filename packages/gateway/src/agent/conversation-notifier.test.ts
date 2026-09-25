// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  clipNotificationBody,
  conversationCollapseId,
  ConversationNotifier,
  MAX_NOTIFICATION_BODY_CHARS,
} from "./conversation-notifier.js";

describe("ConversationNotifier", () => {
  test("publishes the conversation target and rendered banner once", async () => {
    const publish = vi.fn(async () => []);
    const notifier = new ConversationNotifier({ publish });
    await notifier.notify({
      conversationId: "conversation-example",
      title: "Fictional conversation",
      body: "A fictional update is ready.",
    });
    expect(publish).toHaveBeenCalledWith({
      kind: "conversation",
      title: "Fictional conversation",
      body: "A fictional update is ready.",
      data: { conversationId: "conversation-example" },
      collapseId: "agent-answer:conversation-example",
    });
  });

  test("uses a generic title when the conversation has none", async () => {
    const publish = vi.fn(async () => []);
    await new ConversationNotifier({ publish }).notify({
      conversationId: "conversation-example",
      title: "",
      body: "Fictional update",
    });
    expect(publish.mock.calls[0]?.[0].title).toBe("Omnesis");
  });

  test("reports broadcaster failures without rejecting the conversation write", async () => {
    const publish = vi.fn(async () => [
      {
        deviceId: "00000000-0000-4000-8000-000000000001" as never,
        transport: "unavailable" as const,
        ok: false as const,
        reason: "not registered",
      },
    ]);
    await expect(
      new ConversationNotifier({ publish }).notify({
        conversationId: "conversation-example",
        title: "Fictional conversation",
        body: "Fictional update",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("conversation notification helpers", () => {
  test("collapse ids are stable per conversation", () => {
    expect(conversationCollapseId("conversation-example")).toBe(
      "agent-answer:conversation-example",
    );
  });

  test("body clipping collapses whitespace and prefers a nearby word boundary", () => {
    const clipped = clipNotificationBody(`  ${"fictional ".repeat(40)}\nupdate  `);
    expect(clipped.length).toBeLessThanOrEqual(MAX_NOTIFICATION_BODY_CHARS);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipped).not.toContain("\n");
  });

  test("short bodies remain unchanged", () => {
    expect(clipNotificationBody("Fictional update.")).toBe("Fictional update.");
  });
});

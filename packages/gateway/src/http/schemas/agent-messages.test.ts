// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ingestAgentMessagesBody } from "./agent-messages.js";

const message = {
  harness: "hermes",
  channel: "slack",
  chatId: "room-1",
  role: "user",
  text: "hello",
  occurredAt: 1_000,
};

describe("pushed conversation authors", () => {
  it("accepts legacy messages without asserting ownership", () => {
    expect(
      ingestAgentMessagesBody.parse({ messages: [message] }).messages[0].author,
    ).toBeUndefined();
  });

  it.each(["owner", "participant", "unknown"])(
    "accepts structured user attribution: %s",
    (kind) => {
      const author = { kind, id: "speaker-1", name: "Casey" };
      expect(
        ingestAgentMessagesBody.parse({ messages: [{ ...message, author }] }).messages[0].author,
      ).toEqual(author);
    },
  );

  it.each([
    { role: "user", author: { kind: "agent" } },
    { role: "assistant", author: { kind: "owner" } },
    { role: "assistant", author: { kind: "participant" } },
    { author: { kind: "participant", name: "x".repeat(201) } },
    { author: { kind: "participant", id: "x".repeat(257) } },
    { author: { kind: "participant", name: " " } },
    { author: { kind: "participant", name: " ".repeat(201) + "A" } },
    { author: { kind: "owner", trusted: true } },
  ])("rejects contradictory or unbounded attribution %#", (extra) => {
    expect(
      ingestAgentMessagesBody.safeParse({ messages: [{ ...message, ...extra }] }).success,
    ).toBe(false);
  });

  it("accepts assistant attribution without requiring a display identity", () => {
    expect(
      ingestAgentMessagesBody.safeParse({
        messages: [{ ...message, role: "assistant", author: { kind: "agent" } }],
      }).success,
    ).toBe(true);
  });
});

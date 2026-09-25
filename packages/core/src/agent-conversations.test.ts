// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  conversationExternalId,
  localDayBounds,
  localDayKey,
  localHourMinute,
  platformLabel,
  renderConversationDay,
  type ConversationChat,
  type ConversationMessage,
  type RenderConversationDayOptions,
} from "./agent-conversations.js";

describe("local day helpers", () => {
  it("round-trips a key through its bounds", () => {
    // TZ-agnostic: the day key of any instant must lie within that key's bounds,
    // and the bounds' start must map back to the same key.
    const ms = new Date(2026, 6, 20, 13, 45, 0).getTime();
    const key = localDayKey(ms);
    const { startMs, endMs } = localDayBounds(key);
    expect(ms).toBeGreaterThanOrEqual(startMs);
    expect(ms).toBeLessThan(endMs);
    expect(localDayKey(startMs)).toBe(key);
    expect(localDayKey(endMs - 1)).toBe(key);
  });

  it("puts a just-after-midnight instant on that local day, not the previous one", () => {
    const justAfterMidnight = new Date(2026, 0, 2, 0, 30, 0).getTime();
    expect(localDayKey(justAfterMidnight)).toBe("2026-01-02");
  });

  it("formats hour:minute zero-padded", () => {
    expect(localHourMinute(new Date(2026, 0, 1, 9, 5, 0).getTime())).toBe("09:05");
    expect(localHourMinute(new Date(2026, 0, 1, 23, 59, 0).getTime())).toBe("23:59");
  });

  it("consecutive days differ by exactly one day-width in bounds", () => {
    const a = localDayBounds("2026-03-10");
    const b = localDayBounds("2026-03-11");
    expect(b.startMs).toBe(a.endMs);
  });

  it.each([
    ["2026-03-29", 23],
    ["2026-10-25", 25],
  ])("uses the real Europe/London DST width for %s", (day, expectedHours) => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "Europe/London";
    try {
      const { startMs, endMs } = localDayBounds(day);
      expect((endMs - startMs) / 3_600_000).toBe(expectedHours);
      expect(localDayKey(startMs)).toBe(day);
      expect(localDayKey(endMs - 1)).toBe(day);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });
});

const providerId = ProviderId("nova");
const sourceId = SourceId("nova:local");

function opts(
  chat: ConversationChat,
  messages: ConversationMessage[],
  dayKey = "2026-07-20",
): RenderConversationDayOptions {
  return { chat, dayKey, messages, providerId, sourceId, agentName: "Nova", harnessId: "nova" };
}

const slackChat: ConversationChat = {
  platform: "slack",
  chatId: "C012345",
  chatName: "General",
  chatType: "dm",
};

const twoTurns: ConversationMessage[] = [
  {
    role: "user",
    text: "what's my flight tomorrow?",
    atMs: new Date(2026, 6, 20, 9, 14).getTime(),
  },
  {
    role: "assistant",
    text: "You're on flight XY123 at 08:40.",
    atMs: new Date(2026, 6, 20, 9, 14).getTime(),
  },
];

describe("renderConversationDay", () => {
  it("builds the composite externalId <platform>:<chat>:<day>", () => {
    const doc = renderConversationDay(opts(slackChat, twoTurns));
    expect(doc.externalId).toBe("slack:C012345:2026-07-20");
    expect(conversationExternalId(slackChat, "2026-07-20")).toBe(doc.externalId);
  });

  it("uses 'local' as the chat segment for a host-local surface", () => {
    const cli: ConversationChat = { platform: "cli", chatId: "" };
    const doc = renderConversationDay(opts(cli, twoTurns));
    expect(doc.externalId).toBe("cli:local:2026-07-20");
  });

  it("renders a dialogue-only body with 'You' and the agent name", () => {
    const doc = renderConversationDay(opts(slackChat, twoTurns));
    expect(doc.content).toContain("· You**");
    expect(doc.content).toContain("· Nova**");
    expect(doc.content).toContain("what's my flight tomorrow?");
    expect(doc.content).toContain("You're on flight XY123 at 08:40.");
    // No tool traces / telemetry.
    expect(doc.content).not.toContain("tool_call");
  });

  it("marks the human self and never adds the agent to the people graph", () => {
    const doc = renderConversationDay(opts(slackChat, twoTurns));
    expect(doc.metadata.people).toEqual([{ role: "participant", name: "You", isSelf: true }]);
  });

  it("sets conversation type, rollingAggregate, and harness-pushed provenance", () => {
    const doc = renderConversationDay(opts(slackChat, twoTurns));
    expect(doc.metadata.documentType).toBe("conversation");
    expect(doc.metadata.rollingAggregate).toBe(true);
    expect(doc.metadata.sourceUrl).toBeUndefined();
    expect(doc.metadata.appUrl).toBeUndefined();
    expect(doc.metadata.extra).toMatchObject({
      harness: "nova",
      channel: "slack",
      provenance: "harness-pushed",
      messageCount: 2,
    });
  });

  it("is a pure function of content — identical input, identical hash", () => {
    const a = renderConversationDay(opts(slackChat, twoTurns));
    const b = renderConversationDay(opts(slackChat, twoTurns));
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("changes the hash when a message is appended, keeping the externalId", () => {
    const a = renderConversationDay(opts(slackChat, twoTurns));
    const grown = [
      ...twoTurns,
      { role: "user" as const, text: "thanks", atMs: new Date(2026, 6, 20, 9, 20).getTime() },
    ];
    const b = renderConversationDay(opts(slackChat, grown));
    expect(b.externalId).toBe(a.externalId);
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  it("carries first/last timestamps into sourceCreatedAt/UpdatedAt", () => {
    const grown = [
      ...twoTurns,
      { role: "assistant" as const, text: "np", atMs: new Date(2026, 6, 20, 18, 0).getTime() },
    ];
    const doc = renderConversationDay(opts(slackChat, grown));
    expect(doc.sourceCreatedAt).toBe(new Date(twoTurns[0].atMs).toISOString());
    expect(doc.sourceUpdatedAt).toBe(new Date(grown[2].atMs).toISOString());
  });

  it("throws on an empty day (callers must filter)", () => {
    expect(() => renderConversationDay(opts(slackChat, []))).toThrow();
  });
});

describe("platformLabel", () => {
  it("maps known channels and capitalizes unknown ones", () => {
    expect(platformLabel("whatsapp")).toBe("WhatsApp");
    expect(platformLabel("cli")).toBe("CLI");
    expect(platformLabel("mysteryapp")).toBe("Mysteryapp");
  });
});

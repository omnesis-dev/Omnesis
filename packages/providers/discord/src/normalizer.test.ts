// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { DAVID, JAMIE, MAYA, SARAH, TICKER_BOT, msg } from "./fake-discord.js";
import {
  MAX_CONTENT_CHARS,
  normalizeChannelDay,
  renderMentions,
  renderMessage,
} from "./normalizer.js";
import type { ChannelRef } from "./types.js";

const ctx = {
  providerId: ProviderId("discord:900000000000000001"),
  sourceId: SourceId("discord:900000000000000001"),
  selfUserId: MAYA.id,
};

const general: ChannelRef = {
  id: "10",
  guildId: "1",
  guildName: "Northstar Labs",
  name: "general",
  kind: "text",
};

const post: ChannelRef = {
  id: "30",
  guildId: "1",
  guildName: "Northstar Labs",
  name: "Q4 budget review",
  kind: "forum-post",
  parentName: "planning",
};

describe("renderMentions", () => {
  it("names mentioned users and flattens custom emoji", () => {
    expect(
      renderMentions(`hey <@${JAMIE.id}> and <@!${DAVID.id}> <:party:123456> <#55> <@&66>`, [
        JAMIE,
        DAVID,
      ]),
    ).toBe("hey @Jamie Lopez and @David Lin :party: <#55> <@&66>");
  });

  it("keeps an unknown mention as-is", () => {
    expect(renderMentions("<@42>", [])).toBe("<@42>");
  });
});

describe("renderMessage", () => {
  it("renders time, author, text, attachments, embeds, edits and the quoted reply", () => {
    const parent = msg("10", JAMIE, "2026-03-08T08:59:00.000Z", "plan?\nsecond line");
    const m = msg("10", MAYA, "2026-03-08T09:04:30.000Z", "here you go", {
      type: 19,
      edited_timestamp: "2026-03-08T09:10:00.000Z",
      attachments: [
        { id: "a", filename: "budget.xlsx", size: 10, url: "https://cdn.example.com/x" },
      ],
      embeds: [{ title: "Q4 plan", url: "https://example.com/plan" }],
      referenced_message: parent,
    });
    expect(renderMessage(m)).toBe(
      "> _Jamie Lopez: plan?_\n**09:04** Maya Reeves: here you go [Attachment: budget.xlsx] [Embed: Q4 plan] _(edited)_",
    );
  });

  it("falls back to the username when no display name is set", () => {
    expect(renderMessage(msg("10", SARAH, "2026-03-08T09:04:30.000Z", "hi"))).toBe(
      "**09:04** smendez: hi",
    );
  });

  it("reads Discord's +00:00 offset spelling as the same UTC instant", () => {
    const doc = normalizeChannelDay(
      general,
      "2026-03-08",
      [msg("10", SARAH, "2026-03-08T23:59:30.123000+00:00", "late")],
      ctx,
    )!;
    expect(doc.content).toContain("**23:59** smendez: late");
    expect(doc.sourceCreatedAt).toBe("2026-03-08T23:59:30.123Z");
  });

  it("renders nothing for a message with no content, attachment or embed", () => {
    expect(renderMessage(msg("10", MAYA, "2026-03-08T09:04:30.000Z", ""))).toBe("");
  });
});

describe("normalizeChannelDay", () => {
  const day = "2026-03-08";
  const messages = [
    msg("10", MAYA, "2026-03-08T09:00:00.000Z", `morning <@${DAVID.id}>`, { mentions: [DAVID] }),
    msg("10", TICKER_BOT, "2026-03-08T09:01:00.000Z", "AAPL 1.2%"),
    msg("10", JAMIE, "2026-03-08T09:02:00.000Z", "joined", { type: 7 }),
    msg("10", JAMIE, "2026-03-08T09:03:00.000Z", "morning!"),
    msg("10", JAMIE, "2026-03-08T09:04:00.000Z", "again", {
      edited_timestamp: "2026-03-08T10:00:00.000Z",
    }),
    msg("10", JAMIE, "2026-03-08T09:05:00.000Z", `<@${TICKER_BOT.id}> quote?`, {
      mentions: [TICKER_BOT],
    }),
  ];

  it("builds one conversation document with a stable id and a link to its first message", () => {
    const doc = normalizeChannelDay(general, day, messages, ctx)!;
    expect(doc.externalId).toBe("10:2026-03-08");
    expect(doc.title).toBe("Northstar Labs #general — 2026-03-08");
    expect(doc.metadata.sourceUrl).toBe(`https://discord.com/channels/1/10/${messages[0].id}`);
    expect(doc.metadata.documentType).toBe("conversation");
    expect(doc.content).toBe(
      [
        "# Northstar Labs #general — 2026-03-08",
        "",
        "**09:00** Maya Reeves: morning @David Lin",
        "**09:01** ticker: AAPL 1.2%",
        "**09:03** Jamie Lopez: morning!",
        "**09:04** Jamie Lopez: again _(edited)_",
        "**09:05** Jamie Lopez: @ticker quote?",
      ].join("\n"),
    );
  });

  it("skips system notices and dates the document by its first and last change", () => {
    const doc = normalizeChannelDay(general, day, messages, ctx)!;
    expect(doc.metadata.extra?.messageCount).toBe(5);
    expect(doc.sourceCreatedAt).toBe("2026-03-08T09:00:00.000Z");
    // The edit at 10:00 is the newest change, later than the last message.
    expect(doc.sourceUpdatedAt).toBe("2026-03-08T10:00:00.000Z");
  });

  it("emits humans as namespaced participants, self flagged, bots excluded, mentions apart", () => {
    const doc = normalizeChannelDay(general, day, messages, ctx)!;
    expect(doc.metadata.people).toEqual([
      { role: "participant", name: "Maya Reeves", lids: [`discord:${MAYA.id}`], isSelf: true },
      { role: "participant", name: "Jamie Lopez", lids: [`discord:${JAMIE.id}`] },
      { role: "mentioned", name: "David Lin", lids: [`discord:${DAVID.id}`] },
    ]);
    expect(doc.metadata.extra?.participants).toEqual(["Maya Reeves", "Jamie Lopez"]);
  });

  it("describes a forum post with its parent channel", () => {
    const doc = normalizeChannelDay(post, day, messages, ctx)!;
    expect(doc.title).toBe("Northstar Labs #planning › Q4 budget review — 2026-03-08");
    expect(doc.metadata.extra).toMatchObject({
      guildName: "Northstar Labs",
      channelName: "Q4 budget review",
      channelKind: "forum-post",
      parentChannelName: "planning",
    });
  });

  it("flags the operator when they are mentioned, not only when they post", () => {
    const doc = normalizeChannelDay(
      general,
      day,
      [msg("10", JAMIE, "2026-03-08T09:00:00.000Z", `ping <@${MAYA.id}>`, { mentions: [MAYA] })],
      ctx,
    )!;
    expect(doc.metadata.people).toEqual([
      { role: "participant", name: "Jamie Lopez", lids: [`discord:${JAMIE.id}`] },
      { role: "mentioned", name: "Maya Reeves", lids: [`discord:${MAYA.id}`], isSelf: true },
    ]);
  });

  it("falls back to the username when the display name is an address or blank", () => {
    const odd = {
      id: "100000000000000005",
      username: "riverside",
      global_name: "riverside@example.com",
    };
    const blank = { id: "100000000000000006", username: "northstar", global_name: "   " };
    const doc = normalizeChannelDay(
      general,
      day,
      [
        msg("10", odd, "2026-03-08T09:00:00.000Z", "hi"),
        msg("10", blank, "2026-03-08T09:01:00.000Z", "hey"),
      ],
      ctx,
    )!;
    expect(doc.metadata.people!.map((p) => p.name)).toEqual(["riverside", "northstar"]);
  });

  it("treats a webhook post as automated even when its author lacks the bot flag", () => {
    const hook = { id: "900000000000000007", username: "Deploys" };
    const doc = normalizeChannelDay(
      general,
      day,
      [
        msg("10", hook, "2026-03-08T09:00:00.000Z", "deployed v2", {
          webhook_id: "700000000000000001",
        }),
        msg("10", JAMIE, "2026-03-08T09:01:00.000Z", "nice"),
      ],
      ctx,
    )!;
    expect(doc.content).toContain("**09:00** Deploys: deployed v2");
    expect(doc.metadata.people!.map((p) => p.name)).toEqual(["Jamie Lopez"]);
  });

  it("bounds a very long day and says how many messages were left out", () => {
    const wall = "x".repeat(2000);
    const many = Array.from({ length: 150 }, (_, i) =>
      msg(
        "10",
        JAMIE,
        `2026-03-08T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
        wall,
      ),
    );
    const doc = normalizeChannelDay(general, day, many, ctx)!;
    expect(doc.content.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS + 100);
    // Title (38) + blank, then 2023-character lines: 98 fit under the cap, 52 are cut off the tail.
    expect(doc.content).toMatch(/_… 52 more messages not shown_$/);
    expect(doc.content.split("\n").length).toBe(102);
    expect(doc.metadata.extra?.messageCount).toBe(150);
  });

  it("returns null for a day of system notices only", () => {
    const joins = [msg("10", JAMIE, "2026-03-08T09:02:00.000Z", "", { type: 7 })];
    expect(normalizeChannelDay(general, day, joins, ctx)).toBeNull();
  });
});

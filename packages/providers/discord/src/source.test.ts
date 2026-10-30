// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { DiscordClient } from "./client.js";
import { BOT, DAVID, FakeDiscord, JAMIE, MAYA, msg } from "./fake-discord.js";
import { DiscordSource } from "./source.js";
import { validateDiscordCursor } from "./types.js";
import discordProvider from "./index.js";
import type { DiscordCursor } from "./types.js";
import type { SyncResult } from "@omnesis/source-sdk";

const providerId = ProviderId("discord:900000000000000001");
const sourceId = SourceId("discord:900000000000000001");

function world() {
  const fake = new FakeDiscord();
  fake.addGuild("1", "Northstar Labs");
  fake.addChannel("1", { id: "10", type: 0, name: "general" });
  fake.addChannel("1", { id: "11", type: 4, name: "Category" });
  fake.addChannel("1", { id: "12", type: 2, name: "voice" });
  fake.addChannel("1", { id: "20", type: 15, name: "planning" });
  fake.addThread(
    "1",
    { id: "30", type: 11, name: "Q4 budget review", parent_id: "20" },
    { archived: true },
  );
  fake.addThread("1", { id: "31", type: 11, name: "standup notes", parent_id: "10" });
  fake.addThread("1", { id: "32", type: 12, name: "private", parent_id: "10" });
  fake.post(msg("10", MAYA, "2026-03-08T09:00:00.000Z", "morning"));
  fake.post(msg("10", JAMIE, "2026-03-08T09:03:00.000Z", "morning!"));
  fake.post(msg("10", MAYA, "2026-03-09T08:00:00.000Z", "day two"));
  fake.post(msg("30", DAVID, "2026-03-08T12:00:00.000Z", "budget draft attached"));
  fake.post(msg("31", JAMIE, "2026-03-09T10:00:00.000Z", "standup: shipped it"));
  return fake;
}

function source(
  fake: FakeDiscord,
  extra: Partial<ConstructorParameters<typeof DiscordSource>[0]> = {},
) {
  return new DiscordSource({
    client: new DiscordClient("valid-token", {
      fetchImpl: fake.fetch,
      sleep: () => Promise.resolve(),
    }),
    providerId,
    sourceId,
    ...extra,
  });
}

/** Drive `sync()` until `hasMore` is false, as the engine does within one tick. */
async function drain(src: DiscordSource, cursor: DiscordCursor | null) {
  const docs: SyncResult<DiscordCursor>["documents"] = [];
  const results: SyncResult<DiscordCursor>[] = [];
  let steps = 0;
  for (;;) {
    const res = await src.sync(cursor);
    docs.push(...res.documents);
    results.push(res);
    cursor = res.cursor;
    steps++;
    if (!res.hasMore) return { docs, cursor, steps, results };
    if (steps > 1000) throw new Error("sync did not terminate");
  }
}

describe("DiscordSource bootstrap", () => {
  it("indexes text channels, active and archived public threads as channel-day documents", async () => {
    const fake = world();
    const { docs, cursor } = await drain(source(fake), null);
    expect(docs.map((d) => d.externalId).sort()).toEqual([
      "10:2026-03-08",
      "10:2026-03-09",
      "30:2026-03-08",
      "31:2026-03-09",
    ]);
    expect(cursor.queue).toBeUndefined();
    expect(Object.keys(cursor.channels).sort()).toEqual(["10", "30", "31"]);
    // Never asked for voice, category, forum-container or private-thread messages.
    const asked = fake.requests.filter((r) => r.path.includes("/messages")).map((r) => r.path);
    expect(
      asked.some(
        (p) =>
          p.startsWith("/channels/12/") ||
          p.startsWith("/channels/20/") ||
          p.startsWith("/channels/32/"),
      ),
    ).toBe(false);
  });

  it("labels a forum post with its parent and a thread with its channel", async () => {
    const { docs } = await drain(source(world()), null);
    const byId = new Map(docs.map((d) => [d.externalId, d]));
    expect(byId.get("30:2026-03-08")!.title).toBe(
      "Northstar Labs #planning › Q4 budget review — 2026-03-08",
    );
    expect(byId.get("30:2026-03-08")!.metadata.extra?.channelKind).toBe("forum-post");
    expect(byId.get("31:2026-03-09")!.metadata.extra).toMatchObject({
      channelKind: "thread",
      parentChannelName: "general",
    });
  });

  it("labels an announcement channel and a plain text channel by kind", async () => {
    const fake = world();
    fake.addChannel("1", { id: "13", type: 5, name: "news" });
    fake.post(msg("13", DAVID, "2026-03-08T09:00:00.000Z", "release day"));
    const { docs } = await drain(source(fake), null);
    const kinds = new Map(docs.map((d) => [d.externalId, d.metadata.extra?.channelKind]));
    expect(kinds.get("13:2026-03-08")).toBe("announcement");
    expect(kinds.get("10:2026-03-08")).toBe("text");
  });

  it("starts from the data cutoff and drops nothing older than it", async () => {
    const fake = world();
    const { docs } = await drain(source(fake, { dataCutoff: "2026-03-09T00:00:00.000Z" }), null);
    expect(docs.map((d) => d.externalId).sort()).toEqual(["10:2026-03-09", "31:2026-03-09"]);
    const generalFetch = fake.requests.find((r) => r.path.startsWith("/channels/10/messages"))!;
    expect(generalFetch.path).not.toMatch(/after=0$/);
  });

  it("treats a mid-day cutoff as its whole UTC day, so the cut day is never a partial document", async () => {
    const fake = world();
    // The cutoff falls between the two messages of 2026-03-08 in #general.
    const { docs } = await drain(source(fake, { dataCutoff: "2026-03-08T09:01:00.000Z" }), null);
    const day = docs.find((d) => d.externalId === "10:2026-03-08")!;
    expect(day.metadata.extra?.messageCount).toBe(2);
    expect(day.sourceCreatedAt).toBe("2026-03-08T09:00:00.000Z");
  });

  it("indexes only the configured guilds and warns about unknown ones", async () => {
    const fake = world();
    fake.addGuild("2", "Riverside Estate");
    fake.addChannel("2", { id: "40", type: 0, name: "lobby" });
    fake.post(msg("40", DAVID, "2026-03-08T09:00:00.000Z", "hello"));
    const { docs } = await drain(source(fake, { guildIds: ["2", "999"] }), null);
    expect(docs.map((d) => d.externalId)).toEqual(["40:2026-03-08"]);
  });
});

describe("DiscordSource incremental", () => {
  it("emits nothing when upstream is unchanged and keeps every watermark", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    fake.requests.length = 0;
    const second = await drain(src, first.cursor);
    expect(second.docs).toEqual([]);
    expect(second.cursor.channels).toEqual(first.cursor.channels);
    // One re-read of the newest day per channel, nothing older.
    expect(fake.requests.filter((r) => r.path.includes("/messages")).length).toBe(3);
  });

  it("re-renders a day whole when a message lands on it", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    fake.post(msg("10", DAVID, "2026-03-09T09:30:00.000Z", "late addition"));
    const second = await drain(src, first.cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["10:2026-03-09"]);
    expect(second.docs[0].content).toContain("**08:00** Maya Reeves: day two");
    expect(second.docs[0].content).toContain("**09:30** David Lin: late addition");
    expect(second.cursor.channels["10"].lastId).not.toBe(first.cursor.channels["10"].lastId);
  });

  it("emits only the new day when the channel moves on", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    fake.post(msg("31", MAYA, "2026-03-10T10:00:00.000Z", "standup: reviewing"));
    const second = await drain(src, first.cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["31:2026-03-10"]);
  });

  it("re-emits the newest day when a message on it is edited, and only then", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    const target = fake.messages.get("10")!.find((m) => m.content === "day two")!;
    target.content = "day two (fixed)";
    target.edited_timestamp = "2026-03-09T09:00:00.000Z";
    const second = await drain(src, first.cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["10:2026-03-09"]);
    expect(second.docs[0].content).toContain("day two (fixed) _(edited)_");
    expect(second.docs[0].sourceUpdatedAt).toBe("2026-03-09T09:00:00.000Z");
    const third = await drain(src, second.cursor);
    expect(third.docs).toEqual([]);
  });

  it("re-emits the last indexed day on a partial deletion and keeps the watermark", async () => {
    const fake = world();
    const src = source(fake);
    const late = fake.post(msg("10", JAMIE, "2026-03-09T09:00:00.000Z", "later"));
    const first = await drain(src, null);
    fake.messages.set(
      "10",
      fake.messages.get("10")!.filter((m) => m.id !== late.id),
    );
    const second = await drain(src, first.cursor);
    expect(second.docs.map((d) => [d.externalId, d.metadata.extra?.messageCount])).toEqual([
      ["10:2026-03-09", 1],
    ]);
    expect(second.cursor.channels["10"].lastId).toBe(late.id);
    const third = await drain(src, second.cursor);
    expect(third.docs).toEqual([]);
    expect(third.results.flatMap((r) => r.deletedExternalIds)).toEqual([]);
  });

  it("tombstones the last indexed day when only system notices remain on it", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    fake.messages.get("10")!.find((m) => m.content === "day two")!.type = 7;
    const second = await drain(src, first.cursor);
    expect(second.docs).toEqual([]);
    expect(second.results.flatMap((r) => r.deletedExternalIds)).toEqual(["10:2026-03-09"]);
    const third = await drain(src, second.cursor);
    expect(third.results.flatMap((r) => r.deletedExternalIds)).toEqual([]);
  });

  it("still lands an edit on the last indexed day when a newer day has arrived since", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    const target = fake.messages.get("10")!.find((m) => m.content === "day two")!;
    target.content = "day two (fixed)";
    target.edited_timestamp = "2026-03-10T07:00:00.000Z";
    fake.post(msg("10", DAVID, "2026-03-10T08:00:00.000Z", "day three"));
    const second = await drain(src, first.cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["10:2026-03-09", "10:2026-03-10"]);
    expect(second.docs[0].content).toContain("day two (fixed)");
    const third = await drain(src, second.cursor);
    expect(third.docs).toEqual([]);
  });

  it("tombstones the last indexed day deleted whole while a newer day exists", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    fake.messages.set(
      "10",
      fake.messages.get("10")!.filter((m) => m.content !== "day two"),
    );
    fake.post(msg("10", DAVID, "2026-03-10T08:00:00.000Z", "day three"));
    const second = await drain(src, first.cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["10:2026-03-10"]);
    expect(second.results.flatMap((r) => r.deletedExternalIds)).toEqual(["10:2026-03-09"]);
  });

  it("visits every quiet channel within one call, so an idle cycle costs one page", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    const second = await drain(src, first.cursor);
    expect(second.docs).toEqual([]);
    expect(second.steps).toBe(1);
  });

  it("tombstones the newest day when every message on it is deleted", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    fake.messages.set("31", []);
    const second = await drain(src, first.cursor);
    expect(second.docs).toEqual([]);
    const tombstones = second.results.flatMap((r) => r.deletedExternalIds);
    expect(tombstones).toEqual(["31:2026-03-09"]);
    const third = await drain(src, second.cursor);
    expect(third.results.flatMap((r) => r.deletedExternalIds)).toEqual([]);
  });

  it("picks up a thread created since the last cycle", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    fake.addThread("1", { id: "33", type: 11, name: "incident", parent_id: "10" });
    fake.post(msg("33", JAMIE, "2026-03-10T11:00:00.000Z", "gateway is down"));
    const second = await drain(src, first.cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["33:2026-03-10"]);
  });
});

describe("DiscordSource paging", () => {
  it("holds back a half-fetched day at the page cap and renders it whole on the next call", async () => {
    const fake = new FakeDiscord();
    fake.addGuild("1", "Northstar Labs");
    fake.addChannel("1", { id: "10", type: 0, name: "busy" });
    // Day one: 150 messages; day two: 30. One page of 100 per call.
    for (let i = 0; i < 150; i++) {
      const minute = String(i % 60).padStart(2, "0");
      const hour = String(Math.floor(i / 60)).padStart(2, "0");
      fake.post(msg("10", MAYA, `2026-03-08T${hour}:${minute}:00.000Z`, `m${i}`));
    }
    for (let i = 0; i < 30; i++) {
      fake.post(msg("10", JAMIE, `2026-03-09T01:${String(i).padStart(2, "0")}:00.000Z`, `n${i}`));
    }
    const src = source(fake, { pagesPerCall: 1 });

    // Enumerates, then reads 100 messages, all on day one → held back, resume at day start.
    const a = await src.sync(null);
    expect(a.documents).toEqual([]);
    expect(a.hasMore).toBe(true);
    expect(a.cursor.queue?.[0].after).toBeDefined();

    // Resumes at the start of day one and, because that day is still open at
    // the cap, keeps paging until it closes: both days land whole.
    const b = await src.sync(a.cursor);
    expect(b.documents.map((d) => d.externalId)).toEqual(["10:2026-03-08", "10:2026-03-09"]);
    expect(b.documents[0].metadata.extra?.messageCount).toBe(150);
    expect(b.documents[1].metadata.extra?.messageCount).toBe(30);
    expect(b.hasMore).toBe(false);
    expect(b.cursor.queue).toBeUndefined();
  });

  it("slices a sparse history into at most daysPerCall day documents per call", async () => {
    const fake = new FakeDiscord();
    fake.addGuild("1", "Northstar Labs");
    fake.addChannel("1", { id: "10", type: 0, name: "sparse" });
    for (let d = 1; d <= 5; d++)
      fake.post(msg("10", MAYA, `2026-03-0${d}T09:00:00.000Z`, `day ${d}`));
    const src = source(fake, { daysPerCall: 2 });
    const a = await src.sync(null);
    expect(a.documents.map((d) => d.externalId)).toEqual(["10:2026-03-01", "10:2026-03-02"]);
    expect(a.hasMore).toBe(true);
    const b = await src.sync(a.cursor);
    expect(b.documents.map((d) => d.externalId)).toEqual(["10:2026-03-03", "10:2026-03-04"]);
    const c = await src.sync(b.cursor);
    expect(c.documents.map((d) => d.externalId)).toEqual(["10:2026-03-05"]);
    expect(c.hasMore).toBe(false);
  });

  it("finishes a capped channel over several calls and lands on the same corpus", async () => {
    const fake = world();
    // Three days of 90 messages: one page of 100 per call always ends mid-day.
    for (const day of ["10", "11", "12"]) {
      for (let i = 0; i < 90; i++) {
        fake.post(
          msg(
            "10",
            JAMIE,
            `2026-03-${day}T01:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
            `x${i}`,
          ),
        );
      }
    }
    const capped = await drain(source(fake, { pagesPerCall: 1 }), null);
    const uncapped = await drain(source(fake), null);
    const byId = (docs: typeof capped.docs) =>
      Object.fromEntries(docs.map((d) => [d.externalId, d.content]));
    expect(byId(capped.docs)).toEqual(byId(uncapped.docs));
    expect(capped.cursor.channels).toEqual(uncapped.cursor.channels);
    expect(capped.steps).toBeGreaterThan(uncapped.steps);
  });
});

describe("DiscordSource failure scope", () => {
  it("skips a channel the bot cannot read and indexes the rest", async () => {
    const fake = world();
    fake.forbidden.add("10");
    const { docs, cursor } = await drain(source(fake), null);
    expect(docs.map((d) => d.externalId).sort()).toEqual(["30:2026-03-08", "31:2026-03-09"]);
    expect(cursor.channels["10"]).toBeUndefined();
  });

  it("skips a guild whose channels it may not list", async () => {
    const fake = world();
    fake.addGuild("2", "Riverside Estate");
    fake.forbiddenGuilds.add("2");
    const { docs } = await drain(source(fake), null);
    expect(docs.length).toBe(4);
  });

  it("reports a bot that can see servers but read no channel as a permission error with the grant to make", async () => {
    const fake = world();
    fake.forbidden.add("10").add("30").add("31");
    const err = await drain(source(fake), null).catch((e) => e);
    expect(err).toMatchObject({ kind: "permission" });
    expect(err.message).toMatch(/every one of the 3 channels/);
    expect(err.remediation?.steps.join(" ")).toMatch(/Read Message History/);
  });

  it("does not escalate when only the last channel visited is unreadable", async () => {
    const fake = world();
    fake.forbidden.add("30");
    const { docs } = await drain(source(fake), null);
    expect(docs.map((d) => d.externalId).sort()).toEqual([
      "10:2026-03-08",
      "10:2026-03-09",
      "31:2026-03-09",
    ]);
  });

  it("treats channels deleted since enumeration as gone, not as a refused grant", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    fake.messages.delete("10");
    fake.messages.delete("30");
    fake.messages.delete("31");
    const second = await drain(src, first.cursor);
    expect(second.docs).toEqual([]);
    expect(second.cursor.channels).toEqual({});
  });

  it("recovers on the next tick once the grant is made, instead of pinning one channel", async () => {
    const fake = world();
    const src = source(fake);
    const indexed = await drain(src, null);
    fake.forbidden.add("10").add("30").add("31");
    await expect(drain(src, indexed.cursor)).rejects.toMatchObject({ kind: "permission" });
    // The thrown page kept no cursor: the tick after the grant starts from the last good one.
    fake.forbidden.clear();
    fake.post(msg("31", MAYA, "2026-03-10T10:00:00.000Z", "back"));
    const after = await drain(src, indexed.cursor);
    expect(after.docs.map((d) => d.externalId)).toEqual(["31:2026-03-10"]);
  });

  it("reports a bot that is in none of the configured servers, or in no server at all", async () => {
    const fake = world();
    const none = await source(fake, { guildIds: ["999"] })
      .sync(null)
      .catch((e) => e);
    expect(none).toMatchObject({ kind: "permission" });
    expect(none.message).toMatch(/999/);
    const empty = new FakeDiscord();
    await expect(source(empty).sync(null)).rejects.toMatchObject({ kind: "permission" });
  });

  it("hands the operator an invite link built for this bot, asking for the two read permissions", async () => {
    const empty = new FakeDiscord();
    empty.applicationId = "800000000000000009";
    const err = await source(empty)
      .sync(null)
      .catch((e) => e);
    const invite = new URL(
      err.remediation.steps[0].split(" ").find((w: string) => w.startsWith("https://"))!,
    );
    expect(invite.origin + invite.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(invite.searchParams.get("client_id")).toBe("800000000000000009");
    expect(invite.searchParams.get("scope")).toBe("bot");
    // View Channels (1 << 10) + Read Message History (1 << 16), and nothing else.
    expect(invite.searchParams.get("permissions")).toBe("66560");
  });

  it("falls back to the manual invite route when Discord will not name the application", async () => {
    const empty = new FakeDiscord();
    empty.scripted.push({ match: "/oauth2/applications/@me", status: 403 });
    const err = await source(empty)
      .sync(null)
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "permission" });
    expect(err.remediation.steps.join(" ")).toMatch(/URL Generator/);
  });

  it("blames the Message Content intent when Discord serves a run of blanked messages", async () => {
    const fake = new FakeDiscord();
    fake.addGuild("1", "Northstar Labs");
    fake.addChannel("1", { id: "10", type: 0, name: "general" });
    for (let i = 0; i < 60; i++) {
      fake.post(msg("10", MAYA, `2026-03-08T09:${String(i).padStart(2, "0")}:00.000Z`, ""));
    }
    const err = await source(fake)
      .sync(null)
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "permission" });
    expect(err.message).toMatch(/no content/);
    expect(err.remediation.steps.join(" ")).toMatch(/Message Content Intent/);
  });

  it("does not blame the intent when the blanked messages carry an attachment, or any message reads", async () => {
    const attachmentsOnly = new FakeDiscord();
    attachmentsOnly.addGuild("1", "Northstar Labs");
    attachmentsOnly.addChannel("1", { id: "10", type: 0, name: "general" });
    for (let i = 0; i < 60; i++) {
      attachmentsOnly.post(
        msg("10", MAYA, `2026-03-08T09:${String(i).padStart(2, "0")}:00.000Z`, "", {
          attachments: [
            {
              id: `a${i}`,
              filename: "chart.png",
              size: 2048,
              url: "https://example.com/chart.png",
            },
          ],
        }),
      );
    }
    await expect(source(attachmentsOnly).sync(null)).resolves.toBeDefined();

    const oneReadable = new FakeDiscord();
    oneReadable.addGuild("1", "Northstar Labs");
    oneReadable.addChannel("1", { id: "10", type: 0, name: "general" });
    for (let i = 0; i < 60; i++) {
      oneReadable.post(msg("10", MAYA, `2026-03-08T09:${String(i).padStart(2, "0")}:00.000Z`, ""));
    }
    oneReadable.post(msg("10", JAMIE, "2026-03-08T10:00:00.000Z", "it reads"));
    await expect(source(oneReadable).sync(null)).resolves.toBeDefined();
  });

  it("counts blanked messages across the whole cycle, not one call", async () => {
    // Ten channels of six messages each: no single call ever sees fifty, so
    // only a cycle-wide count catches a server this shape.
    const fake = new FakeDiscord();
    fake.addGuild("1", "Northstar Labs");
    for (let c = 0; c < 10; c++) {
      const id = String(100 + c);
      fake.addChannel("1", { id, type: 0, name: `room-${c}` });
      for (let i = 0; i < 6; i++) {
        fake.post(msg(id, MAYA, `2026-03-08T0${c}:0${i}:00.000Z`, ""));
      }
    }
    const src = source(fake);
    const err = await (async () => {
      let cursor: DiscordCursor | null = null;
      for (let call = 0; call < 20; call++) {
        const res: SyncResult<DiscordCursor> = await src.sync(cursor);
        cursor = res.cursor;
        if (!res.hasMore) return null;
      }
      return null;
    })().catch((e) => e);
    expect(err).toMatchObject({ kind: "permission" });
    expect(err.remediation.steps.join(" ")).toMatch(/Message Content Intent/);
  });

  it("does not count a join notice as a blanked message", async () => {
    const joins = new FakeDiscord();
    joins.addGuild("1", "Northstar Labs");
    joins.addChannel("1", { id: "10", type: 0, name: "general" });
    for (let i = 0; i < 60; i++) {
      // Type 7 (USER_JOIN) carries no body of its own whatever the intent is.
      joins.post(
        msg("10", MAYA, `2026-03-08T09:${String(i).padStart(2, "0")}:00.000Z`, "", { type: 7 }),
      );
    }
    await expect(source(joins).sync(null)).resolves.toBeDefined();
  });

  it("pages through more than one hundred archived threads under a channel", async () => {
    const fake = world();
    for (let i = 0; i < 101; i++) {
      const id = String(1000 + i);
      fake.addThread(
        "1",
        { id, type: 11, name: `old thread ${i}`, parent_id: "10" },
        {
          archived: true,
          archivedAt: `2026-02-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
        },
      );
      fake.post(msg(id, JAMIE, "2026-02-01T09:00:00.000Z", `archived ${i}`));
    }
    const { docs } = await drain(source(fake), null);
    expect(docs.filter((d) => /^1\d{3}:/.test(d.externalId)).length).toBe(101);
    const archivedCalls = fake.requests.filter((r) =>
      r.path.startsWith("/channels/10/threads/archived/public"),
    );
    expect(archivedCalls.length).toBe(2);
    expect(archivedCalls[1].path).toMatch(/before=/);
  });

  it("builds the source through the descriptor, honouring the guilds and selfUserId settings", async () => {
    const fake = world();
    fake.addGuild("2", "Riverside Estate");
    fake.addChannel("2", { id: "40", type: 0, name: "lobby" });
    fake.post(msg("40", MAYA, "2026-03-08T09:00:00.000Z", "hello from Maya"));
    const client = new DiscordClient("valid-token", {
      fetchImpl: fake.fetch,
      sleep: () => Promise.resolve(),
    });
    const instance = await discordProvider.sources[0].create(
      {
        sourceId,
        providerId,
        accountId: BOT.id,
        sourceConfig: { params: { guilds: "2", selfUserId: MAYA.id } },
      } as never,
      { client, accountId: BOT.id },
    );
    const docs = [];
    let cursor = null;
    for (let i = 0; i < 20; i++) {
      const res = await instance.sync(cursor);
      docs.push(...res.documents);
      cursor = res.cursor as never;
      if (!res.hasMore) break;
    }
    expect(docs.map((d) => d.externalId)).toEqual(["40:2026-03-08"]);
    expect(docs[0].metadata.people).toEqual([
      { role: "participant", name: "Maya Reeves", lids: [`discord:${MAYA.id}`], isSelf: true },
    ]);
  });

  it("reports a bot refused by every server it is in as a permission error", async () => {
    const fake = world();
    fake.forbiddenGuilds.add("1");
    const err = await source(fake)
      .sync(null)
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "permission" });
    expect(err.remediation).toBeDefined();
  });

  it("skips a malformed message row instead of failing the page", async () => {
    const fake = world();
    fake.post({
      ...msg("10", MAYA, "2026-03-08T09:01:00.000Z", "broken"),
      author: undefined as never,
    });
    fake.post({
      ...msg("10", MAYA, "2026-03-08T09:01:30.000Z", "no time"),
      timestamp: "not a date",
    });
    const { docs } = await drain(source(fake), null);
    const day = docs.find((d) => d.externalId === "10:2026-03-08")!;
    expect(day.metadata.extra?.messageCount).toBe(2);
  });

  it("fails a page loudly when Discord answers a message listing with a non-list", async () => {
    const fake = world();
    fake.scripted.push({ match: "/channels/10/messages", status: 200, body: { message: "odd" } });
    const err = await drain(source(fake), null).catch((e) => e);
    expect(err).toMatchObject({ kind: "unknown" });
    expect(err.message).toMatch(/non-list/);
  });

  it("keeps two accounts' sources apart", async () => {
    const a = world();
    const b = world();
    b.addChannel("1", { id: "50", type: 0, name: "only-b" });
    b.post(msg("50", DAVID, "2026-03-08T09:00:00.000Z", "b only"));
    const srcA = source(a, { sourceId: SourceId("discord:900000000000000001") });
    const srcB = source(b, { sourceId: SourceId("discord:900000000000000009") });
    const [ra, rb] = await Promise.all([drain(srcA, null), drain(srcB, null)]);
    expect(rb.docs.some((d) => d.externalId === "50:2026-03-08")).toBe(true);
    expect(ra.docs.some((d) => d.externalId === "50:2026-03-08")).toBe(false);
    expect(Object.keys(ra.cursor.channels)).not.toContain("50");
    expect(new Set(rb.docs.map((d) => d.sourceId))).toEqual(
      new Set(["discord:900000000000000009"]),
    );
  });

  it("surfaces a revoked token as a typed auth error without touching the cursor", async () => {
    const fake = world();
    const src = source(fake);
    const first = await drain(src, null);
    fake.scripted.push({ match: "/users/@me/guilds", status: 401 });
    await expect(src.sync(first.cursor)).rejects.toMatchObject({ kind: "auth" });
  });

  it("re-bootstraps from a cursor an older build wrote", () => {
    expect(validateDiscordCursor({ v: 0, channels: {} })).toBeNull();
    expect(validateDiscordCursor({ v: 1, channels: { "10": { lastId: 5 } } })).toBeNull();
    expect(validateDiscordCursor({ v: 1, channels: { "10": { lastId: "5" } } })).not.toBeNull();
    expect(validateDiscordCursor({ v: 1, channels: {}, queue: [] })).toBeNull();
    expect(validateDiscordCursor({ v: 1, channels: {}, queue: [{ name: "x" }] })).toBeNull();
    expect(validateDiscordCursor({ v: 1, channels: {}, cycle: { readable: "1" } })).toBeNull();
  });
});

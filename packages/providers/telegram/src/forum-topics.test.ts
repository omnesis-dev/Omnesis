// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Forum topics (`docs/telegram-source.md` §8.2, §8.3, §14 phase 4): each
 * forum's topics are listed with the dialogs, a message renders with its
 * topic's title and the day names its topics, and only a title that changed
 * re-renders anything.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TelegramError } from "./client/types.js";
import {
  DAVID,
  JAMIE,
  T0,
  chatOf,
  latestDocs,
  messageIn,
  syncAll,
  syncRig,
  type SyncRig,
} from "./testing/fixtures.js";

const FORUM = chatOf(-1008000000001, "forum", "Riverside Estate planning");
const DAY1 = `${FORUM.id}:2026-03-10`;
const DAY2 = `${FORUM.id}:2026-03-11`;

let rig: SyncRig | undefined;
afterEach(async () => {
  await rig?.dispose();
  rig = undefined;
});

async function forumRig(): Promise<SyncRig> {
  rig = await syncRig({
    users: [JAMIE, DAVID],
    chats: [
      {
        chat: FORUM,
        topics: [
          { id: 2, title: "Catering" },
          { id: 3, title: "Music" },
        ],
        messages: [
          messageIn(FORUM, 10, T0, "Menu tasting on Thursday", { senderId: JAMIE.id, topicId: 2 }),
          messageIn(FORUM, 11, T0 + 60, "Stellar Sound confirmed the set", {
            senderId: DAVID.id,
            topicId: 3,
          }),
          messageIn(FORUM, 12, T0 + 120, "Welcome, everyone", { senderId: DAVID.id }),
          messageIn(FORUM, 13, T0 + 86_400, "Second tasting booked", {
            senderId: JAMIE.id,
            topicId: 2,
          }),
          messageIn(FORUM, 14, T0 + 86_460, "Playlist draft is up", {
            senderId: DAVID.id,
            topicId: 3,
          }),
        ],
      },
    ],
  });
  return rig;
}

const topicListings = (r: SyncRig): number =>
  r.sim.calls.filter((c) => c.method === "iterForumTopics").length;

describe("forum topics", () => {
  // Clock times are the host's local time; pin the host's zone.
  beforeAll(() => vi.stubEnv("TZ", "UTC"));
  afterAll(() => vi.unstubAllEnvs());

  it("lists the topics before the walk and renders every message with its topic", async () => {
    const r = await forumRig();
    const { pages } = await syncAll(r.source, null);
    const methods = r.sim.calls.map((c) => c.method);
    expect(methods.indexOf("iterForumTopics")).toBeLessThan(methods.indexOf("getHistory"));
    expect(topicListings(r)).toBe(1);

    const day = latestDocs(pages).get(DAY1)!;
    expect(day.content).toContain("**09:00** [#Catering] Jamie Lopez: Menu tasting on Thursday");
    expect(day.content).toContain("**09:01** [#Music] David Lin: Stellar Sound confirmed the set");
    // A message outside any topic (the General topic) carries no prefix.
    expect(day.content).toContain("**09:02** David Lin: Welcome, everyone");
    expect(day.metadata.extra?.topics).toEqual(["Catering", "Music"]);
    expect(day.metadata.extra?.chatKind).toBe("forum");
  });

  it("re-renders nothing when the topics are listed again unchanged", async () => {
    const r = await forumRig();
    const boot = await syncAll(r.source, null);
    r.provider.getArchive().requestFullReconcile();
    const again = await r.source.sync(boot.cursor);
    expect(topicListings(r)).toBe(2);
    expect(again.documents).toEqual([]);
    expect(again.deletedExternalIds).toEqual([]);
  });

  it("re-renders only the days holding a renamed topic's messages", async () => {
    const r = await forumRig();
    const boot = await syncAll(r.source, null);
    r.sim.setTopic(FORUM.id, 3, "Music and sound");
    // A third day holding only Catering, which the rename must leave alone.
    r.sim.pushNew(FORUM.id, {
      text: "Tasting notes",
      senderId: JAMIE.id,
      topicId: 2,
      date: T0 + 2 * 86_400,
    });
    const live = await r.source.sync(boot.cursor);
    expect(live.documents.map((d) => d.externalId)).toEqual([`${FORUM.id}:2026-03-12`]);

    r.provider.getArchive().requestFullReconcile();
    const renamed = await r.source.sync(live.cursor);
    expect(renamed.documents.map((d) => d.externalId).sort()).toEqual([DAY1, DAY2].sort());
    expect(renamed.documents.find((d) => d.externalId === DAY2)!.content).toContain(
      "[#Music and sound] David Lin: Playlist draft is up",
    );
  });

  it("lists the topics again when a message arrives in a topic it has no title for", async () => {
    const r = await forumRig();
    const boot = await syncAll(r.source, null);
    r.sim.setTopic(FORUM.id, 20, "Transport");
    r.sim.pushNew(FORUM.id, {
      text: "Shuttle from the station at noon",
      senderId: DAVID.id,
      topicId: 20,
      date: Math.floor(Date.now() / 1000) + 5,
    });
    const page = await r.source.sync(boot.cursor);
    expect(topicListings(r)).toBe(2);
    const doc = page.documents.find((d) => d.content.includes("Shuttle"))!;
    expect(doc.content).toContain("[#Transport] David Lin: Shuttle from the station at noon");
    expect(doc.metadata.extra?.topics).toEqual(["Transport"]);

    // Listed once; the next page does not ask again.
    await r.source.sync(page.cursor);
    expect(topicListings(r)).toBe(2);
  });

  it("walks a forum whose topics Telegram will not list, without prefixes", async () => {
    rig = await forumRig();
    rig.sim.failNext(
      "iterForumTopics",
      new TelegramError("forbidden", "CHANNEL_PRIVATE", { rpc: "CHANNEL_PRIVATE" }),
    );
    const { pages } = await syncAll(rig.source, null);
    expect(rig.provider.getArchive().getChat(FORUM.id)?.walkState).toBe("done");
    const day = latestDocs(pages).get(DAY1)!;
    expect(day.content).toContain("**09:00** Jamie Lopez: Menu tasting on Thursday");
    expect(day.metadata.extra?.topics).toBeUndefined();
    expect(topicListings(rig)).toBe(1);
  });

  it("forgets a forum's topics with its messages when the forum is excluded", async () => {
    const r = await forumRig();
    const boot = await syncAll(r.source, null);
    r.remake({ policy: { includeChannels: false, excludedChats: [String(FORUM.id)] } });
    const page = await r.source.sync(boot.cursor);
    expect(page.deletedExternalIds.sort()).toEqual([DAY1, DAY2].sort());
    expect(r.provider.getArchive().getTopics(FORUM.id).size).toBe(0);
  });
});

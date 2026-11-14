// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The chat list a synthetic chat twin publishes, built from the `chat-filters`
 * universe: its cast, the days its iMessage fixture names and the roster its
 * `chats.json` states. All fixture data is invented.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetCastCache } from "./cast.js";
import {
  ChatRoster,
  getChatRoster,
  loadChatRosterFixtures,
  registerChatRoster,
  unregisterChatRoster,
  type ChatDayFixture,
} from "./chat-roster.js";
import { loadActiveUniverse, loadSourceFixtureJson, resetActiveUniverseCache } from "./universe.js";
import type { FilterListItem } from "@omnesis/types";

const CREW = "chat100000000000000001";
const NOTICES = "chat100000000000000002";
const DIRECT = "+12025550123";

beforeEach(() => {
  vi.stubEnv("OMNESIS_SYNTH_UNIVERSE", "chat-filters");
  resetActiveUniverseCache();
  resetCastCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetActiveUniverseCache();
  resetCastCache();
});

const days = (): ChatDayFixture[] =>
  loadSourceFixtureJson<ChatDayFixture[]>(loadActiveUniverse(), "apple-imessage", "messages.json");
const byId = (items: FilterListItem[]) => new Map(items.map((item) => [item.id, item]));
const members = (item: FilterListItem | undefined): string[] =>
  (item?.members ?? []).map((member) => `${member.type}:${member.value}`).sort();

describe("the chats of a universe", () => {
  test("are those chats.json states, then every other chat the days mention", () => {
    const fixtures = loadChatRosterFixtures("apple-imessage", days());
    expect(fixtures).toEqual([
      { chatId: CREW, title: "Trail crew", members: ["p_maya", "p_jamie"] },
      { chatId: NOTICES, title: "Riverside Estate notices", members: ["p_maya", "p_offers"] },
      { chatId: DIRECT, title: "Maya Reeves", members: ["p_maya"] },
    ]);
  });

  test("come from the days alone for a source without a chats.json", () => {
    const fixtures = loadChatRosterFixtures("whatsapp-messages", [
      { chatId: "g", chatTitle: "Old name", date: "2026-03-01", counterparty: "p_maya" },
      {
        chatId: "g",
        chatTitle: "New name",
        date: "2026-03-02",
        counterparty: "p_maya",
        participants: ["p_jamie"],
      },
    ]);
    expect(fixtures).toEqual([{ chatId: "g", title: "New name", members: ["p_maya", "p_jamie"] }]);
  });
});

describe("the list of a roster", () => {
  const roster = (kinds: ReadonlyArray<"phone" | "email">) =>
    new ChatRoster(loadChatRosterFixtures("apple-imessage", days()), kinds);

  test("names every member by the kinds of identifier the source writes", () => {
    const both = byId(roster(["phone", "email"]).list());
    expect(both.get(CREW)).toMatchObject({ label: "Trail crew" });
    expect(members(both.get(CREW))).toEqual([
      "email:maya.reeves@example.com",
      "email:sam.rivera@icloud.example",
      "phone:+12025550101",
      "phone:+12025550123",
      "phone:+12025550142",
    ]);
    expect(both.get(CREW)?.membersIncomplete).toBeUndefined();

    const phonesOnly = byId(roster(["phone"]).list());
    expect(members(phonesOnly.get(CREW))).toEqual([
      "phone:+12025550101",
      "phone:+12025550123",
      "phone:+12025550142",
    ]);
  });

  test("says so when a member has no identifier of those kinds", () => {
    const listed = byId(roster(["phone", "email"]).list());
    expect(listed.get(NOTICES)?.membersIncomplete).toBe(true);
    expect(listed.get(DIRECT)?.membersIncomplete).toBeUndefined();
  });

  test("follows a member added, a member removed and a rename", () => {
    const live = roster(["phone"]);
    live.addMember(CREW, "p_david");
    live.removeMember(CREW, "p_jamie");
    live.rename(CREW, "Trail and track crew");

    const crew = byId(live.list()).get(CREW);
    expect(crew?.label).toBe("Trail and track crew");
    expect(members(crew)).toEqual([
      "phone:+12025550101",
      "phone:+12025550123",
      "phone:+12025550177",
    ]);
    expect(live.listings).toBe(1);
    expect(() => live.addMember("no-such-chat", "p_david")).toThrow(/no chat/);
  });

  test("is reachable by source id while its source is live", () => {
    const live = roster(["phone"]);
    registerChatRoster("apple-imessage:sam.rivera@icloud.example", live);
    expect(getChatRoster("apple-imessage:sam.rivera@icloud.example")).toBe(live);
    unregisterChatRoster("apple-imessage:sam.rivera@icloud.example");
    expect(getChatRoster("apple-imessage:sam.rivera@icloud.example")).toBeUndefined();
  });
});

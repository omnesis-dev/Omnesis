// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The chats of a synthetic chat account and who is in each, as the list a
 * chat twin publishes for filters.
 *
 * A twin's day documents come from `messages.json` and name the people on
 * that day. Who is in a chat is a separate fact: a member may never have
 * spoken. A universe states it in an optional `chats.json` beside the
 * messages; a chat it does not state is taken to hold the people its days
 * name. The roster is held in memory, so a test can add or remove a member or
 * rename a chat between two syncs and watch the next ordinary sync carry the
 * change while no day document is sent again.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePerson } from "./cast.js";
import { loadActiveUniverse, loadSourceFixtureJson } from "./universe.js";
import type { FilterIdentifier, FilterListItem } from "@omnesis/types";
import type { PersonRef } from "./types.js";

/** One chat in a universe's `sources/<source>/chats.json`. */
export interface ChatRosterFixture {
  chatId: string;
  title: string;
  /** Cast references of every member, with or without `self`. */
  members: PersonRef[];
}

/** The fields of a day fixture a roster is derived from. */
export interface ChatDayFixture {
  chatId: string;
  chatTitle: string;
  date: string;
  counterparty: string;
  participants?: PersonRef[];
}

const ROSTER_FILE = "chats.json";

/**
 * The chats of the active universe for one chat source: those `chats.json`
 * states, then every other chat the day fixtures mention, under its latest
 * title and with the people its days name.
 */
export function loadChatRosterFixtures(
  sourceKey: string,
  days: readonly ChatDayFixture[],
): ChatRosterFixture[] {
  const universe = loadActiveUniverse();
  const stated = existsSync(join(universe.dir, "sources", sourceKey, ROSTER_FILE))
    ? loadSourceFixtureJson<ChatRosterFixture[]>(universe, sourceKey, ROSTER_FILE)
    : [];
  const chats = new Map(stated.map((chat) => [chat.chatId, chat]));
  const latest = new Map<string, ChatDayFixture>();
  const named = new Map<string, Set<PersonRef>>();
  for (const day of days) {
    if (chats.has(day.chatId)) continue;
    const previous = latest.get(day.chatId);
    if (!previous || day.date > previous.date) latest.set(day.chatId, day);
    const members = named.get(day.chatId) ?? new Set<PersonRef>();
    for (const ref of day.participants ?? [day.counterparty]) members.add(ref);
    named.set(day.chatId, members);
  }
  for (const [chatId, day] of latest) {
    chats.set(chatId, { chatId, title: day.chatTitle, members: [...(named.get(chatId) ?? [])] });
  }
  return [...chats.values()];
}

/** The live chats of one synthetic chat account. */
export class ChatRoster {
  private readonly chats = new Map<string, { title: string; members: Set<PersonRef> }>();
  /** How many times the account has been listed. */
  listings = 0;

  /**
   * @param kinds The identifier kinds the source writes on a day's people.
   *   A member the cast gives none of them is one the list cannot name.
   */
  constructor(
    fixtures: readonly ChatRosterFixture[],
    private readonly kinds: ReadonlyArray<"phone" | "email">,
  ) {
    for (const chat of fixtures) {
      this.chats.set(chat.chatId, { title: chat.title, members: new Set(chat.members) });
    }
  }

  private chat(chatId: string): { title: string; members: Set<PersonRef> } {
    const chat = this.chats.get(chatId);
    if (!chat) throw new Error(`no chat ${chatId} in this roster`);
    return chat;
  }

  rename(chatId: string, title: string): void {
    this.chat(chatId).title = title;
  }

  addMember(chatId: string, ref: PersonRef): void {
    this.chat(chatId).members.add(ref);
  }

  removeMember(chatId: string, ref: PersonRef): void {
    this.chat(chatId).members.delete(ref);
  }

  /** Every chat with its members, the account holder included. */
  list(): FilterListItem[] {
    this.listings++;
    return [...this.chats].map(([chatId, chat]) => {
      const members: FilterIdentifier[] = [];
      let incomplete = false;
      for (const ref of new Set<PersonRef>(["self", ...chat.members])) {
        const person = resolvePerson(ref);
        const identifiers: FilterIdentifier[] = [
          ...(this.kinds.includes("phone") ? person.phones : []).map((value) => ({
            type: "phone" as const,
            value,
          })),
          ...(this.kinds.includes("email") ? person.emails : []).map((value) => ({
            type: "email" as const,
            value,
          })),
        ];
        if (identifiers.length === 0 && !person.isSelf) incomplete = true;
        members.push(...identifiers);
      }
      return {
        id: chatId,
        label: chat.title,
        members,
        ...(incomplete ? { membersIncomplete: true } : {}),
      };
    });
  }
}

const rosters = new Map<string, ChatRoster>();

export function registerChatRoster(sourceId: string, roster: ChatRoster): void {
  rosters.set(sourceId, roster);
}

export function unregisterChatRoster(sourceId: string): void {
  rosters.delete(sourceId);
}

/** The live roster of a fully qualified chat source, such as `apple-imessage:<account>`. */
export function getChatRoster(sourceId: string): ChatRoster | undefined {
  return rosters.get(sourceId);
}

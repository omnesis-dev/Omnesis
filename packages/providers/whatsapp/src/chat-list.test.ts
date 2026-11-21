// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The list of chats a WhatsApp account publishes for filters: one item per
 * chat, with the phone numbers of its members, read from the message store
 * without reading a message. All names and numbers are invented.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  collectFilterList,
  documentFieldFilterProblem,
  personFilterProblem,
} from "@omnesis/source-sdk";
import { SourceId } from "@omnesis/types";
import {
  WHATSAPP_CHAT_FIELD,
  listWhatsAppChats,
  whatsappFilterLists,
  type WhatsAppChatDirectory,
} from "./chat-list.js";
import { MessageStore } from "./message-store.js";
import { WhatsAppMessagesSource } from "./messages.js";
import whatsappSource from "./index.js";
import type { FilterListItem } from "@omnesis/types";
import type { StoredMessage } from "./types.js";

const SOURCE = SourceId("whatsapp-messages:+12025550101");
const SELF = "+12025550101";
const SELF_JID = "12025550101@s.whatsapp.net";

const MAYA_JID = "12025550123@s.whatsapp.net";
const MAYA = "+12025550123";
const JAMIE_JID = "12025550142@s.whatsapp.net";
const JAMIE = "+12025550142";
const DAVID_LID = "200000000000077@lid";
const DAVID = "+12025550177";
const GROUP = "120000000000000001@g.us";

let store: MessageStore;

beforeEach(() => {
  store = new MessageStore();
});

afterEach(() => {
  store.close();
});

const phones = (item: FilterListItem | undefined): string[] =>
  (item?.members ?? []).map((member) => `${member.type}:${member.value}`).sort();

const list = (): Map<string, FilterListItem> =>
  new Map(listWhatsAppChats(store, SOURCE).map((item) => [item.id, item]));

function message(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: "m1",
    chatJid: GROUP,
    senderJid: MAYA_JID,
    senderName: "Maya Reeves",
    fromMe: false,
    timestamp: 1_709_900_000,
    type: "text",
    text: "Hello",
    ...overrides,
  };
}

describe("one-to-one chats", () => {
  test("list the account holder and the other party by phone, under the chat's JID", () => {
    store.addChats([{ jid: MAYA_JID, name: MAYA_JID, isGroup: false }]);
    store.addContacts([{ jid: MAYA_JID, name: "Maya Reeves" }]);

    const item = list().get(MAYA_JID);
    expect(item).toEqual({
      id: MAYA_JID,
      label: "Maya Reeves",
      members: [
        { type: "phone", value: SELF },
        { type: "phone", value: MAYA },
      ],
    });
  });

  test("resolve a LID chat to the phone WhatsApp mapped it to", () => {
    store.addChats([{ jid: DAVID_LID, name: DAVID_LID, isGroup: false }]);
    store.setLIDPhone(DAVID_LID, DAVID);

    const item = list().get(DAVID_LID);
    expect(phones(item)).toEqual([`phone:${DAVID}`, `phone:${SELF}`].sort());
    expect(item?.membersIncomplete).toBeUndefined();
    // With no name known, the label is the number, never the opaque LID.
    expect(item?.label).toBe(DAVID);
  });

  test("say so when the other party is known only by a LID", () => {
    store.addChats([{ jid: DAVID_LID, name: DAVID_LID, isGroup: false }]);

    const item = list().get(DAVID_LID);
    expect(phones(item)).toEqual([`phone:${SELF}`]);
    expect(item?.membersIncomplete).toBe(true);
  });

  test("do not trust a LID WhatsApp mapped to two phones, even through a contact", () => {
    store.addChats([{ jid: DAVID_LID, name: DAVID_LID, isGroup: false }]);
    store.addContacts([{ jid: "12025550177@s.whatsapp.net", name: "David Lin", lid: DAVID_LID }]);
    expect(phones(list().get(DAVID_LID))).toContain(`phone:${DAVID}`);

    store.setLIDPhone(DAVID_LID, DAVID);
    store.setLIDPhone(DAVID_LID, "+12025550188");

    expect(store.isLidContested(DAVID_LID)).toBe(true);
    const item = list().get(DAVID_LID);
    expect(phones(item)).toEqual([`phone:${SELF}`]);
    expect(item?.membersIncomplete).toBe(true);
  });
});

describe("groups", () => {
  test("list every member of a whole roster, including one who never spoke", () => {
    store.addChats([{ jid: GROUP, name: "Studio Northstar crew", isGroup: true }]);
    store.updateGroupRoster(GROUP, [SELF_JID, MAYA_JID, JAMIE_JID]);
    // Maya is the only one who speaks; Jamie is on no day document of this chat.
    store.addMessages([message({})]);

    expect(list().get(GROUP)).toEqual({
      id: GROUP,
      label: "Studio Northstar crew",
      members: [
        { type: "phone", value: SELF },
        { type: "phone", value: MAYA },
        { type: "phone", value: JAMIE },
      ],
    });
  });

  test("count the account holder once, whichever JID the roster names them by", () => {
    const selfLid = "200000000000001:7@lid";
    store.setLIDPhone(selfLid, SELF);
    store.addChats([{ jid: GROUP, name: "Crew", isGroup: true }]);
    store.updateGroupRoster(GROUP, [selfLid, "12025550123:3@s.whatsapp.net"]);

    const item = list().get(GROUP);
    expect(phones(item)).toEqual([`phone:${SELF}`, `phone:${MAYA}`].sort());
    expect(item?.membersIncomplete).toBeUndefined();
  });

  test("say so when a member is known only by a LID", () => {
    store.addChats([{ jid: GROUP, name: "Crew", isGroup: true }]);
    store.updateGroupRoster(GROUP, [SELF_JID, MAYA_JID, DAVID_LID]);

    const item = list().get(GROUP);
    expect(phones(item)).toEqual([`phone:${SELF}`, `phone:${MAYA}`].sort());
    expect(item?.membersIncomplete).toBe(true);

    // Once WhatsApp maps the LID, the member is named and the list is whole.
    store.setLIDPhone(DAVID_LID, DAVID);
    const resolved = list().get(GROUP);
    expect(phones(resolved)).toEqual([`phone:${SELF}`, `phone:${MAYA}`, `phone:${DAVID}`].sort());
    expect(resolved?.membersIncomplete).toBeUndefined();
  });

  test("say so when WhatsApp never delivered the roster", () => {
    store.addMessages([message({})]);

    const item = list().get(GROUP);
    // The speaker is not listed: who spoke is on the day documents, and the
    // list reads no message.
    expect(phones(item)).toEqual([`phone:${SELF}`]);
    expect(item?.membersIncomplete).toBe(true);
  });

  test("do not take a roster built from join events alone for the whole roster", () => {
    store.addChats([{ jid: GROUP, name: "Crew", isGroup: true }]);
    store.addGroupParticipants(GROUP, [MAYA_JID]);

    const partial = list().get(GROUP);
    expect(phones(partial)).toEqual([`phone:${SELF}`, `phone:${MAYA}`].sort());
    expect(partial?.membersIncomplete).toBe(true);

    store.updateGroupRoster(GROUP, [SELF_JID, MAYA_JID, JAMIE_JID]);
    expect(list().get(GROUP)?.membersIncomplete).toBeUndefined();
  });

  test("follow members joining and leaving a whole roster", () => {
    store.addChats([{ jid: GROUP, name: "Crew", isGroup: true }]);
    store.updateGroupRoster(GROUP, [SELF_JID, MAYA_JID]);

    store.addGroupParticipants(GROUP, [JAMIE_JID]);
    expect(phones(list().get(GROUP))).toEqual(
      [`phone:${SELF}`, `phone:${MAYA}`, `phone:${JAMIE}`].sort(),
    );
    expect(list().get(GROUP)?.membersIncomplete).toBeUndefined();

    store.removeGroupParticipants(GROUP, [MAYA_JID]);
    expect(phones(list().get(GROUP))).toEqual([`phone:${SELF}`, `phone:${JAMIE}`].sort());
    expect(list().get(GROUP)?.membersIncomplete).toBeUndefined();
  });

  test("keep a whole roster whole when a later chat update carries no roster", () => {
    store.updateGroupRoster(GROUP, [SELF_JID, MAYA_JID]);
    store.addChats([{ jid: GROUP, name: "Renamed crew", isGroup: true }]);

    const item = list().get(GROUP);
    expect(item?.label).toBe("Renamed crew");
    expect(item?.membersIncomplete).toBeUndefined();
  });

  test("remember across a restart whether a roster is whole", () => {
    store.close();
    const dir = `${process.env.TMPDIR ?? "/tmp"}/omnesis-test-wa-chat-list-${crypto.randomUUID()}`;
    store = new MessageStore(dir);
    store.updateGroupRoster(GROUP, [SELF_JID, MAYA_JID]);
    store.addGroupParticipants("120000000000000002@g.us", [MAYA_JID]);
    store.close();

    store = new MessageStore(dir);
    expect(list().get(GROUP)?.membersIncomplete).toBeUndefined();
    expect(list().get("120000000000000002@g.us")?.membersIncomplete).toBe(true);
  });

  test("name a group WhatsApp never named after its members", () => {
    store.addContacts([
      { jid: MAYA_JID, name: "Maya Reeves" },
      { jid: JAMIE_JID, name: "Jamie Lopez" },
    ]);
    store.updateGroupRoster(GROUP, [SELF_JID, MAYA_JID, JAMIE_JID]);

    expect(list().get(GROUP)?.label).toBe("Jamie Lopez, Maya Reeves");
  });
});

test("a chat that is neither a group nor one-to-one has no roster to rely on", () => {
  store.addChats([{ jid: "status@broadcast", name: "status@broadcast", isGroup: false }]);

  const item = list().get("status@broadcast");
  expect(phones(item)).toEqual([`phone:${SELF}`]);
  expect(item?.membersIncomplete).toBe(true);
});

test("a chat WhatsApp announced is listed before any of its messages arrive", () => {
  store.addChats([{ jid: MAYA_JID, name: "Maya Reeves", isGroup: false }]);
  expect(store.totalMessages).toBe(0);
  expect([...list().keys()]).toEqual([MAYA_JID]);
});

test("a rename changes the list and marks no day for sending again", () => {
  store.updateGroupRoster(GROUP, [SELF_JID, MAYA_JID]);
  store.addChats([{ jid: GROUP, name: "Crew", isGroup: true }]);
  store.addMessages([message({})]);
  const sent = store.drain();
  const confirmed = store.drain({ committedSeq: sent.emitSeq });
  expect(sent.dirtyKeys.size).toBe(1);
  expect(confirmed.dirtyKeys.size).toBe(0);

  store.addChats([{ jid: GROUP, name: "Atlas crew", isGroup: true }]);
  store.addGroupParticipants(GROUP, [JAMIE_JID]);

  expect(list().get(GROUP)?.label).toBe("Atlas crew");
  expect(phones(list().get(GROUP))).toContain(`phone:${JAMIE}`);
  expect(store.drain({ committedSeq: confirmed.emitSeq }).dirtyKeys.size).toBe(0);
});

test("a resync sends every day again from an empty cursor, each with its chat", async () => {
  store.setHistorySyncState("complete");
  store.addMessages([
    message({ id: "a", timestamp: 1_709_900_000 }),
    message({ id: "b", timestamp: 1_709_900_000 + 86_400 }),
    message({ id: "c", chatJid: MAYA_JID, timestamp: 1_709_900_000 }),
  ]);
  const source = new WhatsAppMessagesSource(store, "+12025550101");
  const first = await source.sync(null);
  expect(first.documents).toHaveLength(3);
  const settled = await source.sync(first.cursor);
  expect(settled.documents).toHaveLength(0);

  source.onResync();
  const again = await source.sync(null);

  expect(again.documents.map((doc) => doc.externalId).sort()).toEqual(
    first.documents.map((doc) => doc.externalId).sort(),
  );
  expect(again.documents.map((doc) => doc.metadata.extra?.chatJid).sort()).toEqual(
    [GROUP, GROUP, MAYA_JID].sort(),
  );
  expect(again.hasMore).toBe(false);
});

test("the list reads chats, contacts and the LID map, and no message", () => {
  store.updateGroupRoster(GROUP, [SELF_JID, MAYA_JID]);
  store.addMessages(
    Array.from({ length: 500 }, (_, i) =>
      message({ id: `m${i}`, timestamp: 1_709_900_000 + i * 86_400 }),
    ),
  );
  // A directory that holds only what the list is documented to read: were a
  // message needed, there would be nowhere to get it from.
  const directory: WhatsAppChatDirectory = {
    allChats: store.allChats,
    allContacts: store.allContacts,
    lidPhoneMap: store.lidPhoneMap,
    isLidContested: (lid) => store.isLidContested(lid),
  };
  expect(listWhatsAppChats(directory, SOURCE)).toEqual(listWhatsAppChats(store, SOURCE));
  expect(listWhatsAppChats(directory, SOURCE)).toHaveLength(1);
});

test("the producer passes the list contract and is keyed by the declared field", async () => {
  store.updateGroupRoster(GROUP, [SELF_JID, MAYA_JID, DAVID_LID]);
  store.addChats([{ jid: MAYA_JID, name: "Maya Reeves", isGroup: false }]);

  const producers = whatsappFilterLists(store, SOURCE);
  expect(Object.keys(producers)).toEqual([WHATSAPP_CHAT_FIELD]);
  const items = await collectFilterList(producers[WHATSAPP_CHAT_FIELD]!, {
    signal: new AbortController().signal,
  });
  expect(items.map((item) => [item.id, item.membersIncomplete === true])).toEqual([
    [GROUP, true],
    [MAYA_JID, false],
  ]);
});

describe("the declaration", () => {
  const profile = whatsappSource.documentEventProfile!;
  const context = { outputRevision: whatsappSource.contract?.outputRevision ?? 1 };

  test("marks the chat JID as a filterable field every stored record carries", () => {
    const field = profile.metadataFields?.find((entry) => entry.path === WHATSAPP_CHAT_FIELD);
    expect(field?.type).toBe("string");
    expect(field?.filter).toEqual({
      capability: "membership",
      minVersion: 0,
      scope: "global",
      noun: { one: "chat", many: "chats" },
      picker: "search",
      listsMembers: true,
    });
    expect(documentFieldFilterProblem("string", field?.filter, context)).toBeNull();
    // The only filterable field: nothing else needs a list.
    expect(profile.metadataFields?.filter((entry) => entry.filter).map((e) => e.path)).toEqual([
      WHATSAPP_CHAT_FIELD,
    ]);
  });

  test("matches people by the phone of a participant, with the chat's listed members", () => {
    expect(profile.personFilter).toEqual({
      minVersion: 0,
      roles: ["participant"],
      identifiers: ["phone"],
      membersOf: WHATSAPP_CHAT_FIELD,
    });
    expect(personFilterProblem(profile.personFilter, profile, context)).toBeNull();
  });

  test("states what a resync costs in one sentence", () => {
    expect(whatsappSource.resyncCost).toMatch(/already kept on this computer/);
  });
});

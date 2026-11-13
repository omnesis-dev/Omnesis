// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Chat and person filters declare version 0: they apply to conversations
 * stored by every earlier build of this source, with no resync. That holds
 * only while the two details a filter reads are where, and in the form, the
 * earliest build wrote them:
 *
 * - the chat, at `metadata.extra.chatJid`, as the chat's raw JID — the same
 *   string the published list uses as the chat's id;
 * - each participant's phone, in `metadata.people[]` entries whose role is
 *   `participant`, in the `phones` array, in E.164.
 *
 * The documents below are written out by hand in the shape the first build
 * of the normalizer stored them (no `conversationId`, LIDs without a
 * namespace, the retired `whatsapp://chat?jid=` link), and are compared with
 * what today's normalizer and today's list produce for the same chat. A
 * change to either that would make a filter miss an old record fails here.
 * All names and numbers are invented.
 */

import { describe, expect, test } from "vitest";
import { buildAttachmentDocument } from "@omnesis/core";
import { ProviderId, SourceId, personIdentifiers } from "@omnesis/types";
import { WHATSAPP_CHAT_FIELD, listWhatsAppChats } from "./chat-list.js";
import { normalizeDayChat } from "./normalizer.js";
import whatsappSource from "./index.js";
import type { DocumentInput } from "@omnesis/types";
import type { StoredChat, StoredContact, StoredMessage } from "./types.js";

const PROVIDER = ProviderId("whatsapp:+12025550101");
const SOURCE = SourceId("whatsapp-messages:+12025550101");
const SELF = "+12025550101";
const MAYA_JID = "12025550123@s.whatsapp.net";
const MAYA = "+12025550123";
const JAMIE_JID = "12025550142@s.whatsapp.net";
const JAMIE = "+12025550142";
const DAVID_LID_JID = "200000000000077@lid";
const GROUP = "120000000000000001@g.us";
const DATE = "2026-03-08";

type StoredDocument = Pick<DocumentInput, "externalId" | "metadata">;

/** A one-to-one day as the first build stored it. */
const OLD_DIRECT_DAY: StoredDocument = {
  externalId: `${MAYA_JID}:${DATE}`,
  metadata: {
    sourceUrl: `whatsapp://chat?jid=${MAYA_JID}`,
    tags: [],
    documentType: "conversation",
    people: [
      { role: "participant", name: "You", phones: [SELF] },
      { role: "participant", name: "Maya Reeves", phones: [MAYA] },
    ],
    extra: {
      chatJid: MAYA_JID,
      chatName: "Maya Reeves",
      isGroup: false,
      messageCount: 1,
      mediaCount: 0,
      participants: ["Maya Reeves"],
      date: DATE,
    },
  },
};

/**
 * A group day as the first build stored it. The roster was known, so Jamie is
 * a participant without having spoken; David is known only by a LID, stored
 * as bare digits and with no phone; a number quoted in the text is `mentioned`.
 */
const OLD_GROUP_DAY: StoredDocument = {
  externalId: `${GROUP}:${DATE}`,
  metadata: {
    sourceUrl: `whatsapp://chat?jid=${GROUP}`,
    tags: ["group"],
    documentType: "conversation",
    people: [
      { role: "participant", name: "You", phones: [SELF] },
      { role: "participant", name: "Maya Reeves", phones: [MAYA] },
      { role: "participant", name: "Jamie Lopez", phones: [JAMIE] },
      { role: "participant", name: "LID 20000000…", lids: ["200000000000077"] },
      { role: "mentioned", phones: ["+12025550199"] },
    ],
    extra: {
      chatJid: GROUP,
      chatName: "Studio Northstar crew",
      isGroup: true,
      messageCount: 1,
      mediaCount: 0,
      participants: ["You", "Maya Reeves", "Jamie Lopez", "LID 20000000…"],
      date: DATE,
    },
  },
};

/** A group day stored while the roster was unknown: only that day's speaker is on it. */
const OLD_GROUP_DAY_WITHOUT_ROSTER: StoredDocument = {
  externalId: `${GROUP}:2026-03-01`,
  metadata: {
    sourceUrl: `whatsapp://chat?jid=${GROUP}`,
    tags: [],
    documentType: "conversation",
    people: [
      { role: "participant", name: "You", phones: [SELF] },
      { role: "participant", name: "Maya Reeves", phones: [MAYA] },
    ],
    extra: {
      chatJid: GROUP,
      chatName: GROUP,
      isGroup: false,
      messageCount: 1,
      mediaCount: 0,
      participants: ["Maya Reeves"],
      date: "2026-03-01",
    },
  },
};

/** A file sent in the group that day, as the first build stored it. */
const OLD_ATTACHMENT: StoredDocument = {
  externalId: `${GROUP}:${DATE}/att/booking.pdf-1024-0`,
  metadata: {
    sourceUrl: `whatsapp://chat?jid=${GROUP}`,
    documentType: "attachment",
    people: [
      { role: "participant", name: "You", phones: [SELF] },
      { role: "participant", name: "Maya Reeves", phones: [MAYA] },
      { role: "participant", name: "Jamie Lopez", phones: [JAMIE] },
      { role: "participant", name: "LID 20000000…", lids: ["200000000000077"] },
    ],
    extra: {
      parentExternalId: `${GROUP}:${DATE}`,
      originalFilename: "booking.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      truncated: false,
    },
  },
};

// ── What a filter reads from a stored record ────────────────────────────────

const profile = whatsappSource.documentEventProfile!;
const filterRoles = new Set<string>(profile.personFilter!.roles);

/** The record's chat, at the declared path. */
function chatOf(doc: StoredDocument): unknown {
  const [root, key] = WHATSAPP_CHAT_FIELD.split(".") as ["extra", string];
  return doc.metadata[root]?.[key];
}

/** The phones of the people a person filter considers, whichever array holds them. */
function filterPhones(doc: StoredDocument): string[] {
  return (doc.metadata.people ?? [])
    .filter((person) => filterRoles.has(person.role))
    .flatMap((person) => personIdentifiers(person))
    .filter((identifier) => identifier.kind === "phone")
    .map((identifier) => identifier.value)
    .sort();
}

/** People a person filter considers who carry no identifier it can compare. */
function unmatchablePeople(doc: StoredDocument): number {
  return (doc.metadata.people ?? []).filter(
    (person) =>
      filterRoles.has(person.role) &&
      !personIdentifiers(person).some((identifier) => identifier.kind === "phone"),
  ).length;
}

// ── The same chats, as today's source sees them ─────────────────────────────

const contacts = new Map<string, StoredContact>([
  [MAYA_JID, { jid: MAYA_JID, name: "Maya Reeves" }],
  [JAMIE_JID, { jid: JAMIE_JID, name: "Jamie Lopez" }],
]);
const groupChat: StoredChat = {
  jid: GROUP,
  name: "Studio Northstar crew",
  isGroup: true,
  participants: ["12025550101@s.whatsapp.net", MAYA_JID, JAMIE_JID, DAVID_LID_JID],
  rosterComplete: true,
};
const directChat: StoredChat = { jid: MAYA_JID, name: "Maya Reeves", isGroup: false };

function message(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: "m1",
    chatJid: GROUP,
    senderJid: MAYA_JID,
    senderName: "Maya Reeves",
    fromMe: false,
    timestamp: Date.parse(`${DATE}T12:00:00Z`) / 1000,
    type: "text",
    text: "call the venue on +12025550199",
    ...overrides,
  };
}

const today = {
  direct: normalizeDayChat(
    MAYA_JID,
    DATE,
    [message({ chatJid: MAYA_JID, text: "see you there" })],
    directChat,
    contacts,
    PROVIDER,
    SOURCE,
  ),
  group: normalizeDayChat(GROUP, DATE, [message({})], groupChat, contacts, PROVIDER, SOURCE),
};

const listed = new Map(
  listWhatsAppChats(
    {
      allChats: new Map([
        [GROUP, groupChat],
        [MAYA_JID, directChat],
      ]),
      allContacts: contacts,
      lidPhoneMap: new Map(),
      isLidContested: () => false,
    },
    SOURCE,
  ).map((item) => [item.id, item]),
);
const listedPhones = (chat: string): string[] =>
  (listed.get(chat)?.members ?? []).map((member) => member.value).sort();

describe("the chat a stored conversation belongs to", () => {
  test.each([
    ["a one-to-one day", OLD_DIRECT_DAY, MAYA_JID],
    ["a group day", OLD_GROUP_DAY, GROUP],
    ["a group day stored without a roster", OLD_GROUP_DAY_WITHOUT_ROSTER, GROUP],
  ])("is the raw chat JID at the declared path on %s", (_name, doc, jid) => {
    expect(chatOf(doc)).toBe(jid);
    // The same string the record's own id starts with, and the list's item id.
    expect(doc.externalId.startsWith(`${jid}:`)).toBe(true);
    expect(listed.has(jid)).toBe(true);
  });

  test("is written today exactly as it was then", () => {
    expect(chatOf(today.direct)).toBe(chatOf(OLD_DIRECT_DAY));
    expect(chatOf(today.group)).toBe(chatOf(OLD_GROUP_DAY));
    expect(today.direct.externalId).toBe(OLD_DIRECT_DAY.externalId);
    expect(today.group.externalId).toBe(OLD_GROUP_DAY.externalId);
  });

  test("is absent from an attachment, which names its conversation instead", () => {
    expect(chatOf(OLD_ATTACHMENT)).toBeUndefined();
    expect(OLD_ATTACHMENT.metadata.extra?.parentExternalId).toBe(OLD_GROUP_DAY.externalId);

    const attachment = buildAttachmentDocument(
      today.group,
      "booking.pdf",
      { text: "Booking confirmation", truncated: false },
      { mimeType: "application/pdf", sizeBytes: 1024 },
    );
    expect(chatOf(attachment)).toBeUndefined();
    expect(attachment.metadata.extra?.parentExternalId).toBe(today.group.externalId);
    expect(attachment.metadata.documentType).toBe("attachment");
  });
});

describe("the people of a stored conversation", () => {
  test("carry their phones in E.164, in the form the list spells its members", () => {
    for (const doc of [OLD_DIRECT_DAY, OLD_GROUP_DAY, OLD_GROUP_DAY_WITHOUT_ROSTER]) {
      for (const phone of filterPhones(doc)) expect(phone).toMatch(/^\+[1-9]\d{6,14}$/);
    }
    expect(filterPhones(OLD_DIRECT_DAY)).toEqual([SELF, MAYA].sort());
    expect(filterPhones(OLD_GROUP_DAY)).toEqual([SELF, MAYA, JAMIE].sort());
    // Every phone a record holds for a current member is spelled as the list spells it.
    expect(listedPhones(MAYA_JID)).toEqual(filterPhones(OLD_DIRECT_DAY));
    expect(listedPhones(GROUP)).toEqual(filterPhones(OLD_GROUP_DAY));
  });

  test("are written today with the same phones, in the same array", () => {
    expect(filterPhones(today.direct)).toEqual(filterPhones(OLD_DIRECT_DAY));
    expect(filterPhones(today.group)).toEqual(filterPhones(OLD_GROUP_DAY));
    for (const person of today.group.metadata.people ?? []) {
      expect(person.identifiers).toBeUndefined();
    }
  });

  test("do not count a number quoted in the text as someone in the chat", () => {
    expect(filterPhones(OLD_GROUP_DAY)).not.toContain("+12025550199");
    expect(filterPhones(today.group)).not.toContain("+12025550199");
  });

  test("leave a member known only by a LID with nothing to compare, then and now", () => {
    expect(unmatchablePeople(OLD_GROUP_DAY)).toBe(1);
    expect(unmatchablePeople(today.group)).toBe(1);
    // The list says the same of the chat, so the chat is not mistaken for one
    // whose members are all known.
    expect(listed.get(GROUP)?.membersIncomplete).toBe(true);
    expect(unmatchablePeople(OLD_DIRECT_DAY)).toBe(0);
    expect(listed.get(MAYA_JID)?.membersIncomplete).toBeUndefined();
  });

  test("miss a silent member on a day stored without a roster; the list has them", () => {
    expect(filterPhones(OLD_GROUP_DAY_WITHOUT_ROSTER)).not.toContain(JAMIE);
    expect(listedPhones(String(chatOf(OLD_GROUP_DAY_WITHOUT_ROSTER)))).toContain(JAMIE);
  });

  test("are inherited by an attachment, without the people only its parent's text quoted", () => {
    expect(filterPhones(OLD_ATTACHMENT)).toEqual(filterPhones(OLD_GROUP_DAY));
    expect(
      (OLD_ATTACHMENT.metadata.people ?? []).some((person) => person.role === "mentioned"),
    ).toBe(false);
  });
});

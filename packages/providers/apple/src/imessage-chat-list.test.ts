// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The list of chats the iMessage source publishes for filters, read from a
 * `chat.db` built for the test, and the form in which stored conversations
 * hold their chat and their people.
 *
 * Chat and person filters declare version 0: they apply to conversations
 * stored by every earlier build, with no resync. The documents in the second
 * half are written out by hand in the shape the first build of the normalizer
 * stored them, and compared with what today's normalizer and today's list
 * produce for the same chat. All names, numbers and addresses are invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  collectFilterList,
  documentFieldFilterProblem,
  personFilterProblem,
} from "@omnesis/source-sdk";
import { ProviderId, SourceId, personIdentifiers } from "@omnesis/types";
import { appleIMessageDocumentProfile } from "./document-profiles.js";
import { IMESSAGE_CHAT_FIELD, listIMessageChats } from "./imessage-chat-list.js";
import { normalizeDayChat } from "./imessage-normalizer.js";
import { AppleIMessageSource } from "./imessage.js";
import { AppleProvider } from "./provider.js";
import appleProvider from "./index.js";
import type { DocumentInput, FilterListItem } from "@omnesis/types";
import type { ParsedIMessage } from "./imessage-types.js";

const ACCOUNT = "sam.rivera@example.org";
const SOURCE = SourceId(`apple-imessage:${ACCOUNT}`);
const PROVIDER = ProviderId(`apple:${ACCOUNT}`);
const MAYA = "+12025550123";
const JAMIE = "+12025550142";
const DAVID_EMAIL = "David.Lin@Example.org";
const GROUP = "chat100000000000000001";
const DATE = "2026-03-08";

let dir: string;
let db: Database.Database;
let nextHandle = 1;
let nextChat = 1;

beforeEach(() => {
  nextHandle = 1;
  nextChat = 1;
  dir = mkdtempSync(join(tmpdir(), "omnesis-test-imessage-chats-"));
  db = new Database(join(dir, "chat.db"));
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT,
      service_name TEXT, display_name TEXT
    );
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function handle(id: string): number {
  const rowId = nextHandle++;
  db.prepare("INSERT INTO handle (ROWID, id, service) VALUES (?, ?, 'iMessage')").run(rowId, id);
  return rowId;
}

function chat(identifier: string, handles: number[], displayName: string | null = null): void {
  const rowId = nextChat++;
  db.prepare(
    "INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name) VALUES (?, ?, ?, 'iMessage', ?)",
  ).run(rowId, `guid-${rowId}`, identifier, displayName);
  for (const handleId of handles) {
    db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(
      rowId,
      handleId,
    );
  }
}

const list = (): Map<string, FilterListItem> =>
  new Map(listIMessageChats(db, SOURCE).map((item) => [item.id, item]));
const members = (item: FilterListItem | undefined): string[] =>
  (item?.members ?? []).map((member) => `${member.type}:${member.value}`).sort();

describe("the list of chats", () => {
  test("lists a one-to-one chat under the other party's handle, with both sides", () => {
    chat(MAYA, [handle(MAYA)]);

    expect(list().get(MAYA)).toEqual({
      id: MAYA,
      label: MAYA,
      members: [
        { type: "email", value: ACCOUNT },
        { type: "phone", value: MAYA },
      ],
    });
  });

  test("lists every member of a group, whoever has spoken, by phone or lowercase email", () => {
    chat(GROUP, [handle(MAYA), handle(JAMIE), handle(DAVID_EMAIL)], "Studio Northstar crew");

    const item = list().get(GROUP);
    expect(item?.label).toBe("Studio Northstar crew");
    expect(members(item)).toEqual(
      [`email:${ACCOUNT}`, "email:david.lin@example.org", `phone:${MAYA}`, `phone:${JAMIE}`].sort(),
    );
    expect(item?.membersIncomplete).toBeUndefined();
  });

  test("labels a group nobody named by its first members", () => {
    chat(GROUP, [handle(MAYA), handle(JAMIE), handle(DAVID_EMAIL), handle("+12025550177")]);

    expect(list().get(GROUP)?.label).toBe(`${MAYA}, ${JAMIE}, +12025550177 +1`);
  });

  test("treats the iMessage and SMS rows of one conversation as one chat", () => {
    const maya = handle(MAYA);
    chat(MAYA, [maya]);
    chat(MAYA, [maya]);

    expect([...list().keys()]).toEqual([MAYA]);
    expect(members(list().get(MAYA))).toEqual([`email:${ACCOUNT}`, `phone:${MAYA}`].sort());
  });

  test("says so when a member's handle is neither a phone number nor an address", () => {
    chat(GROUP, [handle(MAYA), handle("NORTHSTAR")], "Offers");
    chat("72345", [handle("72345")]);

    expect(members(list().get(GROUP))).toEqual([`email:${ACCOUNT}`, `phone:${MAYA}`].sort());
    expect(list().get(GROUP)?.membersIncomplete).toBe(true);
    expect(members(list().get("72345"))).toEqual([`email:${ACCOUNT}`]);
    expect(list().get("72345")?.membersIncomplete).toBe(true);
  });

  test("says so when Messages records no member for a chat", () => {
    chat(GROUP, [], "Emptied");

    expect(list().get(GROUP)?.membersIncomplete).toBe(true);
  });

  test("shows a renamed group and a new member without any message being read", () => {
    const maya = handle(MAYA);
    chat(GROUP, [maya, handle(JAMIE)], "Crew");
    expect(list().get(GROUP)?.label).toBe("Crew");

    db.prepare("UPDATE chat SET display_name = 'Atlas crew' WHERE chat_identifier = ?").run(GROUP);
    db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, ?)").run(
      handle(DAVID_EMAIL),
    );

    // The database has no message table at all: the list cannot depend on one.
    expect(list().get(GROUP)?.label).toBe("Atlas crew");
    expect(members(list().get(GROUP))).toContain("email:david.lin@example.org");
  });

  test("is produced by the source and passes the list contract", async () => {
    chat(MAYA, [handle(MAYA)]);
    chat(GROUP, [handle(JAMIE), handle("NORTHSTAR")], "Offers");
    const provider = new AppleProvider({
      notesDbPath: join(dir, "missing.sqlite"),
      remindersDirPath: join(dir, "missing-dir"),
      imessageDbPath: join(dir, "chat.db"),
      accountId: ACCOUNT,
    });
    await provider.initialize();
    await provider.authenticate();
    try {
      const source = new AppleIMessageSource(provider, { sourceId: SOURCE, providerId: PROVIDER });
      const items = await collectFilterList(() => source.listChats(), {
        signal: new AbortController().signal,
      });
      expect(items.map((item) => [item.id, item.membersIncomplete === true])).toEqual([
        [MAYA, false],
        [GROUP, true],
      ]);
    } finally {
      await provider.disconnect();
    }
  });

  test("fails rather than list nothing while the Messages database cannot be opened", async () => {
    const provider = new AppleProvider({
      notesDbPath: join(dir, "missing.sqlite"),
      remindersDirPath: join(dir, "missing-dir"),
      imessageDbPath: join(dir, "missing-chat.db"),
      accountId: ACCOUNT,
    });
    await provider.initialize();
    try {
      const source = new AppleIMessageSource(provider, { sourceId: SOURCE, providerId: PROVIDER });
      expect(() => source.listChats()).toThrow();
    } finally {
      await provider.disconnect();
    }
  });
});

describe("the declaration", () => {
  const imessage = appleProvider.sources.find((source) => source.id === "apple-imessage")!;
  const context = { outputRevision: imessage.contract?.outputRevision ?? 1, partitioned: false };

  test("marks the chat identifier as a filterable field every stored record carries", () => {
    const field = appleIMessageDocumentProfile.metadataFields?.find(
      (entry) => entry.path === IMESSAGE_CHAT_FIELD,
    );
    expect(field?.filter).toEqual({
      capability: "membership",
      minVersion: 0,
      scope: "global",
      noun: { one: "conversation", many: "conversations" },
      picker: "search",
      listsMembers: true,
    });
    expect(documentFieldFilterProblem("string", field?.filter, context)).toBeNull();
  });

  test("matches people by a participant's phone or address, with the chat's listed members", () => {
    expect(appleIMessageDocumentProfile.personFilter).toEqual({
      minVersion: 0,
      roles: ["participant"],
      identifiers: ["phone", "email"],
      membersOf: IMESSAGE_CHAT_FIELD,
    });
    expect(
      personFilterProblem(
        appleIMessageDocumentProfile.personFilter,
        appleIMessageDocumentProfile,
        context,
      ),
    ).toBeNull();
  });

  test("states what a resync costs in one sentence", () => {
    expect(imessage.resyncCost).toMatch(/nothing is downloaded/);
  });
});

// ── Stored conversations, then and now ──────────────────────────────────────

type StoredDocument = Pick<DocumentInput, "externalId" | "metadata">;

/** A one-to-one day as the first build stored it. */
const OLD_DIRECT_DAY: StoredDocument = {
  externalId: `${MAYA}:${DATE}`,
  metadata: {
    sourceUrl: `imessage://${MAYA}`,
    documentType: "conversation",
    tags: ["iMessage"],
    people: [
      { role: "participant", name: "You", emails: [ACCOUNT] },
      { role: "participant", name: undefined, phones: [MAYA] },
    ],
    extra: {
      chatIdentifier: MAYA,
      chatName: undefined,
      isGroup: false,
      messageCount: 1,
      service: "iMessage",
      participants: [MAYA],
      date: DATE,
    },
  },
};

/**
 * A group day as the first build stored it: the roster was not read then, so
 * only that day's speakers are on it. David spoke; Jamie, a member, did not.
 */
const OLD_GROUP_DAY: StoredDocument = {
  externalId: `${GROUP}:${DATE}`,
  metadata: {
    sourceUrl: undefined,
    documentType: "conversation",
    tags: ["iMessage"],
    people: [
      { role: "participant", name: "You", emails: [ACCOUNT] },
      { role: "participant", name: undefined, emails: ["david.lin@example.org"] },
      { role: "mentioned", phones: ["+12025550199"] },
    ],
    extra: {
      chatIdentifier: GROUP,
      chatName: "Studio Northstar crew",
      isGroup: true,
      messageCount: 1,
      service: "iMessage",
      participants: [DAVID_EMAIL],
      date: DATE,
    },
  },
};

const filterRoles = new Set<string>(appleIMessageDocumentProfile.personFilter!.roles);
const filterKinds = new Set<string>(appleIMessageDocumentProfile.personFilter!.identifiers);

function chatOf(doc: StoredDocument): unknown {
  const [root, key] = IMESSAGE_CHAT_FIELD.split(".") as ["extra", string];
  return doc.metadata[root]?.[key];
}

/** The identifiers of the people a person filter considers, as `kind:value`. */
function filterIdentifiers(doc: StoredDocument): string[] {
  return (doc.metadata.people ?? [])
    .filter((person) => filterRoles.has(person.role))
    .flatMap((person) => personIdentifiers(person))
    .filter((identifier) => filterKinds.has(identifier.kind))
    .map((identifier) => `${identifier.kind}:${identifier.value}`)
    .sort();
}

function parsed(overrides: Partial<ParsedIMessage>): ParsedIMessage {
  return {
    rowId: 1,
    guid: "msg-1",
    text: "see you there",
    date: new Date(`${DATE}T12:00:00Z`),
    isFromMe: false,
    isSystemMessage: false,
    sender: MAYA,
    service: "iMessage",
    attachments: [],
    contactId: MAYA,
    ...overrides,
  };
}

describe("stored conversations", () => {
  const todayDirect = () =>
    normalizeDayChat(
      DATE,
      [parsed({})],
      { chatIdentifier: MAYA, displayName: null, isGroup: false, service: "iMessage" },
      PROVIDER,
      SOURCE,
    );
  const todayGroup = () =>
    normalizeDayChat(
      DATE,
      [
        parsed({
          sender: DAVID_EMAIL,
          contactId: DAVID_EMAIL,
          text: "call the venue on +12025550199",
        }),
      ],
      {
        chatIdentifier: GROUP,
        displayName: "Studio Northstar crew",
        isGroup: true,
        service: "iMessage",
        participantHandles: [MAYA, JAMIE, DAVID_EMAIL],
      },
      PROVIDER,
      SOURCE,
    );

  test("hold their chat at the declared path, as the identifier the list uses", () => {
    chat(MAYA, [handle(MAYA)]);
    chat(GROUP, [handle(MAYA), handle(JAMIE), handle(DAVID_EMAIL)], "Studio Northstar crew");

    for (const doc of [OLD_DIRECT_DAY, OLD_GROUP_DAY]) {
      const id = chatOf(doc);
      expect(typeof id).toBe("string");
      expect(doc.externalId.startsWith(`${String(id)}:`)).toBe(true);
      expect(list().has(String(id))).toBe(true);
    }
    expect(chatOf(todayDirect())).toBe(chatOf(OLD_DIRECT_DAY));
    expect(chatOf(todayGroup())).toBe(chatOf(OLD_GROUP_DAY));
    expect(todayDirect().externalId).toBe(OLD_DIRECT_DAY.externalId);
    expect(todayGroup().externalId).toBe(OLD_GROUP_DAY.externalId);
  });

  test("hold phones in E.164 and addresses in lowercase, as the list spells its members", () => {
    chat(MAYA, [handle(MAYA)]);
    chat(GROUP, [handle(MAYA), handle(JAMIE), handle(DAVID_EMAIL)], "Studio Northstar crew");

    expect(filterIdentifiers(OLD_DIRECT_DAY)).toEqual([`email:${ACCOUNT}`, `phone:${MAYA}`]);
    expect(filterIdentifiers(todayDirect())).toEqual(filterIdentifiers(OLD_DIRECT_DAY));
    expect(members(list().get(MAYA))).toEqual(filterIdentifiers(OLD_DIRECT_DAY));

    // Every identifier the old group day holds is one the list spells the same way.
    expect(filterIdentifiers(OLD_GROUP_DAY)).toEqual(
      [`email:${ACCOUNT}`, "email:david.lin@example.org"].sort(),
    );
    for (const identifier of filterIdentifiers(OLD_GROUP_DAY)) {
      expect(members(list().get(GROUP))).toContain(identifier);
    }
    // Today's day also lists the members who stayed silent; the list covers
    // them for the days stored before it did.
    expect(filterIdentifiers(todayGroup())).toEqual(members(list().get(GROUP)));
    expect(filterIdentifiers(OLD_GROUP_DAY)).not.toContain(`phone:${JAMIE}`);
    expect(members(list().get(GROUP))).toContain(`phone:${JAMIE}`);
  });

  test("still write identifiers in the arrays the first build used", () => {
    for (const person of todayGroup().metadata.people ?? []) {
      expect(person.identifiers).toBeUndefined();
    }
  });

  test("do not count an address or number quoted in the text as someone in the chat", () => {
    expect(filterIdentifiers(OLD_GROUP_DAY)).not.toContain("phone:+12025550199");
    expect(filterIdentifiers(todayGroup())).not.toContain("phone:+12025550199");
  });
});

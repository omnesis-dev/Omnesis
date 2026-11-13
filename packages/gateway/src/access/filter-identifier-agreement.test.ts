// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A person filter matches by comparing the identifiers an owner saved with
 * the identifiers of the people a record involves. Each case writes the two
 * sides the way their own path does: a typed identifier through the check a
 * client calls before saving (`readTypedFilterIdentifier`, behind
 * `POST /admin/access/source-filters/identifiers`) and the saved filter's
 * parser, a record's people and a chat's members as a source stores them.
 * Then it asks the read check which records an agent sees.
 *
 * All fixture data is invented.
 */

import { readTypedFilterIdentifier } from "@omnesis/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentAccessInclusionSql } from "./filter-decision.js";
import { filterFieldsFor } from "./filter-fields.js";
import { filterPersonIdentifiers } from "./filter-editor-reads.js";
import { parseSourceFilter } from "./scope-policy.js";
import {
  PARLEY_PROFILE,
  insertDocument,
  openFilterFixture,
  publishList,
  publishProfile,
  type FilterFixture,
} from "./filter-test-utils.js";
import type { DocumentEventProfile } from "@omnesis/source-sdk";
import type { FilterIdentifierType, FilterListItem, PersonMention } from "@omnesis/types";

const CHAT = "parley:studio";
const MAIL = "letters:inbox";

/** Chat members and a record's own participants, read by phone or email. */
const CHAT_PROFILE = {
  ...PARLEY_PROFILE,
  personFilter: {
    minVersion: 0,
    roles: ["participant"],
    identifiers: ["phone", "email"],
    membersOf: "extra.chatId",
  },
} as unknown as DocumentEventProfile;

/** Mail: the sender and recipients of a message, by address or by domain. */
const MAIL_PROFILE = {
  documentTypes: ["email"],
  personRoles: ["sender", "recipient", "mentioned"],
  metadataFields: [],
  personFilter: {
    minVersion: 0,
    roles: ["sender", "recipient"],
    identifiers: ["email", "domain"],
  },
} as unknown as DocumentEventProfile;

let fixture: FilterFixture;

beforeEach(() => {
  fixture = openFilterFixture();
  publishProfile(fixture.db, "parley", 1, CHAT_PROFILE);
  publishProfile(fixture.db, "letters", 1, MAIL_PROFILE);
});

afterEach(() => fixture.close());

/** Each chat gets one day record; the list holds every chat with its members. */
function chats(items: FilterListItem[]): void {
  publishList(fixture.db, { sourceId: CHAT, field: "extra.chatId" }, items);
  for (const item of items) {
    insertDocument(fixture.db, {
      id: `${item.id}-day`,
      sourceId: CHAT,
      metadata: { documentType: "day", people: [], extra: { chatId: item.id } },
    });
  }
}

function chatDay(id: string, chatId: string, people: PersonMention[]): void {
  insertDocument(fixture.db, {
    id,
    sourceId: CHAT,
    metadata: { documentType: "day", people, extra: { chatId } },
  });
}

function email(id: string, people: PersonMention[]): void {
  insertDocument(fixture.db, { id, sourceId: MAIL, metadata: { documentType: "email", people } });
}

/** The identifier exactly as the client's check returns it, or the sentence it shows. */
function typedIdentifier(type: FilterIdentifierType, value: string) {
  const read = readTypedFilterIdentifier(type, value);
  if ("error" in read) throw new Error(read.error);
  return read.identifier;
}

/** The records an agent sees under a filter naming one person by `typed`. */
function visible(
  sourceId: string,
  action: "share" | "hide",
  typed: Array<{ type: FilterIdentifierType; value: string }>,
): string[] {
  const policy = parseSourceFilter(
    {
      sourceId,
      audience: { accessLevel: "level", capability: "direct" },
      rules: [
        {
          action,
          match: [{ capability: "person", label: "As typed", identifiers: typed }],
        },
      ],
      otherwise: action === "share" ? "hide" : "share",
    },
    filterFieldsFor(fixture.db, sourceId.split(":")[0]!),
  );
  const saved = policy.rules[0].match[0]!;
  // The identifier saved is the one the client's check showed the owner.
  expect(saved.capability === "person" && saved.identifiers).toEqual(
    typed.map((identifier) => typedIdentifier(identifier.type, identifier.value)),
  );
  const inclusion = documentAccessInclusionSql(
    fixture.db,
    { capabilityGranted: true, permittedSourceIds: null, filters: [policy] },
    "d.id",
    "d.source_id",
    { row: "d" },
  );
  return fixture.db
    .prepare<unknown[], { id: string }>(
      `SELECT d.id FROM documents d WHERE d.source_id = ? AND ${inclusion.sql} ORDER BY d.id`,
    )
    .all(sourceId, ...inclusion.params)
    .map((row) => row.id);
}

describe("phone numbers", () => {
  it.each([
    "+12025550123",
    "+1 (202) 555-0123",
    "+1 202-555-0123",
    "+1.202.555.0123",
    "0012025550123",
    "+1 202 555 0123",
    "tel:+12025550123",
  ])("a number typed as %j shares and hides the chat whose members include it", (typed) => {
    chats([
      { id: "with-maya", label: "Maya", members: [{ type: "phone", value: "+12025550123" }] },
      { id: "with-jamie", label: "Jamie", members: [{ type: "phone", value: "+12025550145" }] },
    ]);
    const identifiers = [{ type: "phone" as const, value: typed }];
    expect(visible(CHAT, "share", identifiers)).toEqual(["with-maya-day"]);
    expect(visible(CHAT, "hide", identifiers)).toEqual(["with-jamie-day"]);
  });

  it.each(["+1 (202) 555-0123", "+1 202 555 0123", "001 202 555 0123"])(
    "a record that stores %j still meets the number saved in its canonical form",
    (stored) => {
      chats([{ id: "quiet", label: "Quiet", members: [] }]);
      chatDay("from-maya", "quiet", [{ role: "participant", phones: [stored] }]);
      const identifiers = [{ type: "phone" as const, value: "+12025550123" }];
      expect(visible(CHAT, "share", identifiers)).toEqual(["from-maya"]);
      expect(visible(CHAT, "hide", identifiers)).toEqual(["quiet-day"]);
    },
  );

  it.each(["12025550123", "(202) 555-0123", "12025550123@s.example.net"])(
    "a participant stored without a country code as %j leaves the record unknown, hidden either way",
    (stored) => {
      chats([{ id: "quiet", label: "Quiet", members: [] }]);
      chatDay("unaddressable", "quiet", [{ role: "participant", phones: [stored] }]);
      const identifiers = [{ type: "phone" as const, value: "+12025550123" }];
      expect(visible(CHAT, "share", identifiers)).toEqual([]);
      expect(visible(CHAT, "hide", identifiers)).toEqual(["quiet-day"]);
    },
  );

  it("a chat whose roster is not known whole is unknown unless a listed member matches", () => {
    chats([
      {
        id: "partial",
        label: "Partial",
        members: [{ type: "phone", value: "+12025550145" }],
        membersIncomplete: true,
      },
      {
        id: "partial-with-maya",
        label: "Partial with Maya",
        members: [{ type: "phone", value: "+12025550123" }],
        membersIncomplete: true,
      },
    ]);
    const identifiers = [{ type: "phone" as const, value: "+12025550123" }];
    expect(visible(CHAT, "share", identifiers)).toEqual(["partial-with-maya-day"]);
    expect(visible(CHAT, "hide", identifiers)).toEqual([]);
  });

  it("a member the source lists by email is matched however its case was typed", () => {
    chats([
      {
        id: "by-email",
        label: "By email",
        members: [{ type: "email", value: "Maya.Reeves@Example.org" }],
      },
      { id: "other", label: "Other", members: [{ type: "email", value: "jamie@example.io" }] },
    ]);
    const identifiers = [{ type: "email" as const, value: "MAYA.REEVES@example.ORG " }];
    expect(visible(CHAT, "share", identifiers)).toEqual(["by-email-day"]);
    expect(visible(CHAT, "hide", identifiers)).toEqual(["other-day"]);
  });
});

describe("email addresses and domains", () => {
  it.each([
    ["Maya@Example.ORG", "maya@example.org"],
    ["maya@example.org", "Maya <MAYA@example.org>"],
    ["maya@example.org", "mailto:maya@example.org"],
    ["maya@example.org.", "maya@example.org"],
    ["o'neil&co=7@example.org", "O'Neil&Co=7@example.org"],
    ["maya@bücher.example", "maya@xn--bcher-kva.example"],
    ["maya@xn--bcher-kva.example", "maya@BÜCHER.example"],
  ])("mail stored from %j meets the address typed as %j", (stored, typed) => {
    email("from-maya", [
      { role: "sender", emails: [stored] },
      { role: "recipient", isSelf: true, emails: ["owner@example.org"] },
    ]);
    email("from-jamie", [
      { role: "sender", emails: ["jamie@example.net"] },
      { role: "recipient", isSelf: true, emails: ["owner@example.org"] },
    ]);
    const identifiers = [{ type: "email" as const, value: typed }];
    expect(visible(MAIL, "share", identifiers)).toEqual(["from-maya"]);
    expect(visible(MAIL, "hide", identifiers)).toEqual(["from-jamie"]);
  });

  it("plus-addressing is a different address outside the providers that fold it", () => {
    email("tagged", [{ role: "sender", emails: ["maya+receipts@example.org"] }]);
    email("plain", [{ role: "sender", emails: ["maya@example.org"] }]);
    const identifiers = [{ type: "email" as const, value: "maya@example.org" }];
    expect(visible(MAIL, "share", identifiers)).toEqual(["plain"]);
    expect(visible(MAIL, "hide", identifiers)).toEqual(["tagged"]);
  });

  it.each(["studio.example", "STUDIO.example", "@studio.example", "studio.example."])(
    "the domain typed as %j is one exact host name: never a subdomain, a suffix or a lookalike",
    (typed) => {
      email("exact", [{ role: "sender", emails: ["Maya@Studio.EXAMPLE"] }]);
      email("subdomain", [{ role: "sender", emails: ["maya@mail.studio.example"] }]);
      email("lookalike", [{ role: "sender", emails: ["maya@notstudio.example"] }]);
      email("suffix", [{ role: "sender", emails: ["maya@studio.example.example.net"] }]);
      const identifiers = [{ type: "domain" as const, value: typed }];
      expect(visible(MAIL, "share", identifiers)).toEqual(["exact"]);
      expect(visible(MAIL, "hide", identifiers)).toEqual(["lookalike", "subdomain", "suffix"]);
    },
  );

  it("a person in To, Cc or Bcc counts; an address only quoted in the body does not", () => {
    email("to", [
      { role: "sender", emails: ["jamie@example.net"] },
      { role: "recipient", emails: ["maya@example.org"] },
    ]);
    email("body-only", [
      { role: "sender", emails: ["jamie@example.net"] },
      { role: "mentioned", emails: ["maya@example.org"] },
    ]);
    const identifiers = [{ type: "email" as const, value: "maya@example.org" }];
    expect(visible(MAIL, "share", identifiers)).toEqual(["to"]);
    expect(visible(MAIL, "hide", identifiers)).toEqual(["body-only"]);
  });

  it("a participant with no usable address leaves the message unknown, hidden either way", () => {
    email("malformed", [
      { role: "sender", emails: ["jamie@example.net"] },
      { role: "recipient", emails: ["undisclosed-recipients"] },
    ]);
    const identifiers = [{ type: "email" as const, value: "maya@example.org" }];
    expect(visible(MAIL, "share", identifiers)).toEqual([]);
    expect(visible(MAIL, "hide", identifiers)).toEqual([]);
  });
});

describe("what an owner types or picks", () => {
  it.each([
    ["phone", "00 1 (555) 010-0142", "+15550100142"],
    ["email", "Maya <Maya.Reeves@Example.ORG>", "maya.reeves@example.org"],
    ["domain", "@Example.ORG.", "example.org"],
  ] as const)("the check a client calls reads the %s %j as %j", (type, raw, value) => {
    expect(readTypedFilterIdentifier(type, raw)).toEqual({ identifier: { type, value } });
  });

  it.each([
    ["phone", "+44 (0)7700 900123"],
    ["phone", "(202) 555-0123"],
    ["email", "maya"],
    ["domain", "*.example.org"],
  ] as const)("the check refuses the %s %j with the sentence the field shows", (type, raw) => {
    const read = readTypedFilterIdentifier(type, raw);
    expect(read).toEqual({ error: expect.stringMatching(/^Enter /) });
  });

  it("picking a person offers every address of them and of the people merged into them, in the saved spelling", () => {
    const { db } = fixture;
    const person = db.prepare(
      `INSERT INTO people (id, canonical_name, merged_into, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, ?, 'test', 'now', 'now', 'now', 'now')`,
    );
    person.run("maya", "Maya", null);
    person.run("maya-old", "Maya", "maya");
    let aliases = 0;
    const insertAlias = db.prepare(
      "INSERT INTO person_aliases (id, person_id, alias_type, alias, created_at) VALUES (?, ?, ?, ?, 'now')",
    );
    const alias = {
      run: (personId: string, type: string, value: string) =>
        insertAlias.run(`alias-${++aliases}`, personId, type, value),
    };
    alias.run("maya", "phone", "+12025550123");
    alias.run("maya", "phone", "+1 (202) 555-0145");
    alias.run("maya", "phone", "202-555-0199");
    alias.run("maya", "email", "o'neil&co=7@example.org");
    alias.run("maya-old", "email", "Maya@BÜCHER.example");
    alias.run("maya", "name", "Maya");
    const picked = filterPersonIdentifiers(db, "maya", ["phone", "email"]);
    expect(picked).toEqual([
      { type: "email", value: "maya@xn--bcher-kva.example" },
      { type: "email", value: "o'neil&co=7@example.org" },
      { type: "phone", value: "+12025550123" },
      { type: "phone", value: "+12025550145" },
    ]);
    for (const identifier of picked!) {
      expect(typedIdentifier(identifier.type, identifier.value)).toEqual(identifier);
    }
    expect(filterPersonIdentifiers(db, "maya", ["phone"])).toEqual([
      { type: "phone", value: "+12025550123" },
      { type: "phone", value: "+12025550145" },
    ]);
  });
});

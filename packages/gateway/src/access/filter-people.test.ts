// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading the people of a stored record for a person filter: both stored
 * forms, every way the record can fail to say who it involves, and the two
 * SQL functions built on the readers. All names and addresses are invented.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  FILTER_MEMBER_SQL_FUNCTION,
  FILTER_MENTION_IDENTIFIER_LIMIT,
  FILTER_PEOPLE_SQL_FUNCTION,
  encodeFilterPeopleSpec,
  filterPeopleSpec,
  projectFilterMember,
  projectFilterPeople,
  registerFilterSqlFunctions,
  type FilterPeopleSpec,
} from "./filter-people.js";
import type { Db } from "../data/types.js";

const MAIL: FilterPeopleSpec = {
  roles: ["sender", "recipient"],
  kinds: ["email", "phone", "domain"],
  maxPeople: 1000,
  requireParticipant: true,
};
const CHAT: FilterPeopleSpec = {
  roles: ["participant"],
  kinds: ["phone"],
  maxPeople: null,
  requireParticipant: false,
};

describe("the people-keys of a record", () => {
  it("reads the per-kind arrays and the identifier list as the same assertion", () => {
    const expected = ["email:maya@example.org", "domain:example.org", "phone:+15550100123"];
    expect(
      projectFilterPeople(
        [{ role: "sender", emails: ["Maya@Example.org"], phones: ["+1 (555) 010-0123"] }],
        MAIL,
      ),
    ).toEqual(expected);
    expect(
      projectFilterPeople(
        [
          {
            role: "sender",
            identifiers: [
              { kind: "email", value: "<maya@example.org>" },
              { kind: "phone", value: "0015550100123" },
            ],
          },
        ],
        MAIL,
      ),
    ).toEqual(expected);
  });

  it("gives the same keys for one mailbox however it was written", () => {
    const keys = (email: string) =>
      projectFilterPeople([{ role: "sender", emails: [email] }], MAIL);
    expect(keys("Fictional.Maya+lists@GoogleMail.com")).toEqual(keys("fictionalmaya@gmail.com"));
    expect(keys("maya@BÜCHER.example")).toEqual(keys("maya@xn--bcher-kva.example"));
  });

  it("keeps only the roles and identifier kinds the source declares", () => {
    expect(
      projectFilterPeople(
        [
          { role: "participant", phones: ["+15550100123"], emails: ["maya@example.org"] },
          { role: "mentioned", phones: ["+15550100456"] },
          { role: "owner", phones: ["+15550100789"] },
        ],
        CHAT,
      ),
    ).toEqual(["phone:+15550100123"]);
  });

  it("derives no domain when the source does not declare domains", () => {
    expect(
      projectFilterPeople([{ role: "sender", emails: ["maya@example.org"] }], {
        ...MAIL,
        kinds: ["email"],
      }),
    ).toEqual(["email:maya@example.org"]);
  });

  it.each<[string, unknown]>([
    ["no list", undefined],
    ["null", null],
    ["text", "maya@example.org"],
    ["an object", { role: "sender" }],
    ["an empty list", []],
    ["an entry that is not a mention", ["maya@example.org"]],
    ["an entry that is null", [null]],
    ["a mention without a role", [{ emails: ["maya@example.org"] }]],
    ["a role that is not text", [{ role: 7, emails: ["maya@example.org"] }]],
    ["a person with only a name", [{ role: "sender", name: "Maya Reeves" }]],
    ["a person with only a platform id", [{ role: "sender", lids: ["parley:1"] }]],
    ["an address that cannot be read", [{ role: "sender", emails: ["maya@example.org", "maya"] }]],
    ["a national phone number", [{ role: "sender", phones: ["(555) 010-0123"] }]],
    ["an identifier that is not text", [{ role: "sender", emails: [42] }]],
    ["identifiers that are not a list", [{ role: "sender", emails: "maya@example.org" }]],
    ["an identifier list that is an object", [{ role: "sender", identifiers: { kind: "email" } }]],
    ["an identifier entry that is null", [{ role: "sender", identifiers: [null] }]],
    ["only the owner, without an identifier", [{ role: "sender", isSelf: true }]],
    ["only people in undeclared roles", [{ role: "mentioned", emails: ["maya@example.org"] }]],
  ])("is unknown for %s", (_what, people) => {
    expect(projectFilterPeople(people, MAIL)).toBeNull();
  });

  it("is unknown when the list is as long as the source's cap, and known just under it", () => {
    const people = (count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        role: "recipient",
        emails: [`guest${index}@example.io`],
      }));
    expect(projectFilterPeople(people(1000), MAIL)).toBeNull();
    expect(projectFilterPeople(people(999), MAIL)).toHaveLength(1000);
    expect(projectFilterPeople(people(5000), { ...MAIL, maxPeople: null })).toHaveLength(5001);
  });

  it("is unknown when one person carries more identifiers than it reads", () => {
    const emails = (count: number) =>
      Array.from({ length: count }, (_unused, index) => `alias${index}@example.io`);
    const limit = FILTER_MENTION_IDENTIFIER_LIMIT;
    expect(projectFilterPeople([{ role: "sender", emails: emails(limit) }], MAIL)).not.toBeNull();
    expect(projectFilterPeople([{ role: "sender", emails: emails(limit + 1) }], MAIL)).toBeNull();
  });

  it("passes over the owner without an identifier when someone else is named", () => {
    expect(
      projectFilterPeople(
        [
          { role: "sender", isSelf: true },
          { role: "recipient", emails: ["jamie@example.io"] },
        ],
        MAIL,
      ),
    ).toEqual(["email:jamie@example.io", "domain:example.io"]);
  });

  it("accepts a record naming nobody when its people also come from a chat's members", () => {
    expect(projectFilterPeople([], CHAT)).toEqual([]);
    expect(projectFilterPeople([{ role: "mentioned", phones: ["+15550100123"] }], CHAT)).toEqual(
      [],
    );
    // Still unknown when someone it does name cannot be identified.
    expect(projectFilterPeople([{ role: "participant", lids: ["parley:1"] }], CHAT)).toBeNull();
  });
});

describe("the people-keys of a list member", () => {
  it("reads a member of a declared kind, with its domain where declared", () => {
    expect(projectFilterMember("phone", "+1 555 010 0123", ["phone"])).toEqual([
      "phone:+15550100123",
    ]);
    expect(projectFilterMember("email", "Maya@Example.org", ["email", "domain"])).toEqual([
      "email:maya@example.org",
      "domain:example.org",
    ]);
    expect(projectFilterMember("domain", "Example.org", ["domain"])).toEqual([
      "domain:example.org",
    ]);
  });

  it("gives no key to a member of a kind the source does not declare", () => {
    expect(projectFilterMember("email", "maya@example.org", ["phone"])).toEqual([]);
    expect(projectFilterMember("domain", "example.org", ["phone"])).toEqual([]);
  });

  it("is unreadable for a value it cannot read or a kind it does not know", () => {
    expect(projectFilterMember("phone", "a member without a number", ["phone"])).toBeNull();
    expect(projectFilterMember("lid", "parley:1", ["phone"])).toBeNull();
    expect(projectFilterMember("phone", 15550100123, ["phone"])).toBeNull();
    expect(projectFilterMember("domain", "not a domain", ["domain"])).toBeNull();
  });
});

describe("the SQL functions", () => {
  function open(): Db {
    const db = new Database(":memory:") as unknown as Db;
    registerFilterSqlFunctions(db);
    registerFilterSqlFunctions(db);
    return db;
  }
  const spec = encodeFilterPeopleSpec(MAIL);

  it("return the keys as JSON, or NULL when the people are unknown", () => {
    const db = open();
    const read = (people: unknown, specText: unknown = spec) =>
      db
        .prepare<[unknown, unknown], { keys: string | null }>(
          `SELECT ${FILTER_PEOPLE_SQL_FUNCTION}(?, ?) AS keys`,
        )
        .get(people, specText)!.keys;
    expect(read(JSON.stringify([{ role: "sender", emails: ["maya@example.org"] }]))).toBe(
      '["email:maya@example.org","domain:example.org"]',
    );
    expect(read("[]")).toBeNull();
    expect(read("not json")).toBeNull();
    expect(read(null)).toBeNull();
    expect(read(7)).toBeNull();
    // A spec it cannot read is never read as "anyone".
    expect(
      read(JSON.stringify([{ role: "sender", emails: ["maya@example.org"] }]), "{"),
    ).toBeNull();
    expect(
      read(JSON.stringify([{ role: "sender", emails: ["maya@example.org"] }]), null),
    ).toBeNull();
    db.close();
  });

  it("answer a repeated call for the same record from the first", () => {
    const db = open();
    const people = JSON.stringify([{ role: "sender", emails: ["maya@example.org"] }]);
    const row = db
      .prepare<[string, string, string, string], { first: string; second: string }>(
        `SELECT ${FILTER_PEOPLE_SQL_FUNCTION}(?, ?) AS first, ${FILTER_PEOPLE_SQL_FUNCTION}(?, ?) AS second`,
      )
      .get(people, spec, people, spec)!;
    expect(row.first).toBe(row.second);
    // A different spec for the same people is not served from that answer.
    const chat = db
      .prepare<[string, string], { keys: string | null }>(
        `SELECT ${FILTER_PEOPLE_SQL_FUNCTION}(?, ?) AS keys`,
      )
      .get(people, encodeFilterPeopleSpec(CHAT))!;
    expect(chat.keys).toBe("[]");
    db.close();
  });

  it("read a member, and refuse kinds they cannot parse", () => {
    const db = open();
    const read = (type: unknown, value: unknown, kinds: unknown) =>
      db
        .prepare<[unknown, unknown, unknown], { keys: string | null }>(
          `SELECT ${FILTER_MEMBER_SQL_FUNCTION}(?, ?, ?) AS keys`,
        )
        .get(type, value, kinds)!.keys;
    expect(read("phone", "+15550100123", '["phone"]')).toBe('["phone:+15550100123"]');
    expect(read("phone", "nobody", '["phone"]')).toBeNull();
    expect(read("phone", "+15550100123", "phone")).toBeNull();
    expect(read("phone", "+15550100123", null)).toBeNull();
    db.close();
  });

  it("derive the spec from the source's declaration", () => {
    expect(
      filterPeopleSpec({ minVersion: 0, roles: ["sender"], identifiers: ["email"], maxPeople: 9 }),
    ).toEqual({ roles: ["sender"], kinds: ["email"], maxPeople: 9, requireParticipant: true });
    expect(
      filterPeopleSpec({
        minVersion: 0,
        roles: ["participant"],
        identifiers: ["phone"],
        membersOf: "extra.chatId",
      }),
    ).toEqual({
      roles: ["participant"],
      kinds: ["phone"],
      maxPeople: null,
      requireParticipant: false,
    });
  });
});

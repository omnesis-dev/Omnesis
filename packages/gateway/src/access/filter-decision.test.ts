// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Why a level can or cannot read a document: one fixture document per
 * reason, the sentence each reason becomes, and the agreement between the
 * single-document decision and the same grant applied to a set.
 *
 * All fixture data is invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decideDocumentAccess,
  documentAccessInclusionSql,
  filterReadableDocumentIds,
  type AccessReason,
  type DocumentAccessGrant,
} from "./filter-decision.js";
import {
  LEDGER_PROFILE,
  PARLEY_PROFILE,
  chat,
  directory,
  folder,
  hide,
  insertDocument,
  label,
  openFilterFixture,
  person,
  publishList,
  publishProfile,
  shareOnly,
  type FilterFixture,
} from "./filter-test-utils.js";
import {
  ACCESS_AUDIT_ANSWER_NOTE,
  ACCESS_AUDIT_OWNER_NOTE,
  accessReasonText,
  tooOldCountText,
  unmatchedCountText,
} from "./filter-wording.js";
import type { SourceFilter } from "@omnesis/types";

const LEDGER = "ledger:northstar";
const PARLEY = "parley:studio";
const LAPTOP = "dev-laptop";
const MAYA = "+15550100123";
const JAMIE = "+15550100456";

let fixture: FilterFixture;

function entry(
  id: string,
  extra: Record<string, unknown>,
  options: { version?: number; streamId?: string; people?: unknown } = {},
): void {
  insertDocument(fixture.db, {
    id,
    sourceId: LEDGER,
    version: options.version ?? 3,
    streamId: options.streamId,
    metadata: {
      documentType: "entry",
      ...(options.people === undefined ? {} : { people: options.people }),
      extra,
    },
  });
}

beforeEach(() => {
  fixture = openFilterFixture();
  const { db } = fixture;
  publishProfile(db, "ledger", 5, LEDGER_PROFILE);
  publishProfile(db, "parley", 1, PARLEY_PROFILE);
  publishList(db, { sourceId: LEDGER, field: "extra.labelIds" }, [
    { id: "L-finance", label: "Finance" },
    { id: "L-clients", label: "Clients" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.folderIds" }, [
    { id: "finance", label: "Finance" },
    { id: "invoices", label: "Invoices", parentId: "finance" },
    { id: "clients", label: "Clients" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.directory", deviceId: LAPTOP }, [
    { id: "/home/maya/work", label: "~/work" },
    { id: "/home/maya/work/atlas-api", label: "~/work/atlas-api", parentId: "/home/maya/work" },
  ]);
  publishList(db, { sourceId: PARLEY, field: "extra.chatId" }, [
    {
      id: "c-team",
      label: "Studio team",
      members: [
        { type: "phone", value: MAYA },
        { type: "phone", value: JAMIE },
      ],
    },
  ]);

  entry("finance-mail", { labelIds: ["L-finance"], folderIds: ["invoices"] });
  entry("clients-mail", { labelIds: ["L-clients"], folderIds: ["clients"] });
  entry("unlabelled-id-mail", { labelIds: ["L-unlisted"], folderIds: [] });
  entry("old-mail", {}, { version: 1 });
  entry("no-detail-mail", {});
  entry("unlisted-folder-mail", { labelIds: [], folderIds: ["vanished"] });
  entry("session", { directory: "/home/maya/work/atlas-api" }, { streamId: LAPTOP });
  entry("session-no-folder", {}, { streamId: LAPTOP });
  entry("session-no-device", { directory: "/home/maya/work" });
  entry(
    "maya-mail",
    {},
    {
      people: [
        { role: "sender", emails: ["maya@example.org"] },
        { role: "recipient", emails: ["jamie@example.io"] },
      ],
    },
  );
  entry("stranger-mail", {}, { people: [{ role: "sender", name: "Someone" }] });
  entry("no-people-mail", {});
  insertDocument(db, {
    id: "orphan-attachment",
    sourceId: LEDGER,
    version: 3,
    metadata: { documentType: "attachment", extra: { parentExternalId: "gone" } },
  });
  insertDocument(db, {
    id: "finance-attachment",
    sourceId: LEDGER,
    version: 3,
    metadata: { documentType: "attachment", extra: { parentExternalId: "finance-mail" } },
  });
  insertDocument(db, {
    id: "team-day",
    sourceId: PARLEY,
    metadata: {
      documentType: "day",
      people: [{ role: "participant", phones: [JAMIE] }],
      extra: { chatId: "c-team" },
    },
  });
  insertDocument(db, { id: "almanac-note", sourceId: "almanac:home", metadata: {} });
  insertDocument(db, { id: "wiki-page", sourceId: "gateway-notes", metadata: {} });
});

afterEach(() => fixture.close());

function grant(
  filters: SourceFilter[],
  overrides: Partial<DocumentAccessGrant> = {},
): DocumentAccessGrant {
  return { capabilityGranted: true, permittedSourceIds: null, filters, ...overrides };
}

/** The decision, checked against the same grant applied to a set and to a re-check. */
function decide(access: DocumentAccessGrant, documentId: string) {
  const decision = decideDocumentAccess(fixture.db, access, documentId);
  const inclusion = documentAccessInclusionSql(fixture.db, access, "d.id", "d.source_id", {
    row: "d",
  });
  const inSet =
    fixture.db
      .prepare(`SELECT 1 FROM documents d WHERE d.id = ? AND ${inclusion.sql}`)
      .get(documentId, ...inclusion.params) !== undefined;
  const lookup = documentAccessInclusionSql(fixture.db, access, "t.document_id", "t.source_id");
  const byId =
    fixture.db
      .prepare(
        `SELECT 1 FROM (SELECT id AS document_id, source_id FROM documents WHERE id = ?) t WHERE ${lookup.sql}`,
      )
      .get(documentId, ...lookup.params) !== undefined;
  const rechecked = filterReadableDocumentIds(fixture.db, access, [documentId]).has(documentId);
  expect({ inSet, byId, rechecked }).toEqual({
    inSet: decision.readable,
    byId: decision.readable,
    rechecked: decision.readable,
  });
  return decision;
}

describe("one document per reason", () => {
  const cases: Array<{
    name: string;
    access: () => DocumentAccessGrant;
    document: string;
    readable: boolean;
    reason: AccessReason;
    direct: string;
  }> = [
    {
      name: "the permission is not granted on the level",
      access: () => grant([], { capabilityGranted: false }),
      document: "finance-mail",
      readable: false,
      reason: { code: "permission-not-granted" },
      direct: "Direct is not granted on this level",
    },
    {
      name: "the document's account is not shared",
      access: () => grant([], { permittedSourceIds: new Set([PARLEY]) }),
      document: "finance-mail",
      readable: false,
      reason: { code: "account-not-shared" },
      direct: "This account is not shared",
    },
    {
      name: "the account is shared and has no filter",
      access: () =>
        grant([hide(PARLEY, [chat("c-team")])], { permittedSourceIds: new Set([LEDGER, PARLEY]) }),
      document: "finance-mail",
      readable: true,
      reason: { code: "readable" },
      direct: "Readable",
    },
    {
      name: "a hide filter leaves it readable",
      access: () => grant([hide(LEDGER, [label("L-finance")])]),
      document: "clients-mail",
      readable: true,
      reason: { code: "readable" },
      direct: "Readable",
    },
    {
      name: "a share-only filter lets it through, naming the label",
      access: () => grant([shareOnly(LEDGER, [label("L-clients"), label("L-finance")])]),
      document: "clients-mail",
      readable: true,
      reason: { code: "readable", via: { noun: "label", label: "Clients" } },
      direct: "Readable: label Clients lets it through",
    },
    {
      name: "a share-only filter lets it through by a folder above its own",
      access: () => grant([shareOnly(LEDGER, [folder("finance")])]),
      document: "finance-mail",
      readable: true,
      reason: { code: "readable", via: { noun: "folder", label: "Finance" } },
      direct: "Readable: folder Finance lets it through",
    },
    {
      name: "a hide filter hides it, naming the label",
      access: () => grant([hide(LEDGER, [label("L-finance")])]),
      document: "finance-mail",
      readable: false,
      reason: { code: "hidden-by-item", item: { noun: "label", label: "Finance" } },
      direct: "Hidden by: label Finance",
    },
    {
      name: "a hide filter hides an attachment through its parent",
      access: () => grant([hide(LEDGER, [label("L-finance")])]),
      document: "finance-attachment",
      readable: false,
      reason: { code: "hidden-by-item", item: { noun: "label", label: "Finance" } },
      direct: "Hidden by: label Finance",
    },
    {
      name: "a hide filter hides it by an id the list has no name for",
      access: () => grant([hide(LEDGER, [label("L-unlisted")])]),
      document: "unlabelled-id-mail",
      readable: false,
      reason: { code: "hidden-by-item", item: { noun: "label", label: "L-unlisted" } },
      direct: "Hidden by: label L-unlisted",
    },
    {
      name: "a hide filter hides a session by the project folder above it",
      access: () => grant([hide(LEDGER, [directory(LAPTOP, "/home/maya/work")])]),
      document: "session",
      readable: false,
      reason: { code: "hidden-by-item", item: { noun: "project folder", label: "~/work" } },
      direct: "Hidden by: project folder ~/work",
    },
    {
      name: "a hide filter hides a session by its whole device",
      access: () => grant([hide(LEDGER, [directory(LAPTOP, "")])]),
      document: "session",
      readable: false,
      reason: { code: "hidden-by-item", item: { noun: "device", label: LAPTOP } },
      direct: `Hidden by: device ${LAPTOP}`,
    },
    {
      name: "a hide filter hides it by a person on the record",
      access: () => grant([hide(LEDGER, [person("Maya Reeves", ["email", "maya@example.org"])])]),
      document: "maya-mail",
      readable: false,
      reason: { code: "hidden-by-item", item: { noun: "person", label: "Maya Reeves" } },
      direct: "Hidden by: person Maya Reeves",
    },
    {
      name: "a hide filter hides it by a silent member of its chat",
      access: () => grant([hide(PARLEY, [person("Maya Reeves", ["phone", MAYA])])]),
      document: "team-day",
      readable: false,
      reason: { code: "hidden-by-item", item: { noun: "person", label: "Maya Reeves" } },
      direct: "Hidden by: person Maya Reeves",
    },
    {
      name: "a share-only filter does not include it",
      access: () => grant([shareOnly(LEDGER, [label("L-clients")])]),
      document: "finance-mail",
      readable: false,
      reason: { code: "not-included" },
      direct: "Not included by this level's share-only filter",
    },
    {
      name: "the record is too old for the filter",
      access: () => grant([hide(LEDGER, [label("L-finance")])]),
      document: "old-mail",
      readable: false,
      reason: {
        code: "record-too-old",
        field: "extra.labelIds",
        noun: { one: "label", many: "labels" },
        recordVersion: 1,
        minVersion: 2,
      },
      direct: "This record is too old for this filter and has not been resynced",
    },
    {
      name: "a detail is not on the record",
      access: () => grant([hide(LEDGER, [directory(LAPTOP, "/home/maya/work")])]),
      document: "session-no-folder",
      readable: false,
      reason: {
        code: "detail-unknown",
        field: "extra.directory",
        noun: { one: "project folder", many: "project folders" },
        person: false,
        cause: "absent",
      },
      direct: "Its project folder is unknown",
    },
    {
      name: "the record sits in a folder the list does not hold",
      access: () => grant([hide(LEDGER, [folder("clients")])]),
      document: "unlisted-folder-mail",
      readable: false,
      reason: {
        code: "detail-unknown",
        field: "extra.folderIds",
        noun: { one: "folder", many: "folders" },
        person: false,
        cause: "not-listed",
      },
      direct: "Its folder is not in this account's list of folders",
    },
    {
      name: "the record does not say which device it came from",
      access: () => grant([hide(LEDGER, [directory(LAPTOP, "/home/maya/work")])]),
      document: "session-no-device",
      readable: false,
      reason: {
        code: "detail-unknown",
        field: "extra.directory",
        noun: { one: "project folder", many: "project folders" },
        person: false,
        cause: "device-unknown",
      },
      direct: "The device it came from is unknown",
    },
    {
      name: "someone on the record cannot be identified",
      access: () => grant([hide(LEDGER, [person("Maya Reeves", ["email", "maya@example.org"])])]),
      document: "stranger-mail",
      readable: false,
      reason: {
        code: "detail-unknown",
        field: "$people",
        noun: { one: "person", many: "people" },
        person: true,
        cause: "person-unreadable",
      },
      direct: "Someone it involves cannot be identified",
    },
    {
      name: "the record's people were never recorded",
      access: () => grant([hide(LEDGER, [person("Maya Reeves", ["email", "maya@example.org"])])]),
      document: "no-people-mail",
      readable: false,
      reason: {
        code: "detail-unknown",
        field: "$people",
        noun: { one: "person", many: "people" },
        person: true,
        cause: "absent",
      },
      direct: "The people it involves are unknown",
    },
    {
      name: "the record an attachment belongs to is missing",
      access: () => grant([hide(LEDGER, [label("L-finance")])]),
      document: "orphan-attachment",
      readable: false,
      reason: {
        code: "detail-unknown",
        field: null,
        noun: null,
        person: false,
        cause: "parent-missing",
      },
      direct: "The record it was attached to is missing",
    },
    {
      name: "the filter cannot be applied",
      access: () =>
        grant([hide(LEDGER, [{ capability: "membership", field: "extra.threadId", id: "t" }])]),
      document: "finance-mail",
      readable: false,
      reason: {
        code: "detail-unknown",
        field: null,
        noun: null,
        person: false,
        cause: "filter-unusable",
      },
      direct: "This level's filter cannot be applied by this version of Omnesis",
    },
    {
      name: "the document does not exist",
      access: () => grant([]),
      document: "no-such-document",
      readable: false,
      reason: { code: "document-not-found" },
      direct: "This document no longer exists",
    },
  ];

  it.each(cases)("$name", ({ access, document, readable, reason, direct }) => {
    const decision = decide(access(), document);
    expect(decision).toEqual({ readable, reason });
    expect(accessReasonText(decision.reason, "direct")).toBe(direct);
  });
});

describe("what a grant shares besides its filters", () => {
  it("reads every account when the level shares all and has no filter", () => {
    for (const id of ["finance-mail", "team-day", "almanac-note", "wiki-page", "old-mail"]) {
      expect(decide(grant([]), id).readable).toBe(true);
    }
  });

  it("reads nothing the gateway writes itself once the level has any filter", () => {
    const filtered = grant([hide(LEDGER, [label("L-finance")])], {
      internalSourceIds: ["gateway-notes"],
    });
    expect(decide(filtered, "wiki-page")).toEqual({
      readable: false,
      reason: { code: "account-not-shared" },
    });
    expect(decide(filtered, "almanac-note").readable).toBe(true);
    expect(decide(grant([], { internalSourceIds: ["gateway-notes"] }), "wiki-page").readable).toBe(
      true,
    );
  });

  it("applies every filter of the account, and the first refusal decides", () => {
    const both = grant([
      shareOnly(LEDGER, [label("L-finance"), label("L-clients")]),
      hide(LEDGER, [folder("finance")]),
    ]);
    expect(decide(both, "clients-mail")).toEqual({
      readable: true,
      reason: { code: "readable", via: { noun: "label", label: "Clients" } },
    });
    expect(decide(both, "finance-mail").reason).toEqual({
      code: "hidden-by-item",
      item: { noun: "folder", label: "Finance" },
    });
  });

  it("names the permission asked about", () => {
    const off = decide(grant([], { capabilityGranted: false }), "finance-mail").reason;
    expect(accessReasonText(off, "answer")).toBe("Answer is not granted on this level");
  });

  it("agrees with a set read for every document under every grant here", () => {
    const grants = [
      grant([]),
      grant([], { capabilityGranted: false }),
      grant([], { permittedSourceIds: new Set([LEDGER]) }),
      grant([hide(LEDGER, [label("L-finance")]), hide(PARLEY, [person("Maya", ["phone", MAYA])])]),
      grant([
        shareOnly(LEDGER, [folder("finance"), person("Maya", ["email", "maya@example.org"])]),
      ]),
      grant([shareOnly(LEDGER, [directory(LAPTOP, "")])], { internalSourceIds: ["gateway-notes"] }),
    ];
    const ids = fixture.db
      .prepare<[], { id: string }>("SELECT id FROM documents ORDER BY id")
      .all()
      .map((row) => row.id);
    for (const access of grants) {
      const one = ids.filter((id) => decideDocumentAccess(fixture.db, access, id).readable);
      const inclusion = documentAccessInclusionSql(fixture.db, access, "d.id", "d.source_id", {
        row: "d",
      });
      const set = fixture.db
        .prepare<unknown[], { id: string }>(
          `SELECT d.id FROM documents d WHERE ${inclusion.sql} ORDER BY d.id`,
        )
        .all(...inclusion.params)
        .map((row) => row.id);
      expect(set).toEqual(one);
      expect([...filterReadableDocumentIds(fixture.db, access, ids)].sort()).toEqual(one);
    }
  });

  it("re-checks more ids than one statement takes", () => {
    for (let index = 0; index < 1200; index++) {
      entry(`bulk-${index}`, { labelIds: [index % 3 === 0 ? "L-finance" : "L-clients"] });
    }
    const ids = Array.from({ length: 1200 }, (_unused, index) => `bulk-${index}`);
    const readable = filterReadableDocumentIds(
      fixture.db,
      grant([hide(LEDGER, [label("L-finance")])]),
      [...ids, "missing"],
    );
    expect(readable.size).toBe(800);
    expect(readable.has("bulk-0")).toBe(false);
    expect(readable.has("bulk-1")).toBe(true);
  });
});

describe("wording", () => {
  it("counts the records too old for a filter, in the singular and the plural", () => {
    expect(tooOldCountText(1)).toBe(
      "1 older item could not be resynced and stays hidden from agents using this filter.",
    );
    expect(tooOldCountText(312)).toBe(
      "312 older items could not be resynced and stay hidden from agents using this filter.",
    );
    expect(tooOldCountText(0)).toBe(
      "0 older items could not be resynced and stay hidden from agents using this filter.",
    );
    expect(tooOldCountText(212000)).toMatch(/^212,000 older items/);
  });

  it("counts the records that cannot be placed, with the source's own noun", () => {
    expect(unmatchedCountText(1, { one: "folder", many: "folders" })).toBe(
      "1 record can't be matched to a folder and stays hidden.",
    );
    expect(unmatchedCountText(4, { one: "project folder", many: "project folders" })).toBe(
      "4 records can't be matched to a project folder and stay hidden.",
    );
    expect(unmatchedCountText(2, { one: "owner", many: "owners" })).toBe(
      "2 records can't be matched to an owner and stay hidden.",
    );
  });

  it("falls back to a plain sentence when the matching entry or the detail cannot be named", () => {
    expect(accessReasonText({ code: "hidden-by-item", item: null }, "direct")).toBe(
      "Hidden by this level's filter",
    );
    expect(
      accessReasonText(
        { code: "detail-unknown", field: null, noun: null, person: false, cause: "absent" },
        "direct",
      ),
    ).toBe("Its details are unknown");
    expect(
      accessReasonText(
        { code: "detail-unknown", field: null, noun: null, person: false, cause: "not-listed" },
        "answer",
      ),
    ).toBe("Where it belongs is not in this account's list");
  });

  it("carries the two notes of the page that says who can read a document", () => {
    expect(ACCESS_AUDIT_ANSWER_NOTE).toContain("privacy policy");
    expect(ACCESS_AUDIT_OWNER_NOTE).toBe(
      "This page is for you, the owner. It is never available to an external agent.",
    );
  });
});

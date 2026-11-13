// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The verdict of a source filter on a record, for every capability, both
 * kinds of filter and every state a record can be in.
 *
 * Each expectation is checked on every path a record can be read through:
 * the corpus check on a row, the corpus check by document id, the check
 * compiled for the copy in the search index, the single-document decision,
 * a set query, and the re-check of search results. They must all agree.
 *
 * All fixture data is invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalFilterIdentifier } from "@omnesis/core";
import { sourceTypeOf, type FilterRef, type SourceFilter } from "@omnesis/types";
import { decideDocumentAccess, filterReadableDocumentIds } from "./filter-decision.js";
import { filterFieldsFor } from "./filter-fields.js";
import {
  CORPUS_FILTER_TABLES,
  INDEX_FILTER_TABLES,
  compileSourceFilter,
  filterAllowSql,
  filterDetailSql,
  filterVerdictSql,
  forFewRecords,
  sourceFilterInclusionSql,
  type FilterVerdict,
} from "./filter-sql.js";
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
  syncFilterCopy,
  tag,
  type FilterFixture,
} from "./filter-test-utils.js";

const LEDGER = "ledger:northstar";
const PARLEY = "parley:studio";
const LAPTOP = "dev-laptop";
const DESKTOP = "dev-desktop";
const MAYA = "+15550100123";
const JAMIE = "+15550100456";

let fixture: FilterFixture;

const sender = (extra: Record<string, unknown>) => ({ role: "sender", ...extra });
const recipient = (extra: Record<string, unknown>) => ({ role: "recipient", ...extra });
const jamieMail = recipient({ identifiers: [{ kind: "email", value: "jamie@example.io" }] });

function entry(
  id: string,
  extra: Record<string, unknown> | null,
  options: { version?: number; streamId?: string; people?: unknown; raw?: string } = {},
): void {
  insertDocument(fixture.db, {
    id,
    sourceId: LEDGER,
    version: options.version ?? 3,
    streamId: options.streamId,
    metadata:
      options.raw ??
      ({
        documentType: "entry",
        ...(options.people === undefined ? {} : { people: options.people }),
        ...(extra === null ? {} : { extra }),
      } as Record<string, unknown>),
  });
}

function day(id: string, extra: Record<string, unknown>, people?: unknown): void {
  insertDocument(fixture.db, {
    id,
    sourceId: PARLEY,
    metadata: { documentType: "day", ...(people === undefined ? {} : { people }), extra },
  });
}

beforeEach(() => {
  fixture = openFilterFixture({ unreadableMetadata: true });
  const { db } = fixture;
  publishProfile(db, "ledger", 5, LEDGER_PROFILE);
  publishProfile(db, "parley", 1, PARLEY_PROFILE);

  publishList(db, { sourceId: LEDGER, field: "extra.labelIds" }, [
    { id: "L-finance", label: "Finance" },
    { id: "L-clients", label: "Clients" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.folderIds" }, [
    { id: "drive", label: "My drive" },
    { id: "finance", label: "Finance", parentId: "drive" },
    { id: "invoices", label: "Invoices", parentId: "finance" },
    { id: "invoices-2027", label: "2027", parentId: "invoices" },
    { id: "clients", label: "Clients", parentId: "drive" },
    { id: "empty", label: "Empty", parentId: "drive" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.directory", deviceId: LAPTOP }, [
    { id: "/home/maya/work", label: "~/work" },
    { id: "/home/maya/work/atlas-api", label: "~/work/atlas-api", parentId: "/home/maya/work" },
    { id: "/home/maya/workshop", label: "~/workshop" },
  ]);
  publishList(db, { sourceId: LEDGER, field: "extra.directory", deviceId: DESKTOP }, [
    { id: "/home/maya/work", label: "~/work" },
  ]);
  publishList(db, { sourceId: PARLEY, field: "extra.chatId" }, [
    {
      id: "c-team",
      label: "Studio team",
      members: [
        { type: "phone", value: "+1 (555) 010-0123" },
        { type: "phone", value: JAMIE },
      ],
    },
    { id: "c-solo", label: "Jamie Lopez", members: [{ type: "phone", value: JAMIE }] },
    {
      id: "c-unreadable",
      label: "Riverside group",
      members: [
        { type: "phone", value: JAMIE },
        { type: "phone", value: "member without a number" },
      ],
    },
  ]);

  // Labels: a list of ids from version 2.
  entry("m-finance", { labelIds: ["L-finance"] });
  entry("m-clients", { labelIds: ["L-clients", "L-other"] });
  entry("m-none", { labelIds: [] });
  entry("m-old-with", { labelIds: ["L-finance"] }, { version: 1 });
  entry("m-old", {}, { version: 0 });
  entry("m-absent", {});
  entry("m-no-extra", null);
  entry("m-wrong-type", { labelIds: "L-finance" });
  entry("m-not-text", { labelIds: ["L-finance", 7] });
  entry("m-empty-id", { labelIds: [""] });
  entry("m-not-json", null, { raw: "{not json" });
  entry("m-json-scalar", null, { raw: "42" });
  insertDocument(fixture.db, {
    id: "att-finance",
    sourceId: LEDGER,
    version: 3,
    externalId: "m-finance/att/1",
    metadata: { documentType: "attachment", extra: { parentExternalId: "m-finance" } },
  });
  insertDocument(fixture.db, {
    id: "att-clients-carrying-finance",
    sourceId: LEDGER,
    version: 3,
    externalId: "m-clients/att/1",
    // What the attachment itself carries is not what decides it.
    metadata: {
      documentType: "attachment",
      extra: { parentExternalId: "m-clients", labelIds: ["L-finance"] },
    },
  });
  insertDocument(fixture.db, {
    id: "att-orphan",
    sourceId: LEDGER,
    version: 3,
    metadata: { documentType: "attachment", extra: { parentExternalId: "gone" } },
  });
  insertDocument(fixture.db, {
    id: "att-no-parent-id",
    sourceId: LEDGER,
    version: 3,
    metadata: { documentType: "attachment", extra: { labelIds: ["L-clients"] } },
  });
  insertDocument(fixture.db, {
    id: "att-of-attachment",
    sourceId: LEDGER,
    version: 3,
    metadata: { documentType: "attachment", extra: { parentExternalId: "m-finance/att/1" } },
  });
  insertDocument(fixture.db, {
    id: "child-with-parent-key",
    sourceId: LEDGER,
    version: 3,
    // Not typed as an attachment, but it names a parent: decided through it.
    metadata: {
      documentType: "entry",
      extra: { parentExternalId: "m-none", labelIds: ["L-finance"] },
    },
  });
  insertDocument(fixture.db, {
    id: "att-of-old",
    sourceId: LEDGER,
    version: 3,
    metadata: { documentType: "attachment", extra: { parentExternalId: "m-old" } },
  });

  // Folders: a tree from version 3.
  entry("f-invoices", { folderIds: ["invoices"] });
  entry("f-deep", { folderIds: ["invoices-2027"] });
  entry("f-clients", { folderIds: ["clients"] });
  entry("f-nowhere", { folderIds: [] });
  entry("f-unlisted", { folderIds: ["vanished"] });
  entry("f-two", { folderIds: ["clients", "invoices"] });
  entry("f-one-unlisted", { folderIds: ["clients", "vanished"] });
  entry("f-version-2", { folderIds: ["clients"] }, { version: 2 });

  // A directory and tags that belong to a device.
  entry(
    "d-atlas",
    { directory: "/home/maya/work/atlas-api", tagIds: ["red"] },
    { streamId: LAPTOP },
  );
  entry("d-workshop", { directory: "/home/maya/workshop", tagIds: [] }, { streamId: LAPTOP });
  entry("d-desktop-work", { directory: "/home/maya/work", tagIds: ["red"] }, { streamId: DESKTOP });
  entry("d-no-device", { directory: "/home/maya/work", tagIds: ["red"] });
  entry("d-no-directory", {}, { streamId: LAPTOP });
  entry("d-empty-directory", { directory: "" }, { streamId: LAPTOP });
  entry("d-unlisted", { directory: "/home/maya/elsewhere" }, { streamId: LAPTOP });
  entry("d-other-device-path", { directory: "/home/maya/workshop" }, { streamId: DESKTOP });

  // People on the record.
  entry(
    "p-new-form",
    {},
    {
      people: [sender({ identifiers: [{ kind: "email", value: "maya@example.org" }] }), jamieMail],
    },
  );
  entry("p-old-form", {}, { people: [sender({ emails: ["Maya@Example.ORG"] }), jamieMail] });
  entry("p-old-phone", {}, { people: [sender({ phones: ["+1 (555) 010-0123"] }), jamieMail] });
  entry(
    "p-recipient",
    {},
    {
      people: [
        sender({ emails: ["jamie@example.io"] }),
        recipient({ emails: ["maya@example.org"] }),
      ],
    },
  );
  entry(
    "p-mentioned",
    {},
    {
      people: [
        sender({ emails: ["jamie@example.io"] }),
        { role: "mentioned", emails: ["maya@example.org"] },
      ],
    },
  );
  entry("p-jamie-only", {}, { people: [sender({ emails: ["jamie@example.io"] })] });
  entry("p-name-only", {}, { people: [sender({ name: "Maya Reeves" }), jamieMail] });
  entry("p-platform-id-only", {}, { people: [sender({ lids: ["parley:998877"] }), jamieMail] });
  entry("p-self-without-id", {}, { people: [sender({ isSelf: true }), jamieMail] });
  entry("p-only-self-without-id", {}, { people: [sender({ isSelf: true })] });
  entry("p-garbled", {}, { people: [sender({ emails: ["jamie@example.io", "not an address"] })] });
  entry(
    "p-at-cap",
    {},
    {
      people: [1, 2, 3, 4, 5].map((n) => recipient({ emails: [`guest${n}@example.io`] })),
    },
  );
  entry(
    "p-under-cap",
    {},
    {
      people: [1, 2, 3, 4].map((n) => recipient({ emails: [`guest${n}@example.io`] })),
    },
  );
  entry("p-not-a-list", {}, { people: "maya@example.org" });
  entry("p-list-as-text", {}, { people: '[{"role":"sender","emails":["jamie@example.io"]}]' });
  entry("p-missing", {});
  entry("p-empty", {}, { people: [] });
  entry("p-entry-not-object", {}, { people: ["maya@example.org"] });
  entry("p-emails-not-list", {}, { people: [sender({ emails: 7 })] });
  entry(
    "p-googlemail",
    {},
    { people: [sender({ emails: ["Fictional.Maya+news@googlemail.com"] })] },
  );
  entry("p-domain", {}, { people: [sender({ emails: ["billing@northstar-labs.example"] })] });
  entry("p-unicode-domain", {}, { people: [sender({ emails: ["maya@bücher.example"] })] });

  // A chat source: people also come from the chat's members.
  day("w-team-jamie-speaks", { chatId: "c-team" }, [{ role: "participant", phones: [JAMIE] }]);
  day("w-team-nobody-speaks", { chatId: "c-team" }, []);
  day("w-solo", { chatId: "c-solo" }, [{ role: "participant", phones: [JAMIE] }]);
  day("w-unlisted-chat", { chatId: "c-gone" }, [{ role: "participant", phones: [JAMIE] }]);
  day("w-no-chat", {}, [{ role: "participant", phones: [JAMIE] }]);
  day("w-platform-id", { chatId: "c-solo" }, [{ role: "participant", lids: ["parley:5544"] }]);
  day("w-unreadable-member", { chatId: "c-unreadable" }, [
    { role: "participant", phones: [JAMIE] },
  ]);
  day("w-no-people", { chatId: "c-solo" });

  syncFilterCopy(fixture);
});

afterEach(() => fixture.close());

function compile(filter: SourceFilter) {
  return compileSourceFilter(filter, filterFieldsFor(fixture.db, sourceTypeOf(filter.sourceId)));
}

function one<T>(db: FilterFixture["db"], sql: string, params: unknown[]): T | undefined {
  return db.prepare<unknown[], { value: T }>(sql).get(...params)?.value;
}

/** The verdict of `filter` on a document, on every path, all of which must agree. */
function verdict(filter: SourceFilter, documentId: string): FilterVerdict {
  const compiled = compile(filter);
  const grant = { capabilityGranted: true, permittedSourceIds: null, filters: [filter] };

  const row = filterVerdictSql(compiled, { row: "d" });
  const corpusRow = one<FilterVerdict>(
    fixture.db,
    `SELECT (${row.sql}) AS value FROM documents d WHERE d.id = ?`,
    [...row.params, documentId],
  );
  const byId = filterVerdictSql(compiled, { id: "t.document_id" });
  const corpusId = one<FilterVerdict>(
    fixture.db,
    `SELECT (${byId.sql}) AS value FROM (SELECT ? AS document_id) t`,
    [...byId.params, documentId],
  );
  const copy = filterVerdictSql(compiled, { id: "t.document_id" }, INDEX_FILTER_TABLES);
  const index = one<FilterVerdict>(
    fixture.indexDb,
    `SELECT (${copy.sql}) AS value FROM (SELECT ? AS document_id) t`,
    [...copy.params, documentId],
  );
  const detail = filterDetailSql(compiled, { row: "d" });
  const detailed = one<string>(
    fixture.db,
    `SELECT (${detail.sql}) AS value FROM documents d WHERE d.id = ?`,
    [...detail.params, documentId],
  );
  // The shape compiled for a statement that checks a few records.
  const few = filterVerdictSql(forFewRecords(compiled), { row: "d" });
  const fewRecords = one<FilterVerdict>(
    fixture.db,
    `SELECT (${few.sql}) AS value FROM documents d WHERE d.id = ?`,
    [...few.params, documentId],
  );
  const fewCopy = filterVerdictSql(
    forFewRecords(compiled),
    { id: "t.document_id" },
    INDEX_FILTER_TABLES,
  );
  const fewIndex = one<FilterVerdict>(
    fixture.indexDb,
    `SELECT (${fewCopy.sql}) AS value FROM (SELECT ? AS document_id) t`,
    [...fewCopy.params, documentId],
  );
  expect({ corpusId, index, fewRecords, fewIndex, detailed: detailed?.slice(0, 1) }).toEqual({
    corpusId: corpusRow,
    index: corpusRow,
    fewRecords: corpusRow,
    fewIndex: corpusRow,
    detailed: corpusRow,
  });

  const readable = corpusRow === "R";
  const allow = filterAllowSql(compiled, { row: "d" });
  expect(
    fixture.db
      .prepare(`SELECT 1 FROM documents d WHERE d.id = ? AND ${allow.sql}`)
      .get(documentId, ...allow.params) !== undefined,
  ).toBe(readable);
  const inclusion = sourceFilterInclusionSql([compiled], "d.id", "d.source_id", { row: "d" });
  const included = fixture.db
    .prepare<unknown[], { id: string }>(
      `SELECT d.id FROM documents d WHERE d.source_id = ? AND ${inclusion.sql}`,
    )
    .all(filter.sourceId, ...inclusion.params)
    .map((found) => found.id);
  expect(included.includes(documentId)).toBe(readable);
  const indexInclusion = sourceFilterInclusionSql([compiled], "c.document_id", "c.source_id", {
    map: INDEX_FILTER_TABLES,
  });
  expect(
    fixture.indexDb
      .prepare(
        `SELECT 1 FROM index_filter_documents c WHERE c.document_id = ? AND ${indexInclusion.sql}`,
      )
      .get(documentId, ...indexInclusion.params) !== undefined,
  ).toBe(readable);
  expect(decideDocumentAccess(fixture.db, grant, documentId).readable).toBe(readable);
  expect(filterReadableDocumentIds(fixture.db, grant, [documentId, "no-such-id"])).toEqual(
    new Set(readable ? [documentId] : []),
  );
  return corpusRow!;
}

function expectVerdicts(
  match: FilterRef[],
  sourceId: string,
  expected: Record<string, [shareOnly: FilterVerdict, hide: FilterVerdict]>,
): void {
  const got: Record<string, [FilterVerdict, FilterVerdict]> = {};
  for (const documentId of Object.keys(expected)) {
    got[documentId] = [
      verdict(shareOnly(sourceId, match), documentId),
      verdict(hide(sourceId, match), documentId),
    ];
  }
  expect(got).toEqual(expected);
}

describe("membership: a record's ids against the saved ids", () => {
  it("applies the filter to a record that carries the detail at a new enough version", () => {
    expectVerdicts([label("L-finance")], LEDGER, {
      "m-finance": ["R", "H"],
      "m-clients": ["N", "R"],
      // No label at all is known: it has none of the saved ones.
      "m-none": ["N", "R"],
    });
  });

  it("matches a record when any of its ids is saved", () => {
    expectVerdicts([label("L-other"), label("L-unused")], LEDGER, {
      "m-clients": ["R", "H"],
      "m-finance": ["N", "R"],
    });
  });

  it("hides a record too old to carry the detail, whatever the filter says", () => {
    expectVerdicts([label("L-finance")], LEDGER, {
      "m-old": ["O", "O"],
      // Even one that happens to hold a value at that path.
      "m-old-with": ["O", "O"],
    });
  });

  it("hides a record whose detail is absent or malformed, whatever the filter says", () => {
    expectVerdicts([label("L-finance")], LEDGER, {
      "m-absent": ["U", "U"],
      "m-no-extra": ["U", "U"],
      "m-wrong-type": ["U", "U"],
      "m-not-text": ["U", "U"],
      "m-empty-id": ["U", "U"],
      "m-not-json": ["U", "U"],
      "m-json-scalar": ["U", "U"],
    });
  });

  it("does not need the id to be in the account's list", () => {
    expectVerdicts([label("L-other")], LEDGER, { "m-clients": ["R", "H"] });
  });

  it("checks only the details the filter uses", () => {
    // These records have no folder or people detail at all.
    expectVerdicts([label("L-clients")], LEDGER, {
      "m-clients": ["R", "H"],
      "f-clients": ["U", "U"],
    });
    expectVerdicts([folder("clients")], LEDGER, {
      "f-clients": ["R", "H"],
      "m-clients": ["U", "U"],
    });
  });

  it("with no saved entry, a share-only filter shares nothing and a hide filter hides nothing", () => {
    expectVerdicts([], LEDGER, {
      "m-finance": ["N", "R"],
      "m-old": ["N", "R"],
      // Metadata that cannot be read is never readable through a filter.
      "m-not-json": ["U", "U"],
      "m-json-scalar": ["U", "U"],
      // Still decided through its parent.
      "att-orphan": ["U", "U"],
    });
  });
});

describe("an attachment is decided through the record it was attached to", () => {
  it("follows its parent, not what it carries itself", () => {
    expectVerdicts([label("L-finance")], LEDGER, {
      "att-finance": ["R", "H"],
      "att-clients-carrying-finance": ["N", "R"],
      "child-with-parent-key": ["N", "R"],
      "att-of-old": ["O", "O"],
    });
  });

  it("is unknown when the parent is missing, unnamed, or itself an attachment", () => {
    expectVerdicts([label("L-finance")], LEDGER, {
      "att-orphan": ["U", "U"],
      "att-no-parent-id": ["U", "U"],
      "att-of-attachment": ["U", "U"],
    });
  });

  it("is unknown when the parent's id is not text, even if a record has that id", () => {
    entry("77", { labelIds: ["L-clients"] });
    insertDocument(fixture.db, {
      id: "att-numeric-parent",
      sourceId: LEDGER,
      version: 3,
      metadata: { documentType: "attachment", extra: { parentExternalId: 77 } },
    });
    syncFilterCopy(fixture);
    expectVerdicts([label("L-finance")], LEDGER, { "att-numeric-parent": ["U", "U"] });
  });

  it("is not found through a record of another stream", () => {
    insertDocument(fixture.db, {
      id: "att-other-stream",
      sourceId: LEDGER,
      version: 3,
      streamId: LAPTOP,
      metadata: { documentType: "attachment", extra: { parentExternalId: "m-finance" } },
    });
    syncFilterCopy(fixture);
    expectVerdicts([label("L-finance")], LEDGER, { "att-other-stream": ["U", "U"] });
  });
});

describe("tree: a record's container against the saved nodes and everything inside them", () => {
  it("covers the saved folder and the folders inside it, at any depth", () => {
    expectVerdicts([folder("finance")], LEDGER, {
      "f-invoices": ["R", "H"],
      "f-deep": ["R", "H"],
      "f-clients": ["N", "R"],
      "f-two": ["R", "H"],
      // Filed nowhere is known: it is in no saved folder.
      "f-nowhere": ["N", "R"],
    });
  });

  it("does not cover the folders above or beside the saved one", () => {
    expectVerdicts([folder("invoices-2027")], LEDGER, {
      "f-deep": ["R", "H"],
      "f-invoices": ["N", "R"],
    });
  });

  it("covers everything from a root", () => {
    expectVerdicts([folder("drive")], LEDGER, {
      "f-invoices": ["R", "H"],
      "f-clients": ["R", "H"],
    });
  });

  it("hides a record in a folder the list does not hold, even under a filter naming another", () => {
    expectVerdicts([folder("clients")], LEDGER, {
      "f-unlisted": ["U", "U"],
      "f-one-unlisted": ["U", "U"],
    });
  });

  it("hides a record below the field's minimum version", () => {
    expectVerdicts([folder("clients")], LEDGER, { "f-version-2": ["O", "O"] });
  });

  it("treats a saved folder the list no longer holds as matching nothing listed", () => {
    expectVerdicts([folder("vanished")], LEDGER, {
      "f-clients": ["N", "R"],
      "f-unlisted": ["U", "U"],
    });
  });

  it("follows a folder that is moved in the list without any record changing", () => {
    expectVerdicts([folder("finance")], LEDGER, { "f-clients": ["N", "R"] });
    publishList(fixture.db, { sourceId: LEDGER, field: "extra.folderIds" }, [
      { id: "drive", label: "My drive" },
      { id: "finance", label: "Finance", parentId: "drive" },
      { id: "invoices", label: "Invoices", parentId: "finance" },
      { id: "invoices-2027", label: "2027", parentId: "invoices" },
      { id: "clients", label: "Clients", parentId: "finance" },
    ]);
    syncFilterCopy(fixture);
    expectVerdicts([folder("finance")], LEDGER, { "f-clients": ["R", "H"] });
  });

  it("ends on a list whose parents loop", () => {
    publishList(fixture.db, { sourceId: LEDGER, field: "extra.folderIds" }, [
      { id: "finance", label: "Finance", parentId: "invoices" },
      { id: "invoices", label: "Invoices", parentId: "finance" },
      { id: "clients", label: "Clients" },
    ]);
    syncFilterCopy(fixture);
    expectVerdicts([folder("finance")], LEDGER, {
      "f-invoices": ["R", "H"],
      "f-clients": ["N", "R"],
    });
  });

  it("hides every record of a field whose list was never published", () => {
    fixture.db.prepare("DELETE FROM source_filter_lists WHERE field = 'extra.folderIds'").run();
    syncFilterCopy(fixture);
    expectVerdicts([folder("finance")], LEDGER, {
      "f-invoices": ["U", "U"],
      "f-nowhere": ["N", "R"],
    });
  });
});

describe("a field whose ids belong to a device", () => {
  it("is matched as device and id together", () => {
    expectVerdicts([directory(LAPTOP, "/home/maya/work")], LEDGER, {
      "d-atlas": ["R", "H"],
      "d-workshop": ["N", "R"],
      // The same path on another device is another folder.
      "d-desktop-work": ["N", "R"],
    });
    expectVerdicts([directory(DESKTOP, "/home/maya/work")], LEDGER, {
      "d-desktop-work": ["R", "H"],
      "d-atlas": ["N", "R"],
    });
  });

  it("does not let a folder cover one whose path merely starts the same", () => {
    expectVerdicts([directory(LAPTOP, "/home/maya/work")], LEDGER, {
      "d-workshop": ["N", "R"],
    });
  });

  it("covers a whole device when the entry names only the device", () => {
    expectVerdicts([directory(LAPTOP, "")], LEDGER, {
      "d-atlas": ["R", "H"],
      "d-workshop": ["R", "H"],
      "d-desktop-work": ["N", "R"],
      // Still unknown: selecting the device does not excuse a missing detail.
      "d-no-directory": ["U", "U"],
      "d-unlisted": ["U", "U"],
    });
  });

  it("hides a record that does not say which device it came from, or where it sits", () => {
    expectVerdicts([directory(LAPTOP, "/home/maya/work")], LEDGER, {
      "d-no-device": ["U", "U"],
      "d-no-directory": ["U", "U"],
      "d-empty-directory": ["U", "U"],
      "d-unlisted": ["U", "U"],
      // Listed on the laptop, not on the device this record came from.
      "d-other-device-path": ["U", "U"],
    });
  });

  it("applies to a membership field as well", () => {
    expectVerdicts([tag(LAPTOP, "red")], LEDGER, {
      "d-atlas": ["R", "H"],
      "d-desktop-work": ["N", "R"],
      "d-workshop": ["N", "R"],
      "d-no-device": ["U", "U"],
    });
    expectVerdicts([tag(DESKTOP, "red"), tag(LAPTOP, "blue")], LEDGER, {
      "d-desktop-work": ["R", "H"],
      "d-atlas": ["N", "R"],
    });
  });

  it("makes the whole account unknown when an entry names no device", () => {
    expectVerdicts(
      [{ capability: "tree", field: "extra.directory", id: "/home/maya/work" }],
      LEDGER,
      { "d-atlas": ["U", "U"], "d-workshop": ["U", "U"], "m-finance": ["U", "U"] },
    );
  });
});

describe("person: the people of the record in the declared roles", () => {
  const maya = person("Maya Reeves", ["email", "maya@example.org"], ["phone", MAYA]);

  it("matches both stored forms of a person's identifiers", () => {
    expectVerdicts([maya], LEDGER, {
      "p-new-form": ["R", "H"],
      // The older per-kind arrays, in the spelling the source wrote.
      "p-old-form": ["R", "H"],
      "p-old-phone": ["R", "H"],
      "p-recipient": ["R", "H"],
      "p-jamie-only": ["N", "R"],
    });
  });

  it("does not count a mention in the text as involvement", () => {
    expectVerdicts([maya], LEDGER, { "p-mentioned": ["N", "R"] });
  });

  it("hides a record that involves someone who cannot be identified", () => {
    expectVerdicts([maya], LEDGER, {
      "p-name-only": ["U", "U"],
      "p-platform-id-only": ["U", "U"],
      "p-garbled": ["U", "U"],
      "p-entry-not-object": ["U", "U"],
      "p-emails-not-list": ["U", "U"],
    });
  });

  it("passes over the account's owner when they carry no identifier", () => {
    expectVerdicts([maya], LEDGER, {
      "p-self-without-id": ["N", "R"],
      // But a record must name someone.
      "p-only-self-without-id": ["U", "U"],
    });
  });

  it("hides a record whose people are missing, empty or not a list", () => {
    expectVerdicts([maya], LEDGER, {
      "p-missing": ["U", "U"],
      "p-empty": ["U", "U"],
      "p-not-a-list": ["U", "U"],
      "p-list-as-text": ["U", "U"],
      "m-not-json": ["U", "U"],
    });
  });

  it("hides a record whose list of people is as long as the source's cap", () => {
    const guest = person("Guest", ["email", "guest1@example.io"]);
    expectVerdicts([guest], LEDGER, {
      "p-at-cap": ["U", "U"],
      "p-under-cap": ["R", "H"],
    });
  });

  it("reads one mailbox under its provider's two names, with dots and a tag", () => {
    expectVerdicts([person("Maya", ["email", "fictionalmaya@gmail.com"])], LEDGER, {
      "p-googlemail": ["R", "H"],
      "p-new-form": ["N", "R"],
    });
  });

  it("matches a whole mail domain exactly, never a suffix", () => {
    expectVerdicts([person("Northstar Labs", ["domain", "northstar-labs.example"])], LEDGER, {
      "p-domain": ["R", "H"],
      "p-new-form": ["N", "R"],
    });
    expectVerdicts([person("Labs", ["domain", "labs.example"])], LEDGER, {
      "p-domain": ["N", "R"],
    });
    expectVerdicts([person("Books", ["domain", "xn--bcher-kva.example"])], LEDGER, {
      "p-unicode-domain": ["R", "H"],
    });
  });

  it("is decided for an attachment through its parent's people", () => {
    insertDocument(fixture.db, {
      id: "att-of-maya",
      sourceId: LEDGER,
      version: 3,
      metadata: {
        documentType: "attachment",
        people: [sender({ emails: ["jamie@example.io"] })],
        extra: { parentExternalId: "p-new-form" },
      },
    });
    syncFilterCopy(fixture);
    expectVerdicts([maya], LEDGER, { "att-of-maya": ["R", "H"] });
  });

  it("applies the person filter's own minimum version like a field's", () => {
    const profile = structuredClone(LEDGER_PROFILE) as unknown as {
      personFilter: { minVersion: number };
    };
    profile.personFilter.minVersion = 2;
    publishProfile(fixture.db, "ledger", 6, profile as never);
    entry(
      "p-version-1",
      {},
      {
        version: 1,
        people: [sender({ emails: ["maya@example.org"] })],
      },
    );
    entry(
      "p-version-2",
      {},
      {
        version: 2,
        people: [sender({ emails: ["maya@example.org"] })],
      },
    );
    syncFilterCopy(fixture);
    expectVerdicts([maya], LEDGER, {
      // Its people are there, but a record this old may be missing some.
      "p-version-1": ["O", "O"],
      "p-version-2": ["R", "H"],
      "p-new-form": ["R", "H"],
    });
    // A filter that does not use people is not held to their minimum.
    expectVerdicts([tag(LAPTOP, "red")], LEDGER, { "d-atlas": ["R", "H"] });
  });

  it("matches a mailbox typed with dots and a tag against the stored form", () => {
    entry("p-stored-gmail", {}, { people: [sender({ emails: ["fictionalmaya@gmail.com"] })] });
    syncFilterCopy(fixture);
    const typed = canonicalFilterIdentifier("email", "Fictional.Maya+news@gmail.com")!;
    expectVerdicts([person("Maya", [typed.type as "email", typed.value])], LEDGER, {
      "p-stored-gmail": ["R", "H"],
      "p-googlemail": ["R", "H"],
    });
  });

  it("makes the account unknown when an entry names an identifier kind the source lacks", () => {
    expectVerdicts([person("Maya", ["email", "maya@example.org"])], PARLEY, {
      "w-solo": ["U", "U"],
    });
  });
});

describe("person, for a source whose chats list their members", () => {
  const maya = person("Maya Reeves", ["phone", MAYA]);

  it("counts the members of the record's chat, including one who said nothing", () => {
    expectVerdicts([maya], PARLEY, {
      "w-team-jamie-speaks": ["R", "H"],
      "w-team-nobody-speaks": ["R", "H"],
      "w-solo": ["N", "R"],
    });
  });

  it("matches the people of the record itself too", () => {
    expectVerdicts([person("Jamie Lopez", ["phone", JAMIE])], PARLEY, {
      "w-solo": ["R", "H"],
      "w-team-jamie-speaks": ["R", "H"],
    });
  });

  it("hides a record whose chat is unknown, unlisted or has a member that cannot be read", () => {
    expectVerdicts([maya], PARLEY, {
      "w-no-chat": ["U", "U"],
      "w-unlisted-chat": ["U", "U"],
      "w-unreadable-member": ["U", "U"],
      "w-platform-id": ["U", "U"],
      "w-no-people": ["U", "U"],
    });
  });

  it("filters by chat without needing the chat to be listed", () => {
    expectVerdicts([chat("c-team")], PARLEY, {
      "w-team-jamie-speaks": ["R", "H"],
      "w-solo": ["N", "R"],
      "w-unlisted-chat": ["N", "R"],
      "w-no-chat": ["U", "U"],
    });
    expectVerdicts([chat("c-gone")], PARLEY, { "w-unlisted-chat": ["R", "H"] });
  });

  it("matches an entry of either kind when a filter mixes them", () => {
    expectVerdicts([chat("c-solo"), maya], PARLEY, {
      "w-solo": ["R", "H"],
      "w-team-nobody-speaks": ["R", "H"],
      "w-unlisted-chat": ["U", "U"],
    });
  });
});

describe("a filter this gateway cannot apply hides the whole account", () => {
  const cases: Array<[string, SourceFilter]> = [
    [
      "a field the source does not declare",
      shareOnly(LEDGER, [{ capability: "membership", field: "extra.threadId", id: "t1" }]),
    ],
    [
      "the wrong capability for a field",
      hide(LEDGER, [{ capability: "tree", field: "extra.labelIds", id: "L-finance" }]),
    ],
    [
      "a device on a field shared by every device",
      hide(LEDGER, [
        { capability: "membership", field: "extra.labelIds", id: "L-finance", device: LAPTOP },
      ]),
    ],
    [
      "an unknown capability",
      hide(LEDGER, [{ capability: "date-range", field: "extra.labelIds", id: "x" } as never]),
    ],
    ["an empty id", hide(LEDGER, [label("")])],
    ["a person entry without identifiers", hide(LEDGER, [person("Nobody")])],
    [
      "share-only that also shares the rest",
      { ...shareOnly(LEDGER, [label("L-finance")]), otherwise: "share" },
    ],
    ["hide that also hides the rest", { ...hide(LEDGER, [label("L-finance")]), otherwise: "hide" }],
    [
      "two rules",
      {
        ...hide(LEDGER, []),
        rules: [
          { match: [], action: "hide" },
          { match: [], action: "hide" },
        ] as never,
      },
    ],
    ["no rule", { ...hide(LEDGER, []), rules: [] as never }],
    [
      "an unknown action",
      { ...hide(LEDGER, []), rules: [{ match: [], action: "redact" }] as never },
    ],
    [
      "entries that are not a list",
      { ...hide(LEDGER, []), rules: [{ match: "all", action: "hide" }] as never },
    ],
    ["an entry that is not an object", hide(LEDGER, [null as never])],
  ];
  it.each(cases)("%s", (_what, filter) => {
    expect(compile(filter).unusable).not.toBeNull();
    for (const documentId of ["m-finance", "m-none", "m-old", "att-finance", "p-new-form"]) {
      expect(verdict(filter, documentId)).toBe("U");
    }
  });

  it("when the source's profile is gone or carries no version", () => {
    const filter = hide(LEDGER, [label("L-clients")]);
    expect(verdict(filter, "m-finance")).toBe("R");
    fixture.db.prepare("UPDATE source_document_profiles SET output_revision = 0").run();
    syncFilterCopy(fixture);
    expect(verdict(filter, "m-finance")).toBe("U");
    fixture.db.prepare("DELETE FROM source_document_profiles").run();
    syncFilterCopy(fixture);
    expect(verdict(filter, "m-finance")).toBe("U");
  });

  it("when the field's declaration is one this gateway cannot read", () => {
    const profile = structuredClone(LEDGER_PROFILE) as unknown as {
      metadataFields: Array<{ filter: { capability: string } }>;
    };
    profile.metadataFields[0]!.filter.capability = "date-range";
    publishProfile(fixture.db, "ledger", 6, profile as never);
    syncFilterCopy(fixture);
    expect(verdict(hide(LEDGER, [label("L-clients")]), "m-finance")).toBe("U");
  });
});

describe("the check for several accounts at once", () => {
  it("passes a record of an account that has no filter and checks the others", () => {
    const filters = [
      compile(hide(LEDGER, [label("L-finance")])),
      compile(shareOnly(PARLEY, [chat("c-solo")])),
    ];
    insertDocument(fixture.db, { id: "other-1", sourceId: "almanac:home", metadata: {} });
    const inclusion = sourceFilterInclusionSql(filters, "d.id", "d.source_id", { row: "d" });
    const ids = fixture.db
      .prepare<unknown[], { id: string }>(
        `SELECT d.id FROM documents d WHERE d.id IN ('other-1','m-finance','m-clients','w-solo','w-team-jamie-speaks') AND ${inclusion.sql} ORDER BY d.id`,
      )
      .all(...inclusion.params)
      .map((row) => row.id);
    expect(ids).toEqual(["m-clients", "other-1", "w-solo"]);
  });

  it("is a constant when there is no filter", () => {
    expect(sourceFilterInclusionSql([], "d.id", "d.source_id")).toEqual({ sql: "1", params: [] });
  });

  it("refuses a column or alias that is not a plain identifier, or one it uses itself", () => {
    const compiled = compile(hide(LEDGER, [label("L-finance")]));
    expect(() =>
      sourceFilterInclusionSql([compiled], "d.id; DROP TABLE documents", "d.source_id"),
    ).toThrow();
    expect(() => sourceFilterInclusionSql([compiled], "id", "d.source_id")).toThrow();
    expect(() => sourceFilterInclusionSql([compiled], "fs.id", "fs.source_id")).toThrow();
    expect(() => filterVerdictSql(compiled, { row: "d) OR (1" })).toThrow();
    expect(() => filterVerdictSql(compiled, { row: "fv" })).toThrow();
  });
});

describe("hostile and oversized input", () => {
  const hostile = [
    "'; DROP TABLE documents; --",
    '" OR "1"="1',
    "\\\"]}',",
    "$.extra.labelIds",
    "%_*?[]",
    "línea\nnueva\ttab\u0000nul",
    "標籤-🎯-ярлык",
    "x".repeat(512),
    '{"capability":"person"}',
    "0",
  ];

  it("compares an id made of quotes, SQL, JSON or path characters as plain text", () => {
    hostile.forEach((id, index) => {
      entry(`h-${index}`, { labelIds: [id], folderIds: [id] });
    });
    publishList(
      fixture.db,
      { sourceId: LEDGER, field: "extra.folderIds" },
      hostile.map((id) => ({ id, label: id })),
    );
    syncFilterCopy(fixture);
    hostile.forEach((id, index) => {
      expectVerdicts([label(id)], LEDGER, {
        [`h-${index}`]: ["R", "H"],
        [`h-${(index + 1) % hostile.length}`]: ["N", "R"],
      });
      expectVerdicts([folder(id)], LEDGER, {
        [`h-${index}`]: ["R", "H"],
        [`h-${(index + 1) % hostile.length}`]: ["N", "R"],
      });
    });
    expect(
      fixture.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM documents").get()!.n,
    ).toBeGreaterThan(hostile.length);
  });

  it("treats a person identifier made of such characters as matching nobody", () => {
    for (const value of hostile) {
      expect(verdict(hide(LEDGER, [person(value, ["email", value])]), "p-new-form")).toBe("R");
    }
  });

  it("reads a field whose declared path cannot be written as one as an unusable filter", () => {
    const profile = structuredClone(LEDGER_PROFILE) as unknown as {
      metadataFields: Array<{ path: string }>;
    };
    profile.metadataFields[0]!.path = 'extra."labelIds';
    publishProfile(fixture.db, "ledger", 6, profile as never);
    syncFilterCopy(fixture);
    const filter = hide(LEDGER, [{ capability: "membership", field: 'extra."labelIds', id: "x" }]);
    expect(compile(filter).unusable).toMatch(/not a readable path/);
    expect(verdict(filter, "m-finance")).toBe("U");
  });

  it("applies a filter holding the most entries one can hold", () => {
    const many = Array.from({ length: 255 }, (_unused, index) => label(`L-unused-${index}`));
    expectVerdicts([...many, label("L-finance")], LEDGER, {
      "m-finance": ["R", "H"],
      "m-clients": ["N", "R"],
      "m-old": ["O", "O"],
    });
    const identifiers = Array.from({ length: 255 }, (_unused, index): ["email", string] => [
      "email",
      `guest-${index}@example.io`,
    ]);
    expectVerdicts([person("Everyone", ...identifiers, ["email", "maya@example.org"])], LEDGER, {
      "p-new-form": ["R", "H"],
      "p-domain": ["N", "R"],
    });
  });

  it("does not raise on metadata that is not JSON anywhere in a scanned account", () => {
    for (let index = 0; index < 5; index++) {
      entry(`broken-${index}`, null, { raw: ["", "{", "[1,2", "nul\u0000l", '{"extra":'][index] });
    }
    syncFilterCopy(fixture);
    const filters = [
      hide(LEDGER, [label("L-finance")]),
      shareOnly(LEDGER, [folder("finance")]),
      hide(LEDGER, [person("Maya", ["email", "maya@example.org"])]),
      hide(LEDGER, [directory(LAPTOP, "/home/maya/work")]),
    ];
    for (const filter of filters) {
      const allow = filterAllowSql(compile(filter), { row: "d" });
      const readable = fixture.db
        .prepare<unknown[], { id: string }>(
          `SELECT d.id FROM documents d WHERE d.source_id = ? AND ${allow.sql}`,
        )
        .all(LEDGER, ...allow.params)
        .map((row) => row.id);
      expect(readable.some((id) => id.startsWith("broken-"))).toBe(false);
      for (let index = 0; index < 5; index++) {
        expect(verdict(filter, `broken-${index}`)).toBe("U");
      }
    }
  });
});

describe("the index copy on its own", () => {
  it("hides a document it holds no row for, and one written under another declaration", () => {
    const filter = hide(LEDGER, [label("L-clients")]);
    const compiled = compile(filter);
    const copy = filterVerdictSql(compiled, { id: "t.document_id" }, INDEX_FILTER_TABLES);
    const read = (documentId: string) =>
      one<FilterVerdict>(
        fixture.indexDb,
        `SELECT (${copy.sql}) AS value FROM (SELECT ? AS document_id) t`,
        [...copy.params, documentId],
      );
    expect(read("m-finance")).toBe("R");
    fixture.indexDb
      .prepare(
        "UPDATE index_filter_documents SET declaration = 'older' WHERE document_id = 'm-finance'",
      )
      .run();
    expect(read("m-finance")).toBe("U");
    fixture.indexDb
      .prepare("DELETE FROM index_filter_documents WHERE document_id = 'm-finance'")
      .run();
    expect(read("m-finance")).toBe("U");
    // The attachment's parent is the row just removed.
    expect(read("att-finance")).toBe("U");
  });

  it("hides a row that claims to belong to another account", () => {
    const compiled = compile(hide(LEDGER, [label("L-clients")]));
    const copy = filterVerdictSql(compiled, { id: "t.document_id" }, INDEX_FILTER_TABLES);
    fixture.indexDb
      .prepare(
        "UPDATE index_filter_documents SET source_id = 'ledger:other' WHERE document_id = 'm-finance'",
      )
      .run();
    expect(
      one<FilterVerdict>(
        fixture.indexDb,
        `SELECT (${copy.sql}) AS value FROM (SELECT ? AS document_id) t`,
        [...copy.params, "m-finance"],
      ),
    ).toBe("U");
  });
});

describe("the plan of the compiled check", () => {
  function plan(db: FilterFixture["db"], sql: string, params: unknown[]): string[] {
    return db
      .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail);
  }

  it("expands the saved tree set once for the statement, never per record", () => {
    const compiled = compile(hide(LEDGER, [folder("finance")]));
    const allow = filterAllowSql(compiled, { row: "d" });
    const steps = plan(
      fixture.db,
      `SELECT count(*) FROM documents d WHERE d.source_id = ? AND ${allow.sql}`,
      [LEDGER, ...allow.params],
    );
    if (process.env.OMNESIS_PRINT_FILTER_PLAN) process.stdout.write(`${steps.join("\n")}\n`);
    const recursive = steps.filter((step) => /RECURSIVE|sel\b/.test(step));
    expect(recursive.length).toBeGreaterThan(0);
    // The set is a list subquery that depends on nothing in the outer row.
    expect(steps.some((step) => step.startsWith("LIST SUBQUERY"))).toBe(true);
    expect(steps.filter((step) => step.startsWith("CORRELATED LIST SUBQUERY"))).toEqual([]);
    // Each step down the tree seeks the children of a node by the parent index.
    const descents = steps.filter((step) => step.includes("idx_source_filter_items_parent"));
    expect(descents.length).toBeGreaterThan(0);
    for (const descent of descents) {
      expect(descent).toBe(
        "SEARCH fi USING COVERING INDEX idx_source_filter_items_parent (source_id=? AND field=? AND device_id=? AND generation=? AND parent_id=?)",
      );
    }
    expect(steps.some((step) => /SCAN (fi|source_filter_items)/.test(step))).toBe(false);
  });

  it("evaluates the saved set once however many records are scanned", () => {
    let calls = 0;
    fixture.db.function("count_filter_set_rows", (value: unknown) => {
      calls++;
      return value as string;
    });
    for (let index = 0; index < 200; index++) entry(`bulk-${index}`, { folderIds: ["clients"] });
    const compiled = compile(hide(LEDGER, [folder("finance")]));
    const allow = filterAllowSql(compiled, { row: "d" });
    // Wrap the seed of the recursive set so every evaluation of it is counted.
    const counted = allow.sql.replace(
      /json_extract\(fj\.value, '\$\[1\]'\)/g,
      "count_filter_set_rows(json_extract(fj.value, '$[1]'))",
    );
    expect(counted).not.toBe(allow.sql);
    fixture.db
      .prepare(`SELECT count(*) FROM documents d WHERE d.source_id = ? AND ${counted}`)
      .get(LEDGER, ...allow.params);
    // One saved id, read once for the record branch and once for the
    // attachment branch of the statement.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("decides a single document without scanning the documents table", () => {
    for (const filter of [
      hide(LEDGER, [folder("finance"), label("L-finance")]),
      shareOnly(LEDGER, [person("Maya", ["email", "maya@example.org"])]),
      hide(LEDGER, [directory(LAPTOP, "/home/maya/work")]),
      hide(PARLEY, [person("Maya", ["phone", MAYA])]),
    ]) {
      const detail = filterDetailSql(compile(filter), { row: "d" });
      const steps = plan(fixture.db, `SELECT (${detail.sql}) FROM documents d WHERE d.id = ?`, [
        ...detail.params,
        "m-finance",
      ]);
      expect(steps.filter((step) => /^SCAN (d|fs|documents)\b/.test(step))).toEqual([]);
      expect(
        steps.some((step) => /^SEARCH d USING INDEX sqlite_autoindex_documents_1/.test(step)),
      ).toBe(true);
      // The parent of an attachment is one seek on the documents' unique key.
      expect(
        steps.some((step) => /^SEARCH fs USING INDEX sqlite_autoindex_documents_2/.test(step)),
      ).toBe(true);
    }
  });

  it("reads a chat's members once for a statement, or by the record's chat for a few records", () => {
    const compiled = compile(hide(PARLEY, [person("Maya", ["phone", MAYA])]));
    const read = (shape: typeof compiled): string[] => {
      const verdict = filterVerdictSql(shape, { row: "d" });
      return plan(fixture.db, `SELECT (${verdict.sql}) FROM documents d WHERE d.id = ?`, [
        ...verdict.params,
        "w-solo",
      ]).filter((step) => /\bfm\b/.test(step));
    };
    const perStatement = read(compiled);
    expect(perStatement.length).toBeGreaterThan(0);
    expect(perStatement.every((step) => step.includes("(source_id=? AND field=?)"))).toBe(true);
    const perRecord = read(forFewRecords(compiled));
    expect(perRecord.length).toBeGreaterThan(0);
    for (const step of perRecord) {
      expect(step).toBe(
        "SEARCH fm USING PRIMARY KEY (source_id=? AND field=? AND device_id=? AND generation=? AND item_id=?)",
      );
    }
  });

  it("looks a document up by id through the primary key of each store", () => {
    const compiled = compile(hide(LEDGER, [label("L-finance")]));
    const corpus = filterVerdictSql(compiled, { id: "t.document_id" });
    expect(
      plan(fixture.db, `SELECT (${corpus.sql}) FROM (SELECT ? AS document_id) t`, [
        ...corpus.params,
        "m-finance",
      ]).filter((step) => /^SCAN (fx|fs|documents)\b/.test(step)),
    ).toEqual([]);
    const copy = filterVerdictSql(compiled, { id: "t.document_id" }, INDEX_FILTER_TABLES);
    expect(
      plan(fixture.indexDb, `SELECT (${copy.sql}) FROM (SELECT ? AS document_id) t`, [
        ...copy.params,
        "m-finance",
      ]).filter((step) => /^SCAN (fx|fs|index_filter_documents)\b/.test(step)),
    ).toEqual([]);
  });

  it("emits the same text for the corpus and the index copy apart from the table names", () => {
    const compiled = compile(hide(LEDGER, [folder("finance")]));
    const corpus = filterVerdictSql(
      compiled,
      { id: "t.document_id" },
      {
        ...CORPUS_FILTER_TABLES,
        subject: "subject-id",
        declaration: "declaration",
      },
    );
    const copy = filterVerdictSql(compiled, { id: "t.document_id" }, INDEX_FILTER_TABLES);
    let renamed = copy.sql;
    for (const key of ["documents", "lists", "items", "itemsByParent", "members"] as const) {
      renamed = renamed.replaceAll(INDEX_FILTER_TABLES[key], CORPUS_FILTER_TABLES[key]);
    }
    renamed = renamed.replaceAll("document_id", "id").replaceAll(".details", ".metadata");
    expect(renamed).toBe(corpus.sql.replaceAll("document_id", "id"));
    expect(copy.params).toEqual(corpus.params);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The filter rows stay what the records say, whatever writes the records.
 *
 * Every test ends by checking the rows against rows cut again from nothing:
 * the rows of every record are removed, every record is cut again, and the
 * two sets, and the running counts kept from them, must be equal.
 *
 * All fixture data is invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderId, SourceId, sourceTypeOf, type DocumentInput } from "@omnesis/types";
import {
  deleteAllBySource,
  deleteDocuments,
  upsertDocuments,
} from "../data/repositories/DocumentRepository.js";
import { filterFieldsFor } from "./filter-fields.js";
import {
  LEDGER_PROFILE,
  PARLEY_PROFILE,
  insertDocument,
  openFilterFixture,
  publishProfile,
  type FilterFixture,
} from "./filter-test-utils.js";
import {
  FILTER_VALUE_PEOPLE,
  advanceFilterValuePasses,
  applyFilterValueWork,
  createDocumentFilterValueTables,
  filterValueDeclaration,
  filterValuesReady,
  readFilterValueWork,
  settleFilterValues,
} from "./filter-values.js";
import type { Db } from "../data/types.js";

const LEDGER = "ledger:northstar";
const PARLEY = "parley:studio";
const MAYA = "+15550100123";

let fixture: FilterFixture;
let db: Db;

beforeEach(() => {
  fixture = openFilterFixture();
  db = fixture.db;
  publishProfile(db, "ledger", 3, LEDGER_PROFILE);
  publishProfile(db, "parley", 1, PARLEY_PROFILE);
});

afterEach(() => fixture.close());

function entry(
  sourceId: string,
  externalId: string,
  metadata: Record<string, unknown>,
): DocumentInput {
  return {
    providerId: ProviderId(sourceId),
    sourceId: SourceId(sourceId),
    externalId,
    title: `Entry ${externalId}`,
    content: `Quarterly budget review ${externalId}`,
    contentHash: `hash:${externalId}:${JSON.stringify(metadata)}`,
    metadata: metadata as DocumentInput["metadata"],
    sourceCreatedAt: "2027-02-01T08:00:00.000Z",
    sourceUpdatedAt: "2027-02-01T08:00:00.000Z",
  };
}

function mail(externalId: string, extra: Record<string, unknown>, sender = "maya@example.org") {
  return entry(LEDGER, externalId, {
    documentType: "entry",
    extra,
    people: [
      { role: "sender", name: "Sender", emails: [sender] },
      { role: "recipient", name: "Recipient", emails: ["jamie@example.com"] },
    ],
  });
}

function attachment(externalId: string, parentExternalId: string) {
  return entry(LEDGER, externalId, {
    documentType: "attachment",
    extra: { parentExternalId, originalFilename: "agenda.pdf" },
  });
}

function write(documents: DocumentInput[], version: number, streamId = ""): void {
  const sourceId = documents[0]!.sourceId;
  upsertDocuments(db, documents, {
    sourceVersions: { [sourceId]: version },
    streams: { [sourceId]: streamId },
  });
}

function idOf(externalId: string): string {
  return db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId)!.id;
}

function queued(): string[] {
  return db
    .prepare<[], { document_id: string }>(
      "SELECT document_id FROM document_filter_value_queue ORDER BY document_id",
    )
    .all()
    .map((row) => row.document_id);
}

/** Every row, named by its account, field and device rather than its slot. */
function rows(): string[] {
  return db
    .prepare<[], { line: string }>(
      `SELECT json_array(s.source_id, s.field, s.device_id, v.value, v.document_id, v.source_version, v.known) AS line
         FROM document_filter_values v JOIN document_filter_slots s ON s.slot = v.slot
        ORDER BY line`,
    )
    .all()
    .map((row) => row.line);
}

function rowsOf(externalId: string): Array<[field: string, value: string]> {
  return db
    .prepare<[string], { field: string; value: string }>(
      `SELECT s.field, v.value FROM document_filter_values v JOIN document_filter_slots s ON s.slot = v.slot
        WHERE v.document_id = ? ORDER BY s.field, v.value`,
    )
    .all(idOf(externalId))
    .map((row) => [row.field, row.value]);
}

function ready(sourceId: string): boolean {
  return filterValuesReady(
    db,
    sourceId,
    filterValueDeclaration(filterFieldsFor(db, sourceTypeOf(sourceId))),
  );
}

/** The rows and counts equal rows cut again from nothing. */
function expectConsistent(): void {
  const counts = db
    .prepare<[], { line: string }>(
      `SELECT json_array(slot, value, source_version, known, records) AS line
         FROM document_filter_value_counts ORDER BY line`,
    )
    .all()
    .map((row) => row.line);
  const aggregated = db
    .prepare<[], { line: string }>(
      `SELECT json_array(slot, value, source_version, known, count(*)) AS line
         FROM document_filter_values GROUP BY slot, value, source_version, known ORDER BY line`,
    )
    .all()
    .map((row) => row.line);
  expect(counts).toEqual(aggregated);
  const before = rows();
  db.exec(`DELETE FROM document_filter_values;
           DELETE FROM document_filter_value_sources;
           DELETE FROM document_filter_value_queue;`);
  settleFilterValues(db);
  expect(rows()).toEqual(before);
}

describe("a sync page", () => {
  it("writes the rows of what it stores in the same transaction", () => {
    write([mail("m-1", { labelIds: ["l-1", "l-2"], folderIds: ["f-1"] }), mail("m-2", {})], 3);

    expect(queued()).toEqual([]);
    // An address is stored under its domain, so a domain is a range of rows.
    expect(rowsOf("m-1")).toEqual([
      // Two labels: a count over several labels must not count it twice.
      ["[many]extra.labelIds", ""],
      ["[people]", "email:example.com\u001fjamie@example.com"],
      ["[people]", "email:example.org\u001fmaya@example.org"],
      ["[record]", "S"],
      ["extra.folderIds", "f-1"],
      ["extra.labelIds", "l-1"],
      ["extra.labelIds", "l-2"],
    ]);
    expectConsistent();
  });

  it("makes a new account readable from its rows without a pass", () => {
    write([mail("m-1", { labelIds: ["l-1"] }), mail("m-2", {})], 3);
    expect(ready(LEDGER)).toBe(true);
    expect(advanceFilterValuePasses(db)).toEqual({ queued: 0, changed: false });
  });

  it("leaves an account holding records it did not cut to the pass", () => {
    insertDocument(db, { id: "old-1", sourceId: LEDGER, version: 3, metadata: { extra: {} } });
    db.exec("DELETE FROM document_filter_value_queue");
    write([mail("m-1", { labelIds: ["l-1"] })], 3);
    expect(ready(LEDGER)).toBe(false);
    settleFilterValues(db);
    expect(ready(LEDGER)).toBe(true);
    expect(rowsOf("old-1")).toEqual([["[record]", "S"]]);
    expectConsistent();
  });

  it("rewrites the rows when the details change, and only the version when they do not", () => {
    write([mail("m-1", { labelIds: ["l-1"] })], 2);
    write([mail("m-1", { labelIds: ["l-3"] }, "sarah@example.net")], 3);
    expect(queued()).toEqual([]);
    expect(rowsOf("m-1")).toContainEqual(["extra.labelIds", "l-3"]);
    expect(rowsOf("m-1")).not.toContainEqual(["extra.labelIds", "l-1"]);
    expect(rowsOf("m-1")).toContainEqual([
      FILTER_VALUE_PEOPLE,
      "email:example.net\u001fsarah@example.net",
    ]);

    // The same record re-read by a newer host: only its version moves.
    write([mail("m-1", { labelIds: ["l-3"] }, "sarah@example.net")], 4);
    expect(queued()).toEqual([]);
    expect(
      db
        .prepare<[string], { v: number }>(
          "SELECT DISTINCT source_version AS v FROM document_filter_values WHERE document_id = ?",
        )
        .all(idOf("m-1")),
    ).toEqual([{ v: 4 }]);
    expectConsistent();
  });

  it("keeps a device's rows under the stream it was read from", () => {
    write([mail("m-1", { directory: "~/work", tagIds: ["t-1"] })], 3, "dev-a");
    write([mail("m-1", { directory: "~/work" })], 3, "");
    expect(
      db
        .prepare<[], { field: string; device_id: string; value: string }>(
          `SELECT s.field, s.device_id, v.value FROM document_filter_values v
             JOIN document_filter_slots s ON s.slot = v.slot
            WHERE s.field IN ('extra.directory', 'extra.tagIds') ORDER BY s.field, v.value`,
        )
        .all(),
    ).toEqual([
      { field: "extra.directory", device_id: "dev-a", value: "" },
      { field: "extra.directory", device_id: "dev-a", value: "~/work" },
      { field: "extra.tagIds", device_id: "dev-a", value: "" },
      { field: "extra.tagIds", device_id: "dev-a", value: "t-1" },
    ]);
    expectConsistent();
  });
});

describe("attachments", () => {
  it("take the rows of the record they were attached to, whichever arrives first", () => {
    write([attachment("a-1", "m-1")], 3);
    expect(rowsOf("a-1")).toEqual([
      ["[parent]", "m-1"],
      ["[record]", "U"],
    ]);

    write([mail("m-1", { labelIds: ["l-1"] })], 3);
    expect(queued()).toEqual([]);
    expect(rowsOf("a-1")).toContainEqual(["[record]", "D"]);
    expect(rowsOf("a-1")).toContainEqual(["extra.labelIds", "l-1"]);

    write([mail("m-1", { labelIds: ["l-2"] })], 3);
    expect(rowsOf("a-1")).toContainEqual(["extra.labelIds", "l-2"]);
    expect(rowsOf("a-1")).not.toContainEqual(["extra.labelIds", "l-1"]);
    expectConsistent();
  });

  it("become undecidable when their record is deleted", () => {
    write([mail("m-1", { labelIds: ["l-1"] }), attachment("a-1", "m-1")], 3);
    expect(rowsOf("a-1")).toContainEqual(["[record]", "D"]);

    deleteDocuments(db, LEDGER, LEDGER, ["m-1"]);
    expect(queued()).toEqual([idOf("a-1")]);
    expect(ready(LEDGER)).toBe(false);
    settleFilterValues(db);
    expect(rowsOf("a-1")).toEqual([
      ["[parent]", "m-1"],
      ["[record]", "U"],
    ]);
    expectConsistent();
  });
});

describe("deletion and resync", () => {
  it("drops the rows of a deleted record", () => {
    write([mail("m-1", { labelIds: ["l-1"] }), mail("m-2", { labelIds: ["l-1"] })], 3);
    const gone = idOf("m-1");
    deleteDocuments(db, LEDGER, LEDGER, ["m-1"]);
    expect(
      db
        .prepare<[string], { n: number }>(
          "SELECT count(*) AS n FROM document_filter_values WHERE document_id = ?",
        )
        .get(gone)!.n,
    ).toBe(0);
    expectConsistent();
  });

  it("follows a resync in place and a resync from scratch", () => {
    write([mail("m-1", {}), mail("m-2", { labelIds: ["l-1"] }), attachment("a-1", "m-2")], 1);
    settleFilterValues(db);
    expect(ready(LEDGER)).toBe(true);

    // In place: every record read again by a newer host, some changed.
    write(
      [
        mail("m-1", { labelIds: ["l-4"], folderIds: ["f-2"] }),
        mail("m-2", { labelIds: ["l-1"] }),
        attachment("a-1", "m-2"),
      ],
      3,
    );
    expect(queued()).toEqual([]);
    expect(ready(LEDGER)).toBe(true);
    expectConsistent();

    // From scratch: everything goes, and comes back.
    deleteAllBySource(db, LEDGER);
    expect(rows().filter((row) => row.includes(LEDGER))).toEqual([]);
    write([attachment("a-1", "m-2"), mail("m-2", { labelIds: ["l-9"] })], 3);
    expect(queued()).toEqual([]);
    expectConsistent();
  });

  it("forgets an account that holds no records any more", () => {
    write([mail("m-1", { labelIds: ["l-1"] })], 3);
    settleFilterValues(db);
    deleteAllBySource(db, LEDGER);
    settleFilterValues(db);
    expect(
      db
        .prepare<[string], { n: number }>(
          `SELECT (SELECT count(*) FROM document_filter_value_sources WHERE source_id = ?)
                + (SELECT count(*) FROM document_filter_slots WHERE source_id = ?) AS n`,
        )
        .get(LEDGER, LEDGER)!.n,
    ).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM document_filter_value_counts").get()).toEqual({
      n: 0,
    });
  });
});

describe("writes outside a sync page", () => {
  it("are queued, keep the account from being read, and are cut by the drain", () => {
    write([mail("m-1", { labelIds: ["l-1"] }), mail("m-2", {})], 3);
    settleFilterValues(db);
    expect(ready(LEDGER)).toBe(true);

    db.prepare(
      "UPDATE documents SET metadata = json_set(metadata, '$.extra.labelIds', json('[\"l-7\"]')) WHERE id = ?",
    ).run(idOf("m-2"));
    db.prepare("UPDATE documents SET stream_id = 'dev-b' WHERE id = ?").run(idOf("m-1"));
    expect(queued()).toEqual([idOf("m-1"), idOf("m-2")].sort());
    // A record that changed stream leaves its rows at once.
    expect(rowsOf("m-1")).toEqual([]);
    expect(ready(LEDGER)).toBe(false);

    settleFilterValues(db);
    expect(ready(LEDGER)).toBe(true);
    expect(rowsOf("m-2")).toContainEqual(["extra.labelIds", "l-7"]);
    expectConsistent();
  });

  it("are not overwritten by rows cut from an older read", () => {
    write([mail("m-1", { labelIds: ["l-1"] })], 3);
    db.prepare("UPDATE documents SET source_version = 3 WHERE id = ?").run(idOf("m-1"));
    db.prepare(
      "UPDATE documents SET metadata = json_set(metadata, '$.extra.labelIds', json('[\"l-2\"]')) WHERE id = ?",
    ).run(idOf("m-1"));
    const stale = readFilterValueWork(db, 10);
    // The record changes again, through a sync page, after the read.
    write([mail("m-1", { labelIds: ["l-3"] })], 3);
    expect(applyFilterValueWork(db, stale).applied).toBe(0);
    expect(rowsOf("m-1")).toContainEqual(["extra.labelIds", "l-3"]);
    expectConsistent();
  });
});

describe("declarations", () => {
  it("cuts every record again when a source's declaration changes", () => {
    write([mail("m-1", { labelIds: ["l-1"], folderIds: ["f-1"] })], 3);
    settleFilterValues(db);
    expect(ready(LEDGER)).toBe(true);
    // A record cut under the declaration that is about to be replaced.
    db.prepare(
      "UPDATE documents SET metadata = json_set(metadata, '$.extra.folderIds', json('[\"f-2\"]')) WHERE id = ?",
    ).run(idOf("m-1"));
    const work = readFilterValueWork(db, 10);
    expect(work).toHaveLength(1);

    const fewer = {
      ...(LEDGER_PROFILE as unknown as Record<string, unknown>),
      metadataFields: (
        LEDGER_PROFILE as unknown as { metadataFields: Array<{ path: string }> }
      ).metadataFields.filter((field) => field.path !== "extra.folderIds"),
    };
    publishProfile(db, "ledger", 4, fewer as unknown as typeof LEDGER_PROFILE);
    expect(ready(LEDGER)).toBe(false);
    // Rows cut under the declaration before are not applied.
    expect(applyFilterValueWork(db, work).applied).toBe(0);
    expect(rowsOf("m-1")).toContainEqual(["extra.folderIds", "f-1"]);
    advanceFilterValuePasses(db);
    settleFilterValues(db);
    expect(ready(LEDGER)).toBe(true);
    expect(rowsOf("m-1").map(([field]) => field)).not.toContain("extra.folderIds");
    expectConsistent();
  });
});

describe("an upgrade", () => {
  it("cuts the rows of the records already stored in the background, not in the migration", () => {
    for (const trigger of db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'document_filter_value%'",
      )
      .all()) {
      db.exec(`DROP TRIGGER "${trigger.name}"`);
    }
    for (const table of [
      "document_filter_values",
      "document_filter_value_counts",
      "document_filter_value_sources",
      "document_filter_value_queue",
      "document_filter_slots",
    ]) {
      db.exec(`DROP TABLE ${table}`);
    }
    // Chat records stored before any row existed: their people filter works
    // from the chat's members at once, so their rows must exist after upgrade.
    for (let index = 0; index < 5; index++) {
      insertDocument(db, {
        id: `p-${index}`,
        sourceId: PARLEY,
        version: 1,
        metadata: {
          documentType: "day",
          extra: { chatId: `c-${index % 2}` },
          people: [{ role: "participant", name: "Sender", phones: [MAYA] }],
        },
      });
    }

    createDocumentFilterValueTables(db);
    expect(db.prepare("SELECT count(*) AS n FROM document_filter_values").get()).toEqual({ n: 0 });
    expect(queued()).toEqual([]);
    expect(ready(PARLEY)).toBe(false);

    settleFilterValues(db);
    expect(ready(PARLEY)).toBe(true);
    expect(rowsOf("p-3")).toEqual([
      ["[people]", `phone:${MAYA}`],
      ["[record]", "S"],
      ["extra.chatId", "c-1"],
    ]);
    expectConsistent();
  });
});

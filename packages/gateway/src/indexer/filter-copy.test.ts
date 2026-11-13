// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The copy of what filters read, kept in the search index database: what a
 * row holds, how it follows a version-only change, a changed declaration and
 * a republished list, and that a stale copy hides rather than shows.
 *
 * All fixture data is invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filterFieldsFor } from "../access/filter-fields.js";
import {
  INDEX_FILTER_TABLES,
  compileSourceFilter,
  filterVerdictSql,
} from "../access/filter-sql.js";
import {
  LEDGER_PROFILE,
  folder,
  hide,
  insertDocument,
  label,
  openFilterFixture,
  person,
  publishList,
  publishProfile,
  type FilterFixture,
} from "../access/filter-test-utils.js";
import {
  FILTER_COPY_DELETE_BATCH,
  FILTER_COPY_MISSING_SUBJECT,
  FILTER_COPY_TABLES,
  buildFilterCopyBatch,
  completeFilterIndexQueue,
  createFilterCopyTables,
  deleteFilterCopyDocuments,
  deleteFilterCopySource,
  drainFilterIndexQueue,
  readFilterIndexQueue,
  refreshFilterCopyDeclarations,
  refreshFilterListCopy,
  writeFilterCopyBatch,
} from "./filter-copy.js";
import type { SourceFilter } from "@omnesis/types";

const LEDGER = "ledger:northstar";
let fixture: FilterFixture;

function entry(id: string, extra: Record<string, unknown>, version = 3, people?: unknown): void {
  insertDocument(fixture.db, {
    id,
    sourceId: LEDGER,
    version,
    metadata: {
      documentType: "entry",
      title: "Quarterly budget review",
      ...(people === undefined ? {} : { people }),
      extra: { threadId: "thread-1", ...extra },
    },
  });
}

function copyRow(id: string) {
  return fixture.indexDb
    .prepare<[string], Record<string, unknown>>(
      "SELECT * FROM index_filter_documents WHERE document_id = ?",
    )
    .get(id);
}

function indexVerdict(filter: SourceFilter, documentId: string): string {
  const compiled = compileSourceFilter(filter, filterFieldsFor(fixture.db, "ledger"));
  const sql = filterVerdictSql(compiled, { id: "t.document_id" }, INDEX_FILTER_TABLES);
  return fixture.indexDb
    .prepare<unknown[], { verdict: string }>(
      `SELECT (${sql.sql}) AS verdict FROM (SELECT ? AS document_id) t`,
    )
    .get(...sql.params, documentId)!.verdict;
}

function copyAll(): void {
  const ids = fixture.db
    .prepare<[], { id: string }>("SELECT id FROM documents")
    .all()
    .map((row) => row.id);
  writeFilterCopyBatch(fixture.indexDb, buildFilterCopyBatch(fixture.db, ids));
}

beforeEach(() => {
  fixture = openFilterFixture();
  publishProfile(fixture.db, "ledger", 5, LEDGER_PROFILE);
  publishList(fixture.db, { sourceId: LEDGER, field: "extra.folderIds" }, [
    { id: "finance", label: "Finance" },
    { id: "invoices", label: "Invoices", parentId: "finance" },
  ]);
});

afterEach(() => fixture.close());

describe("a copy row", () => {
  it("holds the declared fields and the people, and nothing else of the record", () => {
    entry(
      "m1",
      { labelIds: ["L-finance"], folderIds: ["invoices"], directory: "/home/maya/work" },
      3,
      [
        { role: "sender", name: "Maya Reeves", emails: ["maya@example.org"], isSelf: false },
        "not a mention",
      ],
    );
    copyAll();
    const row = copyRow("m1")!;
    expect(row).toMatchObject({
      document_id: "m1",
      source_id: LEDGER,
      stream_id: "",
      source_version: 3,
      subject_document_id: "",
    });
    expect(JSON.parse(row.details as string)).toEqual({
      people: [{ role: "sender", emails: ["maya@example.org"], isSelf: false }, "not a mention"],
      extra: { labelIds: ["L-finance"], folderIds: ["invoices"], directory: "/home/maya/work" },
    });
    expect(row.details).not.toContain("Maya Reeves");
    expect(row.details).not.toContain("Quarterly");
    expect(row.details).not.toContain("thread-1");
  });

  it("keeps the difference between a detail that is empty and one that is absent", () => {
    entry("none", { labelIds: [] });
    entry("absent", {});
    copyAll();
    expect(JSON.parse(copyRow("none")!.details as string)).toEqual({ extra: { labelIds: [] } });
    expect(JSON.parse(copyRow("absent")!.details as string)).toEqual({});
    expect(indexVerdict(hide(LEDGER, [label("L-finance")]), "none")).toBe("R");
    expect(indexVerdict(hide(LEDGER, [label("L-finance")]), "absent")).toBe("U");
  });

  it("copies a detail of the wrong type as it is, so the check judges it", () => {
    entry("wrong", { labelIds: "L-finance" }, 3, "nobody");
    copyAll();
    expect(JSON.parse(copyRow("wrong")!.details as string)).toEqual({
      extra: { labelIds: "L-finance" },
    });
    expect(indexVerdict(hide(LEDGER, [label("L-clients")]), "wrong")).toBe("U");
  });

  it("names the record an attachment is decided through, or that it is missing", () => {
    entry("parent", { labelIds: ["L-finance"] });
    insertDocument(fixture.db, {
      id: "child",
      sourceId: LEDGER,
      version: 3,
      metadata: { documentType: "attachment", extra: { parentExternalId: "parent" } },
    });
    insertDocument(fixture.db, {
      id: "orphan",
      sourceId: LEDGER,
      version: 3,
      metadata: { documentType: "attachment", extra: { parentExternalId: "gone" } },
    });
    insertDocument(fixture.db, {
      id: "unnamed",
      sourceId: LEDGER,
      version: 3,
      metadata: { documentType: "attachment" },
    });
    copyAll();
    expect(copyRow("child")!.subject_document_id).toBe("parent");
    expect(copyRow("orphan")!.subject_document_id).toBe(FILTER_COPY_MISSING_SUBJECT);
    expect(copyRow("unnamed")!.subject_document_id).toBe(FILTER_COPY_MISSING_SUBJECT);
    const filter = hide(LEDGER, [label("L-finance")]);
    expect(indexVerdict(filter, "child")).toBe("H");
    expect(indexVerdict(filter, "orphan")).toBe("U");
    expect(indexVerdict(filter, "unnamed")).toBe("U");
  });

  it("is not kept for a source that declares nothing a filter reads, or a document that is gone", () => {
    insertDocument(fixture.db, { id: "note", sourceId: "almanac:home", metadata: { extra: {} } });
    const batch = buildFilterCopyBatch(fixture.db, ["note", "never-existed"]);
    expect(batch).toEqual({ rows: [], absent: ["note", "never-existed"] });
    // A row left from an earlier declaration is removed by the same batch.
    fixture.indexDb
      .prepare(
        "INSERT INTO index_filter_documents VALUES ('note', 'almanac:home', '', 0, '', 'older', '{}')",
      )
      .run();
    writeFilterCopyBatch(fixture.indexDb, batch);
    expect(copyRow("note")).toBeUndefined();
  });

  it("is replaced when the document is copied again", () => {
    entry("m1", { labelIds: ["L-finance"] });
    copyAll();
    fixture.db
      .prepare("UPDATE documents SET metadata = ?, source_version = 4 WHERE id = 'm1'")
      .run(JSON.stringify({ documentType: "entry", extra: { labelIds: ["L-clients"] } }));
    copyAll();
    expect(copyRow("m1")).toMatchObject({ source_version: 4 });
    expect(indexVerdict(hide(LEDGER, [label("L-finance")]), "m1")).toBe("R");
  });
});

describe("a version that rises with nothing else changed", () => {
  it("reaches the copy through the queue, a batch at a time", () => {
    for (let index = 0; index < 5; index++) entry(`m${index}`, { labelIds: ["L-finance"] }, 1);
    copyAll();
    const filter = hide(LEDGER, [label("L-clients")]);
    expect(indexVerdict(filter, "m0")).toBe("O");

    fixture.db.prepare("UPDATE documents SET source_version = 3").run();
    fixture.db
      .prepare("INSERT INTO document_filter_index_queue (document_id) SELECT id FROM documents")
      .run();
    expect(readFilterIndexQueue(fixture.db, 2)).toEqual(["m0", "m1"]);
    const deps = { corpusDb: fixture.db, indexDb: fixture.indexDb, limit: 2 };
    expect(drainFilterIndexQueue(deps)).toBe(2);
    expect(indexVerdict(filter, "m0")).toBe("R");
    expect(indexVerdict(filter, "m4")).toBe("O");
    expect(drainFilterIndexQueue(deps)).toBe(2);
    expect(drainFilterIndexQueue(deps)).toBe(1);
    expect(drainFilterIndexQueue(deps)).toBe(0);
    expect(indexVerdict(filter, "m4")).toBe("R");
  });

  it("forgets a queue entry only after its row is stored", () => {
    entry("m0", { labelIds: [] }, 3);
    fixture.db.prepare("INSERT INTO document_filter_index_queue VALUES ('m0')").run();
    const forgotten: string[][] = [];
    drainFilterIndexQueue({
      corpusDb: fixture.db,
      indexDb: fixture.indexDb,
      corpusWrite: (ids) => {
        // The row is already there when the corpus is asked to forget the entry.
        expect(copyRow("m0")).toBeDefined();
        forgotten.push([...ids]);
      },
    });
    expect(forgotten).toEqual([["m0"]]);
    // Nothing was forgotten, so the entry is offered again.
    expect(readFilterIndexQueue(fixture.db, 10)).toEqual(["m0"]);
    completeFilterIndexQueue(fixture.db, ["m0"]);
    expect(readFilterIndexQueue(fixture.db, 10)).toEqual([]);
  });

  it("drops the row of a queued document that was deleted meanwhile", () => {
    entry("m0", { labelIds: [] });
    copyAll();
    fixture.db.pragma("foreign_keys = OFF");
    fixture.db.prepare("INSERT INTO document_filter_index_queue VALUES ('m0')").run();
    fixture.db.prepare("DELETE FROM documents WHERE id = 'm0'").run();
    drainFilterIndexQueue({ corpusDb: fixture.db, indexDb: fixture.indexDb });
    expect(copyRow("m0")).toBeUndefined();
  });
});

describe("a declaration that changes", () => {
  it("hides the rows written under the old one until they are rewritten", () => {
    for (let index = 0; index < 5; index++)
      entry(`m${index}`, { labelIds: ["L-finance"], region: "north" });
    const deps = { corpusDb: fixture.db, indexDb: fixture.indexDb, limit: 2 };
    // A source new to the copy is written in bounded passes.
    expect(refreshFilterCopyDeclarations(deps)).toBe(2);
    expect(copyRow("m1")).toBeDefined();
    expect(copyRow("m2")).toBeUndefined();
    expect(refreshFilterCopyDeclarations(deps)).toBe(2);
    expect(refreshFilterCopyDeclarations(deps)).toBe(1);
    expect(refreshFilterCopyDeclarations(deps)).toBe(0);
    const filter = hide(LEDGER, [label("L-clients")]);
    expect(indexVerdict(filter, "m4")).toBe("R");

    // The source starts declaring another field.
    const profile = structuredClone(LEDGER_PROFILE) as unknown as { metadataFields: unknown[] };
    profile.metadataFields.push({
      path: "extra.region",
      type: "string",
      description: "Region.",
      filter: {
        capability: "membership",
        minVersion: 0,
        scope: "global",
        noun: { one: "region", many: "regions" },
        picker: "search",
      },
    });
    publishProfile(fixture.db, "ledger", 6, profile as never);
    expect(indexVerdict(filter, "m0")).toBe("U");
    expect(refreshFilterCopyDeclarations(deps)).toBe(2);
    expect(indexVerdict(filter, "m0")).toBe("R");
    expect(indexVerdict(filter, "m4")).toBe("U");
    while (refreshFilterCopyDeclarations(deps) > 0);
    expect(indexVerdict(filter, "m4")).toBe("R");
    expect(JSON.parse(copyRow("m4")!.details as string).extra.region).toBe("north");
  });

  it("starts over when the declaration changes again part way through", () => {
    for (let index = 0; index < 4; index++) entry(`m${index}`, { labelIds: [] });
    const deps = { corpusDb: fixture.db, indexDb: fixture.indexDb, limit: 3 };
    expect(refreshFilterCopyDeclarations(deps)).toBe(3);
    const profile = structuredClone(LEDGER_PROFILE) as unknown as { personFilter?: unknown };
    delete profile.personFilter;
    publishProfile(fixture.db, "ledger", 6, profile as never);
    while (refreshFilterCopyDeclarations(deps) > 0);
    const declarations = fixture.indexDb
      .prepare<[], { declaration: string }>(
        "SELECT DISTINCT declaration FROM index_filter_documents",
      )
      .all();
    expect(declarations).toHaveLength(1);
    expect(indexVerdict(hide(LEDGER, [label("L-x")]), "m0")).toBe("R");
  });

  it("removes the rows of a source that no longer declares anything", () => {
    entry("m0", { labelIds: [] });
    const deps = { corpusDb: fixture.db, indexDb: fixture.indexDb };
    while (refreshFilterCopyDeclarations(deps) > 0);
    expect(copyRow("m0")).toBeDefined();
    publishProfile(fixture.db, "ledger", 6, { documentTypes: ["entry"] } as never);
    while (refreshFilterCopyDeclarations(deps) > 0);
    expect(copyRow("m0")).toBeUndefined();
  });
});

describe("the lists", () => {
  const filter = hide(LEDGER, [folder("finance")]);

  it("follow a republished list, and drop a list the corpus no longer has", () => {
    entry("m0", { folderIds: ["invoices"] });
    entry("m1", { folderIds: ["clients"] });
    copyAll();
    const deps = { corpusDb: fixture.db, indexDb: fixture.indexDb };
    // Nothing copied yet: every folder is unlisted in the index.
    expect(indexVerdict(filter, "m0")).toBe("U");
    expect(refreshFilterListCopy(deps)).toBe(1);
    expect(refreshFilterListCopy(deps)).toBe(0);
    expect(indexVerdict(filter, "m0")).toBe("H");
    expect(indexVerdict(filter, "m1")).toBe("U");

    publishList(fixture.db, { sourceId: LEDGER, field: "extra.folderIds" }, [
      { id: "finance", label: "Finance" },
      { id: "invoices", label: "Invoices" },
      { id: "clients", label: "Clients", parentId: "finance" },
    ]);
    expect(refreshFilterListCopy(deps)).toBe(1);
    expect(indexVerdict(filter, "m0")).toBe("R");
    expect(indexVerdict(filter, "m1")).toBe("H");
    // Only the current version is kept.
    expect(
      fixture.indexDb
        .prepare<[], { n: number }>(
          "SELECT count(DISTINCT generation) AS n FROM index_filter_items",
        )
        .get()!.n,
    ).toBe(1);

    fixture.db.prepare("DELETE FROM source_filter_lists").run();
    expect(refreshFilterListCopy(deps)).toBe(1);
    expect(
      fixture.indexDb
        .prepare<[], { n: number }>("SELECT count(*) AS n FROM index_filter_items")
        .get()!.n,
    ).toBe(0);
    expect(indexVerdict(filter, "m0")).toBe("U");
  });

  it("carry the members of each item", () => {
    publishProfile(fixture.db, "parley", 1, {
      documentTypes: ["day"],
      personRoles: ["participant"],
      metadataFields: [
        {
          path: "extra.chatId",
          type: "string",
          description: "Chat id.",
          filter: {
            capability: "membership",
            minVersion: 0,
            scope: "global",
            noun: { one: "chat", many: "chats" },
            picker: "search",
            listsMembers: true,
          },
        },
      ],
      personFilter: {
        minVersion: 0,
        roles: ["participant"],
        identifiers: ["phone"],
        membersOf: "extra.chatId",
      },
    } as never);
    publishList(fixture.db, { sourceId: "parley:studio", field: "extra.chatId" }, [
      { id: "c1", label: "Studio team", members: [{ type: "phone", value: "+15550100123" }] },
    ]);
    insertDocument(fixture.db, {
      id: "day",
      sourceId: "parley:studio",
      metadata: { documentType: "day", people: [], extra: { chatId: "c1" } },
    });
    copyAll();
    refreshFilterListCopy({ corpusDb: fixture.db, indexDb: fixture.indexDb });
    const compiled = compileSourceFilter(
      hide("parley:studio", [person("Maya Reeves", ["phone", "+15550100123"])]),
      filterFieldsFor(fixture.db, "parley"),
    );
    const sql = filterVerdictSql(compiled, { id: "t.document_id" }, INDEX_FILTER_TABLES);
    expect(
      fixture.indexDb
        .prepare<unknown[], { verdict: string }>(
          `SELECT (${sql.sql}) AS verdict FROM (SELECT ? AS document_id) t`,
        )
        .get(...sql.params, "day")!.verdict,
    ).toBe("H");
  });

  it("copy a list larger than one write, and survive an interrupted copy", () => {
    const items = Array.from({ length: 4500 }, (_unused, index) => ({
      id: `folder-${index}`,
      label: `Folder ${index}`,
      ...(index > 0 ? { parentId: "folder-0" } : {}),
    }));
    publishList(fixture.db, { sourceId: LEDGER, field: "extra.folderIds" }, items);
    const generation = fixture.db
      .prepare<[], { generation: number }>("SELECT generation FROM source_filter_lists")
      .get()!.generation;
    // Rows an interrupted copy of this version left behind.
    fixture.indexDb
      .prepare(
        "INSERT INTO index_filter_items VALUES (?, 'extra.folderIds', '', ?, 'left-over', NULL, 'Left over')",
      )
      .run(LEDGER, generation);
    refreshFilterListCopy({ corpusDb: fixture.db, indexDb: fixture.indexDb });
    expect(
      fixture.indexDb
        .prepare<[], { n: number }>("SELECT count(*) AS n FROM index_filter_items")
        .get()!.n,
    ).toBe(4500);
    entry("deep", { folderIds: ["folder-4499"] });
    copyAll();
    expect(indexVerdict(hide(LEDGER, [folder("folder-0")]), "deep")).toBe("H");
  });
});

describe("removal", () => {
  it("deletes the rows of documents that left the index", () => {
    entry("m0", { labelIds: [] });
    entry("m1", { labelIds: [] });
    copyAll();
    deleteFilterCopyDocuments(fixture.indexDb, ["m0", "unknown"]);
    deleteFilterCopyDocuments(fixture.indexDb, []);
    expect(copyRow("m0")).toBeUndefined();
    expect(copyRow("m1")).toBeDefined();
  });

  it("deletes a source in bounded passes, then its lists", () => {
    const insert = fixture.indexDb.prepare(
      "INSERT INTO index_filter_documents VALUES (?, ?, '', 0, '', 'd', '{}')",
    );
    fixture.indexDb.transaction(() => {
      for (let index = 0; index < FILTER_COPY_DELETE_BATCH + 10; index++) {
        insert.run(`doc-${index}`, LEDGER);
      }
      insert.run("other", "ledger:elsewhere");
    })();
    refreshFilterListCopy({ corpusDb: fixture.db, indexDb: fixture.indexDb });
    expect(deleteFilterCopySource(fixture.indexDb, LEDGER)).toBe(false);
    expect(
      fixture.indexDb
        .prepare<[], { n: number }>("SELECT count(*) AS n FROM index_filter_lists")
        .get()!.n,
    ).toBe(1);
    expect(deleteFilterCopySource(fixture.indexDb, LEDGER)).toBe(true);
    expect(copyRow("other")).toBeDefined();
    for (const table of FILTER_COPY_TABLES) {
      const left = fixture.indexDb
        .prepare<[string], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE source_id = ?`)
        .get(LEDGER)!.n;
      expect([table, left]).toEqual([table, 0]);
    }
  });

  it("creates its tables more than once without harm", () => {
    createFilterCopyTables(fixture.indexDb);
    createFilterCopyTables(fixture.indexDb);
    const tables = fixture.indexDb
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'index_filter_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([...FILTER_COPY_TABLES].sort());
  });
});

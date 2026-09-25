// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { tableWrites, tableWriteRowCount, type TableWrite } from "./table-write.js";
import {
  deletionsFor,
  emittedRows,
  rowsFor,
  tablesWritten,
  writesFor,
} from "./testing/page-writes.js";

describe("tableWrites", () => {
  test("a page with no analytics writes nothing", () => {
    expect(tableWrites(undefined)).toEqual([]);
  });

  test("one table may be named directly, without a list", () => {
    expect(tableWrites({ tableName: "runs", records: [{ id: 1 }] })).toEqual([
      { tableName: "runs", records: [{ id: 1 }] },
    ]);
  });

  test("order is preserved, because a source may need a parent before its children", () => {
    const writes: TableWrite[] = [
      { tableName: "runs", records: [{ id: 1 }] },
      { tableName: "run_splits", records: [{ run_id: 1 }] },
    ];
    expect(tableWrites(writes).map((w) => w.tableName)).toEqual(["runs", "run_splits"]);
  });

  test("one table named twice stays two writes, so a clear can precede its rewrite", () => {
    const writes: TableWrite[] = [
      { tableName: "kudos", deletedIds: ["7"], deleteKeyColumn: "run_id" },
      { tableName: "kudos", records: [{ run_id: 7, position: 1 }] },
    ];
    const got = tableWrites(writes);
    expect(got).toHaveLength(2);
    expect(got[0]!.deletedIds).toEqual(["7"]);
    expect(got[1]!.records).toHaveLength(1);
  });

  test("a write that asks for nothing is dropped rather than sent", () => {
    // A source composing its page from optional parts should not have to
    // filter its own list, and an empty write costs a round trip to say so.
    expect(tableWrites([{ tableName: "runs" }, { tableName: "runs", records: [] }])).toEqual([]);
  });

  test("an empty snapshot is not an empty write", () => {
    // `presentIds: []` says the upstream is empty, which deletes everything —
    // the one case where dropping the write would lose the source's meaning.
    expect(tableWrites({ tableName: "runs", presentIds: [] })).toHaveLength(1);
  });

  test("a schema-only write survives, because it registers the table", () => {
    const schemaOnly: TableWrite = {
      tableName: "runs",
      schema: {
        tableName: "runs",
        displayName: "Runs",
        description: "Runs",
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      },
    };
    expect(tableWrites(schemaOnly)).toHaveLength(1);
  });

  test("the row count spans every table, not just the first", () => {
    expect(
      tableWriteRowCount([
        { tableName: "runs", records: [{ id: 1 }] },
        { tableName: "run_splits", records: [{ id: 1 }, { id: 2 }] },
      ]),
    ).toBe(3);
  });

  test("deletions alone count as no rows written", () => {
    expect(tableWriteRowCount({ tableName: "runs", deletedIds: ["1", "2"] })).toBe(0);
  });
});

describe("reading a page in a test", () => {
  const page = {
    analytics: [
      { tableName: "runs", records: [{ id: 1 }] },
      { tableName: "kudos", deletedIds: ["1"], deleteKeyColumn: "run_id" },
      { tableName: "kudos", records: [{ run_id: 1, position: 1 }] },
    ] as TableWrite[],
  };

  test("rows for a table named twice come back joined, in order", () => {
    expect(rowsFor(page, "kudos")).toEqual([{ run_id: 1, position: 1 }]);
    expect(rowsFor(page, "runs")).toEqual([{ id: 1 }]);
  });

  test("a table the page never names has no rows", () => {
    expect(rowsFor(page, "splits")).toEqual([]);
  });

  test("the written tables repeat, because the sequence is the assertion", () => {
    expect(tablesWritten(page)).toEqual(["runs", "kudos", "kudos"]);
  });

  test("deletions are readable per table", () => {
    expect(deletionsFor(page, "kudos")).toEqual(["1"]);
    expect(deletionsFor(page, "runs")).toEqual([]);
  });

  test("the raw writes carry what the rows do not", () => {
    expect(writesFor(page, "kudos")[0]!.deleteKeyColumn).toBe("run_id");
  });

  test("emitted rows tag every table, so a fan-out source is checked whole", () => {
    expect(emittedRows(page)).toEqual([
      { table: "runs", row: { id: 1 } },
      { table: "kudos", row: { run_id: 1, position: 1 } },
    ]);
  });
});

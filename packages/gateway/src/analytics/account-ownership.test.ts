// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { AnalyticsDb } from "../analytics-db.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const parent: AnalyticsTableSchema = {
  tableName: "ownership_parents",
  displayName: "Parents",
  description: "Invented ownership records",
  columns: [
    { name: "id", type: "VARCHAR", description: "Key" },
    { name: "account", type: "VARCHAR", description: "Owner" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["id"] },
  sharedDiscriminatorColumn: "account",
};
const oldParent: AnalyticsTableSchema = { ...parent, sharedDiscriminatorColumn: undefined };
const child: AnalyticsTableSchema = {
  tableName: "ownership_children",
  displayName: "Children",
  description: "Invented child records",
  columns: [
    { name: "id", type: "VARCHAR", description: "Key" },
    { name: "parent_id", type: "VARCHAR", description: "Parent" },
    { name: "owner", type: "VARCHAR", description: "Owner", nullable: true },
  ],
  primaryKey: ["id"],
  deleteKey: ["parent_id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["id"] },
  sharedDiscriminatorColumn: "owner",
  sharedDiscriminatorParent: { table: parent.tableName, column: "parent_id", parentColumn: "id" },
};
const oldChild: AnalyticsTableSchema = {
  ...child,
  columns: child.columns.slice(0, 2),
  sharedDiscriminatorColumn: undefined,
  sharedDiscriminatorParent: undefined,
};

describe("legacy analytics account ownership", () => {
  let directory: string;
  let db: AnalyticsDb;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "omnesis-ownership-"));
    db = new AnalyticsDb(join(directory, "analytics.db"));
    await db.open();
  });
  afterEach(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function seed() {
    await db.ensureTable(oldParent, "fixture-source");
    await db.insertRecords(
      parent.tableName,
      [
        { id: "p1", account: "first" },
        { id: "p2", account: "second" },
      ],
      ["id"],
    );
    await db.ensureTable(oldChild, "fixture-source");
    await db.insertRecords(
      child.tableName,
      [
        { id: "c1", parent_id: "p1" },
        { id: "c2", parent_id: "p2" },
      ],
      ["id"],
    );
  }
  const rows = async () =>
    (await db.executeQuery("SELECT id, owner FROM ownership_children ORDER BY id")).rows;
  test("a bare legacy parent and child-only old page recover via explicit schema prerequisites", async () => {
    await seed();
    await db.ensureTable(parent, "fixture-source:first");
    await db.ensureTable(child, "fixture-source:first");
    expect(await rows()).toEqual([
      ["c1", "first"],
      ["c2", "second"],
    ]);
    await db.ingestPage({
      tableName: child.tableName,
      schema: oldChild,
      sourceId: "fixture-source:first",
      records: [],
      deletedIds: ["p1", "p2"],
    });
    expect(await rows()).toEqual([["c2", "second"]]);
    await db.close();
    db = new AnalyticsDb(join(directory, "analytics.db"));
    await db.open();
    expect(
      (
        await db.executeQuery(
          "SELECT ownership_backfill_pending FROM _analytics_catalog WHERE table_name = 'ownership_children'",
        )
      ).rows,
    ).toEqual([[false]]);
  });
  test("orphans preserve all removal effects and recover after their parent arrives", async () => {
    await seed();
    await db.insertRecords(child.tableName, [{ id: "orphan", parent_id: "later" }], ["id"]);
    await db.ensureTable(parent, "fixture-source:first");
    await db.ensureTable(child, "fixture-source:first");
    await expect(db.deleteAnalyticsForSource("fixture-source:first")).rejects.toThrow(
      /unresolved account ownership/,
    );
    expect(await rows()).toEqual([
      ["c1", "first"],
      ["c2", "second"],
      ["orphan", null],
    ]);
    expect((await db.executeQuery("SELECT COUNT(*) FROM ownership_parents")).rows).toEqual([[2]]);
    await db.ingestPage({
      tableName: parent.tableName,
      sourceId: "fixture-source:first",
      records: [{ id: "later" }],
    });
    await db.ensureTable(child, "fixture-source:first");
    await db.deleteAnalyticsForSource("fixture-source:first");
    expect(await rows()).toEqual([["c2", "second"]]);
  });
  test("bounded repair commits progress beyond an orphan before destructive retries", async () => {
    await seed();
    await db.insertRecords(
      child.tableName,
      [
        { id: "orphan", parent_id: "later" },
        ...Array.from({ length: 2001 }, (_, i) => ({ id: `bulk-${i}`, parent_id: "p1" })),
      ],
      ["id"],
    );
    await db.ensureTable(parent, "fixture-source:first");
    const unresolved = async () =>
      (await db.executeQuery("SELECT COUNT(*) FROM ownership_children WHERE owner IS NULL"))
        .rows[0]![0];
    await db.ensureTable(child, "fixture-source:first");
    expect(await unresolved()).toBe(1004);
    await expect(
      db.ingestPage({
        tableName: child.tableName,
        sourceId: "fixture-source:first",
        records: [],
        deletedIds: ["later", "p1"],
      }),
    ).rejects.toThrow(/unresolved account ownership/);
    expect(await unresolved()).toBe(1004); // page repair rolled back, prerequisite did not
    await db.ensureTable(child, "fixture-source:first");
    expect(await unresolved()).toBe(4);
    await db.ensureTable(child, "fixture-source:first");
    expect(await unresolved()).toBe(1);
    await db.ingestPage({
      tableName: child.tableName,
      sourceId: "fixture-source:first",
      records: [],
      deletedIds: ["p1"],
    });
    expect(await rows()).toEqual([
      ["c2", "second"],
      ["orphan", null],
    ]);
  });
  test("a relation cannot read another provider or replace its parent", async () => {
    await db.ensureTable(parent, "other-source:first");
    await expect(db.ensureTable(child, "fixture-source:first")).rejects.toThrow(/same-source/);
    expect((await db.getCatalog()).map((entry) => entry.tableName)).toEqual([parent.tableName]);
    await db.ensureTable({ ...parent, tableName: "same_parent" }, "fixture-source:first");
    await db.ensureTable(
      {
        ...child,
        sharedDiscriminatorParent: { ...child.sharedDiscriminatorParent!, table: "same_parent" },
      },
      "fixture-source:first",
    );
    await expect(
      db.ensureTable(
        {
          ...child,
          sharedDiscriminatorParent: {
            ...child.sharedDiscriminatorParent!,
            table: "different_parent",
          },
        },
        "fixture-source:first",
      ),
    ).rejects.toThrow(/cannot be replaced/);
  });

  test("parent attribution joins only the same device stream", async () => {
    for (const [streamId, account] of [
      ["device-a", "first"],
      ["device-b", "second"],
    ]) {
      await db.ingestPage({
        tableName: parent.tableName,
        schema: oldParent,
        sourceId: "fixture-source",
        streamId,
        records: [{ id: "same-parent", account }],
      });
      await db.ingestPage({
        tableName: child.tableName,
        schema: oldChild,
        sourceId: "fixture-source",
        streamId,
        records: [{ id: "same-child", parent_id: "same-parent" }],
      });
    }
    await db.ensureTable(parent, "fixture-source:first");
    await db.ensureTable(child, "fixture-source:first");
    expect(
      (
        await db.executeQuery(
          "SELECT owner, _stream_id FROM ownership_children ORDER BY _stream_id",
        )
      ).rows,
    ).toEqual([
      ["first", "device-a"],
      ["second", "device-b"],
    ]);
    await db.prepareSourceRemoval("fixture-source:first", "device-a");
    await db.deleteAnalyticsStream("fixture-source:first", "device-a");
    expect(
      (await db.executeQuery("SELECT owner, _stream_id FROM ownership_children")).rows,
    ).toEqual([["second", "device-b"]]);
  });

  test("an incoming record cannot steal an unresolved child beyond the repair batch", async () => {
    await seed();
    await db.insertRecords(
      child.tableName,
      Array.from({ length: 2100 }, (_, i) => ({ id: `sibling-${i}`, parent_id: "p2" })),
      ["id"],
    );
    await db.ensureTable(parent, "fixture-source:first");
    await db.ensureTable(child, "fixture-source:first");
    const unresolved = (
      await db.executeQuery(
        "SELECT id FROM ownership_children WHERE owner IS NULL ORDER BY id DESC LIMIT 1",
      )
    ).rows[0]![0];
    await expect(
      db.ingestPage({
        tableName: child.tableName,
        sourceId: "fixture-source:first",
        records: [{ id: unresolved, parent_id: "p2" }],
      }),
    ).rejects.toThrow(/unresolved account ownership|different source account/);
    expect(
      (await db.executeQuery("SELECT COUNT(*) FROM ownership_children WHERE owner = 'first'")).rows,
    ).toEqual([[1]]);
  });

  test("orphan ownership blocks snapshots and old absence marks without deleting the orphan", async () => {
    await db.ensureTable(oldParent, "fixture-source");
    await db.ensureTable(oldChild, "fixture-source:first");
    await db.insertRecords(child.tableName, [{ id: "orphan", parent_id: "later" }], ["id"]);
    await db.ingestPage({
      tableName: child.tableName,
      sourceId: "fixture-source:first",
      records: [],
      presentIds: [],
      absencePolicy: { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 100 },
    });
    const due = await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 });
    expect(due).toHaveLength(1);
    await db.ensureTable(oldChild, "fixture-source:second");
    await db.ensureTable(parent, "fixture-source:first");
    await db.ensureTable(child, "fixture-source:first");
    await expect(db.deleteAbsentRecords(due)).rejects.toThrow(/unresolved account ownership/);
    await expect(
      db.ingestPage({
        tableName: child.tableName,
        sourceId: "fixture-source:first",
        records: [],
        presentIds: [],
        absencePolicy: { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 100 },
      }),
    ).rejects.toThrow(/unresolved account ownership/);
    await expect(db.prepareSourceRemoval("fixture-source:first")).rejects.toThrow(
      /unresolved account ownership/,
    );
    expect(await rows()).toEqual([["orphan", null]]);
  });

  test.each(["nonunique", "type-mismatch", "chain"])(
    "invalid parent proof %s leaves no child schema",
    async (kind) => {
      const invalid: AnalyticsTableSchema =
        kind === "nonunique"
          ? { ...parent, primaryKey: ["id", "account"] }
          : kind === "type-mismatch"
            ? {
                ...parent,
                columns: [{ ...parent.columns[0]!, type: "BIGINT" }, parent.columns[1]!],
              }
            : {
                ...parent,
                sharedDiscriminatorParent: {
                  table: "unregistered_parent",
                  column: "id",
                  parentColumn: "id",
                },
              };
      await db.ensureTable(invalid, "fixture-source:first");
      await expect(db.ensureTable(child, "fixture-source:first")).rejects.toThrow(/ownership/);
      expect((await db.getCatalog()).map((entry) => entry.tableName)).toEqual([parent.tableName]);
    },
  );

  test.each(["explicit", "inferred"])(
    "static ownership introduction cannot archive a %s dynamic parent",
    async (kind) => {
      const dynamic: AnalyticsTableSchema = {
        ...oldParent,
        dynamicColumns: kind === "explicit" ? true : undefined,
        columns: [
          ...oldParent.columns,
          {
            name: "upstream_extra",
            type: "VARCHAR",
            nullable: true,
            description: "Preserved",
            sourceColumnId: kind === "inferred" ? "upstream-field" : undefined,
          },
        ],
      };
      await db.ensureTable(dynamic, "fixture-source");
      await db.insertRecords(
        parent.tableName,
        [{ id: "p1", account: "first", upstream_extra: "retained" }],
        ["id"],
      );
      await expect(db.ensureTable(parent, "fixture-source:first")).rejects.toThrow(
        /static schema into a dynamic/,
      );
      expect((await db.executeQuery("SELECT upstream_extra FROM ownership_parents")).rows).toEqual([
        ["retained"],
      ]);
      expect(
        (
          await db.executeQuery(
            "SELECT json_extract_string(schema_json, '$.sharedDiscriminatorColumn') FROM _analytics_catalog WHERE table_name = 'ownership_parents'",
          )
        ).rows,
      ).toEqual([[null]]);
    },
  );

  test("old dynamic payloads preserve ownership and parent join columns; renames and retypes refuse", async () => {
    await seed();
    await db.ensureTable(parent, "fixture-source:first");
    const dynamic: AnalyticsTableSchema = {
      ...child,
      dynamicColumns: true,
      columns: child.columns.map((column) => ({
        ...column,
        sourceColumnId: `upstream-${column.name}`,
      })),
    };
    await db.ensureTable(dynamic, "fixture-source:first");
    const old: AnalyticsTableSchema = {
      ...dynamic,
      columns: [dynamic.columns[0]!],
      deleteKey: undefined,
      sharedDiscriminatorColumn: undefined,
      sharedDiscriminatorParent: undefined,
    };
    await db.ensureTable(old, "fixture-source:first");
    expect(
      (await db.executeQuery("SELECT parent_id, owner FROM ownership_children ORDER BY id")).rows,
    ).toEqual([
      ["p1", "first"],
      ["p2", "second"],
    ]);
    for (const name of ["owner", "parent_id"]) {
      await expect(
        db.ensureTable(
          {
            ...old,
            columns: [
              ...old.columns,
              {
                ...dynamic.columns.find((column) => column.name === name)!,
                name: `renamed_${name}`,
              },
            ],
          },
          "fixture-source:first",
        ),
      ).rejects.toThrow(/cannot be renamed/);
      await expect(
        db.ensureTable(
          {
            ...old,
            columns: [
              ...old.columns,
              { ...dynamic.columns.find((column) => column.name === name)!, type: "BIGINT" },
            ],
          },
          "fixture-source:first",
        ),
      ).rejects.toThrow(/type cannot be replaced/);
    }
  });

  test.each(["source", "stream"])(
    "%s cleanup retires a stale catalog whose physical table is missing",
    async (kind) => {
      await db.ingestPage({
        tableName: parent.tableName,
        schema: parent,
        sourceId: "fixture-source:first",
        streamId: kind === "stream" ? "device-a" : undefined,
        records: [{ id: "one" }],
      });
      await db.close();
      const raw = await DuckDBInstance.create(join(directory, "analytics.db"));
      const conn = await raw.connect();
      await conn.run("DROP TABLE ownership_parents");
      conn.closeSync();
      raw.closeSync();
      db = new AnalyticsDb(join(directory, "analytics.db"));
      await db.open();
      await db.prepareSourceRemoval(
        "fixture-source:first",
        kind === "stream" ? "device-a" : undefined,
      );
      if (kind === "stream") await db.deleteAnalyticsStream("fixture-source:first", "device-a");
      else await db.deleteAnalyticsForSource("fixture-source:first");
      expect(await db.getCatalog()).toEqual([]);
    },
  );

  test.each([false, true])(
    "missing physical parent allows known-owned cleanup but protects orphans: %s",
    async (orphan) => {
      await seed();
      if (orphan)
        await db.insertRecords(child.tableName, [{ id: "orphan", parent_id: "missing" }], ["id"]);
      await db.ensureTable(parent, "fixture-source:first");
      await db.ensureTable(child, "fixture-source:first");
      await db.close();
      const raw = await DuckDBInstance.create(join(directory, "analytics.db"));
      const conn = await raw.connect();
      await conn.run("DROP TABLE ownership_parents");
      conn.closeSync();
      raw.closeSync();
      db = new AnalyticsDb(join(directory, "analytics.db"));
      await db.open();
      if (orphan) {
        await expect(db.prepareSourceRemoval("fixture-source:first")).rejects.toThrow(
          /unresolved account ownership/,
        );
        await expect(db.deleteAnalyticsForSource("fixture-source:first")).rejects.toThrow(
          /unresolved account ownership/,
        );
        expect(await rows()).toEqual([
          ["c1", "first"],
          ["c2", "second"],
          ["orphan", null],
        ]);
      } else {
        await db.prepareSourceRemoval("fixture-source:first");
        await db.deleteAnalyticsForSource("fixture-source:first");
        expect(await rows()).toEqual([["c2", "second"]]);
      }
    },
  );

  test.each(["incoming", "persisted"])(
    "a %s nonunique declared child key cannot assign a sibling parent's ownership",
    async (keyDrift) => {
      await db.ensureTable(oldParent, "fixture-source");
      await db.insertRecords(
        parent.tableName,
        [
          { id: "p1", account: "first" },
          { id: "p2", account: "second" },
        ],
        ["id"],
      );
      const legacy: AnalyticsTableSchema = {
        ...oldChild,
        columns: [
          ...oldChild.columns,
          { name: "group_key", type: "VARCHAR", description: "Nonunique group" },
        ],
      };
      await db.ensureTable(legacy, "fixture-source");
      await db.insertRecords(
        child.tableName,
        [
          { id: "c1", parent_id: "p1", group_key: "same" },
          { id: "c2", parent_id: "p2", group_key: "same" },
        ],
        ["id"],
      );
      // An older catalog can have evolved declared keys without rebuilding the physical key.
      if (keyDrift === "persisted")
        await db.ensureTable({ ...legacy, primaryKey: ["group_key"] }, "fixture-source");
      await db.ensureTable(parent, "fixture-source:first");
      await expect(
        db.ensureTable(
          { ...child, columns: [...child.columns, legacy.columns[2]!], primaryKey: ["group_key"] },
          "fixture-source:first",
        ),
      ).rejects.toThrow(/declared physical primary key/);
      expect(
        (await db.executeQuery("SELECT id, parent_id FROM ownership_children ORDER BY id")).rows,
      ).toEqual([
        ["c1", "p1"],
        ["c2", "p2"],
      ]);
      expect(
        (
          await db.executeQuery(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'ownership_children' AND column_name = 'owner'",
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await db.executeQuery(
            "SELECT json_extract_string(schema_json, '$.primaryKey[0]'), json_extract_string(schema_json, '$.sharedDiscriminatorColumn') FROM _analytics_catalog WHERE table_name = 'ownership_children'",
          )
        ).rows,
      ).toEqual([[keyDrift === "persisted" ? "group_key" : "id", null]]);
    },
  );
});

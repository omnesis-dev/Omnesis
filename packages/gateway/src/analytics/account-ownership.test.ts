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
  test("an orphan never holds up removal; it stays, and its parent's arrival still attributes it", async () => {
    await seed();
    await db.insertRecords(child.tableName, [{ id: "orphan", parent_id: "later" }], ["id"]);
    await db.ensureTable(parent, "fixture-source:first");
    await db.ensureTable(child, "fixture-source:first");
    await db.prepareSourceRemoval("fixture-source:first");
    await db.deleteAnalyticsForSource("fixture-source:first");
    // The shared table scopes the removal to the account; the orphan is nobody's.
    expect(await rows()).toEqual([
      ["c2", "second"],
      ["orphan", null],
    ]);
    expect((await db.executeQuery("SELECT COUNT(*) FROM ownership_parents")).rows).toEqual([[1]]);
    expect(await db.unattributedLegacyRows("fixture-source:second")).toEqual([
      { tableName: child.tableName, rows: 1, remaining: 1 },
    ]);
    await db.ingestPage({
      tableName: parent.tableName,
      sourceId: "fixture-source:second",
      records: [{ id: "later" }],
    });
    await db.ensureTable(child, "fixture-source:second");
    expect(await rows()).toEqual([
      ["c2", "second"],
      ["orphan", "second"],
    ]);
    expect(await db.unattributedLegacyRows("fixture-source:second")).toEqual([]);
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
    ).rejects.toThrow(/still being attributed/);
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
    ).rejects.toThrow(/still being attributed|different source account/);
    expect(
      (await db.executeQuery("SELECT COUNT(*) FROM ownership_children WHERE owner = 'first'")).rows,
    ).toEqual([[1]]);
  });

  test("an orphan passes snapshots, old absence marks and removal untouched", async () => {
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
    // The absence was marked while the table had no account column; the
    // sweep's account scope now excludes a row nobody owns.
    expect(await db.deleteAbsentRecords(due)).toEqual({ deleted: 0, disputed: 0 });
    await db.ingestPage({
      tableName: child.tableName,
      sourceId: "fixture-source:first",
      records: [],
      presentIds: [],
      absencePolicy: { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 100 },
    });
    await db.prepareSourceRemoval("fixture-source:first");
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
    "missing physical parent allows known-owned cleanup and leaves an orphan in place: %s",
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
      await db.prepareSourceRemoval("fixture-source:first");
      await db.deleteAnalyticsForSource("fixture-source:first");
      expect(await rows()).toEqual(
        orphan
          ? [
              ["c2", "second"],
              ["orphan", null],
            ]
          : [["c2", "second"]],
      );
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

  /**
   * The shape of a provider-owned table several accounts write with no parent
   * relation: nothing but an incoming record, the catalog's exclusive owner or
   * the operator can ever attribute its legacy rows.
   */
  const events: AnalyticsTableSchema = {
    tableName: "ownership_events",
    displayName: "Events",
    description: "Invented calendar rows",
    columns: [
      { name: "id", type: "VARCHAR", description: "Key" },
      { name: "account", type: "VARCHAR", description: "Owner", nullable: true },
      { name: "title", type: "VARCHAR", description: "Title", nullable: true },
      { name: "start_time", type: "TIMESTAMPTZ", description: "Start" },
      { name: "end_time", type: "TIMESTAMPTZ", description: "End", nullable: true },
    ],
    primaryKey: ["id"],
    semanticTimeColumn: "start_time",
    record: { titleColumns: ["title"], keyColumns: ["start_time", "end_time"] },
    sharedDiscriminatorColumn: "account",
    temporalProjection: {
      slot: "calendar",
      start: "$semanticTime",
      end: "end_time",
      label: "title",
      kind: "appointment",
      modality: "scheduled",
    },
  };
  const oldEvents: AnalyticsTableSchema = {
    ...events,
    columns: events.columns.filter((column) => column.name !== "account"),
    sharedDiscriminatorColumn: undefined,
  };
  const event = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Meeting ${id}`,
    start_time: "2026-03-01T10:00:00Z",
    end_time: "2026-03-01T11:00:00Z",
    ...extra,
  });
  const eventRows = async () =>
    (await db.executeQuery("SELECT id, account FROM ownership_events ORDER BY id")).rows;
  const pendingFlag = async () =>
    (
      await db.executeQuery(
        "SELECT ownership_backfill_pending FROM _analytics_catalog WHERE table_name = 'ownership_events'",
      )
    ).rows[0]![0];
  const projections = async () =>
    (
      await db.executeQuery(
        "SELECT COUNT(*) FROM _temporal_projections WHERE table_name = 'ownership_events'",
      )
    ).rows[0]![0];
  /** Legacy rows written while two accounts shared the table without an account column. */
  async function seedSharedEvents(legacy: Record<string, unknown>[]) {
    await db.ingestPage({
      tableName: events.tableName,
      schema: oldEvents,
      sourceId: "fixture-source:first",
      records: [],
    });
    await db.ingestPage({
      tableName: events.tableName,
      schema: oldEvents,
      sourceId: "fixture-source:second",
      records: legacy,
    });
    await db.ensureTable(events, "fixture-source:first");
    await db.ensureTable(events, "fixture-source:second");
  }

  test("a tombstone for a legacy row nothing attributes commits its page and leaves the row", async () => {
    await seedSharedEvents([event("e1"), event("e2")]);
    const page = await db.ingestPage({
      tableName: events.tableName,
      sourceId: "fixture-source:first",
      records: [event("e3")],
      deletedIds: ["e1"],
    });
    expect(page.deleted).toBe(0);
    expect(await eventRows()).toEqual([
      ["e1", null],
      ["e2", null],
      ["e3", "first"],
    ]);
    expect(await pendingFlag()).toBe(true);
    expect(await db.unattributedLegacyRows("fixture-source:first")).toEqual([
      { tableName: events.tableName, rows: 2, remaining: 2 },
    ]);
    // A snapshot cannot delete it either, and an account re-emitting the key adopts it.
    await db.ingestPage({
      tableName: events.tableName,
      sourceId: "fixture-source:first",
      records: [event("e1")],
      presentIds: ["e1", "e3"],
      absencePolicy: { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 100 },
    });
    expect(await eventRows()).toEqual([
      ["e1", "first"],
      ["e2", null],
      ["e3", "first"],
    ]);
    expect(await db.unattributedLegacyRows("fixture-source:second")).toEqual([
      { tableName: events.tableName, rows: 1, remaining: 1 },
    ]);
  });

  test("a single-account history attributes its legacy rows itself; two accounts do not", async () => {
    // The account column exists but was never stamped, and the catalog still
    // records the one account that has ever claimed the table.
    await db.ingestPage({
      tableName: events.tableName,
      schema: events,
      sourceId: "fixture-source:first",
      records: [],
    });
    await db.close();
    const raw = await DuckDBInstance.create(join(directory, "analytics.db"));
    const conn = await raw.connect();
    for (let i = 0; i < 1200; i += 400) {
      await conn.run(
        `INSERT INTO ownership_events (id, title, start_time) VALUES ${Array.from(
          { length: 400 },
          (_, j) =>
            `('e${String(i + j).padStart(4, "0")}', 'Meeting', TIMESTAMPTZ '2026-03-01 10:00:00+00')`,
        ).join(", ")}`,
      );
    }
    await conn.run("UPDATE _analytics_catalog SET ownership_backfill_pending = true");
    conn.closeSync();
    raw.closeSync();
    db = new AnalyticsDb(join(directory, "analytics.db"));
    await db.open();
    await db.ensureTable(events, "fixture-source:first");
    const unattributed = async () =>
      (await db.executeQuery("SELECT COUNT(*) FROM ownership_events WHERE account IS NULL"))
        .rows[0]![0];
    // One bounded batch per admission; the pending flag clears with the last row.
    expect(await unattributed()).toBe(200);
    expect(await pendingFlag()).toBe(true);
    await db.ingestPage({
      tableName: events.tableName,
      sourceId: "fixture-source:first",
      records: [],
      deletedIds: ["e0000"],
    });
    expect(await unattributed()).toBe(0);
    expect(await eventRows()).toHaveLength(1199);
    expect(await pendingFlag()).toBe(false);

    await db.close();
    db = new AnalyticsDb(join(directory, "analytics.db"));
    await db.open();
    await db.deleteAnalyticsForSource("fixture-source:first");
    await seedSharedEvents([event("e1")]);
    await db.ingestPage({
      tableName: events.tableName,
      sourceId: "fixture-source:first",
      records: [event("e2")],
    });
    expect(await eventRows()).toEqual([
      ["e1", null],
      ["e2", "first"],
    ]);
    expect(await pendingFlag()).toBe(true);
  });

  test("the background repair finishes a single-account history no sync revisits", async () => {
    await db.ingestPage({
      tableName: events.tableName,
      schema: events,
      sourceId: "fixture-source:first",
      records: [],
    });
    await db.close();
    const raw = await DuckDBInstance.create(join(directory, "analytics.db"));
    const conn = await raw.connect();
    for (let i = 0; i < 2200; i += 440) {
      await conn.run(
        `INSERT INTO ownership_events (id, title, start_time) VALUES ${Array.from(
          { length: 440 },
          (_, j) =>
            `('e${String(i + j).padStart(4, "0")}', 'Meeting', TIMESTAMPTZ '2026-03-01 10:00:00+00')`,
        ).join(", ")}`,
      );
    }
    await conn.run("UPDATE _analytics_catalog SET ownership_backfill_pending = true");
    conn.closeSync();
    raw.closeSync();
    db = new AnalyticsDb(join(directory, "analytics.db"));
    await db.open();
    const unattributed = async () =>
      (await db.executeQuery("SELECT COUNT(*) FROM ownership_events WHERE account IS NULL"))
        .rows[0]![0];
    // No page arrives; each pass labels one bounded batch and reports whether
    // the table is still pending, until the last pass finds nothing to do.
    expect(await db.repairPendingOwnership()).toEqual({
      tables: 1,
      attributed: 1000,
      pending: 1,
      skipped: 0,
    });
    expect(await unattributed()).toBe(1200);
    expect(await db.repairPendingOwnership()).toEqual({
      tables: 1,
      attributed: 1000,
      pending: 1,
      skipped: 0,
    });
    expect(await db.repairPendingOwnership()).toEqual({
      tables: 1,
      attributed: 200,
      pending: 0,
      skipped: 0,
    });
    expect(await unattributed()).toBe(0);
    expect(await pendingFlag()).toBe(false);
    expect(await db.repairPendingOwnership()).toEqual({
      tables: 0,
      attributed: 0,
      pending: 0,
      skipped: 0,
    });
    expect(await db.unattributedLegacyRows("fixture-source:first")).toEqual([]);
  });

  test("the background repair labels by parent and leaves a shared history without one alone", async () => {
    // Children whose parents are owned are labelled from them; the shared
    // events table has no proof, so its rows stay and the table stays pending.
    await seed();
    await db.ensureTable(parent, "fixture-source:first");
    await db.ensureTable(child, "fixture-source:first");
    await db.insertRecords(child.tableName, [{ id: "orphan", parent_id: "nobody" }], ["id"]);
    await seedSharedEvents([event("e1")]);
    await db.ingestPage({
      tableName: events.tableName,
      sourceId: "fixture-source:second",
      records: [event("e2")],
    });
    await db.close();
    const raw = await DuckDBInstance.create(join(directory, "analytics.db"));
    const conn = await raw.connect();
    await conn.run("UPDATE ownership_children SET owner = NULL");
    await conn.run("UPDATE ownership_events SET account = NULL WHERE id = 'e1'");
    await conn.run(
      "UPDATE _analytics_catalog SET ownership_backfill_pending = true WHERE table_name IN ('ownership_children', 'ownership_events')",
    );
    conn.closeSync();
    raw.closeSync();
    db = new AnalyticsDb(join(directory, "analytics.db"));
    await db.open();
    // The orphan keeps the children table pending; the second pass has
    // nothing left to label, which is what lets the job back off.
    expect(await db.repairPendingOwnership()).toEqual({
      tables: 2,
      attributed: 2,
      pending: 2,
      skipped: 0,
    });
    expect(await db.repairPendingOwnership()).toEqual({
      tables: 2,
      attributed: 0,
      pending: 2,
      skipped: 0,
    });
    expect(await rows()).toEqual([
      ["c1", "first"],
      ["c2", "second"],
      ["orphan", null],
    ]);
    expect(await eventRows()).toEqual([
      ["e1", null],
      ["e2", "second"],
    ]);
  });

  test("the background repair takes no write for a table without an account column or without a physical table", async () => {
    // A table that never declared an account column carries the catalog's
    // default pending flag; a shared table whose physical table is gone has
    // nothing to label. Neither reaches the writer or counts as work.
    await db.ensureTable(oldParent, "fixture-source");
    await db.ingestPage({
      tableName: events.tableName,
      schema: events,
      sourceId: "fixture-source:first",
      records: [event("e1")],
    });
    await db.close();
    const raw = await DuckDBInstance.create(join(directory, "analytics.db"));
    const conn = await raw.connect();
    await conn.run("UPDATE _analytics_catalog SET ownership_backfill_pending = true");
    await conn.run("DROP TABLE ownership_events");
    conn.closeSync();
    raw.closeSync();
    db = new AnalyticsDb(join(directory, "analytics.db"));
    await db.open();
    expect(await db.repairPendingOwnership()).toEqual({
      tables: 0,
      attributed: 0,
      pending: 0,
      skipped: 0,
    });
  });

  test("a table whose batch fails is skipped and the others are still repaired", async () => {
    // The children table lost its physical primary key, which a repair refuses
    // to work without; the shared events table behind it still gets its batch.
    await seed();
    await db.ensureTable(parent, "fixture-source:first");
    await db.ensureTable(child, "fixture-source:first");
    await db.ingestPage({
      tableName: events.tableName,
      schema: events,
      sourceId: "fixture-source:first",
      records: [event("e1")],
    });
    await db.close();
    const raw = await DuckDBInstance.create(join(directory, "analytics.db"));
    const conn = await raw.connect();
    await conn.run("CREATE TABLE unkeyed AS SELECT * FROM ownership_children");
    await conn.run("DROP TABLE ownership_children");
    await conn.run("ALTER TABLE unkeyed RENAME TO ownership_children");
    await conn.run("UPDATE ownership_children SET owner = NULL");
    await conn.run("UPDATE ownership_events SET account = NULL");
    await conn.run(
      "UPDATE _analytics_catalog SET ownership_backfill_pending = true WHERE table_name IN ('ownership_children', 'ownership_events')",
    );
    conn.closeSync();
    raw.closeSync();
    db = new AnalyticsDb(join(directory, "analytics.db"));
    await db.open();
    expect(await db.repairPendingOwnership()).toEqual({
      tables: 2,
      attributed: 1,
      pending: 1,
      skipped: 1,
    });
    expect(await eventRows()).toEqual([["e1", "first"]]);
    expect(await rows()).toEqual([
      ["c1", null],
      ["c2", null],
    ]);
  });

  test("a source holding unattributed legacy rows can still be removed", async () => {
    await seedSharedEvents([event("e1")]);
    await db.ingestPage({
      tableName: events.tableName,
      sourceId: "fixture-source:first",
      records: [event("e2")],
    });
    await db.ingestPage({
      tableName: events.tableName,
      sourceId: "fixture-source:second",
      records: [event("e3")],
    });
    await db.prepareSourceRemoval("fixture-source:first");
    await db.deleteAnalyticsForSource("fixture-source:first");
    expect(await eventRows()).toEqual([
      ["e1", null],
      ["e3", "second"],
    ]);
    expect(await db.unattributedLegacyRows("fixture-source:second")).toEqual([
      { tableName: events.tableName, rows: 1, remaining: 1 },
    ]);
  });

  test.each(["claim", "drop"] as const)(
    "the operator settles the rows nothing attributes by %s, in bounded batches",
    async (action) => {
      await seedSharedEvents(
        Array.from({ length: 1100 }, (_, i) => event(`legacy-${String(i).padStart(4, "0")}`)),
      );
      await db.ingestPage({
        tableName: events.tableName,
        sourceId: "fixture-source:first",
        records: [event("mine")],
      });
      await db.ingestPage({
        tableName: events.tableName,
        sourceId: "fixture-source:second",
        records: [event("theirs")],
      });
      expect(await projections()).toBe(1102);
      expect(await db.settleLegacyRows("fixture-source:first", action)).toEqual([
        { tableName: events.tableName, rows: 1100, remaining: 0 },
      ]);
      const counts = (
        await db.executeQuery(
          "SELECT account, COUNT(*) FROM ownership_events GROUP BY account ORDER BY account",
        )
      ).rows;
      expect(counts).toEqual(
        action === "claim"
          ? [
              ["first", 1101],
              ["second", 1],
            ]
          : [
              ["first", 1],
              ["second", 1],
            ],
      );
      expect(await projections()).toBe(action === "claim" ? 1102 : 2);
      expect(await pendingFlag()).toBe(false);
      expect(await db.unattributedLegacyRows("fixture-source:first")).toEqual([]);
      expect(await db.settleLegacyRows("fixture-source:first", action)).toEqual([]);
      if (action === "claim") {
        // The claimed rows' projections now belong to the claimant, which can
        // retract them like any row of its own.
        expect(
          (
            await db.executeQuery(
              "SELECT COUNT(*) FROM _temporal_projections WHERE table_name = 'ownership_events' AND source_id = 'fixture-source:first'",
            )
          ).rows,
        ).toEqual([[1101]]);
        await db.ingestPage({
          tableName: events.tableName,
          sourceId: "fixture-source:first",
          records: [],
          deletedIds: ["legacy-0000"],
        });
        expect(await projections()).toBe(1101);
      }
    },
  );

  test("a claim re-homes a projection without duplicating one the claimant already holds", async () => {
    await seedSharedEvents([event("shared")]);
    // The claimant re-emitted the row before the claim, so its own projection
    // already stands beside the legacy one; the row then lost its owner again.
    await db.ingestPage({
      tableName: events.tableName,
      sourceId: "fixture-source:first",
      records: [event("shared"), event("mine")],
    });
    await db.close();
    const raw = await DuckDBInstance.create(join(directory, "analytics.db"));
    const conn = await raw.connect();
    await conn.run(
      "INSERT INTO _temporal_projections SELECT replace(id, 'tp_', 'tp_legacy_'), 'fixture-source:second', table_name, record_key, slot, bound_document_external_id, start_ms, end_exclusive_ms, start_canonical, end_canonical, precision, all_day, time_zone, label, kind, modality, status, source_updated_at, correlation_keys, projected_at FROM _temporal_projections WHERE record_key = 'shared'",
    );
    await conn.run("UPDATE ownership_events SET account = NULL WHERE id = 'shared'");
    await conn.run("UPDATE _analytics_catalog SET ownership_backfill_pending = true");
    conn.closeSync();
    raw.closeSync();
    db = new AnalyticsDb(join(directory, "analytics.db"));
    await db.open();
    expect(await projections()).toBe(3);
    expect(await db.settleLegacyRows("fixture-source:first", "claim")).toEqual([
      { tableName: events.tableName, rows: 1, remaining: 0 },
    ]);
    expect(
      (
        await db.executeQuery(
          "SELECT source_id, COUNT(*) FROM _temporal_projections WHERE table_name = 'ownership_events' GROUP BY source_id",
        )
      ).rows,
    ).toEqual([["fixture-source:first", 2]]);
  });

  test("the operator cannot claim or drop a row a parent repair will attribute", async () => {
    await seed();
    await db.insertRecords(
      child.tableName,
      [
        { id: "orphan", parent_id: "nobody" },
        ...Array.from({ length: 1200 }, (_, i) => ({ id: `owned-${i}`, parent_id: "p2" })),
      ],
      ["id"],
    );
    await db.ensureTable(parent, "fixture-source:first");
    await db.ensureTable(child, "fixture-source:first");
    // One bounded repair has run; the second account's remaining children are
    // still NULL but are not the first account's to settle.
    expect(await db.unattributedLegacyRows("fixture-source:first")).toEqual([
      { tableName: child.tableName, rows: 1, remaining: 1 },
    ]);
    expect(await db.settleLegacyRows("fixture-source:first", "claim")).toEqual([
      { tableName: child.tableName, rows: 1, remaining: 0 },
    ]);
    // The orphan is the claimant's; every row still owned by nobody has the
    // sibling's parent and waits for the repair, which never touches the claim.
    expect(
      (
        await db.executeQuery(
          "SELECT owner, COUNT(*), COUNT(DISTINCT parent_id) FROM ownership_children WHERE owner = 'first' OR owner IS NULL GROUP BY owner ORDER BY owner NULLS LAST",
        )
      ).rows,
    ).toEqual([
      ["first", 2, 2],
      [null, 202, 1],
    ]);
    expect(
      (
        await db.executeQuery(
          "SELECT COUNT(*) FROM ownership_children WHERE owner IS NULL AND parent_id <> 'p2'",
        )
      ).rows,
    ).toEqual([[0]]);
  });
});

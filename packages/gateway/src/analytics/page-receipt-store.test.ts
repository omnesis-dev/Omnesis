// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AnalyticsDb } from "../analytics-db.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const schema: AnalyticsTableSchema = {
  tableName: "example_page_rows",
  displayName: "Example rows",
  description: "Fictional group replacement rows",
  columns: [
    { name: "group_id", type: "VARCHAR", description: "Group" },
    { name: "id", type: "VARCHAR", description: "Row" },
  ],
  primaryKey: ["group_id", "id"],
  deleteKey: ["group_id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["group_id", "id"] },
};
let dir: string;
let db: AnalyticsDb;
const sourceId = "example:local";
const receipt = {
  pageId: "page-one",
  ordinal: 0,
  cursorRow: "member-a",
  digest: "exact-source-output",
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-page-receipt-"));
  db = new AnalyticsDb(join(dir, "rows.db"));
  await db.open();
  await db.ingestPage({
    tableName: schema.tableName,
    schema,
    sourceId,
    records: [{ group_id: "g", id: "original" }],
  });
});
afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});
const remove = () =>
  db.ingestPage({
    tableName: schema.tableName,
    sourceId,
    records: [],
    deletedKeys: [{ group_id: "g" }],
    receipt,
  });
const ids = async () =>
  (await db.executeQuery(`SELECT id FROM ${schema.tableName} ORDER BY id`)).rows.map(
    (row) => row[0],
  );

test("coarse-key destructive replay after restart preserves intervening sibling rows", async () => {
  expect((await remove()).deleted).toBe(1);
  await db.ingestPage({
    tableName: schema.tableName,
    sourceId,
    records: [{ group_id: "g", id: "sibling" }],
  });
  await db.close();
  db = new AnalyticsDb(join(dir, "rows.db"));
  await db.open();
  expect((await remove()).deleted).toBe(1); // Original result, not a new deletion.
  expect(await ids()).toEqual(["sibling"]);
});

test("a failed transaction records neither deletion nor receipt", async () => {
  await expect(
    db.ingestPage({
      tableName: schema.tableName,
      sourceId,
      records: [],
      deletedKeys: [{ group_id: "g" }],
      receipt,
      replica: {
        recordPresence: async () => {},
        judgeDeletions: async () => {
          throw new Error("injected transaction failure");
        },
      },
    }),
  ).rejects.toThrow("injected");
  expect(await ids()).toEqual(["original"]);
  expect((await remove()).deleted).toBe(1);
  expect(await ids()).toEqual([]);
});

test("a changed replay is refused before mutations; a new logical page can delete again", async () => {
  await remove();
  await db.ingestPage({
    tableName: schema.tableName,
    sourceId,
    records: [{ group_id: "g", id: "new" }],
  });
  await expect(
    db.ingestPage({
      tableName: schema.tableName,
      sourceId,
      records: [],
      deletedKeys: [{ group_id: "g" }],
      receipt: { ...receipt, digest: "changed" },
    }),
  ).rejects.toThrow("changed during replay");
  expect(await ids()).toEqual(["new"]);
  await db.ingestPage({
    tableName: schema.tableName,
    sourceId,
    records: [],
    deletedKeys: [{ group_id: "g" }],
    receipt: { ...receipt, pageId: "next-page" },
  });
  expect(await ids()).toEqual([]);
});

test("a deferred deletion is never receipted as a completed write", async () => {
  const page = {
    tableName: schema.tableName,
    sourceId,
    records: [],
    deletedKeys: [{ group_id: "g" }],
    receipt,
  };
  await db.ingestPage({
    ...page,
    replica: {
      recordPresence: async () => {},
      judgeDeletions: async () => ({ apply: [], deferred: true }),
    },
  });
  expect(await ids()).toEqual(["original"]);
  expect(
    (
      await db.ingestPage({
        ...page,
        replica: {
          recordPresence: async () => {},
          judgeDeletions: async (keys) => ({ apply: keys }),
        },
      })
    ).deleted,
  ).toBe(1);
  await expect(
    db.ingestPage({
      ...page,
      replica: {
        recordPresence: async () => {},
        judgeDeletions: async () => {
          throw new Error("must use committed receipt");
        },
      },
    }),
  ).resolves.toMatchObject({ deleted: 1 });
  expect(await ids()).toEqual([]);
});

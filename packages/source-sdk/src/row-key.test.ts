// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { encodeRowKey, rowKeyOf, RowKeyError } from "./row-key.js";
import { normalizeTableKeys, type TableWrite } from "./table-write.js";
import {
  analyticsDeleteKey,
  validateAnalyticsDeleteKeys,
  type AnalyticsTableSchema,
} from "./structured-source.js";
import { defineStructuredSource } from "./define-source.js";

/**
 * The canonical name of a row, which three ledgers store in one text column.
 * What matters is that the same row always encodes the same way, that two
 * different rows never encode alike, and that a table whose key has always
 * been one column keeps the exact strings those ledgers already hold.
 */
describe("naming a row", () => {
  test.each([null, undefined, {}, [], ["a", "b"], NaN, Infinity])(
    "rejects non-scalar or missing key value %j",
    (id) => {
      expect(() => encodeRowKey(["id"], { id })).toThrow(RowKeyError);
    },
  );
  test("a one-column key is the bare value, so stored keys keep their meaning", () => {
    expect(encodeRowKey(["id"], { id: "abc" })).toBe("abc");
    expect(encodeRowKey(["activity_id"], { activity_id: 42 })).toBe("42");
  });

  test("a key is the same however the record spells it", () => {
    const a = encodeRowKey(["item_id", "transaction_id"], { item_id: "i1", transaction_id: "t1" });
    const b = encodeRowKey(["item_id", "transaction_id"], { transaction_id: "t1", item_id: "i1" });
    expect(a).toBe(b);
  });

  test("the key's declared order decides the encoding, not the record's", () => {
    const forward = encodeRowKey(["a", "b"], { a: "1", b: "2" });
    const reversed = encodeRowKey(["b", "a"], { a: "1", b: "2" });
    expect(forward).not.toBe(reversed);
  });

  test("two rows that a joined string would confuse stay different", () => {
    // "a:b" + "c" and "a" + "b:c" join to the same thing; a key must not.
    const left = encodeRowKey(["x", "y"], { x: "a:b", y: "c" });
    const right = encodeRowKey(["x", "y"], { x: "a", y: "b:c" });
    expect(left).not.toBe(right);
  });

  test("a key that names the wrong columns is refused rather than encoded", () => {
    // Encoding a partial key would produce one that matches nothing, and an
    // extra column one the ledger holds under another name. Both are silent.
    expect(() => encodeRowKey(["item_id", "transaction_id"], { item_id: "i1" })).toThrow(
      /names \(item_id, transaction_id\)/,
    );
    expect(() =>
      encodeRowKey(["id"], { id: "a", extra: "b" } as Record<string, unknown>),
    ).toThrow();
    // The type is the classification, not the wording: the host answers a
    // client mistake as a bad request by asking what was thrown, and a plain
    // Error here would reach it as an internal failure.
    expect(() => encodeRowKey(["item_id", "transaction_id"], { item_id: "i1" })).toThrow(
      RowKeyError,
    );
    expect(() => encodeRowKey([], { id: "a" })).toThrow(RowKeyError);
  });

  test("a stored row is named by the same key its delete would carry", () => {
    const row = { item_id: "i1", transaction_id: "t1", amount: 12.5 };
    expect(rowKeyOf(["item_id", "transaction_id"], row)).toBe(
      encodeRowKey(["item_id", "transaction_id"], { item_id: "i1", transaction_id: "t1" }),
    );
  });
});

const schema = (over: Partial<AnalyticsTableSchema>): AnalyticsTableSchema =>
  ({
    tableName: "example_rows",
    displayName: "Example rows",
    description: "",
    columns: [
      { name: "group_id", type: "varchar", description: "" },
      { name: "position", type: "integer", description: "" },
      { name: "note", type: "varchar", description: "" },
    ],
    primaryKey: ["group_id", "position"],
    semanticTimeColumn: null,
    record: { titleColumns: ["note"], keyColumns: ["group_id", "position"] },
    ...over,
  }) as AnalyticsTableSchema;

describe("which columns address a table", () => {
  test("a table that declares nothing is addressed by its primary key", () => {
    expect(analyticsDeleteKey(schema({}))).toEqual(["group_id", "position"]);
  });

  test("a coarser key is how a group-addressed table is spelled", () => {
    expect(analyticsDeleteKey(schema({ deleteKey: ["group_id"] }))).toEqual(["group_id"]);
  });

  test("a key outside the primary key is a group key, and allowed", () => {
    // A source that re-reads a parent names the parent. Whether the group is
    // the right unit is a fact about the upstream, not something a validator
    // can decide — what it can check is that the column exists.
    expect(() =>
      validateAnalyticsDeleteKeys([schema({ deleteKey: ["note"] })], "test"),
    ).not.toThrow();
    expect(analyticsDeleteKey(schema({ deleteKey: ["note"] }))).toEqual(["note"]);
  });

  test("a key naming a column the table does not have is refused", () => {
    expect(() => validateAnalyticsDeleteKeys([schema({ deleteKey: ["nope"] })], "test")).toThrow(
      /does not have/,
    );
  });

  test("an empty key is refused rather than read as the primary key", () => {
    expect(() => validateAnalyticsDeleteKeys([schema({ deleteKey: [] })], "test")).toThrow(
      /empty deleteKey/,
    );
  });
});

describe("the two spellings of a page's row keys", () => {
  const write = (over: Partial<TableWrite>): TableWrite => ({ tableName: "example_rows", ...over });

  test("the older spelling becomes a one-column key", () => {
    expect(normalizeTableKeys(write({ deletedIds: ["a", "b"] }), ["id"])).toEqual({
      deletedKeys: [{ id: "a" }, { id: "b" }],
      presentKeys: undefined,
    });
  });

  test("a snapshot in the older spelling becomes keys too", () => {
    expect(normalizeTableKeys(write({ presentIds: ["a"] }), ["id"]).presentKeys).toEqual([
      { id: "a" },
    ]);
  });

  test("an empty snapshot stays an assertion, not an absent one", () => {
    // `[]` says the table holds nothing; `undefined` says nothing at all.
    expect(normalizeTableKeys(write({ presentIds: [] }), ["id"]).presentKeys).toEqual([]);
    expect(normalizeTableKeys(write({}), ["id"]).presentKeys).toBeUndefined();
  });

  test("both spellings on one write is refused, not resolved", () => {
    expect(() =>
      normalizeTableKeys(write({ deletedIds: ["a"], deletedKeys: [{ id: "a" }] }), ["id"]),
    ).toThrow(/two answers to one question/);
  });

  test("the older spelling cannot address a table with a wider key", () => {
    expect(() => normalizeTableKeys(write({ deletedIds: ["t1"] }), ["item_id", "id"])).toThrow(
      /Send deletedKeys/,
    );
  });

  test("a page keyed on a column the table does not declare is refused", () => {
    // The hazard the declaration exists for: one table addressed two ways,
    // and ledgers holding keys from both with nothing to tell them apart.
    expect(() =>
      normalizeTableKeys(write({ deletedIds: ["g1"], deleteKeyColumn: "group_id" }), ["id"]),
    ).toThrow(/belongs to the table/);
  });
});

/**
 * The validator runs where a schema is declared and again where one arrives.
 * A source can be defined in three ways and a schema can also reach the
 * gateway over the wire, so a check wired into one of those seams is a check
 * three kinds of caller walk past.
 */
describe("where a bad key is caught", () => {
  test("defining a structured source with a key the table lacks is refused", () => {
    const define = (deleteKey: string[]) =>
      defineStructuredSource({
        id: "example-rows",
        name: "Example rows",
        description: "Fictional rows",
        authType: "local",
        analyticsSchemas: [schema({ deleteKey })],
        create: async () => ({
          analyticsSchemas: [schema({ deleteKey })],
          syncStructured: async () => ({
            records: [],
            tableName: "example_rows",
            cursor: {},
            hasMore: false,
          }),
        }),
      } as unknown as Parameters<typeof defineStructuredSource>[0]);

    expect(() => define(["nope"])).toThrow(/does not have/);
    // And a key the table does have is accepted, so the refusal above is
    // about the column rather than about the fixture.
    expect(() => define(["group_id"])).not.toThrow();
  });
});

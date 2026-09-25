// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { encodeRowKey, type AnalyticsTableSchema, type ColumnType } from "@omnesis/source-sdk";
import { encodeTypedRowKeys, rowKeyExpr, rowKeySpace } from "./row-key-sql.js";
import { AnalyticsConnectionPool } from "./connection-pool.js";

/**
 * The SDK encodes a key in TypeScript; this expression produces it in SQL.
 * A difference between the two is a delete that removes nothing and an absence
 * nothing ever clears, so they are checked against each other over real rows
 * in a real DuckDB rather than against a hand-written expectation.
 */
describe("naming a stored row in SQL", () => {
  let pool: AnalyticsConnectionPool;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "omnesis-test-row-key-"));
    pool = new AnalyticsConnectionPool(join(directory, "analytics.db"));
    await pool.open(async (conn) => {
      await conn.run(
        `CREATE TABLE rows_t (item_id VARCHAR, txn_id VARCHAR, position INTEGER, note VARCHAR)`,
      );
      await conn.run(
        `INSERT INTO rows_t VALUES ('i1', 't1', 1, 'a'), ('i2', 't1', 2, 'b'),
                                   ('i1', 't2', 3, 'c'), ('i1', NULL, 4, 'd')`,
      );
    });
  });

  afterEach(async () => {
    await pool.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function keysIn(columns: string[]): Promise<string[]> {
    return pool.withConn(async ({ conn }) => {
      const reader = await conn.runAndReadAll(
        `SELECT ${rowKeyExpr(columns)} FROM rows_t ORDER BY position`,
      );
      return (reader.getRows() as unknown[][]).map((row) => String(row[0]));
    });
  }

  test("a one-column key is the bare value, matching what a ledger holds", async () => {
    expect(await keysIn(["txn_id"])).toEqual(["t1", "t1", "t2", ""]);
  });

  test("a wider key is what the SDK would have encoded", async () => {
    const fromSql = await keysIn(["item_id", "txn_id"]);
    const fromSdk = [
      { item_id: "i1", txn_id: "t1" },
      { item_id: "i2", txn_id: "t1" },
      { item_id: "i1", txn_id: "t2" },
    ].map((key) => encodeRowKey(["item_id", "txn_id"], key));
    expect(fromSql.slice(0, 3)).toEqual(fromSdk);
  });

  test("a row whose key column is NULL is still addressable", async () => {
    // SQL's NULL equals nothing, itself included, so a raw comparison would
    // leave that row unreachable by any delete or snapshot.
    const keys = await keysIn(["txn_id"]);
    expect(keys[3]).toBe("");
  });

  test("a non-text column encodes the same on both sides", async () => {
    const fromSql = await keysIn(["position"]);
    expect(fromSql).toEqual([1, 2, 3, 4].map((p) => encodeRowKey(["position"], { position: p })));
  });

  test("the expression selects exactly the row a key names", async () => {
    const key = encodeRowKey(["item_id", "txn_id"], { item_id: "i1", txn_id: "t1" });
    const notes = await pool.withConn(async ({ conn }) => {
      const reader = await conn.runAndReadAll(
        `SELECT note FROM rows_t WHERE ${rowKeyExpr(["item_id", "txn_id"])} = '${key}'`,
      );
      return (reader.getRows() as unknown[][]).map((row) => String(row[0]));
    });
    expect(notes).toEqual(["a"]);
  });

  test("a value carrying JSON's own punctuation encodes the same on both sides", async () => {
    // The two encoders escape independently — one in JavaScript, one in
    // DuckDB — so a quote, a backslash or a control character is where they
    // would quietly stop agreeing, and a key that does not match deletes
    // nothing while reporting that it did.
    const awkward = [
      { item_id: 'a"b', txn_id: "c" },
      { item_id: "a\\b", txn_id: "c" },
      { item_id: "a\nb", txn_id: "c" },
      { item_id: "héllo", txn_id: "c" },
    ];
    await pool.withConn(async ({ conn }) => {
      await conn.run("DELETE FROM rows_t");
      for (const [index, key] of awkward.entries()) {
        await conn.run(
          `INSERT INTO rows_t VALUES ('${key.item_id.replace(/'/g, "''")}', 'c', ${index}, 'x')`,
        );
      }
    });

    const fromSql = await keysIn(["item_id", "txn_id"]);
    expect(fromSql).toEqual(awkward.map((key) => encodeRowKey(["item_id", "txn_id"], key)));
  });

  test("a key space names the columns a ledger's keys were built from", () => {
    expect(rowKeySpace(["item_id", "txn_id"])).toBe("item_id,txn_id");
    expect(rowKeySpace(["id"])).toBe("id");
  });

  test("source key names cannot collide with the canonicalizer's ordering column", async () => {
    const schema: AnalyticsTableSchema = {
      tableName: "alias_keys",
      displayName: "Alias keys",
      description: "Fictional keys",
      columns: [
        { name: "_key_position", type: "VARCHAR", description: "Source key" },
        { name: "_key_value_0", type: "INTEGER", description: "Second source key" },
      ],
      primaryKey: ["_key_position", "_key_value_0"],
      semanticTimeColumn: null,
      record: { titleColumns: ["_key_position"], keyColumns: ["_key_position", "_key_value_0"] },
    };
    await pool.withConn(async ({ conn }) => {
      expect(
        await encodeTypedRowKeys(conn, schema, schema.primaryKey, [
          { _key_position: "real-id", _key_value_0: 42 },
          { _key_position: "another-id", _key_value_0: 7 },
        ]),
      ).toEqual(['["real-id","42"]', '["another-id","7"]']);
    });
  });

  test.each<[ColumnType, string | number | boolean]>([
    ["VARCHAR", "a'b"],
    ["INTEGER", 42],
    ["BIGINT", "9007199254740993"],
    ["DOUBLE", 1e-7],
    ["FLOAT", 1.2],
    ["BOOLEAN", true],
    ["DATE", "2026-01-02"],
    ["TIMESTAMP", "2026-01-02T12:34:56.123456"],
    ["TIMESTAMPTZ", "2026-01-02T14:34:56.123456+02:00"],
    ["INTERVAL", "2 days"],
    ["JSON", '{"a":1}'],
    ["VARCHAR[]", "[a, b]"],
    ["DECIMAL(18,4)", "12.3400"],
  ])("typed %s keys match stored rows without JavaScript coercion", async (type, value) => {
    const schema: AnalyticsTableSchema = {
      tableName: "typed_keys",
      displayName: "Typed keys",
      description: "Fictional rows",
      columns: [{ name: "id", type, description: "Key" }],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id"] },
    };
    await pool.withConn(async ({ conn }) => {
      await conn.run(`CREATE TABLE typed_keys (id ${type})`);
      const escaped = String(value).replaceAll("'", "''");
      await conn.run(`INSERT INTO typed_keys VALUES ('${escaped}')`);
      const stored = (await conn.runAndReadAll(`SELECT ${rowKeyExpr(["id"])} FROM typed_keys`))
        .getRows()
        .map((row) => String(row[0]));
      expect(await encodeTypedRowKeys(conn, schema, ["id"], [{ id: value }])).toEqual(stored);
    });
  });
});

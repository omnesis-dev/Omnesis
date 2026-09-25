// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Coverage for `createGatewaySqlPort` — the `run_sql` tool's gateway adapter
 * (#757, sub-issue b):
 *   - per-row record identity, surfaced ONLY when the projection exposes
 *     exactly one known table's full primary key, and round-tripping through
 *     `analyticsRowKey` / `parseAnalyticsRowKey`;
 *   - identity OMITTED for aggregates / PK-dropping projections / multi-table
 *     joins (no fabricated identity);
 *   - over-cap → a thrown `SqlPortOverCapError` (never a silent truncation).
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SqlPortNotPermittedError, SqlPortOverCapError } from "@omnesis/agent";
import { analyticsRowKey, parseAnalyticsRowKey } from "@omnesis/core";

import { AnalyticsDb } from "../analytics-db.js";
import { createGatewaySqlPort } from "./ports.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const DB = `/tmp/omnesis-test-sql-port-${randomUUID()}.db`;

// Two fictional structured sources: one with a composite primary key
// (transactions) and one single-key (positions). Invented data only.
const txnSchema: AnalyticsTableSchema = {
  tableName: "bank_transactions",
  displayName: "Bank Transactions",
  description: "Fictional bank transactions for tests",
  columns: [
    { name: "account_key", type: "VARCHAR", description: "Account id" },
    { name: "transaction_key", type: "VARCHAR", description: "Transaction id" },
    { name: "counterparty", type: "VARCHAR", description: "Who" },
    { name: "amount", type: "DOUBLE", description: "Amount" },
    { name: "booking_date", type: "TIMESTAMP", description: "Event time" },
  ],
  primaryKey: ["account_key", "transaction_key"],
  semanticTimeColumn: "booking_date",
  record: { titleColumns: ["counterparty"], keyColumns: ["counterparty", "amount"] },
};

const posSchema: AnalyticsTableSchema = {
  tableName: "bank_balances",
  displayName: "Bank Balances",
  description: "Fictional balances for tests",
  columns: [
    { name: "balance_id", type: "VARCHAR", description: "Balance id" },
    { name: "amount", type: "DOUBLE", description: "Amount" },
  ],
  primaryKey: ["balance_id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["balance_id"], keyColumns: ["balance_id", "amount"] },
};

let db: AnalyticsDb;

function cleanup(path: string): void {
  for (const suffix of ["", ".wal"]) {
    try {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    } catch {
      /* ignore */
    }
  }
}

beforeEach(async () => {
  db = new AnalyticsDb(DB);
  await db.open();
  await db.ensureTable(txnSchema, "lunchflow:local");
  await db.ensureTable(posSchema, "lunchflow:local");
  await db.insertRecords(
    "bank_transactions",
    [
      {
        account_key: "acct-1",
        transaction_key: "txn-1",
        counterparty: "Maya Reeves",
        amount: 12.5,
        booking_date: "2026-05-01T10:00:00Z",
      },
      {
        account_key: "acct-1",
        transaction_key: "txn-2",
        counterparty: "Studio Northstar",
        amount: 30,
        booking_date: "2026-05-02T10:00:00Z",
      },
    ],
    ["account_key", "transaction_key"],
  );
  await db.insertRecords("bank_balances", [{ balance_id: "bal-1", amount: 99.9 }], ["balance_id"]);
});

afterEach(async () => {
  await db.close();
  cleanup(DB);
});

describe("createGatewaySqlPort — per-row identity", () => {
  test("a full-PK projection surfaces identity that round-trips back to the row", async () => {
    const port = createGatewaySqlPort(db);
    const res = await port.run(
      "SELECT account_key, transaction_key, counterparty FROM bank_transactions ORDER BY transaction_key",
    );

    expect(res.rowIdentities).toBeDefined();
    expect(res.rowIdentities).toHaveLength(2);

    const first = res.rowIdentities![0]!;
    expect(first).not.toBeNull();
    expect(first!.table).toBe("bank_transactions");
    expect(first!.primaryKeyColumns.map((c) => c.name)).toEqual(["account_key", "transaction_key"]);
    expect(first!.primaryKeyColumns.map((c) => c.value)).toEqual(["acct-1", "txn-1"]);

    // Round-trip: recordKey ⇆ { table, primaryKeyColumns }.
    const pkString = first!.primaryKeyColumns.map((c) => c.value).join(":");
    expect(first!.recordKey).toBe(analyticsRowKey("bank_transactions", pkString));
    const parsed = parseAnalyticsRowKey(first!.recordKey);
    expect(parsed).toEqual({ table: "bank_transactions", primaryKey: pkString });
  });

  test("identity is omitted for an aggregate (no PK columns present)", async () => {
    const port = createGatewaySqlPort(db);
    const res = await port.run(
      "SELECT counterparty, COUNT(*) AS n FROM bank_transactions GROUP BY counterparty",
    );
    expect(res.rowIdentities).toBeUndefined();
  });

  test("identity is omitted when a composite-PK column is dropped from the projection", async () => {
    const port = createGatewaySqlPort(db);
    // Only one of the two PK columns is selected → no addressable identity.
    const res = await port.run("SELECT account_key, amount FROM bank_transactions");
    expect(res.rowIdentities).toBeUndefined();
  });

  test("identity is omitted for a join that surfaces two known tables' keys", async () => {
    const port = createGatewaySqlPort(db);
    const res = await port.run(
      "SELECT t.account_key, t.transaction_key, b.balance_id " +
        "FROM bank_transactions t CROSS JOIN bank_balances b",
    );
    // Both bank_transactions' full PK and bank_balances' full PK are present —
    // ambiguous which table is THE row, so neither is claimed.
    expect(res.rowIdentities).toBeUndefined();
  });

  test("a single-PK table surfaces identity too", async () => {
    const port = createGatewaySqlPort(db);
    const res = await port.run("SELECT balance_id, amount FROM bank_balances");
    expect(res.rowIdentities).toHaveLength(1);
    expect(res.rowIdentities![0]!.table).toBe("bank_balances");
    expect(res.rowIdentities![0]!.recordKey).toBe(analyticsRowKey("bank_balances", "bal-1"));
  });
});

describe("createGatewaySqlPort — row identity on a stream-keyed table", () => {
  test("identity carries the stream column, and is omitted when the projection drops it", async () => {
    await db.ingestPage({
      tableName: "bank_balances",
      records: [{ balance_id: "bal-1", amount: 5 }],
      sourceId: "lunchflow:local",
      streamId: "device-a",
    });
    const port = createGatewaySqlPort(db);
    const res = await port.run(
      "SELECT balance_id, amount, _stream_id FROM bank_balances ORDER BY _stream_id",
    );
    expect(res.rowIdentities).toHaveLength(2);
    // The shared stream's row keeps its identity: an empty stream is a value,
    // not a missing key.
    expect(res.rowIdentities![0]!.primaryKeyColumns).toEqual([
      { name: "balance_id", value: "bal-1", castType: "VARCHAR" },
      { name: "_stream_id", value: "", castType: "VARCHAR" },
    ]);
    expect(res.rowIdentities![1]!.recordKey).toBe(
      analyticsRowKey("bank_balances", "bal-1:device-a"),
    );

    const dropped = await port.run("SELECT balance_id, amount FROM bank_balances");
    expect(dropped.rowIdentities).toBeUndefined();
  });
});

describe("createGatewaySqlPort — over-cap error, never truncate", () => {
  test("a result that exceeds maxRows throws SqlPortOverCapError", async () => {
    const port = createGatewaySqlPort(db);
    await expect(
      port.run("SELECT * FROM bank_transactions", { maxRows: 1 }),
    ).rejects.toBeInstanceOf(SqlPortOverCapError);
  });

  test("a result at the cap returns cleanly and is never flagged truncated", async () => {
    const port = createGatewaySqlPort(db);
    const res = await port.run("SELECT * FROM bank_transactions", { maxRows: 2 });
    expect(res.rowCount).toBe(2);
    expect(res.truncated).toBe(false);
  });
});

describe("createGatewaySqlPort — source-scoped run_sql", () => {
  const storeSchema: AnalyticsTableSchema = {
    tableName: "other_store_events",
    displayName: "Other Store Events",
    description: "Fictional other-source events for scoping tests",
    columns: [
      { name: "event_id", type: "VARCHAR", description: "Event id" },
      { name: "note", type: "VARCHAR", description: "Note" },
    ],
    primaryKey: ["event_id"],
    semanticTimeColumn: null,
    record: { titleColumns: ["note"], keyColumns: ["event_id", "note"] },
  };

  async function scopedPort() {
    await db.ensureTable(storeSchema, "other:remote");
    await db.insertRecords(
      "other_store_events",
      [{ event_id: "ev-1", note: "sealed" }],
      ["event_id"],
    );
    return createGatewaySqlPort(db, { permittedSourceIds: new Set(["lunchflow:local"]) });
  }

  async function deniedTables(port: ReturnType<typeof createGatewaySqlPort>, sql: string) {
    const failure = await port.run(sql).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SqlPortNotPermittedError);
    return (failure as SqlPortNotPermittedError).tables;
  }

  test("a permitted table and a table-less query run", async () => {
    const port = await scopedPort();
    const res = await port.run("SELECT account_key FROM bank_transactions ORDER BY account_key");
    expect(res.rowCount).toBe(2);
    const bare = await port.run("SELECT 1 AS value");
    expect(bare.rows).toEqual([[1]]);
  });

  test("identifiers fold like DuckDB's own binder — no false refusal on case", async () => {
    const port = await scopedPort();
    const res = await port.run("SELECT COUNT(*) AS n FROM BANK_TRANSACTIONS");
    expect(res.rows).toEqual([[2]]);
    const qualified = await port.run("SELECT COUNT(*) AS n FROM main.bank_transactions");
    expect(qualified.rows).toEqual([[2]]);
  });

  test("a qualified read cannot hide behind a same-named CTE", async () => {
    const port = await scopedPort();
    // DuckDB binds `main.other_store_events` to the real table even with
    // the CTE in scope (a bare ref would see the CTE instead) — the gate
    // must report the qualified ref and deny it.
    const failure = await port
      .run("WITH other_store_events AS (SELECT 1 AS x) SELECT * FROM main.other_store_events")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(SqlPortNotPermittedError);
    expect((failure as SqlPortNotPermittedError).tables).toEqual(["main.other_store_events"]);
  });

  test("a denied table is refused before it runs, naming only that table", async () => {
    const port = await scopedPort();
    expect(await deniedTables(port, "SELECT * FROM other_store_events")).toEqual([
      "other_store_events",
    ]);
    // A join is denied the moment one side leaves the grant.
    expect(
      await deniedTables(port, "SELECT * FROM bank_transactions CROSS JOIN other_store_events"),
    ).toEqual(["other_store_events"]);
  });

  test("unknown tables, views, system schemas, and the gateway catalog are refused", async () => {
    const port = await scopedPort();
    // The gate runs before the statement binds, so a nonexistent name
    // fails exactly like a denied one — a restricted caller cannot probe
    // table existence through the error code.
    for (const sql of [
      "SELECT * FROM no_such_table",
      "SELECT * FROM information_schema.tables",
      "SELECT * FROM _analytics_catalog",
    ]) {
      const failure = await port.run(sql).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure, sql).toBeInstanceOf(SqlPortNotPermittedError);
    }
  });

  test("a bare SHOW is refused; a table-bound DESCRIBE follows its table", async () => {
    const port = await scopedPort();
    // `SHOW TABLES` lists every table with no FROM for the gate to see.
    const shown = await port.run("SELECT * FROM (SHOW TABLES) AS s").then(
      () => null,
      (error: unknown) => error,
    );
    expect(shown).toBeInstanceOf(SqlPortNotPermittedError);
    expect((shown as SqlPortNotPermittedError).shows).toEqual(["SHOW_UNQUALIFIED"]);
    // DESCRIBE embeds the table as a normal ref: permitted runs, denied refuses.
    const described = await port.run("DESCRIBE bank_transactions");
    expect(described.rowCount).toBeGreaterThan(0);
    await expect(port.run("DESCRIBE other_store_events")).rejects.toBeInstanceOf(
      SqlPortNotPermittedError,
    );
  });

  test("comments and string literals cannot smuggle — or widen — table refs", async () => {
    const port = await scopedPort();
    // The comment names a denied table; the engine parse ignores it, so this runs.
    const commented = await port.run(
      "SELECT account_key FROM bank_transactions /* FROM other_store_events */",
    );
    expect(commented.rowCount).toBe(2);
    // The literal names a denied table; it matches no row and refuses nothing.
    const literal = await port.run(
      "SELECT * FROM bank_transactions WHERE counterparty = 'FROM other_store_events'",
    );
    expect(literal.rowCount).toBe(0);
  });

  test("a CTE over permitted tables runs; a same-named shadow does not hide a denied read", async () => {
    const port = await scopedPort();
    const cte = await port.run(
      "WITH recent AS (SELECT * FROM bank_transactions) SELECT COUNT(*) AS n FROM recent",
    );
    expect(cte.rows).toEqual([[2]]);
    // The outer FROM is the real denied table; the inner WITH only shadows
    // the name inside its own subquery.
    await expect(
      port.run(
        "SELECT * FROM other_store_events WHERE EXISTS " +
          "(WITH other_store_events AS (SELECT 1 AS x) SELECT * FROM other_store_events)",
      ),
    ).rejects.toBeInstanceOf(SqlPortNotPermittedError);
  });

  test("table functions are refused for a scoped grant — even the harmless-looking ones", async () => {
    const port = await scopedPort();
    // range() touches no corpus data, but pragma_table_info(t) leaks a
    // denied table's schema through the same node shape — so the scoped
    // gate refuses the whole family instead of auditing arguments.
    for (const sql of [
      "SELECT * FROM range(3) AS r(n)",
      "SELECT * FROM pragma_table_info('other_store_events')",
    ]) {
      const failure = await port.run(sql).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure, sql).toBeInstanceOf(SqlPortNotPermittedError);
      expect((failure as SqlPortNotPermittedError).tableFunctions).toHaveLength(1);
    }
  });

  test("PIVOT, TABLESAMPLE, and LATERAL read through the same gate", async () => {
    const port = await scopedPort();
    // Shapes the extractor never special-cases: the generic recursion
    // surfaces their BASE_TABLE refs, so permitted reads run and denied
    // reads refuse.
    const pivoted = await port.run(
      "SELECT * FROM bank_transactions PIVOT (SUM(amount) FOR counterparty IN ('Maya Reeves', 'Studio Northstar'))",
    );
    // No GROUP BY: DuckDB pivots per row-key group, one row per transaction.
    expect(pivoted.rowCount).toBe(2);
    const sampled = await port.run(
      "SELECT COUNT(*) AS n FROM bank_transactions TABLESAMPLE RESERVOIR (2 ROWS) REPEATABLE (7)",
    );
    expect(sampled.rows).toEqual([[2]]);
    await expect(
      port.run("SELECT * FROM bank_transactions, LATERAL (SELECT * FROM other_store_events) AS s"),
    ).rejects.toBeInstanceOf(SqlPortNotPermittedError);
  });

  test("SUMMARIZE reads through the same gate", async () => {
    const port = await scopedPort();
    // SUMMARIZE prepares as a SELECT over the table — permitted tables
    // summarize, denied tables refuse (their statistics are data too).
    const ok = await port.run("SUMMARIZE bank_transactions");
    expect(ok.rowCount).toBeGreaterThan(0);
    await expect(port.run("SUMMARIZE other_store_events")).rejects.toBeInstanceOf(
      SqlPortNotPermittedError,
    );
  });

  test("a case-mismatched CTE fails closed toward denial", async () => {
    const port = await scopedPort();
    // DuckDB folds unquoted CTE names, but the gate compares raw parse
    // output: `recent` matches no CTE key `Recent`, so it is treated as a
    // real (unknown) table and refused. A false deny in an edge case the
    // engine itself would accept — the safe direction.
    await expect(
      port.run("WITH Recent AS (SELECT * FROM bank_transactions) SELECT * FROM recent"),
    ).rejects.toBeInstanceOf(SqlPortNotPermittedError);
  });

  test("an empty permitted set denies every table but runs table-less queries", async () => {
    await scopedPort();
    const port = createGatewaySqlPort(db, { permittedSourceIds: new Set() });
    const bare = await port.run("SELECT 1 AS value");
    expect(bare.rows).toEqual([[1]]);
    await expect(port.run("SELECT * FROM bank_transactions")).rejects.toBeInstanceOf(
      SqlPortNotPermittedError,
    );
  });

  test("the unscoped port is unchanged — it still reads every table", async () => {
    await scopedPort();
    const port = createGatewaySqlPort(db);
    const res = await port.run("SELECT event_id FROM other_store_events");
    expect(res.rows).toEqual([["ev-1"]]);
  });

  test("an empty grant learns no denied-source metadata from a comment", async () => {
    await scopedPort();
    const port = createGatewaySqlPort(db, { permittedSourceIds: new Set() });
    // The comment names a denied table. The SQL gate ignores it (no real
    // read), but the attribution regex matches it — so the catalog it is
    // looked up in must not contain denied sources.
    const res = await port.run("SELECT 1 /* FROM other_store_events */");
    expect(res.rows).toEqual([[1]]);
    expect(res.sources).toEqual([]);
    expect(res.subjects).toEqual([]);
  });

  test("an empty grant derives no identity off a denied table's key alias", async () => {
    await scopedPort();
    const port = createGatewaySqlPort(db, { permittedSourceIds: new Set() });
    // `event_id` is the denied table's whole primary key. No table is
    // read, so the gate passes — identity must not be derived from a
    // catalog the grant cannot see.
    const res = await port.run("SELECT 1 AS event_id");
    expect(res.rows).toEqual([[1]]);
    expect(res.rowIdentities).toBeUndefined();
  });

  test("a restricted grant attributes permitted tables but never denied ones", async () => {
    const port = await scopedPort();
    // Comment naming the denied table: no attribution leaks.
    const leaked = await port.run("SELECT 1 /* FROM other_store_events */");
    expect(leaked.sources).toEqual([]);
    expect(leaked.subjects).toEqual([]);
    // Permitted reads keep their full attribution and identity.
    const res = await port.run(
      "SELECT account_key, transaction_key FROM bank_transactions ORDER BY transaction_key",
    );
    expect(res.sources).toEqual([
      { sourceId: "lunchflow:local", sourceType: "lunchflow", displayName: "Lunchflow" },
    ]);
    expect(res.subjects).toEqual(["Bank Transactions"]);
    expect(res.rowIdentities).toHaveLength(2);
    expect(res.rowIdentities![0]!.table).toBe("bank_transactions");
  });

  test("the unscoped port still attributes and identifies every table", async () => {
    await scopedPort();
    const port = createGatewaySqlPort(db);
    const commented = await port.run("SELECT 1 /* FROM other_store_events */");
    expect(commented.sources?.map((s) => s.sourceId)).toEqual(["other:remote"]);
    expect(commented.subjects).toEqual(["Other Store Events"]);
    const aliased = await port.run("SELECT 1 AS event_id");
    expect(aliased.rowIdentities).toHaveLength(1);
    expect(aliased.rowIdentities![0]!.table).toBe("other_store_events");
  });
});

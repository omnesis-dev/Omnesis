// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * End-to-end coverage for the synthetic Coinbase source — Omnesis's
 * first finance source. The synth twin feeds canned multi-page Coinbase API
 * responses into the REAL provider's HTTP client, so this exercises the
 * production parse → normalize → key → ingest path, not a re-implementation.
 *
 * The headline is money exactness: every amount travels as a validated decimal
 * string into DECIMAL(38,8) (fiat) / DECIMAL(38,18) (crypto) columns and
 * aggregates through DuckDB with no cent drift. Balances and holdings are
 * point-in-time day snapshots (net-worth-over-time = GROUP BY snapshot_date);
 * orders, fills, and the v2 ledger are append-only, keyed on stable upstream
 * ids so an at-least-once re-sync neither duplicates nor destroys rows.
 *
 * Expected counts derive from the e2e-minimal Coinbase corpus: one portfolio
 * with three non-zero balances (a zero-balance DOGE wallet is skipped), three
 * holdings, three orders across two pages, two fills, and three v2 ledger
 * transactions.
 */
describe("Synthetic provider — Coinbase (first finance source)", () => {
  let harness: SyntheticE2EHarness;
  const sourceId = "coinbase:cb-portfolio-john";

  const expectedCounts: Record<string, number> = {
    coinbase_balances: 3,
    coinbase_holdings: 3,
    coinbase_orders: 3,
    coinbase_fills: 2,
    coinbase_transactions: 3,
  };

  beforeAll(async () => {
    delete process.env.OMNESIS_COINBASE_SYNTH_DAY;
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(sourceId, 60000);
    await harness.refreshSearchSnapshot();
  }, 240000);

  afterAll(async () => {
    delete process.env.OMNESIS_COINBASE_SYNTH_DAY;
    await harness.destroy();
  }, 15000);

  async function catalogCounts(): Promise<Record<string, number>> {
    const data = (await harness.gatewayJson("/analytics/catalog")) as {
      tables: Array<{ tableName: string; recordCount: number }>;
    };
    const counts: Record<string, number> = {};
    for (const t of data.tables) {
      if (t.tableName in expectedCounts) counts[t.tableName] = t.recordCount;
    }
    return counts;
  }

  async function sqlQuery(sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
    return (await harness.gatewayJson("/analytics/sql", {
      method: "POST",
      body: JSON.stringify({ sql }),
    })) as { columns: string[]; rows: unknown[][] };
  }

  async function scalar(sql: string): Promise<string> {
    const res = await sqlQuery(sql);
    return String(res.rows[0]![0]);
  }

  async function columnType(table: string, column: string): Promise<string> {
    const res = await sqlQuery(
      `SELECT data_type FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${column}'`,
    );
    expect(res.rows.length, `${table}.${column} should exist`).toBe(1);
    return String(res.rows[0]![0]);
  }

  test("analytics catalog lists every Coinbase table with exact record counts", async () => {
    expect(await catalogCounts()).toEqual(expectedCounts);
  });

  test("money columns are exact DECIMALs — fiat at scale 8, crypto at scale 18", async () => {
    expect(await columnType("coinbase_balances", "available_balance")).toBe("DECIMAL(38,18)");
    expect(await columnType("coinbase_holdings", "cost_basis")).toBe("DECIMAL(38,8)");
    expect(await columnType("coinbase_orders", "total_fees")).toBe("DECIMAL(38,8)");
    expect(await columnType("coinbase_fills", "commission")).toBe("DECIMAL(38,8)");
    expect(await columnType("coinbase_transactions", "native_amount")).toBe("DECIMAL(38,8)");
  });

  test("the SUM-exactness oracle: summing money via run_sql does not drift cents", async () => {
    // Crypto quantities: 0.50000000 + 2.0 + 1234.56 = 1237.06, exact at scale 18.
    expect(
      await scalar("SELECT CAST(SUM(available_balance) AS VARCHAR) FROM coinbase_balances"),
    ).toBe("1237.060000000000000000");

    // Holdings cost basis (fiat): 21000.55 + 4800.20 + 1234.56 = 27035.31.
    expect(await scalar("SELECT CAST(SUM(cost_basis) AS VARCHAR) FROM coinbase_holdings")).toBe(
      "27035.31000000",
    );

    // Order fees: 10.50 + 0 + 5.25 = 15.75.
    expect(await scalar("SELECT CAST(SUM(total_fees) AS VARCHAR) FROM coinbase_orders")).toBe(
      "15.75000000",
    );

    // Fill commissions: 10.50 + 5.25 = 15.75.
    expect(await scalar("SELECT CAST(SUM(commission) AS VARCHAR) FROM coinbase_fills")).toBe(
      "15.75000000",
    );

    // Ledger native value, signed: 21000.06 + 30.00 + (-500.00) = 20530.06.
    expect(
      await scalar("SELECT CAST(SUM(native_amount) AS VARCHAR) FROM coinbase_transactions"),
    ).toBe("20530.06000000");

    // A single signed debit round-trips exactly through DECIMAL.
    const sent = await sqlQuery(
      "SELECT CAST(amount AS VARCHAR), CAST(native_amount AS VARCHAR) FROM coinbase_transactions WHERE transaction_id = 'txn-3'",
    );
    expect(sent.rows[0]).toEqual(["-0.100000000000000000", "-500.00000000"]);
  });

  test("a zero-balance dust wallet is skipped from the snapshot", async () => {
    const currencies = await sqlQuery("SELECT currency FROM coinbase_balances ORDER BY currency");
    expect(currencies.rows.map((r) => String(r[0]))).toEqual(["BTC", "ETH", "USD"]);
  });

  test("balances + holdings snapshot on the pinned synth day", async () => {
    const dates = await sqlQuery(
      "SELECT DISTINCT CAST(snapshot_date AS VARCHAR) FROM coinbase_balances",
    );
    expect(dates.rows.map((r) => String(r[0]))).toEqual(["2025-12-31"]);

    // Holdings fold the same day into their composite key, so a pass that
    // straddles UTC midnight still writes one consistent snapshot.
    const holdingDates = await sqlQuery(
      "SELECT DISTINCT CAST(snapshot_date AS VARCHAR) FROM coinbase_holdings",
    );
    expect(holdingDates.rows.map((r) => String(r[0]))).toEqual(["2025-12-31"]);
  });

  test("the v2 ledger co-emits searchable transaction documents", async () => {
    const res = (await harness.gatewayJson(
      `/documents/search?q=Bought%200.5%20BTC&sources=${encodeURIComponent(sourceId)}&limit=10`,
    )) as { results?: Array<{ title: string }> };
    expect((res.results ?? []).map((d) => d.title)).toContain("Bought 0.5 BTC (0.50000000 BTC)");
  });

  test("re-syncing the same day is idempotent — counts and sums unchanged", async () => {
    await harness.triggerSyncAndWait(sourceId, 60000);
    expect(await catalogCounts()).toEqual(expectedCounts);
    expect(await scalar("SELECT CAST(SUM(cost_basis) AS VARCHAR) FROM coinbase_holdings")).toBe(
      "27035.31000000",
    );
    expect(
      await scalar("SELECT CAST(SUM(native_amount) AS VARCHAR) FROM coinbase_transactions"),
    ).toBe("20530.06000000");
  }, 120000);

  test("an at-least-once re-walk of the append-only pages neither duplicates nor destroys rows", async () => {
    // The watermark filter is inclusive at the boundary (`>=`), so a row landing
    // exactly at the cursor timestamp is re-delivered on the next walk — an
    // at-least-once delivery. The append-only tables key on the stable upstream
    // id (order_id / trade_id / transaction_id), so that re-delivery upserts the
    // identical primary key: a second full sync re-walks the pages, yet the row
    // counts hold exactly (no duplicate, no loss).
    const before = {
      orders: await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM coinbase_orders"),
      fills: await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM coinbase_fills"),
      txns: await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM coinbase_transactions"),
    };
    await harness.triggerSyncAndWait(sourceId, 60000);
    expect(await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM coinbase_orders")).toBe(
      before.orders,
    );
    expect(await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM coinbase_fills")).toBe(before.fills);
    expect(await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM coinbase_transactions")).toBe(
      before.txns,
    );
  }, 120000);

  test("net-worth-over-time: a new UTC day appends a second snapshot, history retained", async () => {
    // Roll the synth clock to a new day and re-sync: the incremental phase
    // re-runs the snapshot for the new day, appending rows rather than
    // overwriting the prior day's — point-in-time history accumulates.
    process.env.OMNESIS_COINBASE_SYNTH_DAY = "2026-01-01";
    try {
      await harness.triggerSyncAndWait(sourceId, 60000);
    } finally {
      delete process.env.OMNESIS_COINBASE_SYNTH_DAY;
    }

    // GROUP BY snapshot_date now returns BOTH days, each with the same exact
    // balance total — the net-worth-over-time query the success criterion names.
    const series = await sqlQuery(
      "SELECT CAST(snapshot_date AS VARCHAR), CAST(SUM(available_balance) AS VARCHAR) FROM coinbase_balances GROUP BY snapshot_date ORDER BY snapshot_date",
    );
    expect(series.rows).toEqual([
      ["2025-12-31", "1237.060000000000000000"],
      ["2026-01-01", "1237.060000000000000000"],
    ]);

    // The append-only tables did NOT double — the watermark kept the second
    // day's walk to only-new (here: zero) rows.
    expect(await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM coinbase_orders")).toBe("3");
    expect(await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM coinbase_transactions")).toBe("3");
  }, 120000);
});

/**
 * The ledger-grant-absent path needs its own gateway: the corpus's `v2Grant`
 * flag is baked into the fixture, so a separate run drives the synth twin with
 * the grant denied. The source must reach a healthy synced state with
 * `coinbase_transactions` empty while the other four tables populate.
 */
describe("Synthetic provider — Coinbase ledger grant absent", () => {
  let harness: SyntheticE2EHarness;
  const sourceId = "coinbase:cb-portfolio-john";

  beforeAll(async () => {
    process.env.OMNESIS_COINBASE_SYNTH_NO_LEDGER = "1";
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(sourceId, 60000);
  }, 240000);

  afterAll(async () => {
    delete process.env.OMNESIS_COINBASE_SYNTH_NO_LEDGER;
    await harness.destroy();
  }, 15000);

  /** Record counts keyed by table, read from the analytics catalog (0 when a table is absent). */
  async function catalogCounts(): Promise<Record<string, number>> {
    const data = (await harness.gatewayJson("/analytics/catalog")) as {
      tables: Array<{ tableName: string; recordCount: number }>;
    };
    const counts: Record<string, number> = {};
    for (const t of data.tables) {
      if (t.tableName.startsWith("coinbase_")) counts[t.tableName] = t.recordCount;
    }
    return counts;
  }

  test("the ledger is skipped but the source stays healthy with the other tables populated", async () => {
    const counts = await catalogCounts();

    // The four non-ledger tables populate normally.
    expect(counts.coinbase_balances).toBe(3);
    expect(counts.coinbase_holdings).toBe(3);
    expect(counts.coinbase_orders).toBe(3);
    expect(counts.coinbase_fills).toBe(2);

    // The ledger never produced a row, so its table is absent (or 0) — the grant
    // was absent and the phase degraded gracefully, it did not error.
    expect(counts.coinbase_transactions ?? 0).toBe(0);

    // The source completed (it is in sync_state, with the grant recorded absent
    // so later passes don't re-probe), not parked in an error state.
    const state = await harness.getSyncState(sourceId);
    expect(state).not.toBeNull();
    expect((state!.cursor as { ledgerUnavailable?: boolean }).ledgerUnavailable).toBe(true);
  });
});

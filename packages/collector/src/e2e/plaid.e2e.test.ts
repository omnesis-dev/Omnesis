// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * End-to-end coverage for the synthetic Plaid source — US/CA banks via
 * the Plaid aggregator. The synth twin feeds canned Plaid API responses into the
 * REAL provider's HTTP client, so this exercises the production phase machine
 * (transactions → snapshot-balances → snapshot-holdings → incremental),
 * parse → normalize → key → ingest path, not a re-implementation.
 *
 * The headline is balances + holdings as point-in-time day snapshots (balance/portfolio-over-time = GROUP BY
 * snapshot_date), with exact money. Every amount travels as a validated decimal
 * string into DECIMAL columns and aggregates through DuckDB with no cent drift.
 * The snapshot tables are append-only — a re-sync on the same day overwrites the
 * day's rows by their composite PK and emits NO deletes; a new UTC day appends a
 * fresh snapshot.
 *
 * Expected counts derive from the e2e-minimal Plaid corpus: one item with two
 * transactions, three balance accounts (checking, savings, credit card), and
 * two investment holdings.
 */
describe("Synthetic provider — Plaid (US/CA banks)", () => {
  let harness: SyntheticE2EHarness;
  const sourceId = "plaid:plaid-item-johnsmith";

  /** Expected per-table record counts from the e2e-minimal Plaid corpus. */
  const expectedCounts: Record<string, number> = {
    plaid_transactions: 2,
    plaid_balances: 3,
    plaid_holdings: 2,
  };

  beforeAll(async () => {
    delete process.env.OMNESIS_PLAID_SYNTH_DAY;
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(sourceId, 60000);
    await harness.refreshSearchSnapshot();
  }, 240000);

  afterAll(async () => {
    delete process.env.OMNESIS_PLAID_SYNTH_DAY;
    await harness.destroy();
  }, 15000);

  async function catalogCounts(): Promise<Record<string, number>> {
    const data = (await harness.gatewayJson("/analytics/catalog")) as {
      tables: Array<{ tableName: string; recordCount: number }>;
    };
    const counts: Record<string, number> = {};
    for (const t of data.tables) {
      if (t.tableName.startsWith("plaid_")) counts[t.tableName] = t.recordCount;
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

  test("analytics catalog lists every Plaid table with exact record counts", async () => {
    expect(await catalogCounts()).toEqual(expectedCounts);
  });

  test("money columns are exact DECIMALs — money at scale 2, quantities at scale 8", async () => {
    expect(await columnType("plaid_balances", "current")).toBe("DECIMAL(38,2)");
    expect(await columnType("plaid_balances", "credit_limit")).toBe("DECIMAL(38,2)");
    expect(await columnType("plaid_holdings", "institution_value")).toBe("DECIMAL(38,2)");
    expect(await columnType("plaid_holdings", "cost_basis")).toBe("DECIMAL(38,2)");
    expect(await columnType("plaid_holdings", "quantity")).toBe("DECIMAL(38,8)");
    expect(await columnType("plaid_holdings", "institution_price")).toBe("DECIMAL(38,8)");
    expect(await columnType("plaid_transactions", "amount")).toBe("DECIMAL(38,2)");
  });

  test("the SUM-exactness oracle: summing money via run_sql does not drift cents", async () => {
    // Balances current: 1620.50 + 8000.00 + 800.99 = 10421.49.
    expect(await scalar("SELECT CAST(SUM(current) AS VARCHAR) FROM plaid_balances")).toBe(
      "10421.49",
    );
    // Holdings market value: 2505.00 + 1000.50 = 3505.50.
    expect(await scalar("SELECT CAST(SUM(institution_value) AS VARCHAR) FROM plaid_holdings")).toBe(
      "3505.50",
    );
    // Holdings cost basis: 2000.00 + 900.00 = 2900.00.
    expect(await scalar("SELECT CAST(SUM(cost_basis) AS VARCHAR) FROM plaid_holdings")).toBe(
      "2900.00",
    );
    // Transactions, sign-flipped to the bank convention: a 12.34 purchase
    // (Plaid +12.34) lands as -12.34; a 50.00 deposit (Plaid -50.00) as +50.00.
    expect(await scalar("SELECT CAST(SUM(amount) AS VARCHAR) FROM plaid_transactions")).toBe(
      "37.66",
    );
  });

  test("balances + holdings snapshot on the pinned synth day", async () => {
    const balDates = await sqlQuery(
      "SELECT DISTINCT CAST(snapshot_date AS VARCHAR) FROM plaid_balances",
    );
    expect(balDates.rows.map((r) => String(r[0]))).toEqual(["2026-05-15"]);
    const holdDates = await sqlQuery(
      "SELECT DISTINCT CAST(snapshot_date AS VARCHAR) FROM plaid_holdings",
    );
    expect(holdDates.rows.map((r) => String(r[0]))).toEqual(["2026-05-15"]);
  });

  test("holdings join the security catalog — tickers and names resolve", async () => {
    const res = await sqlQuery("SELECT ticker, security_name FROM plaid_holdings ORDER BY ticker");
    expect(res.rows).toEqual([
      ["YYYY", "Northstar Growth Fund"],
      ["ZZZX", "Stellar Index Fund"],
    ]);
  });

  test("a credit-card balance keeps Plaid's sign and carries the credit limit", async () => {
    const res = await sqlQuery(
      "SELECT CAST(current AS VARCHAR), CAST(credit_limit AS VARCHAR) FROM plaid_balances WHERE account_id = 'pacct-card'",
    );
    expect(res.rows[0]).toEqual(["800.99", "5000.00"]);
  });

  test("re-syncing the same day is idempotent — snapshot counts and sums unchanged", async () => {
    // The snapshot tables key on the composite PK including snapshot_date, so a
    // same-day re-sync overwrites the day's rows (no duplicate, no delete).
    await harness.triggerSyncAndWait(sourceId, 60000);
    expect(await catalogCounts()).toEqual(expectedCounts);
    expect(await scalar("SELECT CAST(SUM(current) AS VARCHAR) FROM plaid_balances")).toBe(
      "10421.49",
    );
    expect(await scalar("SELECT CAST(SUM(institution_value) AS VARCHAR) FROM plaid_holdings")).toBe(
      "3505.50",
    );
  }, 120000);

  test("balance-over-time: a new UTC day appends a second snapshot, history retained", async () => {
    // Roll the synth clock to a new day and re-sync: the incremental phase
    // re-runs the snapshot for the new day, appending rows rather than
    // overwriting the prior day's — point-in-time history accumulates.
    process.env.OMNESIS_PLAID_SYNTH_DAY = "2026-05-16";
    try {
      await harness.triggerSyncAndWait(sourceId, 60000);
    } finally {
      delete process.env.OMNESIS_PLAID_SYNTH_DAY;
    }

    // GROUP BY snapshot_date now returns BOTH days, each with the same exact
    // balance total — the balance-over-time query the success criterion names.
    const series = await sqlQuery(
      "SELECT CAST(snapshot_date AS VARCHAR), CAST(SUM(current) AS VARCHAR) FROM plaid_balances GROUP BY snapshot_date ORDER BY snapshot_date",
    );
    expect(series.rows).toEqual([
      ["2026-05-15", "10421.49"],
      ["2026-05-16", "10421.49"],
    ]);

    // Both snapshot tables doubled (one snapshot per day); transactions did NOT
    // (the delta cursor returned an empty page — nothing new).
    expect(await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM plaid_balances")).toBe("6");
    expect(await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM plaid_holdings")).toBe("4");
    expect(await scalar("SELECT CAST(COUNT(*) AS VARCHAR) FROM plaid_transactions")).toBe("2");
  }, 120000);

  test("transactions co-emit searchable documents with the sign-flipped amount", async () => {
    const res = (await harness.gatewayJson(
      `/documents/search?q=Stellar%20Sound&sources=${encodeURIComponent(sourceId)}&limit=10`,
    )) as { results?: Array<{ title: string }> };
    expect((res.results ?? []).map((d) => d.title)).toContain("Stellar Sound — -12.34 USD");
  });

  test("the source completed and is parked in incremental (steady state)", async () => {
    const state = await harness.getSyncState(sourceId);
    expect(state).not.toBeNull();
    expect((state!.cursor as { phase?: string }).phase).toBe("incremental");
  });
});

/**
 * A deposit-only item has no investment account, so `/investments/holdings/get`
 * answers 400 `NO_INVESTMENT_ACCOUNTS`. The snapshot phase must fold that into
 * zero positions without erroring, the other tables populate, and the source
 * reaches a healthy steady state.
 */
describe("Synthetic provider — Plaid deposit-only item (holdings answers 400 NO_INVESTMENT_ACCOUNTS)", () => {
  let harness: SyntheticE2EHarness;
  const sourceId = "plaid:plaid-item-johnsmith";

  beforeAll(async () => {
    process.env.OMNESIS_PLAID_SYNTH_NO_INVESTMENTS = "1";
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(sourceId, 60000);
  }, 240000);

  afterAll(async () => {
    delete process.env.OMNESIS_PLAID_SYNTH_NO_INVESTMENTS;
    await harness.destroy();
  }, 15000);

  async function catalogCounts(): Promise<Record<string, number>> {
    const data = (await harness.gatewayJson("/analytics/catalog")) as {
      tables: Array<{ tableName: string; recordCount: number }>;
    };
    const counts: Record<string, number> = {};
    for (const t of data.tables) {
      if (t.tableName.startsWith("plaid_")) counts[t.tableName] = t.recordCount;
    }
    return counts;
  }

  test("balances + transactions populate; holdings stays empty; source healthy", async () => {
    const counts = await catalogCounts();
    expect(counts.plaid_balances).toBe(3);
    expect(counts.plaid_transactions).toBe(2);
    expect(counts.plaid_holdings ?? 0).toBe(0);

    const state = await harness.getSyncState(sourceId);
    expect(state).not.toBeNull();
    expect((state!.cursor as { phase?: string }).phase).toBe("incremental");
  });
});

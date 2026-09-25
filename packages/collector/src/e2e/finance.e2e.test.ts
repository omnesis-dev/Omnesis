// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * End-to-end coverage for the synthetic finance providers — Enable Banking
 * (Revolut via PSD2 open banking) and Lunch Flow (UK/EU banks via the
 * GoCardless aggregator). Both are hybrid structured sources: transactions
 * land as DuckDB rows AND searchable documents, while balances are
 * snapshot-only rows.
 *
 * Money discipline is the core thing under test here: every amount travels
 * the wire as a validated decimal string, lands in a DECIMAL(18,4) column,
 * and aggregates exactly (SUM over DECIMAL(18,4) widens to DECIMAL(38,4) —
 * still exact, scale-padded when stringified).
 *
 * Expected counts derive from the e2e-minimal fixtures: one Enable Banking
 * account (2 balance types, 3 transactions) and a Lunch Flow connection
 * fanning out over 2 accounts (4 transactions, 2 balances).
 */
describe("Synthetic providers — finance (Enable Banking + Lunch Flow)", () => {
  let harness: SyntheticE2EHarness;
  const ebSourceId = "enable-banking-accounts:revolut-de";
  const lunchflowSourceId = "lunchflow-accounts:default";

  /** Every finance table with its exact e2e-minimal fixture row count. */
  const expectedCounts: Record<string, number> = {
    bank_accounts: 1,
    bank_balances: 2,
    bank_transactions: 3,
    lunchflow_accounts: 2,
    lunchflow_transactions: 4,
    lunchflow_balances: 2,
  };

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "e2e-minimal" });
    await harness.start();
    await harness.triggerSyncAndWait(ebSourceId, 60000);
    await harness.triggerSyncAndWait(lunchflowSourceId, 60000);
    await harness.refreshSearchSnapshot();
  }, 240000);

  afterAll(async () => {
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

  async function columnType(table: string, column: string): Promise<string> {
    const res = await sqlQuery(
      `SELECT data_type FROM information_schema.columns WHERE table_name = '${table}' AND column_name = '${column}'`,
    );
    expect(res.rows.length, `${table}.${column} should exist`).toBe(1);
    return String(res.rows[0]![0]);
  }

  test("analytics catalog lists every finance table with exact record counts", async () => {
    expect(await catalogCounts()).toEqual(expectedCounts);
  });

  test("bank transaction amounts are exact DECIMAL(18,4) — signed, summable", async () => {
    expect(await columnType("bank_transactions", "amount")).toBe("DECIMAL(18,4)");

    // -23.40 (Riverside Grocers) + 2450.00 (salary) + 24.50 (P2P) = 2451.10.
    // SUM over DECIMAL(18,4) widens to DECIMAL(38,4) — exact, scale-padded.
    const sum = await sqlQuery("SELECT CAST(SUM(amount) AS VARCHAR) FROM bank_transactions");
    expect(sum.rows[0]![0]).toBe("2451.1000");

    // String-level DBIT negation: the fixture carries magnitude "23.40".
    const debit = await sqlQuery(
      "SELECT CAST(amount AS VARCHAR), counterparty_name FROM bank_transactions WHERE transaction_key = 'synth-eb-001'",
    );
    expect(debit.rows[0]).toEqual(["-23.4000", "Riverside Grocers"]);
  });

  test("bank balances snapshot at the pinned synth date with reference_date present", async () => {
    const res = await sqlQuery(
      "SELECT balance_type, CAST(amount AS VARCHAR), CAST(snapshot_date AS VARCHAR), CAST(reference_date AS VARCHAR) FROM bank_balances ORDER BY balance_type",
    );
    expect(res.rows).toEqual([
      ["CLBD", "3411.6200", "2025-12-31", "2025-12-30"],
      ["ITAV", "3387.1200", "2025-12-31", "2025-12-31"],
    ]);
  });

  test("lunchflow fans out over both accounts with exact, summable DECIMAL(18,4) amounts", async () => {
    expect(await columnType("lunchflow_transactions", "amount")).toBe("DECIMAL(18,4)");

    // One API key, two connected accounts (the headline of the single-instance
    // fan-out design): rows for both account_ids land in the one table.
    const accounts = await sqlQuery(
      "SELECT DISTINCT account_id FROM lunchflow_transactions ORDER BY account_id",
    );
    expect(accounts.rows.map((r) => String(r[0]))).toEqual(["481", "902"]);

    // -42.50 (groceries) + 1800 (salary) + 300 (savings) + 1.12 (interest) = 2058.62.
    const sum = await sqlQuery("SELECT CAST(SUM(amount) AS VARCHAR) FROM lunchflow_transactions");
    expect(sum.rows[0]![0]).toBe("2058.6200");

    // The aggregator already signs the amount — a money-out row stays negative,
    // no re-signing. The Lunch Flow transaction id becomes the transaction_key.
    const debit = await sqlQuery(
      "SELECT CAST(amount AS VARCHAR), merchant FROM lunchflow_transactions WHERE transaction_key = 'lf-txn-001'",
    );
    expect(debit.rows[0]).toEqual(["-42.5000", "Riverbend Market"]);
  });

  test("lunchflow null-id transaction falls back to a content-hash key", async () => {
    // The savings-interest row has no Lunch Flow id (transaction_id NULL); the
    // normalizer synthesizes a stable content-hash transaction_key so the row
    // still upserts on a stable primary key.
    const row = await sqlQuery(
      "SELECT transaction_id, transaction_key, CAST(amount AS VARCHAR) FROM lunchflow_transactions WHERE account_id = '902' AND description = 'Savings interest'",
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0]![0]).toBeNull();
    expect(String(row.rows[0]![1])).toMatch(/^[0-9a-f]{64}-\d+$/);
    expect(row.rows[0]![2]).toBe("1.1200");
  });

  test("lunchflow balances snapshot at the pinned synth date, one row per account", async () => {
    const res = await sqlQuery(
      "SELECT account_id, CAST(amount AS VARCHAR), currency, CAST(snapshot_date AS VARCHAR) FROM lunchflow_balances ORDER BY account_id",
    );
    expect(res.rows).toEqual([
      ["481", "1280.7500", "GBP", "2025-12-31"],
      ["902", "5250.0000", "GBP", "2025-12-31"],
    ]);
  });

  test("transaction documents are searchable for both sources", async () => {
    const eb = (await harness.gatewayJson(
      `/documents/search?q=Riverside%20Grocers&sources=${encodeURIComponent(ebSourceId)}&limit=10`,
    )) as { results?: Array<{ title: string }> };
    expect((eb.results ?? []).map((d) => d.title)).toContain("Riverside Grocers — -23.40 EUR");

    const lunchflow = (await harness.gatewayJson(
      `/documents/search?q=Riverbend%20Market&sources=${encodeURIComponent(lunchflowSourceId)}&limit=10`,
    )) as { results?: Array<{ title: string }> };
    expect((lunchflow.results ?? []).map((d) => d.title)).toContain("Riverbend Market — -42.5 GBP");
  });

  test("re-syncing all sources is idempotent — counts and sums unchanged", async () => {
    await harness.triggerSyncAndWait(ebSourceId, 60000);
    await harness.triggerSyncAndWait(lunchflowSourceId, 60000);
    expect(await catalogCounts()).toEqual(expectedCounts);
    const eb = await sqlQuery("SELECT CAST(SUM(amount) AS VARCHAR) FROM bank_transactions");
    expect(eb.rows[0]![0]).toBe("2451.1000");
    const lunchflow = await sqlQuery(
      "SELECT CAST(SUM(amount) AS VARCHAR) FROM lunchflow_transactions",
    );
    expect(lunchflow.rows[0]![0]).toBe("2058.6200");
  }, 150000);

  test("the enable-banking instance is labelled as the connected bank", async () => {
    // The per-instance label override travels collector → gateway on the
    // sync meta push and surfaces in the portal's source-meta map.
    const meta = (await harness.gatewayJson("/portal/source-meta.json")) as Record<
      string,
      { label?: string }
    >;
    expect(meta[ebSourceId]?.label).toBe("Revolut");
  });
});

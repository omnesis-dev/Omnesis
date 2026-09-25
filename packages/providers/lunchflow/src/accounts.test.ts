// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { LunchflowAccountsSource } from "./accounts.js";
import { LunchflowAccountGoneError } from "./client.js";
import { validateLunchflowCursor } from "./types.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";
import type { GetTransactionsParams, LunchflowTransport } from "./client.js";
import type {
  LunchflowAccount,
  LunchflowBalance,
  LunchflowCursor,
  LunchflowTransaction,
} from "./types.js";

const PROVIDER_ID = ProviderId("lunchflow:default");
const SOURCE_ID = SourceId("lunchflow-accounts:default");
const CLOCK = () => new Date("2026-06-18T09:00:00.000Z");

const ACCT_481: LunchflowAccount = {
  id: 481,
  name: "Everyday Current",
  institution_name: "Northstar Bank",
  institution_logo: null,
  provider: "gocardless",
  currency: "GBP",
  status: "ACTIVE",
};
const ACCT_902: LunchflowAccount = {
  id: 902,
  name: "Rainy Day Saver",
  institution_name: "Riverside Building Society",
  institution_logo: null,
  provider: "gocardless",
  currency: "GBP",
  status: "ACTIVE",
};

function tx(id: string | null, date: string, amount: number): LunchflowTransaction {
  return { id, accountId: 481, amount, currency: "GBP", date, merchant: "Shop", isPending: false };
}

class FakeClient implements LunchflowTransport {
  accounts: LunchflowAccount[] = [];
  transactionsByAccount = new Map<string, LunchflowTransaction[]>();
  balancesByAccount = new Map<string, LunchflowBalance>();
  goneAccounts = new Set<string>();
  transactionsCalls: Array<{ accountId: string; params?: GetTransactionsParams }> = [];
  balanceCalls: string[] = [];

  async listAccounts(): Promise<LunchflowAccount[]> {
    return this.accounts;
  }
  async getTransactions(
    accountId: string,
    params?: GetTransactionsParams,
  ): Promise<LunchflowTransaction[]> {
    this.transactionsCalls.push({ accountId, params });
    if (this.goneAccounts.has(accountId)) throw new LunchflowAccountGoneError(accountId);
    return this.transactionsByAccount.get(accountId) ?? [];
  }
  async getBalance(accountId: string): Promise<LunchflowBalance> {
    this.balanceCalls.push(accountId);
    if (this.goneAccounts.has(accountId)) throw new LunchflowAccountGoneError(accountId);
    return this.balancesByAccount.get(accountId) ?? { amount: 0, currency: "GBP" };
  }
}

type Page = StructuredSyncResult<LunchflowCursor>;

function makeSource(
  client: LunchflowTransport,
  opts: { dataCutoff?: string } = {},
): LunchflowAccountsSource {
  return new LunchflowAccountsSource(client, PROVIDER_ID, SOURCE_ID, "lunchflow-testaccount", {
    now: CLOCK,
    ...opts,
  });
}

async function runTick(
  source: LunchflowAccountsSource,
  cursor: LunchflowCursor | null,
): Promise<{ pages: Page[]; cursor: LunchflowCursor | null }> {
  const pages: Page[] = [];
  let current = cursor;
  for (let i = 0; i < 50; i++) {
    const page = await source.syncStructured(current);
    pages.push(page);
    current = page.cursor;
    if (!page.hasMore) return { pages, cursor: current };
  }
  throw new Error("tick did not terminate within 50 pages");
}

function recordsFor(pages: Page[], table: string): Record<string, unknown>[] {
  return pages.flatMap((p) => rowsFor(p, table));
}

function makeFullClient(): FakeClient {
  const client = new FakeClient();
  client.accounts = [ACCT_481, ACCT_902];
  client.transactionsByAccount.set("481", [
    tx("a", "2025-06-20", -42.5),
    tx("b", "2025-06-25", 1800),
  ]);
  client.transactionsByAccount.set("902", [tx("c", "2025-06-18", 300)]);
  client.balancesByAccount.set("481", { amount: 1280.75, currency: "GBP" });
  client.balancesByAccount.set("902", { amount: 5250, currency: "GBP" });
  return client;
}

describe("validateLunchflowCursor", () => {
  test("accepts known phases; garbage resolves to null (sync restarts cleanly)", () => {
    expect(validateLunchflowCursor(null)).toBeNull();
    expect(validateLunchflowCursor({ phase: "transactions" })).toEqual({ phase: "transactions" });
    expect(validateLunchflowCursor({ phase: "nonsense" })).toBeNull();
    expect(validateLunchflowCursor({})).toBeNull();
  });
});

describe("accounts phase", () => {
  test("first page emits one lunchflow_accounts row per account and advances to transactions", async () => {
    const client = makeFullClient();
    const page = await makeSource(client).syncStructured(null);
    expect(tablesWritten(page)).toEqual(["lunchflow_accounts"]);
    expect(rowsFor(page, "lunchflow_accounts")).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.cursor.phase).toBe("transactions");
    expect(page.cursor.accounts?.map((a) => a.id)).toEqual(["481", "902"]);
  });

  test("a DISCONNECTED account still gets its row but is not fanned out", async () => {
    const client = makeFullClient();
    client.accounts = [ACCT_481, { ...ACCT_902, status: "DISCONNECTED" }];
    await runTick(makeSource(client), null);
    // 902 is disconnected → never fetched.
    expect(client.transactionsCalls.map((c) => c.accountId)).toEqual(["481"]);
    expect(client.balanceCalls).toEqual(["481"]);
  });
});

describe("full tick (bootstrap)", () => {
  test("fans out transactions + balances across all accounts", async () => {
    const client = makeFullClient();
    const { pages, cursor } = await runTick(makeSource(client), null);

    expect(recordsFor(pages, "lunchflow_accounts")).toHaveLength(2);
    expect(recordsFor(pages, "lunchflow_transactions")).toHaveLength(3);
    expect(recordsFor(pages, "lunchflow_balances")).toHaveLength(2);

    const docs = pages.flatMap((p) => p.documents ?? []);
    expect(docs).toHaveLength(3);
    expect(docs.map((d) => d.externalId).sort()).toEqual(["481:a", "481:b", "902:c"]);

    // Bootstrap fetched full history (no `from`) for both accounts.
    expect(client.transactionsCalls.map((c) => c.params?.from)).toEqual([undefined, undefined]);

    // The tick ends with per-account watermarks and today's balance date.
    expect(cursor?.phase).toBe("accounts");
    expect(cursor?.lastDates).toEqual({ "481": "2025-06-25", "902": "2025-06-18" });
    expect(cursor?.lastBalancesDate).toBe("2026-06-18");
  });

  test("honors the data cutoff on the first backfill", async () => {
    const client = makeFullClient();
    const source = makeSource(client, { dataCutoff: "2025-06-21T00:00:00.000Z" });
    const { pages } = await runTick(source, null);
    // 481: keeps b (06-25), drops a (06-20<cutoff); 902: drops c (06-18<cutoff).
    expect(recordsFor(pages, "lunchflow_transactions")).toHaveLength(1);
  });
});

describe("incremental tick", () => {
  test("re-fetches each account from lastDate − overlap and skips same-day balances", async () => {
    const client = makeFullClient();
    const source = makeSource(client);
    const first = await runTick(source, null);
    client.transactionsCalls.length = 0;
    client.balanceCalls.length = 0;

    const { pages } = await runTick(source, first.cursor);
    // 481 lastDate 2025-06-25 → from 2025-06-18; 902 lastDate 2025-06-18 → from 2025-06-11.
    expect(client.transactionsCalls).toEqual([
      { accountId: "481", params: { from: "2025-06-18", includePending: false } },
      { accountId: "902", params: { from: "2025-06-11", includePending: false } },
    ]);
    // Balances already snapshotted today → not re-fetched, no balance page.
    expect(client.balanceCalls).toEqual([]);
    expect(recordsFor(pages, "lunchflow_balances")).toHaveLength(0);
  });
});

describe("resilience", () => {
  test("an account that 404s mid-tick is skipped, the rest continue", async () => {
    const client = makeFullClient();
    client.goneAccounts.add("902");
    const { pages } = await runTick(makeSource(client), null);
    // Only 481's transactions + balance survive; 902 skipped on both phases.
    expect(recordsFor(pages, "lunchflow_transactions")).toHaveLength(2);
    expect(recordsFor(pages, "lunchflow_balances")).toHaveLength(1);
    expect((recordsFor(pages, "lunchflow_balances")[0] as { account_id: string }).account_id).toBe(
      "481",
    );
  });

  test("an empty connection ends the tick after the accounts page", async () => {
    const client = new FakeClient();
    client.accounts = [];
    const { pages, cursor } = await runTick(makeSource(client), null);
    expect(pages).toHaveLength(1);
    // No accounts fetched at all — an empty write carries nothing, so the
    // page's analytics field is empty rather than naming lunchflow_accounts
    // with 0 rows.
    expect(tablesWritten(pages[0])).toEqual([]);
    expect(cursor?.phase).toBe("accounts");
  });

  test("an account whose balance has no amount emits no balance row but the tick still completes", async () => {
    const client = makeFullClient();
    client.balancesByAccount.set("902", { amount: null, currency: "GBP" });
    const { pages, cursor } = await runTick(makeSource(client), null);
    // 481's balance lands; 902's is skipped (logged), not fatal.
    const balances = recordsFor(pages, "lunchflow_balances");
    expect(balances).toHaveLength(1);
    expect((balances[0] as { account_id: string }).account_id).toBe("481");
    // Both accounts were still visited and the tick finished cleanly.
    expect(client.balanceCalls).toEqual(["481", "902"]);
    expect(cursor?.phase).toBe("accounts");
    expect(cursor?.lastBalancesDate).toBe("2026-06-18");
  });
});

describe("account currency backfill", () => {
  test("learns a null-currency account's currency from its money, applied the next cycle", async () => {
    const client = new FakeClient();
    // Mirror Lunch Flow's real /accounts: no account-level currency at all.
    client.accounts = [{ ...ACCT_481, currency: null }];
    client.transactionsByAccount.set("481", [tx("a", "2025-06-20", -42.5)]); // currency GBP
    client.balancesByAccount.set("481", { amount: 1280.75, currency: "GBP" });
    const source = makeSource(client);

    const tick1 = await runTick(source, null);
    // First cycle: the account row has no currency yet (none was known)…
    const acct1 = recordsFor(tick1.pages, "lunchflow_accounts");
    expect((acct1[0] as { currency: string | null }).currency).toBeNull();
    // …but the cycle learned it from the transactions/balance.
    expect(tick1.cursor?.currencies).toEqual({ "481": "GBP" });

    // Second cycle: the accounts phase stamps the learned currency onto the row.
    const tick2 = await runTick(source, tick1.cursor);
    const acct2 = recordsFor(tick2.pages, "lunchflow_accounts");
    expect((acct2[0] as { currency: string | null }).currency).toBe("GBP");
  });
});

describe("per-UTC-day balance gating", () => {
  test("a new UTC day re-snapshots balances, accruing a second row per account", async () => {
    const client = makeFullClient();
    // Day 1: full tick snapshots balances at 2026-06-18.
    const first = await runTick(makeSource(client), null);
    expect(first.cursor?.lastBalancesDate).toBe("2026-06-18");
    client.balanceCalls.length = 0;

    // Day 2: a fresh clock one day later — balancesDue flips true again.
    const day2 = () => new Date("2026-06-19T09:00:00.000Z");
    const source2 = new LunchflowAccountsSource(
      client,
      PROVIDER_ID,
      SOURCE_ID,
      "lunchflow-testaccount",
      { now: day2 },
    );
    const { pages, cursor } = await runTick(source2, first.cursor);

    // Balances re-fetched for every account, on the new snapshot_date.
    expect(client.balanceCalls).toEqual(["481", "902"]);
    const balances = recordsFor(pages, "lunchflow_balances");
    expect(balances).toHaveLength(2);
    expect(
      balances.every((b) => (b as { snapshot_date: string }).snapshot_date === "2026-06-19"),
    ).toBe(true);
    // The [account_id, snapshot_date] PK accrues daily history rather than overwriting.
    expect(cursor?.lastBalancesDate).toBe("2026-06-19");
  });
});

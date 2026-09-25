// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { clearSecretFileKeyCacheForTests, ensureInstallRootKey } from "@omnesis/core";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { rowsFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { EnableBankingAccountsSource, minusDays, utcDateOf } from "./accounts.js";
import {
  bootstrapAccountDir,
  bootstrapRootDir,
  completedBootstrapMarker,
  markBootstrapComplete,
  saveSession,
  writeBootstrapPage,
} from "./session.js";
import { validateEnableBankingCursor } from "./types.js";
import type { EnableBankingTransport, GetTransactionsParams } from "./client.js";
import type {
  EbBalance,
  EbTransaction,
  EbTransactionsPage,
  EnableBankingCursor,
  StoredSession,
} from "./types.js";

const providerId = ProviderId("enable-banking:revolut-de");
const sourceId = SourceId("enable-banking-accounts:revolut-de");
const ACCOUNT_ID = "revolut-de";
const NOW = new Date("2026-06-01T08:00:00.000Z");

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    session_id: "sess-1",
    valid_until: "2026-11-28T00:00:00.000Z",
    aspsp: { name: "Revolut", country: "DE" },
    accounts: [
      {
        account_key: "hash-eur",
        uid: "uid-eur-1",
        iban: "DE89975713758667268881",
        currency: "EUR",
        name: "Main EUR",
        cash_account_type: "CACC",
        product: null,
      },
      {
        account_key: "hash-usd",
        uid: "uid-usd-1",
        iban: "DE84813465346925806408",
        currency: "USD",
        name: "USD pocket",
        cash_account_type: "CACC",
        product: null,
      },
    ],
    ...overrides,
  };
}

function txn(overrides: Partial<EbTransaction> = {}): EbTransaction {
  return {
    entry_reference: "ref-1",
    booking_date: "2026-05-03",
    transaction_amount: { currency: "EUR", amount: "23.40" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    creditor: { name: "Northstar Hardware" },
    remittance_information: ["Shelf brackets"],
    ...overrides,
  };
}

class FakeClient implements EnableBankingTransport {
  balancesCalls: string[] = [];
  transactionsCalls: Array<{ uid: string; params: GetTransactionsParams }> = [];
  balancesByUid = new Map<string, EbBalance[]>();
  /** Queue of pages per uid; the last entry is returned once the queue drains. */
  transactionPagesByUid = new Map<string, EbTransactionsPage[]>();

  async getBalances(uid: string): Promise<EbBalance[]> {
    this.balancesCalls.push(uid);
    return this.balancesByUid.get(uid) ?? [];
  }

  async getTransactions(
    uid: string,
    params: GetTransactionsParams = {},
  ): Promise<EbTransactionsPage> {
    this.transactionsCalls.push({ uid, params });
    const queue = this.transactionPagesByUid.get(uid);
    if (!queue || queue.length === 0) return { transactions: [] };
    return queue.length > 1 ? queue.shift()! : queue[0];
  }
}

let configDir: string;
let client: FakeClient;

function makeSource(opts: { now?: () => Date; dataCutoff?: string } = {}) {
  return new EnableBankingAccountsSource(client, providerId, sourceId, ACCOUNT_ID, {
    now: opts.now ?? (() => NOW),
    configDir,
    dataCutoff: opts.dataCutoff,
  });
}

/** Run syncStructured until hasMore=false; returns all pages. */
async function runTick(source: EnableBankingAccountsSource, cursor: EnableBankingCursor | null) {
  const pages = [];
  let current = cursor;
  for (let i = 0; i < 50; i++) {
    const page = await source.syncStructured(current);
    pages.push(page);
    current = page.cursor;
    if (!page.hasMore) return { pages, cursor: current };
  }
  throw new Error("tick did not terminate within 50 pages");
}

beforeEach(async () => {
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  clearSecretFileKeyCacheForTests();
  configDir = mkdtempSync(join(tmpdir(), "omnesis-eb-test-"));
  await ensureInstallRootKey({ configDir, backend: "file" });
  client = new FakeClient();
  saveSession(ACCOUNT_ID, makeSession(), configDir);
});

afterEach(() => {
  clearSecretFileKeyCacheForTests();
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

describe("cursor validator", () => {
  test("accepts known phases; garbage resolves to null (sync restarts cleanly)", () => {
    expect(validateEnableBankingCursor(null)).toBeNull();
    expect(validateEnableBankingCursor({ phase: "incremental" })).toEqual({
      phase: "incremental",
    });
    expect(validateEnableBankingCursor({ phase: "nonsense" })).toBeNull();
    expect(validateEnableBankingCursor("garbage")).toBeNull();
    expect(validateEnableBankingCursor(42)).toBeNull();
  });
});

describe("phase: accounts", () => {
  test("first page emits bank_accounts rows keyed by account_key with the slug discriminator", async () => {
    const source = makeSource();
    const page = await source.syncStructured(null);
    expect(tablesWritten(page)).toEqual(["bank_accounts"]);
    expect(page.hasMore).toBe(true);
    expect(rowsFor(page, "bank_accounts")).toHaveLength(2);
    expect(rowsFor(page, "bank_accounts")[0]).toMatchObject({
      account_key: "hash-eur",
      source_account_id: ACCOUNT_ID,
      bank_name: "Revolut",
      country: "DE",
      uid: "uid-eur-1",
      iban_masked: "DE…8881",
    });
    expect(page.cursor.phase).toBe("bootstrap");
  });

  test("a missing session surfaces as SyncError auth", async () => {
    rmSync(join(configDir, "enable-banking", ACCOUNT_ID, "session.json"), { force: true });
    const source = makeSource();
    await expect(source.syncStructured(null)).rejects.toMatchObject({
      name: "SyncError",
      kind: "auth",
    });
  });
});

describe("phase: bootstrap", () => {
  test("drains the prefetched cache pages without network calls", async () => {
    // Account 1: two cached pages; account 2: one cached page.
    const dirEur = bootstrapAccountDir(ACCOUNT_ID, "hash-eur", configDir);
    writeBootstrapPage(dirEur, 0, {
      transactions: [txn(), txn({ entry_reference: "ref-2", booking_date: "2026-05-04" })],
    });
    writeBootstrapPage(dirEur, 1, {
      transactions: [txn({ entry_reference: "ref-3", booking_date: "2026-05-10" })],
    });
    markBootstrapComplete(dirEur, 2, "sess-1");
    const dirUsd = bootstrapAccountDir(ACCOUNT_ID, "hash-usd", configDir);
    writeBootstrapPage(dirUsd, 0, {
      transactions: [
        txn({
          entry_reference: "ref-u1",
          booking_date: "2026-05-08",
          transaction_amount: { currency: "USD", amount: "10.00" },
        }),
      ],
    });
    markBootstrapComplete(dirUsd, 1, "sess-1");

    const source = makeSource();
    const { pages, cursor } = await runTick(source, null);

    // No transaction API calls — the cache covered the bootstrap.
    expect(client.transactionsCalls).toHaveLength(0);
    const txnPages = pages.filter((p) => tablesWritten(p).includes("bank_transactions"));
    const allRecords = txnPages.flatMap((p) => rowsFor(p, "bank_transactions"));
    expect(allRecords).toHaveLength(4);
    // Documents ride the transaction pages.
    expect(txnPages.flatMap((p) => p.documents ?? [])).toHaveLength(4);
    // Watermarks promoted per account.
    expect(cursor?.lastBookingDates).toEqual({
      "hash-eur": "2026-05-10",
      "hash-usd": "2026-05-08",
    });
    expect(cursor?.phase).toBe("incremental");
    // The drained raw history was deleted when the balances phase ran.
    expect(existsSync(bootstrapRootDir(ACCOUNT_ID, configDir))).toBe(false);
    // The epoch never leaks past the bootstrap phase.
    expect(cursor?.bootstrapSessionId).toBeUndefined();
    // ASPSPs are not required to hand over an account's complete lifetime
    // even in the post-SCA capture window, so a cache-drained page never
    // vouches for "complete" history.
    expect(txnPages.every((p) => p.progress?.coverage === "unknown")).toBe(true);
    // How far each account's walk reached has to survive the bootstrap that
    // recorded it — every account's walk ends on the same cursor return, so
    // that return dropping the field made the whole record inert while every
    // test that injected it still passed.
    expect(cursor?.bootstrapReach).toEqual({ "hash-eur": "full", "hash-usd": "full" });
    // Each account speaks for itself, so a claim about one cannot be taken as
    // the connection's.
    expect(new Set(txnPages.map((p) => p.progress?.coverageSubject))).toEqual(
      new Set(["hash-eur", "hash-usd"]),
    );
  });

  test("falls back to a 90-day network window when no complete cache exists", async () => {
    client.transactionPagesByUid.set("uid-eur-1", [
      {
        transactions: [txn()],
        continuation_key: "ck-1",
      },
      { transactions: [txn({ entry_reference: "ref-2", booking_date: "2026-05-20" })] },
    ]);
    client.transactionPagesByUid.set("uid-usd-1", [{ transactions: [] }]);

    const source = makeSource();
    const { pages, cursor } = await runTick(source, null);

    // Paginated via continuation_key: two calls for EUR, one for USD.
    const eurCalls = client.transactionsCalls.filter((c) => c.uid === "uid-eur-1");
    expect(eurCalls).toHaveLength(2);
    expect(eurCalls[0].params.dateFrom).toBe(minusDays(utcDateOf(NOW), 90));
    expect(eurCalls[0].params.continuationKey).toBeUndefined();
    expect(eurCalls[1].params.continuationKey).toBe("ck-1");
    // Booked-only on every call.
    for (const call of client.transactionsCalls) {
      expect(call.params.transactionStatus).toBe("BOOK");
    }
    expect(cursor?.lastBookingDates?.["hash-eur"]).toBe("2026-05-20");
    // The fallback window is a known gap, not an uncertain one — the source
    // knows exactly what it left out (everything before dateFrom).
    const txnPages = pages.filter((p) => tablesWritten(p).includes("bank_transactions"));
    expect(txnPages.every((p) => p.progress?.coverage === "partial")).toBe(true);
  });

  test("an interrupted prefetch (pages but no marker) counts as absent cache", async () => {
    const dirEur = bootstrapAccountDir(ACCOUNT_ID, "hash-eur", configDir);
    writeBootstrapPage(dirEur, 0, { transactions: [txn()] });
    // No markBootstrapComplete — sync must take the network path.
    client.transactionPagesByUid.set("uid-eur-1", [{ transactions: [] }]);
    client.transactionPagesByUid.set("uid-usd-1", [{ transactions: [] }]);

    const source = makeSource();
    await runTick(source, null);
    expect(client.transactionsCalls.filter((c) => c.uid === "uid-eur-1")).toHaveLength(1);
  });

  test("a corrupt cache preserves full history and refuses network fallback", async () => {
    const dir = bootstrapAccountDir(ACCOUNT_ID, "hash-eur", configDir);
    writeBootstrapPage(dir, 0, { transactions: [txn()] });
    writeBootstrapPage(dir, 1, { transactions: [txn({ entry_reference: "ref-2" })] });
    markBootstrapComplete(dir, 2, "sess-1");
    writeFileSync(join(dir, "page-0001.json"), "{ truncated", { mode: 0o600 });

    await expect(runTick(makeSource(), null)).rejects.toThrow();
    expect(existsSync(join(dir, "page-0000.json"))).toBe(true);
    expect(existsSync(join(dir, "page-0001.json"))).toBe(true);
    expect(completedBootstrapMarker(dir)).toEqual({ pages: 2, sessionId: "sess-1" });
    expect(client.transactionsCalls).toEqual([]);
  });

  test("a cache rewritten by a re-consent mid-drain restarts the bootstrap walk from the first account", async () => {
    // Consent "sess-2" replaced the session and re-prefetched both caches.
    const replaced = makeSession({ session_id: "sess-2" });
    saveSession(ACCOUNT_ID, replaced, configDir);
    const dirEur = bootstrapAccountDir(ACCOUNT_ID, "hash-eur", configDir);
    writeBootstrapPage(dirEur, 0, { transactions: [txn({ entry_reference: "ref-e0" })] });
    writeBootstrapPage(dirEur, 1, { transactions: [txn({ entry_reference: "ref-e1" })] });
    markBootstrapComplete(dirEur, 2, "sess-2");
    const dirUsd = bootstrapAccountDir(ACCOUNT_ID, "hash-usd", configDir);
    writeBootstrapPage(dirUsd, 0, { transactions: [txn({ entry_reference: "ref-u0" })] });
    markBootstrapComplete(dirUsd, 1, "sess-2");

    // The persisted cursor was minted against the OLD cache (epoch sess-1):
    // accountIndex/cachePageIndex point into renumbered pages.
    const staleCursor: EnableBankingCursor = {
      phase: "bootstrap",
      accountIndex: 1,
      cachePageIndex: 1,
      bootstrapSessionId: "sess-1",
      lastBookingDates: {},
    };

    const source = makeSource();
    const page = await source.syncStructured(staleCursor);

    // Restarted at account 0 page 0 of the NEW cache.
    expect(rowsFor(page, "bank_transactions").map((r) => r.transaction_key)).toEqual(["ref-e0"]);
    expect(page.cursor).toMatchObject({
      phase: "bootstrap",
      accountIndex: 0,
      cachePageIndex: 1,
      bootstrapSessionId: "sess-2",
    });

    // The remainder of the walk drains both accounts cleanly.
    const { pages } = await runTick(source, page.cursor);
    const keys = pages
      .flatMap((p) => rowsFor(p, "bank_transactions"))
      .map((r) => r.transaction_key);
    expect(keys).toEqual(expect.arrayContaining(["ref-e1", "ref-u0"]));
    expect(client.transactionsCalls).toHaveLength(0);
  });

  test("a cache left behind by a previous consent is invalidated, not drained", async () => {
    // session.json carries sess-1, but the cache was prefetched under an
    // older consent that no longer exists.
    const dirEur = bootstrapAccountDir(ACCOUNT_ID, "hash-eur", configDir);
    writeBootstrapPage(dirEur, 0, { transactions: [txn({ entry_reference: "ref-old" })] });
    markBootstrapComplete(dirEur, 1, "sess-0");
    client.transactionPagesByUid.set("uid-eur-1", [
      { transactions: [txn({ entry_reference: "ref-net" })] },
    ]);
    client.transactionPagesByUid.set("uid-usd-1", [{ transactions: [] }]);

    const source = makeSource();
    const { pages } = await runTick(source, null);

    const keys = pages
      .flatMap((p) => rowsFor(p, "bank_transactions"))
      .map((r) => r.transaction_key);
    expect(keys).toContain("ref-net");
    expect(keys).not.toContain("ref-old");
    expect(completedBootstrapMarker(dirEur)).toBeNull();
    const eurCall = client.transactionsCalls.find((c) => c.uid === "uid-eur-1");
    expect(eurCall?.params.dateFrom).toBe(minusDays(utcDateOf(NOW), 90));
  });

  test("a stale continuation key on the network fallback restarts the window without the key", async () => {
    const failing = new (class extends FakeClient {
      override async getTransactions(
        uid: string,
        params: GetTransactionsParams = {},
      ): Promise<EbTransactionsPage> {
        this.transactionsCalls.push({ uid, params });
        if (params.continuationKey) {
          throw new SyncError("unknown", "Enable Banking request failed (HTTP 400).");
        }
        return uid === "uid-eur-1"
          ? { transactions: [txn({ booking_date: "2026-05-20" })] }
          : { transactions: [] };
      }
    })();
    const source = new EnableBankingAccountsSource(failing, providerId, sourceId, ACCOUNT_ID, {
      now: () => NOW,
      configDir,
    });

    // Persisted mid-window cursor whose continuation key died with the old session.
    const staleCursor: EnableBankingCursor = {
      phase: "bootstrap",
      accountIndex: 0,
      continuationKey: "ck-stale",
      windowMaxBookingDate: "2026-05-10",
      windowHashCounts: { abc: 2 },
      lastBookingDates: {},
    };

    const restartPage = await source.syncStructured(staleCursor);
    expect(rowsFor(restartPage, "bank_transactions")).toEqual([]);
    expect(restartPage.hasMore).toBe(true);
    expect(restartPage.cursor.continuationKey).toBeUndefined();
    expect(restartPage.cursor.windowMaxBookingDate).toBeUndefined();
    expect(restartPage.cursor.windowHashCounts).toBeUndefined();
    expect(restartPage.cursor).toMatchObject({ phase: "bootstrap", accountIndex: 0 });

    // The next page restarts the window from its date_from with no key.
    const retryPage = await source.syncStructured(restartPage.cursor);
    const retryCall = failing.transactionsCalls.at(-1);
    expect(retryCall?.params.continuationKey).toBeUndefined();
    expect(retryCall?.params.dateFrom).toBe(minusDays(utcDateOf(NOW), 90));
    expect(rowsFor(retryPage, "bank_transactions").map((r) => r.transaction_key)).toEqual([
      "ref-1",
    ]);
  });
});

describe("phase: balances → incremental", () => {
  test("the initial balances snapshot stamps the UTC fetch date and ends the tick", async () => {
    client.balancesByUid.set("uid-eur-1", [
      {
        balance_type: "CLBD",
        balance_amount: { currency: "EUR", amount: "1250.00" },
        reference_date: "2026-05-31",
      },
    ]);
    const source = makeSource();
    const { pages, cursor } = await runTick(source, null);

    const balancePage = pages.find((p) => tablesWritten(p).includes("bank_balances"));
    expect(balancePage).toBeDefined();
    expect(balancePage!.hasMore).toBe(false);
    expect(rowsFor(balancePage!, "bank_balances")[0]).toMatchObject({
      snapshot_date: "2026-06-01",
      account_key: "hash-eur",
      amount: "1250.00",
    });
    expect(cursor?.phase).toBe("incremental");
    expect(cursor?.lastBalancesDate).toBe("2026-06-01");
  });
});

describe("phase: incremental", () => {
  /** Cursor as it looks after a completed bootstrap tick. */
  function incrementalCursor(overrides: Partial<EnableBankingCursor> = {}): EnableBankingCursor {
    return {
      phase: "incremental",
      lastBookingDates: { "hash-eur": "2026-05-25", "hash-usd": "2026-05-20" },
      lastBalancesDate: "2026-06-01",
      ...overrides,
    };
  }

  test("same UTC day: transactions only, with the 7-day overlap window", async () => {
    const source = makeSource();
    const { pages } = await runTick(source, incrementalCursor());

    expect(client.balancesCalls).toHaveLength(0);
    expect(pages.every((p) => tablesWritten(p).every((t) => t === "bank_transactions"))).toBe(true);
    const eurCall = client.transactionsCalls.find((c) => c.uid === "uid-eur-1");
    expect(eurCall?.params.dateFrom).toBe("2026-05-18"); // 2026-05-25 − 7d
    const usdCall = client.transactionsCalls.find((c) => c.uid === "uid-usd-1");
    expect(usdCall?.params.dateFrom).toBe("2026-05-13"); // 2026-05-20 − 7d
    for (const call of client.transactionsCalls) {
      expect(call.params.transactionStatus).toBe("BOOK");
    }
  });

  test("first tick of a new UTC day refreshes accounts + balances before transactions", async () => {
    const nextDay = new Date("2026-06-02T07:00:00.000Z");
    const source = makeSource({ now: () => nextDay });
    const { pages, cursor } = await runTick(source, incrementalCursor());

    expect(tablesWritten(pages[0])).toEqual(["bank_accounts"]);
    // The balances phase ran (client.balancesCalls below), but the FakeClient
    // has no balances queued — an empty write carries nothing, so the page's
    // analytics field is empty rather than naming bank_balances with 0 rows.
    expect(tablesWritten(pages[1])).toEqual([]);
    expect(client.balancesCalls).toEqual(["uid-eur-1", "uid-usd-1"]);
    expect(cursor?.lastBalancesDate).toBe("2026-06-02");
    // Remaining pages are per-account transactions.
    expect(
      pages.slice(2).every((p) => tablesWritten(p).every((t) => t === "bank_transactions")),
    ).toBe(true);
  });

  test("snapshot idempotency: same-day re-syncs reuse the snapshot_date PK; a new day adds a row", async () => {
    client.balancesByUid.set("uid-eur-1", [
      { balance_type: "CLBD", balance_amount: { currency: "EUR", amount: "1250.00" } },
    ]);

    // Two syncs on day 2: only the first fetches balances.
    const day2 = new Date("2026-06-02T07:00:00.000Z");
    const source = makeSource({ now: () => day2 });
    const run1 = await runTick(source, incrementalCursor());
    const run2 = await runTick(source, run1.cursor ?? null);
    expect(client.balancesCalls.filter((u) => u === "uid-eur-1")).toHaveLength(1);
    const day2Snapshot = rowsFor(
      run1.pages.find((p) => tablesWritten(p).includes("bank_balances"))!,
      "bank_balances",
    )[0];
    expect(day2Snapshot.snapshot_date).toBe("2026-06-02");
    expect(run2.pages.find((p) => tablesWritten(p).includes("bank_balances"))).toBeUndefined();

    // Day 3: a new snapshot row (different PK date) is produced.
    const day3 = new Date("2026-06-03T07:00:00.000Z");
    const source3 = makeSource({ now: () => day3 });
    const run3 = await runTick(source3, run2.cursor ?? null);
    const day3Snapshot = rowsFor(
      run3.pages.find((p) => tablesWritten(p).includes("bank_balances"))!,
      "bank_balances",
    )[0];
    expect(day3Snapshot.snapshot_date).toBe("2026-06-03");
    expect(day3Snapshot.account_key).toBe(day2Snapshot.account_key);
    expect(day3Snapshot.balance_type).toBe(day2Snapshot.balance_type);
  });

  test("continuation pages keep the account window open and promote the watermark at the end", async () => {
    client.transactionPagesByUid.set("uid-eur-1", [
      { transactions: [txn({ booking_date: "2026-05-30" })], continuation_key: "ck-9" },
      { transactions: [txn({ entry_reference: "ref-2", booking_date: "2026-06-01" })] },
    ]);
    const source = makeSource();
    const { cursor } = await runTick(source, incrementalCursor());

    const eurCalls = client.transactionsCalls.filter((c) => c.uid === "uid-eur-1");
    expect(eurCalls).toHaveLength(2);
    expect(eurCalls[1].params.continuationKey).toBe("ck-9");
    expect(cursor?.lastBookingDates?.["hash-eur"]).toBe("2026-06-01");
    // Transient window state cleared at tick end.
    expect(cursor?.continuationKey).toBeUndefined();
    expect(cursor?.incrementalAccountIndex).toBeUndefined();
    expect(cursor?.windowHashCounts).toBeUndefined();
  });

  test("a stale continuation key drops the key and restarts the account window", async () => {
    const failing = new (class extends FakeClient {
      override async getTransactions(
        uid: string,
        params: GetTransactionsParams = {},
      ): Promise<EbTransactionsPage> {
        this.transactionsCalls.push({ uid, params });
        if (params.continuationKey) {
          throw new SyncError("unknown", "Enable Banking request failed (HTTP 400).");
        }
        return { transactions: [txn({ booking_date: "2026-05-30" })] };
      }
    })();
    const source = new EnableBankingAccountsSource(failing, providerId, sourceId, ACCOUNT_ID, {
      now: () => NOW,
      configDir,
    });

    const staleCursor = incrementalCursor({
      incStage: "transactions",
      incrementalAccountIndex: 0,
      continuationKey: "ck-dead",
      windowMaxBookingDate: "2026-05-27",
      windowHashCounts: { abc: 1 },
    });

    const restartPage = await source.syncStructured(staleCursor);
    expect(rowsFor(restartPage, "bank_transactions")).toEqual([]);
    expect(restartPage.hasMore).toBe(true);
    expect(restartPage.cursor.continuationKey).toBeUndefined();
    expect(restartPage.cursor.windowMaxBookingDate).toBeUndefined();
    expect(restartPage.cursor.windowHashCounts).toBeUndefined();
    expect(restartPage.cursor).toMatchObject({
      phase: "incremental",
      incStage: "transactions",
      incrementalAccountIndex: 0,
    });
    // Watermarks survive untouched — the window will re-cover from date_from.
    expect(restartPage.cursor.lastBookingDates).toEqual(staleCursor.lastBookingDates);

    // The next page restarts the same account's window from its date_from.
    const retryPage = await source.syncStructured(restartPage.cursor);
    const retryCall = failing.transactionsCalls.at(-1);
    expect(retryCall?.uid).toBe("uid-eur-1");
    expect(retryCall?.params.continuationKey).toBeUndefined();
    expect(retryCall?.params.dateFrom).toBe("2026-05-18"); // 2026-05-25 − 7d
    expect(rowsFor(retryPage, "bank_transactions")).toHaveLength(1);
  });

  test("an unknown failure WITHOUT a continuation key still propagates", async () => {
    const failing = new (class extends FakeClient {
      override async getTransactions(): Promise<EbTransactionsPage> {
        throw new SyncError("unknown", "Enable Banking request failed (HTTP 400).");
      }
    })();
    const source = new EnableBankingAccountsSource(failing, providerId, sourceId, ACCOUNT_ID, {
      now: () => NOW,
      configDir,
    });
    await expect(source.syncStructured(incrementalCursor())).rejects.toMatchObject({
      kind: "unknown",
    });
  });

  test("an auth failure on a continuation request keeps its auth routing", async () => {
    const failing = new (class extends FakeClient {
      override async getTransactions(): Promise<EbTransactionsPage> {
        throw new SyncError("auth", "Enable Banking rejected the request (HTTP 401).");
      }
    })();
    const source = new EnableBankingAccountsSource(failing, providerId, sourceId, ACCOUNT_ID, {
      now: () => NOW,
      configDir,
    });
    await expect(
      source.syncStructured(
        incrementalCursor({
          incStage: "transactions",
          incrementalAccountIndex: 0,
          continuationKey: "ck-dead",
        }),
      ),
    ).rejects.toMatchObject({ kind: "auth" });
  });

  test("session replacement re-maps account_key → uid without changing identity", async () => {
    const source = makeSource();
    await runTick(source, incrementalCursor());
    expect(client.transactionsCalls[0].uid).toBe("uid-eur-1");

    // Re-consent: same account_keys, brand-new session uids.
    const replaced = makeSession();
    replaced.session_id = "sess-2";
    replaced.accounts[0].uid = "uid-eur-NEW";
    replaced.accounts[1].uid = "uid-usd-NEW";
    saveSession(ACCOUNT_ID, replaced, configDir);

    client.transactionsCalls = [];
    client.transactionPagesByUid.set("uid-eur-NEW", [
      { transactions: [txn({ entry_reference: "ref-new", booking_date: "2026-06-01" })] },
    ]);
    const source2 = makeSource();
    const { pages, cursor } = await runTick(source2, incrementalCursor());

    // API calls use the NEW uid; records keep the SAME account_key PK.
    expect(client.transactionsCalls[0].uid).toBe("uid-eur-NEW");
    const record = pages
      .flatMap((p) => rowsFor(p, "bank_transactions"))
      .find((r) => r.transaction_key === "ref-new");
    expect(record?.account_key).toBe("hash-eur");
    // Watermarks stay keyed by account_key — no duplication.
    expect(Object.keys(cursor?.lastBookingDates ?? {})).toEqual(["hash-eur", "hash-usd"]);
  });

  test("an account first seen mid-life (no watermark) uses the 90-day fallback window", async () => {
    const source = makeSource();
    const { pages } = await runTick(
      source,
      incrementalCursor({ lastBookingDates: { "hash-eur": "2026-05-25" } }),
    );
    const usdCall = client.transactionsCalls.find((c) => c.uid === "uid-usd-1");
    expect(usdCall?.params.dateFrom).toBe(minusDays(utcDateOf(NOW), 90));
    // The watermarked EUR account (processed first) makes no coverage claim;
    // the un-watermarked USD account (processed last, ending the tick)
    // reports the known fallback gap.
    expect(pages[0].progress).toBeUndefined();
    expect(pages.at(-1)?.progress?.coverage).toBe("partial");
  });

  test("an account that simply holds no transactions is not a failed full-history capture", async () => {
    // The dormant account never acquires a watermark, because there was never
    // a booking date to promote. Before the reach was recorded that was
    // indistinguishable from the 90-day fallback, so a bank whose prefetch
    // worked perfectly reported, on every tick forever, that it had not.
    const source = makeSource();
    const { pages } = await runTick(
      source,
      incrementalCursor({
        lastBookingDates: { "hash-eur": "2026-05-25" },
        bootstrapReach: { "hash-eur": "full", "hash-usd": "full" },
      }),
    );
    for (const page of pages) expect(page.progress?.coverage).toBeUndefined();
  });

  test("an account the fallback truncated still says so, tick after tick", async () => {
    const source = makeSource();
    const { pages } = await runTick(
      source,
      incrementalCursor({
        lastBookingDates: { "hash-eur": "2026-05-25", "hash-usd": "2026-05-20" },
        bootstrapReach: { "hash-eur": "full", "hash-usd": "window" },
      }),
    );
    // The watermark alone would have silenced this one — it has a booking date.
    expect(pages.some((p) => p.progress?.coverage === "partial")).toBe(true);
  });

  test("a 429 from the client propagates as SyncError rate-limit without cursor corruption", async () => {
    const failing = new (class extends FakeClient {
      override async getTransactions(): Promise<EbTransactionsPage> {
        throw new SyncError("rate-limit", "cap reached", { retryAfterMs: 6 * 3600 * 1000 });
      }
    })();
    const source = new EnableBankingAccountsSource(failing, providerId, sourceId, ACCOUNT_ID, {
      now: () => NOW,
      configDir,
    });
    await expect(source.syncStructured(incrementalCursor())).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 6 * 3600 * 1000,
    });
  });

  test("malformed amounts skip the single record, not the page", async () => {
    client.transactionPagesByUid.set("uid-eur-1", [
      {
        transactions: [
          txn(),
          txn({
            entry_reference: "ref-bad",
            transaction_amount: { currency: "EUR", amount: "not-a-number" },
          }),
        ],
      },
    ]);
    const source = makeSource();
    const { pages } = await runTick(source, incrementalCursor());
    const keys = pages
      .flatMap((p) => rowsFor(p, "bank_transactions"))
      .map((r) => r.transaction_key);
    expect(keys).toContain("ref-1");
    expect(keys).not.toContain("ref-bad");
  });

  test("dataCutoff filters old transactions before they reach records", async () => {
    client.transactionPagesByUid.set("uid-eur-1", [
      {
        transactions: [
          txn({ booking_date: "2026-05-30" }),
          txn({ entry_reference: "ref-old", booking_date: "2024-01-01" }),
        ],
      },
    ]);
    const source = makeSource({ dataCutoff: "2026-01-01T00:00:00.000Z" });
    const { pages } = await runTick(source, incrementalCursor());
    const keys = pages
      .flatMap((p) => rowsFor(p, "bank_transactions"))
      .map((r) => r.transaction_key);
    expect(keys).toContain("ref-1");
    expect(keys).not.toContain("ref-old");
  });
});

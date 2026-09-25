// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { deletionsFor, rowsFor, tablesWritten, writesFor } from "@omnesis/source-sdk/testing";
import { ProviderId, SourceId } from "@omnesis/types";
import { PlaidApiError } from "./client.js";
import {
  balanceAccountToRecord,
  balanceAccountsToRecords,
  holdingToRecord,
  holdingsToRecords,
} from "./normalizer.js";
import { PlaidSyncSource } from "./sync.js";
import { plaidBalancesSchema, plaidHoldingsSchema, plaidTransactionsSchema } from "./schemas.js";
import type {
  PlaidAccountsGetResponse,
  PlaidBalanceAccount,
  PlaidHolding,
  PlaidInvestmentsHoldingsGetResponse,
  PlaidSecurity,
  PlaidTransactionsSyncResponse,
} from "./schemas.js";
import type { LinkTokenCreateParams, PlaidTransport, TransactionsSyncParams } from "./client.js";

const PROVIDER_ID = ProviderId("plaid:item-1");
const SOURCE_ID = SourceId("plaid:item-1");
const ITEM_ID = "item-1";
const ACCESS_TOKEN = "access-sandbox-1";
const DAY = "2026-05-15";
const NEXT_DAY = "2026-05-16";

function balanceAccount(overrides: Partial<PlaidBalanceAccount> = {}): PlaidBalanceAccount {
  return {
    account_id: "acct-checking",
    name: "Everyday Checking",
    type: "depository",
    subtype: "checking",
    balances: {
      available: 1500.25,
      current: 1620.5,
      limit: null,
      iso_currency_code: "USD",
    },
    ...overrides,
  };
}

function holding(overrides: Partial<PlaidHolding> = {}): PlaidHolding {
  return {
    account_id: "acct-invest",
    security_id: "sec-zzzx",
    quantity: 10,
    institution_price: 250.5,
    institution_value: 2505,
    cost_basis: 2000,
    iso_currency_code: "USD",
    ...overrides,
  };
}

function security(overrides: Partial<PlaidSecurity> = {}): PlaidSecurity {
  return {
    security_id: "sec-zzzx",
    ticker_symbol: "ZZZX",
    name: "Stellar Index Fund",
    type: "etf",
    iso_currency_code: "USD",
    ...overrides,
  };
}

describe("balance normalization", () => {
  test("renders exact money, account labels, and currency; pins the snapshot date", () => {
    const rec = balanceAccountToRecord(balanceAccount(), { itemId: ITEM_ID, snapshotDate: DAY });
    expect(rec).toEqual({
      snapshot_date: DAY,
      item_id: ITEM_ID,
      account_id: "acct-checking",
      account_name: "Everyday Checking",
      account_type: "depository",
      account_subtype: "checking",
      available: "1500.25",
      current: "1620.50",
      credit_limit: null,
      currency: "USD",
    });
  });

  test("a credit-card current balance keeps Plaid's sign (amount owed is positive), limit carried", () => {
    const rec = balanceAccountToRecord(
      balanceAccount({
        account_id: "acct-card",
        name: "Rewards Card",
        type: "credit",
        subtype: "credit card",
        balances: { available: 4200, current: 800.99, limit: 5000, iso_currency_code: "USD" },
      }),
      { itemId: ITEM_ID, snapshotDate: DAY },
    );
    expect(rec.current).toBe("800.99");
    expect(rec.credit_limit).toBe("5000.00");
  });

  test("a null balance figure maps to null (never NaN), unofficial currency falls back", () => {
    const rec = balanceAccountToRecord(
      balanceAccount({
        balances: {
          available: null,
          current: null,
          iso_currency_code: null,
          unofficial_currency_code: "BTC",
        },
      }),
      { itemId: ITEM_ID, snapshotDate: DAY },
    );
    expect(rec.available).toBeNull();
    expect(rec.current).toBeNull();
    expect(rec.currency).toBe("BTC");
  });

  test("official_name is the label fallback when name is absent", () => {
    const rec = balanceAccountToRecord(
      balanceAccount({ name: null, official_name: "PREMIER CHECKING ACCOUNT" }),
      { itemId: ITEM_ID, snapshotDate: DAY },
    );
    expect(rec.account_name).toBe("PREMIER CHECKING ACCOUNT");
  });

  test("every account in a response folds onto the same pinned day", () => {
    const recs = balanceAccountsToRecords(
      [balanceAccount(), balanceAccount({ account_id: "acct-savings", name: "Savings" })],
      { itemId: ITEM_ID, snapshotDate: DAY },
    );
    expect(recs.map((r) => r.snapshot_date)).toEqual([DAY, DAY]);
    expect(recs.map((r) => r.account_id)).toEqual(["acct-checking", "acct-savings"]);
  });
});

describe("holding normalization", () => {
  test("joins the security, renders exact quantity/price/value/cost-basis, pins the day", () => {
    const rec = holdingToRecord(holding(), security(), { itemId: ITEM_ID, snapshotDate: DAY });
    expect(rec).toEqual({
      snapshot_date: DAY,
      item_id: ITEM_ID,
      account_id: "acct-invest",
      security_id: "sec-zzzx",
      ticker: "ZZZX",
      security_name: "Stellar Index Fund",
      security_type: "etf",
      quantity: "10.00000000",
      institution_price: "250.50000000",
      institution_value: "2505.00",
      cost_basis: "2000.00",
      currency: "USD",
    });
  });

  test("an unresolved security leaves the display columns null but still records the position", () => {
    const rec = holdingToRecord(holding(), undefined, { itemId: ITEM_ID, snapshotDate: DAY });
    expect(rec.ticker).toBeNull();
    expect(rec.security_name).toBeNull();
    expect(rec.security_id).toBe("sec-zzzx");
    expect(rec.institution_value).toBe("2505.00");
  });

  test("holdingsToRecords resolves each holding's security by id", () => {
    const recs = holdingsToRecords(
      [holding(), holding({ security_id: "sec-cash", account_id: "acct-invest" })],
      [
        security(),
        security({ security_id: "sec-cash", ticker_symbol: null, name: "Cash", type: "cash" }),
      ],
      { itemId: ITEM_ID, snapshotDate: DAY },
    );
    expect(recs[0].ticker).toBe("ZZZX");
    expect(recs[1].security_name).toBe("Cash");
    expect(recs.map((r) => r.snapshot_date)).toEqual([DAY, DAY]);
  });
});

/**
 * A scripted transport for the phase machine. Snapshot endpoints return canned
 * responses and count calls; the transactions delta returns one empty page so
 * the machine reaches `incremental`.
 */
class PhaseTransport implements PlaidTransport {
  balanceCalls = 0;
  holdingsCalls = 0;
  itemGetCalls = 0;
  txnCalls: TransactionsSyncParams[] = [];

  constructor(
    private readonly balances: PlaidAccountsGetResponse,
    private readonly holdings: PlaidInvestmentsHoldingsGetResponse,
    /** `string` = a deadline, `null` = never-expires, `"throw"` = read fails. */
    private readonly consentExpiration: string | null | "throw" = null,
    /** When set, `/investments/holdings/get` rejects with this error. */
    private readonly holdingsError?: Error,
  ) {}

  accountsGet(): Promise<PlaidAccountsGetResponse> {
    this.balanceCalls += 1;
    return Promise.resolve(this.balances);
  }
  investmentsHoldingsGet(): Promise<PlaidInvestmentsHoldingsGetResponse> {
    this.holdingsCalls += 1;
    if (this.holdingsError) return Promise.reject(this.holdingsError);
    return Promise.resolve(this.holdings);
  }
  transactionsSync(params: TransactionsSyncParams): Promise<PlaidTransactionsSyncResponse> {
    this.txnCalls.push({ ...params });
    return Promise.resolve({
      added: [],
      modified: [],
      removed: [],
      next_cursor: "cursor-end",
      has_more: false,
    });
  }
  linkTokenCreate(_p: LinkTokenCreateParams): Promise<never> {
    throw new Error("not used");
  }
  itemPublicTokenExchange(): Promise<never> {
    throw new Error("not used");
  }
  itemRemove(): Promise<never> {
    throw new Error("not used");
  }
  linkTokenGet(): Promise<never> {
    throw new Error("not used");
  }
  institutionGetById(): Promise<never> {
    throw new Error("not used");
  }
  itemGet(): Promise<{ item: { item_id: string; consent_expiration_time?: string | null } }> {
    this.itemGetCalls += 1;
    if (this.consentExpiration === "throw") {
      return Promise.reject(new Error("item/get failed"));
    }
    return Promise.resolve({
      item: { item_id: ITEM_ID, consent_expiration_time: this.consentExpiration },
    });
  }
}

function makeTransport(consentExpiration: string | null | "throw" = null): PhaseTransport {
  return new PhaseTransport(
    {
      accounts: [balanceAccount(), balanceAccount({ account_id: "acct-savings", name: "Savings" })],
    },
    { holdings: [holding()], securities: [security()] },
    consentExpiration,
  );
}

function makeSync(transport: PlaidTransport, now: () => Date): PlaidSyncSource {
  return new PlaidSyncSource(transport, PROVIDER_ID, SOURCE_ID, ITEM_ID, ACCESS_TOKEN, {
    institutionName: "Northstar Bank",
    now,
  });
}

const NOW = (): Date => new Date(`${DAY}T12:00:00.000Z`);

describe("PlaidSyncSource — phase machine", () => {
  test("a fresh item drains transactions first, then snapshots ONE pinned day", async () => {
    // Transactions run first because they are the corpus: a snapshot leg
    // reaches the institution and can fail on a bank outage, and ordering it
    // first would hold the item's whole history behind a bad afternoon.
    const transport = makeTransport();
    const source = makeSync(transport, NOW);

    const t = await source.syncStructured(null);
    expect(tablesWritten(t)).toEqual([plaidTransactionsSchema.tableName]);
    expect(t.cursor.phase).toBe("snapshot-balances");
    expect(t.hasMore).toBe(true);

    const b = await source.syncStructured(t.cursor);
    expect(tablesWritten(b)).toEqual([plaidBalancesSchema.tableName]);
    expect(rowsFor(b, plaidBalancesSchema.tableName)).toHaveLength(2);
    expect(rowsFor(b, plaidBalancesSchema.tableName).every((r) => r.snapshot_date === DAY)).toBe(
      true,
    );
    expect(b.cursor.phase).toBe("snapshot-holdings");
    expect(b.cursor.snapshotDate).toBe(DAY);

    const h = await source.syncStructured(b.cursor);
    expect(tablesWritten(h)).toEqual([plaidHoldingsSchema.tableName]);
    expect(rowsFor(h, plaidHoldingsSchema.tableName)).toHaveLength(1);
    expect(rowsFor(h, plaidHoldingsSchema.tableName)[0].snapshot_date).toBe(DAY);
    expect(h.cursor.phase).toBe("incremental");
    expect(h.cursor.snapshotDate).toBeUndefined();
    expect(h.cursor.lastSnapshotDate).toBe(DAY);
    expect(h.hasMore).toBe(false);

    expect(transport.balanceCalls).toBe(1);
    expect(transport.holdingsCalls).toBe(1);
  });

  test("snapshot phases emit NO deletes — append-only by composite PK", async () => {
    const transport = makeTransport();
    const source = makeSync(transport, NOW);

    const t = await source.syncStructured(null);
    const b = await source.syncStructured(t.cursor);
    expect(deletionsFor(b, plaidBalancesSchema.tableName)).toEqual([]);
    expect(writesFor(b, plaidBalancesSchema.tableName)[0]?.deletedKeys).toBeUndefined();
    expect(b.deletedExternalIds).toBeUndefined();

    const h = await source.syncStructured(b.cursor);
    expect(deletionsFor(h, plaidHoldingsSchema.tableName)).toEqual([]);
    expect(writesFor(h, plaidHoldingsSchema.tableName)[0]?.deletedKeys).toBeUndefined();
    expect(h.deletedExternalIds).toBeUndefined();
  });

  test("the pinned day does NOT drift across the pass even when the clock advances", async () => {
    let t = 0;
    const clock = (): Date => new Date(t === 0 ? `${DAY}T23:59:59Z` : `${NEXT_DAY}T00:00:01Z`);
    const transport = makeTransport();
    const source = makeSync(transport, () => {
      const d = clock();
      t += 1;
      return d;
    });
    const txn = await source.syncStructured(null);
    const b = await source.syncStructured(txn.cursor);
    const h = await source.syncStructured(b.cursor);
    // Both snapshot legs write the day the balances leg pinned.
    expect(rowsFor(b, plaidBalancesSchema.tableName)[0].snapshot_date).toBe(b.cursor.snapshotDate);
    expect(rowsFor(h, plaidHoldingsSchema.tableName)[0].snapshot_date).toBe(b.cursor.snapshotDate);
  });

  test("incremental idles on the same day and re-snapshots once the UTC day rolls", async () => {
    const transport = makeTransport();
    let day = DAY;
    const source = makeSync(transport, () => new Date(`${day}T12:00:00Z`));

    // Walk a fresh item to its idle state.
    let r = await source.syncStructured(null);
    r = await source.syncStructured(r.cursor);
    r = await source.syncStructured(r.cursor);
    expect(r.cursor.phase).toBe("incremental");
    const snapshotsAfterFirstPass = transport.balanceCalls;

    // Same day: the tick polls the delta and idles again, no new snapshot.
    r = await source.syncStructured(r.cursor);
    expect(tablesWritten(r)).toEqual([plaidTransactionsSchema.tableName]);
    expect(r.cursor.phase).toBe("incremental");
    expect(r.hasMore).toBe(false);
    expect(transport.balanceCalls).toBe(snapshotsAfterFirstPass);

    // New day: the delta poll hands off to a fresh snapshot pass.
    day = NEXT_DAY;
    r = await source.syncStructured(r.cursor);
    expect(r.cursor.phase).toBe("snapshot-balances");
    expect(r.hasMore).toBe(true);
    r = await source.syncStructured(r.cursor);
    expect(transport.balanceCalls).toBe(snapshotsAfterFirstPass + 1);
    expect(
      rowsFor(r, plaidBalancesSchema.tableName).every((row) => row.snapshot_date === NEXT_DAY),
    ).toBe(true);
  });

  test("an item with investment access but no positions snapshots zero rows", async () => {
    const transport = new PhaseTransport(
      { accounts: [balanceAccount()] },
      { holdings: [], securities: [] },
    );
    const source = makeSync(transport, NOW);
    const t = await source.syncStructured(null);
    const b = await source.syncStructured(t.cursor);
    const h = await source.syncStructured(b.cursor);
    expect(rowsFor(h, plaidHoldingsSchema.tableName)).toHaveLength(0);
    expect(h.cursor.phase).toBe("incremental");
    expect(h.cursor.lastSnapshotDate).toBe(DAY);
  });

  test.each(["NO_INVESTMENT_ACCOUNTS", "PRODUCTS_NOT_SUPPORTED"])(
    "a deposit-only item (%s) snapshots zero positions and still completes the pass",
    async (code) => {
      // `investments` is an optional product, so this is the common case; a
      // failure here would wedge the phase machine.
      const transport = new PhaseTransport(
        { accounts: [balanceAccount()] },
        { holdings: [], securities: [] },
        null,
        new PlaidApiError("unknown", `Plaid request failed (HTTP 400) (${code}).`, {
          errorCode: code,
        }),
      );
      const source = makeSync(transport, NOW);
      const t = await source.syncStructured(null);
      const b = await source.syncStructured(t.cursor);
      const h = await source.syncStructured(b.cursor);
      expect(rowsFor(h, plaidHoldingsSchema.tableName)).toHaveLength(0);
      expect(h.cursor.phase).toBe("incremental");
      expect(h.cursor.lastSnapshotDate).toBe(DAY);
    },
  );

  test("a bank outage costs the day's snapshot, not the transactions already ingested", async () => {
    // The snapshot legs are tolerant: the run advances past a failing leg and
    // retries it on the next scheduled sync.
    const transport = new PhaseTransport(
      { accounts: [balanceAccount()] },
      { holdings: [], securities: [] },
      null,
      new PlaidApiError("transient", "Plaid could not reach the bank right now.", {
        errorCode: "INSTITUTION_DOWN",
      }),
    );
    const source = makeSync(transport, NOW);
    const t = await source.syncStructured(null);
    expect(tablesWritten(t)).toEqual([plaidTransactionsSchema.tableName]);
    const b = await source.syncStructured(t.cursor);
    const h = await source.syncStructured(b.cursor);
    expect(rowsFor(h, plaidHoldingsSchema.tableName)).toHaveLength(0);
    expect(h.cursor.phase).toBe("incremental");
  });
});

// Forward-looking consent-expiry. The balances phase — which opens every
// snapshot pass — reads `/item/get` once per pass and reports the item's
// `consent_expiration_time` as `consentExpiresAt` on its result. The collector
// forwards it to the gateway, which persists it and derives the non-terminal
// `auth-expiring` warning. Only the balances phase reports it (the per-pass
// cadence); the other phases leave it `undefined` (keep the stored value).
describe("PlaidSyncSource — consent-expiry reporting", () => {
  test("the balances phase reports the item's consent deadline once per pass", async () => {
    const deadline = "2026-08-01T00:00:00Z";
    const transport = makeTransport(deadline);
    const source = makeSync(transport, NOW);

    const t0 = await source.syncStructured(null);
    const b = await source.syncStructured(t0.cursor);
    expect(b.consentExpiresAt).toBe(deadline);
    expect(transport.itemGetCalls).toBe(1);

    // Holdings + transactions do NOT re-read consent — `undefined` keeps the
    // stored deadline rather than re-querying every page.
    const h = await source.syncStructured(b.cursor);
    expect(h.consentExpiresAt).toBeUndefined();
    const t = await source.syncStructured(h.cursor);
    expect(t.consentExpiresAt).toBeUndefined();
    expect(transport.itemGetCalls).toBe(1);
  });

  test("a never-expiring item reports null (clears any prior deadline)", async () => {
    const transport = makeTransport(null);
    const source = makeSync(transport, NOW);
    const t0 = await source.syncStructured(null);
    const b = await source.syncStructured(t0.cursor);
    expect(b.consentExpiresAt).toBeNull();
  });

  test("a failed /item/get reports undefined — the snapshot still succeeds", async () => {
    const transport = makeTransport("throw");
    const source = makeSync(transport, NOW);
    const t0 = await source.syncStructured(null);
    const b = await source.syncStructured(t0.cursor);
    // Balances landed despite the consent read failing.
    expect(rowsFor(b, plaidBalancesSchema.tableName)).toHaveLength(2);
    // undefined ⇒ the gateway leaves any stored deadline unchanged.
    expect(b.consentExpiresAt).toBeUndefined();
  });

  test("a re-snapshot on a new UTC day re-reads the consent deadline", async () => {
    const deadline = "2026-08-01T00:00:00Z";
    const transport = makeTransport(deadline);
    const source = makeSync(transport, NOW);
    // A new UTC day: the incremental poll hands off to a fresh snapshot pass.
    const poll = await source.syncStructured({
      phase: "incremental",
      lastSnapshotDate: "2026-05-14",
    });
    expect(poll.cursor.phase).toBe("snapshot-balances");
    const rolled = await source.syncStructured(poll.cursor);
    expect(tablesWritten(rolled)).toEqual([plaidBalancesSchema.tableName]);
    expect(rolled.consentExpiresAt).toBe(deadline);
    expect(transport.itemGetCalls).toBe(1);
  });
});

describe("PlaidSyncSource — a snapshot leg that fails", () => {
  /** A transport whose balances read fails and whose holdings read works. */
  function balancesFailing(err: Error): PhaseTransport {
    const t = new PhaseTransport(
      { accounts: [balanceAccount()] },
      { holdings: [], securities: [] },
    );
    t.accountsGet = () => Promise.reject(err);
    return t;
  }

  test("a failed balances read leaves the day unrecorded, so it is retried", async () => {
    // The day must NOT be stamped: stamping it would skip the retry and leave
    // a permanent hole in the append-only balance history.
    const transport = balancesFailing(
      new PlaidApiError("transient", "Plaid could not reach the bank right now.", {
        errorCode: "INSTITUTION_DOWN",
      }),
    );
    const source = makeSync(transport, NOW);
    const t = await source.syncStructured(null);
    const b = await source.syncStructured(t.cursor);
    expect(rowsFor(b, plaidBalancesSchema.tableName)).toHaveLength(0);
    expect(b.cursor.phase).toBe("incremental");
    expect(b.cursor.lastSnapshotDate).toBeUndefined();

    // The next tick on the same day tries the snapshot again.
    const retry = await source.syncStructured(b.cursor);
    expect(retry.cursor.phase).toBe("snapshot-balances");
  });

  test("a revoked consent is never swallowed — the source must park in needs-auth", async () => {
    const transport = balancesFailing(
      new PlaidApiError("auth", "Plaid rejected the request (ITEM_LOGIN_REQUIRED).", {
        errorCode: "ITEM_LOGIN_REQUIRED",
      }),
    );
    const source = makeSync(transport, NOW);
    const t = await source.syncStructured(null);
    await expect(source.syncStructured(t.cursor)).rejects.toMatchObject({ kind: "auth" });
  });

  test("a rate limit is never swallowed — its backoff hint is the collector's", async () => {
    const transport = balancesFailing(
      new PlaidApiError("rate-limit", "Plaid rate limit.", {
        errorCode: "RATE_LIMIT_EXCEEDED",
        retryAfterMs: 30_000,
      }),
    );
    const source = makeSync(transport, NOW);
    const t = await source.syncStructured(null);
    await expect(source.syncStructured(t.cursor)).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 30_000,
    });
  });
});

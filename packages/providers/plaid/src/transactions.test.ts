// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { deletionKeysFor, rowsFor, tablesWritten, writesFor } from "@omnesis/source-sdk/testing";
import { PLAID_SYNC_MUTATION_CODE, PlaidApiError } from "./client.js";
import { PLAID_BACKFILL_WAIT_MS, PlaidTransactionsSource } from "./transactions.js";
import { plaidTransactionsSchema } from "./schemas.js";
import type {
  PlaidItemGetResponse,
  PlaidLinkTokenCreateResponse,
  PlaidTransaction,
  PlaidTransactionsSyncResponse,
} from "./schemas.js";
import type { LinkTokenCreateParams, PlaidTransport, TransactionsSyncParams } from "./client.js";

const PROVIDER_ID = ProviderId("plaid:item-1");
const SOURCE_ID = SourceId("plaid:item-1");
const ITEM_ID = "item-1";
const ACCESS_TOKEN = "access-sandbox-1";

function txn(overrides: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: "txn-1",
    account_id: "acct-1",
    amount: 12.34,
    iso_currency_code: "USD",
    date: "2026-05-01",
    name: "Stellar Sound",
    merchant_name: "Stellar Sound",
    pending: false,
    ...overrides,
  };
}

function page(
  overrides: Partial<PlaidTransactionsSyncResponse> = {},
): PlaidTransactionsSyncResponse {
  return {
    added: [],
    modified: [],
    removed: [],
    next_cursor: "cursor-end",
    has_more: false,
    ...overrides,
  };
}

/**
 * A scripted Plaid transport: `transactionsSync` returns one queued page per
 * call and records every params it was called with, so a test can assert the
 * cursor the source sent. The auth-flow methods are unused here.
 */
class FakeTransport implements PlaidTransport {
  readonly syncCalls: TransactionsSyncParams[] = [];
  constructor(private readonly pages: PlaidTransactionsSyncResponse[]) {}

  transactionsSync(params: TransactionsSyncParams): Promise<PlaidTransactionsSyncResponse> {
    this.syncCalls.push({ ...params });
    const next = this.pages.shift();
    if (!next) throw new Error("FakeTransport: transactionsSync called more times than scripted");
    return Promise.resolve(next);
  }

  linkTokenCreate(_p: LinkTokenCreateParams): Promise<PlaidLinkTokenCreateResponse> {
    throw new Error("not used");
  }
  itemPublicTokenExchange(): Promise<never> {
    throw new Error("not used");
  }
  itemGet(): Promise<PlaidItemGetResponse> {
    throw new Error("not used");
  }
  itemRemove(): Promise<never> {
    throw new Error("not used");
  }
  accountsGet(): Promise<never> {
    throw new Error("not used");
  }
  linkTokenGet(): Promise<never> {
    throw new Error("not used");
  }
  institutionGetById(): Promise<never> {
    throw new Error("not used");
  }
  investmentsHoldingsGet(): Promise<never> {
    throw new Error("not used");
  }
}

function makeSource(transport: PlaidTransport): PlaidTransactionsSource {
  // Pacing exists so a waiting page cannot spin; tests must not wait it out.
  return new PlaidTransactionsSource(transport, PROVIDER_ID, SOURCE_ID, ITEM_ID, ACCESS_TOKEN, {
    institutionName: "Example Bank",
    sleep: () => Promise.resolve(),
  });
}

describe("PlaidTransactionsSource — bootstrap (no cursor)", () => {
  test("first sync calls /transactions/sync with no cursor and emits added rows", async () => {
    const transport = new FakeTransport([
      page({
        added: [txn(), txn({ transaction_id: "txn-2", amount: -20 })],
        next_cursor: "cursor-1",
        has_more: false,
      }),
    ]);
    const result = await makeSource(transport).syncStructured(null);

    // No cursor on the very first call — Plaid returns the requested history.
    expect(transport.syncCalls[0].cursor).toBeUndefined();
    expect(transport.syncCalls[0].accessToken).toBe(ACCESS_TOKEN);

    expect(tablesWritten(result)).toEqual([plaidTransactionsSchema.tableName]);
    const records = rowsFor(result, plaidTransactionsSchema.tableName);
    expect(records.map((r) => r.transaction_id)).toEqual(["txn-1", "txn-2"]);
    expect(records[0].amount).toBe("-12.34");
    expect(records[1].amount).toBe("20.00"); // Plaid -20 (money in) → +20
    expect(result.documents?.map((d) => d.externalId)).toEqual(["item-1:txn-1", "item-1:txn-2"]);
    expect(result.cursor.phase).toBe("transactions");
    expect(result.cursor.transactionsCursor).toBe("cursor-1");
    expect(result.hasMore).toBe(false);
    // Plaid's requested history window is best-effort per institution, so this
    // source never vouches for holding an item's complete transaction history.
    expect(result.progress?.coverage).toBe("unknown");
  });

  test("paginates while has_more, advancing the cursor each page", async () => {
    const transport = new FakeTransport([
      page({ added: [txn()], next_cursor: "cursor-1", has_more: true }),
      page({ added: [txn({ transaction_id: "txn-2" })], next_cursor: "cursor-2", has_more: false }),
    ]);
    const source = makeSource(transport);

    const p1 = await source.syncStructured(null);
    expect(p1.hasMore).toBe(true);
    expect(p1.cursor.transactionsCursor).toBe("cursor-1");

    const p2 = await source.syncStructured(p1.cursor);
    // The second page carried the first page's cursor.
    expect(transport.syncCalls[1].cursor).toBe("cursor-1");
    expect(p2.hasMore).toBe(false);
    expect(p2.cursor.transactionsCursor).toBe("cursor-2");
    expect(rowsFor(p2, plaidTransactionsSchema.tableName).map((r) => r.transaction_id)).toEqual([
      "txn-2",
    ]);
  });
});

describe("PlaidTransactionsSource — incremental delta", () => {
  test("a stored cursor drives the incremental fetch", async () => {
    const transport = new FakeTransport([
      page({ added: [txn({ transaction_id: "txn-new" })], next_cursor: "cursor-2" }),
    ]);
    const result = await makeSource(transport).syncStructured({
      phase: "transactions",
      transactionsCursor: "cursor-1",
    });
    expect(transport.syncCalls[0].cursor).toBe("cursor-1");
    expect(rowsFor(result, plaidTransactionsSchema.tableName).map((r) => r.transaction_id)).toEqual(
      ["txn-new"],
    );
    expect(result.cursor.transactionsCursor).toBe("cursor-2");
  });

  test("modified rows upsert by the composite PK (overwrite)", async () => {
    const transport = new FakeTransport([
      page({ modified: [txn({ name: "Stellar Sound (corrected)", amount: 15 })] }),
    ]);
    const result = await makeSource(transport).syncStructured({
      phase: "transactions",
      transactionsCursor: "c",
    });
    const records = rowsFor(result, plaidTransactionsSchema.tableName);
    expect(records).toHaveLength(1);
    expect(records[0].transaction_id).toBe("txn-1");
    expect(records[0].name).toBe("Stellar Sound (corrected)");
    expect(records[0].amount).toBe("-15.00");
  });

  test("removed transactions are tombstoned by transaction_id + co-doc externalId", async () => {
    const transport = new FakeTransport([
      page({ removed: [{ transaction_id: "txn-gone" }, { transaction_id: "txn-gone-2" }] }),
    ]);
    const result = await makeSource(transport).syncStructured({
      phase: "transactions",
      transactionsCursor: "c",
    });
    // Named by both halves of the table's key. Keyed on the transaction id
    // alone this would reach a row of any connection that happened to carry
    // it — safe only while the upstream's uniqueness promise holds.
    expect(deletionKeysFor(result, plaidTransactionsSchema.tableName)).toEqual([
      { item_id: "item-1", transaction_id: "txn-gone" },
      { item_id: "item-1", transaction_id: "txn-gone-2" },
    ]);
    expect(result.deletedExternalIds).toEqual(["item-1:txn-gone", "item-1:txn-gone-2"]);
  });

  test("no deletes when removed[] is empty (no spurious delete primitive)", async () => {
    const transport = new FakeTransport([page({ added: [txn()] })]);
    const result = await makeSource(transport).syncStructured({
      phase: "transactions",
      transactionsCursor: "c",
    });
    expect(deletionKeysFor(result, plaidTransactionsSchema.tableName)).toEqual([]);
    expect(writesFor(result, plaidTransactionsSchema.tableName)[0]?.deletedKeys).toBeUndefined();
    expect(result.deletedExternalIds).toBeUndefined();
  });
});

describe("PlaidTransactionsSource — pending→posted transition", () => {
  test("the posted row is added and the pending id is tombstoned in the same page", async () => {
    // Plaid mints a NEW id when a pending txn posts, lists the old pending id in
    // removed[], and links the posted row via pending_transaction_id.
    const transport = new FakeTransport([
      page({
        added: [
          txn({
            transaction_id: "txn-posted",
            pending: false,
            pending_transaction_id: "txn-pending",
          }),
        ],
        removed: [{ transaction_id: "txn-pending" }],
      }),
    ]);
    const result = await makeSource(transport).syncStructured({
      phase: "transactions",
      transactionsCursor: "c",
    });
    // Posted row inserted with its link back to the pending row.
    const records = rowsFor(result, plaidTransactionsSchema.tableName);
    expect(records.map((r) => r.transaction_id)).toEqual(["txn-posted"]);
    expect(records[0].pending).toBe(false);
    expect(records[0].pending_transaction_id).toBe("txn-pending");
    // The stale pending row is tombstoned — no orphan, no duplicate.
    expect(deletionKeysFor(result, plaidTransactionsSchema.tableName)).toEqual([
      { item_id: "item-1", transaction_id: "txn-pending" },
    ]);
    expect(result.deletedExternalIds).toEqual(["item-1:txn-pending"]);
  });
});

describe("PlaidTransactionsSource — at-least-once idempotency", () => {
  test("re-running the SAME cursor page reproduces identical rows/cursor/tombstones", async () => {
    // The gateway persists the cursor only after a page durably ingests; a crash
    // before that re-fetches the same page from the previous cursor. Plaid serves
    // the same cursor page deterministically — the composite-PK upserts and the
    // id-keyed tombstones make the replay a no-op beyond a harmless re-write.
    const samePage = (): PlaidTransactionsSyncResponse =>
      page({
        added: [txn(), txn({ transaction_id: "txn-2" })],
        removed: [{ transaction_id: "txn-gone" }],
        next_cursor: "cursor-2",
      });
    const transport = new FakeTransport([samePage(), samePage()]);
    const source = makeSource(transport);

    const first = await source.syncStructured({ phase: "transactions", transactionsCursor: "c1" });
    const retry = await source.syncStructured({ phase: "transactions", transactionsCursor: "c1" });

    // Both requests carried the same (not-yet-advanced) cursor.
    expect(transport.syncCalls[0].cursor).toBe("c1");
    expect(transport.syncCalls[1].cursor).toBe("c1");
    // Identical output → idempotent on replay.
    expect(rowsFor(retry, plaidTransactionsSchema.tableName)).toEqual(
      rowsFor(first, plaidTransactionsSchema.tableName),
    );
    expect(deletionKeysFor(retry, plaidTransactionsSchema.tableName)).toEqual(
      deletionKeysFor(first, plaidTransactionsSchema.tableName),
    );
    expect(retry.cursor.transactionsCursor).toBe(first.cursor.transactionsCursor);
  });
});

describe("PlaidTransactionsSource — stale cursor recovery", () => {
  test("a page invalidated mid-run restarts from the cursor the run began with", async () => {
    // Plaid invalidates a pagination run whose data changed underneath it and
    // asks for a restart from the run's starting cursor — retrying the failing
    // page would hit the same mutation. The composite-PK upserts make the
    // replay idempotent.
    const transport: PlaidTransport = {
      transactionsSync: () =>
        Promise.reject(
          new PlaidApiError("unknown", "Plaid request failed (HTTP 400).", {
            errorCode: PLAID_SYNC_MUTATION_CODE,
          }),
        ),
      linkTokenCreate: () => Promise.reject(new Error("x")),
      itemPublicTokenExchange: () => Promise.reject(new Error("x")),
      itemGet: () => Promise.reject(new Error("x")),
      itemRemove: () => Promise.reject(new Error("x")),
      accountsGet: () => Promise.reject(new Error("x")),
      linkTokenGet: () => Promise.reject(new Error("x")),
      institutionGetById: () => Promise.reject(new Error("x")),
      investmentsHoldingsGet: () => Promise.reject(new Error("x")),
    };
    const result = await makeSource(transport).syncStructured({
      phase: "transactions",
      transactionsCursor: "page-3-cursor",
      loopStartCursor: "run-start-cursor",
    });
    expect(rowsFor(result, plaidTransactionsSchema.tableName)).toHaveLength(0);
    expect(result.cursor.transactionsCursor).toBe("run-start-cursor");
    expect(result.cursor.loopStartCursor).toBe("run-start-cursor");
    expect(result.hasMore).toBe(true);
    expect(result.progress?.coverage).toBe("unknown");
  });

  test("a mutation on the run's first page keeps the cursor it already had", async () => {
    // On the first page there is no separate starting cursor — the cursor in
    // hand IS where the run began. Dropping it would replay the item's whole
    // history, every time.
    const transport: PlaidTransport = {
      transactionsSync: () =>
        Promise.reject(
          new PlaidApiError("unknown", "Plaid request failed (HTTP 400).", {
            errorCode: PLAID_SYNC_MUTATION_CODE,
          }),
        ),
      linkTokenCreate: () => Promise.reject(new Error("x")),
      linkTokenGet: () => Promise.reject(new Error("x")),
      itemPublicTokenExchange: () => Promise.reject(new Error("x")),
      itemGet: () => Promise.reject(new Error("x")),
      itemRemove: () => Promise.reject(new Error("x")),
      institutionGetById: () => Promise.reject(new Error("x")),
      accountsGet: () => Promise.reject(new Error("x")),
      investmentsHoldingsGet: () => Promise.reject(new Error("x")),
    };
    const result = await makeSource(transport).syncStructured({
      phase: "transactions",
      transactionsCursor: "live-cursor",
    });
    expect(result.cursor.transactionsCursor).toBe("live-cursor");
    expect(result.cursor.loopStartCursor).toBe("live-cursor");
  });

  test("any other failure keeps its own routing and never touches the cursor", async () => {
    // A validation failure or an institution outage must not be mistaken for a
    // pagination restart, which would re-walk the whole history.
    const transport: PlaidTransport = {
      transactionsSync: () =>
        Promise.reject(new SyncError("unknown", "Plaid response failed validation.")),
      linkTokenCreate: () => Promise.reject(new Error("x")),
      linkTokenGet: () => Promise.reject(new Error("x")),
      itemPublicTokenExchange: () => Promise.reject(new Error("x")),
      itemGet: () => Promise.reject(new Error("x")),
      itemRemove: () => Promise.reject(new Error("x")),
      institutionGetById: () => Promise.reject(new Error("x")),
      accountsGet: () => Promise.reject(new Error("x")),
      investmentsHoldingsGet: () => Promise.reject(new Error("x")),
    };
    await expect(
      makeSource(transport).syncStructured({
        phase: "transactions",
        transactionsCursor: "live-cursor",
      }),
    ).rejects.toMatchObject({ kind: "unknown" });
  });

  test("the SAME error on the FIRST (cursorless) call propagates, never silently restarts", async () => {
    const transport: PlaidTransport = {
      transactionsSync: () =>
        Promise.reject(new SyncError("unknown", "Plaid request failed (HTTP 400).")),
      linkTokenCreate: () => Promise.reject(new Error("x")),
      itemPublicTokenExchange: () => Promise.reject(new Error("x")),
      itemGet: () => Promise.reject(new Error("x")),
      itemRemove: () => Promise.reject(new Error("x")),
      accountsGet: () => Promise.reject(new Error("x")),
      linkTokenGet: () => Promise.reject(new Error("x")),
      institutionGetById: () => Promise.reject(new Error("x")),
      investmentsHoldingsGet: () => Promise.reject(new Error("x")),
    };
    const err = await makeSource(transport)
      .syncStructured(null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
  });
});

describe("PlaidTransactionsSource — error propagation", () => {
  test("a SyncError from the transport surfaces unchanged (collector routes it)", async () => {
    const transport: PlaidTransport = {
      transactionsSync: () =>
        Promise.reject(new SyncError("auth", "Plaid rejected the item — reconnect.")),
      linkTokenCreate: () => Promise.reject(new Error("x")),
      itemPublicTokenExchange: () => Promise.reject(new Error("x")),
      itemGet: () => Promise.reject(new Error("x")),
      itemRemove: () => Promise.reject(new Error("x")),
      accountsGet: () => Promise.reject(new Error("x")),
      linkTokenGet: () => Promise.reject(new Error("x")),
      institutionGetById: () => Promise.reject(new Error("x")),
      investmentsHoldingsGet: () => Promise.reject(new Error("x")),
    };
    const err = await makeSource(transport)
      .syncStructured(null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("auth");
  });
});

describe("PlaidTransactionsSource — Plaid still assembling the history", () => {
  /** A caught-up page that reports the history is not finished yet. */
  function backfillingPage(): PlaidTransactionsSyncResponse {
    return {
      added: [],
      modified: [],
      removed: [],
      next_cursor: "cursor-1",
      has_more: false,
      transactions_update_status: "INITIAL_UPDATE_COMPLETE",
    } as unknown as PlaidTransactionsSyncResponse;
  }

  test("keeps asking while Plaid is still building the item's history", async () => {
    // `has_more: false` here means "nothing more right now", not "the history
    // is complete" — idling would leave most of it for the next scheduled run.
    const transport = new FakeTransport([backfillingPage()]);
    const source = makeSource(transport);
    const result = await source.syncStructured(null);
    expect(result.hasMore).toBe(true);
    expect(result.cursor.phase).toBe("transactions");
    expect(result.cursor.backfillWaitSince).toBeDefined();
  });

  test("paces the wait instead of spinning against Plaid's per-item limit", async () => {
    const waits: number[] = [];
    const transport = new FakeTransport([backfillingPage()]);
    const source = new PlaidTransactionsSource(
      transport,
      PROVIDER_ID,
      SOURCE_ID,
      ITEM_ID,
      ACCESS_TOKEN,
      {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
    );
    await source.syncStructured(null);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(10_000);
  });

  test("gives up waiting once the budget is spent, leaving the rest to the next run", async () => {
    const transport = new FakeTransport([backfillingPage()]);
    let clock = Date.parse("2026-05-15T12:00:00Z");
    const source = new PlaidTransactionsSource(
      transport,
      PROVIDER_ID,
      SOURCE_ID,
      ITEM_ID,
      ACCESS_TOKEN,
      {
        sleep: () => Promise.resolve(),
        now: () => new Date((clock += PLAID_BACKFILL_WAIT_MS)),
      },
    );
    const result = await source.syncStructured({
      phase: "transactions",
      backfillWaitSince: "2026-05-15T12:00:00Z",
    });
    expect(result.hasMore).toBe(false);
    expect(result.cursor.backfillWaitSince).toBeUndefined();
  });

  test("a complete history idles normally", async () => {
    const transport = new FakeTransport([
      {
        added: [],
        modified: [],
        removed: [],
        next_cursor: "cursor-1",
        has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      } as unknown as PlaidTransactionsSyncResponse,
    ]);
    const result = await makeSource(transport).syncStructured(null);
    expect(result.hasMore).toBe(false);
    expect(result.cursor.backfillWaitSince).toBeUndefined();
  });
});

describe("PlaidTransactionsSource — a row Plaid serves in an unexpected shape", () => {
  test("skips the row and keeps the rest of the page and its cursor", async () => {
    // One unreadable row must not block the page behind it, nor the cursor.
    const good = {
      transaction_id: "txn-good",
      account_id: "acct-1",
      date: "2026-05-14",
      amount: 10,
    };
    const transport = new FakeTransport([
      {
        added: [good, { transaction_id: "txn-bad", amount: "not a number" }],
        modified: [],
        removed: [],
        next_cursor: "cursor-1",
        has_more: false,
      } as unknown as PlaidTransactionsSyncResponse,
    ]);
    const result = await makeSource(transport).syncStructured(null);
    const rows = rowsFor(result, plaidTransactionsSchema.tableName);
    expect(rows).toHaveLength(1);
    expect(rows[0].transaction_id).toBe("txn-good");
    expect(result.cursor.transactionsCursor).toBe("cursor-1");
  });
});

describe("PlaidTransactionsSource — an abandoned sync", () => {
  test("passes the abort signal to Plaid, so the request goes with the sync", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const transport: PlaidTransport = {
      transactionsSync: (_p, opts) => {
        seen.push(opts?.signal);
        return Promise.resolve({
          added: [],
          modified: [],
          removed: [],
          next_cursor: "c",
          has_more: false,
        } as unknown as PlaidTransactionsSyncResponse);
      },
      linkTokenCreate: () => Promise.reject(new Error("x")),
      linkTokenGet: () => Promise.reject(new Error("x")),
      itemPublicTokenExchange: () => Promise.reject(new Error("x")),
      itemGet: () => Promise.reject(new Error("x")),
      itemRemove: () => Promise.reject(new Error("x")),
      institutionGetById: () => Promise.reject(new Error("x")),
      accountsGet: () => Promise.reject(new Error("x")),
      investmentsHoldingsGet: () => Promise.reject(new Error("x")),
    };
    const controller = new AbortController();
    await makeSource(transport).syncStructured(null, { signal: controller.signal });
    expect(seen[0]).toBe(controller.signal);
  });
});

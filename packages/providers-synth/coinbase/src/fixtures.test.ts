// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The synth twin must run the REAL Coinbase sync path over canned responses,
 * not a re-implementation. These tests drive a real `CoinbaseSnapshotSource`
 * (built by the twin's factory) through the synthetic fetch and assert the
 * production parsing/keying/normalization holds — money stays exact decimal
 * strings, the phase machine terminates, and the grant-absent path degrades
 * gracefully. They run at the package level (no gateway), so they stay fast and
 * fail loudly if a fixture drifts from the schema the real client parses.
 */

import { describe, expect, test } from "vitest";
import { CoinbaseSnapshotSource, validateCoinbaseCursor } from "@omnesis/provider-coinbase";
import { ProviderId, SourceId } from "@omnesis/types";
import { tableWrites } from "@omnesis/source-sdk";
import { rowsFor } from "@omnesis/source-sdk/testing";
import {
  type CoinbaseResponsesFixture,
  loadResponses,
  syntheticCoinbaseClient,
} from "./fixtures.js";
import type { StructuredSyncResult } from "@omnesis/source-sdk";
import type { CoinbaseCursor } from "@omnesis/provider-coinbase";

const ACCOUNT = "cb-portfolio-john";
const PROVIDER_ID = ProviderId(`coinbase:${ACCOUNT}`);
const SOURCE_ID = SourceId(`coinbase:${ACCOUNT}`);
const NOW = (): Date => new Date("2025-12-31T12:00:00.000Z");

function makeSource(responses: CoinbaseResponsesFixture): CoinbaseSnapshotSource {
  return new CoinbaseSnapshotSource(
    syntheticCoinbaseClient(responses),
    PROVIDER_ID,
    SOURCE_ID,
    ACCOUNT,
    ACCOUNT,
    { now: NOW },
  );
}

/** Drive the real phase machine to completion, collecting rows + documents. */
async function drain(source: CoinbaseSnapshotSource): Promise<{
  byTable: Record<string, Record<string, unknown>[]>;
  documents: Array<{ externalId: string; title: string; content: string }>;
  cursor: CoinbaseCursor;
}> {
  const byTable: Record<string, Record<string, unknown>[]> = {};
  const documents: Array<{ externalId: string; title: string; content: string }> = [];
  let cursor: CoinbaseCursor | null = null;
  let page: StructuredSyncResult<CoinbaseCursor>;
  let guard = 0;
  do {
    page = await source.syncStructured(cursor ? validateCoinbaseCursor(cursor) : null);
    for (const write of tableWrites(page.analytics)) {
      (byTable[write.tableName] ??= []).push(...(write.records ?? []));
    }
    for (const doc of page.documents ?? []) {
      documents.push({ externalId: doc.externalId, title: doc.title, content: doc.content });
    }
    cursor = page.cursor;
    if (++guard > 100) throw new Error("phase machine did not terminate");
  } while (page.hasMore);
  return { byTable, documents, cursor };
}

describe("coinbase synth twin drives the real sync over canned responses", () => {
  test("the universe corpus parses + normalizes through the real client to all five tables", async () => {
    const { byTable, documents } = await drain(makeSource(loadResponses()));

    // Balances: zero-balance DOGE dust skipped; BTC/ETH/USD retained across the
    // two-page accounts walk, all on the one pinned snapshot date.
    const balances = byTable["coinbase_balances"] ?? [];
    expect(balances.map((r) => r.currency).sort()).toEqual(["BTC", "ETH", "USD"]);
    expect(new Set(balances.map((r) => r.snapshot_date))).toEqual(new Set(["2025-12-31"]));
    const btc = balances.find((r) => r.currency === "BTC")!;
    expect(btc.available_balance).toBe("0.500000000000000000"); // exact, scaled — not a float

    // Holdings: three spot positions; float aggregates never become columns.
    const holdings = byTable["coinbase_holdings"] ?? [];
    expect(holdings.map((r) => r.asset).sort()).toEqual(["BTC", "ETH", "USD"]);
    for (const row of holdings) {
      expect(row).not.toHaveProperty("total_balance_fiat");
      expect(row).not.toHaveProperty("allocation");
    }

    // Orders walk across two pages → three orders; an open order keeps OPEN.
    const orders = byTable["coinbase_orders"] ?? [];
    expect(orders.map((r) => r.order_id).sort()).toEqual(["ord-1", "ord-2", "ord-3"]);

    // Fills are immutable, keyed on trade_id.
    const fills = byTable["coinbase_fills"] ?? [];
    expect(fills.map((r) => r.trade_id).sort()).toEqual(["trade-1", "trade-2"]);

    // v2 ledger ingests + co-emits searchable documents.
    const txns = byTable["coinbase_transactions"] ?? [];
    expect(txns.map((r) => r.transaction_id).sort()).toEqual(["txn-1", "txn-2", "txn-3"]);
    expect(documents.map((d) => d.externalId).sort()).toEqual([
      `${ACCOUNT}:txn-1`,
      `${ACCOUNT}:txn-2`,
      `${ACCOUNT}:txn-3`,
    ]);
  });

  test("re-running the whole sync is exactly idempotent — identical primary keys", async () => {
    const source = makeSource(loadResponses());
    const first = await drain(source);
    const second = await drain(source); // same UTC day, full re-walk

    const pk = (r: Record<string, unknown>, cols: string[]) => cols.map((c) => r[c]).join("|");
    const keys = (rows: Record<string, unknown>[], cols: string[]) =>
      rows.map((r) => pk(r, cols)).sort();

    expect(
      keys(second.byTable["coinbase_balances"] ?? [], ["account_key", "currency", "snapshot_date"]),
    ).toEqual(
      keys(first.byTable["coinbase_balances"] ?? [], ["account_key", "currency", "snapshot_date"]),
    );
    expect(keys(second.byTable["coinbase_orders"] ?? [], ["account_key", "order_id"])).toEqual(
      keys(first.byTable["coinbase_orders"] ?? [], ["account_key", "order_id"]),
    );
    expect(
      keys(second.byTable["coinbase_transactions"] ?? [], ["account_key", "transaction_id"]),
    ).toEqual(
      keys(first.byTable["coinbase_transactions"] ?? [], ["account_key", "transaction_id"]),
    );
  });

  test("at-least-once: the SAME page delivered twice yields identical primary keys (no dupes)", async () => {
    // The frozen idempotency oracle — deliver one page twice from its starting
    // cursor (the at-least-once retry the engine performs after an interrupted
    // push), and assert the stable-id PKs are identical so the gateway's upsert
    // dedupes rather than duplicating or losing rows.
    const source = makeSource(loadResponses());
    const ordersCursor = validateCoinbaseCursor({ phase: "orders" });
    const a = await source.syncStructured(ordersCursor);
    const b = await source.syncStructured(ordersCursor);
    const orderPk = (r: Record<string, unknown>) => [r.account_key, r.order_id].join("|");
    expect(rowsFor(a, "coinbase_orders").map(orderPk).sort()).toEqual(
      rowsFor(b, "coinbase_orders").map(orderPk).sort(),
    );

    const txnCursor = validateCoinbaseCursor({ phase: "transactions" });
    const c = await source.syncStructured(txnCursor);
    const d = await source.syncStructured(txnCursor);
    const txnPk = (r: Record<string, unknown>) => [r.account_key, r.transaction_id].join("|");
    expect(rowsFor(c, "coinbase_transactions").map(txnPk).sort()).toEqual(
      rowsFor(d, "coinbase_transactions").map(txnPk).sort(),
    );
  });

  test("a corpus without the ledger grant skips the ledger but keeps the source healthy", async () => {
    const denied: CoinbaseResponsesFixture = { ...loadResponses(), v2Grant: false };
    const { byTable, cursor } = await drain(makeSource(denied));
    expect(byTable["coinbase_transactions"] ?? []).toEqual([]);
    expect(cursor.ledgerUnavailable).toBe(true);
    expect(cursor.phase).toBe("incremental");
    // Other tables are unaffected by the missing grant.
    expect((byTable["coinbase_balances"] ?? []).length).toBe(3);
    expect((byTable["coinbase_orders"] ?? []).length).toBe(3);
  });
});

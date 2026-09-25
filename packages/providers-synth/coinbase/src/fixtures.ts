// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic Coinbase backend.
 *
 * Rather than re-implement the sync (which would let fixture semantics drift
 * from production), the twin feeds canned multi-page Coinbase API responses
 * into the REAL provider's HTTP client via an injected `fetchImpl`. The real
 * `CoinbaseClient` still mints a per-request JWT (with a throwaway runtime key,
 * never a real one), parses every page through its zod schemas, and maps
 * status codes to the typed `SyncError`s the sync engine routes on — so the
 * synth path exercises the production parsing, keying, normalization,
 * pagination, watermark, and graceful-degrade code unchanged.
 *
 * The fixtures are raw Advanced-Trade / v2 App-API JSON, loaded from the active
 * universe (`sources/coinbase/responses.json`). Money fields are decimal
 * strings, exactly as Coinbase sends them. All ids/balances are invented;
 * BTC/ETH/USD/DOGE are public market symbols, not PII.
 */

import { generateKeyPairSync } from "node:crypto";
import { COINBASE_API_HOST, CoinbaseClient } from "@omnesis/provider-coinbase";
import { loadActiveUniverse, loadSourceFixtureJson } from "@omnesis/providers-synth-common";
import type { FetchFn } from "@omnesis/provider-coinbase";

/** Descriptor id of the brokerage source (shared with the real package). */
export const COINBASE_DESCRIPTOR_ID = "coinbase";

/**
 * The canned-response corpus for one synthetic Coinbase portfolio. Each
 * cursor-paginated list is an array of page objects; the fake fetch serves them
 * in order, honoring the `cursor` / `starting_after` query param the real
 * client sends. `v2Grant: false` makes the `/v2` reads return HTTP 403, which
 * the real client maps to a `CoinbaseScopeError` so the ledger phase
 * gracefully degrades (table stays empty, source stays healthy).
 */
export interface CoinbaseResponsesFixture {
  /** Pages of `GET /api/v3/brokerage/accounts` (balances walk). */
  accountsPages: unknown[];
  /** `GET /api/v3/brokerage/portfolios`. */
  portfolios: unknown;
  /** `GET /api/v3/brokerage/portfolios/{uuid}` keyed by portfolio uuid (holdings). */
  breakdowns: Record<string, unknown>;
  /** Pages of `GET /api/v3/brokerage/orders/historical/batch`. */
  ordersPages: unknown[];
  /** Pages of `GET /api/v3/brokerage/orders/historical/fills`. */
  fillsPages: unknown[];
  /** Pages of `GET /v2/accounts` (v2 wallet list). */
  v2AccountsPages: unknown[];
  /** Pages of `GET /v2/accounts/{id}/transactions` keyed by wallet id. */
  v2TransactionsPages: Record<string, unknown[]>;
  /** When false, all `/v2` reads return 403 — the ledger grant is absent. */
  v2Grant: boolean;
}

let cachedResponses: CoinbaseResponsesFixture | null = null;

/** Load the active universe's Coinbase response corpus (cached). */
export function loadResponses(): CoinbaseResponsesFixture {
  if (!cachedResponses) {
    cachedResponses = loadSourceFixtureJson<CoinbaseResponsesFixture>(
      loadActiveUniverse(),
      COINBASE_DESCRIPTOR_ID,
      "responses.json",
    );
  }
  return cachedResponses;
}

/** Reset the memoized fixture corpus — testing aid. */
export function resetResponsesCache(): void {
  cachedResponses = null;
}

/**
 * The active corpus with test-only env overrides applied. `v2Grant` can be
 * forced off via `OMNESIS_COINBASE_SYNTH_NO_LEDGER=1` so an E2E can drive the
 * grant-absent graceful-degrade path without a second fixture file. Read
 * per-sync so a single gateway process can flip it between runs.
 */
export function activeResponses(): CoinbaseResponsesFixture {
  const base = loadResponses();
  if (process.env.OMNESIS_COINBASE_SYNTH_NO_LEDGER === "1") {
    return { ...base, v2Grant: false };
  }
  return base;
}

/**
 * A throwaway EC P-256 key minted once per process. The real `CoinbaseClient`
 * needs a parseable CDP key to mint its per-request JWT; this is a freshly
 * generated key with no value, never persisted, never a real Coinbase key.
 */
let cachedSyntheticKey: { keyId: string; privateKeyPem: string } | null = null;
export function syntheticCdpKey(): { keyId: string; privateKeyPem: string } {
  if (!cachedSyntheticKey) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    cachedSyntheticKey = {
      keyId: "synthetic-coinbase-key",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    };
  }
  return cachedSyntheticKey;
}

/** A JSON `Response` with the given status (200 by default). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Zero-based page index from a cursor like `acc-1` / `ord-2` / `txn-3` (page 0 when absent). */
function pageIndex(cursor: string | null): number {
  if (!cursor) return 0;
  const m = /(\d+)$/.exec(cursor);
  return m ? Number(m[1]) : 0;
}

/** The nth page of a list, or an empty page beyond the end (defensive). */
function pageAt(pages: unknown[], index: number, empty: unknown): unknown {
  return pages[index] ?? empty;
}

/**
 * Build a `fetchImpl` that serves the fixture corpus by URL + query. Routes the
 * exact endpoints the real `CoinbaseClient` calls; an unrecognized path returns
 * 404 so a fixture/route drift fails loudly rather than silently returning
 * empty. The optional `signal` is honored so a synthetic 429/401 path could
 * still be wired without leaking timers.
 */
export function syntheticCoinbaseFetch(responses: CoinbaseResponsesFixture): FetchFn {
  return (input: string): Promise<Response> => {
    const url = new URL(input);
    if (url.hostname !== COINBASE_API_HOST) {
      return Promise.resolve(jsonResponse({ error: `unexpected host ${url.hostname}` }, 404));
    }
    const path = url.pathname;
    const v2Denied = !responses.v2Grant;

    // ── balances ────────────────────────────────────────────────────
    if (path === "/api/v3/brokerage/accounts") {
      const idx = pageIndex(url.searchParams.get("cursor"));
      return Promise.resolve(
        jsonResponse(pageAt(responses.accountsPages, idx, { accounts: [], has_next: false })),
      );
    }

    // ── holdings ────────────────────────────────────────────────────
    if (path === "/api/v3/brokerage/portfolios") {
      return Promise.resolve(jsonResponse(responses.portfolios));
    }
    if (path.startsWith("/api/v3/brokerage/portfolios/")) {
      const uuid = decodeURIComponent(path.slice("/api/v3/brokerage/portfolios/".length));
      const breakdown = responses.breakdowns[uuid];
      if (!breakdown) {
        return Promise.resolve(jsonResponse({ error: `unknown portfolio ${uuid}` }, 404));
      }
      return Promise.resolve(jsonResponse(breakdown));
    }

    // ── orders / fills ──────────────────────────────────────────────
    if (path === "/api/v3/brokerage/orders/historical/batch") {
      const idx = pageIndex(url.searchParams.get("cursor"));
      return Promise.resolve(
        jsonResponse(pageAt(responses.ordersPages, idx, { orders: [], has_next: false })),
      );
    }
    if (path === "/api/v3/brokerage/orders/historical/fills") {
      const idx = pageIndex(url.searchParams.get("cursor"));
      return Promise.resolve(
        jsonResponse(pageAt(responses.fillsPages, idx, { fills: [], has_next: false })),
      );
    }

    // ── v2 ledger (grant-gated) ─────────────────────────────────────
    if (path === "/v2/accounts") {
      if (v2Denied) return Promise.resolve(jsonResponse({ errors: ["missing grant"] }, 403));
      const idx = pageIndex(url.searchParams.get("starting_after"));
      return Promise.resolve(jsonResponse(pageAt(responses.v2AccountsPages, idx, { data: [] })));
    }
    const v2TxnMatch = /^\/v2\/accounts\/([^/]+)\/transactions$/.exec(path);
    if (v2TxnMatch) {
      if (v2Denied) return Promise.resolve(jsonResponse({ errors: ["missing grant"] }, 403));
      const walletId = decodeURIComponent(v2TxnMatch[1]!);
      const pages = responses.v2TransactionsPages[walletId] ?? [];
      const idx = pageIndex(url.searchParams.get("starting_after"));
      return Promise.resolve(jsonResponse(pageAt(pages, idx, { data: [] })));
    }

    return Promise.resolve(jsonResponse({ error: `unrouted path ${path}` }, 404));
  };
}

/** A real `CoinbaseClient` wired to the fixture corpus via the synthetic fetch. */
export function syntheticCoinbaseClient(responses: CoinbaseResponsesFixture): CoinbaseClient {
  const key = syntheticCdpKey();
  return new CoinbaseClient({
    keyId: key.keyId,
    privateKeyPem: key.privateKeyPem,
    fetchImpl: syntheticCoinbaseFetch(responses),
  });
}

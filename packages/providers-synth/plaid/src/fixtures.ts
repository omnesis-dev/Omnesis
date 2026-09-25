// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic Plaid backend.
 *
 * Rather than re-implement the sync (which would let fixture semantics drift
 * from production), the twin feeds canned Plaid API responses into the REAL
 * provider's HTTP client via an injected `fetchImpl`. The real `PlaidClient`
 * still authenticates with `client_id` + `secret` in the body (throwaway synth
 * values, never real), parses every response through its zod schemas, and maps
 * status codes to the typed `SyncError`s the sync engine routes on — so the
 * synth path exercises the production parse → normalize → key → snapshot/delta
 * → ingest code unchanged. Only the network and the auth handshake are replaced.
 *
 * The fixtures are raw Plaid JSON, loaded from the active universe
 * (`sources/plaid/responses.json`). Money fields are JSON numbers, exactly as
 * Plaid sends them. All ids/balances/holdings are invented; tickers are
 * fictional (e.g. `ZZZX`), never real instruments held by a real person.
 */

import { PlaidClient } from "@omnesis/provider-plaid";
import { loadActiveUniverse, loadSourceFixtureJson } from "@omnesis/providers-synth-common";

/** Descriptor id of the Plaid source (shared with the real package). */
export const PLAID_DESCRIPTOR_ID = "plaid";

/** The synthetic Plaid host the real client targets in `sandbox`. */
export const PLAID_SANDBOX_HOST = "sandbox.plaid.com";

/**
 * The canned-response corpus for one synthetic Plaid item. `/transactions/sync`
 * is served as ordered pages keyed by the request cursor; the balance and
 * holdings reads are single point-in-time responses.
 */
export interface PlaidResponsesFixture {
  /** Pages of `POST /transactions/sync`, served in order (cursor → next page). */
  transactionsSyncPages: unknown[];
  /** `POST /accounts/get`. */
  accountsGet: unknown;
  /** `POST /investments/holdings/get`. */
  investmentsHoldingsGet: unknown;
  /**
   * `POST /item/get` — the item envelope carrying `consent_expiration_time` for
   * the forward-looking consent-expiry surface. Optional: an older
   * fixture without it falls back to a synthesized never-expiring item so the
   * snapshot's consent read succeeds (and reports `null`) rather than 404ing.
   */
  itemGet?: unknown;
}

let cachedResponses: PlaidResponsesFixture | null = null;

/** Load the active universe's Plaid response corpus (cached). */
export function loadResponses(): PlaidResponsesFixture {
  if (!cachedResponses) {
    cachedResponses = loadSourceFixtureJson<PlaidResponsesFixture>(
      loadActiveUniverse(),
      PLAID_DESCRIPTOR_ID,
      "responses.json",
    );
  }
  return cachedResponses;
}

/** Reset the memoized fixture corpus — testing aid. */
export function resetResponsesCache(): void {
  cachedResponses = null;
}

/** Plaid's documented response for holdings on an item without investment accounts. */
const NO_INVESTMENT_ACCOUNTS_ERROR = {
  error_type: "INVALID_REQUEST",
  error_code: "NO_INVESTMENT_ACCOUNTS",
  error_message: "No investment accounts available",
};

/**
 * The active corpus with test-only env overrides applied. Setting
 * `OMNESIS_PLAID_SYNTH_NO_INVESTMENTS=1` makes `/investments/holdings/get`
 * answer the way Plaid does for an item with no investment account — a 400
 * `NO_INVESTMENT_ACCOUNTS`, not empty arrays — so an E2E can drive the
 * deposit-only item path without a second fixture file. Read per-sync so a
 * single gateway process can flip it between runs.
 */
export function activeResponses(): PlaidResponsesFixture {
  const base = loadResponses();
  if (process.env.OMNESIS_PLAID_SYNTH_NO_INVESTMENTS === "1") {
    return { ...base, investmentsHoldingsGet: NO_INVESTMENT_ACCOUNTS_ERROR };
  }
  return base;
}

/** A JSON `Response` with the given status (200 by default). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Zero-based page index from a Plaid transactions cursor. The first page is
 * cursorless (index 0); subsequent pages carry `txn-cursor-<n>` so the fake
 * serves them in order. An unknown cursor falls past the end (an empty delta).
 */
function transactionsPageIndex(cursor: unknown): number {
  if (typeof cursor !== "string" || cursor.length === 0) return 0;
  const m = /(\d+)$/.exec(cursor);
  return m ? Number(m[1]) : 0;
}

/**
 * Build a `fetchImpl` that serves the fixture corpus by URL path + request body.
 * Routes the exact endpoints the real `PlaidClient` calls; an unrecognized path
 * returns 404 so a fixture/route drift fails loudly rather than silently
 * returning empty.
 */
export function syntheticPlaidFetch(responses: PlaidResponsesFixture): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.hostname !== PLAID_SANDBOX_HOST) {
      return jsonResponse({ error_code: "UNEXPECTED_HOST" }, 404);
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const path = url.pathname;

    if (path === "/transactions/sync") {
      const idx = transactionsPageIndex(body.cursor);
      const page = responses.transactionsSyncPages[idx] ?? {
        added: [],
        modified: [],
        removed: [],
        next_cursor: `txn-cursor-${idx}`,
        has_more: false,
      };
      return jsonResponse(page);
    }
    if (path === "/accounts/get") {
      return jsonResponse(responses.accountsGet);
    }
    if (path === "/investments/holdings/get") {
      const body = responses.investmentsHoldingsGet as { error_code?: string };
      return jsonResponse(body, body.error_code ? 400 : 200);
    }
    if (path === "/item/get") {
      // The snapshot phase reads `consent_expiration_time` here (#927). A fixture
      // may omit `itemGet`; synthesize a never-expiring item so the real client's
      // schema still parses and the consent read reports `null` (clears the flag).
      return jsonResponse(
        responses.itemGet ?? {
          item: { item_id: "synthetic-plaid-item", consent_expiration_time: null },
        },
      );
    }

    return jsonResponse({ error_code: "UNROUTED_PATH", path }, 404);
  }) as unknown as typeof fetch;
}

/** A real `PlaidClient` wired to the fixture corpus via the synthetic fetch. */
export function syntheticPlaidClient(responses: PlaidResponsesFixture): PlaidClient {
  return new PlaidClient({
    clientId: "synthetic-plaid-client",
    secret: "synthetic-plaid-secret",
    environment: "sandbox",
    fetchImpl: syntheticPlaidFetch(responses),
  });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Minimal HTTP client for the Coinbase Advanced Trade API.
 *
 * - Mints a fresh per-request JWT (signed with the user's CDP key) for every
 *   call; the key never leaves this process — only the short-lived Bearer JWT
 *   travels on the wire.
 * - Errors map to typed `SyncError`s so the collector routes the source:
 *   401/403 → `auth` (invalid / revoked / wrong-scope key → needs-auth),
 *   429 → `rate-limit` with a self-derived backoff (Coinbase sends no
 *   `Retry-After` header), 5xx → `transient`, fetch throw / timeout →
 *   `network`. Never logs the JWT, the key, the Authorization header, or raw
 *   response bodies; messages carry status + endpoint label only.
 * - Exposes the liveness-probe reads (`getAccounts`, `getKeyPermissions`), the
 *   balances/holdings snapshot reads (`getAccountsPage`, `getPortfolios`,
 *   `getPortfolioBreakdown`, #752), and the append-only activity reads
 *   (`getOrdersPage`, `getFillsPage`) plus the v2 ledger reads
 *   (`getV2AccountsPage`, `getV2TransactionsPage`, #753).
 * - The v2 App-API ledger needs the additional read-only
 *   `wallet:transactions:read` grant. A 401/403 on the v2 path is NOT a source-
 *   wide auth failure (the brokerage key is still fine) — it means the grant is
 *   absent, so those reads throw a distinct {@link CoinbaseScopeError} the
 *   ledger phase catches and skips, leaving the source healthy. Brokerage-path
 *   403s stay terminal `auth` errors (a View-scope key that can't read the
 *   brokerage genuinely needs re-keying).
 */

import { createLogger } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import { signCoinbaseJwt } from "./jwt.js";
import {
  coinbaseAccountsResponseSchema,
  coinbaseFillsResponseSchema,
  coinbaseOrdersResponseSchema,
  coinbasePortfolioBreakdownSchema,
  coinbasePortfoliosResponseSchema,
  coinbaseV2AccountsResponseSchema,
  coinbaseV2TransactionsResponseSchema,
} from "./schemas.js";
import type { z } from "zod";
import type {
  CoinbaseAccountsPage,
  CoinbaseFillsPage,
  CoinbaseOrdersPage,
  CoinbasePortfolioBreakdown,
  CoinbasePortfoliosResponse,
  CoinbaseV2AccountsPage,
  CoinbaseV2TransactionsPage,
} from "./schemas.js";
import type { CoinbaseAccountsResponse, CoinbaseKeyPermissions } from "./types.js";

const log = createLogger("provider:coinbase:client");

export const COINBASE_API_HOST = "api.coinbase.com";
export const COINBASE_BROKERAGE_BASE = "/api/v3/brokerage";
export const COINBASE_V2_BASE = "/v2";

/** Default page size for the historical orders/fills walks (Coinbase caps these at 1000). */
export const ACTIVITY_PAGE_LIMIT = 100;

/**
 * Thrown when a v2 App-API read is denied because the pasted key lacks the
 * additional `wallet:transactions:read` grant (401/403 on the `/v2` path). The
 * ledger phase catches this and skips gracefully — the brokerage key is still
 * valid, so the source stays healthy rather than parking in needs-auth.
 */
export class CoinbaseScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoinbaseScopeError";
  }
}

/** Default backoff hint on a 429 (Coinbase documents no `Retry-After` header). */
const RATE_LIMIT_RETRY_MS = 60_000;

/** Abort a request that hangs longer than this and map it to `network`. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Injectable fetch dependency — tests swap in a mock without touching globals. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface CoinbaseClientOptions {
  /** CDP key id (key name) — the JWT `kid`/`sub`. */
  keyId: string;
  /** CDP private key, PEM (EC P-256 / Ed25519). */
  privateKeyPem: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: FetchFn;
  /** Injectable clock (epoch ms) for deterministic JWT `nbf`/`exp` in tests. */
  now?: () => number;
  /** Override the API host (tests). Defaults to `api.coinbase.com`. */
  host?: string;
  /** Injectable request timeout signal factory (tests skip the real timer). */
  timeoutMs?: number;
}

export class CoinbaseClient {
  private readonly keyId: string;
  private readonly privateKeyPem: string;
  private readonly fetchImpl: FetchFn;
  private readonly now: () => number;
  private readonly host: string;
  private readonly timeoutMs: number;

  constructor(opts: CoinbaseClientOptions) {
    this.keyId = opts.keyId;
    this.privateKeyPem = opts.privateKeyPem;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.host = opts.host ?? COINBASE_API_HOST;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /**
   * Liveness probe: fetch the first account. The cheapest authenticated call;
   * confirms the key is valid and (via `retail_portfolio_id`) yields the
   * stable account identity.
   */
  async getAccounts(limit = 1): Promise<CoinbaseAccountsResponse> {
    const path = `${COINBASE_BROKERAGE_BASE}/accounts?limit=${encodeURIComponent(String(limit))}`;
    return this.get<CoinbaseAccountsResponse>(path);
  }

  /**
   * The discrete view/trade/transfer permissions of the pasted key. Used by
   * `authFlow()` to assert the key is read-only.
   */
  async getKeyPermissions(): Promise<CoinbaseKeyPermissions> {
    return this.get<CoinbaseKeyPermissions>(`${COINBASE_BROKERAGE_BASE}/key_permissions`);
  }

  /**
   * One page of wallet accounts (balances), cursor-paginated. The page size
   * caps at Coinbase's 250 max; the caller chains pages via the returned
   * `cursor` while `has_next` holds. Parsed defensively (zod) so a single
   * tolerant field never wedges the page.
   */
  async getAccountsPage(
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<CoinbaseAccountsPage> {
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(opts.limit ?? 250, 1), 250)));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const raw = await this.get<unknown>(`${COINBASE_BROKERAGE_BASE}/accounts?${params.toString()}`);
    return parse(coinbaseAccountsResponseSchema, raw, "accounts");
  }

  /** List the portfolios for this key (holdings live under each portfolio). */
  async getPortfolios(): Promise<CoinbasePortfoliosResponse> {
    const raw = await this.get<unknown>(`${COINBASE_BROKERAGE_BASE}/portfolios`);
    return parse(coinbasePortfoliosResponseSchema, raw, "portfolios");
  }

  /**
   * The portfolio breakdown for one portfolio UUID — `breakdown.spot_positions`
   * carries the holdings (asset, exact crypto quantity, cost basis). The float
   * aggregate fields it also returns are intentionally not money columns.
   */
  async getPortfolioBreakdown(portfolioUuid: string): Promise<CoinbasePortfolioBreakdown> {
    const raw = await this.get<unknown>(
      `${COINBASE_BROKERAGE_BASE}/portfolios/${encodeURIComponent(portfolioUuid)}`,
    );
    return parse(coinbasePortfolioBreakdownSchema, raw, "portfolio breakdown");
  }

  /**
   * One page of historical orders, cursor-paginated. The caller chains pages
   * via the returned `cursor` while `has_next` holds and filters incremental
   * fetches by `start_date` (RFC3339) so settled history is not re-walked.
   */
  async getOrdersPage(
    opts: { cursor?: string; startDate?: string; limit?: number } = {},
  ): Promise<CoinbaseOrdersPage> {
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(opts.limit ?? ACTIVITY_PAGE_LIMIT, 1), 1000)));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.startDate) params.set("start_date", opts.startDate);
    const raw = await this.get<unknown>(
      `${COINBASE_BROKERAGE_BASE}/orders/historical/batch?${params.toString()}`,
    );
    return parse(coinbaseOrdersResponseSchema, raw, "orders");
  }

  /** One page of fills, cursor-paginated (filtered by `start_sequence_timestamp`). */
  async getFillsPage(
    opts: { cursor?: string; startTime?: string; limit?: number } = {},
  ): Promise<CoinbaseFillsPage> {
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(opts.limit ?? ACTIVITY_PAGE_LIMIT, 1), 1000)));
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.startTime) params.set("start_sequence_timestamp", opts.startTime);
    const raw = await this.get<unknown>(
      `${COINBASE_BROKERAGE_BASE}/orders/historical/fills?${params.toString()}`,
    );
    return parse(coinbaseFillsResponseSchema, raw, "fills");
  }

  /**
   * One page of v2 wallet accounts (the ledger is per-account). On the `/v2`
   * path a 401/403 means the `wallet:transactions:read` grant is absent →
   * {@link CoinbaseScopeError}, which the ledger phase skips gracefully.
   */
  async getV2AccountsPage(
    opts: { startingAfter?: string; limit?: number } = {},
  ): Promise<CoinbaseV2AccountsPage> {
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(opts.limit ?? ACTIVITY_PAGE_LIMIT, 1), 100)));
    if (opts.startingAfter) params.set("starting_after", opts.startingAfter);
    const raw = await this.getV2<unknown>(`${COINBASE_V2_BASE}/accounts?${params.toString()}`);
    return parse(coinbaseV2AccountsResponseSchema, raw, "v2 accounts");
  }

  /** One page of v2 ledger transactions for a wallet account (cursor = `starting_after`). */
  async getV2TransactionsPage(
    accountId: string,
    opts: { startingAfter?: string; limit?: number } = {},
  ): Promise<CoinbaseV2TransactionsPage> {
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(opts.limit ?? ACTIVITY_PAGE_LIMIT, 1), 100)));
    if (opts.startingAfter) params.set("starting_after", opts.startingAfter);
    const raw = await this.getV2<unknown>(
      `${COINBASE_V2_BASE}/accounts/${encodeURIComponent(accountId)}/transactions?${params.toString()}`,
    );
    return parse(coinbaseV2TransactionsResponseSchema, raw, "v2 transactions");
  }

  /**
   * A `/v2` read. Identical signing/transport to {@link get}, but a 401/403 is
   * mapped to {@link CoinbaseScopeError} (missing grant, skip the phase) rather
   * than a terminal `auth` SyncError, because the brokerage key is still valid.
   */
  private async getV2<T>(path: string): Promise<T> {
    try {
      return await this.get<T>(path);
    } catch (err) {
      if (err instanceof SyncError && err.kind === "auth") {
        throw new CoinbaseScopeError(
          "Coinbase v2 transaction ledger denied — the key lacks the wallet:transactions:read grant.",
        );
      }
      throw err;
    }
  }

  private async get<T>(path: string): Promise<T> {
    const fullPath = path.startsWith("/") ? path : `/${path}`;
    const url = `https://${this.host}${fullPath}`;
    const jwt = signCoinbaseJwt({
      keyId: this.keyId,
      privateKeyPem: this.privateKeyPem,
      // Coinbase signs METHOD + host + PATH only — the query string is
      // excluded from the `uri` claim (a `?limit=1` mismatch would 401).
      request: { method: "GET", host: this.host, path: stripQuery(fullPath) },
      nowEpochSeconds: this.now() / 1000,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      const reason = (err as Error)?.name === "AbortError" ? "timed out" : "failed";
      throw new SyncError("network", `Coinbase request ${reason}.`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch (err) {
        throw new SyncError("unknown", `Coinbase returned an unparseable response.`, {
          cause: err,
        });
      }
    }

    if (res.status === 401) {
      throw new SyncError("auth", `Coinbase rejected the API key (HTTP 401).`);
    }
    if (res.status === 403) {
      // Insufficient scope — surfaced as auth so the source parks in needs-auth
      // with a re-key hint rather than retrying a permanently-denied call.
      throw new SyncError(
        "auth",
        `Coinbase denied the request (HTTP 403) — the key lacks the required View permission.`,
      );
    }
    if (res.status === 429) {
      log.warn("Coinbase rate limit hit (HTTP 429) — deferring");
      // The CDP key signed into every request IS the per-account credential
      // (see the module doc comment) — there is no Omnesis-wide app secret in
      // the picture, so any budget Coinbase enforces on it is the account's own.
      throw new SyncError("rate-limit", `Coinbase rate limit exceeded.`, {
        retryAfterMs: RATE_LIMIT_RETRY_MS,
        quota: { kind: "account" },
      });
    }
    if (res.status >= 500) {
      throw new SyncError("transient", `Coinbase server error (HTTP ${res.status}).`);
    }
    throw new SyncError("unknown", `Coinbase request failed (HTTP ${res.status}).`);
  }
}

/** The path with any query string removed — Coinbase signs the path only. */
function stripQuery(path: string): string {
  const q = path.indexOf("?");
  return q === -1 ? path : path.slice(0, q);
}

/**
 * Parse a raw response through its zod schema, mapping a shape mismatch to a
 * typed `unknown` SyncError (the message names the endpoint label only — never
 * the body, which may carry balances). A schema mismatch is a real upstream
 * shape change, not something to silently coerce.
 */
function parse<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new SyncError("unknown", `Coinbase ${label} response had an unexpected shape.`, {
      cause: result.error,
    });
  }
  return result.data;
}

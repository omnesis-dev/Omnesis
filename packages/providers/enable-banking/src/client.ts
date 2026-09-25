// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SyncError } from "@omnesis/types";
import { signEnableBankingJwt } from "./jwt.js";
import {
  ebAspspsResponseSchema,
  ebAuthStartResponseSchema,
  ebBalancesResponseSchema,
  ebSessionResponseSchema,
  ebTransactionsPageSchema,
} from "./schemas.js";
import type { ZodError, ZodType } from "zod";
import type { EbAspsp, EbBalance, EbSessionResponse, EbTransactionsPage } from "./types.js";

const EB_API_BASE = "https://api.enablebanking.com";

/**
 * ASPSP unattended-fetch caps (commonly 4/day, Revolut included) return 429.
 * Enable Banking's guidance is to retry after ~6 hours; the deadline is
 * handed to the scheduler immediately — a tick must never sleep through it.
 */
export const EB_RATE_LIMIT_RETRY_MS = 6 * 60 * 60 * 1000;

export interface EnableBankingClientOptions {
  applicationId: string;
  privateKeyPem: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic JWTs in tests. */
  now?: () => Date;
}

export interface StartAuthParams {
  /** ISO 8601 — how long the consent should stay valid (max 180d for most ASPSPs). */
  validUntil: string;
  /** Exact ASPSP name as returned by `GET /aspsps`. */
  aspspName: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  /** Whitelisted HTTPS redirect URL of the user's application. */
  redirectUrl: string;
  /** Round-trip state — the gateway flow id, so `/oauth/callback` can route the code. */
  state: string;
}

export interface GetTransactionsParams {
  /** YYYY-MM-DD lower bound (inclusive). Omit for full history (post-SCA window). */
  dateFrom?: string;
  /** Continuation key from the previous page. */
  continuationKey?: string;
  /** Transaction status filter — this source always syncs "BOOK" (booked only). */
  transactionStatus?: string;
}

/**
 * Subset of the client the sync source depends on — lets tests and the
 * synthetic twin substitute a hand-rolled fake without touching HTTP.
 */
export interface EnableBankingTransport {
  getBalances(accountUid: string): Promise<EbBalance[]>;
  getTransactions(accountUid: string, params?: GetTransactionsParams): Promise<EbTransactionsPage>;
}

/**
 * Thin client for the Enable Banking API. Every request carries a freshly
 * minted RS256 application JWT (`Authorization: Bearer …`). Responses are
 * zod-parsed at this boundary; errors map to typed `SyncError`s so the
 * collector routes the source correctly: `auth` parks it in needs-auth,
 * `rate-limit` carries the 6-hour `retryAfterMs` hint the sync engine
 * honors — it parks the source in `rate-limited` and defers the next tick
 * to that deadline — and `transient`/`network` retry on the next tick.
 * Error messages carry status + safe summary only — never tokens, JWTs,
 * or response bodies.
 */
export class EnableBankingClient implements EnableBankingTransport {
  private readonly applicationId: string;
  private readonly privateKeyPem: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(opts: EnableBankingClientOptions) {
    this.applicationId = opts.applicationId;
    this.privateKeyPem = opts.privateKeyPem;
    this.baseUrl = opts.baseUrl ?? EB_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** List available banks for a country. */
  async getAspsps(country: string): Promise<EbAspsp[]> {
    const query = new URLSearchParams({ country });
    const res = await this.request(`/aspsps?${query.toString()}`, ebAspspsResponseSchema, {});
    return res.aspsps;
  }

  /** Start a user authorization — returns the URL the user opens for SCA. */
  async startAuth(params: StartAuthParams): Promise<{ url: string }> {
    const body = {
      access: { valid_until: params.validUntil },
      aspsp: { name: params.aspspName, country: params.country },
      state: params.state,
      redirect_url: params.redirectUrl,
      psu_type: "personal",
    };
    let res: { url: string };
    try {
      res = await this.request("/auth", ebAuthStartResponseSchema, {
        method: "POST",
        body,
      });
    } catch (err) {
      // The URL is one the user typed (or accepted as a default built from the
      // gateway's own address), and Enable Banking accepts only the ones
      // registered on the application. The bare code tells them neither which
      // URL was sent nor where to allow it — and the default differs on every
      // gateway, so a second instance fails here while the first one works.
      if (
        err instanceof EnableBankingRequestError &&
        err.errorCode === "REDIRECT_URI_NOT_ALLOWED"
      ) {
        throw new EnableBankingRedirectNotAllowedError(params.redirectUrl, err);
      }
      throw err;
    }
    return { url: res.url };
  }

  /** Exchange the redirect `code` for a session. */
  async createSession(code: string): Promise<EbSessionResponse> {
    return this.request("/sessions", ebSessionResponseSchema, {
      method: "POST",
      body: { code },
    });
  }

  async getBalances(accountUid: string): Promise<EbBalance[]> {
    const res = await this.request(
      `/accounts/${encodeURIComponent(accountUid)}/balances`,
      ebBalancesResponseSchema,
      {},
    );
    return res.balances;
  }

  async getTransactions(
    accountUid: string,
    params: GetTransactionsParams = {},
  ): Promise<EbTransactionsPage> {
    const query = new URLSearchParams();
    if (params.dateFrom) query.set("date_from", params.dateFrom);
    if (params.transactionStatus) query.set("transaction_status", params.transactionStatus);
    if (params.continuationKey) query.set("continuation_key", params.continuationKey);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request(
      `/accounts/${encodeURIComponent(accountUid)}/transactions${suffix}`,
      ebTransactionsPageSchema,
      {},
    );
  }

  private async request<T>(
    path: string,
    schema: ZodType<T>,
    opts: { method?: string; body?: unknown },
  ): Promise<T> {
    const jwt = signEnableBankingJwt({
      applicationId: this.applicationId,
      privateKeyPem: this.privateKeyPem,
      nowEpochSeconds: this.now().getTime() / 1000,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new SyncError("network", `Enable Banking request failed: ${(err as Error).message}`, {
        cause: err,
      });
    }

    if (!res.ok) {
      const code = await safeErrorCode(res);
      const suffix = code ? ` (${code})` : "";
      if (res.status === 401 || res.status === 403) {
        throw new SyncError(
          "auth",
          `Enable Banking rejected the request (HTTP ${res.status})${suffix} — the session or application key may need re-authorization.`,
        );
      }
      if (res.status === 429) {
        // ASPSP unattended-access cap — surface the deadline to the
        // scheduler immediately, never sleep through it in-tick. The cap is
        // the bank's own per-PSU/per-consent allowance, not a budget Enable
        // Banking's API shares across every connected bank, so it is counted
        // against this one connected account.
        throw new SyncError(
          "rate-limit",
          `Enable Banking rate limit (HTTP 429)${suffix} — ASPSP unattended-access cap reached; retrying in ~6h.`,
          { retryAfterMs: EB_RATE_LIMIT_RETRY_MS, quota: { kind: "account" } },
        );
      }
      if (res.status >= 500) {
        throw new SyncError("transient", `Enable Banking server error (HTTP ${res.status}).`);
      }
      throw new EnableBankingRequestError(
        `Enable Banking request to ${redactPath(path)} failed (HTTP ${res.status})${suffix}.`,
        res.status,
        code,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new SyncError(
        "unknown",
        `Enable Banking returned a non-JSON response for ${redactPath(path)}.`,
      );
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new SyncError(
        "unknown",
        `Enable Banking response for ${redactPath(path)} failed validation: ${formatZodIssues(parsed.error)}`,
      );
    }
    return parsed.data;
  }
}

/**
 * A request Enable Banking answered with a client error. Carries the
 * machine-readable code so a caller that knows what a specific code means can
 * say so, instead of matching the text of the message.
 */
export class EnableBankingRequestError extends SyncError {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string | undefined,
  ) {
    super("unknown", message);
    this.name = "EnableBankingRequestError";
  }
}

/**
 * Enable Banking refused the redirect URL because it is not registered on the
 * application. Names the URL that was sent: the default is built from the
 * gateway's own address, so it differs on every gateway, and "the redirect URL"
 * without the value leaves the operator guessing which one.
 */
export class EnableBankingRedirectNotAllowedError extends SyncError {
  constructor(
    readonly redirectUrl: string,
    cause: unknown,
  ) {
    super("permission", `Enable Banking does not allow the redirect URL ${redirectUrl}.`, {
      cause,
    });
    this.name = "EnableBankingRedirectNotAllowedError";
  }
}

/**
 * Pull the machine-readable `error` code (an enum, e.g.
 * ASPSP_RATE_LIMIT_EXCEEDED) out of an error body. The free-form
 * `error_description` is deliberately dropped — it may carry PII.
 */
async function safeErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error.slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

/** Strip account uids from paths used in error messages. */
function redactPath(path: string): string {
  return path.replace(/\/accounts\/[^/]+/, "/accounts/…").replace(/\?.*$/, "");
}

/** First few zod issues as `path: message` — never includes received values. */
function formatZodIssues(err: ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

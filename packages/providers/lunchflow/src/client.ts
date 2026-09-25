// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger, retry } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import {
  lunchflowAccountsResponseSchema,
  lunchflowBalanceResponseSchema,
  lunchflowTransactionsResponseSchema,
} from "./schemas.js";
import type { ZodError, ZodType } from "zod";
import type { RetryOptions } from "@omnesis/core";
import type { LunchflowAccount, LunchflowBalance, LunchflowTransaction } from "./types.js";

const LUNCHFLOW_API_BASE = "https://www.lunchflow.app/api/v1";
const LUNCHFLOW_REQUEST_MAX_ATTEMPTS = 3;
const LUNCHFLOW_REQUEST_BASE_BACKOFF_MS = 500;
const LUNCHFLOW_REQUEST_MAX_BACKOFF_MS = 2_000;

const log = createLogger("provider:lunchflow:client");

/**
 * Lunch Flow does not document a rate limit; when one surfaces (HTTP 429)
 * with no `Retry-After`, back off for an hour rather than hammer the
 * aggregator. A present `Retry-After` (delta-seconds or HTTP-date) always wins.
 */
export const LUNCHFLOW_RATE_LIMIT_RETRY_MS = 60 * 60 * 1000;

/**
 * A per-account endpoint returned 404 ("Account not found"). The account was
 * disconnected/removed at Lunch Flow between listing it and fetching it — the
 * sync skips just that account and carries on with the others, rather than
 * wedging the whole tick. Not a `SyncError`: it is expected and recoverable.
 */
export class LunchflowAccountGoneError extends Error {
  constructor(readonly accountId: string) {
    super(`Lunch Flow account ${accountId} not found (disconnected?)`);
    this.name = "LunchflowAccountGoneError";
  }
}

export interface LunchflowClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. Defaults to the canonical retry timer. */
  sleep?: RetryOptions["sleep"];
}

export interface GetTransactionsParams {
  /** YYYY-MM-DD lower bound (inclusive). Omit for full history. */
  from?: string;
  /** YYYY-MM-DD upper bound (inclusive). */
  to?: string;
  /** Include pending transactions — this source always syncs booked only. */
  includePending?: boolean;
}

/**
 * Subset of the client the sync source depends on — lets tests and the
 * synthetic twin substitute a hand-rolled fake without touching HTTP.
 */
export interface LunchflowTransport {
  listAccounts(): Promise<LunchflowAccount[]>;
  getTransactions(
    accountId: string,
    params?: GetTransactionsParams,
  ): Promise<LunchflowTransaction[]>;
  getBalance(accountId: string): Promise<LunchflowBalance>;
}

/**
 * Thin client for the Lunch Flow API. Every request carries the user's API
 * key (`x-api-key`). Responses are zod-parsed at this boundary; errors map to
 * typed `SyncError`s so the collector routes the source correctly. Network
 * failures and 5xx responses get a short bounded retry before escaping to the
 * collector, unless a 5xx asks for a longer delay; auth and rate-limit errors
 * escape immediately. A per-account 404 surfaces as
 * `LunchflowAccountGoneError` so the caller can skip that account.
 * Network/server error messages carry status + a safe summary only — never
 * API keys, bodies, account ids, or raw fetch causes.
 */
export class LunchflowClient implements LunchflowTransport {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: RetryOptions["sleep"];

  constructor(opts: LunchflowClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? LUNCHFLOW_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep;
  }

  async listAccounts(): Promise<LunchflowAccount[]> {
    const res = await this.request("/accounts", lunchflowAccountsResponseSchema, {});
    return res.accounts;
  }

  async getTransactions(
    accountId: string,
    params: GetTransactionsParams = {},
  ): Promise<LunchflowTransaction[]> {
    const query = new URLSearchParams();
    if (params.from) query.set("from", params.from);
    if (params.to) query.set("to", params.to);
    query.set("include_pending", params.includePending ? "true" : "false");
    const res = await this.request(
      `/accounts/${encodeURIComponent(accountId)}/transactions?${query.toString()}`,
      lunchflowTransactionsResponseSchema,
      { accountId },
    );
    return res.transactions;
  }

  async getBalance(accountId: string): Promise<LunchflowBalance> {
    const res = await this.request(
      `/accounts/${encodeURIComponent(accountId)}/balance`,
      lunchflowBalanceResponseSchema,
      { accountId },
    );
    return res.balance;
  }

  private async request<T>(
    path: string,
    schema: ZodType<T>,
    opts: { accountId?: string },
  ): Promise<T> {
    const safePath = redactPath(path);
    const res = await retry<Response, unknown>(
      async () => {
        let response: Response;
        try {
          response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            headers: {
              "x-api-key": this.apiKey,
              Accept: "application/json",
            },
          });
        } catch (err) {
          throw networkSyncError(safePath, err);
        }

        if (response.status >= 500) {
          await response.body?.cancel().catch(() => undefined);
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          throw new SyncError(
            "transient",
            `Lunch Flow server error for ${safePath} (HTTP ${response.status}).`,
            { retryAfterMs },
          );
        }
        return response;
      },
      {
        maxAttempts: LUNCHFLOW_REQUEST_MAX_ATTEMPTS,
        baseBackoffMs: LUNCHFLOW_REQUEST_BASE_BACKOFF_MS,
        maxBackoffMs: LUNCHFLOW_REQUEST_MAX_BACKOFF_MS,
        sleep: this.sleep,
        shouldRetry: (err) => {
          if (!(err instanceof SyncError)) return false;
          if (err.kind === "network") return true;
          return (
            err.kind === "transient" &&
            (err.retryAfterMs === undefined || err.retryAfterMs <= LUNCHFLOW_REQUEST_MAX_BACKOFF_MS)
          );
        },
        computeBackoff: (err, _attempt, defaultMs) =>
          err instanceof SyncError && err.retryAfterMs !== undefined ? err.retryAfterMs : defaultMs,
        onRetry: (err, attempt, delayMs) => {
          const message = err instanceof Error ? err.message : "transient request failure";
          log.warn(
            `${message} Retrying in ${delayMs}ms (attempt ${attempt}/${LUNCHFLOW_REQUEST_MAX_ATTEMPTS}).`,
          );
        },
      },
    );

    if (!res.ok) {
      if (res.status === 404 && opts.accountId !== undefined) {
        throw new LunchflowAccountGoneError(opts.accountId);
      }
      if (res.status === 401 || res.status === 403) {
        throw new SyncError(
          "auth",
          `Lunch Flow rejected the request (HTTP ${res.status}) — the API key is missing, invalid, or revoked. Re-run the setup to paste a fresh key.`,
        );
      }
      if (res.status === 429) {
        // Every request carries the user's own `x-api-key` — Lunch Flow has no
        // Omnesis-wide app credential for a limit to attach to, so a 429 can
        // only be budgeted against this account's key.
        throw new SyncError(
          "rate-limit",
          `Lunch Flow rate limit (HTTP 429) — backing off before the next tick.`,
          { retryAfterMs: retryAfterMs(res), quota: { kind: "account" } },
        );
      }
      throw new SyncError(
        "unknown",
        `Lunch Flow request to ${safePath} failed (HTTP ${res.status}).`,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new SyncError("unknown", `Lunch Flow returned a non-JSON response for ${safePath}.`);
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new SyncError(
        "unknown",
        `Lunch Flow response for ${safePath} failed validation: ${formatZodIssues(parsed.error)}`,
      );
    }
    return parsed.data;
  }
}

/** `Retry-After` (delta-seconds or HTTP-date) when present, else the default backoff. */
function retryAfterMs(res: Response): number {
  return parseRetryAfterMs(res.headers.get("retry-after")) ?? LUNCHFLOW_RATE_LIMIT_RETRY_MS;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function networkSyncError(path: string, cause: unknown): SyncError {
  const code = networkErrorCode(cause);
  const safeCause = Object.assign(new Error("Lunch Flow network request failed"), {
    ...(code ? { code } : {}),
  });
  return new SyncError(
    "network",
    `Lunch Flow network request to ${path} failed${code ? ` (${code})` : ""}.`,
    { cause: safeCause },
  );
}

/** Extract only a conventional machine-readable code; cause messages can contain sensitive URLs. */
function networkErrorCode(value: unknown): string | undefined {
  let current = value;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

/** Strip account ids and query strings from paths used in error messages. */
function redactPath(path: string): string {
  return path.replace(/\/accounts\/[^/?]+/, "/accounts/…").replace(/\?.*$/, "");
}

/** First few zod issues as `path: message` — never includes received values. */
function formatZodIssues(err: ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

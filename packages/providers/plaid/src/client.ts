// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SyncError } from "@omnesis/types";
import {
  plaidAccountsGetResponseSchema,
  plaidErrorResponseSchema,
  plaidInstitutionGetByIdResponseSchema,
  plaidInvestmentsHoldingsGetResponseSchema,
  plaidItemGetResponseSchema,
  plaidItemPublicTokenExchangeResponseSchema,
  plaidItemRemoveResponseSchema,
  plaidLinkTokenCreateResponseSchema,
  plaidLinkTokenGetResponseSchema,
  plaidTransactionsSyncResponseSchema,
} from "./schemas.js";
import { PLAID_DEFAULT_COUNTRIES, plaidHost } from "./types.js";
import type {
  PlaidAccountsGetResponse,
  PlaidInstitutionGetByIdResponse,
  PlaidInvestmentsHoldingsGetResponse,
  PlaidItemGetResponse,
  PlaidItemPublicTokenExchangeResponse,
  PlaidItemRemoveResponse,
  PlaidLinkTokenCreateResponse,
  PlaidLinkTokenGetResponse,
  PlaidTransactionsSyncResponse,
} from "./schemas.js";
import type { PlaidEnvironment } from "./types.js";
import type { SyncErrorOptions } from "@omnesis/types";
import type { ZodError, ZodType } from "zod";

/**
 * A non-2xx Plaid response, carrying Plaid's `error_code` so callers can act on
 * the specific condition — an item that is already gone, an institution with no
 * investment accounts, a page invalidated mid-pagination — rather than on the
 * coarse `SyncError` kind the collector routes on. The message never includes
 * the response body, the secret, or the access token.
 */
export class PlaidApiError extends SyncError {
  readonly errorCode?: string;

  constructor(
    kind: SyncError["kind"],
    message: string,
    opts: SyncErrorOptions & { errorCode?: string } = {},
  ) {
    const { errorCode, ...rest } = opts;
    super(kind, message, rest);
    this.name = "PlaidApiError";
    this.errorCode = errorCode;
  }
}

/** The shape of every Plaid `error_code`; anything else is not trusted into a message. */
const PLAID_ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;

/**
 * The API version the response schemas are written against. Sent on every
 * request, because a Plaid dashboard carries a per-team default version and two
 * operators would otherwise get different response shapes from the same code.
 */
export const PLAID_API_VERSION = "2020-09-14";

/**
 * Plaid `error_code` values meaning the item no longer exists — the token is
 * unknown, or the item was removed by `/item/remove`, from the dashboard, or by
 * the user through Plaid Portal. A revoke that meets one of these is done.
 */
export const PLAID_ITEM_GONE_CODES: ReadonlySet<string> = new Set([
  "INVALID_ACCESS_TOKEN",
  "ITEM_NOT_FOUND",
  "ITEM_CONCURRENTLY_DELETED",
]);

/**
 * `/investments/holdings/get` answers for an item that carries no investment
 * account. `investments` is only an optional product, so this is the ordinary
 * response for a deposit-only bank, not a failure.
 */
export const PLAID_NO_INVESTMENTS_CODES: ReadonlySet<string> = new Set([
  "NO_INVESTMENT_ACCOUNTS",
  "PRODUCTS_NOT_SUPPORTED",
]);

/**
 * The page a `/transactions/sync` pagination run was on has been invalidated by
 * data changing underneath it. Plaid's remedy is to restart the run from the
 * cursor it began with — not from the failing page, which would recur.
 */
export const PLAID_SYNC_MUTATION_CODE = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

/**
 * Conditions that clear on their own: the institution is unreachable or busy,
 * or the user is still working through Link. Retrying on the next tick is the
 * whole remedy, so these must not surface as errors the operator has to read.
 */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
  "INSTITUTION_NOT_AVAILABLE",
  "INSTITUTION_RATE_LIMIT",
  "PRODUCT_NOT_READY",
]);

/**
 * Conditions only the user can clear, by signing in again through Link update
 * mode. The collector parks the source in needs-auth and prompts, instead of
 * retrying every interval forever.
 */
/**
 * The app credential itself is wrong — every connected bank fails at once, and
 * no amount of reconnecting one of them helps, because the operator has to fix
 * the credential.
 */
const APP_CREDENTIAL_ERROR_CODES: ReadonlySet<string> = new Set([
  "INVALID_API_KEYS",
  "INVALID_CLIENT_ID",
  "INVALID_SECRET",
]);

const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  ...PLAID_ITEM_GONE_CODES,
  ...APP_CREDENTIAL_ERROR_CODES,
  "ITEM_LOGIN_REQUIRED",
  "ACCESS_NOT_GRANTED",
  "USER_PERMISSION_REVOKED",
  "USER_ACCOUNT_REVOKED",
  "INVALID_CREDENTIALS",
  "INVALID_UPDATED_USERNAME",
  "ITEM_LOCKED",
  "PASSWORD_RESET_REQUIRED",
  "USER_SETUP_REQUIRED",
  // Nobody is watching a background sync, so these never clear on their own:
  // each needs the user back in Link before the bank will answer again.
  "INVALID_MFA",
  "USER_INPUT_TIMEOUT",
  "INSUFFICIENT_CREDENTIALS",
  "NO_ACCOUNTS",
]);

/** Back-off when Plaid signals a rate limit without a `Retry-After` header. */
export const PLAID_RATE_LIMIT_RETRY_MS = 60 * 1000;

/**
 * Read-only account-information products required at Link time. Link only lists
 * institutions supporting every required product, so this stays minimal.
 * **Never** payment-initiation, transfer, or any write product.
 */
export const PLAID_PRODUCTS: readonly string[] = ["transactions"];

/**
 * Products requested only where the institution supports them, so deposit-only
 * banks stay in the picker and only items with a brokerage account carry the
 * investments subscription.
 */
export const PLAID_OPTIONAL_PRODUCTS: readonly string[] = ["investments"];

/**
 * Transaction history requested when an item is created. Plaid defaults to 90
 * days and fixes the figure for the life of the item, so ask for the maximum.
 */
export const PLAID_TRANSACTIONS_DAYS_REQUESTED = 730;

/** The Omnesis-side label Plaid records on the Link session. */
export const PLAID_CLIENT_NAME = "Omnesis";

/** Page size for `/transactions/sync` — Plaid's per-request maximum. */
export const PLAID_TRANSACTIONS_SYNC_COUNT = 500;

/** Parameters for one `/transactions/sync` page. */
export interface TransactionsSyncParams {
  /** The per-item access token (a secret — never logged). */
  accessToken: string;
  /** The delta cursor from the previous page; omitted to walk from the start. */
  cursor?: string;
  /** Rows per page; defaults to the Plaid maximum. */
  count?: number;
}

/** Parameters for minting a Link token. */
export interface LinkTokenCreateParams {
  /**
   * Stable Omnesis-side user handle Plaid associates the Link session with.
   * Not a Plaid credential — an opaque identifier for the operator's install.
   */
  clientUserId: string;
  /** When set, opens Link in update mode to refresh consent on an existing item. */
  accessToken?: string;
}

export interface PlaidClientOptions {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
  /** Countries whose institutions Link offers; defaults to US and Canada. */
  countryCodes?: readonly string[];
  /** Overrides the environment host (tests). */
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Per-request options every client method accepts. */
export interface PlaidRequestOptions {
  /** Aborts the in-flight request when the collector cancels the sync. */
  signal?: AbortSignal;
}

/**
 * The slice of the client the auth flow and the sync sources depend on, so
 * tests and the synthetic twin substitute a hand-rolled fake without HTTP.
 */
export interface PlaidTransport {
  linkTokenCreate(params: LinkTokenCreateParams): Promise<PlaidLinkTokenCreateResponse>;
  linkTokenGet(linkToken: string): Promise<PlaidLinkTokenGetResponse>;
  itemPublicTokenExchange(publicToken: string): Promise<PlaidItemPublicTokenExchangeResponse>;
  itemGet(accessToken: string, opts?: PlaidRequestOptions): Promise<PlaidItemGetResponse>;
  itemRemove(accessToken: string): Promise<PlaidItemRemoveResponse>;
  institutionGetById(institutionId: string): Promise<PlaidInstitutionGetByIdResponse>;
  transactionsSync(
    params: TransactionsSyncParams,
    opts?: PlaidRequestOptions,
  ): Promise<PlaidTransactionsSyncResponse>;
  accountsGet(accessToken: string, opts?: PlaidRequestOptions): Promise<PlaidAccountsGetResponse>;
  investmentsHoldingsGet(
    accessToken: string,
    opts?: PlaidRequestOptions,
  ): Promise<PlaidInvestmentsHoldingsGetResponse>;
}

/**
 * Thin client for the Plaid API. Every request authenticates with the
 * operator's `client_id` + `secret` in the JSON body (Plaid's scheme) — never a
 * header, never logged. Responses are zod-parsed at this boundary; failures map
 * to typed `PlaidApiError`s so the collector routes the source correctly:
 * `auth` parks it in needs-auth, `rate-limit` carries the `retryAfterMs` hint,
 * `transient`/`network` retry on the next tick. Messages carry the Plaid
 * `error_code` and a safe summary only — never a secret, token, or body.
 */
export class PlaidClient implements PlaidTransport {
  private readonly clientId: string;
  private readonly secret: string;
  private readonly countryCodes: readonly string[];
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PlaidClientOptions) {
    this.clientId = opts.clientId;
    this.secret = opts.secret;
    this.countryCodes = opts.countryCodes?.length ? opts.countryCodes : PLAID_DEFAULT_COUNTRIES;
    this.baseUrl = opts.baseUrl ?? plaidHost(opts.environment);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Mint a Link token for a **Hosted Link** session: Plaid serves the whole
   * sign-in page, including the redirect out to an OAuth bank and back, so
   * Omnesis hands the user a URL and never embeds a widget or hosts a callback.
   * Passing `accessToken` opens the session in update mode on that item.
   */
  async linkTokenCreate(params: LinkTokenCreateParams): Promise<PlaidLinkTokenCreateResponse> {
    const body: Record<string, unknown> = {
      client_name: PLAID_CLIENT_NAME,
      language: "en",
      country_codes: this.countryCodes,
      user: { client_user_id: params.clientUserId },
      // An empty object is what enables Hosted Link; its defaults (a 30-minute
      // URL lifetime for a link Omnesis delivers itself) are what we want.
      hosted_link: {},
    };
    if (params.accessToken) {
      // Update mode: products and history are inherited from the existing item.
      body.access_token = params.accessToken;
    } else {
      body.products = PLAID_PRODUCTS;
      body.optional_products = PLAID_OPTIONAL_PRODUCTS;
      body.transactions = { days_requested: PLAID_TRANSACTIONS_DAYS_REQUESTED };
    }
    return this.request("/link/token/create", plaidLinkTokenCreateResponseSchema, body);
  }

  /** Read a Link token's sessions — how a Hosted Link flow learns its outcome. */
  async linkTokenGet(linkToken: string): Promise<PlaidLinkTokenGetResponse> {
    return this.request("/link/token/get", plaidLinkTokenGetResponseSchema, {
      link_token: linkToken,
    });
  }

  async itemPublicTokenExchange(
    publicToken: string,
  ): Promise<PlaidItemPublicTokenExchangeResponse> {
    return this.request("/item/public_token/exchange", plaidItemPublicTokenExchangeResponseSchema, {
      public_token: publicToken,
    });
  }

  async itemGet(accessToken: string, opts?: PlaidRequestOptions): Promise<PlaidItemGetResponse> {
    return this.request(
      "/item/get",
      plaidItemGetResponseSchema,
      { access_token: accessToken },
      opts,
    );
  }

  async itemRemove(accessToken: string): Promise<PlaidItemRemoveResponse> {
    // Disconnects the item at Plaid: invalidates the access token and ends the
    // item's product subscriptions, which otherwise bill until it is removed.
    return this.request("/item/remove", plaidItemRemoveResponseSchema, {
      access_token: accessToken,
    });
  }

  /** Institution identity and branding, for the connected instance's icon. */
  async institutionGetById(institutionId: string): Promise<PlaidInstitutionGetByIdResponse> {
    return this.request("/institutions/get_by_id", plaidInstitutionGetByIdResponseSchema, {
      institution_id: institutionId,
      country_codes: this.countryCodes,
      options: { include_optional_metadata: true },
    });
  }

  async transactionsSync(
    params: TransactionsSyncParams,
    opts?: PlaidRequestOptions,
  ): Promise<PlaidTransactionsSyncResponse> {
    const body: Record<string, unknown> = {
      access_token: params.accessToken,
      count: params.count ?? PLAID_TRANSACTIONS_SYNC_COUNT,
    };
    // Omit `cursor` entirely on the first sync — Plaid treats an absent cursor
    // as "from the beginning", but rejects an empty-string cursor.
    if (params.cursor) body.cursor = params.cursor;
    return this.request("/transactions/sync", plaidTransactionsSyncResponseSchema, body, opts);
  }

  async accountsGet(
    accessToken: string,
    opts?: PlaidRequestOptions,
  ): Promise<PlaidAccountsGetResponse> {
    // Every account on the item with the balances Plaid last refreshed. Free,
    // and fresh enough for a daily snapshot; `/accounts/balance/get` forces a
    // live pull from the institution and is billed per request.
    return this.request(
      "/accounts/get",
      plaidAccountsGetResponseSchema,
      { access_token: accessToken },
      opts,
    );
  }

  async investmentsHoldingsGet(
    accessToken: string,
    opts?: PlaidRequestOptions,
  ): Promise<PlaidInvestmentsHoldingsGetResponse> {
    return this.request(
      "/investments/holdings/get",
      plaidInvestmentsHoldingsGetResponseSchema,
      { access_token: accessToken },
      opts,
    );
  }

  private async request<T>(
    path: string,
    schema: ZodType<T>,
    body: Record<string, unknown>,
    opts?: PlaidRequestOptions,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Plaid-Version": PLAID_API_VERSION,
        },
        // The operator credentials authenticate every request, in the body.
        body: JSON.stringify({ client_id: this.clientId, secret: this.secret, ...body }),
        signal: opts?.signal,
      });
    } catch (err) {
      if (opts?.signal?.aborted) {
        throw new SyncError("transient", `Plaid request to ${path} was cancelled.`);
      }
      throw new SyncError("network", `Plaid request to ${path} failed: ${(err as Error).message}`, {
        cause: err,
      });
    }

    if (!res.ok) throw await this.errorFor(res, path);

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new SyncError("unknown", `Plaid returned a non-JSON response for ${path}.`);
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new SyncError(
        "unknown",
        `Plaid response for ${path} failed validation: ${formatZodIssues(parsed.error)}`,
      );
    }
    return parsed.data;
  }

  /** Map a non-2xx Plaid response onto a typed `PlaidApiError` by `error_code`. */
  private async errorFor(res: Response, path: string): Promise<PlaidApiError> {
    const code = await this.readErrorCode(res);
    const suffix = code ? ` (${code})` : "";
    if (code && APP_CREDENTIAL_ERROR_CODES.has(code)) {
      return new PlaidApiError(
        "auth",
        `Plaid rejected the app credential${suffix}. Check the client ID and the secret for this ` +
          `environment in the Plaid dashboard — every connected bank fails until it is fixed.`,
        // One credential is shared by every connected item, so this failure
        // reaches the whole connection rather than the item that happened to
        // make the request.
        { errorCode: code, scope: "connection" },
      );
    }
    if ((code && AUTH_ERROR_CODES.has(code)) || res.status === 401 || res.status === 403) {
      return new PlaidApiError(
        "auth",
        `Plaid says this bank's consent is no longer valid${suffix}. Reconnect the bank to ` +
          `restore access.`,
        { errorCode: code },
      );
    }
    if (code === "RATE_LIMIT_EXCEEDED" || res.status === 429) {
      return new PlaidApiError(
        "rate-limit",
        `Plaid rate limit${suffix} — backing off before retry.`,
        { errorCode: code, retryAfterMs: retryAfterMs(res) },
      );
    }
    if (res.status >= 500) {
      return new PlaidApiError("transient", `Plaid server error (HTTP ${res.status})${suffix}.`, {
        errorCode: code,
      });
    }
    if (code && TRANSIENT_ERROR_CODES.has(code)) {
      return new PlaidApiError(
        "transient",
        `Plaid could not reach the bank right now${suffix} — retrying on the next sync.`,
        { errorCode: code },
      );
    }
    return new PlaidApiError(
      "unknown",
      `Plaid request to ${path} failed (HTTP ${res.status})${suffix}.`,
      { errorCode: code },
    );
  }

  /** Best-effort extraction of `error_code` without ever surfacing the body. */
  private async readErrorCode(res: Response): Promise<string | undefined> {
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return undefined;
    }
    const parsed = plaidErrorResponseSchema.safeParse(json);
    const code = parsed.success ? parsed.data.error_code : undefined;
    return code !== undefined && PLAID_ERROR_CODE_RE.test(code) ? code : undefined;
  }
}

/** `Retry-After` (seconds) when present, else the default backoff. */
function retryAfterMs(res: Response): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return PLAID_RATE_LIMIT_RETRY_MS;
}

/** First few zod issues as `path: message` — never includes received values. */
function formatZodIssues(err: ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

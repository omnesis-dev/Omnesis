// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SyncError, type SyncErrorKind, type FailureScope, type QuotaBucket } from "@omnesis/types";
import { toErrorMessage } from "@omnesis/core";

/**
 * Subset of GaxiosError fields we look at — the googleapis SDK widens the
 * error shape over major versions, so we duck-type the bits we care about.
 */
interface GaxiosLikeError {
  code?: number | string;
  status?: number;
  message?: string;
  errors?: Array<{ reason?: string; message?: string }>;
  /** gaxios keeps the request it was making on the error it throws. */
  config?: { url?: unknown; method?: unknown };
  response?: {
    status?: number;
    headers?: Record<string, string | string[] | undefined>;
    data?: {
      // googleapis returns three shapes here: a string (`"invalid_grant"`
      // from oauth2.googleapis.com/token), an object with `.errors[]`
      // (REST API errors), and an object with `.message` (e.g. the
      // `error.message` field on Google's standard error envelope).
      error?: string | { errors?: Array<{ reason?: string; message?: string }>; message?: string };
      error_description?: string;
    };
  };
}

function getStatus(e: GaxiosLikeError): number | undefined {
  if (typeof e.code === "number") return e.code;
  if (typeof e.status === "number") return e.status;
  if (typeof e.response?.status === "number") return e.response.status;
  return undefined;
}

function firstReason(e: GaxiosLikeError): string | undefined {
  if (e.errors?.[0]?.reason) return e.errors[0].reason;
  const nested = e.response?.data?.error;
  if (nested && typeof nested === "object") {
    return nested.errors?.[0]?.reason;
  }
  return undefined;
}

/**
 * The request a failure was making, as `METHOD /path`, when gaxios recorded
 * one. The query string is dropped: it carries page tokens and field masks
 * that make the line unreadable and identify nothing useful.
 */
function describeRequest(e: GaxiosLikeError): string | undefined {
  const rawUrl = e.config?.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return undefined;
  const method = typeof e.config?.method === "string" ? e.config.method.toUpperCase() : "GET";
  try {
    return `${method} ${new URL(rawUrl).pathname}`;
  } catch {
    return `${method} ${rawUrl.split("?")[0]}`;
  }
}

function getRetryAfter(e: GaxiosLikeError): number | undefined {
  const raw = e.response?.headers?.["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

// Matched against the error's whole cause chain, not just its top message:
// `fetch()` rejects with a bare `TypeError: fetch failed` and names the
// actual failure only in `cause`. `UND_ERR_` covers undici's own codes
// (socket closed, connect timeout, headers timeout); `terminated` is a
// response body that died mid-read.
const NETWORK_PATTERNS =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|UND_ERR_|fetch failed|other side closed|terminated/i;

// OAuth refresh-token failures come back from Google's token endpoint
// (oauth2.googleapis.com/token) as HTTP 400 — without a body check
// they'd land in `unknown` and the collector would render a generic
// red error pill instead of the `needs-auth` remediation state.
//
// Patterns are intentionally tight: only the exact strings the token
// endpoint (RFC 6749) and Google's documented messages emit. Wildcards
// would over-match upstream 5xx whose body happens to mention "refresh
// token" — and since this check runs before the 5xx → transient branch
// below, a wildcard hit would silently turn a transient into needs-auth.
// Match the body (`response.data.error` / `error_description` / the
// nested `error.message`) AND the top-level message so we catch both
// the raw token-endpoint response and the SDK's pre-extracted `.message`.
const OAUTH_REFRESH_FAILURE_PATTERNS =
  /\binvalid_grant\b|\binvalid_client\b|token has been expired or revoked/i;

function getOAuthErrorBody(e: GaxiosLikeError): string {
  const data = e.response?.data;
  if (!data) return "";
  const parts: string[] = [];
  if (typeof data.error === "string") {
    parts.push(data.error);
  } else if (data.error && typeof data.error === "object") {
    if (typeof data.error.message === "string") parts.push(data.error.message);
    if (Array.isArray(data.error.errors)) {
      for (const sub of data.error.errors) {
        if (typeof sub?.reason === "string") parts.push(sub.reason);
        if (typeof sub?.message === "string") parts.push(sub.message);
      }
    }
  }
  if (typeof data.error_description === "string") parts.push(data.error_description);
  return parts.join(" ");
}

/**
 * Normalise a `googleapis` SDK error into a typed `SyncError` so the
 * collector's classifier can route the source to the right state and pick
 * up any Retry-After hint without parsing free-form messages. Pass-through
 * for already-typed `SyncError` instances.
 *
 * Mapping rules:
 * - 401, `invalidCredentials`, `unauthorized`, `unauthenticated` → `auth`
 * - OAuth refresh-token failures (`invalid_grant`, `Token has been expired
 *   or revoked`, etc.) → `auth` — these come back as HTTP 400 from the
 *   token endpoint, not 401
 * - 429, `rateLimitExceeded`, `userRateLimitExceeded` → `rate-limit`
 * - 403 → `permission` (or `rate-limit` when the reason explicitly says so)
 * - 5xx → `transient`
 * - ECONN..., ETIMEDOUT, ENOTFOUND, EAI_AGAIN, ENETUNREACH → `network`
 * - everything else → `unknown`
 *
 * `auth` always carries `scope: "connection"`: every Google source (Gmail,
 * Calendar, Drive, Contacts) is built from the one `OAuth2Client` the
 * provider's `createContext` mints for the account, so a rejected token
 * fails all of them identically, not just the source that happened to make
 * the next request.
 *
 * `rate-limit` carries `quota: { kind: "account" }` only for the
 * `userRateLimitExceeded` reason — Google's API error reference documents
 * that reason as the per-user limit specifically. The bare `rateLimitExceeded`
 * reason (and a 429/403 with no reason at all) is documented ambiguously as
 * "per project, per client, or an interaction of both", so it is left
 * unclassified rather than guessed.
 */
export function mapGoogleApiError(err: unknown): SyncError {
  if (err instanceof SyncError) return err;

  const e = (err ?? {}) as GaxiosLikeError;
  const status = getStatus(e);
  const reason = firstReason(e);
  const message = e.message ?? String(err);
  const oauthBody = getOAuthErrorBody(e);
  // The full `message: cause: cause` chain. Only the network test reads it:
  // widening the auth and OAuth tests the same way would let a nested
  // message mentioning a token flip an unrelated upstream failure to
  // `needs-auth`, which is the one misclassification an operator cannot
  // undo by waiting.
  const chain = toErrorMessage(err);

  let kind: SyncErrorKind = "unknown";
  let retryAfterMs = getRetryAfter(e);

  if (
    status === 401 ||
    reason === "invalidCredentials" ||
    reason === "unauthorized" ||
    reason === "unauthenticated" ||
    OAUTH_REFRESH_FAILURE_PATTERNS.test(message) ||
    OAUTH_REFRESH_FAILURE_PATTERNS.test(oauthBody)
  ) {
    kind = "auth";
  } else if (
    status === 429 ||
    reason === "rateLimitExceeded" ||
    reason === "userRateLimitExceeded"
  ) {
    kind = "rate-limit";
  } else if (status === 403) {
    // Google sometimes returns 403 for quota issues with reason
    // `rateLimitExceeded` / `userRateLimitExceeded`; otherwise it's a true
    // permission denial (`forbidden`, `domainPolicy`, …).
    kind =
      reason === "rateLimitExceeded" || reason === "userRateLimitExceeded"
        ? "rate-limit"
        : "permission";
  } else if (typeof status === "number" && status >= 500 && status <= 599) {
    kind = "transient";
  } else if (NETWORK_PATTERNS.test(chain)) {
    kind = "network";
  }

  // Retry-After is only meaningful on rate-limit / transient classes.
  if (kind !== "rate-limit" && kind !== "transient") retryAfterMs = undefined;

  const scope: FailureScope | undefined = kind === "auth" ? "connection" : undefined;
  const quota: QuotaBucket | undefined =
    kind === "rate-limit" && reason === "userRateLimitExceeded" ? { kind: "account" } : undefined;

  // A transport failure's own message is a category ("fetch failed") and its
  // stack holds only undici internals, so an unnamed one reaches the operator
  // as a red source with nothing to say which host stopped answering. Name the
  // API, the way every other provider client in this repo names itself.
  const request = describeRequest(e);
  const text =
    kind === "network"
      ? `Google API request failed${request ? ` (${request})` : ""}: ${chain}`
      : message;

  return new SyncError(kind, text, { retryAfterMs, scope, quota, cause: err });
}

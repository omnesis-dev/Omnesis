// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { toErrorMessage } from "@omnesis/core";
import { SyncError, type SyncErrorKind } from "@omnesis/types";

export type { SyncErrorKind };

// ── Auth-failure patterns ──────────────────────────────────────────
const AUTH_PATTERNS: readonly string[] = [
  "invalid_grant",
  "invalid grant",
  "invalid_client",
  "invalid client",
  // Google's `googleapis` SDK throws bare `Invalid Credentials` on every
  // call (Calendar / Contacts / Drive / Gmail) when the user revokes
  // access at myaccount.google.com/permissions — without this pattern,
  // a Google revoke lands the source in generic `error` instead of
  // `needs-auth`. Caught live during Tier 5 of sources-qa Phase 4
  // validation.
  "invalid credentials",
  "unauthorized",
  "unauthenticated",
  "token has been expired or revoked",
  "refresh token",
  " 401 ",
  "(401)",
  "status: 401",
  "status code 401",
];

const AUTH_SUFFIXES: readonly string[] = [" 401"];

// ── Rate-limit patterns ────────────────────────────────────────────
//
// Sources that throw a typed `SyncError` (Google via `mapGoogleApiError`,
// Notion via `mapNotionApiError`, Strava for the statuses its client names)
// carry their classification directly. The substring patterns below fire for
// throw paths that surface the SDK's raw error message — Microsoft Graph
// throughout, and Strava's catch-all for any status its client doesn't name.
const RATE_LIMIT_PATTERNS: readonly string[] = [
  "rate limit",
  "rate-limit",
  "ratelimit",
  "rate_limit",
  "too many requests",
  " 429 ",
  "(429)",
  "status: 429",
  "status code 429",
];

// ── Permission patterns ────────────────────────────────────────────
const PERMISSION_PATTERNS: readonly string[] = [
  "forbidden",
  " 403 ",
  "(403)",
  "status: 403",
  "status code 403",
  "permission denied",
  "insufficientpermissions",
  "insufficient permissions",
];

// ── Network patterns (fetch/undici/Node net errors) ────────────────
const NETWORK_PATTERNS: readonly string[] = [
  "econnreset",
  "econnrefused",
  "etimedout",
  "enotfound",
  "eai_again",
  "enetunreach",
  "fetch failed",
  "network error",
  "socket hang up",
  "request timed out",
  "request timeout",
];

// ── Transient (5xx, server-side) patterns ─────────────────────────
const TRANSIENT_PATTERNS: readonly string[] = [
  " 500 ",
  " 502 ",
  " 503 ",
  " 504 ",
  "(500)",
  "(502)",
  "(503)",
  "(504)",
  "status: 500",
  "status: 502",
  "status: 503",
  "status: 504",
  "internal server error",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  // Low-disk write guard (#15): the gateway ingest endpoint returns 507 with
  // an "insufficient disk space" message. Treat it as transient alongside the
  // other 5xx codes so the source resumes (no needs-auth mis-flip).
  " 507 ",
  "(507)",
  "status: 507",
  "insufficient disk space",
];

function matches(msg: string, needles: readonly string[]): boolean {
  for (const n of needles) {
    if (msg.includes(n)) return true;
  }
  return false;
}

/**
 * Classify an error thrown during sync.
 *
 * A typed `SyncError` (thrown by sources via provider-specific helpers like
 * `mapGoogleApiError`) carries its classification directly and short-circuits
 * — except for kind `unknown`, which is the mapper saying it recognised
 * nothing. That carries no more information than an untyped error, so it is no
 * more authoritative: an unknown-kind `SyncError` is classified from its
 * message like any other error, and every mapper's blind spot is covered by
 * the same substring list rather than by widening each mapper.
 *
 * Message classification runs in the order `auth → rate-limit → permission
 * → network → transient → unknown` so that an OAuth 401 is never misread as
 * a permission denial, and a 503 from a flaky upstream is distinguishable
 * from a 5xx that happens to mention "permission denied" in the body.
 */
export function classifySyncError(err: unknown): SyncErrorKind {
  if (err instanceof SyncError && err.kind !== "unknown") return err.kind;

  const msg = toErrorMessage(err).toLowerCase();

  for (const needle of AUTH_PATTERNS) {
    if (msg.includes(needle)) return "auth";
  }
  for (const suffix of AUTH_SUFFIXES) {
    if (msg.endsWith(suffix)) return "auth";
  }

  if (matches(msg, RATE_LIMIT_PATTERNS)) return "rate-limit";
  if (matches(msg, PERMISSION_PATTERNS)) return "permission";
  if (matches(msg, NETWORK_PATTERNS)) return "network";
  if (matches(msg, TRANSIENT_PATTERNS)) return "transient";

  return "unknown";
}

/**
 * Heuristic: does this error look like an OAuth/credential failure that
 * the user can fix by re-running `cli -- sources reauth`? We err on the side of
 * marking too many things as auth failures (the CLI hint just says
 * "try re-auth", which is harmless even when the actual cause was
 * something else).
 */
export function looksLikeAuthFailure(err: unknown): boolean {
  return classifySyncError(err) === "auth";
}

/**
 * Extract a rate-limit retry hint from a sync error, if and only if the
 * source threw a typed {@link SyncError} of kind `rate-limit` carrying a
 * positive `retryAfterMs`. Returns `null` for every other error — including
 * untyped errors whose message merely *looks* like a rate limit (a plain
 * `Error("rate limited (429)")`) and typed rate-limit errors with no
 * `retryAfterMs`. Those keep flowing through the generic `error` path, so
 * the deferral is strictly additive: we only special-case a source when the
 * provider explicitly told us when it is worth retrying.
 */
export function extractRateLimitDeferral(err: unknown): { retryAfterMs: number } | null {
  if (!(err instanceof SyncError)) return null;
  if (err.kind !== "rate-limit") return null;
  if (typeof err.retryAfterMs !== "number" || err.retryAfterMs <= 0) return null;
  return { retryAfterMs: err.retryAfterMs };
}

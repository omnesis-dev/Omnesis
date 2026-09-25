// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { APIErrorCode, RequestTimeoutError, isHTTPResponseError } from "@notionhq/client";
import { SyncError, type FailureScope, type QuotaBucket, type SyncErrorKind } from "@omnesis/types";
import { toErrorMessage } from "@omnesis/core";

import { readRetryAfterMs } from "./client.js";

/**
 * Normalise a Notion SDK error into a typed {@link SyncError} so the collector
 * routes the source to the right state instead of guessing from the message.
 *
 * Guessing does not work here: the SDK carries its classification in `code`
 * (`unauthorized`, `rate_limited`, …) while `message` holds Notion's prose —
 * a revoked integration reads "API token is invalid.", which names neither the
 * status nor the condition. Left untyped it lands in `unknown`, so the one
 * failure the operator can actually fix renders as a generic red error with no
 * re-auth prompt.
 *
 * Mapping rules:
 * - `unauthorized`, HTTP 401 → `auth`, scope `connection` (the integration's
 *   OAuth grant for the whole workspace was revoked, or its token was rotated
 *   out from under us — `notion-pages` and `notion-databases` share the one
 *   access token minted per workspace in `provider.ts`'s OAuth exchange, so
 *   both sources are dead, not just whichever one made this request)
 * - `restricted_resource` → `permission`
 * - `rate_limited`, HTTP 429 → `rate-limit`, carrying `Retry-After` when Notion
 *   sends one, and `quota: { kind: "account" }` (Notion enforces its ~3 req/s
 *   ceiling per access token — i.e. per authorized workspace — not per
 *   registered OAuth client, so a throttled workspace never implies another
 *   workspace on the same client_id is also throttled)
 * - HTTP 5xx → `transient`
 * - a request timeout or a `fetch` transport failure → `network`
 * - everything else → `unknown`
 */
export function mapNotionApiError(err: unknown): SyncError {
  if (err instanceof SyncError) return err;

  // Both HTTP error classes, not just `APIResponseError`: the SDK falls back to
  // `UnknownHTTPResponseError` whenever a response body isn't Notion's JSON
  // envelope or carries a code its enum doesn't know — which is what a
  // Cloudflare-fronted 401 or 429 arrives as. Those carry `status` and
  // `headers` all the same, and classifying them by status is the whole point.
  if (isHTTPResponseError(err)) {
    let kind: SyncErrorKind = "unknown";
    let retryAfterMs: number | undefined;
    let scope: FailureScope | undefined;
    let quota: QuotaBucket | undefined;

    if (err.code === APIErrorCode.Unauthorized || err.status === 401) {
      kind = "auth";
      scope = "connection";
    } else if (err.code === APIErrorCode.RestrictedResource || err.status === 403) {
      kind = "permission";
    } else if (err.code === APIErrorCode.RateLimited || err.status === 429) {
      kind = "rate-limit";
      retryAfterMs = readRetryAfterMs(err.headers);
      quota = { kind: "account" };
    } else if (err.status >= 500 && err.status <= 599) {
      kind = "transient";
    }

    return new SyncError(kind, `Notion API ${err.status} (${err.code}): ${err.message}`, {
      retryAfterMs,
      scope,
      quota,
      cause: err,
    });
  }

  if (RequestTimeoutError.isRequestTimeoutError(err)) {
    return new SyncError("network", `Notion request timed out: ${toErrorMessage(err)}`, {
      cause: err,
    });
  }

  // `fetch`/undici surface transport failures as a bare TypeError, an aborted
  // signal as AbortError, and a `node-fetch`-style client as FetchError — none
  // of which the SDK wraps. Kept in step with `isTransientNotionError`, which
  // decides whether the same failures are worth retrying.
  if (
    err instanceof Error &&
    (err.name === "TypeError" || err.name === "AbortError" || err.name === "FetchError")
  ) {
    return new SyncError("network", `Notion request failed: ${toErrorMessage(err)}`, {
      cause: err,
    });
  }

  return new SyncError("unknown", err instanceof Error ? err.message : String(err), { cause: err });
}

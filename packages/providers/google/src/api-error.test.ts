// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { SyncError } from "@omnesis/types";
import { mapGoogleApiError } from "./api-error.js";

describe("mapGoogleApiError", () => {
  test("passes SyncError through unchanged", () => {
    const orig = new SyncError("rate-limit", "already typed");
    expect(mapGoogleApiError(orig)).toBe(orig);
  });

  test("401 → auth", () => {
    const e = mapGoogleApiError({ code: 401, message: "Unauthorized" });
    expect(e.kind).toBe("auth");
    expect(e.message).toBe("Unauthorized");
  });

  test("auth failures scope to the whole connection, not just this source", () => {
    // Gmail, Calendar, Drive and Contacts all run on the one OAuth2Client
    // the provider mints per account, so a dead token takes every one of
    // them down at once.
    const e = mapGoogleApiError({ code: 401, message: "Unauthorized" });
    expect(e.scope).toBe("connection");
  });

  test("invalidCredentials reason → auth", () => {
    const e = mapGoogleApiError({
      code: 400,
      message: "Bad Request",
      errors: [{ reason: "invalidCredentials" }],
    });
    expect(e.kind).toBe("auth");
  });

  test("invalid_grant in message → auth (refresh-token expiry)", () => {
    // Shape of error googleapis throws when refresh fails against
    // oauth2.googleapis.com/token. Status is 400, not 401.
    const e = mapGoogleApiError({
      code: 400,
      status: 400,
      message: "invalid_grant",
      response: {
        status: 400,
        data: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
      },
    });
    expect(e.kind).toBe("auth");
  });

  test("Token has been expired or revoked in error_description → auth", () => {
    const e = mapGoogleApiError({
      code: 400,
      message: "Bad Request",
      response: {
        status: 400,
        data: { error_description: "Token has been expired or revoked." },
      },
    });
    expect(e.kind).toBe("auth");
  });

  test("invalid_client in response body → auth", () => {
    const e = mapGoogleApiError({
      code: 401,
      message: "Unauthorized",
      response: {
        status: 401,
        data: { error: "invalid_client", error_description: "Unauthorized client" },
      },
    });
    expect(e.kind).toBe("auth");
  });

  test("plain Error wrapping invalid_grant message → auth", () => {
    const e = mapGoogleApiError(new Error("invalid_grant: Bad Request"));
    expect(e.kind).toBe("auth");
  });

  test("Invalid Credentials surfaced via nested data.error.message → auth", () => {
    // Google's REST envelope: { error: { code, message, errors: [...] } }.
    // `firstReason` already covers reason matches; this covers the case
    // where the SDK only populates `error.message` text.
    const e = mapGoogleApiError({
      code: 401,
      message: "Request failed",
      response: {
        status: 401,
        data: { error: { message: "Invalid Credentials" } },
      },
    });
    expect(e.kind).toBe("auth");
  });

  test("5xx whose body mentions 'refresh token' → transient, NOT auth", () => {
    // Regression guard: an earlier version of the regex used `.*` wildcards
    // and matched legitimate 5xx whose body happens to mention refresh
    // tokens. Since OAuth-pattern matching runs before the 5xx → transient
    // branch, a misclassified message would silently turn a transient into
    // a needs-auth state.
    const e = mapGoogleApiError({
      code: 503,
      message: "Internal server error: refresh token service unavailable",
    });
    expect(e.kind).toBe("transient");
  });

  test("403 message mentioning 'refresh access token' → permission, NOT auth", () => {
    // A rate-limit or throttling hint that names refresh-token-related
    // concepts shouldn't trip the OAuth-failure detector.
    const e = mapGoogleApiError({
      code: 403,
      message: "Forbidden: please refresh your access token after the cool-down",
    });
    expect(e.kind).toBe("permission");
  });

  test("empty object error → unknown (no spurious match on String(err))", () => {
    expect(mapGoogleApiError({}).kind).toBe("unknown");
    expect(mapGoogleApiError(null).kind).toBe("unknown");
  });

  test("OAuth body via nested errors[].reason → auth", () => {
    const e = mapGoogleApiError({
      code: 401,
      message: "",
      response: {
        status: 401,
        data: { error: { errors: [{ reason: "invalid_grant" }] } },
      },
    });
    expect(e.kind).toBe("auth");
  });

  test("429 → rate-limit and Retry-After seconds → ms", () => {
    const e = mapGoogleApiError({
      code: 429,
      message: "Too many requests",
      response: { headers: { "retry-after": "30" } },
    });
    expect(e.kind).toBe("rate-limit");
    expect(e.retryAfterMs).toBe(30_000);
  });

  test("429 with no reason → rate-limit, no quota bucket (can't tell app vs account)", () => {
    const e = mapGoogleApiError({ code: 429, message: "Too many requests" });
    expect(e.kind).toBe("rate-limit");
    expect(e.quota).toBeUndefined();
  });

  test("bare rateLimitExceeded reason → rate-limit, no quota bucket", () => {
    // Google's own error reference documents this reason ambiguously —
    // "per project, per client, or an interaction of both" — so it isn't
    // safe to guess which budget it counted against.
    const e = mapGoogleApiError({
      code: 429,
      errors: [{ reason: "rateLimitExceeded" }],
      message: "quota",
    });
    expect(e.kind).toBe("rate-limit");
    expect(e.quota).toBeUndefined();
  });

  test("userRateLimitExceeded reason → rate-limit with an account-scoped quota bucket", () => {
    // Google documents this reason as the per-user limit specifically.
    const e = mapGoogleApiError({
      code: 429,
      errors: [{ reason: "userRateLimitExceeded" }],
      message: "quota",
    });
    expect(e.kind).toBe("rate-limit");
    expect(e.quota).toEqual({ kind: "account" });
  });

  test("403 with rateLimitExceeded reason → rate-limit", () => {
    const e = mapGoogleApiError({
      code: 403,
      errors: [{ reason: "userRateLimitExceeded" }],
      message: "quota",
    });
    expect(e.kind).toBe("rate-limit");
    expect(e.quota).toEqual({ kind: "account" });
  });

  test("403 plain → permission, default source scope, no quota bucket", () => {
    const e = mapGoogleApiError({ code: 403, message: "Forbidden" });
    expect(e.kind).toBe("permission");
    expect(e.retryAfterMs).toBeUndefined();
    expect(e.scope).toBe("source");
    expect(e.quota).toBeUndefined();
  });

  test("503 → transient", () => {
    const e = mapGoogleApiError({ code: 503, message: "Service Unavailable" });
    expect(e.kind).toBe("transient");
  });

  test("ECONNRESET in message → network", () => {
    const e = mapGoogleApiError(new Error("read ECONNRESET"));
    expect(e.kind).toBe("network");
  });

  test("unrecognised error → unknown", () => {
    const e = mapGoogleApiError(new Error("something else"));
    expect(e.kind).toBe("unknown");
  });

  test("response.data.error.errors path is read for reason", () => {
    const e = mapGoogleApiError({
      code: 429,
      response: {
        data: { error: { errors: [{ reason: "rateLimitExceeded" }] } },
      },
    });
    expect(e.kind).toBe("rate-limit");
  });

  test("Retry-After HTTP-date is converted to ms-from-now", () => {
    const future = new Date(Date.now() + 5_000).toUTCString();
    const e = mapGoogleApiError({
      code: 503,
      message: "transient",
      response: { headers: { "retry-after": future } },
    });
    expect(e.kind).toBe("transient");
    // Allow some clock-skew tolerance.
    expect(e.retryAfterMs).toBeGreaterThan(2_000);
    expect(e.retryAfterMs).toBeLessThanOrEqual(5_500);
  });

  test("cause chain is preserved", () => {
    const cause = new Error("inner");
    const e = mapGoogleApiError(cause);
    expect(e.cause).toBe(cause);
  });
});

describe("mapGoogleApiError — transport failures", () => {
  /** The rejection a fetch produces when the server closes a pooled socket. */
  function socketClosed(): TypeError {
    return new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
  }

  test("classifies a closed socket as network, reading the cause chain", () => {
    // `fetch failed` alone says nothing; the reason is one link down.
    const mapped = mapGoogleApiError(socketClosed());
    expect(mapped.kind).toBe("network");
  });

  test("names the API a transport failure was talking to", () => {
    const mapped = mapGoogleApiError(socketClosed());
    expect(mapped.message).toBe("Google API request failed: fetch failed: other side closed");
  });

  test("names the exact request when gaxios recorded one, without its query", () => {
    // Which call died is the difference between "Gmail is broken" and "the
    // attachment fetch for one message is". The query carries page tokens
    // and field masks that identify nothing and swamp the line.
    const err = Object.assign(socketClosed(), {
      config: {
        method: "get",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123/attachments/xyz?alt=json&prettyPrint=false",
      },
    });
    expect(mapGoogleApiError(err).message).toBe(
      "Google API request failed (GET /gmail/v1/users/me/messages/abc123/attachments/xyz): " +
        "fetch failed: other side closed",
    );
  });

  test("omits the request when gaxios recorded none", () => {
    expect(mapGoogleApiError(socketClosed()).message).not.toContain("(");
  });

  test("classifies by the cause when the top message names nothing", () => {
    // The SDK is free to wrap the transport failure in its own wording. Only
    // reading the chain reaches the reason; matching the top message alone
    // leaves this `unknown`, which is how a retryable blip became a red source.
    const wrapped = new Error("Gmail users.messages.list did not complete", {
      cause: socketClosed(),
    });
    expect(mapGoogleApiError(wrapped).kind).toBe("network");
  });

  test("classifies a connect timeout, whose message is empty and code is all there is", () => {
    const cause = Object.assign(new Error(""), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(mapGoogleApiError(new TypeError("fetch failed", { cause })).kind).toBe("network");
  });

  test("leaves a non-transport failure's message untouched", () => {
    const mapped = mapGoogleApiError(new Error("something else entirely"));
    expect(mapped.kind).toBe("unknown");
    expect(mapped.message).toBe("something else entirely");
  });

  test("does not let a cause mentioning a token flip an upstream failure to auth", () => {
    // Only the network test reads the chain. A 503 whose body happens to
    // mention a refresh token must stay transient, not become needs-auth.
    const err = {
      code: 503,
      message: "Service Unavailable",
      response: { status: 503 },
      cause: new Error("refresh token pool exhausted"),
    };
    expect(mapGoogleApiError(err).kind).toBe("transient");
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { SyncError } from "@omnesis/types";
import { classifySyncError, looksLikeAuthFailure } from "./error-classifier.js";

describe("classifySyncError", () => {
  test("typed SyncError short-circuits to its kind", () => {
    expect(classifySyncError(new SyncError("rate-limit", "429"))).toBe("rate-limit");
    expect(classifySyncError(new SyncError("permission", "403"))).toBe("permission");
    expect(classifySyncError(new SyncError("network", "ECONNRESET"))).toBe("network");
    expect(classifySyncError(new SyncError("transient", "503"))).toBe("transient");
    expect(classifySyncError(new SyncError("auth", "401"))).toBe("auth");
    expect(classifySyncError(new SyncError("unknown", "?"))).toBe("unknown");
  });

  test("a typed error of kind `unknown` is classified from its message", () => {
    // A typed `unknown` carries no more information than an untyped error, so
    // it is no more authoritative: `google-auth-library` throws a plain
    // `Error("No refresh token is set.")` when an eager refresh finds no
    // refresh token, and `mapGoogleApiError` stamps `unknown` on it (no HTTP
    // status, no reason, no OAuth body). The message still says what happened.
    expect(classifySyncError(new SyncError("unknown", "No refresh token is set."))).toBe("auth");
    expect(looksLikeAuthFailure(new SyncError("unknown", "No refresh token is set."))).toBe(true);
    expect(classifySyncError(new SyncError("unknown", "status: 429 from upstream"))).toBe(
      "rate-limit",
    );
  });

  test("a typed error of kind `unknown` whose message is transient is not auth", () => {
    // The fall-through must not park a healthy source in needs-auth: a network
    // blip and a 5xx keep their own class.
    for (const message of [
      "read ECONNRESET",
      "connect ETIMEDOUT 203.0.113.10:443",
      "fetch failed",
      "status: 503 Service Unavailable",
    ]) {
      expect(looksLikeAuthFailure(new SyncError("unknown", message))).toBe(false);
    }
    expect(classifySyncError(new SyncError("unknown", "read ECONNRESET"))).toBe("network");
    expect(classifySyncError(new SyncError("unknown", "status: 503 Service Unavailable"))).toBe(
      "transient",
    );
  });

  test("a typed error of a known kind outranks its own message", () => {
    // Only `unknown` falls through — a provider that classified the error
    // stays authoritative even when the message reads like another class.
    expect(classifySyncError(new SyncError("transient", "upstream could not refresh token"))).toBe(
      "transient",
    );
    expect(classifySyncError(new SyncError("network", "invalid_grant"))).toBe("network");
  });

  test("auth substrings classify as auth", () => {
    expect(classifySyncError(new Error("invalid_grant"))).toBe("auth");
    expect(classifySyncError(new Error("Invalid Credentials"))).toBe("auth");
    expect(classifySyncError(new Error("status code 401"))).toBe("auth");
    expect(classifySyncError(new Error("Token has been expired or revoked"))).toBe("auth");
  });

  test("429 substrings classify as rate-limit", () => {
    expect(classifySyncError(new Error("Too many requests"))).toBe("rate-limit");
    expect(classifySyncError(new Error("status: 429"))).toBe("rate-limit");
    expect(classifySyncError(new Error("rate limit exceeded"))).toBe("rate-limit");
  });

  test("403 substrings classify as permission (not auth)", () => {
    expect(classifySyncError(new Error("Forbidden: missing scope"))).toBe("permission");
    expect(classifySyncError(new Error("status: 403"))).toBe("permission");
    expect(classifySyncError(new Error("permission denied"))).toBe("permission");
  });

  test("network errors classify as network", () => {
    expect(classifySyncError(new Error("read ECONNRESET"))).toBe("network");
    expect(classifySyncError(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe("network");
    expect(classifySyncError(new Error("fetch failed"))).toBe("network");
  });

  test("5xx server errors classify as transient", () => {
    expect(classifySyncError(new Error("status: 500 Internal Server Error"))).toBe("transient");
    expect(classifySyncError(new Error("status: 502 Bad Gateway"))).toBe("transient");
    expect(classifySyncError(new Error("Service Unavailable"))).toBe("transient");
  });

  test("507 low-disk ingest error classifies as transient, not auth", () => {
    // The gateway returns 507 with an "Insufficient disk space" body when the
    // disk guard trips; the source must resume on a later tick, not flip to
    // needs-auth/permission.
    expect(
      classifySyncError(
        new Error(
          "Gateway error 507: Insufficient disk space: 100MB free is below the 500MB minimum",
        ),
      ),
    ).toBe("transient");
    expect(classifySyncError(new Error("status: 507"))).toBe("transient");
    expect(looksLikeAuthFailure(new Error("Insufficient disk space"))).toBe(false);
  });

  test("auth wins over the other classes when both substrings appear", () => {
    expect(classifySyncError(new Error("Forbidden — invalid credentials"))).toBe("auth");
    expect(classifySyncError(new Error("Too many requests, unauthorized"))).toBe("auth");
  });

  test("unrecognised messages collapse to unknown", () => {
    expect(classifySyncError(new Error("something weird happened"))).toBe("unknown");
    expect(classifySyncError("plain string error")).toBe("unknown");
    expect(classifySyncError(undefined)).toBe("unknown");
  });

  test("looksLikeAuthFailure mirrors classifySyncError === 'auth'", () => {
    expect(looksLikeAuthFailure(new Error("invalid_grant"))).toBe(true);
    expect(looksLikeAuthFailure(new SyncError("auth", "401"))).toBe(true);
    expect(looksLikeAuthFailure(new SyncError("rate-limit", "429"))).toBe(false);
    expect(looksLikeAuthFailure(new Error("ECONNRESET"))).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  APIErrorCode,
  APIResponseError,
  RequestTimeoutError,
  UnknownHTTPResponseError,
} from "@notionhq/client";
import { SyncError } from "@omnesis/types";
import { describe, expect, test } from "vitest";
import { mapNotionApiError } from "./api-error.js";

function apiError(
  code: APIErrorCode,
  status: number,
  message: string,
  headers = new Headers(),
): APIResponseError {
  return new APIResponseError({
    code,
    status,
    message,
    headers,
    rawBodyText: "",
    additional_data: undefined,
    request_id: undefined,
  });
}

describe("mapNotionApiError", () => {
  // Notion's 401 body reads "API token is invalid." — it names neither the
  // status nor the condition, so nothing downstream can recover the
  // classification from the message alone.
  test("a revoked integration is auth, scoped to the whole connection", () => {
    const err = mapNotionApiError(
      apiError(APIErrorCode.Unauthorized, 401, "API token is invalid."),
    );
    expect(err.kind).toBe("auth");
    // notion-pages and notion-databases share the one access token minted
    // per workspace, so a revoked grant takes both sources down at once.
    expect(err.scope).toBe("connection");
  });

  test("a restricted resource is permission, not auth", () => {
    const err = mapNotionApiError(
      apiError(APIErrorCode.RestrictedResource, 403, "Insufficient permissions for this endpoint."),
    );
    expect(err.kind).toBe("permission");
  });

  test("a throttled workspace is rate-limit, carries Retry-After, and is an account-scoped quota", () => {
    const err = mapNotionApiError(
      apiError(APIErrorCode.RateLimited, 429, "Rate limited", new Headers({ "retry-after": "30" })),
    );
    expect(err.kind).toBe("rate-limit");
    expect(err.retryAfterMs).toBe(30_000);
    // Notion's ~3 req/s ceiling is enforced per access token (per authorized
    // workspace), not per registered OAuth client, so it never implies a
    // sibling workspace on the same client_id is also throttled.
    expect(err.quota).toEqual({ kind: "account" });
  });

  test("a Notion outage is transient", () => {
    const err = mapNotionApiError(
      apiError(APIErrorCode.InternalServerError, 503, "Service unavailable"),
    );
    expect(err.kind).toBe("transient");
  });

  // A response the SDK cannot parse as Notion's JSON envelope — an edge
  // proxy's HTML error page, say — arrives as `UnknownHTTPResponseError`
  // rather than `APIResponseError`. It still carries the status, and a 401 is
  // still a revoked integration.
  test("classifies an unparseable error response by its status", () => {
    const unparseable = (status: number): UnknownHTTPResponseError =>
      new UnknownHTTPResponseError({
        status,
        message: undefined,
        headers: new Headers(),
        rawBodyText: "<html>denied by the edge</html>",
      });

    expect(mapNotionApiError(unparseable(401)).kind).toBe("auth");
    expect(mapNotionApiError(unparseable(403)).kind).toBe("permission");
    expect(mapNotionApiError(unparseable(429)).kind).toBe("rate-limit");
    expect(mapNotionApiError(unparseable(502)).kind).toBe("transient");
  });

  test("a transport failure is network, not auth", () => {
    expect(mapNotionApiError(new TypeError("fetch failed")).kind).toBe("network");
    expect(mapNotionApiError(new RequestTimeoutError("timed out")).kind).toBe("network");
  });

  test("an already-typed SyncError passes through untouched", () => {
    const original = new SyncError("rate-limit", "already classified", { retryAfterMs: 5_000 });
    expect(mapNotionApiError(original)).toBe(original);
  });

  test("anything else stays unknown rather than guessing", () => {
    expect(mapNotionApiError(new Error("something went sideways")).kind).toBe("unknown");
  });
});

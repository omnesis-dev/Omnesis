// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { APIResponseError, APIErrorCode, RequestTimeoutError } from "@notionhq/client";
import {
  NotionClient,
  withRetry,
  isInaccessibleNotionError,
  isTransientNotionError,
  readRetryAfterMs,
} from "./client.js";

function makeAPIError(args: {
  code: APIErrorCode;
  status: number;
  headers?: Record<string, string> | Headers;
  message?: string;
}) {
  return new APIResponseError({
    code: args.code,
    status: args.status,
    message: args.message ?? "test error",
    headers: args.headers ?? new Headers(),
    rawBodyText: "{}",
    additional_data: undefined,
    request_id: undefined,
  });
}

const noSleep = async () => {};

describe("readRetryAfterMs", () => {
  test("reads from Headers instance", () => {
    const h = new Headers({ "Retry-After": "5" });
    expect(readRetryAfterMs(h)).toBe(5000);
  });

  test("reads from plain object (lowercase)", () => {
    expect(readRetryAfterMs({ "retry-after": "3" })).toBe(3000);
  });

  test("reads from plain object (Pascal-case)", () => {
    expect(readRetryAfterMs({ "Retry-After": "7" })).toBe(7000);
  });

  test("returns undefined for missing/invalid header", () => {
    expect(readRetryAfterMs(undefined)).toBeUndefined();
    expect(readRetryAfterMs(null)).toBeUndefined();
    expect(readRetryAfterMs({})).toBeUndefined();
    expect(readRetryAfterMs({ "retry-after": "" })).toBeUndefined();
    expect(readRetryAfterMs({ "retry-after": "not-a-number" })).toBeUndefined();
    expect(readRetryAfterMs({ "retry-after": "0" })).toBeUndefined();
  });
});

describe("isTransientNotionError", () => {
  test("RateLimited is transient", () => {
    expect(
      isTransientNotionError(makeAPIError({ code: APIErrorCode.RateLimited, status: 429 })),
    ).toBe(true);
  });

  test("5xx APIResponseError is transient", () => {
    // The SDK reports 5xx as ServiceUnavailable in some versions; just give
    // it a 503 with an arbitrary code field.
    expect(
      isTransientNotionError(
        makeAPIError({
          code: APIErrorCode.ServiceUnavailable,
          status: 503,
        }),
      ),
    ).toBe(true);
  });

  test("404 / 403 are NOT transient", () => {
    expect(
      isTransientNotionError(makeAPIError({ code: APIErrorCode.ObjectNotFound, status: 404 })),
    ).toBe(false);
    expect(
      isTransientNotionError(makeAPIError({ code: APIErrorCode.RestrictedResource, status: 403 })),
    ).toBe(false);
  });

  test("RequestTimeoutError is transient", () => {
    const err = new RequestTimeoutError("timed out");
    expect(isTransientNotionError(err)).toBe(true);
  });

  test("plain network TypeError is transient", () => {
    const err = new TypeError("fetch failed");
    expect(isTransientNotionError(err)).toBe(true);
  });

  test("AbortError is transient", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isTransientNotionError(err)).toBe(true);
  });

  test("arbitrary error is NOT transient", () => {
    expect(isTransientNotionError(new Error("kaboom"))).toBe(false);
  });
});

describe("withRetry", () => {
  test("returns immediately on success", async () => {
    let calls = 0;
    const result = await withRetry(
      "test",
      async () => {
        calls++;
        return "ok";
      },
      { sleepFn: noSleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("non-transient error throws on first attempt without retry", async () => {
    let calls = 0;
    await expect(
      withRetry(
        "test",
        async () => {
          calls++;
          throw makeAPIError({
            code: APIErrorCode.ObjectNotFound,
            status: 404,
          });
        },
        { sleepFn: noSleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("transient error retries up to maxAttempts", async () => {
    let calls = 0;
    await expect(
      withRetry(
        "test",
        async () => {
          calls++;
          throw new RequestTimeoutError("timeout");
        },
        { sleepFn: noSleep, maxAttempts: 3, baseBackoffMs: 1 },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(3);
  });

  test("transient error then success — final value returned", async () => {
    let calls = 0;
    const result = await withRetry(
      "test",
      async () => {
        calls++;
        if (calls < 3) throw new RequestTimeoutError("timeout");
        return "eventually-ok";
      },
      { sleepFn: noSleep, maxAttempts: 4, baseBackoffMs: 1 },
    );
    expect(result).toBe("eventually-ok");
    expect(calls).toBe(3);
  });

  test("429 with Retry-After honors the header", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };

    await expect(
      withRetry(
        "test",
        async () => {
          calls++;
          throw makeAPIError({
            code: APIErrorCode.RateLimited,
            status: 429,
            headers: new Headers({ "Retry-After": "12" }),
          });
        },
        { sleepFn, maxAttempts: 3, baseBackoffMs: 1 },
      ),
    ).rejects.toThrow();

    // Two sleeps before the third (final) attempt — both should respect 12s.
    expect(sleeps).toEqual([12_000, 12_000]);
    expect(calls).toBe(3);
  });

  test("429 without Retry-After falls back to exponential backoff", async () => {
    const sleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };

    await expect(
      withRetry(
        "test",
        async () => {
          throw makeAPIError({
            code: APIErrorCode.RateLimited,
            status: 429,
            headers: new Headers(),
          });
        },
        { sleepFn, maxAttempts: 4, baseBackoffMs: 100 },
      ),
    ).rejects.toThrow();

    // 3 sleeps before the 4th (final) attempt: 100, 200, 400.
    expect(sleeps).toEqual([100, 200, 400]);
  });

  test("5xx error retries with exponential backoff", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };

    await expect(
      withRetry(
        "test",
        async () => {
          calls++;
          throw makeAPIError({
            code: APIErrorCode.ServiceUnavailable,
            status: 504,
          });
        },
        { sleepFn, maxAttempts: 3, baseBackoffMs: 50 },
      ),
    ).rejects.toThrow();

    expect(sleeps).toEqual([50, 100]);
    expect(calls).toBe(3);
  });
});

describe("getPageContent with a nested block Notion will not return", () => {
  const paragraph = (id: string, text: string, hasChildren = false) => ({
    object: "block",
    id,
    type: "paragraph",
    has_children: hasChildren,
    paragraph: { rich_text: [{ plain_text: text, annotations: {}, href: null }] },
  });
  const synced = (id: string) => ({
    object: "block",
    id,
    type: "synced_block",
    has_children: true,
    synced_block: { synced_from: { type: "block_id", block_id: "original" } },
  });

  function clientWithBlocks(
    tree: Record<string, unknown[]>,
    failing: Record<string, () => Error>,
  ): NotionClient {
    const client = new NotionClient("secret_example", { sleepFn: noSleep });
    (client as any).client = {
      blocks: {
        children: {
          async list({ block_id }: { block_id: string }) {
            const fail = failing[block_id];
            if (fail) throw fail();
            return { results: tree[block_id] ?? [], has_more: false, next_cursor: null };
          },
        },
      },
    };
    return client;
  }

  test("renders the page without that subtree", async () => {
    const client = clientWithBlocks(
      {
        page: [
          paragraph("p1", "Before the synced block"),
          synced("s1"),
          paragraph("p2", "After it"),
        ],
      },
      { s1: () => makeAPIError({ code: APIErrorCode.ObjectNotFound, status: 404 }) },
    );

    const { markdown } = await client.getPageContent("page");

    expect(markdown).toContain("Before the synced block");
    expect(markdown).toContain("After it");
  });

  test("still fails when the page itself is not found", async () => {
    const client = clientWithBlocks(
      {},
      { page: () => makeAPIError({ code: APIErrorCode.ObjectNotFound, status: 404 }) },
    );

    await expect(client.getPageContent("page")).rejects.toSatisfy(isInaccessibleNotionError);
  });

  test("still fails on a nested block's server error", async () => {
    const client = clientWithBlocks(
      { page: [paragraph("p1", "Text", true)] },
      { p1: () => makeAPIError({ code: APIErrorCode.ValidationError, status: 400 }) },
    );

    await expect(client.getPageContent("page")).rejects.toBeInstanceOf(APIResponseError);
  });
});

describe("isInaccessibleNotionError", () => {
  test("is true for not-found and restricted objects only", () => {
    expect(
      isInaccessibleNotionError(makeAPIError({ code: APIErrorCode.ObjectNotFound, status: 404 })),
    ).toBe(true);
    expect(
      isInaccessibleNotionError(
        makeAPIError({ code: APIErrorCode.RestrictedResource, status: 403 }),
      ),
    ).toBe(true);
    expect(
      isInaccessibleNotionError(makeAPIError({ code: APIErrorCode.Unauthorized, status: 401 })),
    ).toBe(false);
    expect(isInaccessibleNotionError(new TypeError("fetch failed"))).toBe(false);
  });
});

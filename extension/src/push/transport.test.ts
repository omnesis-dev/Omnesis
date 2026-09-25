// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Transport-level suite for `PushTransport` and `parseRetryAfter`: the exact
 * request each method sends, and how every HTTP/network outcome is classified
 * into a `DeliveryOutcome` before the client's queue policy sees it.
 *
 * Deliberately absent here because the client-level suites already assert them
 * through `PushClient.drain()` / `probeAuth()`:
 *   - `client.test.ts`: the queue's reaction to each outcome (retain vs drop,
 *     backoff and Retry-After scheduling, 401/403 retained for re-pairing, the
 *     hung-request and stalled-body timeouts, and the IP-literal / userinfo
 *     gateway URL rejections that come from `normalizeGatewayUrl` itself).
 *   - `client.probe.test.ts`: the probe's URL, method, bearer and empty body as
 *     observed from the client, and what the probe does with each status.
 *   - `delivery-response.test.ts`: the finer 2xx body contract (visit `deleted`
 *     count, unknown rejection reasons, malformed `rejected` arrays).
 *   - `response-body.test.ts`: the response size cap and reason bounding.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_VISITS_SCHEMA, buildPageVisit, buildWebPageDocument } from "./documents.js";
import { MAX_GATEWAY_REASON_CHARS } from "./response-body.js";
import { FakeFetch, jsonResponse } from "./test-fakes.js";
import { PushTransport, parseRetryAfter } from "./transport.js";
import type { DocumentQueueItem, FetchLike, FetchLikeResponse, VisitQueueItem } from "./types.js";

const GATEWAY = "https://gateway.example.com:7600";
const TOKEN = "tok";
const T0 = 1_700_000_000_000;

async function documentItem(): Promise<DocumentQueueItem> {
  return {
    id: "item-doc",
    attempts: 0,
    notBefore: 0,
    enqueuedAt: T0,
    kind: "document",
    doc: await buildWebPageDocument({
      normalizedUrl: "https://example.com/articles/tide-tables",
      title: "Tide tables",
      text: "High tide at dawn.",
      contentHash: "hash-1",
      visitedAt: new Date(T0).toISOString(),
    }),
  };
}

function visitItem(): VisitQueueItem {
  return {
    id: "item-visit",
    attempts: 0,
    notBefore: 0,
    enqueuedAt: T0,
    kind: "visit",
    visit: buildPageVisit({
      normalizedUrl: "https://example.com/articles/tide-tables",
      title: "Tide tables",
      visitedAt: new Date(T0).toISOString(),
      dwellMs: 6000,
    }),
  };
}

function textResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): FetchLikeResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  };
}

function transportFor(fetch: FetchLike, timeoutMs = 1000): PushTransport {
  return new PushTransport(GATEWAY, TOKEN, fetch, timeoutMs);
}

const JSON_BEARER_HEADERS = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("PushTransport — constructor", () => {
  it.each([`${GATEWAY}/`, `${GATEWAY}/portal`, "http://gateway.example.com:7600"])(
    "refuses a gateway URL that is not its canonical HTTPS origin: %s",
    (gatewayUrl) => {
      const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 0 }));
      expect(() => new PushTransport(gatewayUrl, TOKEN, fetch.fetch, 1000)).toThrow();
    },
  );

  it("names the canonical-origin requirement when the URL merely needs normalizing", () => {
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 0 }));
    expect(() => new PushTransport(`${GATEWAY}/`, TOKEN, fetch.fetch, 1000)).toThrow(
      /canonical HTTPS origin/,
    );
  });

  it("accepts the canonical origin", () => {
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 0 }));
    expect(() => new PushTransport(GATEWAY, TOKEN, fetch.fetch, 1000)).not.toThrow();
  });
});

describe("PushTransport — request shapes", () => {
  it("probeEmptyDocuments posts an empty batch to /documents with bearer + json headers", async () => {
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 0 }));
    const response = await transportFor(fetch.fetch).probeEmptyDocuments();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ ingested: 0 }));
    expect(fetch.requests).toEqual([
      {
        url: `${GATEWAY}/documents`,
        method: "POST",
        headers: JSON_BEARER_HEADERS,
        body: { documents: [] },
        redirect: "error",
      },
    ]);
  });

  it("delivers a document item as a one-document batch to /documents", async () => {
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 1 }));
    const item = await documentItem();

    expect(await transportFor(fetch.fetch).deliver(item)).toEqual({ kind: "ok" });
    expect(fetch.requests).toEqual([
      {
        url: `${GATEWAY}/documents`,
        method: "POST",
        headers: JSON_BEARER_HEADERS,
        body: { documents: [item.doc] },
        redirect: "error",
      },
    ]);
  });

  it("delivers a visit item as a one-record page_visits ingest carrying the schema", async () => {
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 }));
    const item = visitItem();

    expect(await transportFor(fetch.fetch).deliver(item)).toEqual({ kind: "ok" });
    expect(fetch.requests).toEqual([
      {
        url: `${GATEWAY}/analytics/ingest`,
        method: "POST",
        headers: JSON_BEARER_HEADERS,
        body: {
          tableName: "page_visits",
          sourceId: "web",
          records: [item.visit],
          schema: PAGE_VISITS_SCHEMA,
        },
        redirect: "error",
      },
    ]);
  });
});

describe("PushTransport — 2xx classification", () => {
  it("accepts a valid success body for each plane", async () => {
    const fetch = new FakeFetch((req) =>
      req.url.endsWith("/documents")
        ? jsonResponse(201, { ingested: 1 })
        : jsonResponse(200, { ingested: 1, deleted: 0 }),
    );
    const transport = transportFor(fetch.fetch);
    expect(await transport.deliver(await documentItem())).toEqual({ kind: "ok" });
    expect(await transport.deliver(visitItem())).toEqual({ kind: "ok" });
  });

  it("recognises the delivered document as suppressed when the gateway names its externalId", async () => {
    const item = await documentItem();
    const fetch = new FakeFetch(() =>
      jsonResponse(200, { ingested: 0, suppressed: [item.doc.externalId] }),
    );
    expect(await transportFor(fetch.fetch).deliver(item)).toEqual({ kind: "suppressed" });
  });

  it("does not treat a suppression naming another page as this page's", async () => {
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 1, suppressed: ["other"] }));
    expect(await transportFor(fetch.fetch).deliver(await documentItem())).toEqual({ kind: "ok" });
  });

  it("maps a paused rejection to a rejected outcome carrying the server state", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, { ingested: 0, rejected: [{ sourceId: "web", reason: "paused" }] }),
    );
    expect(await transportFor(fetch.fetch).deliver(await documentItem())).toEqual({
      kind: "rejected",
      state: "paused",
      reason: "paused",
    });
  });

  it.each([
    { label: "HTML", body: "<html>login</html>" },
    { label: "empty", body: "" },
    { label: "a bare number", body: "42" },
  ])("retries a 2xx whose body is $label as an invalid success response", async ({ body }) => {
    const fetch = new FakeFetch(() => textResponse(200, body));
    expect(await transportFor(fetch.fetch).deliver(await documentItem())).toEqual({
      kind: "retry",
      status: 200,
      reason: "Invalid gateway success response",
    });
  });
});

describe("PushTransport — recoverable statuses honour Retry-After", () => {
  const RECOVERABLE = [404, 405, 408, 409, 425, 429, 503];

  it.each(RECOVERABLE)("HTTP %s with delta-seconds → retry after that many ms", async (status) => {
    const fetch = new FakeFetch(() =>
      jsonResponse(status, { error: "come back later" }, { "Retry-After": "30" }),
    );
    expect(await transportFor(fetch.fetch).deliver(await documentItem())).toEqual({
      kind: "retry",
      status,
      reason: "come back later",
      retryAfterMs: 30_000,
    });
  });

  it.each(RECOVERABLE)("HTTP %s with an HTTP-date → retry at that instant", async (status) => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const fetch = new FakeFetch(() =>
      textResponse(status, "", { "Retry-After": new Date(T0 + 45_000).toUTCString() }),
    );
    expect(await transportFor(fetch.fetch).deliver(visitItem())).toEqual({
      kind: "retry",
      status,
      reason: `HTTP ${status}`,
      retryAfterMs: 45_000,
    });
  });

  it.each(RECOVERABLE)("HTTP %s without Retry-After → retry with no hint", async (status) => {
    const fetch = new FakeFetch(() => jsonResponse(status, {}));
    const outcome = await transportFor(fetch.fetch).deliver(await documentItem());
    expect(outcome).toEqual({ kind: "retry", status, reason: `HTTP ${status}` });
    expect(outcome).toHaveProperty("retryAfterMs", undefined);
  });
});

describe("PushTransport — other server errors", () => {
  it.each([500, 502])("HTTP %s → retry without a Retry-After hint", async (status) => {
    const fetch = new FakeFetch(() =>
      jsonResponse(status, { error: "upstream exploded" }, { "Retry-After": "30" }),
    );
    const outcome = await transportFor(fetch.fetch).deliver(await documentItem());
    expect(outcome).toEqual({ kind: "retry", status, reason: "upstream exploded" });
    // Only the recoverable set reads the header; a generic 5xx leaves the
    // schedule to the client's backoff.
    expect(outcome).not.toHaveProperty("retryAfterMs");
    expect(outcome).not.toHaveProperty("network");
  });
});

describe("PushTransport — non-retryable client errors", () => {
  it.each([400, 401, 403, 413, 422])(
    "HTTP %s with a JSON error → drop carrying the gateway's reason",
    async (status) => {
      const fetch = new FakeFetch(() => jsonResponse(status, { error: "the gateway said no" }));
      expect(await transportFor(fetch.fetch).deliver(await documentItem())).toEqual({
        kind: "drop",
        status,
        reason: "the gateway said no",
      });
    },
  );

  it("bounds an oversized gateway reason", async () => {
    const fetch = new FakeFetch(() => jsonResponse(400, { error: "x".repeat(2000) }));
    const outcome = await transportFor(fetch.fetch).deliver(await documentItem());
    expect(outcome.kind).toBe("drop");
    expect(outcome.kind === "drop" && outcome.reason).toHaveLength(MAX_GATEWAY_REASON_CHARS);
  });

  it.each([
    { label: "empty", body: "" },
    { label: "non-JSON", body: "<html>forbidden</html>" },
    { label: "JSON without an error string", body: JSON.stringify({ message: "nope" }) },
  ])("falls back to the status line for an $label body", async ({ body }) => {
    const fetch = new FakeFetch(() => textResponse(403, body));
    expect(await transportFor(fetch.fetch).deliver(visitItem())).toEqual({
      kind: "drop",
      status: 403,
      reason: "HTTP 403",
    });
  });

  it("drops any other status the tables do not name", async () => {
    // Redirects are refused at fetch level (`redirect: "error"`), so a 3xx
    // status object can only come from an adapter; it falls through to drop.
    const fetch = new FakeFetch(() => textResponse(302, ""));
    expect(await transportFor(fetch.fetch).deliver(visitItem())).toEqual({
      kind: "drop",
      status: 302,
      reason: "HTTP 302",
    });
  });
});

describe("PushTransport — network faults and the wall-clock bound", () => {
  it("a rejected fetch → network retry carrying the error message", async () => {
    const fetch = new FakeFetch(() => "network-error");
    expect(await transportFor(fetch.fetch).deliver(await documentItem())).toEqual({
      kind: "retry",
      network: true,
      reason: "network error",
    });
  });

  it("truncates a long network error message to 120 characters", async () => {
    const fetch: FetchLike = () => Promise.reject(new Error("e".repeat(500)));
    const outcome = await transportFor(fetch).deliver(visitItem());
    expect(outcome.kind).toBe("retry");
    expect(outcome.kind === "retry" && outcome.reason).toHaveLength(120);
  });

  it("a fetch that never settles → network retry with the timeout reason", async () => {
    const fetch: FetchLike = () => new Promise(() => undefined);
    expect(await transportFor(fetch, 5).deliver(await documentItem())).toEqual({
      kind: "retry",
      network: true,
      reason: "gateway request timed out",
    });
  });

  it("aborts the request's signal when the deadline passes", async () => {
    let signal: AbortSignal | undefined;
    const fetch: FetchLike = (_input, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    };
    const outcome = await transportFor(fetch, 5).deliver(visitItem());
    expect(outcome).toMatchObject({ kind: "retry", network: true });
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  });

  it("does not abort the signal when the exchange completes in time", async () => {
    let signal: AbortSignal | undefined;
    const fetch: FetchLike = (_input, init) => {
      signal = init.signal;
      return Promise.resolve(jsonResponse(200, { ingested: 1 }));
    };
    expect(await transportFor(fetch, 1000).deliver(await documentItem())).toEqual({ kind: "ok" });
    expect(signal?.aborted).toBe(false);
  });

  it("a body that stalls after the headers is also a timeout", async () => {
    const fetch: FetchLike = () =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        text: () => new Promise<string>(() => undefined),
      });
    expect(await transportFor(fetch, 5).deliver(visitItem())).toEqual({
      kind: "retry",
      network: true,
      reason: "gateway request timed out",
    });
  });

  it("an oversized declared body is a network-class retry, not a success", async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        jsonResponse(200, { ingested: 1 }, { "content-length": String(2 * 1024 * 1024) }),
      );
    expect(await transportFor(fetch).deliver(await documentItem())).toEqual({
      kind: "retry",
      network: true,
      reason: "Gateway response exceeded the extension size limit",
    });
  });
});

describe("parseRetryAfter — edge cases", () => {
  it.each([null, ""])("returns undefined for an absent header (%j)", (value) => {
    expect(parseRetryAfter(value)).toBeUndefined();
  });

  it("parses zero and clamps negative delta-seconds to zero", () => {
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("-15")).toBe(0);
  });

  it("parses fractional delta-seconds", () => {
    expect(parseRetryAfter("1.5")).toBe(1500);
  });

  it("returns undefined for a value that is neither a number nor a date", () => {
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter("NaN")).toBeUndefined();
  });

  it("clamps a past HTTP-date to zero and measures a future one from now", () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    expect(parseRetryAfter(new Date(T0 - 60_000).toUTCString())).toBe(0);
    expect(parseRetryAfter(new Date(T0 + 90_000).toUTCString())).toBe(90_000);
  });
});

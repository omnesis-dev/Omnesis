// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Retry-engine coverage for HttpGatewayClient.request().
 *
 * These exercise the failure/backoff paths the integration suite in
 * `http-gateway-client.test.ts` never touches:
 *   - 503 + Retry-After backpressure self-heal (NOT counted against the
 *     retry budget, delay clamped to 30s), and
 *   - 5xx/429 exponential-backoff retry that throws after MAX_RETRIES,
 *     vs. an immediate throw on a non-429 4xx.
 *
 * `fetch` is stubbed (no real HTTP server / no port binding) and timers
 * are faked so the 1s/2s/4s backoff sleeps advance deterministically —
 * no wall-clock coupling, no flake.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { SourceId } from "@omnesis/types";
import { toErrorMessage } from "@omnesis/core";
import { HttpGatewayClient } from "./http-gateway-client.js";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function ok(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function err(status: number, headers: Record<string, string> = {}): Response {
  return new Response(`error body ${status}`, { status, headers });
}

/**
 * Drain queued microtasks AND fire any fake timer scheduled within `ms`.
 * `advanceTimersByTimeAsync` flushes the microtask queue between timer
 * fires, which is what lets the `await fetch()` → `await setTimeout()`
 * interleaving inside `request()` make forward progress under fake timers.
 */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("HttpGatewayClient.request() retry engine", () => {
  test("503 + Retry-After retries indefinitely (not capped at MAX_RETRIES) then succeeds", async () => {
    const client = new HttpGatewayClient("http://gw.example", "key");

    // Six 503s — MORE than MAX_RETRIES (3). If the backpressure path
    // burned a retry slot, this would throw "Gateway error 503" after
    // the 4th attempt. The contract is that 503+Retry-After self-heals
    // without consuming the retry budget, so all six must be tolerated.
    for (let i = 0; i < 6; i++) {
      mockFetch.mockResolvedValueOnce(err(503, { "Retry-After": "1" }));
    }
    mockFetch.mockResolvedValueOnce(ok({ count: 1 }));

    // getDocumentCount issues a single GET through request().
    const pending = client.getDocumentCount(SourceId("gmail"));

    // Each 503 schedules a 1s (Retry-After: 1) backpressure wait. Drive
    // every queued wait to exhaustion; the run settles on the 200.
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(1);
    // 6 backpressure attempts + 1 success — all six 503s were tolerated
    // even though that exceeds MAX_RETRIES (3).
    expect(mockFetch).toHaveBeenCalledTimes(7);
  });

  test("503 Retry-After delay is clamped to 30s (a 120s header does not stall longer)", async () => {
    const client = new HttpGatewayClient("http://gw.example", "key");

    mockFetch.mockResolvedValueOnce(err(503, { "Retry-After": "120" }));
    mockFetch.mockResolvedValueOnce(ok({ count: 0 }));

    const pending = client.getDocumentCount(SourceId("gmail"));

    // Let the first (503) fetch resolve and schedule its wait.
    await tick(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advancing the full clamp window (30s) must release the retry. If
    // the code honored the raw 120s header instead of clamping, 30s
    // would not be enough and the second fetch would not have fired.
    await tick(30000);
    await expect(pending).resolves.toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("retries 5xx with exponential backoff then throws after MAX_RETRIES (4 attempts)", async () => {
    const client = new HttpGatewayClient("http://gw.example", "key");

    // Permanent 500 — every attempt fails. A fresh Response per call:
    // request() reads res.text() each attempt, and a Response body can
    // only be consumed once.
    mockFetch.mockImplementation(() => Promise.resolve(err(500)));

    const pending = client.getDocumentCount(SourceId("gmail"));
    // The promise rejects; attach a catch immediately so an unhandled
    // rejection can't surface while we advance timers.
    const settled = pending.then(
      () => ({ ok: true as const }),
      (e: Error) => ({ ok: false as const, message: e.message }),
    );

    // Drive every queued backoff (1s, 2s, 4s) to exhaustion. After the
    // 4th attempt there is no retry budget left, so the loop throws and
    // no further timer is scheduled — runAllTimersAsync settles cleanly.
    await vi.runAllTimersAsync();
    const result = await settled;

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/Gateway error 500/);
    // MAX_RETRIES (3) retries + the initial attempt = exactly 4 fetches.
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  test("retries 429 (rate-limited) like a 5xx", async () => {
    const client = new HttpGatewayClient("http://gw.example", "key");

    mockFetch.mockResolvedValueOnce(err(429));
    mockFetch.mockResolvedValueOnce(ok({ count: 3 }));

    const pending = client.getDocumentCount(SourceId("gmail"));

    // 429 is retryable: one backoff then the 200 lands.
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("throws immediately on a non-429 4xx — no retry", async () => {
    const client = new HttpGatewayClient("http://gw.example", "key");

    // A 400 is a permanent client error; isRetryable(400) is false, so
    // the first attempt must throw with no second fetch.
    mockFetch.mockImplementation(() => Promise.resolve(err(400)));

    const pending = client.getDocumentCount(SourceId("gmail"));
    const settled = pending.then(
      () => ({ ok: true as const }),
      (e: Error) => ({ ok: false as const, message: e.message }),
    );

    await tick(0);
    const result = await settled;

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/Gateway error 400/);
    // Exactly one fetch — no backoff, no retry on a non-retryable 4xx.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("HttpGatewayClient.request() transport-failure reporting", () => {
  /** The rejection a fetch produces when the peer closes a keep-alive socket. */
  function socketClosed(): TypeError {
    return new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
  }

  test("a transport failure names the request, not just the category", async () => {
    const client = new HttpGatewayClient("http://gw.example", "key");
    mockFetch.mockRejectedValue(socketClosed());

    const pending = client.getDocumentCount(SourceId("gmail")).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const thrown = (await pending) as Error;

    // Without the request in it, an operator sees "fetch failed" on a red
    // source and cannot tell the gateway apart from the upstream API.
    expect(thrown.message).toContain("Gateway request GET /documents/count");
    // The reason rides in the cause; `toErrorMessage` is what renders both,
    // and it must say the reason once, not once per wrapper.
    expect(toErrorMessage(thrown)).toBe(
      "Gateway request GET /documents/count/gmail failed: fetch failed: other side closed",
    );
    expect(thrown.cause).toBeInstanceOf(TypeError);
  });

  test("a response the gateway sent keeps its message verbatim", async () => {
    // Callers match `Gateway error 404:` with startsWith; wrapping this one
    // the way a transport failure is wrapped would silently break them.
    const client = new HttpGatewayClient("http://gw.example", "key");
    mockFetch.mockResolvedValue(err(404));

    const pending = client.getDocumentCount(SourceId("gmail")).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const thrown = (await pending) as Error;

    expect(thrown.message.startsWith("Gateway error 404:")).toBe(true);
  });

  test("retries a body that died mid-read, then succeeds", async () => {
    // `terminated` is undici's word for a response whose body stopped
    // arriving. The request reached the gateway; only the reply was lost.
    const client = new HttpGatewayClient("http://gw.example", "key");
    mockFetch
      .mockRejectedValueOnce(new TypeError("terminated"))
      .mockResolvedValueOnce(ok({ count: 7 }));

    const pending = client.getDocumentCount(SourceId("gmail"));
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(7);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("HttpGatewayClient.request() compatibility-guard failures", () => {
  function socketClosed(): TypeError {
    return new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
  }

  test("a dropped socket on the guard is retried, not fatal", async () => {
    // The guard makes its own HTTP call before every request. A blip there is
    // the same blip the request itself rides out; treating it as fatal ended
    // syncs that had nothing wrong with them.
    const beforeRequest = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(socketClosed())
      .mockResolvedValue(undefined);
    const client = new HttpGatewayClient("http://gw.example", "key", { beforeRequest });
    mockFetch.mockResolvedValue(ok({ count: 3 }));

    const pending = client.getDocumentCount(SourceId("gmail"));
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(3);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
  });

  test("a compatibility refusal is never retried and reaches the caller verbatim", async () => {
    // The whole reason the guard runs outside the request: an incompatible
    // gateway must stop the call, not be hammered three more times.
    const refusal = new Error("Gateway source contract 3 is newer than this collector's 2");
    const beforeRequest = vi.fn<() => Promise<void>>().mockRejectedValue(refusal);
    const client = new HttpGatewayClient("http://gw.example", "key", { beforeRequest });
    mockFetch.mockResolvedValue(ok());

    const thrown = await client.getDocumentCount(SourceId("gmail")).catch((e: unknown) => e);

    expect(thrown).toBe(refusal);
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    // The guarded request must not have been sent.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("a guard that never recovers still fails, naming the check", async () => {
    const beforeRequest = vi.fn<() => Promise<void>>().mockRejectedValue(socketClosed());
    const client = new HttpGatewayClient("http://gw.example", "key", { beforeRequest });

    const pending = client.getDocumentCount(SourceId("gmail")).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const thrown = (await pending) as Error;

    expect(toErrorMessage(thrown)).toContain("other side closed");
    expect(beforeRequest).toHaveBeenCalledTimes(4);
  });
});

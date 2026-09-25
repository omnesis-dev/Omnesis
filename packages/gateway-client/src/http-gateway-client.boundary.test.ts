// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Backpressure-cap BOUNDARY coverage for HttpGatewayClient.request().
 *
 * The retry-engine suite in `http-gateway-client.retry.test.ts` proves
 * that a *handful* of 503+Retry-After responses self-heal without burning
 * the retry budget, but it never approaches the
 * DEFAULT_MAX_BACKPRESSURE_WAITS cap (10). These pin the EXACT cap edge:
 *
 *   request() takes the backpressure branch while
 *     `backpressureWaits < MAX_BACKPRESSURE_WAITS`
 *   i.e. for backpressureWaits = 0..9 → exactly TEN 503-backpressure
 *   waits. The 11th consecutive 503 must fall through to the ordinary
 *   retry path (it is no longer treated as backpressure), where the
 *   normal MAX_RETRIES (3) exponential-backoff budget applies before the
 *   call finally throws.
 *
 * That makes the all-503 fetch count fully determined:
 *   10 backpressure waits  (backpressureWaits 0..9, attempt stays 0)
 *   + 3 retry-backoffs     (attempt 0→1→2→3)
 *   + 1 final attempt that throws (attempt === MAX_RETRIES)
 *   = 14 fetches, then `Gateway error 503`.
 *
 * Loosening the guard to `<=` would grant an ELEVENTH backpressure wait
 * (backpressureWaits 0..10), pushing the all-503 count to 15 — which is
 * exactly what the assertions below forbid.
 *
 * `fetch` is stubbed (no real HTTP / no port) and timers are faked so the
 * backpressure (Retry-After) and exponential-backoff sleeps advance
 * deterministically — no wall-clock coupling.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { AccountId, SourceId, SourceType } from "@omnesis/types";
import { HttpGatewayClient } from "./http-gateway-client.js";
import { DEFAULT_MAX_BACKPRESSURE_WAITS } from "./tunables.js";

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

function ok(body: unknown = { count: 0 }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A 503 carrying Retry-After: 1 → a 1s backpressure wait. */
function backpressure503(): Response {
  return new Response("queue full", {
    status: 503,
    headers: { "Retry-After": "1" },
  });
}

describe("HttpGatewayClient.request() backpressure cap boundary", () => {
  test("tolerates EXACTLY MAX_BACKPRESSURE_WAITS (10) backpressure 503s, then the next 503 falls through to retry+throw", async () => {
    const client = new HttpGatewayClient("http://gw.example", "key");

    // Permanent 503+Retry-After on every attempt. A Response body can be
    // read only once, so hand back a fresh Response per call.
    mockFetch.mockImplementation(() => Promise.resolve(backpressure503()));

    const pending = client.getDocumentCount(SourceId("gmail"));
    const settled = pending.then(
      () => ({ ok: true as const }),
      (e: Error) => ({ ok: false as const, message: e.message }),
    );

    // Drain every backpressure wait (1s each) AND every retry backoff
    // (1s/2s/4s) to exhaustion.
    await vi.runAllTimersAsync();
    const result = await settled;

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/Gateway error 503/);

    // 10 backpressure waits (backpressureWaits 0..9) + 4 retry-budget
    // attempts (initial + MAX_RETRIES=3) = 14. With the guard loosened to
    // `<=` an 11th 503 would be absorbed as backpressure → 15 fetches.
    expect(DEFAULT_MAX_BACKPRESSURE_WAITS).toBe(10);
    expect(mockFetch).toHaveBeenCalledTimes(14);
  });

  test("the run succeeds when a 200 lands on the LAST tolerated backpressure wait (the 10th)", async () => {
    const client = new HttpGatewayClient("http://gw.example", "key");

    // Nine 503-backpressure waits, then a 200 on the 10th fetch. This sits
    // strictly inside the cap (backpressureWaits reaches 9, < 10) on the
    // correct code AND on the `<=` mutant — both accept it — so it is the
    // companion "still healthy below/at the budget" assertion, not the
    // discriminator. It guards against an over-tightening regression that
    // would reject a within-budget self-heal.
    for (let i = 0; i < 9; i++) {
      mockFetch.mockResolvedValueOnce(backpressure503());
    }
    mockFetch.mockResolvedValueOnce(ok({ count: 7 }));

    const pending = client.getDocumentCount(SourceId("gmail"));
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(7);
    // 9 backpressure waits + 1 success = 10 fetches, all within the cap.
    expect(mockFetch).toHaveBeenCalledTimes(10);
  });
});

describe("HttpGatewayClient member-local source registration boundary", () => {
  test("uses the versioned no-fallback endpoint before any member config can mutate an old gateway", async () => {
    const client = new HttpGatewayClient("http://gw.example", "key");
    mockFetch.mockResolvedValueOnce(
      ok({
        count: 1,
        sources: [
          {
            id: "sessions-synth:local",
            updated: false,
            memberConfigApplied: true,
          },
        ],
        errors: [],
      }),
    );

    await client.bulkUpsertSources([
      {
        type: SourceType("sessions-synth"),
        accountId: AccountId("local"),
        config: { enabled: true },
        memberConfig: { params: { sessionsPath: "/srv/fictional-alpha/sessions" } },
      },
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      "http://gw.example/devices/sources/bulk-upsert-member-config",
    );
  });
});

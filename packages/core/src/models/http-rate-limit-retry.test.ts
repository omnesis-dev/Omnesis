// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BACKGROUND_RATE_LIMIT_PATIENCE,
  rateLimitRetryDelayMs,
  retryRateLimitedRequest,
} from "./http-rate-limit-retry.js";

afterEach(() => vi.useRealTimers());

describe("rateLimitRetryDelayMs", () => {
  it("parses Retry-After seconds and dates", () => {
    expect(rateLimitRetryDelayMs(new Headers({ "Retry-After": "1.5" }), 0)).toBe(1_500);
    expect(
      rateLimitRetryDelayMs(new Headers({ "Retry-After": "Thu, 01 Jan 1970 00:00:03 GMT" }), 1_000),
    ).toBe(2_000);
  });

  it("uses the longest exhausted provider dimension", () => {
    const headers = new Headers({
      "x-ratelimit-remaining-tokens-minute": "0",
      "x-ratelimit-reset-tokens-minute": "2.5",
      "x-ratelimit-remaining-requests-day": "0",
      "x-ratelimit-reset-requests-day": "8",
    });
    expect(rateLimitRetryDelayMs(headers)).toBe(8_000);
  });

  it("uses the soonest reset when remaining headers are absent", () => {
    const headers = new Headers({
      "x-ratelimit-reset-tokens-minute": "2.5",
      "x-ratelimit-reset-requests-day": "8",
    });
    expect(rateLimitRetryDelayMs(headers)).toBe(2_500);
  });

  it("uses a reset when a weighted request exceeds a positive remainder", () => {
    expect(
      rateLimitRetryDelayMs(
        new Headers({
          "x-ratelimit-remaining-tokens-minute": "1",
          "x-ratelimit-reset-tokens-minute": "2",
        }),
      ),
    ).toBe(2_000);
  });

  it("ignores malformed hints and clamps past dates", () => {
    expect(rateLimitRetryDelayMs(new Headers({ "Retry-After": "not-a-delay" }))).toBeUndefined();
    expect(
      rateLimitRetryDelayMs(new Headers({ "Retry-After": "Thu, 01 Jan 1970 00:00:01 GMT" }), 2_000),
    ).toBe(0);
  });
});

describe("retryRateLimitedRequest", () => {
  it("retries 429 twice with jittered exponential delays", async () => {
    const responses = [
      new Response("first", { status: 429 }),
      new Response("second", { status: 429 }),
      new Response("ok", { status: 200 }),
    ];
    const request = vi.fn(async () => responses.shift()!);
    const sleep = vi.fn(async () => undefined);

    const result = await retryRateLimitedRequest(request, { random: () => 0.5, sleep });

    expect(result.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([
      [1_000, undefined],
      [2_000, undefined],
    ]);
    expect(responses).toHaveLength(0);
  });

  it("waits out quota resets of a minute under background patience", async () => {
    const limited = (): Response =>
      new Response("limited", { status: 429, headers: { "Retry-After": "60" } });
    const responses = [limited(), limited(), new Response("ok")];
    const request = vi.fn(async () => responses.shift()!);
    const sleep = vi.fn(async () => undefined);

    const result = await retryRateLimitedRequest(request, {
      ...BACKGROUND_RATE_LIMIT_PATIENCE,
      random: () => 0,
      sleep,
    });

    expect(result.status).toBe(200);
    expect(sleep.mock.calls).toEqual([
      [60_000, undefined],
      [60_000, undefined],
    ]);
  });

  it("jitters a provider's reset upward so callers sharing a quota spread out", async () => {
    const request = vi
      .fn<(attempt: number) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response("limited", { status: 429, headers: { "Retry-After": "60" } }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    const sleep = vi.fn(async () => undefined);

    await retryRateLimitedRequest(request, {
      ...BACKGROUND_RATE_LIMIT_PATIENCE,
      random: () => 1,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(66_000, undefined);
    expect(request.mock.calls).toEqual([[1], [2]]);
  });

  it("returns a quota reset beyond background patience without waiting", async () => {
    const request = vi.fn(
      async () => new Response("limited", { status: 429, headers: { "Retry-After": "3600" } }),
    );
    const sleep = vi.fn(async () => undefined);

    const result = await retryRateLimitedRequest(request, {
      ...BACKGROUND_RATE_LIMIT_PATIENCE,
      sleep,
    });

    expect(result.status).toBe(429);
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("preserves the final 429 after the attempt cap", async () => {
    const request = vi.fn(async () => new Response("limited", { status: 429 }));
    const result = await retryRateLimitedRequest(request, {
      random: () => 0.5,
      sleep: async () => undefined,
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(await result.text()).toBe("limited");
  });

  it("honors provider hints as a floor and cancels intermediate bodies", async () => {
    const first = new Response("limited", {
      status: 429,
      headers: { "Retry-After": "2" },
    });
    const cancel = vi.spyOn(first.body!, "cancel");
    const request = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(new Response("ok"));
    const sleep = vi.fn(async () => undefined);

    await retryRateLimitedRequest(request, { random: () => 0, sleep });

    expect(sleep).toHaveBeenCalledWith(2_000, undefined);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns immediately when the provider delay exceeds the total budget", async () => {
    const request = vi.fn(async () =>
      Promise.resolve(new Response("limited", { status: 429, headers: { "Retry-After": "30" } })),
    );
    const sleep = vi.fn(async () => undefined);
    const result = await retryRateLimitedRequest(request, { sleep });
    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(await result.text()).toBe("limited");
  });

  it("does not exceed the cumulative delay budget", async () => {
    const request = vi.fn(async () => new Response("limited", { status: 429 }));
    const sleep = vi.fn(async () => undefined);
    await retryRateLimitedRequest(request, {
      baseDelayMs: 1_000,
      maxAttempts: 5,
      maxTotalDelayMs: 2_500,
      random: () => 0.5,
      sleep,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry other statuses", async () => {
    const request = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const sleep = vi.fn(async () => undefined);
    expect((await retryRateLimitedRequest(request, { sleep })).status).toBe(503);
    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops during backoff when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn(async () => new Response("limited", { status: 429 }));
    const pending = retryRateLimitedRequest(request, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.abort(new DOMException("canceled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledOnce();
  });
});

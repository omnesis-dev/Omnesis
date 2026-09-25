// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { retry } from "./retry.js";

const fakeSleep =
  (sleeps: number[]): ((ms: number) => Promise<void>) =>
  async (ms) => {
    sleeps.push(ms);
  };

describe("retry", () => {
  it("returns the value when fn succeeds on the first try", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn(async () => "ok");
    const result = await retry(fn, { sleep: fakeSleep(sleeps) });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("retries until fn succeeds", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("flaky");
      return "ok";
    });
    const result = await retry(fn, { sleep: fakeSleep(sleeps), baseBackoffMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    // Default backoff: attempt 1 fails → 10ms, attempt 2 fails → 20ms.
    expect(sleeps).toEqual([10, 20]);
  });

  it("rethrows the last error after maxAttempts", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(
      retry(fn, { sleep: fakeSleep(sleeps), maxAttempts: 3, baseBackoffMs: 5 }),
    ).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(3);
    // Two waits between three attempts.
    expect(sleeps).toEqual([5, 10]);
  });

  it("rethrows immediately when shouldRetry returns false", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn(async () => {
      throw new Error("permanent");
    });
    await expect(
      retry(fn, {
        sleep: fakeSleep(sleeps),
        shouldRetry: () => false,
        maxAttempts: 5,
      }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("passes the failed attempt number to shouldRetry (1-indexed)", async () => {
    const sleeps: number[] = [];
    const seen: number[] = [];
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      throw new Error("boom");
    });
    await expect(
      retry(fn, {
        sleep: fakeSleep(sleeps),
        maxAttempts: 4,
        baseBackoffMs: 1,
        shouldRetry: (_err, attempt) => {
          seen.push(attempt);
          return true;
        },
      }),
    ).rejects.toThrow("boom");
    expect(attempts).toBe(4);
    // shouldRetry is consulted after attempt 1, 2, 3 (not after the
    // final attempt 4 — it's rethrown unconditionally).
    expect(seen).toEqual([1, 2, 3]);
  });

  it("honours computeBackoff (e.g. Retry-After override)", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("rate-limited");
      return "ok";
    });
    await retry(fn, {
      sleep: fakeSleep(sleeps),
      baseBackoffMs: 100,
      computeBackoff: (_err, attempt) => attempt * 1000,
    });
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("caps backoff at maxBackoffMs", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });
    await expect(
      retry(fn, {
        sleep: fakeSleep(sleeps),
        maxAttempts: 4,
        baseBackoffMs: 1_000,
        maxBackoffMs: 1_500,
      }),
    ).rejects.toThrow("nope");
    // Default schedule would be 1000, 2000, 4000 — capped to 1000, 1500, 1500.
    expect(sleeps).toEqual([1000, 1500, 1500]);
  });

  it("calls onRetry with the actual delay (post-cap)", async () => {
    const sleeps: number[] = [];
    const calls: Array<{ attempt: number; delay: number; msg: string }> = [];
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("flaky");
      return "ok";
    });
    await retry(fn, {
      sleep: fakeSleep(sleeps),
      baseBackoffMs: 50,
      maxBackoffMs: 60,
      onRetry: (err, attempt, delayMs) => {
        calls.push({ attempt, delay: delayMs, msg: (err as Error).message });
      },
    });
    expect(calls).toEqual([
      { attempt: 1, delay: 50, msg: "flaky" },
      { attempt: 2, delay: 60, msg: "flaky" }, // post-cap
    ]);
  });

  it("rejects negative computeBackoff returns by clamping to zero", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("once");
      return "ok";
    });
    await retry(fn, {
      sleep: fakeSleep(sleeps),
      computeBackoff: () => -500,
    });
    expect(sleeps).toEqual([0]);
  });
});

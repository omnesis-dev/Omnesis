// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, it, vi } from "vitest";
import { RealtimeRateLimit } from "./rate-limit.js";
afterEach(() => vi.useRealTimers());
it("estimates just the token deficit using provider usage and elapsed refill", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const limits = new RealtimeRateLimit();
  const input = [{ text: "Fictional workshop inventory" }];
  limits.request(input);
  limits.observe({
    type: "response.done",
    response: { usage: { input_tokens: 100000, output_tokens: 0 } },
  });
  limits.observe({
    type: "rate_limits.updated",
    rate_limits: [{ name: "tokens", limit: 200000, remaining: 40000, reset_seconds: 48 }],
  });
  expect(limits.delayMs(input)).toBe(18000);
  vi.advanceTimersByTime(10000);
  expect(limits.delayMs(input)).toBe(8000);
});
it("does not invent a token estimate before provider usage or accept malformed snapshots", () => {
  const limits = new RealtimeRateLimit();
  limits.observe({
    type: "rate_limits.updated",
    rate_limits: [{ name: "tokens", limit: 200000, remaining: 0, reset_seconds: 60 }],
  });
  expect(limits.delayMs([])).toBeUndefined();
  limits.observe({
    type: "rate_limits.updated",
    rate_limits: [{ name: "requests", limit: 10, remaining: 11, reset_seconds: 60 }],
  });
  expect(limits.delayMs([])).toBeUndefined();
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Direct tests for the per-IP rate limiter.
// Uses fake time via injected `now` arg so the tests are deterministic
// without `vi.useFakeTimers()` global state.
import { describe, expect, test } from "vitest";
import {
  IpRateLimiter,
  pairingRateLimiter,
  portalLoginRateLimiter,
  wsHelloRateLimiter,
  searchRateLimiter,
  documentsRateLimiter,
  notesRateLimiter,
} from "./rate-limit.js";

describe("IpRateLimiter", () => {
  test("allows up to capacity then refuses", () => {
    const r = new IpRateLimiter({
      surface: "test",
      burst: { capacity: 3, windowMs: 60_000 },
      hourly: { capacity: 100, windowMs: 3_600_000 },
    });
    const now = 1_000_000;
    expect(r.consume("1.2.3.4", now)).toBeNull();
    expect(r.consume("1.2.3.4", now)).toBeNull();
    expect(r.consume("1.2.3.4", now)).toBeNull();
    // 4th attempt within the same instant — refused.
    expect(r.consume("1.2.3.4", now)).toMatch(/burst limit exceeded/);
  });

  test("refills tokens linearly over the window", () => {
    const r = new IpRateLimiter({
      surface: "test",
      burst: { capacity: 4, windowMs: 60_000 },
      hourly: { capacity: 100, windowMs: 3_600_000 },
    });
    const t0 = 1_000_000;
    // Drain the burst bucket.
    for (let i = 0; i < 4; i += 1) expect(r.consume("1.2.3.4", t0)).toBeNull();
    expect(r.consume("1.2.3.4", t0)).toMatch(/burst/);
    // 30s later → half-refilled (2 tokens). Two more allowed, third refused.
    const t1 = t0 + 30_000;
    expect(r.consume("1.2.3.4", t1)).toBeNull();
    expect(r.consume("1.2.3.4", t1)).toBeNull();
    expect(r.consume("1.2.3.4", t1)).toMatch(/burst/);
  });

  test("hourly limit catches a slow-roll attacker pacing under burst", () => {
    const r = new IpRateLimiter({
      surface: "test",
      burst: { capacity: 100, windowMs: 60_000 },
      hourly: { capacity: 5, windowMs: 3_600_000 },
    });
    let now = 1_000_000;
    for (let i = 0; i < 5; i += 1) {
      expect(r.consume("1.2.3.4", now)).toBeNull();
      now += 1_000; // 1s gap — under any burst limit
    }
    expect(r.consume("1.2.3.4", now)).toMatch(/hourly limit exceeded/);
  });

  test("buckets are per-IP", () => {
    const r = new IpRateLimiter({
      surface: "test",
      burst: { capacity: 1, windowMs: 60_000 },
      hourly: { capacity: 10, windowMs: 3_600_000 },
    });
    const now = 1_000_000;
    expect(r.consume("1.2.3.4", now)).toBeNull();
    expect(r.consume("1.2.3.4", now)).toMatch(/burst/);
    // Different IP — fresh bucket.
    expect(r.consume("5.6.7.8", now)).toBeNull();
  });

  test("default factories use the documented capacities", () => {
    const pair = pairingRateLimiter();
    const ws = wsHelloRateLimiter();
    // Both should allow the first 10 requests within a single instant
    // (burst capacity = 10 in both default configs) and refuse the 11th.
    const now = 1_000_000;
    for (let i = 0; i < 10; i += 1) {
      expect(pair.consume("1.2.3.4", now)).toBeNull();
      expect(ws.consume("1.2.3.4", now)).toBeNull();
    }
    expect(pair.consume("1.2.3.4", now)).toMatch(/burst/);
    expect(ws.consume("1.2.3.4", now)).toMatch(/burst/);
  });

  test("portalLoginRateLimiter throttles brute-force login attempts", () => {
    const r = portalLoginRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 10; i += 1) expect(r.consume("1.2.3.4", now)).toBeNull();
    expect(r.consume("1.2.3.4", now)).toMatch(/burst limit exceeded/);
    // A different client IP gets its own bucket.
    expect(r.consume("5.6.7.8", now)).toBeNull();
  });
});

describe("endpoint limiter factories", () => {
  test("searchRateLimiter refuses past its burst capacity", () => {
    const r = searchRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 120; i += 1) expect(r.consume("1.2.3.4", now)).toBeNull();
    expect(r.consume("1.2.3.4", now)).toMatch(/burst limit exceeded/);
  });

  test("documentsRateLimiter tolerates an order of magnitude more (collector ingest)", () => {
    const r = documentsRateLimiter();
    const now = 1_000_000;
    // The collector batch-ingests; the ceiling sits far above search's so a
    // bootstrap never trips it. The 121st request — which would refuse on the
    // search limiter — still passes here.
    for (let i = 0; i < 1_200; i += 1) expect(r.consume("1.2.3.4", now)).toBeNull();
    expect(r.consume("1.2.3.4", now)).toMatch(/burst limit exceeded/);
  });

  test("notesRateLimiter caps at human-capture scale (120/min burst)", () => {
    const r = notesRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 120; i += 1) expect(r.consume("1.2.3.4", now)).toBeNull();
    expect(r.consume("1.2.3.4", now)).toMatch(/burst limit exceeded/);
    // A different client IP gets its own bucket.
    expect(r.consume("5.6.7.8", now)).toBeNull();
  });

  test("limiters track each IP independently", () => {
    const r = searchRateLimiter();
    const now = 1_000_000;
    for (let i = 0; i < 120; i += 1) expect(r.consume("1.1.1.1", now)).toBeNull();
    expect(r.consume("1.1.1.1", now)).toMatch(/burst/);
    // A different IP is unaffected.
    expect(r.consume("2.2.2.2", now)).toBeNull();
  });
});

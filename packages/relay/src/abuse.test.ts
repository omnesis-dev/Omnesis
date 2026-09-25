// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { RelayAbuseGuard, type RelayAbuseLimits } from "./abuse.js";

const limits: RelayAbuseLimits = {
  enrol: { limit: 2, windowMs: 100 },
  verify: { limit: 2, windowMs: 100 },
  invalidWake: { limit: 2, windowMs: 100 },
  globalEnrol: { limit: 2, windowMs: 50 },
  renewalEnrol: { limit: 1, windowMs: 50 },
  carrierFailures: { limit: 2, windowMs: 100 },
  maxTrackedSources: 2,
};

describe("RelayAbuseGuard", () => {
  it("enforces independent rolling source and global windows and recovers at the boundary", () => {
    const guard = new RelayAbuseGuard(limits);
    expect(guard.admitEnrol("source-a", 0).allowed).toBe(true);
    expect(guard.admitEnrol("source-a", 1).allowed).toBe(true);
    expect(guard.admitEnrol("source-b", 1).allowed).toBe(true);
    expect(guard.admitEnrol("source-a", 2)).toMatchObject({
      allowed: false,
      reason: "source_rate",
      retryAfterMs: 98,
    });
    expect(guard.admitEnrol("source-a", 100).allowed).toBe(true);

    expect(guard.reserveGlobalEnrol(0).allowed).toBe(true);
    expect(guard.reserveGlobalEnrol(1).allowed).toBe(true);
    expect(guard.reserveGlobalEnrol(2)).toMatchObject({
      allowed: false,
      reason: "global_circuit",
    });
    expect(guard.reserveGlobalEnrol(50).allowed).toBe(true);
    expect(guard.reserveRenewalEnrol(0).allowed).toBe(true);
    expect(guard.reserveRenewalEnrol(1)).toMatchObject({
      allowed: false,
      reason: "global_circuit",
    });
    expect(guard.reserveRenewalEnrol(50).allowed).toBe(true);
  });

  it("pays down one recent carrier failure per successful challenge", () => {
    const guard = new RelayAbuseGuard({
      ...limits,
      enrol: { limit: 10, windowMs: 100 },
      carrierFailures: { limit: 5, windowMs: 100 },
    });
    for (let now = 0; now < 4; now += 1) {
      guard.recordCarrierChallengeFailure("source-a", now);
    }
    guard.recordCarrierChallengeSuccess("source-a", 4);

    expect(guard.admitEnrol("source-a", 5).allowed).toBe(true);
    guard.recordCarrierChallengeFailure("source-a", 5);
    expect(guard.admitEnrol("source-a", 6).allowed).toBe(true);
    guard.recordCarrierChallengeFailure("source-a", 6);
    expect(guard.admitEnrol("source-a", 7)).toMatchObject({
      allowed: false,
      reason: "carrier_failure_penalty",
    });
  });

  it("admits new sources while preferentially retaining recently verified state", () => {
    const guard = new RelayAbuseGuard(limits);
    expect(guard.admitVerify("source-a", 0).allowed).toBe(true);
    guard.recordVerificationSuccess("source-a", 0);
    expect(guard.admitInvalidWake("source-b", 1).allowed).toBe(true);
    expect(guard.admitInvalidWake("source-b", 2).allowed).toBe(true);

    expect(guard.admitEnrol("source-c", 3).allowed).toBe(true);
    expect(guard.admitVerify("source-a", 4).allowed).toBe(true);
    expect(guard.admitVerify("source-a", 5)).toMatchObject({
      allowed: false,
      reason: "source_rate",
    });
    expect(guard.admitInvalidWake("source-b", 6).allowed).toBe(true);
  });

  it("stops preferring verified state after the verification window", () => {
    const guard = new RelayAbuseGuard({
      ...limits,
      carrierFailures: { limit: 2, windowMs: 200 },
    });
    expect(guard.admitVerify("source-a", 0).allowed).toBe(true);
    guard.recordVerificationSuccess("source-a", 0);
    guard.recordCarrierChallengeFailure("source-a", 50);
    expect(guard.admitInvalidWake("source-b", 60).allowed).toBe(true);

    expect(guard.admitEnrol("source-c", 100).allowed).toBe(true);
    expect(guard.admitInvalidWake("source-b", 101).allowed).toBe(true);
    expect(guard.admitInvalidWake("source-b", 102)).toMatchObject({
      allowed: false,
      reason: "source_rate",
    });
    expect(guard.admitEnrol("source-a", 103).allowed).toBe(true);
  });
});

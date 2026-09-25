// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";

import { RELAY_PRUNE_INTERVAL_MS, RelayService } from "./service.js";
import { RelayStore } from "./store.js";
import { RelayMetrics } from "./metrics.js";
import { CarrierDispatchError } from "./types.js";
import { RelayAbuseGuard, type RelayAbuseLimits } from "./abuse.js";
import type { RelayServiceError } from "./service.js";
import type {
  CarrierHealth,
  Clock,
  RandomSource,
  RelayCarrier,
  RelayPlatform,
  RelayTarget,
} from "./types.js";

class FakeCarrier implements RelayCarrier {
  challenges: Array<{ target: RelayTarget; nonce: string }> = [];
  wakes: RelayTarget[] = [];
  failChallenge = false;
  failWake = false;
  challengeError: Error | null = null;
  wakeError: Error | null = null;

  constructor(
    readonly platform: RelayPlatform,
    private readonly identities: ReadonlySet<string>,
  ) {}

  covers(appId: string): boolean {
    return this.identities.has(appId);
  }

  sendChallenge(target: RelayTarget, nonce: string): Promise<void> {
    if (this.challengeError) return Promise.reject(this.challengeError);
    if (this.failChallenge) return Promise.reject(new Error("challenge carrier failure"));
    this.challenges.push({ target, nonce });
    return Promise.resolve();
  }

  sendWake(target: RelayTarget): Promise<void> {
    if (this.wakeError) return Promise.reject(this.wakeError);
    if (this.failWake) return Promise.reject(new Error("wake carrier failure"));
    this.wakes.push(target);
    return Promise.resolve();
  }

  health(): CarrierHealth {
    return {
      configured: true,
      status: "reachable",
      lastSuccessAt: 1,
      lastFailureAt: null,
    };
  }

  async dispose(): Promise<void> {}
}

function deterministicRandom(): RandomSource {
  let next = 1;
  return {
    uuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    bytes: (length) => Buffer.alloc(length, next++),
  };
}

function setup(
  platform: RelayPlatform = "ios",
  options: {
    clock?: Clock;
    pruneIntervalMs?: number | null;
    abuseLimits?: RelayAbuseLimits;
    challengeTtlMs?: number;
    maxPendingChallenges?: number;
  } = {},
) {
  const clock: Clock = options.clock ?? { now: () => 10_000 };
  const carrier = new FakeCarrier(platform, new Set([`covered.${platform}`]));
  const store = new RelayStore();
  const metrics = new RelayMetrics();
  const service = new RelayService({
    store,
    carriers: [carrier],
    clock,
    random: deterministicRandom(),
    metrics,
    pruneIntervalMs: options.pruneIntervalMs ?? null,
    abuseGuard: options.abuseLimits ? new RelayAbuseGuard(options.abuseLimits) : undefined,
    challengeTtlMs: options.challengeTtlMs,
    maxPendingChallenges: options.maxPendingChallenges,
  });
  const target: RelayTarget =
    platform === "ios"
      ? {
          platform: "ios",
          token: "ab".repeat(32),
          appId: "covered.ios",
          environment: "production",
        }
      : { platform: "android", token: "fictional-fcm-token", appId: "covered.android" };
  return { service, store, carrier, target, metrics };
}

const testAbuseLimits: RelayAbuseLimits = {
  enrol: { limit: 10, windowMs: 1_000 },
  verify: { limit: 10, windowMs: 1_000 },
  invalidWake: { limit: 1, windowMs: 1_000 },
  globalEnrol: { limit: 10, windowMs: 1_000 },
  renewalEnrol: { limit: 10, windowMs: 1_000 },
  carrierFailures: { limit: 2, windowMs: 1_000 },
  maxTrackedSources: 10,
};

async function enrolAndVerify(set: ReturnType<typeof setup>): Promise<string> {
  const { challengeId } = await set.service.enrol(set.target);
  const nonce = set.carrier.challenges.at(-1)!.nonce;
  return set.service.verify(challengeId, nonce).credential;
}

describe("RelayService enrolment possession proof", () => {
  it("bounds pending challenges and uses the configured short expiry", async () => {
    const set = setup("ios", {
      abuseLimits: testAbuseLimits,
      challengeTtlMs: 25,
      maxPendingChallenges: 1,
    });
    await set.service.enrol(set.target, "source-a");
    await expect(set.service.enrol(set.target, "source-b")).rejects.toMatchObject({
      code: "capacity_unavailable",
    });
    const row = set.store.db.prepare("SELECT expires_at FROM relay_challenges").get() as {
      expires_at: number;
    };
    expect(row.expires_at).toBe(10_025);
    expect(set.carrier.challenges).toHaveLength(1);
    await set.service.dispose();
  });

  it("trips the global breaker before carrier dispatch and cleans up its challenge", async () => {
    const set = setup("ios", {
      abuseLimits: { ...testAbuseLimits, globalEnrol: { limit: 1, windowMs: 1_000 } },
    });
    await set.service.enrol(set.target, "source-a");
    await expect(set.service.enrol(set.target, "source-b")).rejects.toMatchObject({
      code: "capacity_unavailable",
    });
    expect(set.carrier.challenges).toHaveLength(1);
    const rows = set.store.db.prepare("SELECT COUNT(*) AS count FROM relay_challenges").get() as {
      count: number;
    };
    expect(rows.count).toBe(1);
    await set.service.dispose();
  });

  it("reserves a bounded renewal lane when new enrolments fill their circuit and capacity", async () => {
    const set = setup("ios", {
      abuseLimits: {
        ...testAbuseLimits,
        globalEnrol: { limit: 9, windowMs: 1_000 },
        renewalEnrol: { limit: 1, windowMs: 1_000 },
      },
      maxPendingChallenges: 10,
    });
    const oldCredential = await enrolAndVerify(set);
    for (let index = 0; index < 8; index += 1) {
      await set.service.enrol({ ...set.target, token: `new-token-${index}` }, `source-${index}`);
    }
    await expect(
      set.service.enrol({ ...set.target, token: "new-token-9" }, "source-9"),
    ).rejects.toMatchObject({ code: "capacity_unavailable" });

    const { challengeId } = await set.service.enrol(set.target, "renewal-source");
    await expect(set.service.enrol(set.target, "another-renewal-source")).rejects.toMatchObject({
      code: "capacity_unavailable",
    });
    const nonce = set.carrier.challenges.at(-1)!.nonce;
    const renewed = set.service.verify(challengeId, nonce, "renewal-source").credential;
    await set.service.wake(renewed);
    await expect(set.service.wake(oldCredential)).rejects.toMatchObject({
      code: "credential_rejected",
    });
    expect(set.carrier.wakes).toHaveLength(1);
    await set.service.dispose();
  });

  it("penalizes a source after repeated carrier-only failures", async () => {
    const set = setup("ios", { abuseLimits: testAbuseLimits });
    set.carrier.failChallenge = true;
    const dispatch = vi.spyOn(set.carrier, "sendChallenge");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(set.service.enrol(set.target, "source-a")).rejects.toMatchObject({
        code: "carrier_failed",
      });
      await expect(set.service.enrol(set.target, "source-a")).rejects.toMatchObject({
        code: "carrier_failed",
      });
      const rejection = await set.service.enrol(set.target, "source-a").catch((error) => error);
      expect(rejection).toMatchObject({ code: "rate_limited" });
      expect(String(rejection)).not.toContain("source-a");
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warning.mock.calls)).not.toContain("source-a");
    } finally {
      warning.mockRestore();
      await set.service.dispose();
    }
  });

  it("does not let one successful challenge erase a mostly failing source history", async () => {
    const set = setup("ios", {
      abuseLimits: {
        ...testAbuseLimits,
        enrol: { limit: 10, windowMs: 1_000 },
        globalEnrol: { limit: 10, windowMs: 1_000 },
        carrierFailures: { limit: 5, windowMs: 1_000 },
      },
    });
    const dispatch = vi.spyOn(set.carrier, "sendChallenge");
    set.carrier.failChallenge = true;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(set.service.enrol(set.target, "source-a")).rejects.toMatchObject({
        code: "carrier_failed",
      });
    }
    set.carrier.failChallenge = false;
    await expect(set.service.enrol(set.target, "source-a")).resolves.toHaveProperty("challengeId");
    set.carrier.failChallenge = true;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(set.service.enrol(set.target, "source-a")).rejects.toMatchObject({
        code: "carrier_failed",
      });
    }

    await expect(set.service.enrol(set.target, "source-a")).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(dispatch).toHaveBeenCalledTimes(7);
    await set.service.dispose();
  });

  it("keeps admitting new sources when the bounded counter map turns over", async () => {
    const set = setup("ios", {
      abuseLimits: { ...testAbuseLimits, maxTrackedSources: 2 },
    });

    await expect(set.service.enrol(set.target, "source-a")).resolves.toHaveProperty("challengeId");
    await expect(set.service.enrol(set.target, "source-b")).resolves.toHaveProperty("challengeId");
    await expect(set.service.enrol(set.target, "source-c")).resolves.toHaveProperty("challengeId");
    expect(set.carrier.challenges).toHaveLength(3);
    await set.service.dispose();
  });

  it("owns an unreferenced prune timer with the one-minute default", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const store = new RelayStore();
      const service = new RelayService({
        store,
        carriers: [new FakeCarrier("ios", new Set(["covered.ios"]))],
      });
      const timer = intervalSpy.mock.results.at(-1)?.value as ReturnType<typeof setInterval>;

      expect(intervalSpy).toHaveBeenLastCalledWith(expect.any(Function), RELAY_PRUNE_INTERVAL_MS);
      expect(timer.hasRef()).toBe(false);
      await service.dispose();
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it("challenges through the selected token, scopes the credential, and wakes it", async () => {
    const set = setup("ios");
    const { challengeId } = await set.service.enrol(set.target);
    expect(set.carrier.challenges).toHaveLength(1);
    expect(set.carrier.challenges[0]?.target).toEqual(set.target);
    expect(set.metrics.render(set.store.operationalSnapshot())).not.toContain(
      'relay_enrolments_total{platform="ios",outcome="accepted"}',
    );
    const credential = set.service.verify(challengeId, set.carrier.challenges[0]!.nonce).credential;
    expect(credential).toMatch(/^omnrelay_v1_[A-Za-z0-9_-]{43}$/);
    await set.service.wake(credential);
    expect(set.carrier.wakes).toEqual([set.target]);
    const metrics = set.metrics.render(set.store.operationalSnapshot());
    expect(metrics).toContain('relay_enrolments_total{platform="ios",outcome="accepted"} 1');
    expect(metrics).toContain('relay_wake_total{platform="ios",result="sent"} 1');
    expect(metrics).toContain(
      'relay_carrier_result_total{platform="ios",outcome="success",reason="none"} 2',
    );
    await set.service.dispose();
  });

  it("refuses an identity the carrier credential does not cover", async () => {
    const set = setup("android");
    await expect(
      set.service.enrol({ ...set.target, appId: "uncovered.android" }),
    ).rejects.toMatchObject({ code: "identity_not_covered" });
    expect(set.carrier.challenges).toEqual([]);
    expect(set.metrics.render(set.store.operationalSnapshot())).toContain(
      'relay_enrolments_total{platform="android",outcome="rejected"} 1',
    );
    await set.service.dispose();
  });

  it("refuses a platform with no configured carrier", async () => {
    const set = setup("ios");
    await expect(
      set.service.enrol({ platform: "android", token: "fcm-token", appId: "covered.android" }),
    ).rejects.toMatchObject({ code: "carrier_unavailable" });
    expect(set.metrics.render(set.store.operationalSnapshot())).toContain(
      'relay_enrolments_total{platform="android",outcome="rejected"} 1',
    );
    await set.service.dispose();
  });

  it("rejects a forged nonce and a replay of a successfully verified challenge", async () => {
    const set = setup("ios");
    const { challengeId } = await set.service.enrol(set.target);
    const nonce = set.carrier.challenges[0]!.nonce;
    expect(() => set.service.verify(challengeId, "forged-nonce")).toThrowError(
      expect.objectContaining({ code: "challenge_rejected" }),
    );
    expect(set.service.verify(challengeId, nonce).credential).toMatch(/^omnrelay_v1_/);
    expect(() => set.service.verify(challengeId, nonce)).toThrowError(
      expect.objectContaining({ code: "challenge_rejected" }),
    );
    const metrics = set.metrics.render(set.store.operationalSnapshot());
    expect(metrics).toContain('relay_enrolments_total{platform="ios",outcome="accepted"} 1');
    expect(metrics).toContain('relay_enrolments_total{platform="ios",outcome="rejected"} 2');
    expect(() => set.service.verify("unknown-challenge", nonce)).toThrowError(
      expect.objectContaining({ code: "challenge_rejected" }),
    );
    expect(set.metrics.render(set.store.operationalSnapshot())).toContain(
      'relay_enrolments_total{platform="ios",outcome="rejected"} 2',
    );
    await set.service.dispose();
  });

  it("deletes a challenge when its carrier dispatch fails", async () => {
    const set = setup("ios");
    set.carrier.failChallenge = true;
    await expect(set.service.enrol(set.target)).rejects.toMatchObject({ code: "carrier_failed" });
    const rows = set.store.db.prepare("SELECT COUNT(*) AS count FROM relay_challenges").get() as {
      count: number;
    };
    expect(rows.count).toBe(0);
    const metrics = set.metrics.render(set.store.operationalSnapshot());
    expect(metrics).toContain('relay_enrolments_total{platform="ios",outcome="failed"} 1');
    expect(metrics).not.toContain('relay_enrolments_total{platform="ios",outcome="accepted"}');
    await set.service.dispose();
  });

  it("prunes expired challenge state while starting a new enrolment", async () => {
    const set = setup("ios");
    set.store.createChallenge({
      id: "expired-challenge",
      target: set.target,
      nonceHash: Buffer.alloc(32),
      createdAt: 0,
      expiresAt: 1,
    });
    await set.service.enrol(set.target);
    const ids = set.store.db
      .prepare<[], { id: string }>("SELECT id FROM relay_challenges ORDER BY id")
      .all()
      .map((row) => row.id);
    expect(ids).toEqual(["00000000-0000-4000-8000-000000000001"]);
    await set.service.dispose();
  });

  it("periodically counts unanswered challenges without a request and only once", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      const set = setup("ios", { clock: { now: () => now }, pruneIntervalMs: 100 });
      set.store.createChallenge({
        id: "unanswered-challenge",
        target: set.target,
        nonceHash: Buffer.alloc(32),
        createdAt: now,
        expiresAt: now + 1,
      });
      now += 2;

      await vi.advanceTimersByTimeAsync(100);
      expect(set.metrics.render(set.store.operationalSnapshot())).toContain(
        'relay_enrol_challenge_unanswered_total{platform="ios"} 1',
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(set.metrics.render(set.store.operationalSnapshot())).toContain(
        'relay_enrol_challenge_unanswered_total{platform="ios"} 1',
      );

      await set.service.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RelayService credential enforcement", () => {
  it("meters bogus credentials by source without source-limiting a valid wake", async () => {
    const set = setup("ios", { abuseLimits: testAbuseLimits });
    const { challengeId } = await set.service.enrol(set.target, "source-a");
    const credential = set.service.verify(
      challengeId,
      set.carrier.challenges[0]!.nonce,
      "source-a",
    ).credential;
    await expect(set.service.wake("not-a-credential", "source-a")).rejects.toMatchObject({
      code: "credential_rejected",
    });
    await expect(set.service.wake("still-not-a-credential", "source-a")).rejects.toMatchObject({
      code: "rate_limited",
    });
    await expect(set.service.wake(credential, "source-a")).resolves.toBeUndefined();
    expect(set.carrier.wakes).toHaveLength(1);
    await set.service.dispose();
  });

  it("rejects malformed, forged, and revoked credentials", async () => {
    const set = setup("ios");
    const credential = await enrolAndVerify(set);
    await expect(set.service.wake("not-a-credential")).rejects.toMatchObject({
      code: "credential_rejected",
    });
    await expect(set.service.wake(`omnrelay_v1_${"z".repeat(43)}`)).rejects.toMatchObject({
      code: "credential_rejected",
    });
    const digest = (await import("./store.js")).digestSecret(credential);
    expect(set.store.revokeCredential(digest, 20_000)).toBe(true);
    await expect(set.service.wake(credential)).rejects.toMatchObject({
      code: "credential_rejected",
    });
    await set.service.dispose();
  });

  it("enforces the per-credential hourly limit before calling the carrier", async () => {
    const set = setup("ios");
    const credential = await enrolAndVerify(set);
    for (let i = 0; i < 30; i += 1) await set.service.wake(credential);
    await expect(set.service.wake(credential)).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 3_600_000,
    });
    expect(set.carrier.wakes).toHaveLength(30);
    await set.service.dispose();
  });

  it("reports carrier failures without leaking the credential", async () => {
    const set = setup("ios");
    const credential = await enrolAndVerify(set);
    set.carrier.failWake = true;
    await expect(set.service.wake(credential)).rejects.toEqual(
      expect.objectContaining<Partial<RelayServiceError>>({ code: "carrier_failed" }),
    );
    await set.service.dispose();
  });

  it("revokes and erases only the exact credential after a known stale rejection", async () => {
    const set = setup("ios");
    const credential = await enrolAndVerify(set);
    const credentialHash = (await import("./store.js")).digestSecret(credential);
    set.carrier.wakeError = new CarrierDispatchError("stale_credential", "unregistered");

    await expect(set.service.wake(credential)).rejects.toMatchObject({ code: "carrier_failed" });
    expect(set.store.lookupCredential(credentialHash)).toBeNull();
    const row = set.store.db
      .prepare(
        "SELECT token, app_id, environment, revoked_at FROM relay_credentials WHERE credential_hash = ?",
      )
      .get(credentialHash);
    expect(row).toEqual({ token: "", app_id: "", environment: null, revoked_at: 10_000 });
    const metrics = set.metrics.render(set.store.operationalSnapshot());
    expect(metrics).toContain(
      'relay_credentials_pruned_total{platform="ios",reason="unregistered"} 1',
    );
    await set.service.dispose();
  });

  it("preserves credentials after unknown carrier failures", async () => {
    const set = setup("android");
    const credential = await enrolAndVerify(set);
    const credentialHash = (await import("./store.js")).digestSecret(credential);
    set.carrier.wakeError = new CarrierDispatchError("other");

    await expect(set.service.wake(credential)).rejects.toMatchObject({ code: "carrier_failed" });
    expect(set.store.lookupCredential(credentialHash)).toEqual(set.target);
    expect(set.metrics.render(set.store.operationalSnapshot())).not.toContain(
      "relay_credentials_pruned_total{",
    );
    await set.service.dispose();
  });

  it("counts bounded credential mint failures for challenges and wakes", async () => {
    const set = setup("ios");
    set.carrier.challengeError = new CarrierDispatchError("credential_mint_failed");
    await expect(set.service.enrol(set.target)).rejects.toMatchObject({ code: "carrier_failed" });
    set.carrier.challengeError = null;
    const credential = await enrolAndVerify(set);
    set.carrier.wakeError = new CarrierDispatchError("credential_mint_failed");
    await expect(set.service.wake(credential)).rejects.toMatchObject({ code: "carrier_failed" });
    expect(set.metrics.render(set.store.operationalSnapshot())).toContain(
      'relay_credential_mint_failures_total{platform="ios"} 2',
    );
    await set.service.dispose();
  });
});

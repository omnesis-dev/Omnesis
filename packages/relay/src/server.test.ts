// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it } from "vitest";

import { createRelayApp } from "./server.js";
import { RelayMetrics } from "./metrics.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";
import type {
  CarrierHealth,
  RandomSource,
  RelayCarrier,
  RelayPlatform,
  RelayTarget,
} from "./types.js";

class HttpFakeCarrier implements RelayCarrier {
  challenges: Array<{ target: RelayTarget; nonce: string }> = [];
  wakes: RelayTarget[] = [];

  constructor(
    readonly platform: RelayPlatform,
    private readonly covered: string,
    private readonly healthStatus: CarrierHealth["status"] = "reachable",
  ) {}

  covers(appId: string): boolean {
    return appId === this.covered;
  }

  sendChallenge(target: RelayTarget, nonce: string): Promise<void> {
    this.challenges.push({ target, nonce });
    return Promise.resolve();
  }

  sendWake(target: RelayTarget): Promise<void> {
    this.wakes.push(target);
    return Promise.resolve();
  }

  health(): CarrierHealth {
    return {
      configured: true,
      status: this.healthStatus,
      lastSuccessAt: this.healthStatus === "reachable" ? 100 : null,
      lastFailureAt: this.healthStatus === "unreachable" ? 100 : null,
    };
  }

  async dispose(): Promise<void> {}
}

const services: RelayService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});

function harness(
  health: { ios?: CarrierHealth["status"]; android?: CarrierHealth["status"] } = {},
) {
  let byte = 1;
  const random: RandomSource = {
    uuid: () => "00000000-0000-4000-8000-000000000001",
    bytes: (length) => Buffer.alloc(length, byte++),
  };
  const ios = new HttpFakeCarrier("ios", "dev.omnesis.ios", health.ios);
  const android = new HttpFakeCarrier("android", "dev.omnesis.android", health.android);
  const store = new RelayStore();
  const metrics = new RelayMetrics();
  const service = new RelayService({
    store,
    carriers: [ios, android],
    clock: { now: () => 1_000 },
    random,
    metrics,
  });
  services.push(service);
  return { app: trustedProxyTestApp(service), ios, android, metrics, store, service };
}

function trustedProxyTestApp(service: RelayService) {
  const app = createRelayApp(service);
  return {
    request(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      headers.set("cf-connecting-ip", "192.0.2.1");
      return Promise.resolve(app.request(path, { ...init, headers }));
    },
  };
}

async function credentialForIos(set: ReturnType<typeof harness>): Promise<string> {
  const enrol = await set.app.request("/v1/enrol", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "ios",
      token: "ab".repeat(32),
      bundleId: "dev.omnesis.ios",
      environment: "production",
    }),
  });
  expect(enrol.status).toBe(202);
  const { challengeId } = (await enrol.json()) as { challengeId: string };
  const verify = await set.app.request("/v1/enrol/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId, nonce: set.ios.challenges[0]!.nonce }),
  });
  expect(verify.status).toBe(200);
  return ((await verify.json()) as { credential: string }).credential;
}

describe("relay HTTP protocol", () => {
  it("requires one valid Cloudflare source on production APIs but not local health", async () => {
    const set = harness();
    const strict = createRelayApp(set.service);
    expect((await strict.request("/health")).status).toBe(200);
    expect((await strict.request("/v1/wake", { method: "POST" })).status).toBe(400);
    for (const invalid of ["", " ", "not-an-ip", "192.0.2.1, 198.51.100.1"]) {
      expect(
        (
          await strict.request("/v1/wake", {
            method: "POST",
            headers: { "cf-connecting-ip": invalid },
          })
        ).status,
      ).toBe(400);
    }
    for (const source of ["192.0.2.1", "2001:db8::1"]) {
      expect(
        (
          await strict.request("/v1/wake", {
            method: "POST",
            headers: { "cf-connecting-ip": source },
          })
        ).status,
      ).toBe(401);
    }
    expect(set.metrics.render(set.store.operationalSnapshot())).toContain(
      'relay_abuse_rejections_total{endpoint="wake",reason="missing_source"} 5',
    );
  });

  it("does not expose the separate metrics surface", async () => {
    expect((await harness().app.request("/metrics")).status).toBe(404);
  });

  it("counts missing and malformed wake credentials as bounded rejections", async () => {
    const set = harness();
    expect((await set.app.request("/v1/wake", { method: "POST" })).status).toBe(401);
    expect(
      (
        await set.app.request("/v1/wake", {
          method: "POST",
          headers: { authorization: "Basic fictional" },
        })
      ).status,
    ).toBe(401);

    expect(set.metrics.render(set.store.operationalSnapshot())).toContain(
      'relay_wake_rejected_total{reason="unknown_credential"} 2',
    );
  });

  it("reports both carrier states and accepted protocol versions", async () => {
    const set = harness();
    const response = await set.app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      status: "ready",
      protocols: { enrolment: [1], wake: [1] },
      carriers: {
        ios: {
          configured: true,
          status: "reachable",
          lastSuccessAt: 100,
          lastFailureAt: null,
        },
        android: {
          configured: true,
          status: "reachable",
          lastSuccessAt: 100,
          lastFailureAt: null,
        },
      },
    });
  });

  it("distinguishes unproven from failed carrier readiness", async () => {
    const unknown = await harness({ ios: "unknown" }).app.request("/health");
    expect(unknown.status).toBe(503);
    expect(await unknown.json()).toMatchObject({ ok: false, status: "unknown" });

    const degraded = await harness({ android: "unreachable" }).app.request("/health");
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toMatchObject({ ok: false, status: "degraded" });
  });

  it("drives enrol, echo, and an authenticated empty wake end to end", async () => {
    const set = harness();
    const credential = await credentialForIos(set);
    const wake = await set.app.request("/v1/wake", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(wake.status).toBe(202);
    expect(await wake.text()).toBe("");
    expect(set.ios.wakes).toEqual([
      {
        platform: "ios",
        token: "ab".repeat(32),
        appId: "dev.omnesis.ios",
        environment: "production",
      },
    ]);
  });

  it("accepts Android's shared core enrolment shape", async () => {
    const set = harness();
    const response = await set.app.request("/v1/enrol", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "android",
        token: "fictional-fcm-registration-token",
        appId: "dev.omnesis.android",
      }),
    });
    expect(response.status).toBe(202);
    expect(set.android.challenges[0]?.target).toEqual({
      platform: "android",
      token: "fictional-fcm-registration-token",
      appId: "dev.omnesis.android",
    });
  });

  it("rejects request bodies above the fixed boundary limit", async () => {
    const set = harness();
    const response = await set.app.request("/v1/enrol", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(17 * 1024) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      message: "request body is too large",
    });
  });

  it("refuses uncovered identities before sending a challenge", async () => {
    const set = harness();
    const response = await set.app.request("/v1/enrol", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "android",
        token: "fictional-fcm-registration-token",
        appId: "org.example.uncovered",
      }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "identity_not_covered" });
    expect(set.android.challenges).toEqual([]);
  });

  it("rejects malformed requests, replayed challenges, forged credentials, and wake content", async () => {
    const set = harness();
    const malformed = await set.app.request("/v1/enrol", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "ios", token: "short", title: "private" }),
    });
    expect(malformed.status).toBe(400);

    const credential = await credentialForIos(set);
    const replay = await set.app.request("/v1/enrol/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: "00000000-0000-4000-8000-000000000001",
        nonce: set.ios.challenges[0]!.nonce,
      }),
    });
    expect(replay.status).toBe(401);

    const forged = await set.app.request("/v1/wake", {
      method: "POST",
      headers: { authorization: `Bearer omnrelay_v1_${"z".repeat(43)}` },
    });
    expect(forged.status).toBe(401);

    const withContent = await set.app.request("/v1/wake", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "private", body: "must not cross" }),
    });
    expect(withContent.status).toBe(400);
    expect(set.ios.wakes).toEqual([]);
  });

  it("returns 429 with a retry-after after 30 wakes for one credential", async () => {
    const set = harness();
    const credential = await credentialForIos(set);
    for (let i = 0; i < 30; i += 1) {
      expect(
        (
          await set.app.request("/v1/wake", {
            method: "POST",
            headers: { authorization: `Bearer ${credential}` },
          })
        ).status,
      ).toBe(202);
    }
    const limited = await set.app.request("/v1/wake", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    expect(set.ios.wakes).toHaveLength(30);
  });
});

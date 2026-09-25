// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { PushClient, clearPushHealth } from "./client.js";
import { buildWebPageDocument } from "./documents.js";
import { MemoryStore, FakeFetch, jsonResponse, type RecordedRequest } from "./test-fakes.js";

const T0 = 1_700_000_000_000;

function makeClient(now: () => number, fetch: FakeFetch, store: MemoryStore): PushClient {
  return new PushClient({
    gatewayUrl: "https://gateway.example.com:7600",
    token: "tok",
    fetch: fetch.fetch,
    store,
    now,
  });
}

describe("push liveness probe — probeAuth", () => {
  it("2xx: reports auth ok, marks reachable, and stamps the beacon without claiming a page synced", async () => {
    const store = new MemoryStore();
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 0, deleted: 0 }));
    const client = makeClient(() => T0, fetch, store);

    const result = await client.probeAuth();

    expect(result).toEqual({ reachable: true, auth: "ok" });
    expect(await client.getHealth()).toBeNull();
    expect(await client.getConnectivity()).toMatchObject({ reachable: true, at: T0 });
    expect(await client.getLastCheckedAt()).toBe(T0);

    // The probe posts an EMPTY batch to /documents with the bearer token — it
    // traverses the real auth path but writes nothing.
    const req = fetch.requests.at(-1) as RecordedRequest;
    expect(req.url).toBe("https://gateway.example.com:7600/documents");
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe("Bearer tok");
    expect(req.body).toEqual({ documents: [] });
  });

  it.each([
    jsonResponse(200, { ingested: 1 }),
    { status: 200, headers: { get: () => null }, text: async () => "<html>login</html>" },
  ])("does not stamp checked for an invalid 2xx liveness body", async (response) => {
    const store = new MemoryStore();
    const client = makeClient(() => T0, new FakeFetch(() => response), store);
    expect(await client.probeAuth()).toMatchObject({
      reachable: true,
      auth: "unknown",
      reason: "Invalid gateway liveness response",
    });
    expect(await client.getLastCheckedAt()).toBeNull();
    expect(await client.getConnectivity()).toMatchObject({ reachable: true, degraded: true });
  });

  it("401: reports auth failed and surfaces the gateway's reason as a health error", async () => {
    const store = new MemoryStore();
    const fetch = new FakeFetch(() => jsonResponse(401, { error: "Unknown or revoked token" }));
    const client = makeClient(() => T0, fetch, store);

    const result = await client.probeAuth();

    expect(result).toEqual({
      reachable: true,
      auth: "failed",
      reason: "Unknown or revoked token",
    });
    // Written to the SAME snapshot a rejected-document drain uses, so the badge
    // + popup light up without any extra wiring.
    expect(await client.getHealth()).toMatchObject({
      ok: false,
      reason: "Unknown or revoked token",
    });
    // The gateway answered, so it's reachable (the fault is the token, not the network).
    expect(await client.getConnectivity()).toMatchObject({ reachable: true });
  });

  it("403: reports auth failed (revoked/unscoped token)", async () => {
    const store = new MemoryStore();
    const fetch = new FakeFetch(() => jsonResponse(403, { error: "forbidden" }));
    const client = makeClient(() => T0, fetch, store);

    const result = await client.probeAuth();

    expect(result.auth).toBe("failed");
    expect(await client.getHealth()).toMatchObject({ ok: false });
  });

  it("network failure: reports unknown auth + offline, and leaves health untouched", async () => {
    const store = new MemoryStore();
    // A completed probe must not create a false page-delivery health snapshot.
    const okFetch = new FakeFetch(() => jsonResponse(200, { ingested: 0, deleted: 0 }));
    let now = T0;
    const client = makeClient(() => now, okFetch, store);
    await client.probeAuth();
    expect(await client.getHealth()).toBeNull();

    now = T0 + 1000;
    okFetch.setScript(() => "network-error");
    const result = await client.probeAuth();

    expect(result).toMatchObject({ reachable: false, auth: "unknown" });
    // Health stays as it was — a network fault is not an auth verdict.
    expect(await client.getHealth()).toBeNull();
    expect(await client.getConnectivity()).toMatchObject({ reachable: false });
    // A failed-to-connect probe doesn't count as a completed check, so the
    // beacon stays at the last successful probe — recovery is detected promptly.
    expect(await client.getLastCheckedAt()).toBe(T0);
  });

  it("does not let an older slow probe overwrite a newer delivery in the same millisecond", async () => {
    const store = new MemoryStore();
    let rejectProbe: ((reason: Error) => void) | undefined;
    const oldClient = new PushClient({
      gatewayUrl: "https://gateway.example.com:7600",
      token: "tok",
      fetch: () =>
        new Promise((_resolve, reject) => {
          rejectProbe = reject;
        }),
      store,
      now: () => T0,
      observationSessionId: "worker-a",
      observationGeneration: 1,
    });
    const probe = oldClient.probeAuth();
    await Promise.resolve();

    const newClient = new PushClient({
      gatewayUrl: "https://gateway.example.com:7600",
      token: "tok",
      fetch: new FakeFetch(() => jsonResponse(200, { ingested: 1 })).fetch,
      store,
      now: () => T0,
      observationSessionId: "worker-a",
      observationGeneration: 2,
    });
    await newClient.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: "https://fictional.example.com/page",
        title: "Fictional page",
        text: "Fictional body",
        contentHash: "hash",
        visitedAt: new Date(T0).toISOString(),
      }),
    );
    await newClient.drain();
    rejectProbe?.(new Error("old probe failed"));
    await probe;
    expect(await newClient.getConnectivity()).toMatchObject({ reachable: true, at: T0 });
  });

  it("accepts a newer observation after an MV3 worker restart resets its generation", async () => {
    const store = new MemoryStore();
    const oldClient = new PushClient({
      gatewayUrl: "https://gateway.example.com:7600",
      token: "tok",
      fetch: new FakeFetch(() => "network-error").fetch,
      store,
      now: () => T0,
      observationSessionId: "old-worker",
      observationGeneration: 20,
    });
    await oldClient.probeAuth();
    expect(await oldClient.getConnectivity()).toMatchObject({ reachable: false, at: T0 });

    const restartedClient = new PushClient({
      gatewayUrl: "https://gateway.example.com:7600",
      token: "tok",
      fetch: new FakeFetch(() => jsonResponse(200, { ingested: 0, deleted: 0 })).fetch,
      store,
      now: () => T0,
      observationSessionId: "new-worker",
      observationGeneration: 1,
    });
    await restartedClient.probeAuth();

    expect(await restartedClient.getConnectivity()).toMatchObject({ reachable: true, at: T0 });
    expect(await restartedClient.getLastCheckedAt()).toBe(T0);
  });

  it("503: records an inconclusive check without advancing the verified beacon", async () => {
    const store = new MemoryStore();
    let now = T0;
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 0, deleted: 0 }));
    const client = makeClient(() => now, fetch, store);
    await client.probeAuth();
    now += 1_000;
    fetch.setScript(() => jsonResponse(503, { error: "temporarily unavailable" }));
    expect(await client.probeAuth()).toMatchObject({ auth: "unknown", reason: "HTTP 503" });
    expect(await client.getLastCheckedAt()).toBe(T0);
    expect(await client.getConnectivity()).toMatchObject({
      reachable: true,
      degraded: true,
      reason: "HTTP 503",
    });
  });

  it("a healthy empty probe does not clear a prior page-upload auth alarm", async () => {
    const store = new MemoryStore();
    const fetch = new FakeFetch(() => jsonResponse(403, { error: "forbidden" }));
    let now = T0;
    const client = makeClient(() => now, fetch, store);

    await client.probeAuth();
    expect(await client.getHealth()).toMatchObject({ ok: false });

    // An empty probe is not proof a page can upload, so it must not hide the alarm.
    now = T0 + 5000;
    fetch.setScript(() => jsonResponse(200, { ingested: 0, deleted: 0 }));
    await client.probeAuth();
    expect(await client.getHealth()).toMatchObject({ ok: false });
  });
});

describe("clearPushHealth — reset on re-pair", () => {
  it("clears a stale auth error so it can't survive a re-pair", async () => {
    const store = new MemoryStore();
    const fetch = new FakeFetch(() =>
      jsonResponse(403, { error: "Forbidden: write:web scope required" }),
    );
    const client = makeClient(() => T0, fetch, store);

    // The previous token was rejected — health is unhealthy and a beacon is set.
    await client.probeAuth();
    expect(await client.getHealth()).toMatchObject({ ok: false });
    expect(await client.getConnectivity()).not.toBeNull();
    expect(await client.getLastCheckedAt()).not.toBeNull();

    // Re-pairing resets the health state, so the popup/badge don't keep showing
    // the warning the new token just resolved.
    await clearPushHealth(store);
    expect(await client.getHealth()).toBeNull();
    expect(await client.getConnectivity()).toBeNull();
    expect(await client.getLastCheckedAt()).toBeNull();
  });
});

describe("push liveness probe — probeAuthIfStale", () => {
  it("skips (no request) when the last check is fresher than maxAge", async () => {
    const store = new MemoryStore();
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 0, deleted: 0 }));
    let now = T0;
    const client = makeClient(() => now, fetch, store);

    await client.probeAuth(); // stamps checked at T0
    const requestsAfterFirst = fetch.requests.length;

    now = T0 + 60_000; // 1 min later, well within a 15-min window
    const skipped = await client.probeAuthIfStale(15 * 60 * 1000);

    expect(skipped).toBeNull();
    expect(fetch.requests.length).toBe(requestsAfterFirst); // no new probe
  });

  it("runs when the last check is older than maxAge (and when never checked)", async () => {
    const store = new MemoryStore();
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 0, deleted: 0 }));
    let now = T0;
    const client = makeClient(() => now, fetch, store);

    // Never checked → runs.
    const first = await client.probeAuthIfStale(15 * 60 * 1000);
    expect(first).toMatchObject({ auth: "ok" });

    // Advance past the window → runs again.
    now = T0 + 16 * 60 * 1000;
    const second = await client.probeAuthIfStale(15 * 60 * 1000);
    expect(second).toMatchObject({ auth: "ok" });
    expect(await client.getLastCheckedAt()).toBe(now);
  });
});

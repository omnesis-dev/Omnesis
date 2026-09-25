// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { hashText } from "../capture/content-hash.js";
import { PushClient, clearPushHealth, clearPushQueue, parseRetryAfter } from "./client.js";
import { buildPageVisit, buildWebPageDocument } from "./documents.js";
import { FakeFetch, MemoryStore, jsonResponse } from "./test-fakes.js";
import type { RecordedRequest } from "./test-fakes.js";

const GATEWAY = "https://gateway.example.ts.net:7600";
const TOKEN = "tok_write_web_fake";

function doc(url: string, hash = "h1") {
  return buildWebPageDocument({
    normalizedUrl: url,
    title: "Example page",
    text: `text for ${url}`,
    contentHash: hash,
    visitedAt: "2026-01-01T00:00:00.000Z",
  });
}

function visit(url: string, at = "2026-01-01T00:00:00.000Z") {
  return buildPageVisit({
    normalizedUrl: url,
    title: "Example page",
    visitedAt: at,
    dwellMs: 6000,
  });
}

/** A controllable clock so backoff math is deterministic and tests never sleep. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("PushClient — happy path", () => {
  it.each([
    `${GATEWAY}/`,
    `${GATEWAY}/portal`,
    "https://user:password@gateway.example.com:7600",
    "https://203.0.113.7:7600",
  ])("rejects a non-canonical gateway before transport can use its token: %s", (gatewayUrl) => {
    expect(
      () =>
        new PushClient({
          gatewayUrl,
          token: TOKEN,
          fetch: new FakeFetch(() => jsonResponse(200, { ingested: 0 })).fetch,
          store: new MemoryStore(),
        }),
    ).toThrow();
  });

  it("drains a queued document and visit to the right endpoints with the bearer token", async () => {
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 }));
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
    });

    await client.enqueueDocument(await doc("https://example.com/a"));
    await client.enqueueVisit(visit("https://example.com/a"));
    expect(await client.queueDepth()).toBe(2);

    const result = await client.drain();
    expect(result.delivered).toBe(2);
    expect(result.retained).toBe(0);
    expect(await client.queueDepth()).toBe(0);

    const docReq = fetch.requests.find((r) => r.url.endsWith("/documents"));
    const visitReq = fetch.requests.find((r) => r.url.endsWith("/analytics/ingest"));
    expect(docReq).toBeDefined();
    expect(visitReq).toBeDefined();
    expect(docReq?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(docReq?.redirect).toBe("error");
    expect((docReq?.body as { documents: unknown[] }).documents).toHaveLength(1);
    expect((visitReq?.body as { tableName: string }).tableName).toBe("page_visits");
    expect((visitReq?.body as { sourceId: string }).sourceId).toBe("web");
  });
});

describe("PushClient — bounded batches", () => {
  it("retains ready items beyond the batch cap for the next drain", async () => {
    const store = new MemoryStore();
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 }));
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store,
      batchSize: 2,
    });

    await client.enqueueDocument(await doc("https://example.com/a"));
    await client.enqueueDocument(await doc("https://example.com/b"));
    await client.enqueueDocument(await doc("https://example.com/c"));

    const first = await client.drain();
    expect(first.delivered).toBe(2);
    expect(first.retained).toBe(1);
    expect(await client.queueDepth()).toBe(1);

    const second = await client.drain();
    expect(second.delivered).toBe(1);
    expect(await client.queueDepth()).toBe(0);
  });
});

describe("PushClient — outage compaction", () => {
  it("keeps only the newest queued document body for the same page", async () => {
    const store = new MemoryStore();
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: new FakeFetch(() => "network-error").fetch,
      store,
    });
    await client.enqueueDocument(await doc("https://example.com/article", "old-hash"));
    await client.enqueueDocument(await doc("https://example.com/article", "new-hash"));
    expect(await client.queueDepth()).toBe(1);
  });
});

describe("PushClient — persistence across a simulated SW restart", () => {
  it("a new client over the same store drains the queue left by the old one", async () => {
    const store = new MemoryStore();
    // Gateway is down while the first client generation enqueues.
    const downFetch = new FakeFetch(() => "network-error");
    const gen1 = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: downFetch.fetch,
      store,
      now: () => 0,
    });
    await gen1.enqueueDocument(await doc("https://example.com/a"));
    await gen1.drain(); // fails, item retained
    expect(await gen1.queueDepth()).toBe(1);

    // Service worker evicted; a fresh client is constructed against the SAME
    // store. The queued item must still be there and drain when the gateway is up.
    const upFetch = new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 }));
    const gen2 = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: upFetch.fetch,
      store,
      now: () => 10_000,
    });
    expect(await gen2.queueDepth()).toBe(1);
    const result = await gen2.drain();
    expect(result.delivered).toBe(1);
    expect(await gen2.queueDepth()).toBe(0);
  });
});

describe("PushClient — pairing transitions", () => {
  it("can clear captures so they never cross into a different gateway pairing", async () => {
    const store = new MemoryStore();
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: new FakeFetch(() => "network-error").fetch,
      store,
    });
    await client.enqueueDocument(await doc("https://example.com/private-draft"));
    await clearPushQueue(store);
    expect(
      await new PushClient({
        gatewayUrl: "https://other-gateway.example.com",
        token: "other-token",
        fetch: new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 })).fetch,
        store,
      }).queueDepth(),
    ).toBe(0);
  });
});

describe("PushClient — 429 with Retry-After", () => {
  it("waits the Retry-After interval, then succeeds", async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetch = new FakeFetch(() => {
      calls += 1;
      return calls === 1
        ? jsonResponse(429, { error: "slow down" }, { "Retry-After": "30" })
        : jsonResponse(200, { ingested: 1, deleted: 0 });
    });
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
      now: clock.now,
    });

    await client.enqueueDocument(await doc("https://example.com/a"));

    // First drain: 429 → item retained, eligible 30s later.
    const r1 = await client.drain();
    expect(r1.delivered).toBe(0);
    expect(r1.retained).toBe(1);
    expect(r1.nextEligibleAt).toBe(30_000);
    expect(await client.getRetry()).toMatchObject({ status: 429, reason: "slow down" });

    // Before the window elapses, the item is not retried.
    clock.advance(10_000);
    const r2 = await client.drain();
    expect(r2.delivered).toBe(0);
    expect(fetch.requests).toHaveLength(1); // no second HTTP call yet

    // After Retry-After elapses, it succeeds.
    clock.advance(25_000); // now at 35s ≥ 30s
    const r3 = await client.drain();
    expect(r3.delivered).toBe(1);
    expect(await client.queueDepth()).toBe(0);
    expect(await client.getRetry()).toBeNull();
  });
});

describe("PushClient — recoverable request statuses", () => {
  it.each([408, 409, 425])("retains HTTP %s responses for retry", async (status) => {
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: new FakeFetch(() => jsonResponse(status, {})).fetch,
      store: new MemoryStore(),
      now: () => 0,
    });
    await client.enqueueDocument(await doc(`https://example.com/status-${status}`));
    const result = await client.drain();
    expect(result).toMatchObject({ delivered: 0, retained: 1, dropped: 0 });
  });
});

describe("PushClient — 503 exponential backoff", () => {
  it("backs off with growing delays, eventually succeeding", async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetch = new FakeFetch(() => {
      calls += 1;
      return calls <= 3
        ? jsonResponse(503, { error: "unavailable" })
        : jsonResponse(200, { ingested: 1, deleted: 0 });
    });
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
      now: clock.now,
      backoff: { baseMs: 1000, factor: 2, maxMs: 60_000, maxAttempts: 12 },
    });
    await client.enqueueDocument(await doc("https://example.com/a"));

    // attempt 1 → 503, next at base*2^0 = 1000ms
    let r = await client.drain();
    expect(r.nextEligibleAt).toBe(1000);

    // attempt 2 → 503, next at base*2^1 = 2000ms after now (1000) = 3000ms
    clock.advance(1000);
    r = await client.drain();
    expect(r.nextEligibleAt).toBe(3000);

    // attempt 3 → 503, next at base*2^2 = 4000ms after now (3000) = 7000ms
    clock.advance(2000);
    r = await client.drain();
    expect(r.nextEligibleAt).toBe(7000);

    // attempt 4 → 200
    clock.advance(4000);
    r = await client.drain();
    expect(r.delivered).toBe(1);
    expect(await client.queueDepth()).toBe(0);
  });
});

describe("PushClient — no data loss across gateway downtime", () => {
  it("delivers every item exactly once after a 5xx outage recovers", async () => {
    const clock = fakeClock();
    const store = new MemoryStore();
    let healthy = false;
    const delivered: RecordedRequest[] = [];
    const fetch = new FakeFetch((req) => {
      if (!healthy) return jsonResponse(503, { error: "down" });
      delivered.push(req);
      return jsonResponse(200, { ingested: 1, deleted: 0 });
    });
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store,
      now: clock.now,
      backoff: { baseMs: 1000, factor: 2, maxMs: 10_000, maxAttempts: 12 },
    });

    const urls = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];
    for (const u of urls) await client.enqueueDocument(await doc(u));

    // Drain repeatedly while the gateway is down — nothing is lost, all retained.
    for (let i = 0; i < 5; i++) {
      await client.drain();
      clock.advance(20_000); // jump past any backoff window
    }
    expect(await client.queueDepth()).toBe(3);
    expect(delivered).toHaveLength(0);

    // Gateway recovers; one drain delivers everything exactly once.
    healthy = true;
    const r = await client.drain();
    expect(r.delivered).toBe(3);
    expect(await client.queueDepth()).toBe(0);

    const deliveredIds = delivered
      .map((req) => (req.body as { documents: { externalId: string }[] }).documents[0].externalId)
      .sort();
    // externalId is SHA256(normalizedUrl) (#895), so derive the expected ids
    // the same way the builder does rather than comparing raw URL strings.
    const expectedIds = (await Promise.all(urls.map((u) => hashText(u)))).sort();
    expect(deliveredIds).toEqual(expectedIds);
  });
});

describe("PushClient — non-retryable client errors are dropped, not wedged", () => {
  it("drops a 400 and persists an operator-visible failure", async () => {
    const fetch = new FakeFetch(() => jsonResponse(400, { error: "bad request" }));
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
    });
    await client.enqueueDocument(await doc("https://example.com/a"));
    const r = await client.drain();
    expect(r.dropped).toBe(1);
    expect(r.delivered).toBe(0);
    expect(await client.queueDepth()).toBe(0);
    expect(await client.getFailure()).toMatchObject({ status: 400, reason: "bad request" });
  });

  it("counts every discarded item in one bounded drain pass", async () => {
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: new FakeFetch(() => jsonResponse(422, { error: "invalid payload" })).fetch,
      store: new MemoryStore(),
    });
    await client.enqueueDocument(await doc("https://example.com/a"));
    await client.enqueueDocument(await doc("https://example.com/b"));
    expect((await client.drain()).dropped).toBe(2);
    expect(await client.getFailure()).toMatchObject({ count: 2, status: 422 });
  });

  it("does not erase permanent data-loss diagnostics when a token is refreshed", async () => {
    const store = new MemoryStore();
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: new FakeFetch(() => jsonResponse(400, { error: "invalid payload" })).fetch,
      store,
    });
    await client.enqueueDocument(await doc("https://example.com/invalid"));
    await client.drain();
    await clearPushHealth(store);
    expect(await client.getFailure()).toMatchObject({ count: 1, status: 400 });
  });

  it("retains a 401/403 so re-pairing can deliver the original capture", async () => {
    const fetch = new FakeFetch(() => jsonResponse(403, { error: "forbidden" }));
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
    });
    await client.enqueueDocument(await doc("https://example.com/a"));
    const r = await client.drain();
    expect(r.dropped).toBe(0);
    expect(r.retained).toBe(1);
    expect(await client.queueDepth()).toBe(1);
  });
});

describe("PushClient — prolonged transient outage", () => {
  it("keeps retrying at the capped backoff instead of discarding the page", async () => {
    const clock = fakeClock();
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: new FakeFetch(() => jsonResponse(503, { error: "down" })).fetch,
      store: new MemoryStore(),
      now: clock.now,
      backoff: { baseMs: 1, factor: 2, maxMs: 4, maxAttempts: 2 },
    });
    await client.enqueueDocument(await doc("https://example.com/a"));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await client.drain();
      clock.advance(10);
    }

    expect(await client.queueDepth()).toBe(1);
    expect(await client.getRetry()).toMatchObject({ status: 503, reason: "down" });
  });

  it("times out a hung request and retains the capture", async () => {
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: () => new Promise(() => undefined),
      store: new MemoryStore(),
      requestTimeoutMs: 5,
    });
    await client.enqueueDocument(await doc("https://example.com/timeout"));
    const result = await client.drain();
    expect(result.retained).toBe(1);
    expect(await client.queueDepth()).toBe(1);
    expect(await client.getConnectivity()).toMatchObject({ reachable: false });
  });

  it("also bounds a response body that stalls after headers", async () => {
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: async () => ({
        status: 200,
        headers: { get: () => null },
        text: () => new Promise(() => undefined),
      }),
      store: new MemoryStore(),
      requestTimeoutMs: 5,
    });
    await client.enqueueDocument(await doc("https://example.com/stalled-body"));
    const result = await client.drain();
    expect(result).toMatchObject({ delivered: 0, retained: 1 });
    expect(await client.getConnectivity()).toMatchObject({ reachable: false });
  });
});

describe("PushClient — fail-loud on auth/scope rejection", () => {
  it("defers every ready item after one shared rejection with a one-item batch", async () => {
    const clock = fakeClock(1_000);
    const store = new MemoryStore();
    const fetch = new FakeFetch(() => jsonResponse(403, { error: "forbidden" }));
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store,
      now: clock.now,
      batchSize: 1,
    });
    for (const suffix of ["a", "b", "c"]) {
      await client.enqueueDocument(await doc(`https://example.com/${suffix}`));
    }
    const result = await client.drain();
    expect(fetch.requests).toHaveLength(1);
    expect(result.nextEligibleAt).toBe(1_000 + 5 * 60 * 1_000);
    const queued = JSON.parse(String(store.snapshot().get("omnesis.push.queue.v1"))) as Array<{
      notBefore: number;
    }>;
    expect(queued.map((item) => item.notBefore)).toEqual([301_000, 301_000, 301_000]);
  });

  it("stops after one shared-token rejection and retains the whole batch", async () => {
    const fetch = new FakeFetch(() => jsonResponse(403, { error: "forbidden" }));
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
    });
    for (const suffix of ["a", "b", "c"]) {
      await client.enqueueDocument(await doc(`https://example.com/${suffix}`));
    }
    const result = await client.drain();
    expect(fetch.requests).toHaveLength(1);
    expect(result.retained).toBe(3);
    expect(await client.queueDepth()).toBe(3);
  });

  it("records an unhealthy snapshot carrying the gateway's reason when a document is 403'd", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(403, { error: "Forbidden: write:web scope required" }),
    );
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
    });
    await client.enqueueDocument(await doc("https://example.com/a"));
    await client.drain();

    const health = await client.getHealth();
    expect(health?.ok).toBe(false);
    expect(health?.reason).toBe("Forbidden: write:web scope required");
  });

  it("clears the unhealthy snapshot once a document delivers successfully again", async () => {
    let forbidden = true;
    const fetch = new FakeFetch(() =>
      forbidden
        ? jsonResponse(403, { error: "forbidden" })
        : jsonResponse(200, { ingested: 1, deleted: 0 }),
    );
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
    });

    await client.enqueueDocument(await doc("https://example.com/a"));
    await client.drain();
    expect((await client.getHealth())?.ok).toBe(false);

    // Re-paired: pushes now carry a write:web token and succeed.
    forbidden = false;
    await client.enqueueDocument(await doc("https://example.com/b"));
    await client.drain();
    expect((await client.getHealth())?.ok).toBe(true);
  });

  it("flags unhealthy even when only the visit plane is 403'd (no document delivered)", async () => {
    const fetch = new FakeFetch(() => jsonResponse(403, { error: "forbidden" }));
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
    });
    await client.enqueueVisit(visit("https://example.com/a"));
    await client.drain();
    expect((await client.getHealth())?.ok).toBe(false);
  });

  it("leaves health untouched (null) when a drain delivers only visits successfully", async () => {
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 }));
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
    });
    await client.enqueueVisit(visit("https://example.com/a"));
    await client.drain();
    expect(await client.getHealth()).toBeNull();
  });
});

describe("PushClient — success response validation", () => {
  it.each([
    {
      label: "HTML",
      response: {
        status: 200,
        headers: { get: () => null },
        text: async () => "<html>login</html>",
      },
    },
    { label: "malformed JSON contract", response: jsonResponse(200, { ok: true }) },
  ])("retains an upload after a $label 2xx response", async ({ response }) => {
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: new FakeFetch(() => response).fetch,
      store: new MemoryStore(),
    });
    await client.enqueueDocument(await doc("https://example.com/retained"));
    const result = await client.drain();
    expect(result).toMatchObject({ delivered: 0, retained: 1 });
    expect(await client.getRetry()).toMatchObject({ reason: "Invalid gateway success response" });
  });
});

describe("PushClient — queued page compaction", () => {
  it("keeps the newest title when one page changes before delivery", async () => {
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 }));
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
      now: () => 0,
    });
    const shared = {
      normalizedUrl: "https://example.com/dashboard",
      text: "identical body text",
      contentHash: "h1",
      visitedAt: "2026-01-01T00:00:00.000Z",
    };
    await client.enqueueDocument(await buildWebPageDocument({ ...shared, title: "Old title" }));
    await client.enqueueDocument(await buildWebPageDocument({ ...shared, title: "Updated title" }));
    expect(await client.queueDepth()).toBe(1);
    await client.drain();
    const body = fetch.requests[0].body as { documents: Array<{ title?: string }> };
    expect(body.documents[0].title).toBe("Updated title");
  });
});

describe("PushClient — server-side removed/paused state (200 + rejected)", () => {
  function removedResponse() {
    return jsonResponse(200, {
      ingested: 0,
      rejected: [{ sourceId: "web", reason: "removed" }],
    });
  }

  it("a 200 with a 'removed' rejection records server-state and retains the item as a probe", async () => {
    const clock = fakeClock();
    const fetch = new FakeFetch(() => removedResponse());
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
      now: clock.now,
    });
    await client.enqueueDocument(await doc("https://example.com/a"));

    const result = await client.drain();
    // Not delivered, not poison-dropped — retained as a probe.
    expect(result.delivered).toBe(0);
    expect(result.dropped).toBe(0);
    expect(result.retained).toBe(1);
    expect(await client.queueDepth()).toBe(1);

    const state = await client.getServerState();
    expect(state?.state).toBe("removed");
    expect(state?.reason).toBe("removed");
  });

  it("maps a 'paused' rejection to the paused state", async () => {
    const fetch = new FakeFetch(() =>
      jsonResponse(200, { ingested: 0, rejected: [{ sourceId: "web", reason: "paused" }] }),
    );
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
    });
    await client.enqueueVisit(visit("https://example.com/a"));
    await client.drain();
    expect((await client.getServerState())?.state).toBe("paused");
  });

  it("clears an obsolete transient retry when the gateway reports authoritative source state", async () => {
    const clock = fakeClock();
    let unavailable = true;
    const fetch = new FakeFetch(() =>
      unavailable ? jsonResponse(503, { error: "down" }) : removedResponse(),
    );
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
      now: clock.now,
      backoff: { baseMs: 1, maxMs: 1 },
    });
    await client.enqueueDocument(await doc("https://example.com/a"));
    await client.drain();
    expect(await client.getRetry()).not.toBeNull();
    unavailable = false;
    clock.advance(1);
    await client.drain();
    expect(await client.getRetry()).toBeNull();
    expect((await client.getServerState())?.state).toBe("removed");
  });

  it("the probe re-attempts later and a clean delivery clears the server-state (auto-resume)", async () => {
    const clock = fakeClock();
    let removed = true;
    const fetch = new FakeFetch(() =>
      removed ? removedResponse() : jsonResponse(200, { ingested: 1 }),
    );
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
      now: clock.now,
    });

    await client.enqueueDocument(await doc("https://example.com/a"));
    await client.drain();
    expect((await client.getServerState())?.state).toBe("removed");
    expect(await client.queueDepth()).toBe(1);

    // The probe is backed off — an immediate drain does nothing.
    expect((await client.drain()).delivered).toBe(0);

    // Source re-enabled (re-pair / portal resume). After the probe interval the
    // retained item re-attempts, delivers, and the server-state clears.
    removed = false;
    clock.advance(60 * 60 * 1000);
    const resumed = await client.drain();
    expect(resumed.delivered).toBe(1);
    expect(await client.queueDepth()).toBe(0);
    expect(await client.getServerState()).toBeNull();
  });

  it("clearServerState resets the persisted state", async () => {
    const fetch = new FakeFetch(() => removedResponse());
    const client = new PushClient({
      gatewayUrl: GATEWAY,
      token: TOKEN,
      fetch: fetch.fetch,
      store: new MemoryStore(),
    });
    await client.enqueueDocument(await doc("https://example.com/a"));
    await client.drain();
    expect(await client.getServerState()).not.toBeNull();
    await client.clearServerState();
    expect(await client.getServerState()).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("60")).toBe(60_000);
  });
  it("parses an HTTP date relative to now", () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(20_000);
    expect(ms).toBeLessThanOrEqual(31_000);
  });
  it("returns undefined for absent/garbage", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });
});

describe("PushClient — a page the user deleted for good", () => {
  it("leaves the queue without counting as synced, and is never listed as recent", async () => {
    const store = new MemoryStore();
    const page = await doc("https://example.com/deleted-for-good");
    const fetch = new FakeFetch((req) =>
      req.url.endsWith("/documents")
        ? jsonResponse(200, { ingested: 0, suppressed: [page.externalId] })
        : jsonResponse(200, { ingested: 1, deleted: 0 }),
    );
    const client = new PushClient({ gatewayUrl: GATEWAY, token: TOKEN, fetch: fetch.fetch, store });
    await client.enqueueDocument(page);
    await client.enqueueVisit(visit("https://example.com/deleted-for-good"));

    const result = await client.drain();
    expect(result).toMatchObject({ delivered: 1, retained: 0, dropped: 0, suppressed: 1 });
    expect(await client.queueDepth()).toBe(0);
    expect(await client.getRecentDeliveries()).toEqual([]);
    expect(await client.getFailure()).toBeNull();
    expect(await client.getRetry()).toBeNull();
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { PushClient } from "./client.js";
import { buildWebPageDocument, buildPageVisit } from "./documents.js";
import { PushObservability } from "./observability.js";
import { MemoryStore, FakeFetch, jsonResponse } from "./test-fakes.js";
import type { DurableStore } from "./types.js";

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

describe("push observability — recent log + connectivity", () => {
  it("serializes snapshot compare-and-set across concurrent client instances", async () => {
    const backing = new MemoryStore();
    let releaseFirstGet: (() => void) | undefined;
    let firstGetStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstGetStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    let delayed = false;
    const store: DurableStore = {
      get: async (key) => {
        if (key === "omnesis.push.connectivity.v1" && !delayed) {
          delayed = true;
          const snapshot = await backing.get(key);
          firstGetStarted?.();
          await release;
          return snapshot;
        }
        return backing.get(key);
      },
      set: (key, value) => backing.set(key, value),
    };
    const older = new PushObservability(store, "worker", 1);
    const newer = new PushObservability(store, "worker", 2);

    const oldWrite = older.writeConnectivity({ reachable: false, at: T0 });
    await started;
    const newWrite = newer.writeConnectivity({ reachable: true, at: T0 });
    releaseFirstGet?.();
    await Promise.all([oldWrite, newWrite]);

    expect(await newer.getConnectivity()).toMatchObject({ reachable: true, at: T0 });
  });

  it("ignores structurally invalid persisted diagnostics instead of crashing status", async () => {
    const store = new MemoryStore();
    await store.set("omnesis.push.recent.v1", JSON.stringify([null]));
    await store.set("omnesis.push.connectivity.v1", JSON.stringify({ reachable: "yes", at: 1 }));
    const client = makeClient(
      () => T0,
      new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 })),
      store,
    );
    expect(await client.getRecentDeliveries()).toEqual([]);
    expect(await client.getConnectivity()).toBeNull();
  });

  it("retains valid document proof from a mixed legacy document/visit log", async () => {
    const store = new MemoryStore();
    await store.set(
      "omnesis.push.recent.v1",
      JSON.stringify([
        { kind: "visit", title: "Legacy visit", url: "https://example.com/visit", at: T0 + 1 },
        { kind: "document", title: "Legacy page", url: "https://example.com/page", at: T0 },
      ]),
    );
    const client = makeClient(
      () => T0,
      new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 })),
      store,
    );
    expect(await client.getRecentDeliveries()).toEqual([
      { kind: "document", title: "Legacy page", url: "https://example.com/page", at: T0 },
    ]);
  });

  it("records delivered pages (newest first) and marks the gateway reachable", async () => {
    const now = T0;
    const store = new MemoryStore();
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 }));
    const client = makeClient(() => now, fetch, store);

    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: "https://example.com/a",
        title: "Page A",
        text: "body a",
        contentHash: "h-a",
        visitedAt: new Date(now).toISOString(),
      }),
    );
    await client.enqueueVisit(
      buildPageVisit({
        normalizedUrl: "https://example.com/a",
        title: "Page A",
        visitedAt: new Date(now).toISOString(),
        dwellMs: 6000,
      }),
    );
    await client.drain();

    const recent = await client.getRecentDeliveries();
    expect(recent).toEqual([
      expect.objectContaining({ kind: "document", url: "https://example.com/a" }),
    ]);
    expect(await client.getConnectivity()).toMatchObject({ reachable: true });
  });

  it("flips to offline when every attempt fails to connect, then recovers", async () => {
    let now = T0;
    const store = new MemoryStore();
    const fetch = new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 }));
    const client = makeClient(() => now, fetch, store);

    // First page delivers cleanly → reachable.
    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: "https://example.com/a",
        title: "Page A",
        text: "body a",
        contentHash: "h-a",
        visitedAt: new Date(now).toISOString(),
      }),
    );
    await client.drain();
    expect(await client.getConnectivity()).toMatchObject({ reachable: true });

    // Gateway goes unreachable; a fresh page can't deliver → offline.
    fetch.setScript(() => "network-error");
    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: "https://example.com/b",
        title: "Page B",
        text: "body b",
        contentHash: "h-b",
        visitedAt: new Date(now).toISOString(),
      }),
    );
    await client.drain();
    expect(await client.getConnectivity()).toMatchObject({ reachable: false });
    // Nothing new was logged while offline.
    expect((await client.getRecentDeliveries()).length).toBe(1);

    // Gateway returns; advance past the backoff so B is eligible again.
    now += 5000;
    fetch.setScript(() => jsonResponse(200, { ingested: 1, deleted: 0 }));
    await client.drain();
    expect(await client.getConnectivity()).toMatchObject({ reachable: true });
    const recent = await client.getRecentDeliveries();
    expect(recent.length).toBe(2);
    expect(recent[0].url).toBe("https://example.com/b"); // newest first
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import { PushClient, buildPageVisit, buildWebPageDocument } from "../push/index.js";
import { FakeFetch, MemoryStore, jsonResponse } from "../push/test-fakes.js";
import { QUEUE_STORAGE_KEY } from "../push/queue.js";
import { badgeFor, composeStatus, type CaptureStatus } from "./status.js";

function status(over: Partial<CaptureStatus> = {}): CaptureStatus {
  return {
    paired: true,
    gatewayUrl: "https://gateway.example.com:7600",
    gatewayVersion: null,
    extensionVersion: null,
    pairedAt: 1,
    scopeOk: true,
    hostPermissionOk: true,
    queueDepth: 0,
    health: null,
    failure: null,
    retry: null,
    queueCorruption: null,
    queueOverflow: null,
    handoffFailure: null,
    handoffOverflow: null,
    serverState: null,
    connectivity: null,
    pause: { paused: false, until: null },
    policyLoaded: true,
    recent: [],
    lastSyncAt: null,
    lastCheckedAt: null,
    ...over,
  };
}

describe("badgeFor — toolbar badge priority", () => {
  it("shows no badge when not paired", () => {
    expect(badgeFor(status({ paired: false })).text).toBe("");
  });

  it("shows a clean (empty) badge when paired and idle", () => {
    expect(badgeFor(status()).text).toBe("");
  });

  it("gives every non-idle badge a usable tooltip", () => {
    const badgeStates: CaptureStatus[] = [
      status({ paired: false }),
      status({ health: { ok: false, reason: "invented", at: 1 } }),
      status({ scopeOk: false }),
      status({ hostPermissionOk: false }),
      status({ handoffFailure: { at: 1, attempts: 2 } }),
      status({ serverState: { state: "paused", reason: "invented", at: 1 } }),
      status({
        retry: {
          itemId: "doc:1",
          kind: "document",
          status: 503,
          reason: "invented",
          attempts: 2,
          nextRetryAt: 10,
          at: 1,
        },
      }),
      status({ handoffOverflow: { at: 1, discarded: 2 } }),
      status({ queueCorruption: { at: 1, discarded: 2 } }),
      status({ queueOverflow: { at: 1, discardedDocuments: 1, discardedVisits: 2 } }),
      status({ pause: { paused: true, until: null } }),
      status({ connectivity: { reachable: false, at: 1 } }),
      status({ connectivity: { reachable: true, degraded: true, at: 1 } }),
      status({
        failure: { kind: "document", status: 422, reason: "invented", at: 1, count: 1 },
      }),
      status({ queueDepth: 3 }),
    ];
    for (const value of badgeStates) expect(badgeFor(value).title.trim()).not.toBe("");
  });

  it("shows an error badge when a legacy pairing scope disables capture", () => {
    const badge = badgeFor(status({ scopeOk: false }));
    expect(badge.text).toBe("!");
    expect(badge.title.trim()).not.toBe("");
  });

  it("shows an actionable error when Chrome page access is missing", () => {
    const badge = badgeFor(status({ hostPermissionOk: false }));
    expect(badge.text).toBe("!");
  });

  it("shows the pending count, capped at 99+", () => {
    expect(badgeFor(status({ queueDepth: 5 })).text).toBe("5");
    expect(badgeFor(status({ queueDepth: 150 })).text).toBe("99+");
  });

  it("prefers an error over everything else", () => {
    const health = { ok: false, reason: "token lacks the write:web scope", at: 1 };
    const b = badgeFor(
      status({
        health,
        serverState: { state: "paused", reason: "paused", at: 1 },
        pause: { paused: true, until: null },
        queueDepth: 9,
      }),
    );
    expect(b).toEqual(badgeFor(status({ health })));
  });

  it("surfaces a permanent page-delivery failure", () => {
    const b = badgeFor(
      status({ failure: { reason: "HTTP 400", status: 400, kind: "document", at: 1, count: 1 } }),
    );
    expect(b.text).toBe("!");
  });

  it("surfaces a content-script handoff failure", () => {
    const b = badgeFor(status({ handoffFailure: { at: 1, attempts: 4 } }));
    expect(b.text).toBe("!");
  });

  it("surfaces a retained retryable gateway failure", () => {
    const b = badgeFor(
      status({
        retry: {
          itemId: "doc:1",
          kind: "document",
          status: 503,
          reason: "temporarily unavailable",
          attempts: 2,
          nextRetryAt: 10,
          at: 1,
        },
      }),
    );
    expect(b.text).toBe("!");
  });

  it("prefers authoritative source state over an obsolete retry diagnostic", () => {
    const serverState = { state: "paused" as const, reason: "paused", at: 2 };
    const b = badgeFor(
      status({
        serverState,
        retry: {
          itemId: "doc:1",
          kind: "document",
          status: 503,
          reason: "old failure",
          attempts: 1,
          nextRetryAt: 10,
          at: 1,
        },
      }),
    );
    expect(b).toEqual(badgeFor(status({ serverState })));
  });

  it("surfaces bounded handoff-outbox loss", () => {
    const b = badgeFor(status({ handoffOverflow: { at: 1, discarded: 2 } }));
    expect(b.text).toBe("!");
  });

  it("surfaces a repaired-but-lossy queue corruption", () => {
    const b = badgeFor(status({ queueCorruption: { at: 1, discarded: 2 } }));
    expect(b.text).toBe("!");
  });

  it("surfaces local queue budget loss as a historical warning", () => {
    const b = badgeFor(
      status({ queueOverflow: { at: 1, discardedDocuments: 1, discardedVisits: 2 } }),
    );
    expect(b.text).toBe("!");
  });

  it("prefers a server paused/removed state over a user pause and queue", () => {
    const b = badgeFor(
      status({
        serverState: { state: "removed", reason: "removed", at: 1 },
        pause: { paused: true, until: null },
        queueDepth: 3,
      }),
    );
    expect(b.text).toBe("!");
  });

  it("shows the user-pause state over offline and pending", () => {
    const b = badgeFor(
      status({
        pause: { paused: true, until: null },
        connectivity: { reachable: false, at: 1 },
        queueDepth: 4,
      }),
    );
    expect(b.text).toBe("॥");
  });

  it("shows a missing settings copy over a pending count, under offline", () => {
    const missing = badgeFor(status({ policyLoaded: false, queueDepth: 4 }));
    expect(missing.text).toBe("!");
    expect(missing.title).toMatch(/capture settings/);
    expect(
      badgeFor(status({ policyLoaded: false, connectivity: { reachable: false, at: 1 } })).text,
    ).toBe("·");
  });

  it("shows offline over a pending count", () => {
    const b = badgeFor(status({ connectivity: { reachable: false, at: 1 }, queueDepth: 4 }));
    expect(b.text).toBe("·");
  });
});

describe("composeStatus", () => {
  it("surfaces legacy scope metadata as an explicit re-pair requirement", async () => {
    const store = new MemoryStore();
    const composed = await composeStatus({
      config: {
        gatewayUrl: "https://gateway.example.com",
        token: "legacy-token",
        scopes: ["write:*"],
        deviceId: "device",
        pairedAt: 1,
      },
      client: null,
      hostPermissionOk: true,
      store,
      now: 1,
    });
    expect(composed.paired).toBe(true);
    expect(composed.scopeOk).toBe(false);
  });

  it("keeps popup queue inspection read-only when the snapshot is damaged", async () => {
    const store = new MemoryStore();
    await store.set(QUEUE_STORAGE_KEY, "damaged-json");
    const client = new PushClient({
      gatewayUrl: "https://gateway.example.com",
      token: "token",
      fetch: new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 })).fetch,
      store,
    });
    const composed = await composeStatus({
      config: {
        gatewayUrl: "https://gateway.example.com",
        token: "token",
        scopes: ["write:web"],
        deviceId: "device",
        pairedAt: 1,
      },
      client,
      hostPermissionOk: true,
      store,
      now: 1,
    });
    expect(composed.queueDepth).toBe(0);
    expect(composed.queueCorruption).toBeNull();
    expect(store.snapshot().get(QUEUE_STORAGE_KEY)).toBe("damaged-json");
  });

  it("does not let a newer analytics visit impersonate a page-document sync", async () => {
    const store = new MemoryStore();
    let now = 1_000;
    const client = new PushClient({
      gatewayUrl: "https://gateway.example.com",
      token: "token",
      fetch: new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 })).fetch,
      store,
      now: () => now,
    });
    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: "https://example.com/article",
        title: "Example article",
        text: "Fictional article text",
        contentHash: "hash",
        visitedAt: new Date(now).toISOString(),
      }),
    );
    await client.drain();
    now = 2_000;
    await client.enqueueVisit(
      buildPageVisit({
        normalizedUrl: "https://example.com/article",
        title: "Example article",
        visitedAt: new Date(now).toISOString(),
        dwellMs: 5_000,
      }),
    );
    await client.drain();

    const composed = await composeStatus({
      config: {
        gatewayUrl: "https://gateway.example.com",
        token: "token",
        scopes: ["write:web"],
        deviceId: "device",
        pairedAt: 1,
      },
      client,
      hostPermissionOk: true,
      store,
      now,
    });
    expect(composed.lastSyncAt).toBe(1_000);
    expect(composed.recent).toHaveLength(1);
    expect(composed.recent[0].kind).toBe("document");
  });

  it("retains last-page proof after more than fifty later analytics visits", async () => {
    const store = new MemoryStore();
    let now = 1_000;
    const client = new PushClient({
      gatewayUrl: "https://gateway.example.com",
      token: "token",
      fetch: new FakeFetch(() => jsonResponse(200, { ingested: 1, deleted: 0 })).fetch,
      store,
      now: () => now,
    });
    await client.enqueueDocument(
      await buildWebPageDocument({
        normalizedUrl: "https://example.com/article",
        title: "Example article",
        text: "Fictional article text",
        contentHash: "hash",
        visitedAt: new Date(now).toISOString(),
      }),
    );
    await client.drain();
    for (let index = 0; index < 55; index += 1) {
      now += 1_000;
      await client.enqueueVisit(
        buildPageVisit({
          normalizedUrl: `https://example.com/visit-${index}`,
          title: "Example visit",
          visitedAt: new Date(now).toISOString(),
          dwellMs: 5_000,
        }),
      );
    }
    for (let pass = 0; pass < 11; pass += 1) await client.drain();
    const composed = await composeStatus({
      config: {
        gatewayUrl: "https://gateway.example.com",
        token: "token",
        scopes: ["write:web"],
        deviceId: "device",
        pairedAt: 1,
      },
      client,
      hostPermissionOk: true,
      store,
      now,
    });
    expect(composed.lastSyncAt).toBe(1_000);
    expect(composed.recent).toHaveLength(1);
  });
});

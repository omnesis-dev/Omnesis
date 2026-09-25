// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit suite for `PushObservability` and the `clearPush*` helpers, driven
 * directly against a store rather than through `PushClient`.
 *
 * Deliberately absent here because the client-level suites already assert them:
 *   - `client.observability.test.ts`: the connectivity compare-and-set race
 *     between two client instances, invalid persisted recent/connectivity read
 *     back as empty/null through the client, the mixed legacy document/visit
 *     log, and the recent log filling newest-first across drains.
 *   - `client.probe.test.ts`: session/generation semantics as `probeAuth`
 *     exercises them (a slow older probe, a restarted worker), and
 *     `clearPushHealth` resetting a stale auth alarm through the client.
 *   - `client.test.ts`: failure `count` accumulating across a drain, retry
 *     snapshots written and cleared by the drain, and `clearPushHealth` leaving
 *     data-loss diagnostics alone.
 */

import { describe, expect, it } from "vitest";
import {
  PUSH_SERVER_STATE_KEY,
  PushObservability,
  clearPushDataLoss,
  clearPushHealth,
  clearPushObservability,
  clearPushServerState,
  type RecentDelivery,
} from "./observability.js";
import { QUEUE_CORRUPTION_KEY, QUEUE_OVERFLOW_KEY } from "./queue.js";
import { MemoryStore } from "./test-fakes.js";
import type { DurableStore } from "./types.js";

const T0 = 1_700_000_000_000;

// The durable key set is the storage contract the popup and the worker share;
// the suite names the keys so a rename cannot silently orphan persisted state.
const HEALTH_KEY = "omnesis.push.health.v1";
const RECENT_KEY = "omnesis.push.recent.v1";
const CONNECTIVITY_KEY = "omnesis.push.connectivity.v1";
const CHECKED_KEY = "omnesis.push.checked.v1";
const FAILURE_KEY = "omnesis.push.failure.v1";
const RETRY_KEY = "omnesis.push.retry.v1";
const QUEUE_KEY = "omnesis.push.queue.v1";
const RECENT_CAP = 50;

const ALL_KEYS = [
  HEALTH_KEY,
  PUSH_SERVER_STATE_KEY,
  RECENT_KEY,
  CONNECTIVITY_KEY,
  CHECKED_KEY,
  FAILURE_KEY,
  RETRY_KEY,
  QUEUE_CORRUPTION_KEY,
  QUEUE_OVERFLOW_KEY,
  QUEUE_KEY,
];

function recent(n: number, at = T0): RecentDelivery {
  return { kind: "document", title: `Page ${n}`, url: `https://example.com/p/${n}`, at };
}

function stored(store: MemoryStore, key: string): unknown {
  const raw = store.snapshot().get(key);
  return raw ? (JSON.parse(raw) as unknown) : raw;
}

/**
 * A store whose first `get` of one key blocks until released, so a test can
 * park one writer inside its read-modify-write while another arrives.
 */
function holdableStore(key: string): {
  store: DurableStore;
  backing: MemoryStore;
  held: Promise<void>;
  release: () => void;
} {
  const backing = new MemoryStore();
  let release: () => void = () => undefined;
  let markHeld: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let armed = true;
  const store: DurableStore = {
    get: async (k) => {
      if (k === key && armed) {
        armed = false;
        const value = await backing.get(k);
        markHeld();
        await gate;
        return value;
      }
      return backing.get(k);
    },
    set: (k, v) => backing.set(k, v),
  };
  return { store, backing, held, release };
}

describe("PushObservability — getters reject what the guards reject", () => {
  it("returns null / [] for every absent key", async () => {
    const o = new PushObservability(new MemoryStore());
    expect(await o.getHealth()).toBeNull();
    expect(await o.getFailure()).toBeNull();
    expect(await o.getRetry()).toBeNull();
    expect(await o.getServerState()).toBeNull();
    expect(await o.getConnectivity()).toBeNull();
    expect(await o.getRecentDeliveries()).toEqual([]);
    expect(await o.getLastCheckedAt()).toBeNull();
    expect(await o.getQueueCorruption()).toBeNull();
    expect(await o.getQueueOverflow()).toBeNull();
  });

  it("returns null / [] for unreadable JSON under every key", async () => {
    const store = new MemoryStore();
    for (const key of ALL_KEYS) await store.set(key, "{not json");
    const o = new PushObservability(store);
    expect(await o.getHealth()).toBeNull();
    expect(await o.getFailure()).toBeNull();
    expect(await o.getRetry()).toBeNull();
    expect(await o.getServerState()).toBeNull();
    expect(await o.getConnectivity()).toBeNull();
    expect(await o.getRecentDeliveries()).toEqual([]);
    expect(await o.getLastCheckedAt()).toBeNull();
    expect(await o.getQueueCorruption()).toBeNull();
    expect(await o.getQueueOverflow()).toBeNull();
  });

  it("health: a non-boolean ok, a negative at, or a non-string reason is null", async () => {
    const store = new MemoryStore();
    const o = new PushObservability(store);
    for (const value of [
      { ok: "yes", at: T0 },
      { ok: true, at: -1 },
      { ok: false, at: T0, reason: 42 },
      "true",
    ]) {
      await store.set(HEALTH_KEY, JSON.stringify(value));
      expect(await o.getHealth()).toBeNull();
    }
    await store.set(HEALTH_KEY, JSON.stringify({ ok: false, at: T0, reason: "forbidden" }));
    expect(await o.getHealth()).toEqual({ ok: false, at: T0, reason: "forbidden" });
  });

  it("failure: an unknown kind, a negative or fractional count, or a string status is null", async () => {
    const store = new MemoryStore();
    const o = new PushObservability(store);
    const valid = { reason: "bad request", status: 400, kind: "document", at: T0, count: 1 };
    for (const value of [
      { ...valid, kind: "email" },
      { ...valid, count: -1 },
      { ...valid, count: 1.5 },
      { ...valid, status: "400" },
      { ...valid, at: Number.NaN },
    ]) {
      await store.set(FAILURE_KEY, JSON.stringify(value));
      expect(await o.getFailure()).toBeNull();
    }
    await store.set(FAILURE_KEY, JSON.stringify(valid));
    expect(await o.getFailure()).toEqual(valid);
  });

  it("retry: a missing itemId, a fractional attempts, or a non-numeric status is null", async () => {
    const store = new MemoryStore();
    const o = new PushObservability(store);
    const valid = {
      itemId: "item-1",
      kind: "visit",
      reason: "HTTP 503",
      attempts: 2,
      nextRetryAt: T0 + 1000,
      at: T0,
    };
    for (const value of [
      { ...valid, itemId: undefined },
      { ...valid, attempts: 0.5 },
      { ...valid, status: "503" },
      { ...valid, kind: "page" },
      { ...valid, nextRetryAt: -5 },
    ]) {
      await store.set(RETRY_KEY, JSON.stringify(value));
      expect(await o.getRetry()).toBeNull();
    }
    await store.set(RETRY_KEY, JSON.stringify({ ...valid, status: 503 }));
    expect(await o.getRetry()).toEqual({ ...valid, status: 503 });
  });

  it("serverState: only paused/removed with a string reason and a timestamp", async () => {
    const store = new MemoryStore();
    const o = new PushObservability(store);
    for (const value of [
      { state: "stopped", reason: "x", at: T0 },
      { state: "paused", reason: null, at: T0 },
      { state: "removed", reason: "removed", at: "now" },
    ]) {
      await store.set(PUSH_SERVER_STATE_KEY, JSON.stringify(value));
      expect(await o.getServerState()).toBeNull();
    }
    await store.set(PUSH_SERVER_STATE_KEY, JSON.stringify({ state: "paused", reason: "p", at: 0 }));
    expect(await o.getServerState()).toEqual({ state: "paused", reason: "p", at: 0 });
  });

  it("connectivity: a non-boolean reachable or degraded is null", async () => {
    const store = new MemoryStore();
    const o = new PushObservability(store);
    for (const value of [
      { reachable: "yes", at: T0 },
      { reachable: true, degraded: "a bit", at: T0 },
      { reachable: true, reason: 7, at: T0 },
      { reachable: true },
    ]) {
      await store.set(CONNECTIVITY_KEY, JSON.stringify(value));
      expect(await o.getConnectivity()).toBeNull();
    }
    await store.set(CONNECTIVITY_KEY, JSON.stringify({ reachable: true, degraded: true, at: T0 }));
    expect(await o.getConnectivity()).toEqual({ reachable: true, degraded: true, at: T0 });
  });

  it("recent: a non-array is empty and invalid entries are filtered out", async () => {
    const store = new MemoryStore();
    const o = new PushObservability(store);
    await store.set(RECENT_KEY, JSON.stringify({ kind: "document" }));
    expect(await o.getRecentDeliveries()).toEqual([]);

    const keep = recent(1);
    await store.set(
      RECENT_KEY,
      JSON.stringify([
        null,
        "page",
        { ...keep, kind: "visit" },
        { ...keep, title: 5 },
        { ...keep, url: undefined },
        { ...keep, at: -1 },
        keep,
      ]),
    );
    expect(await o.getRecentDeliveries()).toEqual([keep]);
  });

  it("lastCheckedAt: a non-numeric, negative, or missing at is null", async () => {
    const store = new MemoryStore();
    const o = new PushObservability(store);
    for (const raw of [
      JSON.stringify({ at: "1" }),
      JSON.stringify({ at: -1 }),
      JSON.stringify({}),
      // An array parses, and `[].at` is a method, not a timestamp.
      "[]",
    ]) {
      await store.set(CHECKED_KEY, raw);
      expect(await o.getLastCheckedAt()).toBeNull();
    }
    await store.set(CHECKED_KEY, JSON.stringify({ at: T0, sessionId: "w", generation: 3 }));
    expect(await o.getLastCheckedAt()).toBe(T0);
  });

  it("queueCorruption: discarded may be null or a whole number, never negative", async () => {
    const store = new MemoryStore();
    const o = new PushObservability(store);
    for (const value of [
      { at: T0, discarded: -1 },
      { at: T0, discarded: 1.5 },
      { at: T0 },
      { discarded: 3 },
    ]) {
      await store.set(QUEUE_CORRUPTION_KEY, JSON.stringify(value));
      expect(await o.getQueueCorruption()).toBeNull();
    }
    await store.set(QUEUE_CORRUPTION_KEY, JSON.stringify({ at: T0, discarded: null }));
    expect(await o.getQueueCorruption()).toEqual({ at: T0, discarded: null });
    await store.set(QUEUE_CORRUPTION_KEY, JSON.stringify({ at: T0, discarded: 3 }));
    expect(await o.getQueueCorruption()).toEqual({ at: T0, discarded: 3 });
  });

  it("queueOverflow: both discarded counters must be whole non-negative numbers", async () => {
    const store = new MemoryStore();
    const o = new PushObservability(store);
    for (const value of [
      { at: T0, discardedDocuments: 1 },
      { at: T0, discardedDocuments: -1, discardedVisits: 0 },
      { at: T0, discardedDocuments: 0, discardedVisits: "2" },
    ]) {
      await store.set(QUEUE_OVERFLOW_KEY, JSON.stringify(value));
      expect(await o.getQueueOverflow()).toBeNull();
    }
    const valid = { at: T0, discardedDocuments: 0, discardedVisits: 12 };
    await store.set(QUEUE_OVERFLOW_KEY, JSON.stringify(valid));
    expect(await o.getQueueOverflow()).toEqual(valid);
  });
});

describe("PushObservability — writeFailure counting", () => {
  const failure = { reason: "bad request", status: 400, kind: "document" as const, at: T0 };

  it("increments count while kind, status and reason all match the previous failure", async () => {
    const o = new PushObservability(new MemoryStore());
    await o.writeFailure(failure);
    expect(await o.getFailure()).toEqual({ ...failure, count: 1 });
    await o.writeFailure({ ...failure, at: T0 + 1 });
    await o.writeFailure({ ...failure, at: T0 + 2 });
    expect(await o.getFailure()).toEqual({ ...failure, at: T0 + 2, count: 3 });
  });

  it.each([
    { label: "reason", next: { ...failure, reason: "invalid payload" } },
    { label: "status", next: { ...failure, status: 422 } },
    { label: "kind", next: { ...failure, kind: "visit" as const } },
  ])("resets count to 1 when the $label differs", async ({ next }) => {
    const o = new PushObservability(new MemoryStore());
    await o.writeFailure(failure);
    await o.writeFailure(failure);
    expect(await o.getFailure()).toMatchObject({ count: 2 });
    await o.writeFailure(next);
    expect(await o.getFailure()).toEqual({ ...next, count: 1 });
  });

  it("starts at 1 over a malformed previous failure", async () => {
    const store = new MemoryStore();
    await store.set(FAILURE_KEY, JSON.stringify({ ...failure, count: -4 }));
    const o = new PushObservability(store);
    await o.writeFailure(failure);
    expect(await o.getFailure()).toEqual({ ...failure, count: 1 });
  });
});

describe("PushObservability — prependRecent", () => {
  it("keeps the newest deliveries first", async () => {
    const o = new PushObservability(new MemoryStore());
    await o.prependRecent([recent(1)]);
    await o.prependRecent([recent(2), recent(3)]);
    expect(await o.getRecentDeliveries()).toEqual([recent(2), recent(3), recent(1)]);
  });

  it("caps the log at 50 entries, dropping the oldest", async () => {
    const o = new PushObservability(new MemoryStore());
    const first = Array.from({ length: 30 }, (_, i) => recent(i));
    const second = Array.from({ length: 30 }, (_, i) => recent(100 + i));
    await o.prependRecent(first);
    await o.prependRecent(second);
    const log = await o.getRecentDeliveries();
    expect(log).toHaveLength(RECENT_CAP);
    expect(log.slice(0, 30)).toEqual(second);
    expect(log.slice(30)).toEqual(first.slice(0, 20));
  });

  it("ignores an empty batch without touching the store", async () => {
    const store = new MemoryStore();
    await new PushObservability(store).prependRecent([]);
    expect(store.snapshot().has(RECENT_KEY)).toBe(false);
  });

  it("drops invalid prior entries when it rewrites the log", async () => {
    const store = new MemoryStore();
    await store.set(RECENT_KEY, JSON.stringify([null, { kind: "visit", at: T0 }, recent(1)]));
    await new PushObservability(store).prependRecent([recent(2)]);
    expect(stored(store, RECENT_KEY)).toEqual([recent(2), recent(1)]);
  });
});

describe("PushObservability — snapshot compare-and-set", () => {
  it("stamps every snapshot with the writer's session and generation", async () => {
    const store = new MemoryStore();
    await new PushObservability(store, "worker-a", 3).writeHealth({ ok: true, at: T0 });
    expect(stored(store, HEALTH_KEY)).toEqual({
      ok: true,
      at: T0,
      sessionId: "worker-a",
      generation: 3,
    });
  });

  it("an older at never overwrites a newer one from the same generation", async () => {
    const o = new PushObservability(new MemoryStore(), "worker-a", 1);
    await o.writeConnectivity({ reachable: true, at: T0 + 10 });
    await o.writeConnectivity({ reachable: false, at: T0 });
    expect(await o.getConnectivity()).toMatchObject({ reachable: true, at: T0 + 10 });
    // An equal at is not newer, so the later write lands.
    await o.writeConnectivity({ reachable: false, at: T0 + 10 });
    expect(await o.getConnectivity()).toMatchObject({ reachable: false, at: T0 + 10 });
  });

  it("a higher generation in the same session wins even with an older at", async () => {
    const store = new MemoryStore();
    const gen1 = new PushObservability(store, "worker-a", 1);
    const gen2 = new PushObservability(store, "worker-a", 2);
    await gen1.writeHealth({ ok: false, at: T0 + 10, reason: "stale" });
    await gen2.writeHealth({ ok: true, at: T0 });
    expect(await gen2.getHealth()).toMatchObject({ ok: true, at: T0, generation: 2 });
    // And the lower generation cannot win it back with a newer at.
    await gen1.writeHealth({ ok: false, at: T0 + 20, reason: "late" });
    expect(await gen2.getHealth()).toMatchObject({ ok: true, at: T0, generation: 2 });
  });

  it("a different session wins only with a newer at, whatever its generation", async () => {
    const store = new MemoryStore();
    const old = new PushObservability(store, "old-worker", 20);
    const restarted = new PushObservability(store, "new-worker", 1);
    await old.writeConnectivity({ reachable: false, at: T0 });
    await restarted.writeConnectivity({ reachable: true, at: T0 - 1 });
    expect(await restarted.getConnectivity()).toMatchObject({ reachable: false, at: T0 });
    await restarted.writeConnectivity({ reachable: true, at: T0 + 1 });
    expect(await restarted.getConnectivity()).toMatchObject({ reachable: true, at: T0 + 1 });
  });

  it("an anonymous writer (empty session) compares by at alone", async () => {
    const store = new MemoryStore();
    const a = new PushObservability(store, "", 5);
    const b = new PushObservability(store, "", 1);
    await a.writeHealth({ ok: true, at: T0 });
    await b.writeHealth({ ok: false, at: T0 + 1 });
    expect(await b.getHealth()).toMatchObject({ ok: false, at: T0 + 1 });
    await a.writeHealth({ ok: true, at: T0 });
    expect(await b.getHealth()).toMatchObject({ ok: false, at: T0 + 1 });
  });

  it("replaces malformed or shapeless stored state instead of deferring to it", async () => {
    const store = new MemoryStore();
    const o = new PushObservability(store, "worker-a", 1);
    await store.set(HEALTH_KEY, "{not json");
    await o.writeHealth({ ok: true, at: T0 });
    expect(await o.getHealth()).toMatchObject({ ok: true, at: T0 });

    await store.set(CONNECTIVITY_KEY, JSON.stringify({ at: "later", generation: "9" }));
    await o.writeConnectivity({ reachable: true, at: T0 });
    expect(await o.getConnectivity()).toMatchObject({ reachable: true, at: T0 });
  });

  it("writeChecked follows the same rules", async () => {
    const store = new MemoryStore();
    const gen1 = new PushObservability(store, "worker-a", 1);
    const gen2 = new PushObservability(store, "worker-a", 2);
    const other = new PushObservability(store, "worker-b", 1);

    await gen1.writeChecked(T0 + 10);
    await gen1.writeChecked(T0);
    expect(await gen1.getLastCheckedAt()).toBe(T0 + 10);

    await gen2.writeChecked(T0 + 5);
    expect(await gen2.getLastCheckedAt()).toBe(T0 + 5);

    await other.writeChecked(T0 + 4);
    expect(await other.getLastCheckedAt()).toBe(T0 + 5);
    await other.writeChecked(T0 + 6);
    expect(await other.getLastCheckedAt()).toBe(T0 + 6);
    expect(stored(store, CHECKED_KEY)).toEqual({
      at: T0 + 6,
      sessionId: "worker-b",
      generation: 1,
    });

    await store.set(CHECKED_KEY, "not json");
    await gen1.writeChecked(T0);
    expect(await gen1.getLastCheckedAt()).toBe(T0);
  });
});

describe("PushObservability — the per-store write lane", () => {
  it("serializes read-modify-write across instances over the same store", async () => {
    const { store, held, release } = holdableStore(FAILURE_KEY);
    const a = new PushObservability(store, "worker-a", 1);
    const b = new PushObservability(store, "worker-b", 1);
    const failure = { reason: "bad request", status: 400, kind: "document" as const, at: T0 };

    const first = a.writeFailure(failure);
    await held;
    const second = b.writeFailure({ ...failure, at: T0 + 1 });
    release();
    await Promise.all([first, second]);

    // Without the lane both writers would read "no previous failure" and each
    // store count 1; the lane makes the second read the first's result.
    expect(await b.getFailure()).toEqual({ ...failure, at: T0 + 1, count: 2 });
  });

  it("does not let one store's held write block another store", async () => {
    const blocked = holdableStore(RETRY_KEY);
    const free = new MemoryStore();
    const retry = {
      itemId: "item-1",
      kind: "document" as const,
      reason: "HTTP 503",
      attempts: 1,
      nextRetryAt: T0 + 1000,
      at: T0,
    };

    const pending = new PushObservability(blocked.store).writeRetry(retry);
    await blocked.held;
    await new PushObservability(free).writeRetry(retry);
    expect(stored(free, RETRY_KEY)).toMatchObject(retry);
    expect(blocked.backing.snapshot().has(RETRY_KEY)).toBe(false);

    blocked.release();
    await pending;
    expect(stored(blocked.backing, RETRY_KEY)).toMatchObject(retry);
  });

  it("a rejected write releases the lane for the next one", async () => {
    const backing = new MemoryStore();
    let failNext = true;
    const store: DurableStore = {
      get: (key) => backing.get(key),
      set: (key, value) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("quota exceeded"));
        }
        return backing.set(key, value);
      },
    };
    const o = new PushObservability(store);
    await expect(o.writeHealth({ ok: true, at: T0 })).rejects.toThrow("quota exceeded");
    await o.writeHealth({ ok: false, at: T0 + 1, reason: "second" });
    expect(await o.getHealth()).toMatchObject({ ok: false, at: T0 + 1, reason: "second" });
  });
});

describe("clearing helpers blank exactly their keys", () => {
  async function populated(): Promise<MemoryStore> {
    const store = new MemoryStore();
    for (const key of ALL_KEYS) await store.set(key, "x");
    return store;
  }

  function blanked(store: MemoryStore): string[] {
    return [...store.snapshot()]
      .filter(([, value]) => value === "")
      .map(([key]) => key)
      .sort();
  }

  it.each([
    {
      name: "clearPushObservability",
      clear: clearPushObservability,
      keys: [
        RECENT_KEY,
        CONNECTIVITY_KEY,
        CHECKED_KEY,
        RETRY_KEY,
        FAILURE_KEY,
        QUEUE_CORRUPTION_KEY,
        QUEUE_OVERFLOW_KEY,
      ],
    },
    {
      name: "clearPushDataLoss",
      clear: clearPushDataLoss,
      keys: [FAILURE_KEY, QUEUE_CORRUPTION_KEY, QUEUE_OVERFLOW_KEY],
    },
    {
      name: "clearPushHealth",
      clear: clearPushHealth,
      keys: [HEALTH_KEY, CONNECTIVITY_KEY, CHECKED_KEY],
    },
    {
      name: "clearPushServerState",
      clear: clearPushServerState,
      keys: [PUSH_SERVER_STATE_KEY],
    },
  ])("$name", async ({ clear, keys }) => {
    const store = await populated();
    await clear(store);
    expect(blanked(store)).toEqual([...keys].sort());
    // Every other key, the queue included, is left as it was.
    for (const key of ALL_KEYS.filter((k) => !keys.includes(k))) {
      expect(store.snapshot().get(key)).toBe("x");
    }
  });

  it("clearRetry and clearServerState blank only their own key", async () => {
    const store = await populated();
    const o = new PushObservability(store);
    await o.clearRetry();
    expect(blanked(store)).toEqual([RETRY_KEY]);
    await o.clearServerState();
    expect(blanked(store)).toEqual([PUSH_SERVER_STATE_KEY, RETRY_KEY].sort());
  });
});

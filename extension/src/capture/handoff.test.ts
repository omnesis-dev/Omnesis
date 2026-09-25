// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_HANDOFF_MAX_RECORDS,
  pendingHandoffKeys,
  persistCaptureHandoff,
  type HandoffStorage,
} from "../chrome/handoff-storage.js";
import { CAPTURE_PENDING_PREFIX } from "../chrome/messages.js";
import { CaptureHandoffQueue } from "./handoff.js";
import type { CaptureEmission } from "./lifecycle.js";

function emission(kind: CaptureEmission["kind"], text: string): CaptureEmission {
  return {
    kind,
    normalizedUrl: "https://example.com/article",
    title: "Example article",
    text,
    contentHash: text,
    visitedAt: "2026-01-01T00:00:00.000Z",
    dwellMs: 5_000,
    contentChanged: true,
  };
}

describe("CaptureHandoffQueue", () => {
  it("retries a transient failure and reports recovery", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValueOnce(new Error("worker cold")).mockResolvedValue(true);
    const recovered = vi.fn();
    const queue = new CaptureHandoffQueue({
      persist: async () => undefined,
      send,
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: vi.fn(),
      onRecovered: recovered,
      retryDelaysMs: [10],
    });
    queue.enqueue(emission("visit", "first"));
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(2);
    expect(recovered).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does not rewrite an already-durable handoff after an ambiguous send failure", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => undefined);
    const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const queue = new CaptureHandoffQueue({
      persist,
      send,
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: vi.fn(),
      onRecovered: vi.fn(),
      retryDelaysMs: [10],
    });

    queue.enqueue(emission("re-extract", "durable snapshot"));
    await vi.runAllTimersAsync();

    expect(send).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("still delivers an in-tab capture whose durable recovery copy was evicted", async () => {
    const values: Record<string, unknown> = {};
    const storage: HandoffStorage = {
      get: async (keys) => {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          list.filter((key) => key in values).map((key) => [key, values[key]]),
        );
      },
      getKeys: async () => Object.keys(values),
      set: async (items) => {
        Object.assign(values, items);
      },
      remove: async (keys) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      },
    };
    const keys = new WeakMap<CaptureEmission, string>();
    const delivered: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sequence = 0;
    const queue = new CaptureHandoffQueue({
      persist: async (item) => {
        const index = sequence;
        sequence += 1;
        const key = `${CAPTURE_PENDING_PREFIX}live.${String(index).padStart(4, "0")}`;
        keys.set(item, key);
        await persistCaptureHandoff(storage, key, {
          at: index,
          order: String(index).padStart(4, "0"),
          pairingId: "a".repeat(64),
          emission: item,
        });
      },
      send: async (item) => {
        if (item.normalizedUrl.endsWith("/0")) await firstBlocked;
        delivered.push(item.normalizedUrl);
        const key = keys.get(item);
        if (key) await storage.remove(key);
        return true;
      },
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: vi.fn(),
      onRecovered: vi.fn(),
    });

    for (let index = 0; index <= CAPTURE_HANDOFF_MAX_RECORDS; index += 1) {
      const item = emission("visit", `capture-${index}`);
      item.normalizedUrl = `https://example.com/${index}`;
      item.visitedAt = new Date(index).toISOString();
      item.contentHash = "a".repeat(64);
      queue.enqueue(item);
    }
    await vi.waitFor(async () => {
      const pending = await pendingHandoffKeys(storage);
      expect(pending.length).toBeLessThanOrEqual(CAPTURE_HANDOFF_MAX_RECORDS);
      expect(pending).not.toContain(`${CAPTURE_PENDING_PREFIX}live.0000`);
    });

    releaseFirst?.();
    await vi.waitFor(() => expect(delivered).toHaveLength(CAPTURE_HANDOFF_MAX_RECORDS + 1));
    expect(delivered[0]).toBe("https://example.com/0");
  });

  it("coalesces obsolete re-extracts while one retry pump is stalled", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let healthy = false;
    const queue = new CaptureHandoffQueue({
      persist: async () => undefined,
      send: async (item) => {
        sent.push(item.text);
        if (!healthy) throw new Error("worker unavailable");
        return true;
      },
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: vi.fn(),
      onRecovered: vi.fn(),
      retryDelaysMs: [10],
    });
    queue.enqueue(emission("re-extract", "old"));
    await Promise.resolve();
    queue.enqueue(emission("re-extract", "newest"));
    healthy = true;
    await vi.runAllTimersAsync();
    expect(sent.at(-1)).toBe("newest");
    expect(sent.filter((text) => text === "old")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("surfaces a stalled handoff but keeps retrying until it recovers", async () => {
    vi.useFakeTimers();
    let healthy = false;
    const stalled = vi.fn();
    const recovered = vi.fn();
    const send = vi.fn(async () => healthy);
    const queue = new CaptureHandoffQueue({
      persist: async () => undefined,
      send,
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: stalled,
      onRecovered: recovered,
      retryDelaysMs: [10, 20],
    });
    queue.enqueue(emission("visit", "first"));
    await vi.advanceTimersByTimeAsync(31);
    expect(stalled).toHaveBeenCalled();
    healthy = true;
    await vi.advanceTimersByTimeAsync(20);
    expect(recovered).toHaveBeenCalledOnce();
    expect(send.mock.calls.length).toBeGreaterThan(3);
    vi.useRealTimers();
  });

  it("preserves distinct visits to the same URL while handoff is unavailable", async () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    let healthy = false;
    const queue = new CaptureHandoffQueue({
      persist: async () => undefined,
      send: async (item) => {
        if (!healthy) return false;
        delivered.push(item.visitedAt);
        return true;
      },
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: vi.fn(),
      onRecovered: vi.fn(),
      retryDelaysMs: [10],
    });
    queue.enqueue(emission("visit", "first"));
    const second = emission("visit", "second");
    second.visitedAt = "2026-01-01T00:01:00.000Z";
    queue.enqueue(second);
    await Promise.resolve();
    healthy = true;
    await vi.runAllTimersAsync();
    expect(delivered).toEqual(["2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z"]);
    vi.useRealTimers();
  });

  it("starts persistence for later emissions before the active handoff recovers", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const persist = vi.fn(async () => undefined);
    let sends = 0;
    const queue = new CaptureHandoffQueue({
      persist,
      send: async () => {
        sends += 1;
        if (sends === 1) await firstSend;
        return true;
      },
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: vi.fn(),
      onRecovered: vi.fn(),
    });
    queue.enqueue(emission("visit", "first"));
    const later = emission("re-extract", "later");
    later.normalizedUrl = "https://example.org/next";
    queue.enqueue(later);
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2));
    releaseFirst?.();
    await vi.waitFor(() => expect(sends).toBe(2));
  });

  it("does not let a pre-pair emission block later captures after pairing", async () => {
    let paired = false;
    const sent: string[] = [];
    const queue = new CaptureHandoffQueue({
      persist: async () => undefined,
      send: async (item) => {
        if (paired) sent.push(item.text);
        return true;
      },
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: vi.fn(),
      onRecovered: vi.fn(),
    });
    queue.enqueue(emission("visit", "before pairing"));
    await vi.waitFor(() => expect(sent).toEqual([]));
    paired = true;
    queue.enqueue(emission("re-extract", "after pairing"));
    await vi.waitFor(() => expect(sent).toEqual(["after pairing"]));
  });

  it("does not send an in-flight persistence after pending work is cancelled", async () => {
    let releasePersist: (() => void) | undefined;
    const persistence = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const send = vi.fn(() => Promise.resolve(true));
    const discard = vi.fn(() => Promise.resolve());
    const queue = new CaptureHandoffQueue({
      persist: () => persistence,
      discard,
      send,
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: vi.fn(),
      onRecovered: vi.fn(),
    });

    queue.enqueue(emission("visit", "cancelled"));
    queue.cancelPending();
    releasePersist?.();
    await persistence;
    await Promise.resolve();

    expect(send).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
  });

  it("discards both active and replacement snapshots on cancellation", async () => {
    let releaseSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const discard = vi.fn(() => Promise.resolve());
    const send = vi.fn(async () => {
      await sendGate;
      return true;
    });
    const queue = new CaptureHandoffQueue({
      persist: () => Promise.resolve(),
      discard,
      send,
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: vi.fn(),
      onRecovered: vi.fn(),
    });
    const old = emission("re-extract", "old snapshot");
    const replacement = emission("re-extract", "replacement snapshot");

    queue.enqueue(old);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    queue.enqueue(replacement);
    queue.cancelPending();
    releaseSend?.();

    await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(2));
    expect(discard).toHaveBeenCalledWith(old);
    expect(discard).toHaveBeenCalledWith(replacement);
  });

  it("tracks every overwritten snapshot until cancellation cleanup", async () => {
    let releaseSend: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const discard = vi.fn(() => Promise.resolve());
    const send = vi.fn(async () => {
      await sendGate;
      return true;
    });
    let persists = 0;
    const queue = new CaptureHandoffQueue({
      persist: () => {
        persists += 1;
        return persists === 3
          ? Promise.reject(new Error("fictional replacement write failure"))
          : Promise.resolve();
      },
      discard,
      send,
      setTimer: (fn, delay) => setTimeout(fn, delay) as unknown as number,
      onStalled: vi.fn(),
      onRecovered: vi.fn(),
    });
    const first = emission("re-extract", "first snapshot");
    const second = emission("re-extract", "second snapshot");
    const third = emission("re-extract", "third snapshot");

    queue.enqueue(first);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    queue.enqueue(second);
    queue.enqueue(third);
    queue.cancelPending();
    releaseSend?.();

    await vi.waitFor(() => expect(discard).toHaveBeenCalledTimes(3));
    expect(discard.mock.calls.map((call: unknown[]) => call[0])).toEqual(
      expect.arrayContaining([first, second, third]),
    );
  });
});

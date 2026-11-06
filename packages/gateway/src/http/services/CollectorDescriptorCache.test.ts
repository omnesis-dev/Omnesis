// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DeviceId } from "@omnesis/types";
import {
  CollectorDescriptorCache,
  type CollectorDescriptorTransport,
} from "./CollectorDescriptorCache.js";

const COLLECTOR = DeviceId("11111111-1111-4111-8111-111111111111");

interface Asked {
  epoch: number;
  resolve: (descriptors: unknown[]) => void;
  reject: (error: Error) => void;
}

/**
 * A socket server reduced to what the cache uses: an epoch per device that the
 * test moves by hand, and `source.descriptors` commands the test answers.
 */
function fakeTransport() {
  const epochs = new Map<DeviceId, number>();
  const asked: Asked[] = [];
  let lastEpoch = 0;
  const transport = {
    connectionEpoch: (deviceId: DeviceId) => epochs.get(deviceId) ?? 0,
    sendCommand: ((deviceId: DeviceId, type: string) => {
      expect(type).toBe("source.descriptors");
      return new Promise((resolve, reject) => {
        asked.push({
          epoch: epochs.get(deviceId) ?? 0,
          resolve: (descriptors) => resolve({ descriptors, hostname: "host.example.com" }),
          reject,
        });
      });
    }) as unknown as CollectorDescriptorTransport["sendCommand"],
  };
  return {
    transport,
    asked,
    connect(deviceId = COLLECTOR) {
      epochs.set(deviceId, ++lastEpoch);
    },
    disconnect(deviceId = COLLECTOR) {
      epochs.delete(deviceId);
    },
  };
}

function cacheOver(fake: ReturnType<typeof fakeTransport>) {
  return new CollectorDescriptorCache({
    wsServer: () => fake.transport,
    firstAnswerWaitMs: 3_000,
    retryDelayMs: 5_000,
    maxRetryDelayMs: 20_000,
  });
}

const d = (id: string, name = id) => ({ id, name });

describe("CollectorDescriptorCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("connect → known: one question at connect, then every request answers from memory", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();

    cache.prefetch(COLLECTOR);
    expect(fake.asked).toHaveLength(1);
    fake.asked[0]!.resolve([d("notes-synth"), d("mail-synth")]);
    await vi.advanceTimersByTimeAsync(0);

    for (let i = 0; i < 5; i++) {
      expect(await cache.descriptorsFor(COLLECTOR)).toEqual([d("notes-synth"), d("mail-synth")]);
    }
    // The pin: a warm entry never sends `source.descriptors` again.
    expect(fake.asked).toHaveLength(1);
    cache.close();
  });

  test("a request with no entry asks once and waits for an answer inside the first-answer window", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();

    const pending = cache.descriptorsFor(COLLECTOR);
    const joined = cache.descriptorsFor(COLLECTOR);
    expect(fake.asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_500);
    fake.asked[0]!.resolve([d("notes-synth")]);

    expect(await pending).toEqual([d("notes-synth")]);
    expect(await joined).toEqual([d("notes-synth")]);
    expect(fake.asked).toHaveLength(1);
    cache.close();
  });

  test("a collector that has not answered by the end of the window is left out, and later requests do not wait for it", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);

    const first = cache.descriptorsFor(COLLECTOR);
    let settled = false;
    void first.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBeNull();

    // Past the window: answered at once, with nothing, and without asking again.
    const later = cache.descriptorsFor(COLLECTOR);
    let laterSettled = false;
    void later.then(() => (laterSettled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(laterSettled).toBe(true);
    expect(await later).toBeNull();
    expect(fake.asked).toHaveLength(1);

    // The collector finally answers: the next request finds it.
    fake.asked[0]!.resolve([d("notes-synth")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await cache.descriptorsFor(COLLECTOR)).toEqual([d("notes-synth")]);
    cache.close();
  });

  test("a failed question is asked again in the background, with backoff", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);

    fake.asked[0]!.reject(new Error("command source.descriptors timed out after 30000ms"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.asked).toHaveLength(2);

    fake.asked[1]!.reject(new Error("command source.descriptors timed out after 30000ms"));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fake.asked).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.asked).toHaveLength(3);

    fake.asked[2]!.resolve([d("notes-synth")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await cache.descriptorsFor(COLLECTOR)).toEqual([d("notes-synth")]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.asked).toHaveLength(3);
    cache.close();
  });

  test("reconnect (an update): the new build's set replaces the old one, adding and removing types", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);
    fake.asked[0]!.resolve([d("notes-synth"), d("retired-synth")]);
    await vi.advanceTimersByTimeAsync(0);

    fake.disconnect();
    cache.onDisconnected(COLLECTOR);
    fake.connect();
    cache.prefetch(COLLECTOR);
    expect(fake.asked).toHaveLength(2);
    fake.asked[1]!.resolve([d("notes-synth"), d("new-synth")]);

    expect(await cache.descriptorsFor(COLLECTOR)).toEqual([d("notes-synth"), d("new-synth")]);
    cache.close();
  });

  test("reconnect without any hook firing still never serves the previous connection's answer", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);
    fake.asked[0]!.resolve([d("retired-synth")]);
    await vi.advanceTimersByTimeAsync(0);

    // The epoch moves on with no prefetch or disconnect call: the read itself
    // notices, and asks the new connection.
    fake.disconnect();
    fake.connect();
    const answer = cache.descriptorsFor(COLLECTOR);
    expect(fake.asked).toHaveLength(2);
    fake.asked[1]!.resolve([d("new-synth")]);
    expect(await answer).toEqual([d("new-synth")]);
    cache.close();
  });

  test("an answer from a connection that has since been replaced is discarded", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);

    fake.disconnect();
    cache.onDisconnected(COLLECTOR);
    fake.connect();
    cache.prefetch(COLLECTOR);
    expect(fake.asked.map((a) => a.epoch)).toEqual([1, 2]);

    // The old connection's late answer lands first and must not be adopted.
    fake.asked[0]!.resolve([d("retired-synth")]);
    await vi.advanceTimersByTimeAsync(0);
    const answer = cache.descriptorsFor(COLLECTOR);
    fake.asked[1]!.resolve([d("new-synth")]);
    expect(await answer).toEqual([d("new-synth")]);
    cache.close();
  });

  test("disconnect: an offline collector has no descriptors, its entry is dropped and its retries stop", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);
    fake.asked[0]!.reject(new Error("command source.descriptors timed out after 30000ms"));
    await vi.advanceTimersByTimeAsync(0);

    fake.disconnect();
    cache.onDisconnected(COLLECTOR);
    expect(await cache.descriptorsFor(COLLECTOR)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.asked).toHaveLength(1);
    cache.close();
  });

  test("a retry whose connection went away without a disconnect call stops on its own", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);
    fake.asked[0]!.reject(new Error("command source.descriptors timed out after 30000ms"));
    await vi.advanceTimersByTimeAsync(0);

    fake.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.asked).toHaveLength(1);
    cache.close();
  });

  test("a second socket closing while another stays connected asks the remaining connection", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);
    fake.asked[0]!.resolve([d("notes-synth")]);
    await vi.advanceTimersByTimeAsync(0);

    // The socket server moves the epoch on when one of two sockets closes.
    fake.connect();
    cache.onDisconnected(COLLECTOR);
    expect(fake.asked).toHaveLength(2);
    fake.asked[1]!.resolve([d("notes-synth")]);
    expect(await cache.descriptorsFor(COLLECTOR)).toEqual([d("notes-synth")]);
    cache.close();
  });

  test("a question that fails because its connection closed is neither retried nor kept", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);

    fake.disconnect();
    fake.asked[0]!.reject(new Error("device disconnected"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.asked).toHaveLength(1);

    // Back online: a fresh question for the new connection.
    fake.connect();
    cache.prefetch(COLLECTOR);
    expect(fake.asked).toHaveLength(2);
    cache.close();
  });

  test("a device that is not connected is never asked", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    cache.prefetch(COLLECTOR);
    cache.onDisconnected(COLLECTOR);
    expect(await cache.descriptorsFor(COLLECTOR)).toBeNull();
    expect(fake.asked).toHaveLength(0);
    cache.close();
  });

  test("entries that are not objects are dropped from an answer", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);
    fake.asked[0]!.resolve([d("notes-synth"), null, "mail-synth", 7]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await cache.descriptorsFor(COLLECTOR)).toEqual([d("notes-synth")]);
    cache.close();
  });

  test("close stops pending retries and answers nothing afterwards", async () => {
    const fake = fakeTransport();
    const cache = cacheOver(fake);
    fake.connect();
    cache.prefetch(COLLECTOR);
    fake.asked[0]!.reject(new Error("gateway shutting down"));
    await vi.advanceTimersByTimeAsync(0);

    cache.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.asked).toHaveLength(1);
    expect(await cache.descriptorsFor(COLLECTOR)).toBeNull();
  });
});

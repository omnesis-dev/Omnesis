// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  CAPTURE_HANDOFF_MAX_RECORDS,
  captureHandoffKey,
  persistCaptureHandoff,
  persistCaptureHandoffGuarded,
  readPendingHandoffs,
  type HandoffStorage,
} from "./handoff-storage.js";
import { CAPTURE_HANDOFF_OVERFLOW_KEY } from "./messages.js";
import type { CaptureEmission } from "../capture/lifecycle.js";

function emission(url: string, hash: string): CaptureEmission {
  return {
    kind: "re-extract",
    normalizedUrl: url,
    title: "Fictional article",
    text: "Fictional body",
    contentHash: /^[a-f0-9]{64}$/.test(hash) ? hash : "a".repeat(64),
    visitedAt: "2026-01-01T00:00:00.000Z",
    dwellMs: 5_000,
    contentChanged: true,
  };
}

function memoryStorage(): HandoffStorage & { values: Record<string, unknown> } {
  const values: Record<string, unknown> = {};
  return {
    values,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        list.filter((key) => key in values).map((key) => [key, values[key]]),
      );
    },
    async getKeys() {
      return Object.keys(values);
    },
    async set(items) {
      Object.assign(values, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

describe("capture handoff storage", () => {
  it("uses distinct durable keys for re-extracts on different SPA routes", async () => {
    const first = await captureHandoffKey(
      "instance",
      emission("https://example.com/one", "a"),
      "first",
    );
    const second = await captureHandoffKey(
      "instance",
      emission("https://example.com/two", "b"),
      "second",
    );
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThan(256);
  });

  it("never reuses a durable key for overlapping same-hash title changes", async () => {
    const first = emission("https://example.com/article", "same-hash");
    const second = { ...first, title: "Updated fictional title" };
    const firstKey = await captureHandoffKey("instance", first, "first-emission");
    const secondKey = await captureHandoffKey("instance", second, "second-emission");
    expect(firstKey).not.toBe(secondKey);
  });

  it("keeps only the newest durable re-extract after out-of-order writes", async () => {
    const storage = memoryStorage();
    const oldEmission = emission("https://example.com/article", "same-hash");
    const newEmission = { ...oldEmission, title: "Updated fictional title" };
    const oldKey = await captureHandoffKey("instance", oldEmission, "0001");
    const newKey = await captureHandoffKey("instance", newEmission, "0002");
    await persistCaptureHandoff(storage, newKey, {
      at: 2,
      order: "0002",
      pairingId: "a".repeat(64),
      emission: newEmission,
    });
    // The older asynchronous write completes last. Observation order, not
    // completion order, keeps it from resurrecting stale content.
    await persistCaptureHandoff(storage, oldKey, {
      at: 1,
      order: "0001",
      pairingId: "a".repeat(64),
      emission: oldEmission,
    });
    const pending = await readPendingHandoffs(storage);
    expect(pending).toHaveLength(1);
    expect(pending[0].record?.emission.title).toBe("Updated fictional title");
  });

  it("bounds the outbox and reports discarded staged captures", async () => {
    const storage = memoryStorage();
    for (let index = 0; index <= CAPTURE_HANDOFF_MAX_RECORDS; index += 1) {
      const item = emission(`https://example.com/${index}`, String(index));
      const key = await captureHandoffKey("instance", item, `emission-${index}`);
      await persistCaptureHandoff(storage, key, {
        at: index,
        order: String(index).padStart(4, "0"),
        pairingId: "a".repeat(64),
        emission: item,
      });
    }
    const pending = await readPendingHandoffs(storage);
    expect(pending).toHaveLength(CAPTURE_HANDOFF_MAX_RECORDS);
    expect(pending[0].record?.emission.normalizedUrl).toBe("https://example.com/1");
    expect(JSON.parse(String(storage.values[CAPTURE_HANDOFF_OVERFLOW_KEY]))).toMatchObject({
      discarded: 1,
    });
  });

  it("removes a persistence that finishes after authorization is revoked", async () => {
    const storage = memoryStorage();
    const originalSet = storage.set;
    let releaseWrite: (() => void) | undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    storage.set = async (items) => {
      await writeGate;
      await originalSet(items);
    };
    const item = emission("https://example.com/private", "a");
    const key = await captureHandoffKey("instance", item, "0001");
    let authorized = true;
    const persistence = persistCaptureHandoffGuarded(
      storage,
      key,
      { at: 1, order: "0001", pairingId: "a".repeat(64), emission: item },
      () => authorized,
    );

    authorized = false;
    releaseWrite?.();
    await persistence;

    expect(storage.values[key]).toBeUndefined();
  });

  it("removes a revoked body even when post-write bookkeeping fails", async () => {
    const storage = memoryStorage();
    const originalGetKeys = storage.getKeys;
    let failBookkeeping = true;
    storage.getKeys = () => {
      if (failBookkeeping) {
        failBookkeeping = false;
        return Promise.reject(new Error("fictional bookkeeping failure"));
      }
      return originalGetKeys();
    };
    const item = emission("https://example.com/private-bookkeeping", "b");
    const key = await captureHandoffKey("instance", item, "0002");

    await expect(
      persistCaptureHandoffGuarded(
        storage,
        key,
        { at: 2, order: "0002", pairingId: "a".repeat(64), emission: item },
        () => false,
      ),
    ).rejects.toThrow("fictional bookkeeping failure");
    expect(storage.values[key]).toBeUndefined();
  });
});

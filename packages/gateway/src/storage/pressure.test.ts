// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { gatewayStoragePolicySchema } from "@omnesis/config";
import {
  StoragePressureManager,
  resolveStoragePolicy,
  type StorageMeasurement,
  type StoragePolicy,
} from "./pressure.js";

function setup() {
  let now = 1000;
  let policy: StoragePolicy = { ...resolveStoragePolicy(undefined, 0), maxBytes: 1000 };
  let measurement: StorageMeasurement = {
    usageBytes: 100,
    measuredAt: now,
    volumes: [{ id: "one", totalBytes: 10000, availableBytes: 5000 }],
  };
  const measure = vi.fn(async () => measurement);
  const manager = new StoragePressureManager({ getPolicy: () => policy, measure, now: () => now });
  return {
    manager,
    measure,
    setPolicy: (patch: Partial<typeof policy>) => {
      policy = { ...policy, ...patch };
    },
    sample: async (patch: Partial<StorageMeasurement> = {}) => {
      measurement = { ...measurement, ...patch, measuredAt: now };
      await manager.refresh();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("capacity admission", () => {
  it("fails closed until measured, without authorizing any deletion", async () => {
    const { manager, sample } = setup();
    expect(manager.snapshot().state).toBe("unknown");
    expect(() => manager.assertCanGrow()).toThrow(/cannot be verified/);
    await sample();
    expect(manager.snapshot().state).toBe("normal");
    expect(() => manager.assertCanGrow()).not.toThrow();
  });

  it("warns before quota, blocks at its boundary, and needs recovery margin", async () => {
    const s = setup();
    await s.sample({ usageBytes: 900 });
    expect(s.manager.snapshot().state).toBe("warning");
    await s.sample({ usageBytes: 1000 });
    expect(s.manager.snapshot()).toMatchObject({ state: "blocked", reasons: ["quota"] });
    expect(() => s.manager.assertCanGrow()).toThrow(/Storage limit reached/);
    await s.sample({ usageBytes: 990 });
    expect(s.manager.snapshot().state).toBe("blocked");
    await s.sample({ usageBytes: 979 });
    expect(s.manager.snapshot().state).toBe("warning");
    expect(() => s.manager.assertCanGrow()).not.toThrow();
  });

  it("checks every volume even without a gateway quota", async () => {
    const s = setup();
    s.setPolicy({ maxBytes: null });
    await s.sample({
      volumes: [
        { id: "main", totalBytes: 10000, availableBytes: 5000 },
        { id: "index", totalBytes: 10000, availableBytes: 500 },
      ],
    });
    expect(s.manager.snapshot()).toMatchObject({ state: "blocked", reasons: ["disk-used"] });
    await s.sample({ volumes: [{ id: "index", totalBytes: 10000, availableBytes: 600 }] });
    expect(s.manager.snapshot().state).toBe("blocked");
    await s.sample({ volumes: [{ id: "index", totalBytes: 10000, availableBytes: 710 }] });
    expect(s.manager.snapshot().state).toBe("warning");
  });

  it("keeps the absolute reserve independent of quota and disk percentage", async () => {
    const s = setup();
    s.setPolicy({ maxBytes: null, minFreeBytes: 1000 });
    await s.sample({ volumes: [{ id: "one", totalBytes: 2000, availableBytes: 999 }] });
    expect(s.manager.snapshot()).toMatchObject({ state: "blocked", reasons: ["disk-reserve"] });
    await s.sample({ volumes: [{ id: "one", totalBytes: 2000, availableBytes: 1050 }] });
    expect(s.manager.snapshot().state).toBe("blocked");
    await s.sample({ volumes: [{ id: "one", totalBytes: 2000, availableBytes: 1100 }] });
    expect(s.manager.snapshot().state).toBe("warning");
  });

  it("fails closed on stale or failed measurements and recovers on success", async () => {
    const s = setup();
    await s.sample();
    s.advance(120000);
    expect(s.manager.snapshot().state).toBe("unknown");
    expect(() => s.manager.assertCanGrow()).toThrow();
    await s.sample();
    expect(s.manager.snapshot().state).toBe("normal");
    s.measure.mockRejectedValueOnce(new Error("unreadable"));
    await s.manager.refresh();
    expect(s.manager.snapshot().state).toBe("unknown");
    await s.sample();
    expect(s.manager.snapshot().state).toBe("normal");
  });

  it.each([
    { usageBytes: NaN },
    { usageBytes: -1 },
    { volumes: [] },
    { volumes: [{ id: "x", totalBytes: 0, availableBytes: 0 }] },
    { volumes: [{ id: "x", totalBytes: 100, availableBytes: Infinity }] },
    { volumes: [{ id: "x", totalBytes: 100, availableBytes: 101 }] },
  ])("refuses invalid measurement %j", async (patch) => {
    const s = setup();
    await s.sample(patch);
    expect(s.manager.snapshot().state).toBe("unknown");
  });

  it("coalesces concurrent inventories", async () => {
    const s = setup();
    const one = s.manager.refresh();
    const two = s.manager.refresh();
    expect(one).toBe(two);
    await Promise.all([one, two]);
    expect(s.measure).toHaveBeenCalledTimes(1);
  });

  it("applies a quota change immediately without remeasuring or weakening the disk guard", async () => {
    const s = setup();
    await s.sample({ usageBytes: 1000 });
    s.setPolicy({ maxBytes: null });
    expect(s.manager.snapshot().state).toBe("normal");
    s.setPolicy({ maxBytes: 500 });
    expect(s.manager.snapshot().state).toBe("blocked");
  });
});

describe("storage configuration", () => {
  it("accepts an explicit unlimited quota and rejects unsafe or duplicate policy input", () => {
    expect(gatewayStoragePolicySchema.parse({ maxBytes: null })).toEqual({ maxBytes: null });
    for (const invalid of [
      { maxBytes: 0 },
      { maxBytes: -1 },
      { maxBytes: Infinity },
      { maxDiskUsedPercent: 100 },
      { retention: [{ sourceId: "example", maxAgeDays: 0 }] },
      {
        retention: [
          { sourceId: "example", maxAgeDays: 3 },
          { sourceId: "example", maxAgeDays: 4 },
        ],
      },
    ])
      expect(gatewayStoragePolicySchema.safeParse(invalid).success).toBe(false);
  });
});

it("preflights bounded growth against quota and independent disk reserves", async () => {
  const s = setup();
  await s.sample({ usageBytes: 800 });
  expect(() => s.manager.assertCanGrow(199)).not.toThrow();
  expect(() => s.manager.assertCanGrow(200)).toThrow(/would exceed/);
  expect(() => s.manager.assertCanGrow(-1)).toThrow(/Invalid growth size/);
  s.setPolicy({ maxBytes: null, minFreeBytes: 1000 });
  await s.sample({ volumes: [{ id: "one", totalBytes: 10000, availableBytes: 1200 }] });
  expect(() => s.manager.assertCanGrow(201)).toThrow(/would exceed/);
  expect(() => s.manager.assertCanGrow(200)).not.toThrow();
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { brokerOwner, memoryStore } from "../test/dns-broker-owner.js";
import { BrokerAdmissionBudget } from "./dns-broker-admission-budget.js";

function fixture() {
  const store = memoryStore();
  const clock = { now: 100_000 };
  const capacity = vi.fn(async () => ({
    usage: 0,
    quota: 200,
    recordsPerName: 3,
    managedRecords: {},
  }));
  const budget = new BrokerAdmissionBudget({ store, capacity, now: () => clock.now });
  return { store, clock, capacity, budget };
}

test("validates limits and provider capacity rather than trusting malformed quota snapshots", async () => {
  const f = fixture();
  expect(
    () =>
      new BrokerAdmissionBudget({
        store: f.store,
        capacity: f.capacity,
        now: () => 1,
        limits: { totalPerDay: 0 },
      }),
  ).toThrow("positive integers");
  for (const patch of [
    { usage: -1 },
    { usage: 0.1 },
    { quota: 0 },
    { quota: 0.1 },
    { recordsPerName: 1 },
    { recordsPerName: 17 },
    { recordsPerName: 2.1 },
  ]) {
    const budget = new BrokerAdmissionBudget({
      store: f.store,
      now: () => 1,
      capacity: async () => ({ ...(await f.capacity()), ...patch }),
    });
    await expect(budget.capacity()).rejects.toMatchObject({ code: "dns-capacity-unavailable" });
  }
  const bad = new BrokerAdmissionBudget({
    store: f.store,
    now: () => 1,
    capacity: async () => {
      throw new Error("provider offline");
    },
  });
  await expect(bad.capacity()).rejects.toMatchObject({ code: "dns-capacity-unavailable" });
});

test("migrates active bindings once, preserves pending allocations and prunes released or missing identities", async () => {
  const f = fixture();
  await f.store.put("name:active", { accountUri: "https://acme.example.test/1" });
  await f.store.put("name:already", { accountUri: "https://acme.example.test/2" });
  await f.store.put("allocation:already", { publishedAt: 12 });
  await f.store.put("name:released", { released: true });
  await f.store.put("allocation:released", {});
  await f.store.put("allocation:missing", {});
  await f.store.put("name:pending", {});
  await f.store.put("allocation:pending", { expiresAt: 200_000 });
  await Promise.all([f.budget.initialize(), f.budget.initialize()]);
  expect(await f.store.get("allocation:active")).toEqual({ publishedAt: 0 });
  expect(await f.store.get("allocation:already")).toEqual({ publishedAt: 12 });
  expect(await f.store.get("allocation:pending")).toEqual({ expiresAt: 200_000 });
  expect(await f.store.get("allocation:released")).toBeUndefined();
  expect(await f.store.get("allocation:missing")).toBeUndefined();
  const list = vi.spyOn(f.store, "list");
  await new BrokerAdmissionBudget({
    store: f.store,
    capacity: f.capacity,
    now: () => f.clock.now,
  }).initialize();
  expect(list).not.toHaveBeenCalled();
});

test("caches and singleflights fresh provider snapshots, then refetches after time or writes", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.budget.capacity(), f.budget.capacity()]);
  expect(first).toBe(second);
  expect(await f.budget.capacity()).toBe(first);
  expect(f.capacity).toHaveBeenCalledTimes(1);
  f.clock.now += 15_000;
  expect(await f.budget.capacity()).not.toBe(first);
  f.budget.mutation();
  expect(await f.budget.capacity()).not.toBe(first);
  expect(f.capacity).toHaveBeenCalledTimes(3);
  await expect(
    f.budget.reserve(brokerOwner().request({ type: "claim" }), "net", "owner", first),
  ).rejects.toMatchObject({ code: "dns-capacity-retry" });
});

test("distinguishes current, expired and permanent entitlement without reviving released names", async () => {
  const f = fixture();
  expect(await f.budget.hasAllocation("name", { released: true, accountUri: "uri" })).toBe(false);
  expect(await f.budget.hasAllocation("name", { accountUri: "uri" })).toBe(true);
  expect(await f.budget.hasAllocation("name", {})).toBe(false);
  await f.store.put("allocation:name", { expiresAt: f.clock.now });
  expect(await f.budget.hasAllocation("name", {})).toBe(false);
  await f.store.put("allocation:name", { expiresAt: f.clock.now + 1 });
  expect(await f.budget.hasAllocation("name", {})).toBe(true);
  await f.store.put("allocation:name", {});
  expect(await f.budget.hasAllocation("name", {})).toBe(true);
});

test("expires only timed reservations and counters, preserving permanent publication capacity", async () => {
  const f = fixture();
  await f.store.put("allocation:permanent", {});
  await f.store.put("allocation:expired", { expiresAt: f.clock.now });
  await f.store.put("allocation:later", { expiresAt: f.clock.now + 2 });
  await f.store.put("budget:expired", { count: 1, expiresAt: f.clock.now - 1 });
  await f.store.put("budget:later", { count: 2, expiresAt: f.clock.now + 1 });
  expect(await f.budget.expire()).toBe(f.clock.now + 1);
  expect(await f.store.get("allocation:permanent")).toEqual({});
  expect(await f.store.get("allocation:expired")).toBeUndefined();
  expect(await f.store.get("budget:expired")).toBeUndefined();
  f.clock.now += 3;
  expect(await f.budget.expire()).toBeUndefined();
});

test("separate daily and network budgets reject before charging other counters", async () => {
  const f = fixture();
  const budget = new BrokerAdmissionBudget({
    store: f.store,
    capacity: f.capacity,
    now: () => f.clock.now,
    renewalSlots: 1,
    limits: { totalPerDay: 1 },
  });
  await f.store.put("allocation:expired", { expiresAt: f.clock.now });
  await f.store.put("allocation:published", { publishedAt: 0 });
  await f.store.put("allocation:partial", {});
  await f.store.put("allocation:drifted", { publishedAt: 0 });
  const snapshot = await budget.capacity();
  snapshot.managedRecords = { published: 99 };
  await budget.reserve(brokerOwner().request({ type: "claim" }), "network1", "owner1", snapshot);
  const before = structuredClone(f.store.values);
  await expect(
    budget.reserve(brokerOwner().request({ type: "claim" }), "network2", "owner2", snapshot),
  ).rejects.toMatchObject({ code: "dns-allocation-rate" });
  expect(f.store.values).toEqual(before);
  const tiny = new BrokerAdmissionBudget({
    store: memoryStore(),
    capacity: async () => ({ usage: 1, quota: 2, recordsPerName: 2, managedRecords: {} }),
    now: () => f.clock.now,
  });
  await expect(
    tiny.reserve(
      brokerOwner().request({ type: "claim" }),
      "network",
      "owner",
      await tiny.capacity(),
    ),
  ).rejects.toMatchObject({ code: "dns-capacity" });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { brokerOwner, memoryStore } from "../test/dns-broker-owner.js";
import { DnsPublicOperations } from "./dns-broker-public-operations.js";
import { BrokerAdmissionBudget } from "./dns-broker-admission-budget.js";
import type { BrokerEntry } from "./dns-broker-core.js";

const account = "https://acme.example.test/acct/123";
async function fixture() {
  const owner = brokerOwner();
  const store = memoryStore();
  const clock = { now: 100_000 };
  const entry: BrokerEntry = {
    gatewayId: owner.gatewayId,
    ownerPublicKey: owner.ownerPublicKey,
    claimedAt: 1,
    source: "claim",
  };
  await store.put(`name:${owner.hostname}`, entry);
  await store.put(`allocation:${owner.hostname}`, {});
  const zone = {
    createTxt: vi.fn(async () => {}),
    removeTxt: vi.fn(async () => {}),
    publishName: vi.fn(async () => {}),
    removeName: vi.fn(async () => {}),
  };
  const budget = new BrokerAdmissionBudget({
    store,
    now: () => clock.now,
    capacity: async () => ({ usage: 0, quota: 200, recordsPerName: 3, managedRecords: {} }),
  });
  const claim = vi.fn(async () => ({ claimed: true }));
  const options = {
    store,
    zone,
    budget,
    now: () => clock.now,
    serialize: async <T>(run: () => Promise<T>) => run(),
    entry: async (hostname: string) =>
      (await store.get(`name:${hostname}`)) as BrokerEntry | undefined,
    claim,
    maxLeases: 2,
    leaseTtlMs: 1000,
    issuer: "letsencrypt.org",
    accountUriPrefix: "https://acme.example.test/acct/",
  };
  const ops = new DnsPublicOperations(options);
  return { owner, store, clock, entry, zone, budget, claim, options, ops };
}

test("enforces exact ownership and active entitlement before writes; idempotent operations stay harmless", async () => {
  const f = await fixture();
  await expect(f.ops.run(brokerOwner().request({ type: "claim" }))).rejects.toMatchObject({
    code: "name-owned-by-another-key",
  });
  await expect(
    f.ops.run({ ...f.owner.request({ type: "claim" }), gatewayId: crypto.randomUUID() }),
  ).rejects.toMatchObject({ code: "name-owned-by-another-key" });
  await expect(
    f.ops.run({
      ...f.owner.request({ type: "claim" }),
      ownerPublicKey: brokerOwner().ownerPublicKey,
    }),
  ).rejects.toMatchObject({ code: "name-owned-by-another-key" });
  expect(await f.ops.run(f.owner.request({ type: "claim" }))).toEqual({ claimed: true });
  expect(f.claim).toHaveBeenCalledOnce();
  expect(
    await f.ops.run(f.owner.request({ type: "txt-remove", leaseId: crypto.randomUUID() })),
  ).toEqual({ removed: true });
  await f.store.delete(`allocation:${f.owner.hostname}`);
  await expect(
    f.ops.run(f.owner.request({ type: "caa", accountUri: account })),
  ).rejects.toMatchObject({ code: "name-admission-required" });
  await f.store.put(`name:${f.owner.hostname}`, { ...f.entry, released: true });
  expect(await f.ops.run(f.owner.request({ type: "release" }))).toEqual({ released: true });
  await expect(
    f.ops.run(f.owner.request({ type: "txt-create", value: "abc" })),
  ).rejects.toMatchObject({ code: "name-admission-required" });
  expect(f.zone.removeName).not.toHaveBeenCalled();
});

test("rejects foreign leases and invalid CAA account namespaces without touching DNS", async () => {
  const f = await fixture();
  const id = crypto.randomUUID();
  await f.store.put(`lease:${id}`, {
    id,
    hostname: brokerOwner().hostname,
    value: "abc",
    expiresAt: 1,
  });
  await expect(
    f.ops.run(f.owner.request({ type: "txt-remove", leaseId: id })),
  ).rejects.toMatchObject({ code: "lease-of-another-name" });
  for (const accountUri of ["https://other.example.test/acct/123", f.options.accountUriPrefix])
    await expect(f.ops.run(f.owner.request({ type: "caa", accountUri }))).rejects.toMatchObject({
      code: "account-not-accepted",
    });
  expect(f.zone.publishName).not.toHaveBeenCalled();
});

test("retains failed publication entitlement and safely removes only the released owner's leases", async () => {
  const f = await fixture();
  f.zone.publishName.mockRejectedValueOnce(new Error("partial write"));
  await expect(
    f.ops.run(f.owner.request({ type: "caa", accountUri: account })),
  ).rejects.toMatchObject({ code: "dns-publication-failed" });
  expect(await f.store.get(`allocation:${f.owner.hostname}`)).toEqual({});
  const own = { id: crypto.randomUUID(), hostname: f.owner.hostname, value: "abc", expiresAt: 1 };
  const foreign = { ...own, id: crypto.randomUUID(), hostname: brokerOwner().hostname };
  await f.store.put(`lease:${own.id}`, own);
  await f.store.put(`lease:${foreign.id}`, foreign);
  f.zone.removeName.mockRejectedValueOnce(new Error("provider offline"));
  await expect(f.ops.run(f.owner.request({ type: "release" }))).rejects.toMatchObject({
    code: "dns-removal-failed",
  });
  expect(await f.store.get(`name:${f.owner.hostname}`)).toEqual(f.entry);
  expect(await f.store.get(`lease:${foreign.id}`)).toEqual(foreign);
  expect(await f.ops.run(f.owner.request({ type: "release" }))).toEqual({ released: true });
  expect(await f.store.get(`allocation:${f.owner.hostname}`)).toBeUndefined();
  expect(await f.store.get(`name:${f.owner.hostname}`)).toEqual({ ...f.entry, released: true });
});

test("limits TXT starts, retains failed cleanup journals and recovers them through maintenance", async () => {
  const f = await fixture();
  f.zone.createTxt.mockRejectedValue(new Error("offline"));
  f.zone.removeTxt.mockRejectedValue(new Error("offline"));
  await expect(
    f.ops.run(f.owner.request({ type: "txt-create", value: "abc" })),
  ).rejects.toMatchObject({ code: "dns-publication-failed" });
  f.clock.now += 1001;
  expect(await f.ops.expireLeases()).toBe(f.clock.now + 60_000);
  f.zone.removeTxt.mockResolvedValue();
  expect(await f.ops.expireLeases()).toBeUndefined();
  f.zone.createTxt.mockResolvedValue();
  for (let i = 0; i < 5; i++) {
    const lease = (await f.ops.run(f.owner.request({ type: "txt-create", value: "abc" }))) as {
      id: string;
    };
    await f.ops.run(f.owner.request({ type: "txt-remove", leaseId: lease.id }));
  }
  await expect(
    f.ops.run(f.owner.request({ type: "txt-create", value: "abc" })),
  ).rejects.toMatchObject({ code: "name-provider-rate" });
  f.clock.now += 3_600_000;
  const lease = (await f.ops.run(f.owner.request({ type: "txt-create", value: "abc" }))) as {
    id: string;
    expiresAt: number;
  };
  expect(await f.ops.expireLeases()).toBe(lease.expiresAt);
});

test("rechecks entitlement immediately before provider work and caps zone-wide lease inventory", async () => {
  const f = await fixture();
  let calls = 0;
  f.options.entry = async () => (++calls === 1 ? f.entry : { ...f.entry, released: true });
  const ops = new DnsPublicOperations(f.options);
  await expect(
    ops.run(f.owner.request({ type: "caa", accountUri: account })),
  ).rejects.toMatchObject({ code: "name-admission-required" });
  f.options.entry = async () => f.entry;
  const fresh = new DnsPublicOperations({ ...f.options, maxLeases: 1 });
  const foreign = {
    id: crypto.randomUUID(),
    hostname: brokerOwner().hostname,
    value: "abc",
    expiresAt: f.clock.now + 100,
  };
  await f.store.put(`lease:${foreign.id}`, foreign);
  await expect(
    fresh.run(f.owner.request({ type: "txt-create", value: "abc" })),
  ).rejects.toMatchObject({ code: "lease-capacity" });
});

test("provider concurrency is bounded independently in the configuration and TXT lanes", async () => {
  const f = await fixture();
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const configurationEntered = Promise.withResolvers<void>();
  const txtEntered = Promise.withResolvers<void>();
  let configurationCalls = 0;
  let txtCalls = 0;
  f.zone.publishName.mockImplementation(async () => {
    if (++configurationCalls === 2) configurationEntered.resolve();
    await blocked;
  });
  f.zone.createTxt.mockImplementation(async () => {
    if (++txtCalls === 8) txtEntered.resolve();
    await blocked;
  });
  const owners = Array.from({ length: 12 }, () => brokerOwner());
  for (const owner of owners) {
    await f.store.put(`name:${owner.hostname}`, {
      ...f.entry,
      gatewayId: owner.gatewayId,
      ownerPublicKey: owner.ownerPublicKey,
    });
    await f.store.put(`allocation:${owner.hostname}`, {});
  }
  const ops = new DnsPublicOperations({ ...f.options, maxLeases: 32 });
  const pending = owners
    .slice(0, 2)
    .map((owner) => ops.run(owner.request({ type: "caa", accountUri: account })));
  const txt: Promise<unknown>[] = [];
  try {
    await configurationEntered.promise;
    await expect(
      ops.run(owners[0]!.request({ type: "txt-create", value: "abc" })),
    ).rejects.toMatchObject({ code: "name-operation-busy" });
    await expect(
      ops.run(owners[0]!.request({ type: "caa", accountUri: `${f.options.accountUriPrefix}999` })),
    ).rejects.toMatchObject({ code: "name-operation-busy" });
    await expect(
      ops.run(owners[2]!.request({ type: "caa", accountUri: account })),
    ).rejects.toMatchObject({ code: "dns-provider-busy" });
    txt.push(
      ...owners
        .slice(3, 11)
        .map((owner) => ops.run(owner.request({ type: "txt-create", value: "abc" }))),
    );
    await txtEntered.promise;
    await expect(
      ops.run(owners[11]!.request({ type: "txt-create", value: "abc" })),
    ).rejects.toMatchObject({ code: "dns-provider-busy" });
  } finally {
    finish();
    await Promise.all([...pending, ...txt]);
  }
});

test("maintenance does not join a name already publishing and retries its lease after the owner finishes", async () => {
  const f = await fixture();
  const lease = { id: crypto.randomUUID(), hostname: f.owner.hostname, value: "abc", expiresAt: 1 };
  await f.store.put(`lease:${lease.id}`, lease);
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entered = Promise.withResolvers<void>();
  f.zone.publishName.mockImplementationOnce(async () => {
    entered.resolve();
    await blocked;
  });
  const pending = f.ops.run(f.owner.request({ type: "caa", accountUri: account }));
  try {
    await entered.promise;
    expect(await f.ops.expireLeases()).toBe(f.clock.now + 60_000);
    expect(f.zone.removeTxt).not.toHaveBeenCalled();
  } finally {
    finish();
    await pending;
  }
  expect(await f.ops.expireLeases()).toBeUndefined();
  expect(f.zone.removeTxt).toHaveBeenCalledOnce();
});

test("CAA cache respects time reversal, account change cooldown and periodic provider reassertion", async () => {
  const f = await fixture();
  await f.store.put(`name:${f.owner.hostname}`, {
    ...f.entry,
    accountUri: account,
    caaPublishedAt: f.clock.now + 1,
  });
  // A future timestamp must not indefinitely suppress provider repair for the same account.
  expect(await f.ops.run(f.owner.request({ type: "caa", accountUri: account }))).toEqual({
    caa: true,
  });
  expect(f.zone.publishName).toHaveBeenCalledOnce();
  await expect(
    f.ops.run(f.owner.request({ type: "caa", accountUri: `${f.options.accountUriPrefix}456` })),
  ).rejects.toMatchObject({ code: "name-provider-rate" });
  f.clock.now += 600_001;
  expect(
    await f.ops.run(
      f.owner.request({ type: "caa", accountUri: `${f.options.accountUriPrefix}456` }),
    ),
  ).toEqual({ caa: true });
  f.clock.now += 3_600_000;
  expect(
    await f.ops.run(
      f.owner.request({ type: "caa", accountUri: `${f.options.accountUriPrefix}456` }),
    ),
  ).toEqual({ caa: true });
  expect(f.zone.publishName).toHaveBeenCalledTimes(3);
});

test("late operation and maintenance completion cannot clear a newer name owner", async () => {
  const f = await fixture();
  // Fault injection models a future cancellation handover while a provider ignores abort.
  // The ownership check must remain safe even if the original promise settles afterwards.
  const names = (
    f.ops as unknown as { names: Map<string, { digest: string; promise: Promise<unknown> }> }
  ).names;
  for (const cleanup of [false, true]) {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const replacement = { digest: "new-owner", promise: Promise.resolve() };
    let pending: Promise<unknown>;
    if (cleanup) {
      const lease = {
        id: crypto.randomUUID(),
        hostname: f.owner.hostname,
        value: "abc",
        expiresAt: 1,
      };
      await f.store.put(`lease:${lease.id}`, lease);
      f.zone.removeTxt.mockImplementationOnce(async () => {
        entered.resolve();
        await finish.promise;
      });
      pending = f.ops.expireLeases();
    } else {
      f.zone.publishName.mockImplementationOnce(async () => {
        entered.resolve();
        await finish.promise;
      });
      pending = f.ops.run(f.owner.request({ type: "caa", accountUri: account }));
    }
    try {
      await entered.promise;
      names.set(f.owner.hostname, replacement);
    } finally {
      finish.resolve();
      await pending;
    }
    expect(names.get(f.owner.hostname)).toBe(replacement);
    names.delete(f.owner.hostname);
  }
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { AcmeDnsChallenges, type DnsChallengeLease } from "./acme-dns.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-dns-challenge-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const owner = "a".repeat(64),
  hostname = "g-user.relay.example.test",
  value = "a".repeat(43);
function fixture() {
  const create = vi.fn(async (_lease: DnsChallengeLease, _signal: AbortSignal) => {});
  const remove = vi.fn(async (_lease: DnsChallengeLease, _signal: AbortSignal) => {});
  const options = {
    file: join(directory, "journal.json"),
    suffix: "relay.example.test",
    provider: { create, remove },
  };
  return { create, remove, options };
}
test("only exact gateway TXT leases are durable, bounded, owner scoped and idempotently cleaned", async () => {
  const f = fixture(),
    service = await AcmeDnsChallenges.open({ ...f.options, maxLeases: 1 });
  try {
    for (const bad of [
      "relay.example.test",
      "relay.example.test.evil.test",
      "*.relay.example.test",
      "evil.test",
      "_acme-challenge.bad",
    ])
      await expect(service.create(owner, bad, value)).rejects.toThrow();
    await expect(service.create(owner, hostname, "invalid")).rejects.toThrow();
    const lease = await service.create(owner, hostname, value);
    expect(lease).toEqual({ id: expect.any(String), expiresAt: expect.any(Number) });
    expect((await stat(f.options.file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(f.options.file, "utf8"))).toEqual([
      expect.objectContaining({ ...lease, accountId: owner, hostname, value }),
    ]);
    await expect(service.create(owner, hostname, value)).rejects.toThrow("capacity");
    await expect(service.create("b".repeat(64), "other.relay.example.test", value)).rejects.toThrow(
      "capacity",
    );
    await expect(service.remove("b".repeat(64), lease.id)).rejects.toThrow("another gateway");
    await service.remove(owner, randomUUID());
    await service.remove(owner, lease.id);
    await service.remove(owner, lease.id);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(f.options.file, "utf8"))).toEqual([]);
  } finally {
    await service.close();
  }
  await expect(service.create(owner, hostname, value)).rejects.toThrow("closed");
});
test("expiry frees capacity and process restart cleans abandoned creation intents before accepting further challenges", async () => {
  const f = fixture(),
    service = await AcmeDnsChallenges.open({ ...f.options, ttlMs: 50 });
  const first = await service.create(owner, hostname, value);
  vi.useFakeTimers({ toFake: ["Date"], now: first.expiresAt });
  await service.expire();
  expect(f.remove).toHaveBeenCalledOnce();
  const second = await service.create(owner, hostname, value);
  expect(second.id).not.toBe(first.id);
  f.remove.mockRejectedValueOnce(new Error("provider offline"));
  await expect(service.close()).rejects.toThrow("offline");
  const restarted = await AcmeDnsChallenges.open(f.options);
  expect(f.remove).toHaveBeenCalledTimes(3);
  expect(JSON.parse(await readFile(f.options.file, "utf8"))).toEqual([]);
  await restarted.close();
});
test("publication errors clean uncertain provider records while failed cleanup remains journaled for restart", async () => {
  const f = fixture(),
    service = await AcmeDnsChallenges.open(f.options);
  f.create.mockRejectedValue(new Error("provider-create-sensitive-secret"));
  try {
    await expect(service.create(owner, hostname, value)).rejects.toThrow("publication failed");
    expect(JSON.parse(await readFile(f.options.file, "utf8"))).toEqual([]);
    f.remove.mockRejectedValueOnce(new Error("offline"));
    await expect(service.create(owner, hostname, value)).rejects.toThrow("publication failed");
    expect(JSON.parse(await readFile(f.options.file, "utf8"))).toHaveLength(1);
  } finally {
    await service.close();
  }
});
test("invalid journals/limits fail closed and a failed durable intent write never reaches the DNS provider", async () => {
  const f = fixture();
  for (const limits of [{ ttlMs: 0 }, { ttlMs: 600001 }, { maxLeases: 0 }, { maxLeases: 33 }])
    await expect(AcmeDnsChallenges.open({ ...f.options, ...limits })).rejects.toThrow("limits");
  await writeFile(f.options.file, "invalid JSON");
  await expect(AcmeDnsChallenges.open(f.options)).rejects.toThrow("journal");
  await rm(f.options.file);
  const service = await AcmeDnsChallenges.open(f.options);
  await rm(directory, { recursive: true });
  // A regular file where the parent directory belongs makes atomic publication fail.
  await writeFile(directory, "not a directory");
  try {
    await expect(service.create(owner, hostname, value)).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await rm(directory);
  }
});

test("admission is bounded before serialization per account and globally, while expiry coalesces", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.create.mockImplementationOnce(async () => gate);
  const service = await AcmeDnsChallenges.open(f.options);
  const first = service.create(owner, hostname, value),
    queued = [service.remove(owner, randomUUID())];
  await expect(service.create(owner, hostname, value)).rejects.toThrow("admission");
  for (let index = 1; index <= 6; index++)
    queued.push(service.remove(String(index).repeat(64), randomUUID()));
  await expect(service.remove("f".repeat(64), randomUUID())).rejects.toThrow("admission");
  const expiry = service.expire();
  expect(service.expire()).toBe(expiry);
  release();
  await first;
  await Promise.all(queued);
  await expiry;
  await service.close();
});

test("owned-zone apex is an explicit local option and expired leases are swept before replacement", async () => {
  const f = fixture(),
    service = await AcmeDnsChallenges.open({ ...f.options, allowApex: true, ttlMs: 1 });
  try {
    await service.create(owner, "relay.example.test", value);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 });
    await service.create(owner, hostname, value);
    expect(f.remove).toHaveBeenCalledOnce();
    await service.expire();
  } finally {
    await service.close();
  }
});

test("the periodic expiry worker contains provider failures and retries retained intents", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    service = await AcmeDnsChallenges.open({ ...f.options, ttlMs: 1 });
  try {
    await service.create(owner, hostname, value);
    f.remove.mockRejectedValueOnce(new Error("temporary cleanup failure"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.remove).toHaveBeenCalledOnce();
    await service.expire();
    expect(f.remove).toHaveBeenCalledTimes(2);
  } finally {
    await service.close();
  }
});

test("local issuer cancellation never continues a queued/publication operation and cleanup gets an independent deadline", async () => {
  const f = fixture(),
    service = await AcmeDnsChallenges.open(f.options),
    cancelled = new AbortController();
  cancelled.abort(new Error("issuer cancelled"));
  try {
    await expect(service.create(owner, hostname, value, cancelled.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(f.create).not.toHaveBeenCalled();
    const active = new AbortController();
    f.create.mockImplementationOnce(async (_lease, signal) => {
      active.abort(new Error("issuance cancelled"));
      expect(signal.aborted).toBe(true);
    });
    await expect(service.create(owner, hostname, value, active.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.remove.mock.calls[0][1].aborted).toBe(false);
    expect(JSON.parse(await readFile(f.options.file, "utf8"))).toEqual([]);
  } finally {
    await service.close();
  }
});

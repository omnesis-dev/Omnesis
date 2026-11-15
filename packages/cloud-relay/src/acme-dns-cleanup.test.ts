// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as privateCredentials from "./google-credentials.js";
import { AcmeDnsChallenges } from "./acme-dns.js";

afterEach(() => vi.restoreAllMocks());
const owner = "a".repeat(64);
const hostname = "g-fictional.relay.example.test";
const value = "b".repeat(43);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "acme-dns-join-"));
  const file = join(directory, "journal.json");
  // Substitute only private helper boundaries; no worker can remain unjoined.
  vi.spyOn(privateCredentials, "readPrivateJson").mockRejectedValueOnce(
    Object.assign(new Error("Invented absent journal"), { code: "ENOENT" }),
  );
  const provider = { create: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  const service = await AcmeDnsChallenges.open({ file, suffix: "relay.example.test", provider });
  return { directory, file, provider, service };
}

test.each([
  { phase: "initial", nested: false },
  { phase: "initial", nested: true },
  { phase: "recovery", nested: false },
  { phase: "recovery", nested: true },
])(
  "unjoined $phase journal publication stops queued/future mutations and close cleanup ($nested)",
  async ({ phase, nested }) => {
    const { directory, file, provider, service } = await fixture();
    const marker = { cleanupFailure: undefined };
    const failure = nested
      ? new Error("Invented publication helper refusal", { cause: marker })
      : marker;
    if (phase === "recovery")
      provider.create.mockRejectedValueOnce(new Error("Invented joined provider refusal"));
    let entered!: () => void;
    const publishing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let fail!: (error: unknown) => void;
    const blocked = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const targetCall = phase === "initial" ? 1 : 2;
    let calls = 0;
    const publish = vi
      .spyOn(privateCredentials, "savePrivateJson")
      .mockImplementation(async (path, input) => {
        calls++;
        if (calls === 1) await writeFile(path, JSON.stringify(input), { mode: 0o600 });
        if (calls === targetCall) {
          entered();
          await blocked;
        }
        if (calls !== 1) await writeFile(path, JSON.stringify(input), { mode: 0o600 });
      });
    let closed = false;
    try {
      const created = service.create(owner, hostname, value).catch((error: unknown) => error);
      await Promise.race([
        publishing,
        created.then((result) => {
          throw result;
        }),
      ]);
      const queued = service.forget(owner).catch((error: unknown) => error);
      fail(failure);
      expect(await created).toBe(failure);
      expect(await queued).toBe(failure);
      expect(provider.create).toHaveBeenCalledTimes(phase === "initial" ? 0 : 1);
      expect(provider.remove).toHaveBeenCalledTimes(phase === "initial" ? 0 : 1);
      expect(publish).toHaveBeenCalledTimes(targetCall);
      const journal = await readFile(file);
      expect(JSON.parse(journal.toString())).toHaveLength(1);
      expect(service.snapshot().dnsLeases).toBe(1);
      await expect(service.forget(owner)).rejects.toBe(failure);
      const receipt = (
        service as AcmeDnsChallenges & { cleanupFailure?: () => unknown }
      ).cleanupFailure?.();
      expect(receipt).toBe(failure);
      const clear = vi.spyOn(globalThis, "clearInterval");
      await expect(service.close()).rejects.toBe(failure);
      closed = true;
      expect(clear).toHaveBeenCalledOnce();
      expect(provider.remove).toHaveBeenCalledTimes(phase === "initial" ? 0 : 1);
      expect(publish).toHaveBeenCalledTimes(targetCall);
      expect(await readFile(file)).toEqual(journal);
    } finally {
      // The marked publication is wholly injected; all physical writes above are joined Node I/O.
      if (!closed) {
        try {
          await service.close();
        } catch (error) {
          if (error !== failure) throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("ordinary joined recovery publication failure retains its intent and permits later cleanup", async () => {
  const { directory, file, provider, service } = await fixture();
  provider.create.mockRejectedValueOnce(new Error("Invented joined provider refusal"));
  let calls = 0;
  const publish = vi
    .spyOn(privateCredentials, "savePrivateJson")
    .mockImplementation(async (path, input) => {
      if (++calls === 2) throw new Error("Invented joined journal refusal");
      await writeFile(path, JSON.stringify(input), { mode: 0o600 });
    });
  try {
    await expect(service.create(owner, hostname, value)).rejects.toMatchObject({ status: 502 });
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveLength(1);
    await service.forget(owner);
    expect(provider.remove).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "an explicit provider receipt stops rollback before another mutation (nested:%s)",
  async (nested) => {
    const { directory, file, provider, service } = await fixture();
    const marker = { cleanupFailure: undefined };
    const failure = nested
      ? new Error("Invented provider ownership refusal", { cause: marker })
      : marker;
    provider.create.mockRejectedValueOnce(failure);
    const publish = vi
      .spyOn(privateCredentials, "savePrivateJson")
      .mockImplementation(async (path, input) => {
        await writeFile(path, JSON.stringify(input), { mode: 0o600 });
      });
    let closed = false;
    try {
      await expect(service.create(owner, hostname, value)).rejects.toBe(failure);
      const journal = await readFile(file);
      expect(JSON.parse(journal.toString())).toHaveLength(1);
      expect(service.cleanupFailure()).toBe(failure);
      await expect(service.expire()).rejects.toBe(failure);
      await expect(service.close()).rejects.toBe(failure);
      closed = true;
      expect(provider.remove).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledOnce();
      expect(await readFile(file)).toEqual(journal);
    } finally {
      if (!closed) {
        try {
          await service.close();
        } catch (error) {
          if (error !== failure) throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("normal close keeps one pending proof, refuses fresh work and clears only after its deletion joins", async () => {
  const { directory, provider, service } = await fixture();
  const publish = vi
    .spyOn(privateCredentials, "savePrivateJson")
    .mockImplementation(async (path, input) => {
      await writeFile(path, JSON.stringify(input), { mode: 0o600 });
    });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  provider.remove.mockImplementationOnce(async () => {
    enter();
    await held;
  });
  let closing: Promise<void> | undefined;
  try {
    expect(service.cleanupFailure()).toBeUndefined();
    await service.create(owner, hostname, value);
    closing = service.close();
    expect(service.close()).toBe(closing);
    await entered;
    expect(service.cleanupFailure()).toMatchObject({ cleanupFailure: true, cleanupPending: true });
    await expect(service.create(owner, hostname, value)).rejects.toMatchObject({ status: 503 });
    expect(provider.create).toHaveBeenCalledOnce();
    release();
    await closing;
    expect(service.cleanupFailure()).toBeUndefined();
    expect(service.close()).toBe(closing);
    expect(provider.remove).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledTimes(2);
  } finally {
    release();
    try {
      await (closing ?? service.close());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

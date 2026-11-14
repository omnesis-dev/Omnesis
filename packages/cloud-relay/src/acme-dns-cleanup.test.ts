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

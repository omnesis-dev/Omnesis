// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { withPairedDeviceFileLock } from "./paired-device-lock.js";

let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "omnesis-pairing-lock-contract-")));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

test("a rejected operation releases the real lock for its next owner", async () => {
  const path = join(directory, "pair.json");
  const refusal = new Error("Invented pairing operation refusal");
  await expect(
    withPairedDeviceFileLock(path, async () => {
      throw refusal;
    }),
  ).rejects.toBe(refusal);
  await expect(withPairedDeviceFileLock(path, async () => "next-owner")).resolves.toBe(
    "next-owner",
  );
});

test.skipIf(process.platform === "win32")(
  "a public or aliased lock folder never dispatches credential work",
  async () => {
    const work = vi.fn(async () => undefined);
    const path = join(directory, "public.json"),
      lock = `${path}.pairing-lock`;
    await mkdir(lock, { mode: 0o700 });
    await chmod(lock, 0o777);
    await expect(withPairedDeviceFileLock(path, work)).rejects.toThrow("private and owned");
    expect(work).not.toHaveBeenCalled();
    const target = join(directory, "target");
    await mkdir(target, { mode: 0o700 });
    const alias = join(directory, "alias.json");
    await symlink(target, `${alias}.pairing-lock`);
    await expect(withPairedDeviceFileLock(alias, work)).rejects.toThrow("private and owned");
    expect(work).not.toHaveBeenCalled();
  },
);

test("Windows ACL admission precedes lease acquisition and cleanup still releases on rejection", async () => {
  const path = join(directory, "windows.json"),
    lock = `${path}.pairing-lock`;
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const release = vi.fn();
  const acquire = vi
    .spyOn(core, "acquireGatewayLock")
    .mockImplementation(async (directory) => ({ path: join(directory, "gateway.lock"), release }));
  const protect = vi.spyOn(core, "ensurePrivateDirs").mockResolvedValue(undefined);
  const work = vi.fn(async () => {
    throw new Error("Invented rejected Windows pairing");
  });
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    await expect(withPairedDeviceFileLock(path, work)).rejects.toThrow("rejected Windows pairing");
    expect(protect).toHaveBeenCalledExactlyOnceWith([lock]);
    expect(acquire).toHaveBeenCalledExactlyOnceWith(lock);
    expect(protect.mock.invocationCallOrder[0]).toBeLessThan(acquire.mock.invocationCallOrder[0]!);
    expect(release).toHaveBeenCalledOnce();
    protect.mockRejectedValueOnce(new Error("Invented ACL refusal"));
    await expect(withPairedDeviceFileLock(path, work)).rejects.toThrow("ACL refusal");
    expect(acquire).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

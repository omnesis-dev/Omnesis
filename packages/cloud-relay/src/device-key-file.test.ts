// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { readOrCreateDeviceKey } from "./device-key-file.js";
import { parseDevicePublicKey } from "./device-enrollment.js";

const { failLink } = vi.hoisted(() => ({ failLink: { code: undefined as string | undefined } }));
vi.mock(import("node:fs/promises"), async (original) => {
  const fs = await original();
  return {
    ...fs,
    link: (async (...args: Parameters<typeof fs.link>) => {
      if (failLink.code) throw Object.assign(new Error("link refused"), { code: failLink.code });
      return fs.link(...args);
    }) as typeof fs.link,
  };
});

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "device-key-file-"));
  if (process.platform === "win32") await core.ensurePrivateDirs([directory]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  failLink.code = undefined;
  await rm(directory, { recursive: true, force: true });
});

test("Windows device creation uses held bounded reads and atomic create-only publication", async () => {
  const path = join(directory, "device.key");
  const { generateKeyPairSync } = await import("node:crypto");
  const winner = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  const read = vi
    .spyOn(core, "readWindowsPrivateFile")
    .mockRejectedValueOnce(Object.assign(new Error("Invented missing key"), { code: "ENOENT" }))
    .mockResolvedValueOnce(Buffer.from(winner));
  const publish = vi
    .spyOn(core, "writeWindowsPrivateFileAtomicStream")
    .mockImplementationOnce(async (target, source, length, options) => {
      expect(target).toBe(path);
      expect(options).toMatchObject({ replaceExisting: false, timeoutMs: 30_000 });
      const chunks: Buffer[] = [];
      for await (const chunk of source as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      const staged = Buffer.concat(chunks);
      expect(staged).toHaveLength(length);
      expect(staged.toString()).toContain("PRIVATE KEY");
      await writeFile(path, winner, { mode: 0o600 });
      throw Object.assign(new Error("Invented concurrent winner"), { code: "EEXIST" });
    });
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const key = await readOrCreateDeviceKey(path);
    expect(key.privateKey.export({ type: "pkcs8", format: "pem" })).toEqual(winner);
    expect(read.mock.calls).toEqual([
      [path, 65_536],
      [path, 65_536],
    ]);
    expect(publish).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual(["device.key"]);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("a Windows private-read refusal never creates or replaces a device identity", async () => {
  const path = join(directory, "refused.key");
  const read = vi
    .spyOn(core, "readWindowsPrivateFile")
    .mockRejectedValue(
      Object.assign(new Error("Invented unsafe private key"), { code: "EPRIVATE" }),
    );
  const publish = vi.spyOn(core, "writeWindowsPrivateFileAtomicStream");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    await expect(readOrCreateDeviceKey(path)).rejects.toThrow("device key could not be read");
    expect(read).toHaveBeenCalledWith(path, 65_536);
    expect(publish).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

// Windows stages and joins writes inside its native atomic publisher instead of a JS FileHandle.
test.skipIf(process.platform === "win32")(
  "a failed POSIX staging write removes the partial secret",
  async () => {
    const open = files.open;
    vi.spyOn(files, "open").mockImplementationOnce(async (...args) => {
      const file = await open(...args);
      const write = file.writeFile.bind(file);
      vi.spyOn(file, "writeFile").mockImplementationOnce(async () => {
        await write("invented partial private key");
        throw new Error("Invented interrupted private-key write");
      });
      return file;
    });
    await expect(readOrCreateDeviceKey(join(directory, "device.key"))).rejects.toThrow(
      "Invented interrupted private-key write",
    );
    expect(await readdir(directory)).toEqual([]);
  },
);

test("the first use creates one private P-256 key that later uses read back", async () => {
  const path = join(directory, "nested", "device.json.key");
  const created = await readOrCreateDeviceKey(path);
  expect(parseDevicePublicKey(created.publicKey).asymmetricKeyDetails?.namedCurve).toBe(
    "prime256v1",
  );
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
  } else {
    expect(core.inspectWindowsPrivatePathSync(path, "file").private).toBe(true);
  }
  const again = await readOrCreateDeviceKey(path);
  expect(again.publicKey).toBe(created.publicKey);
});

test("concurrent first uses agree on one key", async () => {
  for (let round = 0; round < 10; round++) {
    const path = join(directory, `round-${round}`, "device.json.key");
    const keys = await Promise.all(Array.from({ length: 4 }, () => readOrCreateDeviceKey(path)));
    expect(new Set(keys.map((key) => key.publicKey)).size).toBe(1);
    expect(keys[0]!.publicKey).toBe((await readOrCreateDeviceKey(path)).publicKey);
    expect(await readFile(path, "utf8")).toContain("PRIVATE KEY");
  }
});

test("an unreadable key is never replaced and a path that cannot hold one fails", async () => {
  const corrupt = join(directory, "corrupt.key");
  await writeFile(corrupt, "not a key", { mode: 0o600 });
  await expect(readOrCreateDeviceKey(corrupt)).rejects.toThrow("device key could not be read");
  expect(await readFile(corrupt, "utf8")).toBe("not a key");
  const folder = join(directory, "folder.key");
  await mkdir(folder);
  await expect(readOrCreateDeviceKey(folder)).rejects.toThrow("device key could not be read");
  const blocked = join(directory, "file");
  await writeFile(blocked, "");
  await expect(readOrCreateDeviceKey(join(blocked, "device.key"))).rejects.toThrow();
});

test("a filesystem that refuses to publish the key fails without leaving a staged copy", async () => {
  if (process.platform === "win32") {
    vi.spyOn(core, "writeWindowsPrivateFileAtomicStream").mockRejectedValueOnce(
      Object.assign(new Error("link refused"), { code: "EPERM" }),
    );
  } else {
    failLink.code = "EPERM";
  }
  await expect(readOrCreateDeviceKey(join(directory, "device.key"))).rejects.toThrow(
    "link refused",
  );
  expect(await readdir(directory)).toEqual([]);
});

test.skipIf(process.platform !== "win32")(
  "Windows refuses an existing device key with a public read grant",
  async () => {
    const path = join(directory, "device.key");
    await readOrCreateDeviceKey(path);
    const previous = await readFile(path, "utf8");
    try {
      await core.execWindowsJob(join(process.env.SystemRoot!, "System32", "icacls.exe"), [
        path,
        "/grant",
        "*S-1-1-0:(R)",
        "/Q",
      ]);
      expect(core.inspectWindowsPrivatePathSync(path, "file").private).toBe(false);
      await expect(readOrCreateDeviceKey(path)).rejects.toThrow("device key could not be read");
      expect(await readFile(path, "utf8")).toBe(previous);
      expect(await readdir(directory)).toEqual(["device.key"]);
    } finally {
      core.ensurePrivateFileSync(path);
    }
  },
);

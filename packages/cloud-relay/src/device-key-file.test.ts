// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
});
afterEach(async () => {
  failLink.code = undefined;
  await rm(directory, { recursive: true, force: true });
});

test("the first use creates one private P-256 key that later uses read back", async () => {
  const path = join(directory, "nested", "device.json.key");
  const created = await readOrCreateDeviceKey(path);
  expect(parseDevicePublicKey(created.publicKey).asymmetricKeyDetails?.namedCurve).toBe(
    "prime256v1",
  );
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
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
  failLink.code = "EPERM";
  await expect(readOrCreateDeviceKey(join(directory, "device.key"))).rejects.toThrow(
    "link refused",
  );
  expect(await readdir(directory)).toEqual([]);
});

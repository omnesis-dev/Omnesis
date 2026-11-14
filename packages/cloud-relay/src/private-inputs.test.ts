// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@omnesis/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { exposeOwnedFixtureRead } from "../test/owned-file-acl.js";
import {
  identityArtifactPresent,
  readBoundedPrivateText,
  readPrivateInput,
  readPrivateText,
} from "./private-inputs.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "relay-private-input-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

test("Windows private inputs use held reads with the original signing byte limits", async () => {
  const path = join(directory, "private.key");
  const read = vi
    .spyOn(core, "readWindowsPrivateFile")
    .mockResolvedValue(Buffer.from("invented key"));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    expect(await readPrivateInput(path)).toEqual(Buffer.from("invented key"));
    expect(await readPrivateText(path)).toBe("invented key");
    expect(await readBoundedPrivateText(path, 4096, "Invented recovery bound")).toBe(
      "invented key",
    );
    expect(read.mock.calls).toEqual([
      [path, 65_536],
      [path, 65_536],
      [path, 4096],
    ]);
    const refused = Object.assign(new Error("Invented private read refusal"), { code: "EPRIVATE" });
    read.mockRejectedValueOnce(refused);
    await expect(readPrivateInput(path)).rejects.toBe(refused);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("only true Windows missing-file metadata means an identity artifact is absent", async () => {
  const path = join(directory, "public-receipt");
  const prefix = vi.spyOn(core, "readWindowsRegularFilePrefix");
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    prefix.mockRejectedValueOnce(
      Object.assign(new Error("Invented missing file"), { code: "ENOENT" }),
    );
    expect(await identityArtifactPresent(path)).toBe(false);
    for (const code of ["ENOTDIR", "EACCES", "EIO", "EPRIVATE"]) {
      const refused = Object.assign(new Error("Invented metadata refusal"), { code });
      prefix.mockRejectedValueOnce(refused);
      await expect(identityArtifactPresent(path)).rejects.toBe(refused);
    }
    prefix.mockResolvedValueOnce({ bytes: Buffer.alloc(0), size: 4n });
    expect(await identityArtifactPresent(path)).toBe(true);
    expect(prefix.mock.calls.every(([target, limit]) => target === path && limit === 0)).toBe(true);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("missing artifacts are absent while non-directory ancestry cannot hide an identity", async () => {
  expect(await identityArtifactPresent(join(directory, "missing"))).toBe(false);
  const file = join(directory, "parent-file");
  await writeFile(file, "invented metadata");
  await expect(identityArtifactPresent(join(file, "receipt"))).rejects.toThrow();
  expect(await identityArtifactPresent(file)).toBe(true);
});

// A dangling POSIX entry is still evidence of a previous identity, even without readable bytes.
test.skipIf(process.platform === "win32")(
  "a dangling POSIX artifact never authorizes another identity",
  async () => {
    const path = join(directory, "dangling");
    await symlink(join(directory, "missing"), path);
    expect(await identityArtifactPresent(path)).toBe(true);
  },
);

test.each([4096, 65_536])(
  "bounded signing inputs accept exactly %i bytes and reject another byte",
  async (maximumBytes) => {
    const path = join(directory, "bounded.key");
    await core.atomicWriteFile(path, "x".repeat(maximumBytes), { mode: 0o600 });
    expect(await readBoundedPrivateText(path, maximumBytes, "Invented signing bound")).toHaveLength(
      maximumBytes,
    );
    await core.atomicWriteFile(path, "x".repeat(maximumBytes + 1), { mode: 0o600 });
    const oversized = readBoundedPrivateText(path, maximumBytes, "Invented signing bound");
    if (process.platform === "win32")
      await expect(oversized).rejects.toMatchObject({ code: "EPRIVATE" });
    else await expect(oversized).rejects.toThrow("Invented signing bound");
  },
);

// The existing POSIX private-key reader has no size limit; only previously bounded tools gain one here.
test("the POSIX private reader retains its existing unbounded behavior on every host", async () => {
  const path = join(directory, "large.key");
  await writeFile(path, Buffer.alloc(65_537, 42), { mode: 0o600 });
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  try {
    expect(await readPrivateInput(path)).toHaveLength(65_537);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test.skipIf(process.platform !== "win32")(
  "Windows held private reads reject a public grant without changing key bytes",
  async () => {
    const path = join(directory, "private.key");
    await core.atomicWriteFile(path, "invented private key", { mode: 0o600 });
    const exposure = await exposeOwnedFixtureRead(path);
    try {
      expect(core.inspectWindowsPrivatePathSync(path, "file").private).toBe(false);
      await expect(readPrivateInput(path)).rejects.toMatchObject({ code: "EPRIVATE" });
      await expect(readBoundedPrivateText(path, 4096, "Invented bound")).rejects.toMatchObject({
        code: "EPRIVATE",
      });
      expect(await readFile(path, "utf8")).toBe("invented private key");
      expect(await exposure.snapshot()).toBe(exposure.exposed);
    } finally {
      await exposure.restore();
    }
    expect((await readPrivateInput(path)).toString()).toBe("invented private key");
  },
);

test.skipIf(process.platform !== "win32")(
  "Windows junctions cannot hide private key or identity-artifact ancestry",
  async () => {
    const target = join(directory, "target");
    await mkdir(target);
    await core.atomicWriteFile(join(target, "private.key"), "invented private key", {
      mode: 0o600,
    });
    const alias = join(directory, "junction");
    await symlink(target, alias, "junction");
    await expect(readPrivateInput(join(alias, "private.key"))).rejects.toMatchObject({
      code: "EPRIVATE",
    });
    await expect(identityArtifactPresent(join(alias, "private.key"))).rejects.toMatchObject({
      code: "EACCES",
    });
  },
);

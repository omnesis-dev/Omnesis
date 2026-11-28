// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ensureInstallRootKey } from "./secret-store.js";
import { decryptArtifactFileToBuffer, produceEncryptedArtifact } from "./encrypted-artifact.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-artifact-producer-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const options = () => ({ configDir: directory, backend: "file" as const, scope: "export:fixture" });

test("large streamed output persists only ciphertext and publishes after production finishes", async () => {
  await ensureInstallRootKey(options());
  const path = join(directory, "output.enc");
  const content = "invented-private-document-content\n".repeat(4096);
  await produceEncryptedArtifact(path, options(), async (body) => {
    for (let i = 0; i < 8; i++) {
      if (!body.write(content)) await once(body, "drain");
    }
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    const scratch = (await readdir(directory)).find((name) => name.startsWith("output.enc.tmp-"));
    expect(scratch).toBeDefined();
    const bytes = await readFile(join(directory, scratch!));
    expect(bytes.includes(Buffer.from("invented-private-document-content"))).toBe(false);
  });
  expect((await decryptArtifactFileToBuffer(path, options())).toString()).toBe(content.repeat(8));
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await readdir(directory)).filter((name) => name.includes(".tmp-"))).toEqual([]);
});

test("a failed producer drains and removes its owned encrypted partial without publication", async () => {
  await ensureInstallRootKey(options());
  const path = join(directory, "failed.enc");
  await expect(
    produceEncryptedArtifact(path, options(), async (body) => {
      body.write("invented-sensitive-value");
      throw new Error("fixture interrupted");
    }),
  ).rejects.toThrow("fixture interrupted");
  expect((await readdir(directory)).filter((name) => name.startsWith("failed.enc"))).toEqual([]);
});

test("empty output authenticates and an existing destination is never replaced", async () => {
  await ensureInstallRootKey(options());
  const path = join(directory, "empty.enc");
  await produceEncryptedArtifact(path, options(), async () => {});
  expect((await decryptArtifactFileToBuffer(path, options())).length).toBe(0);
  const before = await readFile(path);
  await expect(
    produceEncryptedArtifact(path, options(), async (body) => {
      body.write("replacement");
    }),
  ).rejects.toThrow();
  expect(await readFile(path)).toEqual(before);
});

test("missing root refuses before invoking a producer or creating output", async () => {
  let called = false;
  await expect(
    produceEncryptedArtifact(join(directory, "missing.enc"), options(), async () => {
      called = true;
      await writeFile(join(directory, "unexpected"), "must not run");
    }),
  ).rejects.toThrow("installation key");
  expect(called).toBe(false);
  expect(await readdir(directory)).toEqual([]);
});

test.each([
  ["empty", ""],
  ["oversized", "x".repeat(4097)],
  ["NUL", "invalid\0scope"],
])("an unreadable %s scope is refused before output", async (_label, scope) => {
  await ensureInstallRootKey(options());
  await expect(
    produceEncryptedArtifact(
      join(directory, "invalid.enc"),
      { ...options(), scope },
      async () => {},
    ),
  ).rejects.toThrow();
  expect((await readdir(directory)).filter((name) => name.startsWith("invalid.enc"))).toEqual([]);
});

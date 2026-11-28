// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ensureInstallRootKey,
  generateInstallRootKey,
  readInstallRootKey,
} from "./secret-store.js";
import {
  clearSecretFileKeyCacheForTests,
  readSecretTextFile,
  rewrapSecretFileValue,
  rewrapSecretFileValueAsync,
  secretFileScope,
  writeSecretTextFile,
} from "./secret-file.js";
import {
  ensureStorageKey,
  readStorageKey,
  rewrapStorageKeyValue,
  storageKeyPath,
} from "./storage-keys.js";

let dir: string;
let source: string;
let target: string;
let sourceRoot: string;
let targetRoot: string;
beforeEach(async () => {
  clearSecretFileKeyCacheForTests();
  dir = await mkdtemp(join(tmpdir(), "omnesis-backup-key-rewrap-"));
  source = join(dir, "source");
  target = join(dir, "target");
  await ensureInstallRootKey({ backend: "file", configDir: source });
  await ensureInstallRootKey({ backend: "file", configDir: target });
  sourceRoot = (await readInstallRootKey({ backend: "file", configDir: source }))!;
  targetRoot = (await readInstallRootKey({ backend: "file", configDir: target }))!;
});
afterEach(async () => {
  clearSecretFileKeyCacheForTests();
  await rm(dir, { recursive: true, force: true });
});

test("moves an authenticated secret between explicit scopes without writing or replacing either root", async () => {
  const from = join(source, "provider", "credentials.json");
  const to = join(target, "provider", "account", "credentials.json");
  await writeSecretTextFile(from, "fictional-provider-access-key", {
    backend: "file",
    configDir: source,
  });
  const original = await readFile(from, "utf8");
  const transformed = rewrapSecretFileValue(original, {
    sourceRootKey: sourceRoot,
    targetRootKey: targetRoot,
    sourceScope: secretFileScope(from, source),
    targetScope: secretFileScope(to, target),
  });
  expect(transformed).not.toContain("fictional-provider-access-key");
  expect(await readFile(from, "utf8")).toBe(original);
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await writeFile(to, transformed, { mode: 0o600 });
  expect(await readSecretTextFile(to, { backend: "file", configDir: target })).toBe(
    "fictional-provider-access-key",
  );
  expect((await readInstallRootKey({ backend: "file", configDir: target })) === targetRoot).toBe(
    true,
  );
  expect((await readInstallRootKey({ backend: "file", configDir: source })) === sourceRoot).toBe(
    true,
  );
});

test("wrong roots, swapped secret scopes, invalid envelopes and plaintext fail without returning or logging inputs", async () => {
  const from = join(source, "credentials.json");
  await writeSecretTextFile(from, "fictional-secret", { backend: "file", configDir: source });
  const original = await readFile(from, "utf8");
  const options = {
    sourceRootKey: sourceRoot,
    targetRootKey: targetRoot,
    sourceScope: secretFileScope(from, source),
    targetScope: "config:credentials.json",
  };
  for (const input of [
    { ...options, sourceRootKey: generateInstallRootKey() },
    { ...options, sourceScope: "config:another-file" },
    { ...options, targetScope: "" },
  ]) {
    expect(() => rewrapSecretFileValue(original, input)).toThrow(
      "The encrypted secret could not be rewrapped for this library",
    );
  }
  for (const raw of [
    "plaintext-value",
    "{}",
    JSON.stringify({ omnesis: "omnesis.secret-file", version: 99 }),
  ]) {
    expect(() => rewrapSecretFileValue(raw, options)).toThrow(
      "The encrypted secret could not be rewrapped for this library",
    );
  }
  const tampered = JSON.parse(original) as { ciphertext: string };
  tampered.ciphertext = (tampered.ciphertext[0] === "A" ? "B" : "A") + tampered.ciphertext.slice(1);
  expect(() => rewrapSecretFileValue(JSON.stringify(tampered), options)).toThrow(
    "The encrypted secret could not be rewrapped for this library",
  );
  expect(await readFile(from, "utf8")).toBe(original);
});

test("rewraps a store data key intact while preserving the target root and leaving publication to the caller", async () => {
  await ensureStorageKey("main-db", { backend: "file", configDir: source });
  await ensureStorageKey("main-db", { backend: "file", configDir: target });
  const before = await readFile(storageKeyPath("main-db", target), "utf8");
  const original = await readFile(storageKeyPath("main-db", source), "utf8");
  const dataKey = (await readStorageKey("main-db", { backend: "file", configDir: source }))!;
  const transformed = rewrapStorageKeyValue(original, {
    keyName: "main-db",
    sourceRootKey: sourceRoot,
    targetRootKey: targetRoot,
  });
  expect(await readFile(storageKeyPath("main-db", target), "utf8")).toBe(before);
  expect(transformed.includes(dataKey.toString("hex"))).toBe(false);
  await writeFile(storageKeyPath("main-db", target), transformed, { mode: 0o600 });
  const restoredKey = await readStorageKey("main-db", { backend: "file", configDir: target });
  expect(restoredKey?.equals(dataKey)).toBe(true);
  expect((await readInstallRootKey({ backend: "file", configDir: target })) === targetRoot).toBe(
    true,
  );
});

test("a storage envelope cannot be relabelled to another store or opened under another root", async () => {
  await ensureStorageKey("main-db", { backend: "file", configDir: source });
  const original = await readFile(storageKeyPath("main-db", source), "utf8");
  expect(() =>
    rewrapStorageKeyValue(original, {
      keyName: "index-db",
      sourceRootKey: sourceRoot,
      targetRootKey: targetRoot,
    }),
  ).toThrow("The storage key could not be rewrapped for this library");
  expect(() =>
    rewrapStorageKeyValue(original, {
      keyName: "main-db",
      sourceRootKey: generateInstallRootKey(),
      targetRootKey: targetRoot,
    }),
  ).toThrow("The storage key could not be rewrapped for this library");
  expect(() =>
    rewrapStorageKeyValue("plaintext", {
      keyName: "main-db",
      sourceRootKey: sourceRoot,
      targetRootKey: targetRoot,
    }),
  ).toThrow("The storage key could not be rewrapped for this library");
  expect(await readFile(storageKeyPath("main-db", source), "utf8")).toBe(original);
});

test("async rewrap authenticates both roots and scopes without changing the source", async () => {
  const from = join(source, "conversations/s_fixture.json");
  const to = join(target, "conversations/s_fixture.json");
  await writeSecretTextFile(from, "Invented conversation content", {
    backend: "file",
    configDir: source,
  });
  const raw = await readFile(from, "utf8");
  const options = {
    sourceRootKey: sourceRoot,
    targetRootKey: targetRoot,
    sourceScope: secretFileScope(from, source),
    targetScope: secretFileScope(to, target),
  };
  const transformed = await rewrapSecretFileValueAsync(raw, options);
  expect(transformed).not.toContain("Invented conversation content");
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await writeFile(to, transformed, { mode: 0o600 });
  expect(await readSecretTextFile(to, { backend: "file", configDir: target })).toBe(
    "Invented conversation content",
  );
  for (const overrides of [
    { sourceRootKey: generateInstallRootKey() },
    { sourceScope: "config:another-file.json" },
    { targetScope: "" },
  ]) {
    await expect(rewrapSecretFileValueAsync(raw, { ...options, ...overrides })).rejects.toThrow(
      "could not be rewrapped",
    );
  }
  const bad = JSON.parse(raw) as { tag: string };
  bad.tag = (bad.tag[0] === "A" ? "B" : "A") + bad.tag.slice(1);
  await expect(rewrapSecretFileValueAsync(JSON.stringify(bad), options)).rejects.toThrow(
    "could not be rewrapped",
  );
  await expect(rewrapSecretFileValueAsync("plaintext", options)).rejects.toThrow(
    "could not be rewrapped",
  );
  expect(await readFile(from, "utf8")).toBe(raw);
});

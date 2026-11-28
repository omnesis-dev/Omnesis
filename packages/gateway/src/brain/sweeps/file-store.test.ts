// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  isEncryptedSecretFile,
  markSecretFileEncryptionRequired,
  primeSecretFileKeyCache,
  writeSecretTextFile,
} from "@omnesis/core";
import { protectManagedProse } from "../../managed-prose.js";
import { SweepFileStore } from "./file-store.js";
import { MAX_STEERING_PROMPT_CHARS } from "./file-format.js";

const directories: string[] = [];
afterEach(() => {
  clearSecretFileKeyCacheForTests();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "omnesis-sweep-prose-"));
  directories.push(directory);
  const options = { configDir: directory, backend: "file" as const };
  await ensureInstallRootKey(options);
  await markSecretFileEncryptionRequired(directory, options);
  await primeSecretFileKeyCache(options);
  mkdirSync(join(directory, "sweeps"));
  return { directory, options, path: join(directory, "sweeps", "fixture-review.md") };
}

test("50 KiB valid legacy sweep survives encryption twice with the same bounded steering prompt", async () => {
  const f = await fixture();
  const text =
    "---\ncadence: 7d\n---\n" + " ".repeat(50 * 1024) + "Review invented open questions.\n";
  writeFileSync(f.path, text, { mode: 0o600 });
  const before = new SweepFileStore(f.directory, f.options).get("fixture-review");
  expect(before?.content).toMatchObject({
    cadenceHours: 168,
    steeringPrompt: "Review invented open questions.",
  });
  await protectManagedProse(f.directory, f.options);
  const sealed = readFileSync(f.path, "utf8");
  expect(Buffer.byteLength(sealed)).toBeGreaterThan(64_000);
  expect(isEncryptedSecretFile(sealed)).toBe(true);
  expect(sealed).not.toContain("Review invented open questions");
  await protectManagedProse(f.directory, f.options);
  expect(readFileSync(f.path, "utf8")).toBe(sealed);
  const store = new SweepFileStore(f.directory, f.options);
  expect(store.get("fixture-review")).toEqual(before);
  expect(() =>
    store.write("too-long", { steeringPrompt: "x".repeat(MAX_STEERING_PROMPT_CHARS + 1) }),
  ).toThrow();
});

test("sweep envelope allowance still refuses decoded text over 64,000 bytes before parsing", async () => {
  const f = await fixture();
  const text = "---\ncadence: 7d\n---\n" + " ".repeat(64_000) + "Short invented prompt.";
  await writeSecretTextFile(f.path, text, f.options);
  const sealed = readFileSync(f.path, "utf8");
  expect(new SweepFileStore(f.directory, f.options).get("fixture-review")).toMatchObject({
    content: null,
    error: expect.stringContaining("64000"),
  });
  expect(readFileSync(f.path, "utf8")).toBe(sealed);
});

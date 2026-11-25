// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  isEncryptedSecretFile,
  markSecretFileEncryptionRequired,
  primeSecretFileKeyCache,
} from "@omnesis/core";
import {
  OperatorInstructionsConflictError,
  OperatorInstructionsStore,
} from "./instructions/store.js";
import { SweepFileStore } from "./brain/sweeps/file-store.js";
import { protectManagedProse } from "./managed-prose.js";

const dirs: string[] = [];
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-prose-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  clearSecretFileKeyCacheForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function encryptedDirectory(): Promise<string> {
  const dir = directory();
  await ensureInstallRootKey({ backend: "file", configDir: dir });
  await markSecretFileEncryptionRequired(dir);
  await primeSecretFileKeyCache({ backend: "file", configDir: dir });
  return dir;
}

test("encrypted instructions and sweeps are readable without durable plaintext and retain conflict checks", async () => {
  const dir = await encryptedDirectory();
  const instructions = new OperatorInstructionsStore(dir, { backend: "file" });
  const first = await instructions.write("Prefer clear explanations.", { expectedUpdatedAt: null });
  expect(isEncryptedSecretFile(readFileSync(instructions.path, "utf8"))).toBe(true);
  expect(readFileSync(instructions.path, "utf8")).not.toContain("Prefer clear explanations.");
  expect(instructions.promptText()).toBe("Prefer clear explanations.");
  await instructions.write("Use brief examples.", { expectedUpdatedAt: first.updatedAt });
  await expect(
    instructions.write("Stale edit", { expectedUpdatedAt: null }),
  ).rejects.toBeInstanceOf(OperatorInstructionsConflictError);
  expect(new OperatorInstructionsStore(dir, { backend: "file" }).read().content).toBe(
    "Use brief examples.",
  );
  const sweeps = new SweepFileStore(dir, { backend: "file" });
  sweeps.write("review-notes", {
    steeringPrompt: "Review unresolved questions.",
    cadenceHours: 168,
  });
  expect(isEncryptedSecretFile(readFileSync(sweeps.pathFor("review-notes"), "utf8"))).toBe(true);
  expect(readFileSync(sweeps.pathFor("review-notes"), "utf8")).not.toContain(
    "Review unresolved questions.",
  );
  expect(
    new SweepFileStore(dir, { backend: "file" }).get("review-notes")?.content?.steeringPrompt,
  ).toBe("Review unresolved questions.");
});

test("strict startup protects legacy prose before loading and is idempotent", async () => {
  const dir = await encryptedDirectory();
  mkdirSync(join(dir, "sweeps"));
  writeFileSync(join(dir, "OMNESIS.md"), "Keep answers clear.", { mode: 0o600 });
  writeFileSync(join(dir, "sweeps", "review.md"), "Review pending questions.", { mode: 0o600 });
  await protectManagedProse(dir, { backend: "file" });
  const first = readFileSync(join(dir, "OMNESIS.md"), "utf8");
  expect(isEncryptedSecretFile(first)).toBe(true);
  expect(isEncryptedSecretFile(readFileSync(join(dir, "sweeps", "review.md"), "utf8"))).toBe(true);
  await protectManagedProse(dir, { backend: "file" });
  expect(readFileSync(join(dir, "OMNESIS.md"), "utf8")).toBe(first);
});

test("ordinary headless prose stays editable as plaintext", async () => {
  const dir = directory();
  const instructions = new OperatorInstructionsStore(dir, { backend: "file" });
  await instructions.write("Use clear wording.");
  const sweeps = new SweepFileStore(dir, { backend: "file" });
  sweeps.write("review", { steeringPrompt: "Review questions." });
  await protectManagedProse(dir, { backend: "file" });
  expect(readFileSync(instructions.path, "utf8")).toBe("Use clear wording.");
  expect(readFileSync(sweeps.pathFor("review"), "utf8")).toContain("Review questions.");
});

test("strict startup refuses a linked prose file without changing its target", async () => {
  const dir = await encryptedDirectory();
  const external = join(directory(), "outside.md");
  writeFileSync(external, "Original outside instructions.");
  symlinkSync(external, join(dir, "OMNESIS.md"));
  await expect(protectManagedProse(dir, { backend: "file" })).rejects.toThrow("regular file");
  expect(readFileSync(external, "utf8")).toBe("Original outside instructions.");
});

test("a missing root key never downgrades strict prose writes", async () => {
  const dir = directory();
  await markSecretFileEncryptionRequired(dir);
  const instructions = new OperatorInstructionsStore(dir, { backend: "file" });
  await expect(instructions.write("Private instructions.")).rejects.toThrow();
  expect(() =>
    new SweepFileStore(dir, { backend: "file" }).write("review", {
      steeringPrompt: "Private sweep.",
    }),
  ).toThrow();
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import * as secrets from "./secret-file.js";
import {
  clearProviderAccountAndLegacyCredentials,
  providerCredentialsPath,
  writeProviderAccountCredentials,
  writeProviderCredentials,
} from "./credentials.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture(migrated = true) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-cleanup-"));
  dirs.push(dir);
  mkdirSync(join(dir, "fixture", "host-state"), { recursive: true });
  mkdirSync(join(dir, "fixture", "account-one"), { recursive: true });
  await writeProviderCredentials("fixture", { token: "fictional-shared" }, dir);
  if (migrated)
    await writeProviderAccountCredentials(
      "fixture",
      "account-one",
      { token: "fictional-one" },
      dir,
    );
  return { dir, shared: providerCredentialsPath("fixture", dir) };
}

test("migrated last-account cleanup ignores host-only state directories", async () => {
  const { dir, shared } = await fixture();
  await clearProviderAccountAndLegacyCredentials("fixture", "account-one", dir);
  expect(existsSync(shared)).toBe(false);
  expect(existsSync(join(dir, "fixture", "host-state"))).toBe(true);
});

test("legacy empty markers are ambiguous and preserve their shared credential", async () => {
  const { dir, shared } = await fixture(false);
  await clearProviderAccountAndLegacyCredentials("fixture", "account-one", dir);
  expect(existsSync(shared)).toBe(true);
});

test("a locked sibling is still an account, with no attempt to decrypt it", async () => {
  const { dir, shared } = await fixture();
  await writeProviderAccountCredentials("fixture", "account-two", { token: "fictional-two" }, dir);
  const read = vi
    .spyOn(secrets, "readSecretTextFile")
    .mockRejectedValue(new Error("Keyring locked"));
  await clearProviderAccountAndLegacyCredentials("fixture", "account-one", dir);
  expect(existsSync(shared)).toBe(true);
  expect(read).not.toHaveBeenCalled();
});

test("unknown shared credential state never authorizes deletion", async () => {
  const { dir, shared } = await fixture();
  vi.spyOn(secrets, "readSecretTextFile").mockRejectedValue(new Error("Keyring locked"));
  await expect(
    clearProviderAccountAndLegacyCredentials("fixture", "account-one", dir),
  ).rejects.toThrow("Keyring locked");
  expect(existsSync(shared)).toBe(true);
});

test("malformed shared credentials are preserved", async () => {
  const { dir, shared } = await fixture();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  writeFileSync(shared, "fictional-secret-not-json");
  await clearProviderAccountAndLegacyCredentials("fixture", "account-one", dir);
  expect(existsSync(shared)).toBe(true);
  expect(warning.mock.calls.flat().join(" ")).not.toContain("fictional-secret-not-json");
});

test("an unclassifiable sibling credential path fails closed", async () => {
  const { dir, shared } = await fixture();
  mkdirSync(join(dir, "fixture", "account-two", "credentials.json"), { recursive: true });
  await expect(
    clearProviderAccountAndLegacyCredentials("fixture", "account-one", dir),
  ).rejects.toThrow("Cannot classify");
  expect(existsSync(shared)).toBe(true);
});

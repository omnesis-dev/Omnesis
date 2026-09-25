// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  acquireUpdateLock,
  clearSecretFileKeyCacheForTests,
  createSecretStore,
  ensureInstallRootKey,
  isEncryptedSecretFile,
  OMNESIS_INSTALL_ROOT_KEY,
  readSecretTextFileSync,
} from "@omnesis/core";
import {
  bootstrapAccountDir,
  clearBootstrapCache,
  removeAccountData,
  completedBootstrapMarker,
  loadSession,
  markBootstrapComplete,
  migrateBootstrapCaches,
  readBootstrapPage,
  saveSession,
  sessionPath,
  writeBootstrapPage,
} from "./session.js";
import type { EbTransactionsPage, StoredSession } from "./types.js";

let configDir: string;
const consent: StoredSession = {
  session_id: "invented-consent-token",
  valid_until: "2030-01-01T00:00:00Z",
  aspsp: { name: "bank-example", country: "GB" },
  accounts: [],
};
const page: EbTransactionsPage = {
  transactions: [
    {
      entry_reference: "invented-transaction-reference",
      transaction_amount: { amount: "42.00", currency: "GBP" },
      credit_debit_indicator: "DBIT",
      remittance_information: ["Fictional garden supplies"],
    },
  ],
};
const accountId = "fictional-bank";
function dir() {
  return bootstrapAccountDir(accountId, "invented-account-key", configDir);
}
function seed() {
  saveSession(accountId, consent, configDir);
  writeBootstrapPage(dir(), 0, page, configDir);
  markBootstrapComplete(dir(), 1, consent.session_id, configDir);
}

beforeEach(() => {
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  clearSecretFileKeyCacheForTests();
  configDir = mkdtempSync(join(tmpdir(), "omnesis-banking-encryption-"));
});
afterEach(() => {
  clearSecretFileKeyCacheForTests();
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

test("encrypted consent, pages and completion metadata reopen under the local root key", async () => {
  await ensureInstallRootKey({ configDir, backend: "file" });
  seed();
  for (const path of [
    sessionPath(accountId, configDir),
    join(dir(), "page-0000.json"),
    join(dir(), "complete.json"),
  ]) {
    const raw = readFileSync(path, "utf8");
    expect(isEncryptedSecretFile(raw)).toBe(true);
    expect(raw).not.toContain(consent.session_id);
    expect(raw).not.toContain("Fictional garden supplies");
    expect(JSON.parse(raw).transactions).toBeUndefined();
  }
  clearSecretFileKeyCacheForTests();
  migrateBootstrapCaches(accountId, configDir);
  expect(loadSession(accountId, configDir)).toEqual(consent);
  expect(readBootstrapPage(dir(), 0, configDir)).toEqual(page);
  expect(completedBootstrapMarker(dir(), configDir)).toEqual({
    pages: 1,
    sessionId: consent.session_id,
  });
});

test("legacy and partially migrated spools migrate atomically, including unfinished prefetch", async () => {
  seed();
  const unfinished = bootstrapAccountDir(accountId, "unfinished", configDir);
  writeBootstrapPage(unfinished, 0, page, configDir);
  await ensureInstallRootKey({ configDir, backend: "file" });
  // Model interruption after just the first file has been atomically replaced.
  saveSession(accountId, consent, configDir);
  expect(isEncryptedSecretFile(readFileSync(join(dir(), "page-0000.json"), "utf8"))).toBe(false);
  migrateBootstrapCaches(accountId, configDir);
  expect(loadSession(accountId, configDir)).toEqual(consent);
  for (const cache of [dir(), unfinished]) {
    for (const file of readdirSync(cache)) {
      expect(isEncryptedSecretFile(readFileSync(join(cache, file), "utf8"))).toBe(true);
    }
    expect(readBootstrapPage(cache, 0, configDir)).toEqual(page);
  }
  expect(readdirSync(dir()).sort()).toEqual(["complete.json", "page-0000.json"]);
  expect(completedBootstrapMarker(unfinished, configDir)).toBeNull();
});

test("legacy configuration remains readable without initialized encryption", () => {
  seed();
  migrateBootstrapCaches(accountId, configDir);
  expect(loadSession(accountId, configDir)).toEqual(consent);
  expect(readBootstrapPage(dir(), 0, configDir)).toEqual(page);
});

test("missing root key prevents reads and plaintext replacement without deleting progress", async () => {
  await ensureInstallRootKey({ configDir, backend: "file" });
  seed();
  const path = join(dir(), "page-0000.json");
  const original = readFileSync(path);
  await createSecretStore({ configDir, backend: "file" }).delete(OMNESIS_INSTALL_ROOT_KEY);
  clearSecretFileKeyCacheForTests();
  expect(() => loadSession(accountId, configDir)).toThrow(/install root key/);
  expect(() => readBootstrapPage(dir(), 0, configDir)).toThrow(/install root key/);
  expect(() => completedBootstrapMarker(dir(), configDir)).toThrow(/install root key/);
  expect(() => writeBootstrapPage(dir(), 0, page, configDir)).toThrow(/install root key/);
  expect(() => writeBootstrapPage(dir(), 1, page, configDir)).toThrow(/install root key/);
  expect(readFileSync(path)).toEqual(original);
});

test("wrong root key refuses the spool and retains every encrypted file", async () => {
  await ensureInstallRootKey({ configDir, backend: "file" });
  seed();
  const path = join(dir(), "page-0000.json");
  const original = readFileSync(path);
  rmSync(join(configDir, "keyring"), { recursive: true, force: true });
  clearSecretFileKeyCacheForTests();
  await ensureInstallRootKey({ configDir, backend: "file" });
  expect(() => loadSession(accountId, configDir)).toThrow();
  expect(() => readBootstrapPage(dir(), 0, configDir)).toThrow();
  expect(readFileSync(path)).toEqual(original);
});

test.each(["page-0000.json", "complete.json"])(
  "corrupt encrypted %s refuses progress without rewriting it",
  async (file) => {
    await ensureInstallRootKey({ configDir, backend: "file" });
    seed();
    const path = join(dir(), file);
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.tag = Buffer.alloc(16).toString("base64url");
    const corrupt = JSON.stringify(envelope);
    writeFileSync(path, corrupt);
    expect(() => migrateBootstrapCaches(accountId, configDir)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(corrupt);
  },
);

test("failed migration preserves a corrupt legacy file and retries after repair", async () => {
  seed();
  const path = join(dir(), "page-0000.json");
  writeFileSync(path, "{ incomplete");
  await ensureInstallRootKey({ configDir, backend: "file" });
  expect(() => migrateBootstrapCaches(accountId, configDir)).toThrow();
  expect(readFileSync(path, "utf8")).toBe("{ incomplete");
  writeFileSync(path, JSON.stringify(page));
  migrateBootstrapCaches(accountId, configDir);
  expect(loadSession(accountId, configDir)).toEqual(consent);
  expect(isEncryptedSecretFile(readFileSync(path, "utf8"))).toBe(true);
});

test("a concurrent persistence owner blocks migration, overwrites and cleanup", async () => {
  seed();
  const path = join(dir(), "page-0000.json");
  const original = readFileSync(path);
  await ensureInstallRootKey({ configDir, backend: "file" });
  const lock = acquireUpdateLock(join(configDir, "enable-banking", ".locks", accountId), {
    owner: "test concurrent consent",
  });
  try {
    expect(() => migrateBootstrapCaches(accountId, configDir)).toThrow();
    expect(() =>
      saveSession(accountId, { ...consent, session_id: "new-consent" }, configDir),
    ).toThrow();
    expect(() => writeBootstrapPage(dir(), 0, { transactions: [] }, configDir)).toThrow();
    await expect(clearBootstrapCache(dir())).rejects.toThrow();
    await expect(removeAccountData(accountId, configDir)).rejects.toThrow();
    expect(readFileSync(path)).toEqual(original);
  } finally {
    lock.release();
  }
  migrateBootstrapCaches(accountId, configDir);
  expect(readBootstrapPage(dir(), 0, configDir)).toEqual(page);
});

test("an initializing persistence owner cannot have its unpublished lock stolen", () => {
  seed();
  const path = join(dir(), "page-0000.json");
  const original = readFileSync(path);
  mkdirSync(join(configDir, "enable-banking", ".locks", accountId, "update.lock"));
  expect(() => writeBootstrapPage(dir(), 0, { transactions: [] }, configDir)).toThrow();
  expect(readFileSync(path)).toEqual(original);
});

test("abandoned plaintext atomic stages are encrypted in place without losing the only copy", async () => {
  seed();
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  expect(child.status).toBe(0);
  const stage = join(dir(), `page-0001.json.omnesis-${child.pid.toString(36)}123456abcdef.tmp`);
  writeFileSync(stage, JSON.stringify(page));
  await ensureInstallRootKey({ configDir, backend: "file" });
  migrateBootstrapCaches(accountId, configDir);
  expect(isEncryptedSecretFile(readFileSync(stage, "utf8"))).toBe(true);
  expect(readFileSync(stage, "utf8")).not.toContain("Fictional garden supplies");
  migrateBootstrapCaches(accountId, configDir);
});

test("live-owner stages stay untouched and abandoned partial bytes are preserved inside an envelope", async () => {
  seed();
  const stage = join(dir(), `page-0001.json.omnesis-${process.pid.toString(36)}123456abcdef.tmp`);
  const raw = JSON.stringify(page);
  writeFileSync(stage, raw);
  await ensureInstallRootKey({ configDir, backend: "file" });
  expect(() => migrateBootstrapCaches(accountId, configDir)).toThrow(/live writer/);
  expect(readFileSync(stage, "utf8")).toBe(raw);
  rmSync(stage);
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  expect(child.status).toBe(0);
  const broken = join(dir(), `page-0001.json.omnesis-${child.pid.toString(36)}123456abcdef.tmp`);
  writeFileSync(broken, "{ truncated");
  migrateBootstrapCaches(accountId, configDir);
  expect(isEncryptedSecretFile(readFileSync(broken, "utf8"))).toBe(true);
  expect(readSecretTextFileSync(broken, { configDir })).toBe("{ truncated");
});

test("keyless legacy migration preserves canonical and orphan inodes without plaintext rewrites", () => {
  seed();
  const child = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  expect(child.status).toBe(0);
  const stage = join(dir(), `page-0001.json.omnesis-${child.pid.toString(36)}123456abcdef.tmp`);
  const raw = "{ partial legacy write";
  writeFileSync(stage, raw);
  const canonical = join(dir(), "page-0000.json");
  const canonicalStat = statSync(canonical);
  const stageStat = statSync(stage);
  migrateBootstrapCaches(accountId, configDir);
  expect(statSync(stage).ino).toBe(stageStat.ino);
  expect(statSync(stage).mtimeMs).toBe(stageStat.mtimeMs);
  expect(statSync(canonical).ino).toBe(canonicalStat.ino);
  expect(statSync(canonical).mtimeMs).toBe(canonicalStat.mtimeMs);
  expect(readFileSync(stage, "utf8")).toBe(raw);
});

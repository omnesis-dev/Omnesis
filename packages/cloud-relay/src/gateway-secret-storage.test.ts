// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  realpath,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { readOrCreateGatewayOwnerKey } from "./gateway-key-client.js";
import { readRelaySession } from "./gateway-integration.js";
import { gatewayCredentialOptions, persistGatewayKeySession } from "./gateway-secret-storage.js";
import { readPrivateJson, savePrivateJson } from "./google-credentials.js";
import { ensureAcmeBootstrap } from "./acme-bootstrap.js";
import { GatewayAcmeRenewal } from "./acme-gateway.js";

let directory: string;
let options: core.SecretFileOptions;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "omnesis-managed-gateway-secrets-")));
  if (process.platform === "win32") await core.ensurePrivateDirs([directory]);
  options = { backend: "file", configDir: directory, service: "fixture-gateway-scope" };
  await core.ensureInstallRootKey(options);
  await core.markSecretFileEncryptionRequired(directory, options);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  core.clearSecretFileKeyCacheForTests();
  await rm(directory, { recursive: true, force: true });
});
const publicKey = (key: Parameters<typeof createPublicKey>[0]) =>
  createPublicKey(key).export({ type: "spki", format: "der" }).toString("hex");

test("malformed sealed sessions expose no decrypted parser snippet", async () => {
  const path = join(directory, "session.json"),
    secret = "invented-sensitive-session-marker";
  await core.writeSecretTextFile(path, `{${secret}`, options);
  const failure = await readRelaySession(path, options).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toBe("Error: Invalid private credential file");
  expect(String(failure)).not.toContain(secret);
  expect((failure as Error).cause).toBeUndefined();
});
test("headless optional configuration scope preserves plaintext when protection was never required", async () => {
  const headless = join(directory, "headless");
  await mkdir(headless, { mode: 0o700 });
  const path = join(headless, "credential.json");
  await savePrivateJson(
    path,
    { token: "fixture-headless-token" },
    { configDir: headless, backend: "file", service: "fixture-headless" },
  );
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ token: "fixture-headless-token" });
});

test.skipIf(process.platform === "win32")(
  "managed credential readers refuse final and parent aliases",
  async () => {
    vi.stubEnv("OMNESIS_DESKTOP_MANAGED", "1");
    const real = join(directory, "real");
    await mkdir(real, { mode: 0o700 });
    const path = join(real, "session.json");
    await savePrivateJson(path, { token: "fixture-token" }, options);
    const finalAlias = join(directory, "alias.json");
    await symlink(path, finalAlias);
    await expect(readRelaySession(finalAlias, options)).rejects.toThrow();
    const parentAlias = join(directory, "alias");
    await symlink(real, parentAlias);
    await expect(readRelaySession(join(parentAlias, "session.json"), options)).rejects.toThrow(
      "canonical",
    );
  },
);

test("concurrent owner creation publishes one encrypted identity and upgrades the same legacy key", async () => {
  const path = join(directory, "owner.key");
  const keys = await Promise.all(
    Array.from({ length: 4 }, () => readOrCreateGatewayOwnerKey(path, true, options)),
  );
  expect(new Set(keys.map(publicKey)).size).toBe(1);
  expect(core.isEncryptedSecretFile(await readFile(path, "utf8"))).toBe(true);
  expect(publicKey(await readOrCreateGatewayOwnerKey(path, false, options))).toBe(
    publicKey(keys[0]!),
  );
  const legacy = join(directory, "legacy.key");
  const original = generateKeyPairSync("ed25519").privateKey;
  await writeFile(legacy, original.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  expect(publicKey(await readOrCreateGatewayOwnerKey(legacy, false, options))).toBe(
    publicKey(original),
  );
  expect(core.isEncryptedSecretFile(await readFile(legacy, "utf8"))).toBe(true);
  expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
});

test("another namespace or missing root key never replaces or downgrades encrypted owner material", async () => {
  const path = join(directory, "owner.key");
  await readOrCreateGatewayOwnerKey(path, true, options);
  const sealed = await readFile(path, "utf8"),
    foreign = { ...options, service: "fixture-foreign-scope" };
  await core
    .createSecretStore(foreign)
    .write(core.OMNESIS_INSTALL_ROOT_KEY, core.generateInstallRootKey());
  await expect(readOrCreateGatewayOwnerKey(path, true, foreign)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(sealed);
  await core.createSecretStore(options).delete(core.OMNESIS_INSTALL_ROOT_KEY);
  core.clearSecretFileKeyCacheForTests();
  await expect(readOrCreateGatewayOwnerKey(path, true, options)).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe(sealed);
  await expect(
    savePrivateJson(join(directory, "must-not-exist.json"), { token: "fixture-token" }, options),
  ).rejects.toThrow();
  await expect(readFile(join(directory, "must-not-exist.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("session ciphertext is prepared before its final cancellation fence and never publishes after abort", async () => {
  const path = join(directory, "session.json"),
    controller = new AbortController();
  const pending = persistGatewayKeySession(
    path,
    { token: "fixture-token" },
    options,
    controller.signal,
  );
  controller.abort();
  await expect(pending).rejects.toThrow();
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  await persistGatewayKeySession(path, { token: "fixture-token" }, options);
  expect(core.isEncryptedSecretFile(await readFile(path, "utf8"))).toBe(true);
  expect(await readRelaySession(path, options)).toBe("fixture-token");
});

test("managed private JSON refuses plaintext in its own profile and fixes an explicit exclusive scope", async () => {
  vi.stubEnv("OMNESIS_DESKTOP_MANAGED", "1");
  vi.stubEnv("OMNESIS_CONFIG_DIR", directory);
  vi.stubEnv("OMNESIS_SECRET_SERVICE", "fixture-explicit-scope");
  expect(gatewayCredentialOptions()).toEqual({
    configDir: directory,
    service: "fixture-explicit-scope",
    backend: "macos-keychain",
  });
  const path = join(directory, "invitation.json");
  await writeFile(path, JSON.stringify({ token: "fixture-token" }), { mode: 0o600 });
  await expect(readPrivateJson(path, options)).rejects.toThrow("must be encrypted");
  await savePrivateJson(path, { token: "fixture-token" }, options);
  expect(await readPrivateJson(path, options)).toEqual({ token: "fixture-token" });
  expect(core.isEncryptedSecretFile(await readFile(path, "utf8"))).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "public TLS bootstrap feeds its sealed key through stdin and ACME creates a sealed account identity",
  async () => {
    const certificateFile = join(directory, "public-cert.pem"),
      privateKeyFile = join(directory, "public-key.pem");
    await ensureAcmeBootstrap({
      publicOrigin: "https://gateway.example.test",
      certificateFile,
      privateKeyFile,
      generatePrivateKey: true,
      secretFileOptions: options,
      signal: new AbortController().signal,
    });
    expect(core.isEncryptedSecretFile(await readFile(privateKeyFile, "utf8"))).toBe(true);
    const key = await core.readSecretTextFile(privateKeyFile, options);
    const certificate = new X509Certificate(await readFile(certificateFile));
    expect(certificate.publicKey.export({ type: "spki", format: "der" }).toString("hex")).toBe(
      publicKey(key!),
    );
    const accountKeyFile = join(directory, "acme-account.key");
    const issuer = vi.fn(async () => {
      throw new Error("Stopped at the owned ACME network boundary");
    });
    const renewal = new GatewayAcmeRenewal({
      directoryUrl: "https://acme.example.test/directory",
      publicOrigin: "https://gateway.example.test",
      certificateFile,
      privateKeyFile,
      accountKeyFile,
      secretFileOptions: options,
      presenter: { create: async () => ({ id: "fixture" }), remove: async () => {} },
      issuer,
      activate: async () => {},
    });
    try {
      await expect(renewal.renew(new AbortController().signal)).rejects.toThrow("owned ACME");
      expect(issuer).toHaveBeenCalledOnce();
      expect(core.isEncryptedSecretFile(await readFile(accountKeyFile, "utf8"))).toBe(true);
    } finally {
      await renewal.close();
    }
  },
  30_000,
);

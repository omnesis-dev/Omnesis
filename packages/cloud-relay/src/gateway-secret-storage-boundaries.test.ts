// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import {
  gatewayCredentialOptions,
  persistGatewayKeySession,
  readGatewayPrivateSerialized,
  readOrCreateScopedGatewayKey,
} from "./gateway-secret-storage.js";

vi.mock(import("node:fs/promises"), async (original) => ({ ...(await original()) }));
let directory: string;
let options: core.SecretFileOptions;
beforeEach(async () => {
  directory = await files.realpath(
    await files.mkdtemp(join(tmpdir(), "omnesis-gateway-secret-contract-")),
  );
  if (process.platform === "win32") await core.ensurePrivateDirs([directory]);
  options = { configDir: directory, backend: "file", service: "invented-gateway-contract" };
  await core.ensureInstallRootKey(options);
  await core.markSecretFileEncryptionRequired(directory, options);
});
afterEach(async () => {
  vi.restoreAllMocks();
  core.clearSecretFileKeyCacheForTests();
  await files.rm(directory, { recursive: true, force: true });
});
const publicKey = (key: Parameters<typeof createPublicKey>[0]) =>
  createPublicKey(key).export({ type: "spki", format: "der" }).toString("hex");

test("managed gateway scope requires exact opt-in and a usable absolute profile and service", () => {
  expect(gatewayCredentialOptions(undefined, {})).toBeUndefined();
  expect(gatewayCredentialOptions(undefined, { OMNESIS_DESKTOP_MANAGED: "true" })).toBeUndefined();
  for (const configDir of [undefined, "", "relative-profile"]) {
    expect(() =>
      gatewayCredentialOptions(configDir, {
        OMNESIS_DESKTOP_MANAGED: "1",
        OMNESIS_SECRET_SERVICE: "invented-scope",
      }),
    ).toThrow("scope is unavailable");
  }
  for (const service of [undefined, "", "   "]) {
    expect(() =>
      gatewayCredentialOptions(directory, {
        OMNESIS_DESKTOP_MANAGED: "1",
        OMNESIS_SECRET_SERVICE: service,
      }),
    ).toThrow("scope is unavailable");
  }
  expect(
    gatewayCredentialOptions(directory, {
      OMNESIS_DESKTOP_MANAGED: "1",
      OMNESIS_CONFIG_DIR: "relative-ambient",
      OMNESIS_SECRET_SERVICE: "invented-scope",
    }),
  ).toEqual({ configDir: directory, service: "invented-scope", backend: "macos-keychain" });
});

test.skipIf(process.platform === "win32")(
  "held private reader refuses relative, aliased, linked, exposed, nonregular and oversized input",
  async () => {
    const path = join(directory, "identity.key");
    await files.writeFile(path, "invented-private-bytes", { mode: 0o600 });
    expect(await readGatewayPrivateSerialized(path)).toBe("invented-private-bytes");
    await expect(readGatewayPrivateSerialized("relative.key")).rejects.toThrow("canonical");
    const parentAlias = `${directory}-alias`;
    await files.symlink(directory, parentAlias);
    try {
      await expect(readGatewayPrivateSerialized(join(parentAlias, "identity.key"))).rejects.toThrow(
        "canonical",
      );
    } finally {
      await files.rm(parentAlias);
    }
    const alias = join(directory, "alias.key");
    await files.symlink(path, alias);
    await expect(readGatewayPrivateSerialized(alias)).rejects.toThrow();
    const link = join(directory, "linked.key");
    await files.link(path, link);
    await expect(readGatewayPrivateSerialized(path)).rejects.toThrow("private bounded regular");
    await files.rm(link);
    await files.chmod(path, 0o640);
    await expect(readGatewayPrivateSerialized(path)).rejects.toThrow("private bounded regular");
    await files.chmod(path, 0o600);
    await files.writeFile(path, Buffer.alloc(131_073));
    await expect(readGatewayPrivateSerialized(path)).rejects.toThrow("private bounded regular");
    await expect(readGatewayPrivateSerialized(directory)).rejects.toThrow(
      "private bounded regular",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "held private reader detects real truncation, growth and path replacement and closes its descriptor",
  async () => {
    const path = join(directory, "changing.key");
    const originalOpen = files.open;
    for (const mutation of ["truncate", "grow", "replace"] as const) {
      await files.writeFile(path, "invented-initial-bytes", { mode: 0o600 });
      const close = vi.fn();
      const open = vi.spyOn(files, "open").mockImplementationOnce(async (...args) => {
        const handle = await originalOpen(...args);
        const read = handle.read.bind(handle),
          originalClose = handle.close.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(
          async (...readArgs: Parameters<typeof handle.read>) => {
            if (mutation === "truncate") await files.truncate(path, 1);
            const result = await read(...readArgs);
            if (mutation === "grow") await files.appendFile(path, "invented-growth");
            if (mutation === "replace") {
              const replacement = join(directory, "replacement.key");
              await files.writeFile(replacement, "invented-initial-bytes", { mode: 0o600 });
              await files.rename(replacement, path);
            }
            return result;
          },
        );
        vi.spyOn(handle, "close").mockImplementation(async () => {
          close();
          await originalClose();
        });
        return handle;
      });
      try {
        await expect(readGatewayPrivateSerialized(path)).rejects.toThrow("changed while reading");
        expect(close).toHaveBeenCalledOnce();
      } finally {
        open.mockRestore();
      }
    }
  },
);

test("missing or incompatible gateway identity never silently rotates an existing key", async () => {
  const missing = join(directory, "missing.key");
  await expect(readOrCreateScopedGatewayKey(missing, false, options, "ed25519")).rejects.toThrow(
    "must be restored",
  );
  await expect(files.readFile(missing)).rejects.toMatchObject({ code: "ENOENT" });
  for (const algorithm of ["ed25519", "p256"] as const) {
    const path = join(directory, `${algorithm}.key`);
    const wrong =
      algorithm === "ed25519"
        ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
        : generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey;
    const pem = wrong.export({ type: "pkcs8", format: "pem" });
    await core.atomicWriteFile(path, pem, { mode: 0o600 });
    await expect(readOrCreateScopedGatewayKey(path, true, options, algorithm)).rejects.toThrow(
      "unsupported algorithm",
    );
    expect(await files.readFile(path)).toEqual(Buffer.from(pem));
  }
  const wrongType = join(directory, "wrong-p256-type.key");
  const ed25519 = generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  await core.atomicWriteFile(wrongType, ed25519, { mode: 0o600 });
  await expect(readOrCreateScopedGatewayKey(wrongType, true, options, "p256")).rejects.toThrow(
    "unsupported algorithm",
  );
  expect(await files.readFile(wrongType, "utf8")).toBe(ed25519);
  const path = join(directory, "valid-p256.key");
  const key = await readOrCreateScopedGatewayKey(path, true, options, "p256");
  expect(key.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  expect(publicKey(await readOrCreateScopedGatewayKey(path, false, options, "p256"))).toBe(
    publicKey(key),
  );
});

test.skipIf(process.platform === "win32")(
  "create-only publication selects and encrypts the real concurrent plaintext winner",
  async () => {
    const path = join(directory, "winner.key");
    const winner = generateKeyPairSync("ed25519").privateKey;
    const pem = winner.export({ type: "pkcs8", format: "pem" });
    const link = files.link;
    vi.spyOn(files, "link").mockImplementationOnce(async (...args) => {
      await core.atomicWriteFile(path, pem, { mode: 0o600 });
      return link(...args);
    });
    expect(publicKey(await readOrCreateScopedGatewayKey(path, true, options, "ed25519"))).toBe(
      publicKey(winner),
    );
    expect(core.isEncryptedSecretFile(await files.readFile(path, "utf8"))).toBe(true);
    expect((await files.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "publication refusal leaves no identity or staged encrypted material",
  async () => {
    const path = join(directory, "refused.key");
    const refusal = Object.assign(new Error("Invented publication refusal"), { code: "EPERM" });
    vi.spyOn(files, "link").mockRejectedValueOnce(refusal);
    await expect(readOrCreateScopedGatewayKey(path, true, options, "ed25519")).rejects.toBe(
      refusal,
    );
    await expect(files.readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await files.readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  },
);

test("session serialization rejects oversized and already-cancelled values before publication", async () => {
  const path = join(directory, "session.json");
  const signal = AbortSignal.abort(new Error("Invented stopped session"));
  await expect(
    persistGatewayKeySession(path, { token: "invented-token" }, options, signal),
  ).rejects.toThrow("stopped session");
  await expect(
    persistGatewayKeySession(path, { token: "x".repeat(65_537) }, options),
  ).rejects.toThrow("too large");
  await expect(files.readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  await persistGatewayKeySession(path, { token: "invented-headless-token" }, undefined);
  expect(JSON.parse(await files.readFile(path, "utf8"))).toEqual({
    token: "invented-headless-token",
  });
});

test("a missing installation key never falls back to plaintext gateway identity or session publication", async () => {
  const configDir = join(directory, "unprovisioned");
  await files.mkdir(configDir, { mode: 0o700 });
  const unprovisioned: core.SecretFileOptions = {
    configDir,
    backend: "file",
    service: "invented-unprovisioned",
  };
  const key = join(configDir, "owner.key"),
    session = join(configDir, "session.json");
  await expect(readOrCreateScopedGatewayKey(key, true, unprovisioned, "ed25519")).rejects.toThrow(
    "unlocked installation key",
  );
  await expect(
    persistGatewayKeySession(session, { token: "invented-token" }, unprovisioned),
  ).rejects.toThrow("unlocked installation key");
  await expect(files.readFile(key)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(files.readFile(session)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["created", "winner", "refused", "unjoined-winner"] as const)(
  "Windows gateway identity publication %s respects the private OS boundary and stable winner",
  async (outcome) => {
    const path = join(directory, "windows-owner.key");
    const scoped = { ...options, platform: process.platform };
    const winner = generateKeyPairSync("ed25519").privateKey;
    let selected = (
      await core.serializeSecretFileValue(
        path,
        winner.export({ type: "pkcs8", format: "pem" }).toString(),
        scoped,
      )
    ).value;
    await core.primeSecretFileKeyCache(scoped);
    const read = vi
      .spyOn(core, "readWindowsPrivateFile")
      .mockRejectedValueOnce(Object.assign(new Error("Invented missing key"), { code: "ENOENT" }))
      .mockImplementation(async () => Buffer.from(selected));
    vi.spyOn(core, "ensurePrivateDirs").mockResolvedValue(undefined);
    const release = vi.fn();
    vi.spyOn(core, "acquireGatewayLock").mockImplementation(async (directory) => ({
      path: join(directory, "gateway.lock"),
      release,
    }));
    const failure = Object.assign(
      new Error("publication refused by fixture"),
      { code: outcome === "refused" ? "EPERM" : "EEXIST" },
      outcome === "unjoined-winner" ? { cleanupFailure: undefined, cleanupPending: true } : {},
    );
    const publish = vi
      .spyOn(core, "writeWindowsPrivateFileAtomicStream")
      .mockImplementation(async (target, stream, length, policy) => {
        expect(target).toBe(path);
        expect(policy).toEqual({ replaceExisting: false, timeoutMs: 30_000 });
        const chunks: Buffer[] = [];
        for await (const chunk of stream as AsyncIterable<Uint8Array>)
          chunks.push(Buffer.from(chunk));
        const serialized = Buffer.concat(chunks);
        expect(serialized.length).toBe(length);
        expect(core.isEncryptedSecretFile(serialized.toString("utf8"))).toBe(true);
        expect(serialized.toString("utf8")).not.toContain("PRIVATE KEY");
        if (outcome === "refused" || outcome === "unjoined-winner") throw failure;
        if (outcome === "created") selected = serialized.toString("utf8");
        await files.writeFile(path, selected, { mode: 0o600 });
        if (outcome === "winner") throw failure;
      });
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
    try {
      const result = readOrCreateScopedGatewayKey(path, true, scoped, "ed25519");
      if (outcome === "refused" || outcome === "unjoined-winner") {
        await expect(result).rejects.toBe(failure);
        expect(read).toHaveBeenCalledExactlyOnceWith(path, 131_072);
        await expect(files.readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        const key = await result;
        if (outcome === "winner") expect(publicKey(key)).toBe(publicKey(winner));
        expect(read).toHaveBeenCalledTimes(2);
        expect(core.isEncryptedSecretFile(await files.readFile(path, "utf8"))).toBe(true);
      }
      expect(publish).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect((await files.readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "root-key loss before winner upgrade cannot publish a plaintext fallback",
  async () => {
    const path = join(directory, "winner-after-key-loss.key");
    const winner = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    const link = files.link;
    vi.spyOn(files, "link").mockImplementationOnce(async (...args) => {
      await core.atomicWriteFile(path, winner, { mode: 0o600 });
      await core.createSecretStore(options).delete(core.OMNESIS_INSTALL_ROOT_KEY);
      await files.rm(core.secureMarkerPath("secret-files", directory));
      core.clearSecretFileKeyCacheForTests();
      return link(...args);
    });
    await expect(readOrCreateScopedGatewayKey(path, true, options, "ed25519")).rejects.toThrow(
      "unlocked installation key",
    );
    expect(await files.readFile(path, "utf8")).toBe(winner);
    expect((await files.readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  },
);

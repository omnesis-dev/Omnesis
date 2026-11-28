// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPrivateKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, rm, realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  atomicWriteFile,
  atomicWriteFileSync,
  decodeSecretTextFileValue,
  isEncryptedSecretFile,
  readWindowsPrivateFile,
  serializeSecretFileValue,
  writeWindowsPrivateFileAtomicStream,
  type SecretFileOptions,
} from "@omnesis/core";
import { withPairedDeviceFileLock } from "./paired-device-lock.js";
import { isJoinedPrivateFileError } from "./private-file-errors.js";

/** The desktop fixes these values before any cloud/configuration module is loaded. */
export function gatewayCredentialOptions(
  configDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): SecretFileOptions | undefined {
  if (env.OMNESIS_DESKTOP_MANAGED !== "1") return undefined;
  const root = configDir ?? env.OMNESIS_CONFIG_DIR,
    service = env.OMNESIS_SECRET_SERVICE;
  if (!root || !isAbsolute(root) || !service?.trim())
    throw new Error("The managed gateway credential scope is unavailable");
  return { configDir: root, service, backend: "macos-keychain" };
}

/** Private, held, bounded bytes; the ciphertext envelope is decoded only after its path is checked. */
export async function readGatewayPrivateSerialized(path: string): Promise<string> {
  if (process.platform === "win32")
    return (await readWindowsPrivateFile(path, 131_072)).toString("utf8");
  if (!isAbsolute(path) || (await realpath(dirname(path))) !== resolve(dirname(path)))
    throw new Error("The managed credential parent must remain canonical");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid()) ||
      info.size > 131_072
    )
      throw new Error("The managed private key is not a private bounded regular file");
    const bytes = Buffer.alloc(131_073),
      read = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat(),
      published = await lstat(path);
    if (
      read.bytesRead > 131_072 ||
      read.bytesRead !== info.size ||
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs ||
      published.isSymbolicLink() ||
      published.dev !== info.dev ||
      published.ino !== info.ino
    )
      throw new Error("The managed private key changed while reading");
    return bytes.subarray(0, read.bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

function checkAlgorithm(key: KeyObject, algorithm: "ed25519" | "p256"): void {
  if (
    algorithm === "ed25519"
      ? key.asymmetricKeyType !== "ed25519"
      : key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  )
    throw new Error("The managed gateway private key has an unsupported algorithm");
}

export async function readOrCreateScopedGatewayKey(
  path: string,
  allowCreate: boolean,
  options: SecretFileOptions,
  algorithm: "ed25519" | "p256",
): Promise<KeyObject> {
  return withPairedDeviceFileLock(path, async () => {
    let key: KeyObject, serialized: string | undefined;
    try {
      serialized = await readGatewayPrivateSerialized(path);
      key = createPrivateKey(await decodeSecretTextFileValue(path, serialized, options));
    } catch (error) {
      if (!isJoinedPrivateFileError(error, "ENOENT")) throw error;
      if (!allowCreate)
        throw new Error("The original gateway private identity must be restored", { cause: error });
      key =
        algorithm === "ed25519"
          ? generateKeyPairSync("ed25519").privateKey
          : generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    }
    checkAlgorithm(key, algorithm);
    if (serialized && isEncryptedSecretFile(serialized)) return key;
    const encoded = await serializeSecretFileValue(
      path,
      key.export({ type: "pkcs8", format: "pem" }).toString(),
      options,
      serialized,
    );
    if (!encoded.encrypted)
      throw new Error("The gateway private identity requires an unlocked installation key");
    if (serialized !== undefined) {
      // The shared lease excludes cooperating creators during the one-time plaintext upgrade.
      await atomicWriteFile(path, encoded.value, { mode: 0o600 });
      return key;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      if (process.platform === "win32") {
        const bytes = Buffer.from(encoded.value);
        try {
          await writeWindowsPrivateFileAtomicStream(
            path,
            Readable.from([bytes]),
            bytes.byteLength,
            { replaceExisting: false, timeoutMs: 30_000 },
          );
        } catch (error) {
          if (!isJoinedPrivateFileError(error, "EEXIST")) throw error;
        }
      } else {
        await atomicWriteFile(temporary, encoded.value, { mode: 0o600 });
        try {
          await link(temporary, path);
        } catch (error) {
          if (!isJoinedPrivateFileError(error, "EEXIST")) throw error;
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
    // An exclusive-publication winner always supplies the stable identity.
    const selectedRaw = await readGatewayPrivateSerialized(path);
    const selected = createPrivateKey(await decodeSecretTextFileValue(path, selectedRaw, options));
    checkAlgorithm(selected, algorithm);
    if (!isEncryptedSecretFile(selectedRaw)) {
      const winner = await serializeSecretFileValue(
        path,
        selected.export({ type: "pkcs8", format: "pem" }).toString(),
        options,
        selectedRaw,
      );
      if (!winner.encrypted)
        throw new Error("The gateway private identity requires an unlocked installation key");
      await atomicWriteFile(path, winner.value, { mode: 0o600 });
    }
    return selected;
  });
}

/** Async preparation, then one final cancellation check immediately before synchronous publication. */
export async function persistGatewayKeySession(
  path: string,
  value: unknown,
  options: SecretFileOptions | undefined,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const raw = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(raw) > 65_536) throw new Error("Gateway routing session is too large");
  const encoded = options
    ? await serializeSecretFileValue(path, raw, options)
    : { value: raw, encrypted: false };
  if (options && !encoded.encrypted)
    throw new Error("The gateway routing session requires an unlocked installation key");
  signal?.throwIfAborted();
  atomicWriteFileSync(path, encoded.value, { mode: 0o600 });
}

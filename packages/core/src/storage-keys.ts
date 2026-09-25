// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-store data-encryption keys for live encrypted storage.
 *
 * The OS secret store keeps the install root key. Each encrypted live store gets
 * a random DEK stored as an AES-GCM envelope under the config tree, wrapped by
 * that install root key. This keeps random-access database engines from sharing
 * one raw key while preserving the existing keyring portability model.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { secretPathExists } from "./security-files.js";
import { atomicWriteFile } from "./atomic-write.js";
import {
  installRootKeyBytes,
  readInstallRootKey,
  readInstallRootKeySync,
  type CreateSecretStoreOptions,
} from "./secret-store.js";
import { secureMarkerPath, writeSecureMarker, writeSecureMarkerSync } from "./secure-marker.js";
import { DEFAULT_CONFIG_DIR } from "./utils.js";

const ENVELOPE_MARKER = "omnesis.storage-key";
const ENVELOPE_VERSION = 1;
const ALG = "aes-256-gcm";
const KDF = "hkdf-sha256";
const STORAGE_KEY_BYTES = 32;
const TAG_BYTES = 16;

export const STORAGE_KEY_NAMES = [
  "main-db",
  "index-db",
  "analytics-db",
  "whatsapp-store",
  "imessage-transcripts",
  /**
   * The watch journal's key. The file is `watch.db`; this name is not.
   *
   * A key name is not a label — it is sealed into its envelope four ways: the
   * filename, the HKDF `info` that derives the wrapping key, the AES-GCM
   * additional data, and an equality check on decrypt. So the name cannot be
   * changed by moving a file; it needs a re-wrap under the new name, ordered
   * strictly before anything calls `ensureStorageKey`.
   *
   * That ordering is not enforceable. `ensureStorageKey` mints fresh random
   * bytes for a name it finds no envelope for, and `omnesis keyring
   * storage-init`, `omnesis secure` and each process's boot loop the host's
   * share of this list calling it — from outside the gateway, which is where
   * the ordering would have to live.
   * Running `storage-init` is also the documented repair for a doctor warning
   * about partial encryption. So a rename here has a plausible path to a
   * freshly minted key, a read that succeeds, and a journal that opens with a
   * key that never encrypted it.
   *
   * The bytes are random rather than derived from the name, so the same key
   * opens the same data whatever the file is called. The name stays.
   */
  "watch2-db",
] as const;

export type StorageKeyName = (typeof STORAGE_KEY_NAMES)[number] | `provider:${string}`;

/**
 * The process that opens each store, and so the process that must hold
 * its key before it runs. A gateway host mints the gateway's keys at boot;
 * a collector host mints the keys of the provider stores it hosts. A host
 * that runs both mints both from the one config directory.
 */
export type StorageKeyHost = "gateway" | "collector";

const STORAGE_KEY_HOSTS: Record<(typeof STORAGE_KEY_NAMES)[number], StorageKeyHost> = {
  "main-db": "gateway",
  "index-db": "gateway",
  "analytics-db": "gateway",
  "watch2-db": "gateway",
  "whatsapp-store": "collector",
  "imessage-transcripts": "collector",
};

/** The registered key names a process of `host` is responsible for. */
export function storageKeyNamesForHost(host: StorageKeyHost): readonly StorageKeyName[] {
  return STORAGE_KEY_NAMES.filter((name) => STORAGE_KEY_HOSTS[name] === host);
}

export interface StorageKeyOptions extends CreateSecretStoreOptions {
  configDir?: string;
}

export interface StorageKeyState {
  keyName: StorageKeyName;
  path: string;
  present: boolean;
  valid: boolean;
  encrypted: boolean;
}

export interface EnsureStorageKeyResult extends StorageKeyState {
  created: boolean;
}

interface StorageKeyEnvelopeV1 {
  omnesis: typeof ENVELOPE_MARKER;
  version: typeof ENVELOPE_VERSION;
  alg: typeof ALG;
  kdf: typeof KDF;
  keyName: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class StorageKeyRootKeyUnavailableError extends Error {
  readonly code = "OMNESIS_STORAGE_ROOT_KEY_UNAVAILABLE";

  constructor(readonly keyName: StorageKeyName) {
    super(
      `Cannot read Omnesis storage key ${keyName} without the install root key. Unlock the OS keyring or restore the Omnesis install root key first.`,
    );
    this.name = "StorageKeyRootKeyUnavailableError";
  }
}

export function storageEncryptionRequired(configDir?: string): boolean {
  return secretPathExists(storageEncryptionMarkerPath(configDir));
}

export async function markStorageEncryptionRequired(
  configDir?: string,
  opts: CreateSecretStoreOptions & { rootKeyValue?: string } = {},
): Promise<void> {
  await writeSecureMarker("storage-encryption", { ...opts, configDir });
}

export function markStorageEncryptionRequiredSync(
  configDir?: string,
  opts: CreateSecretStoreOptions & { rootKeyValue?: string } = {},
): void {
  writeSecureMarkerSync("storage-encryption", { ...opts, configDir });
}

export async function inspectStorageKey(
  keyName: StorageKeyName,
  opts: StorageKeyOptions = {},
): Promise<StorageKeyState> {
  const path = storageKeyPath(keyName, opts.configDir);
  if (!secretPathExists(path)) {
    return { keyName, path, present: false, valid: false, encrypted: false };
  }
  try {
    const raw = await readFile(path, "utf8");
    const envelope = parseEnvelope(raw);
    return {
      keyName,
      path,
      present: true,
      valid: envelope?.keyName === keyName,
      encrypted: envelope !== null,
    };
  } catch {
    return { keyName, path, present: true, valid: false, encrypted: false };
  }
}

export async function ensureStorageKey(
  keyName: StorageKeyName,
  opts: StorageKeyOptions = {},
): Promise<EnsureStorageKeyResult> {
  const existing = await readStorageKey(keyName, opts);
  if (existing) {
    const state = await inspectStorageKey(keyName, opts);
    return { ...state, created: false };
  }

  const rootKey = await readInstallRootKey(opts);
  if (!rootKey) throw new StorageKeyRootKeyUnavailableError(keyName);
  const key = randomBytes(STORAGE_KEY_BYTES);
  try {
    await markStorageEncryptionRequired(opts.configDir, { ...opts, rootKeyValue: rootKey });
    await atomicWriteFile(
      storageKeyPath(keyName, opts.configDir),
      encryptKey(keyName, key, rootKey),
      {
        mode: 0o600,
        ensureDir: true,
      },
    );
  } finally {
    key.fill(0);
  }
  const state = await inspectStorageKey(keyName, opts);
  return { ...state, created: true };
}

export async function readStorageKey(
  keyName: StorageKeyName,
  opts: StorageKeyOptions = {},
): Promise<Buffer | null> {
  const path = storageKeyPath(keyName, opts.configDir);
  if (!secretPathExists(path)) return null;
  const raw = await readFile(path, "utf8");
  const envelope = parseEnvelope(raw);
  if (!envelope) return null;
  const rootKey = await readInstallRootKey(opts);
  if (!rootKey) throw new StorageKeyRootKeyUnavailableError(keyName);
  return decryptKey(envelope, keyName, rootKey);
}

export function readStorageKeySync(
  keyName: StorageKeyName,
  opts: StorageKeyOptions = {},
): Buffer | null {
  const path = storageKeyPath(keyName, opts.configDir);
  if (!secretPathExists(path)) return null;
  const envelope = parseEnvelope(readFileSync(path, "utf8"));
  if (!envelope) return null;
  const rootKey = readInstallRootKeySync(opts);
  if (!rootKey) throw new StorageKeyRootKeyUnavailableError(keyName);
  return decryptKey(envelope, keyName, rootKey);
}

export async function rotateStorageKey(
  keyName: StorageKeyName,
  newKey: Buffer,
  opts: StorageKeyOptions = {},
): Promise<StorageKeyState> {
  if (newKey.length !== STORAGE_KEY_BYTES) {
    throw new Error(`Storage key ${keyName} must be ${STORAGE_KEY_BYTES} bytes`);
  }
  const rootKey = await readInstallRootKey(opts);
  if (!rootKey) throw new StorageKeyRootKeyUnavailableError(keyName);
  await markStorageEncryptionRequired(opts.configDir, { ...opts, rootKeyValue: rootKey });
  await atomicWriteFile(
    storageKeyPath(keyName, opts.configDir),
    encryptKey(keyName, newKey, rootKey),
    {
      mode: 0o600,
      ensureDir: true,
    },
  );
  return inspectStorageKey(keyName, opts);
}

export function storageKeyPath(keyName: StorageKeyName, configDir?: string): string {
  return join(
    configDir ?? DEFAULT_CONFIG_DIR,
    "keyring",
    "storage-keys",
    `${safeKeyName(keyName)}.json`,
  );
}

export function storageKeyHex(key: Buffer): string {
  if (key.length !== STORAGE_KEY_BYTES) {
    throw new Error(`Storage key must be ${STORAGE_KEY_BYTES} bytes`);
  }
  return key.toString("hex");
}

export function parseStorageKeyName(raw: string): StorageKeyName {
  if ((STORAGE_KEY_NAMES as readonly string[]).includes(raw)) return raw as StorageKeyName;
  if (raw.startsWith("provider:") && raw.length > "provider:".length) return raw as StorageKeyName;
  throw new Error(`Invalid Omnesis storage key name: ${raw}`);
}

function encryptKey(keyName: StorageKeyName, key: Buffer, rootKeyValue: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const wrappingKey = deriveWrappingKey(rootKeyValue, salt, keyName);
  const cipher = createCipheriv(ALG, wrappingKey, iv);
  cipher.setAAD(Buffer.from(keyName, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  const tag = cipher.getAuthTag();
  wrappingKey.fill(0);
  const envelope: StorageKeyEnvelopeV1 = {
    omnesis: ENVELOPE_MARKER,
    version: ENVELOPE_VERSION,
    alg: ALG,
    kdf: KDF,
    keyName,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function decryptKey(
  envelope: StorageKeyEnvelopeV1,
  expectedKeyName: StorageKeyName,
  rootKeyValue: string,
): Buffer {
  if (envelope.keyName !== expectedKeyName) {
    throw new Error(
      `Storage key scope mismatch: expected ${expectedKeyName}, got ${envelope.keyName}`,
    );
  }
  const wrappingKey = deriveWrappingKey(
    rootKeyValue,
    Buffer.from(envelope.salt, "base64url"),
    expectedKeyName,
  );
  try {
    const decipher = createDecipheriv(ALG, wrappingKey, Buffer.from(envelope.iv, "base64url"), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(expectedKeyName, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const key = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    if (key.length !== STORAGE_KEY_BYTES) {
      throw new Error(`Storage key ${expectedKeyName} has invalid length`);
    }
    return key;
  } finally {
    wrappingKey.fill(0);
  }
}

function deriveWrappingKey(rootKeyValue: string, salt: Buffer, keyName: string): Buffer {
  const rootKey = installRootKeyBytes(rootKeyValue);
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        rootKey,
        salt,
        Buffer.from(`omnesis:${ENVELOPE_MARKER}:${keyName}`, "utf8"),
        32,
      ),
    );
  } finally {
    rootKey.fill(0);
  }
}

function parseEnvelope(raw: string): StorageKeyEnvelopeV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.omnesis !== ENVELOPE_MARKER || candidate.version !== ENVELOPE_VERSION) return null;
  if (candidate.alg !== ALG || candidate.kdf !== KDF) return null;
  for (const key of ["keyName", "salt", "iv", "tag", "ciphertext"]) {
    if (typeof candidate[key] !== "string" || candidate[key].length === 0) return null;
  }
  return candidate as unknown as StorageKeyEnvelopeV1;
}

function storageEncryptionMarkerPath(configDir?: string): string {
  return secureMarkerPath("storage-encryption", configDir);
}

function safeKeyName(keyName: string): string {
  return basename(keyName)
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .replace(/:/g, "__");
}

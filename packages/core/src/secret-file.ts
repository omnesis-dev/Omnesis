// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Root-key-wrapped local secret files.
 *
 * The OS keyring stores one install root key. Durable files that already live
 * in the config tree can then store an AES-GCM envelope instead of plaintext,
 * while retaining plaintext read compatibility for installs that have not
 * initialized a keyring yet.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { SecretPathUnreadableError, secretPathExists } from "./security-files.js";
import { atomicWriteFile, atomicWriteFileSync } from "./atomic-write.js";
import {
  installRootKeyBytes,
  readInstallRootKey,
  readInstallRootKeySync,
  type CreateSecretStoreOptions,
} from "./secret-store.js";
import { secureMarkerPath, writeSecureMarker, writeSecureMarkerSync } from "./secure-marker.js";
import { DEFAULT_CONFIG_DIR } from "./utils.js";

const ENVELOPE_MARKER = "omnesis.secret-file";
const ENVELOPE_VERSION = 1;
const ALG = "aes-256-gcm";
const KDF = "hkdf-sha256";
const TAG_BYTES = 16;

export interface SecretFileOptions extends CreateSecretStoreOptions {
  /**
   * Stable associated data for the file. Defaults to the config-relative path.
   * Use an explicit scope only when the logical secret is not path-addressed.
   */
  scope?: string;
}

interface SecretFileEnvelopeV1 {
  omnesis: typeof ENVELOPE_MARKER;
  version: typeof ENVELOPE_VERSION;
  alg: typeof ALG;
  kdf: typeof KDF;
  scope: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface SecretFileWriteResult {
  encrypted: boolean;
}

export interface SecretFileMigrationResult extends SecretFileWriteResult {
  changed: boolean;
  present: boolean;
}

export class SecretFileRootKeyUnavailableError extends Error {
  readonly code = "OMNESIS_SECRET_ROOT_KEY_UNAVAILABLE";

  constructor(readonly path: string) {
    super(
      `Cannot read encrypted Omnesis secret file without the install root key: ${path}. Unlock the OS keyring or restore the Omnesis install root key first.`,
    );
    this.name = "SecretFileRootKeyUnavailableError";
  }
}

export function isSecretFileRootKeyUnavailableError(
  err: unknown,
): err is SecretFileRootKeyUnavailableError {
  return (
    err instanceof SecretFileRootKeyUnavailableError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { code?: unknown }).code === "OMNESIS_SECRET_ROOT_KEY_UNAVAILABLE")
  );
}

let cachedInstallRootKey: string | undefined;

export function clearSecretFileKeyCacheForTests(): void {
  cachedInstallRootKey = undefined;
}

export async function primeSecretFileKeyCache(
  opts: CreateSecretStoreOptions = {},
): Promise<boolean> {
  cachedInstallRootKey = (await readInstallRootKey(opts)) ?? undefined;
  return cachedInstallRootKey !== undefined;
}

export function secretFileScope(path: string, configDir?: string): string {
  const root = configDir ?? DEFAULT_CONFIG_DIR;
  const rel = relative(root, path).split(sep).join("/");
  return `config:${rel}`;
}

export function secretFileEncryptionRequired(configDir?: string): boolean {
  return secretPathExists(secretFileEncryptionMarkerPath(configDir));
}

export async function markSecretFileEncryptionRequired(
  configDir?: string,
  opts: CreateSecretStoreOptions & { rootKeyValue?: string } = {},
): Promise<void> {
  await writeSecureMarker("secret-files", { ...opts, configDir });
}

export function markSecretFileEncryptionRequiredSync(
  configDir?: string,
  opts: CreateSecretStoreOptions & { rootKeyValue?: string } = {},
): void {
  writeSecureMarkerSync("secret-files", { ...opts, configDir });
}

export function isEncryptedSecretFile(raw: string): boolean {
  return parseEnvelope(raw) !== null;
}

export async function readSecretTextFile(
  path: string,
  opts: SecretFileOptions = {},
): Promise<string | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf8");
  const envelope = parseEnvelope(raw);
  if (!envelope) return raw;

  const key = await installRootKey(opts);
  if (!key) throw new SecretFileRootKeyUnavailableError(path);
  return decryptEnvelope(envelope, key, expectedScope(path, opts));
}

export function readSecretTextFileSync(path: string, opts: SecretFileOptions = {}): string | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const envelope = parseEnvelope(raw);
  if (!envelope) return raw;

  const key = installRootKeySync(opts);
  if (!key) throw new SecretFileRootKeyUnavailableError(path);
  return decryptEnvelope(envelope, key, expectedScope(path, opts));
}

export async function readSecretJsonFile<T>(
  path: string,
  opts: SecretFileOptions = {},
): Promise<T | null> {
  const raw = await readSecretTextFile(path, opts);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

export function readSecretJsonFileSync<T>(path: string, opts: SecretFileOptions = {}): T | null {
  const raw = readSecretTextFileSync(path, opts);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

export async function writeSecretTextFile(
  path: string,
  value: string,
  opts: SecretFileOptions = {},
): Promise<SecretFileWriteResult> {
  const serialized = await serializeSecretValue(path, value, opts);
  await atomicWriteFile(path, serialized.value, { mode: 0o600, ensureDir: true });
  return { encrypted: serialized.encrypted };
}

export function writeSecretTextFileSync(
  path: string,
  value: string,
  opts: SecretFileOptions = {},
): SecretFileWriteResult {
  const serialized = serializeSecretValueSync(path, value, opts);
  atomicWriteFileSync(path, serialized.value, { mode: 0o600, ensureDir: true });
  return { encrypted: serialized.encrypted };
}

export async function writeSecretJsonFile(
  path: string,
  value: unknown,
  opts: SecretFileOptions = {},
): Promise<SecretFileWriteResult> {
  return writeSecretTextFile(path, JSON.stringify(value, null, 2), opts);
}

export function writeSecretJsonFileSync(
  path: string,
  value: unknown,
  opts: SecretFileOptions = {},
): SecretFileWriteResult {
  return writeSecretTextFileSync(path, JSON.stringify(value, null, 2), opts);
}

export async function migrateSecretTextFile(
  path: string,
  opts: SecretFileOptions = {},
): Promise<SecretFileMigrationResult> {
  if (!existsSync(path)) return { present: false, changed: false, encrypted: false };
  const raw = await readFile(path, "utf8");
  if (parseEnvelope(raw)) return { present: true, changed: false, encrypted: true };

  const key = await installRootKey(opts);
  if (!key) return { present: true, changed: false, encrypted: false };

  await armSecretFilesMarkerIfAbsent(opts);
  await atomicWriteFile(path, encryptEnvelope(raw, key, expectedScope(path, opts)), {
    mode: 0o600,
    ensureDir: true,
  });
  return { present: true, changed: true, encrypted: true };
}

async function serializeSecretValue(
  path: string,
  value: string,
  opts: SecretFileOptions,
): Promise<{ value: string; encrypted: boolean }> {
  const key = await installRootKey(opts);
  if (!key) {
    if (secretFileEncryptionRequired(opts.configDir) || (await existingFileIsEncrypted(path))) {
      throw encryptedRewriteWithoutKeyError(path);
    }
    return { value, encrypted: false };
  }
  await armSecretFilesMarkerIfAbsent(opts);
  return { value: encryptEnvelope(value, key, expectedScope(path, opts)), encrypted: true };
}

function serializeSecretValueSync(
  path: string,
  value: string,
  opts: SecretFileOptions,
): { value: string; encrypted: boolean } {
  const key = installRootKeySync(opts);
  if (!key) {
    if (secretFileEncryptionRequired(opts.configDir) || existingFileIsEncryptedSync(path)) {
      throw encryptedRewriteWithoutKeyError(path);
    }
    return { value, encrypted: false };
  }
  armSecretFilesMarkerIfAbsentSync(opts);
  return { value: encryptEnvelope(value, key, expectedScope(path, opts)), encrypted: true };
}

/**
 * Arm the secret-files marker only when it does not exist yet. The hot write
 * path must not touch the secret store on every call, and re-writing an
 * existing marker through a DIFFERENT store than the caller's (opts may name a
 * non-default backend) could re-key its MAC under the wrong install root key.
 * The cached root-key string is threaded through so the marker is MAC-bound
 * to the same key that encrypts the secret files.
 *
 * Reached only with a root key in hand, so the value being written is already
 * encrypted and arming is bookkeeping. A marker that cannot be read therefore
 * skips rather than refusing: the caller's write is safe either way, and
 * failing it would stall every credential write on an install whose root key
 * lives outside the unreadable directory. The decision that must fail closed
 * is the one taken without a key, above.
 */
async function armSecretFilesMarkerIfAbsent(opts: SecretFileOptions): Promise<void> {
  if (markerPresentOrUnreadable(opts.configDir)) return;
  await markSecretFileEncryptionRequired(opts.configDir, {
    ...opts,
    ...(cachedInstallRootKey ? { rootKeyValue: cachedInstallRootKey } : {}),
  });
}

function armSecretFilesMarkerIfAbsentSync(opts: SecretFileOptions): void {
  if (markerPresentOrUnreadable(opts.configDir)) return;
  markSecretFileEncryptionRequiredSync(opts.configDir, {
    ...opts,
    ...(cachedInstallRootKey ? { rootKeyValue: cachedInstallRootKey } : {}),
  });
}

/** Whether arming can be skipped: the marker is already there, or out of reach. */
function markerPresentOrUnreadable(configDir?: string): boolean {
  try {
    return secretFileEncryptionRequired(configDir);
  } catch (err) {
    if (err instanceof SecretPathUnreadableError) return true;
    throw err;
  }
}

async function installRootKey(opts: CreateSecretStoreOptions): Promise<Buffer | null> {
  const fromCache = cachedInstallRootKey;
  if (fromCache !== undefined) return installRootKeyBytes(fromCache);
  const key = await readInstallRootKey(opts);
  if (key) cachedInstallRootKey = key;
  return key ? installRootKeyBytes(key) : null;
}

function installRootKeySync(opts: CreateSecretStoreOptions): Buffer | null {
  const fromCache = cachedInstallRootKey;
  if (fromCache !== undefined) return installRootKeyBytes(fromCache);
  const key = readInstallRootKeySync(opts);
  if (key) cachedInstallRootKey = key;
  return key ? installRootKeyBytes(key) : null;
}

function expectedScope(path: string, opts: SecretFileOptions): string {
  return opts.scope ?? secretFileScope(path, opts.configDir);
}

function secretFileEncryptionMarkerPath(configDir?: string): string {
  return secureMarkerPath("secret-files", configDir);
}

async function existingFileIsEncrypted(path: string): Promise<boolean> {
  if (!secretPathExists(path)) return false;
  try {
    return parseEnvelope(await readFile(path, "utf8")) !== null;
  } catch {
    return false;
  }
}

function existingFileIsEncryptedSync(path: string): boolean {
  if (!secretPathExists(path)) return false;
  try {
    return parseEnvelope(readFileSync(path, "utf8")) !== null;
  } catch {
    return false;
  }
}

function encryptedRewriteWithoutKeyError(path: string): Error {
  return new Error(
    `Refusing to write Omnesis secret file without the install root key after keyring-backed secret files were enabled: ${path}. Unlock the OS keyring or restore the Omnesis install root key first.`,
  );
}

function encryptEnvelope(plaintext: string, rootKey: Buffer, scope: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(rootKey, salt, scope);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope: SecretFileEnvelopeV1 = {
    omnesis: ENVELOPE_MARKER,
    version: ENVELOPE_VERSION,
    alg: ALG,
    kdf: KDF,
    scope,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function decryptEnvelope(envelope: SecretFileEnvelopeV1, rootKey: Buffer, scope: string): string {
  if (envelope.scope !== scope) {
    throw new Error(`Encrypted secret scope mismatch: expected ${scope}, got ${envelope.scope}`);
  }
  const salt = Buffer.from(envelope.salt, "base64url");
  const iv = Buffer.from(envelope.iv, "base64url");
  const key = deriveKey(rootKey, salt, scope);
  const decipher = createDecipheriv(ALG, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(scope, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function deriveKey(rootKey: Buffer, salt: Buffer, scope: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      rootKey,
      salt,
      Buffer.from(`omnesis:${ENVELOPE_MARKER}:${scope}`, "utf8"),
      32,
    ),
  );
}

function parseEnvelope(raw: string): SecretFileEnvelopeV1 | null {
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
  for (const key of ["scope", "salt", "iv", "tag", "ciphertext"]) {
    if (typeof candidate[key] !== "string" || candidate[key].length === 0) return null;
  }
  return candidate as unknown as SecretFileEnvelopeV1;
}

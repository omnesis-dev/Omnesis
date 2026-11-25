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

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  encryptEnvelope,
  decryptEnvelope,
  parseEnvelope,
  encryptEnvelopeAsync,
  decryptEnvelopeAsync,
} from "./secret-file-crypto.js";
import { SecretPathUnreadableError, secretPathExists } from "./security-files.js";
import { atomicWriteFile, atomicWriteFileSync } from "./atomic-write.js";
import {
  installRootKeyBytes,
  resolveSecretStoreService,
  parseSecretStoreBackend,
  readInstallRootKey,
  readInstallRootKeySync,
  type CreateSecretStoreOptions,
} from "./secret-store.js";
import { secureMarkerPath, writeSecureMarker, writeSecureMarkerSync } from "./secure-marker.js";
import { DEFAULT_CONFIG_DIR } from "./utils.js";
import { readPrivateSecretText, readPrivateSecretTextSync } from "./secret-store-files.js";

export interface SecretFileOptions extends CreateSecretStoreOptions {
  /**
   * Stable associated data for the file. Defaults to the config-relative path.
   * Use an explicit scope only when the logical secret is not path-addressed.
   */
  scope?: string;
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

type RootKeyScope = Required<
  Pick<CreateSecretStoreOptions, "configDir" | "service" | "platform" | "backend">
> &
  Pick<CreateSecretStoreOptions, "runCommand">;

// Keep only one installation warm, without retaining an unbounded set of keys.
let cachedInstallRootKey: { scope: RootKeyScope; value: string } | undefined;

function rootKeyScope(opts: CreateSecretStoreOptions): RootKeyScope {
  return {
    configDir: resolve(opts.configDir ?? DEFAULT_CONFIG_DIR),
    service: opts.service ?? resolveSecretStoreService(),
    platform: opts.platform ?? process.platform,
    backend: opts.backend ?? parseSecretStoreBackend(process.env.OMNESIS_SECRET_STORE),
    runCommand: opts.runCommand,
  };
}

function cachedKeyFor(scope: RootKeyScope): string | undefined {
  const cached = cachedInstallRootKey;
  if (!cached) return undefined;
  const previous = cached.scope;
  if (
    previous.configDir !== scope.configDir ||
    previous.service !== scope.service ||
    previous.platform !== scope.platform ||
    previous.runCommand !== scope.runCommand ||
    (scope.backend !== "auto" && previous.backend !== scope.backend)
  )
    return undefined;
  // Daemons prime the chosen backend before synchronous credential writes.
  // Automatic same-install callers must not reopen an unavailable keyring.
  return cached.value;
}

/** Release cached install authority after key replacement or removal. */
export function invalidateSecretFileKeyCache(): void {
  cachedInstallRootKey = undefined;
}

export function clearSecretFileKeyCacheForTests(): void {
  invalidateSecretFileKeyCache();
}

export async function primeSecretFileKeyCache(
  opts: CreateSecretStoreOptions = {},
): Promise<boolean> {
  const scope = rootKeyScope(opts);
  const value = await readInstallRootKey(scope);
  cachedInstallRootKey = value ? { scope, value } : undefined;
  return value !== null;
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

/**
 * Whether a secret file written now would be encrypted at rest: the install
 * root key is readable through this process's secret store. False on any
 * failure to read it, which is when a write stays plaintext (or is refused).
 */
export async function secretFileWritesEncrypted(
  opts: CreateSecretStoreOptions = {},
): Promise<boolean> {
  try {
    return (await installRootKey(opts)) !== null;
  } catch {
    return false;
  }
}

/**
 * Rewrap an authenticated secret for an explicit logical destination without
 * installing either root key or returning plaintext to the caller.
 */
export function rewrapSecretFileValue(
  raw: string,
  options: {
    sourceRootKey: string;
    targetRootKey: string;
    sourceScope: string;
    targetScope: string;
  },
): string {
  let sourceKey: Buffer | undefined;
  let targetKey: Buffer | undefined;
  try {
    if (
      Buffer.byteLength(raw) > 16 * 1024 * 1024 ||
      [options.sourceScope, options.targetScope].some(
        (scope) => !scope || Buffer.byteLength(scope) > 4096 || scope.includes("\0"),
      )
    ) {
      throw new Error("Invalid rewrap input");
    }
    const envelope = parseEnvelope(raw);
    if (!envelope) throw new Error("An encrypted secret is required");
    sourceKey = installRootKeyBytes(options.sourceRootKey);
    targetKey = installRootKeyBytes(options.targetRootKey);
    return encryptEnvelope(
      decryptEnvelope(envelope, sourceKey, options.sourceScope),
      targetKey,
      options.targetScope,
    );
  } catch {
    throw new Error("The encrypted secret could not be rewrapped for this library");
  } finally {
    sourceKey?.fill(0);
    targetKey?.fill(0);
  }
}

/** Async counterpart for bounded responsiveness while importing personal content. */
export async function rewrapSecretFileValueAsync(
  raw: string,
  options: {
    sourceRootKey: string;
    targetRootKey: string;
    sourceScope: string;
    targetScope: string;
  },
): Promise<string> {
  let sourceKey: Buffer | undefined;
  let targetKey: Buffer | undefined;
  try {
    if (
      Buffer.byteLength(raw) > 16 * 1024 * 1024 ||
      [options.sourceScope, options.targetScope].some(
        (scope) => !scope || Buffer.byteLength(scope) > 4096 || scope.includes("\0"),
      )
    ) {
      throw new Error("Invalid rewrap input");
    }
    const envelope = parseEnvelope(raw);
    if (!envelope) throw new Error("An encrypted secret is required");
    sourceKey = installRootKeyBytes(options.sourceRootKey);
    targetKey = installRootKeyBytes(options.targetRootKey);
    return await encryptEnvelopeAsync(
      await decryptEnvelopeAsync(envelope, sourceKey, options.sourceScope),
      targetKey,
      options.targetScope,
    );
  } catch {
    throw new Error("The encrypted secret could not be rewrapped for this library");
  } finally {
    sourceKey?.fill(0);
    targetKey?.fill(0);
  }
}

export function isEncryptedSecretFile(raw: string): boolean {
  return parseEnvelope(raw) !== null;
}

export async function readSecretTextFile(
  path: string,
  opts: SecretFileOptions = {},
): Promise<string | null> {
  const raw = await readSerializedSecretFile(path);
  if (raw === null) return null;
  return decodeSecretTextFileValue(path, raw, opts);
}

/** Decode a value already read through its filesystem security boundary, without reopening it. */
export async function decodeSecretTextFileValue(
  path: string,
  raw: string,
  opts: SecretFileOptions = {},
): Promise<string> {
  const envelope = parseEnvelope(raw);
  if (!envelope) return raw;

  const key = await installRootKey(opts);
  if (!key) throw new SecretFileRootKeyUnavailableError(path);
  return decryptEnvelopeAsync(envelope, key.bytes, expectedScope(path, opts));
}

export function readSecretTextFileSync(path: string, opts: SecretFileOptions = {}): string | null {
  const raw = readSerializedSecretFileSync(path);
  if (raw === null) return null;
  return decodeSecretTextFileValueSync(path, raw, opts);
}

/** Decode a verified serialized value without replacing a pinned read with a second path lookup. */
export function decodeSecretTextFileValueSync(
  path: string,
  raw: string,
  opts: SecretFileOptions = {},
): string {
  const envelope = parseEnvelope(raw);
  if (!envelope) return raw;

  const key = installRootKeySync(opts);
  if (!key) throw new SecretFileRootKeyUnavailableError(path);
  return decryptEnvelope(envelope, key.bytes, expectedScope(path, opts));
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

/** Prepare protected bytes for a caller that supplies its own atomic publication fence. */
export function serializeSecretFileValue(
  path: string,
  value: string,
  opts: SecretFileOptions = {},
  previousSerializedValue?: string | null,
): Promise<{ value: string; encrypted: boolean }> {
  return serializeSecretValue(path, value, opts, previousSerializedValue);
}

export async function writeSecretTextFile(
  path: string,
  value: string,
  opts: SecretFileOptions = {},
  previousSerializedValue?: string | null,
): Promise<SecretFileWriteResult> {
  const serialized = await serializeSecretValue(path, value, opts, previousSerializedValue);
  await atomicWriteFile(path, serialized.value, { mode: 0o600, ensureDir: true });
  return { encrypted: serialized.encrypted };
}

/** A verified prior value preserves the encryption requirement when relocating a logical secret. */
export function writeSecretTextFileSync(
  path: string,
  value: string,
  opts: SecretFileOptions = {},
  previousSerializedValue?: string | null,
): SecretFileWriteResult {
  const serialized = serializeSecretValueSync(path, value, opts, previousSerializedValue);
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
  const raw = await readSerializedSecretFile(path);
  if (raw === null) return { present: false, changed: false, encrypted: false };
  if (parseEnvelope(raw)) return { present: true, changed: false, encrypted: true };

  const key = await installRootKey(opts);
  if (!key) return { present: true, changed: false, encrypted: false };

  await armSecretFilesMarkerIfAbsent(opts, key.value);
  await atomicWriteFile(
    path,
    await encryptEnvelopeAsync(raw, key.bytes, expectedScope(path, opts)),
    {
      mode: 0o600,
      ensureDir: true,
    },
  );
  return { present: true, changed: true, encrypted: true };
}

async function serializeSecretValue(
  path: string,
  value: string,
  opts: SecretFileOptions,
  previousSerializedValue?: string | null,
): Promise<{ value: string; encrypted: boolean }> {
  const key = await installRootKey(opts);
  if (!key) {
    if (
      secretFileEncryptionRequired(opts.configDir) ||
      (typeof previousSerializedValue === "string" &&
        isEncryptedSecretFile(previousSerializedValue)) ||
      (await existingFileIsEncrypted(path))
    ) {
      throw encryptedRewriteWithoutKeyError(path);
    }
    return { value, encrypted: false };
  }
  await armSecretFilesMarkerIfAbsent(opts, key.value);
  return {
    value: await encryptEnvelopeAsync(value, key.bytes, expectedScope(path, opts)),
    encrypted: true,
  };
}

function serializeSecretValueSync(
  path: string,
  value: string,
  opts: SecretFileOptions,
  previousSerializedValue?: string | null,
): { value: string; encrypted: boolean } {
  const key = installRootKeySync(opts);
  if (!key) {
    if (
      secretFileEncryptionRequired(opts.configDir) ||
      (typeof previousSerializedValue === "string" &&
        isEncryptedSecretFile(previousSerializedValue)) ||
      existingFileIsEncryptedSync(path)
    ) {
      throw encryptedRewriteWithoutKeyError(path);
    }
    return { value, encrypted: false };
  }
  armSecretFilesMarkerIfAbsentSync(opts, key.value);
  return {
    value: encryptEnvelope(value, key.bytes, expectedScope(path, opts)),
    encrypted: true,
  };
}

/**
 * Arm the secret-files marker only when it does not exist yet. The hot write
 * path must not touch the secret store on every call, and re-writing an
 * existing marker through a DIFFERENT store than the caller's (opts may name a
 * non-default backend) could re-key its MAC under the wrong install root key.
 * The operation's root-key string is threaded through so the marker is MAC-bound
 * to the same key that encrypts the secret files.
 *
 * Reached only with a root key in hand, so the value being written is already
 * encrypted and arming is bookkeeping. A marker that cannot be read therefore
 * skips rather than refusing: the caller's write is safe either way, and
 * failing it would stall every credential write on an install whose root key
 * lives outside the unreadable directory. The decision that must fail closed
 * is the one taken without a key, above.
 */
async function armSecretFilesMarkerIfAbsent(opts: SecretFileOptions, key: string): Promise<void> {
  if (markerPresentOrUnreadable(opts.configDir)) return;
  await markSecretFileEncryptionRequired(opts.configDir, {
    ...opts,
    rootKeyValue: key,
  });
}

function armSecretFilesMarkerIfAbsentSync(opts: SecretFileOptions, key: string): void {
  if (markerPresentOrUnreadable(opts.configDir)) return;
  markSecretFileEncryptionRequiredSync(opts.configDir, {
    ...opts,
    rootKeyValue: key,
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

type SecretFileKey = { value: string; bytes: Buffer };

async function installRootKey(opts: CreateSecretStoreOptions): Promise<SecretFileKey | null> {
  const scope = rootKeyScope(opts);
  const fromCache = cachedKeyFor(scope);
  if (fromCache !== undefined) return { value: fromCache, bytes: installRootKeyBytes(fromCache) };
  const value = await readInstallRootKey(scope);
  if (value) cachedInstallRootKey = { scope, value };
  return value ? { value, bytes: installRootKeyBytes(value) } : null;
}

function installRootKeySync(opts: CreateSecretStoreOptions): SecretFileKey | null {
  const scope = rootKeyScope(opts);
  const fromCache = cachedKeyFor(scope);
  if (fromCache !== undefined) return { value: fromCache, bytes: installRootKeyBytes(fromCache) };
  const value = readInstallRootKeySync(scope);
  if (value) cachedInstallRootKey = { scope, value };
  return value ? { value, bytes: installRootKeyBytes(value) } : null;
}

function expectedScope(path: string, opts: SecretFileOptions): string {
  return opts.scope ?? secretFileScope(path, opts.configDir);
}

function secretFileEncryptionMarkerPath(configDir?: string): string {
  return secureMarkerPath("secret-files", configDir);
}

async function existingFileIsEncrypted(path: string): Promise<boolean> {
  if (process.platform === "win32") {
    const raw = await readPrivateSecretText(path);
    return raw !== null && isEncryptedSecretFile(raw);
  }
  if (!secretPathExists(path)) return false;
  try {
    return parseEnvelope(await readFile(path, "utf8")) !== null;
  } catch {
    return false;
  }
}

function existingFileIsEncryptedSync(path: string): boolean {
  if (process.platform === "win32") {
    const raw = readPrivateSecretTextSync(path);
    return raw !== null && isEncryptedSecretFile(raw);
  }
  if (!secretPathExists(path)) return false;
  try {
    return parseEnvelope(readFileSync(path, "utf8")) !== null;
  } catch {
    return false;
  }
}

async function readSerializedSecretFile(path: string): Promise<string | null> {
  if (process.platform === "win32") return readPrivateSecretText(path);
  if (!existsSync(path)) return null;
  return readFile(path, "utf8");
}

function readSerializedSecretFileSync(path: string): string | null {
  if (process.platform === "win32") return readPrivateSecretTextSync(path);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function encryptedRewriteWithoutKeyError(path: string): Error {
  return new Error(
    `Refusing to write Omnesis secret file without the install root key after keyring-backed secret files were enabled: ${path}. Unlock the OS keyring or restore the Omnesis install root key first.`,
  );
}

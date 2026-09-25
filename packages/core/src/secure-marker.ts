// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Integrity-bound fail-closed markers.
 *
 * Two marker files under `<configDir>/keyring/` arm Omnesis's fail-closed
 * encryption behavior: `storage-encryption-required` (live DB encryption) and
 * `secret-files-required` (secret-file encryption). Their mere existence is the
 * signal consumers act on — which historically meant deleting a marker silently
 * downgraded a secured install back to plaintext.
 *
 * This module closes that gap with two complementary mechanisms:
 *
 *  - **Tamper/provenance binding.** A v2 marker carries an HMAC-SHA256 keyed by
 *    a key HKDF-derived from the install root key. A marker forged or copied
 *    from a *different* install (different root key) fails verification; a
 *    legacy v1 marker (bare sentinel string) is recognized and upgraded in
 *    place the first time a root-key holder verifies it.
 *
 *  - **Deletion detection.** The marker's "encryption is required" fact is
 *    mirrored as a state entry in the same OS secret store that holds the root
 *    key. A deleted marker file no longer looks like "never enabled": boot sees
 *    the keyring state and fails loud instead of quietly opening plaintext.
 *    State reads fail OPEN (an unavailable secret store must not brick a
 *    plaintext install); only a positive "required" answer escalates.
 *
 * The honest limit: a same-user attacker who can delete files can usually also
 * delete keyring entries. The threats this closes are the accidental ones —
 * partial restores, bad syncs, overzealous cleanup — plus cross-install marker
 * confusion, which are exactly the paths that silently downgraded before.
 */

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWriteFile, atomicWriteFileSync } from "./atomic-write.js";
import { createLogger } from "./logger.js";
import { SecretPathUnreadableError, ensurePrivateDirSync } from "./security-files.js";
import {
  createSecretStore,
  installRootKeyBytes,
  readInstallRootKey,
  readInstallRootKeySync,
  type CreateSecretStoreOptions,
} from "./secret-store.js";
import { DEFAULT_CONFIG_DIR } from "./utils.js";

export type SecureMarkerKind = "storage-encryption" | "secret-files";

/**
 * Verification verdict for a marker file:
 *  - `valid`   — v2 marker whose MAC verifies under the given root key.
 *  - `legacy`  — pre-MAC v1 sentinel; treat as required and upgrade when possible.
 *  - `invalid` — present but unparseable, or the MAC does not verify (tampered,
 *                corrupted, or written under a different install's root key).
 *  - `missing` — no marker file.
 */
export type SecureMarkerStatus = "valid" | "legacy" | "invalid" | "missing";

interface MarkerMeta {
  file: string;
  legacyContent: string;
  headerLine: string;
  stateName: string;
}

const MARKER_META: Record<SecureMarkerKind, MarkerMeta> = {
  "storage-encryption": {
    file: "storage-encryption-required",
    legacyContent: "omnesis.storage-encryption.required.v1\n",
    headerLine: "omnesis.storage-encryption.required.v2",
    stateName: "storage-encryption-state-v1",
  },
  "secret-files": {
    file: "secret-files-required",
    legacyContent: "omnesis.secret-files.required.v1\n",
    headerLine: "omnesis.secret-files.required.v2",
    stateName: "secret-files-state-v1",
  },
};

const log = createLogger("core:secure-marker");

const SALT_BYTES = 16;
const MAC_BYTES = 32;
/** Value stored in the secret store while a marker is armed. */
const STATE_REQUIRED = "required";

/**
 * Per-install discriminator appended to the state entry name. OS keyrings
 * (macOS Keychain, Secret Service) key entries per OS user, not per install —
 * but markers are per config dir, and one machine legitimately runs several
 * installs (a live gateway plus disposable test instances). Without this, one
 * install's armed state would brick every other config dir's boot as a
 * false-positive "marker deleted". Derived from the resolved config-dir path,
 * so a config dir restored to the SAME path keeps its state, while a new path
 * simply starts unarmed (the valid-marker self-heal re-arms it).
 */
function stateEntryName(kind: SecureMarkerKind, configDir?: string): string {
  const dir = resolve(configDir ?? DEFAULT_CONFIG_DIR);
  const discriminator = createHash("sha256").update(dir, "utf8").digest("base64url").slice(0, 12);
  return `${MARKER_META[kind].stateName}:${discriminator}`;
}

export interface SecureMarkerOptions extends CreateSecretStoreOptions {
  configDir?: string;
  /**
   * Pre-read install root key value, so callers that already hold it (e.g.
   * `ensureStorageKey`) avoid a second secret-store round trip.
   */
  rootKeyValue?: string;
}

export function secureMarkerPath(kind: SecureMarkerKind, configDir?: string): string {
  return join(configDir ?? DEFAULT_CONFIG_DIR, "keyring", MARKER_META[kind].file);
}

/** Render a v2 marker body: header line, then base64url salt and MAC lines. */
export function renderSecureMarker(kind: SecureMarkerKind, rootKeyValue: string): string {
  const meta = MARKER_META[kind];
  const salt = randomBytes(SALT_BYTES);
  const mac = computeMarkerMac(kind, rootKeyValue, salt);
  return `${meta.headerLine}\nsalt=${salt.toString("base64url")}\nmac=${mac.toString("base64url")}\n`;
}

/** Classify raw marker file content against a root key. Pure — no IO. */
export function classifySecureMarker(
  kind: SecureMarkerKind,
  raw: string,
  rootKeyValue: string,
): Exclude<SecureMarkerStatus, "missing"> {
  const meta = MARKER_META[kind];
  if (raw === meta.legacyContent) return "legacy";
  const lines = raw.split("\n");
  if (lines[0] !== meta.headerLine) return "invalid";
  const salt = decodeField(lines[1], "salt");
  const mac = decodeField(lines[2], "mac");
  if (!salt || salt.length !== SALT_BYTES || !mac || mac.length !== MAC_BYTES) return "invalid";
  const expected = computeMarkerMac(kind, rootKeyValue, salt);
  return timingSafeEqual(mac, expected) ? "valid" : "invalid";
}

/** Read + classify a marker file. `missing` when the file does not exist. */
export async function verifySecureMarker(
  kind: SecureMarkerKind,
  rootKeyValue: string,
  configDir?: string,
): Promise<SecureMarkerStatus> {
  const path = secureMarkerPath(kind, configDir);
  if (!existsSync(path)) return "missing";
  try {
    return classifySecureMarker(kind, await readFile(path, "utf8"), rootKeyValue);
  } catch {
    return "invalid";
  }
}

/**
 * Write (or upgrade) a marker. With a root key available — passed in or read
 * from the secret store — the marker is written in the MAC-bound v2 format and
 * the keyring-side state entry is set (best-effort). Without one, the legacy
 * v1 sentinel is written so existence semantics still hold for callers that
 * arm the marker before a root key exists.
 */
export async function writeSecureMarker(
  kind: SecureMarkerKind,
  opts: SecureMarkerOptions = {},
): Promise<void> {
  const meta = MARKER_META[kind];
  const path = secureMarkerPath(kind, opts.configDir);
  ensurePrivateDirSync(join(opts.configDir ?? DEFAULT_CONFIG_DIR, "keyring"));
  const rootKeyValue = opts.rootKeyValue ?? (await readInstallRootKey(opts).catch(() => null));
  if (!rootKeyValue) {
    // Never downgrade: with no readable root key, an existing marker (possibly
    // MAC-bound) is left untouched; only an absent marker is armed as legacy.
    if (!existsSync(path)) await atomicWriteFile(path, meta.legacyContent, { mode: 0o600 });
    return;
  }
  const current = existsSync(path) ? await readFile(path, "utf8").catch(() => null) : null;
  if (current === null || classifySecureMarker(kind, current, rootKeyValue) !== "valid") {
    await atomicWriteFile(path, renderSecureMarker(kind, rootKeyValue), { mode: 0o600 });
  }
  await setMarkerKeyringState(kind, opts).catch((err: unknown) => {
    // Best-effort defense-in-depth: an unavailable store must not block
    // arming, but a permanently unarmed deletion-detection layer is worth a
    // line in the log.
    log.warn(
      `Could not record ${kind} marker state in the secret store — deletion detection stays unarmed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

export function writeSecureMarkerSync(
  kind: SecureMarkerKind,
  opts: SecureMarkerOptions = {},
): void {
  const meta = MARKER_META[kind];
  const path = secureMarkerPath(kind, opts.configDir);
  ensurePrivateDirSync(join(opts.configDir ?? DEFAULT_CONFIG_DIR, "keyring"));
  let rootKeyValue = opts.rootKeyValue ?? null;
  if (!rootKeyValue) {
    try {
      rootKeyValue = readInstallRootKeySync(opts);
    } catch {
      rootKeyValue = null;
    }
  }
  if (!rootKeyValue) {
    if (!existsSync(path)) atomicWriteFileSync(path, meta.legacyContent, { mode: 0o600 });
    return;
  }
  let current: string | null = null;
  if (existsSync(path)) {
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = null;
    }
  }
  if (current === null || classifySecureMarker(kind, current, rootKeyValue) !== "valid") {
    atomicWriteFileSync(path, renderSecureMarker(kind, rootKeyValue), { mode: 0o600 });
  }
  // The sync path cannot await the store write; the async boot self-heal sets
  // the state entry on the next verification pass.
}

/**
 * Read the keyring-side marker state. Returns `"required"` only on a positive
 * answer; `null` for absent or unavailable-store — deletion detection must
 * never brick an install whose secret store is simply offline.
 *
 * A store whose material is present but *unreadable* is the one failure this
 * does not absorb. An offline store answers nothing about what was armed; an
 * unreadable one is hiding an answer, and reporting that as "not armed" is
 * exactly the reading that lets an armed install open plaintext.
 */
export async function readMarkerKeyringState(
  kind: SecureMarkerKind,
  opts: CreateSecretStoreOptions = {},
): Promise<"required" | null> {
  try {
    const value = await createSecretStore(opts).read(stateEntryName(kind, opts.configDir));
    return value === STATE_REQUIRED ? "required" : null;
  } catch (err) {
    if (err instanceof SecretPathUnreadableError) throw err;
    return null;
  }
}

/** Record in the secret store that this marker is armed. */
export async function setMarkerKeyringState(
  kind: SecureMarkerKind,
  opts: CreateSecretStoreOptions = {},
): Promise<void> {
  await createSecretStore(opts).write(stateEntryName(kind, opts.configDir), STATE_REQUIRED);
}

/**
 * Clear the keyring-side state (the intentional-disable escape hatch used by
 * tooling; there is no supported decrypt-in-place flow, so this exists for
 * rebuilt-from-scratch installs).
 */
export async function clearMarkerKeyringState(
  kind: SecureMarkerKind,
  opts: CreateSecretStoreOptions = {},
): Promise<void> {
  await createSecretStore(opts).delete(stateEntryName(kind, opts.configDir));
}

function computeMarkerMac(kind: SecureMarkerKind, rootKeyValue: string, salt: Buffer): Buffer {
  const rootKey = installRootKeyBytes(rootKeyValue);
  try {
    const macKey = Buffer.from(
      hkdfSync("sha256", rootKey, salt, Buffer.from(`omnesis:secure-marker:${kind}`, "utf8"), 32),
    );
    try {
      return createHmac("sha256", macKey).update(MARKER_META[kind].headerLine, "utf8").digest();
    } finally {
      macKey.fill(0);
    }
  } finally {
    rootKey.fill(0);
  }
}

function decodeField(line: string | undefined, name: "salt" | "mac"): Buffer | null {
  if (!line || !line.startsWith(`${name}=`)) return null;
  try {
    return Buffer.from(line.slice(name.length + 1), "base64url");
  } catch {
    return null;
  }
}

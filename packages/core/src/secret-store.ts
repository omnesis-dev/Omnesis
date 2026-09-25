// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Small OS secret-store abstraction.
 *
 * This is intentionally narrower than a general credentials vault: callers
 * store named opaque strings and never enumerate them. The first consumer is
 * the install root key that future at-rest encryption work will use to wrap
 * file/DB keys.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import {
  openStringEnvelope,
  parseSealedEnvelope,
  sealStringEnvelope,
  SealedEnvelopeInvalidError,
} from "./sealed-envelope.js";
import {
  SecretPathUnreadableError,
  ensurePrivateDirSync,
  secretPathExists,
} from "./security-files.js";
import { DEFAULT_CONFIG_DIR } from "./utils.js";

export const OMNESIS_SECRET_SERVICE = "dev.omnesis";
export const OMNESIS_INSTALL_ROOT_KEY = "install-root-key-v1";
const ROOT_KEY_PREFIX = "omn_root_v1_";
const ROOT_KEY_BYTES = 32;
const ROOT_KEY_RE = /^omn_root_v1_[A-Za-z0-9_-]{43}$/;
const SECRET_SERVICE_OBJECT = "/org/freedesktop/secrets";
const SECRET_SERVICE_IFACE = "org.freedesktop.Secret.Service";
const SECRET_COLLECTION_IFACE = "org.freedesktop.Secret.Collection";
const SECRET_LOGIN_COLLECTION = "/org/freedesktop/secrets/collection/login";

export const SECRET_STORE_BACKENDS = [
  "auto",
  "macos-keychain",
  "secret-service",
  "passphrase",
  "file",
] as const;

export type SecretStoreBackend = (typeof SECRET_STORE_BACKENDS)[number];
export type ResolvedSecretStoreBackend =
  | "macos-keychain"
  | "secret-service"
  | "passphrase"
  | "file"
  | "unavailable";

/** Environment/credential sources for the `passphrase` backend, in priority order. */
export const PASSPHRASE_ENV = "OMNESIS_KEYRING_PASSPHRASE";
export const PASSPHRASE_FILE_ENV = "OMNESIS_KEYRING_PASSPHRASE_FILE";
/**
 * The systemd credential name a daemon reads the keyring passphrase from
 * (`LoadCredential=omnesis-keyring-passphrase:<path>` → `$CREDENTIALS_DIRECTORY/...`).
 * `service install` emits this exact name so the daemon and the CLI agree.
 */
export const PASSPHRASE_CREDENTIAL_NAME = "omnesis-keyring-passphrase";
const PASSPHRASE_ENVELOPE_MARKER = "omnesis.passphrase-secret";

/**
 * Every environment variable the secret store reads to reach its keys — the
 * three sources {@link resolveKeyringPassphrase} consults, plus the backend
 * selector.
 *
 * Anything that hands a child process a curated environment instead of
 * inheriting one must forward these, or the child selects a backend it has no
 * way to open. Building that list by hand is how a child ends up one variable
 * short of its own keys, so the list lives here, beside the code that reads
 * it: a new source added to the resolver is added here in the same change and
 * every restricted environment picks it up.
 *
 * Note what forwarding all of them means. Three are locators — a backend name
 * and two paths — but `OMNESIS_KEYRING_PASSPHRASE` is the passphrase itself,
 * so a child given the whole list can read it out of its own environment. That
 * is the right trade for a child that must open the same keys as its parent;
 * it is the wrong one for a child that must not, and such a caller should take
 * the locators and leave that key behind.
 */
export const KEYRING_ENV_KEYS: readonly string[] = [
  "OMNESIS_SECRET_STORE",
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  // Set by systemd for a unit with `LoadCredential=`; the passphrase file
  // itself lives at `$CREDENTIALS_DIRECTORY/<PASSPHRASE_CREDENTIAL_NAME>`.
  "CREDENTIALS_DIRECTORY",
];

export interface SecretCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SecretCommandOptions {
  /** Secret Service accepts secrets on stdin; macOS `security` does not. */
  input?: string;
}

export type SecretCommandRunner = (
  cmd: string,
  args: string[],
  options?: SecretCommandOptions,
) => Promise<SecretCommandResult>;

export interface SecretStoreStatus {
  requestedBackend: SecretStoreBackend;
  backend: ResolvedSecretStoreBackend;
  available: boolean;
  secure: boolean;
  detail: string;
  /** How a write passes secret bytes to the backend. */
  writeExposure: "none" | "stdin" | "process-argv" | "owner-only-file";
}

export interface SecretStore {
  readonly backend: ResolvedSecretStoreBackend;
  status(): Promise<SecretStoreStatus>;
  read(name: string): Promise<string | null>;
  write(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface CreateSecretStoreOptions {
  backend?: SecretStoreBackend;
  service?: string;
  configDir?: string;
  platform?: NodeJS.Platform;
  runCommand?: SecretCommandRunner;
}

export interface InstallRootKeyState {
  keyName: typeof OMNESIS_INSTALL_ROOT_KEY;
  store: SecretStoreStatus;
  present: boolean;
  valid: boolean;
}

export interface EnsureInstallRootKeyResult extends InstallRootKeyState {
  created: boolean;
}

export class SecretStoreUnavailableError extends Error {
  constructor(status: SecretStoreStatus) {
    super(status.detail);
    this.name = "SecretStoreUnavailableError";
  }
}

export function parseSecretStoreBackend(raw: string | undefined): SecretStoreBackend {
  if (!raw) return "auto";
  if ((SECRET_STORE_BACKENDS as readonly string[]).includes(raw)) return raw as SecretStoreBackend;
  throw new Error(
    `Invalid OMNESIS_SECRET_STORE="${raw}". Expected one of: ${SECRET_STORE_BACKENDS.join(", ")}`,
  );
}

export function createSecretStore(opts: CreateSecretStoreOptions = {}): SecretStore {
  const requestedBackend =
    opts.backend ?? parseSecretStoreBackend(process.env.OMNESIS_SECRET_STORE);
  const service = opts.service ?? OMNESIS_SECRET_SERVICE;
  const platform = opts.platform ?? process.platform;
  const runCommand = opts.runCommand ?? defaultSecretCommandRunner;
  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;

  // `auto` never resolves to `passphrase` — deriving keys from an
  // operator-supplied passphrase is an explicit opt-in for headless hosts.
  const backend =
    requestedBackend === "auto"
      ? platform === "darwin"
        ? "macos-keychain"
        : platform === "linux"
          ? "secret-service"
          : "unavailable"
      : requestedBackend;

  if (backend === "macos-keychain") {
    return new MacosKeychainSecretStore(requestedBackend, service, runCommand);
  }
  if (backend === "secret-service") {
    return new SecretServiceSecretStore(requestedBackend, service, runCommand);
  }
  if (backend === "passphrase") {
    return new PassphraseSecretStore(requestedBackend, configDir);
  }
  if (backend === "file") {
    return new FileSecretStore(requestedBackend, service, configDir);
  }
  return new UnavailableSecretStore(requestedBackend, platform);
}

export async function inspectInstallRootKey(
  opts: CreateSecretStoreOptions = {},
): Promise<InstallRootKeyState> {
  const store = createSecretStore(opts);
  const status = await store.status();
  if (!status.available) {
    return { keyName: OMNESIS_INSTALL_ROOT_KEY, store: status, present: false, valid: false };
  }
  try {
    const value = await store.read(OMNESIS_INSTALL_ROOT_KEY);
    return {
      keyName: OMNESIS_INSTALL_ROOT_KEY,
      store: status,
      present: value !== null,
      valid: value !== null && isInstallRootKey(value),
    };
  } catch (err) {
    // A sealed entry that the configured passphrase cannot open: the key is
    // present but unusable — report that honestly instead of "absent" so
    // fail-closed consumers keep failing closed.
    if (err instanceof PassphraseMismatchError) {
      return { keyName: OMNESIS_INSTALL_ROOT_KEY, store: status, present: true, valid: false };
    }
    throw err;
  }
}

export async function readInstallRootKey(
  opts: CreateSecretStoreOptions = {},
): Promise<string | null> {
  const store = createSecretStore(opts);
  const status = await store.status();
  if (!status.available) return null;
  const value = await store.read(OMNESIS_INSTALL_ROOT_KEY);
  return value !== null && isInstallRootKey(value) ? value : null;
}

export function readInstallRootKeySync(opts: CreateSecretStoreOptions = {}): string | null {
  const requestedBackend =
    opts.backend ?? parseSecretStoreBackend(process.env.OMNESIS_SECRET_STORE);
  const platform = opts.platform ?? process.platform;
  const service = opts.service ?? OMNESIS_SECRET_SERVICE;
  const configDir = opts.configDir ?? DEFAULT_CONFIG_DIR;
  const backend =
    requestedBackend === "auto"
      ? platform === "darwin"
        ? "macos-keychain"
        : platform === "linux"
          ? "secret-service"
          : "unavailable"
      : requestedBackend;

  if (backend === "passphrase") {
    // Mirror PassphraseSecretStore.read synchronously. A wrong passphrase
    // throws (fail loud) rather than degrading into "no key" — deliberately
    // outside the catch-all below.
    const path = passphraseEntryPath(configDir, OMNESIS_INSTALL_ROOT_KEY);
    if (!secretPathExists(path)) return null;
    const resolution = resolveKeyringPassphrase();
    if (!resolution || !("passphrase" in resolution)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new PassphraseMismatchError(OMNESIS_INSTALL_ROOT_KEY);
    }
    try {
      const value = openStringEnvelope(parsed, resolution.passphrase, {
        marker: PASSPHRASE_ENVELOPE_MARKER,
        aad: OMNESIS_INSTALL_ROOT_KEY,
      });
      return isInstallRootKey(value) ? value : null;
    } catch (err) {
      if (err instanceof SealedEnvelopeInvalidError) {
        throw new PassphraseMismatchError(OMNESIS_INSTALL_ROOT_KEY);
      }
      throw err;
    }
  }

  try {
    if (backend === "file") {
      const path = join(
        configDir,
        "keyring",
        service,
        `${Buffer.from(OMNESIS_INSTALL_ROOT_KEY, "utf8").toString("base64url")}.secret`,
      );
      if (!secretPathExists(path)) return null;
      const value = readFileSync(path, "utf8");
      return isInstallRootKey(value) ? value : null;
    }
    if (backend === "secret-service") {
      const res = spawnSync("secret-tool", [
        "lookup",
        "service",
        service,
        "account",
        OMNESIS_INSTALL_ROOT_KEY,
      ]);
      if (res.status !== 0 || res.error) return null;
      const value = stripFinalNewline(String(res.stdout ?? ""));
      return isInstallRootKey(value) ? value : null;
    }
    if (backend === "macos-keychain") {
      const res = spawnSync("security", [
        "find-generic-password",
        "-a",
        OMNESIS_INSTALL_ROOT_KEY,
        "-s",
        service,
        "-w",
      ]);
      if (res.status !== 0 || res.error) return null;
      const value = stripFinalNewline(String(res.stdout ?? ""));
      return isInstallRootKey(value) ? value : null;
    }
  } catch (err) {
    // A store that answers "cannot tell" is not a store that answers "nothing
    // here"; letting that through is what keeps the sync read as fail-closed as
    // its async twin. Everything else stays soft, so an offline or absent
    // backend still degrades to "no key".
    if (err instanceof SecretPathUnreadableError) throw err;
    return null;
  }
  return null;
}

export function installRootKeyBytes(value: string): Buffer {
  if (!isInstallRootKey(value)) throw new Error("Invalid Omnesis install root key");
  return Buffer.from(value.slice(ROOT_KEY_PREFIX.length), "base64url");
}

export async function ensureInstallRootKey(
  opts: CreateSecretStoreOptions = {},
): Promise<EnsureInstallRootKeyResult> {
  const store = createSecretStore(opts);
  const status = await store.status();
  if (!status.available) throw new SecretStoreUnavailableError(status);

  const existing = await store.read(OMNESIS_INSTALL_ROOT_KEY);
  if (existing) {
    if (!isInstallRootKey(existing)) {
      throw new Error(
        `Existing Omnesis install root key in ${status.backend} has an unknown format; refusing to overwrite it automatically.`,
      );
    }
    return {
      keyName: OMNESIS_INSTALL_ROOT_KEY,
      store: status,
      present: true,
      valid: true,
      created: false,
    };
  }

  await store.write(OMNESIS_INSTALL_ROOT_KEY, generateInstallRootKey());
  return {
    keyName: OMNESIS_INSTALL_ROOT_KEY,
    store: status,
    present: true,
    valid: true,
    created: true,
  };
}

export function generateInstallRootKey(): string {
  return `${ROOT_KEY_PREFIX}${randomBytes(ROOT_KEY_BYTES).toString("base64url")}`;
}

export interface WriteInstallRootKeyOptions extends CreateSecretStoreOptions {
  /** Replace an existing root key. Default false — refuses if one is present. */
  overwrite?: boolean;
}

/**
 * Write a specific install root key value into the secret store — e.g. when
 * recovering it from an escrow envelope onto a fresh machine. Validates the
 * value format and refuses to clobber an existing root key unless `overwrite`
 * is set, so a stray recovery cannot silently replace a live key.
 */
export async function writeInstallRootKey(
  value: string,
  opts: WriteInstallRootKeyOptions = {},
): Promise<void> {
  if (!isInstallRootKey(value)) {
    throw new Error("Refusing to write an install root key with an unknown format.");
  }
  const store = createSecretStore(opts);
  const status = await store.status();
  if (!status.available) throw new SecretStoreUnavailableError(status);
  if (!opts.overwrite) {
    const existing = await store.read(OMNESIS_INSTALL_ROOT_KEY);
    if (existing) {
      throw new Error(
        `An install root key already exists in ${status.backend}; pass --force to replace it.`,
      );
    }
  }
  await store.write(OMNESIS_INSTALL_ROOT_KEY, value);
}

export function isInstallRootKey(value: string): boolean {
  return ROOT_KEY_RE.test(value);
}

export const defaultSecretCommandRunner: SecretCommandRunner = (cmd, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (result: SecretCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ code: 127, stdout, stderr: stderr || err.message });
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
      finish({ code: 127, stdout, stderr: stderr || err.message });
    });

    try {
      child.stdin.end(options.input ?? "");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EPIPE") {
        finish({ code: 127, stdout, stderr: stderr || e.message });
      }
    }
  });

class MacosKeychainSecretStore implements SecretStore {
  readonly backend = "macos-keychain" as const;

  constructor(
    private readonly requestedBackend: SecretStoreBackend,
    private readonly service: string,
    private readonly runCommand: SecretCommandRunner,
  ) {}

  async status(): Promise<SecretStoreStatus> {
    const res = await this.runCommand("security", ["-h"]);
    if (res.code === 127) {
      return unavailableStatus(
        this.requestedBackend,
        this.backend,
        "macOS Keychain CLI (`security`) is not available.",
      );
    }
    return {
      requestedBackend: this.requestedBackend,
      backend: this.backend,
      available: true,
      secure: true,
      detail:
        "macOS Keychain is available. Initialization writes through `/usr/bin/security`, whose noninteractive API passes the new secret as a transient process argument.",
      writeExposure: "process-argv",
    };
  }

  async read(name: string): Promise<string | null> {
    const res = await this.runCommand("security", [
      "find-generic-password",
      "-a",
      name,
      "-s",
      this.service,
      "-w",
    ]);
    if (res.code !== 0) return null;
    return stripFinalNewline(res.stdout);
  }

  async write(name: string, value: string): Promise<void> {
    const res = await this.runCommand("security", [
      "add-generic-password",
      "-a",
      name,
      "-s",
      this.service,
      "-l",
      `Omnesis ${name}`,
      "-U",
      "-w",
      value,
    ]);
    if (res.code !== 0) {
      const message = res.stderr.trim() || "security add-generic-password failed";
      if (/User interaction is not allowed/i.test(message)) {
        throw new Error(
          "macOS Keychain refused the noninteractive write. Run `omnesis keyring init` from an unlocked local login session on the Mac, then retry status checks over SSH.",
        );
      }
      throw new Error(message);
    }
  }

  async delete(name: string): Promise<void> {
    await this.runCommand("security", ["delete-generic-password", "-a", name, "-s", this.service]);
  }
}

class SecretServiceSecretStore implements SecretStore {
  readonly backend = "secret-service" as const;

  constructor(
    private readonly requestedBackend: SecretStoreBackend,
    private readonly service: string,
    private readonly runCommand: SecretCommandRunner,
  ) {}

  async status(): Promise<SecretStoreStatus> {
    const probe = await this.runCommand("secret-tool", [
      "lookup",
      "service",
      this.service,
      "account",
      "__omnesis_status_probe__",
    ]);
    const probeUnavailable = secretServiceUnavailableDetail(probe);
    if (probeUnavailable) {
      return unavailableStatus(this.requestedBackend, this.backend, probeUnavailable);
    }
    const collectionProblem = await this.loginCollectionProblem();
    if (collectionProblem) {
      return unavailableStatus(this.requestedBackend, this.backend, collectionProblem);
    }
    return {
      requestedBackend: this.requestedBackend,
      backend: this.backend,
      available: true,
      secure: true,
      detail: "Linux Secret Service is available through `secret-tool`.",
      writeExposure: "stdin",
    };
  }

  async read(name: string): Promise<string | null> {
    const res = await this.runCommand("secret-tool", [
      "lookup",
      "service",
      this.service,
      "account",
      name,
    ]);
    const unavailable = secretServiceUnavailableDetail(res);
    if (unavailable) {
      throw new SecretStoreUnavailableError(
        unavailableStatus(this.requestedBackend, this.backend, unavailable),
      );
    }
    if (res.code !== 0 || res.stdout.length === 0) return null;
    return stripFinalNewline(res.stdout);
  }

  async write(name: string, value: string): Promise<void> {
    const res = await this.runCommand(
      "secret-tool",
      [
        "store",
        "--collection=login",
        "--label",
        `Omnesis ${name}`,
        "service",
        this.service,
        "account",
        name,
      ],
      { input: `${value}\n` },
    );
    if (res.code !== 0) {
      const message = res.stderr.trim() || "secret-tool store failed";
      if (/collection\/login|Object does not exist/i.test(message)) {
        throw new Error(missingLoginCollectionDetail());
      }
      throw new Error(message);
    }
  }

  async delete(name: string): Promise<void> {
    await this.runCommand("secret-tool", ["clear", "service", this.service, "account", name]);
  }

  private async loginCollectionProblem(): Promise<string | null> {
    const collections = await this.collectionPaths();
    if (collections === null) return null;
    if (!collections.includes(SECRET_LOGIN_COLLECTION)) {
      return missingLoginCollectionDetail();
    }
    const locked = await this.loginCollectionLocked();
    if (locked === true) {
      return "Linux Secret Service is running, but the persistent login collection is locked. Unlock the login keyring for this user, then run `omnesis keyring init` again; do not use the transient session collection for Omnesis root keys.";
    }
    return null;
  }

  private async collectionPaths(): Promise<string[] | null> {
    const busctl = await this.runCommand("busctl", [
      "--user",
      "get-property",
      "org.freedesktop.secrets",
      SECRET_SERVICE_OBJECT,
      SECRET_SERVICE_IFACE,
      "Collections",
    ]);
    if (busctl.code === 0) return parseSecretServiceCollectionPaths(busctl.stdout);
    if (busctl.code !== 127) return null;

    const gdbus = await this.runCommand("gdbus", [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.secrets",
      "--object-path",
      SECRET_SERVICE_OBJECT,
      "--method",
      "org.freedesktop.DBus.Properties.Get",
      SECRET_SERVICE_IFACE,
      "Collections",
    ]);
    if (gdbus.code === 0) return parseSecretServiceCollectionPaths(gdbus.stdout);
    return null;
  }

  private async loginCollectionLocked(): Promise<boolean | null> {
    const busctl = await this.runCommand("busctl", [
      "--user",
      "get-property",
      "org.freedesktop.secrets",
      SECRET_LOGIN_COLLECTION,
      SECRET_COLLECTION_IFACE,
      "Locked",
    ]);
    if (busctl.code === 0) return parseSecretServiceBoolean(busctl.stdout);
    if (busctl.code !== 127) return null;

    const gdbus = await this.runCommand("gdbus", [
      "call",
      "--session",
      "--dest",
      "org.freedesktop.secrets",
      "--object-path",
      SECRET_LOGIN_COLLECTION,
      "--method",
      "org.freedesktop.DBus.Properties.Get",
      SECRET_COLLECTION_IFACE,
      "Locked",
    ]);
    if (gdbus.code === 0) return parseSecretServiceBoolean(gdbus.stdout);
    return null;
  }
}

class FileSecretStore implements SecretStore {
  readonly backend = "file" as const;

  constructor(
    private readonly requestedBackend: SecretStoreBackend,
    private readonly service: string,
    private readonly configDir: string,
  ) {}

  async status(): Promise<SecretStoreStatus> {
    return {
      requestedBackend: this.requestedBackend,
      backend: this.backend,
      available: true,
      secure: false,
      detail:
        "Owner-only file fallback is enabled. This is useful for tests and headless development, but it is not an OS keyring.",
      writeExposure: "owner-only-file",
    };
  }

  async read(name: string): Promise<string | null> {
    const path = this.pathFor(name);
    if (!secretPathExists(path)) return null;
    return readFile(path, "utf8");
  }

  async write(name: string, value: string): Promise<void> {
    const path = this.pathFor(name);
    ensurePrivateDirSync(join(this.configDir, "keyring"));
    ensurePrivateDirSync(join(this.configDir, "keyring", this.service));
    await atomicWriteFile(path, value, { mode: 0o600, ensureDir: true });
  }

  async delete(name: string): Promise<void> {
    const path = this.pathFor(name);
    if (!existsSync(path)) return;
    await unlink(path);
  }

  private pathFor(name: string): string {
    return join(
      this.configDir,
      "keyring",
      this.service,
      `${Buffer.from(name, "utf8").toString("base64url")}.secret`,
    );
  }
}

export class PassphraseMismatchError extends Error {
  readonly code = "OMNESIS_KEYRING_PASSPHRASE_MISMATCH";

  constructor(name: string) {
    super(
      `The Omnesis keyring passphrase does not open the stored secret "${name}". ` +
        `The passphrase (from $${PASSPHRASE_ENV}, $${PASSPHRASE_FILE_ENV}, or the systemd ` +
        `credential "${PASSPHRASE_CREDENTIAL_NAME}") differs from the one the secret was sealed ` +
        "under, or the entry file is corrupt.",
    );
    this.name = "PassphraseMismatchError";
  }
}

type PassphraseResolution = { passphrase: string; source: string } | { error: string } | null;

/**
 * Resolve the operator passphrase for the `passphrase` backend, in priority
 * order: the environment variable, a passphrase file, then a systemd
 * credential (`LoadCredential=omnesis-keyring-passphrase:<path>` — systemd
 * exposes it under $CREDENTIALS_DIRECTORY, encrypted at rest when the host
 * uses `systemd-creds encrypt`). Exactly one trailing newline is stripped so
 * `echo passphrase > file` behaves as expected.
 */
function resolveKeyringPassphrase(env: NodeJS.ProcessEnv = process.env): PassphraseResolution {
  const direct = env[PASSPHRASE_ENV];
  if (direct !== undefined) {
    if (direct) return { passphrase: direct, source: `$${PASSPHRASE_ENV}` };
    return { error: `$${PASSPHRASE_ENV} is set but empty.` };
  }

  const fileVar = env[PASSPHRASE_FILE_ENV];
  if (fileVar) {
    try {
      const value = stripFinalNewline(readFileSync(fileVar, "utf8"));
      if (value) return { passphrase: value, source: fileVar };
      return { error: `Passphrase file ${fileVar} is empty.` };
    } catch (err) {
      return {
        error: `Passphrase file ${fileVar} is not readable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const credDir = env.CREDENTIALS_DIRECTORY;
  if (credDir) {
    const credPath = join(credDir, PASSPHRASE_CREDENTIAL_NAME);
    if (existsSync(credPath)) {
      try {
        const value = stripFinalNewline(readFileSync(credPath, "utf8"));
        if (value)
          return { passphrase: value, source: `systemd credential ${PASSPHRASE_CREDENTIAL_NAME}` };
      } catch {
        return { error: `systemd credential ${PASSPHRASE_CREDENTIAL_NAME} is not readable.` };
      }
    }
  }
  return null;
}

/** Sealed-entry path for the passphrase backend. */
function passphraseEntryPath(configDir: string, name: string): string {
  return join(
    configDir,
    "keyring",
    "passphrase",
    `${Buffer.from(name, "utf8").toString("base64url")}.json`,
  );
}

/**
 * Headless secret store: each entry is sealed on disk under a KEK derived from
 * an operator-supplied passphrase (never stored). Designed for GUI-less hosts
 * where no Secret Service exists — the passphrase arrives at boot via the
 * environment, a file, or a systemd credential. Entry files live under
 * `<configDir>/keyring/passphrase/` with the entry name bound as GCM AAD, so
 * entries cannot be renamed into one another.
 */
class PassphraseSecretStore implements SecretStore {
  readonly backend = "passphrase" as const;

  constructor(
    private readonly requestedBackend: SecretStoreBackend,
    private readonly configDir: string,
  ) {}

  async status(): Promise<SecretStoreStatus> {
    const resolution = resolveKeyringPassphrase();
    if (resolution && "passphrase" in resolution) {
      return {
        requestedBackend: this.requestedBackend,
        backend: this.backend,
        available: true,
        secure: true,
        detail: `Passphrase-sealed keyring is active (passphrase from ${resolution.source}; entries under keyring/passphrase/).`,
        writeExposure: "none",
      };
    }
    const why = resolution
      ? resolution.error
      : `No keyring passphrase is configured. Set $${PASSPHRASE_ENV}, point $${PASSPHRASE_FILE_ENV} at an owner-only file, or pass a systemd credential named "${PASSPHRASE_CREDENTIAL_NAME}".`;
    return {
      requestedBackend: this.requestedBackend,
      backend: this.backend,
      available: false,
      secure: false,
      detail: why,
      writeExposure: "none",
    };
  }

  async read(name: string): Promise<string | null> {
    const path = this.pathFor(name);
    if (!secretPathExists(path)) return null;
    const passphrase = this.requirePassphrase();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new PassphraseMismatchError(name);
    }
    try {
      return openStringEnvelope(parsed, passphrase, {
        marker: PASSPHRASE_ENVELOPE_MARKER,
        aad: name,
      });
    } catch (err) {
      if (err instanceof SealedEnvelopeInvalidError) throw new PassphraseMismatchError(name);
      throw err;
    }
  }

  async write(name: string, value: string): Promise<void> {
    const passphrase = this.requirePassphrase();
    const envelope = sealStringEnvelope(value, passphrase, {
      marker: PASSPHRASE_ENVELOPE_MARKER,
      aad: name,
    });
    ensurePrivateDirSync(join(this.configDir, "keyring"));
    ensurePrivateDirSync(join(this.configDir, "keyring", "passphrase"));
    await atomicWriteFile(this.pathFor(name), `${JSON.stringify(envelope, null, 2)}\n`, {
      mode: 0o600,
      ensureDir: true,
    });
  }

  async delete(name: string): Promise<void> {
    const path = this.pathFor(name);
    if (!existsSync(path)) return;
    await unlink(path);
  }

  private requirePassphrase(): string {
    const resolution = resolveKeyringPassphrase();
    if (resolution && "passphrase" in resolution) return resolution.passphrase;
    throw new SecretStoreUnavailableError({
      requestedBackend: this.requestedBackend,
      backend: this.backend,
      available: false,
      secure: false,
      detail: resolution
        ? resolution.error
        : `No keyring passphrase is configured. Set $${PASSPHRASE_ENV}, point $${PASSPHRASE_FILE_ENV} at an owner-only file, or pass a systemd credential named "${PASSPHRASE_CREDENTIAL_NAME}".`,
      writeExposure: "none",
    });
  }

  private pathFor(name: string): string {
    return passphraseEntryPath(this.configDir, name);
  }
}

class UnavailableSecretStore implements SecretStore {
  readonly backend = "unavailable" as const;

  constructor(
    private readonly requestedBackend: SecretStoreBackend,
    private readonly platform: NodeJS.Platform,
  ) {}

  async status(): Promise<SecretStoreStatus> {
    return unavailableStatus(
      this.requestedBackend,
      this.backend,
      `No secret-store backend is implemented for ${this.platform}.`,
    );
  }

  async read(): Promise<string | null> {
    return null;
  }

  async write(): Promise<void> {
    throw new SecretStoreUnavailableError(await this.status());
  }

  async delete(): Promise<void> {
    return;
  }
}

function unavailableStatus(
  requestedBackend: SecretStoreBackend,
  backend: ResolvedSecretStoreBackend,
  detail: string,
): SecretStoreStatus {
  return {
    requestedBackend,
    backend,
    available: false,
    secure: false,
    detail,
    writeExposure: "none",
  };
}

function secretServiceUnavailableDetail(res: SecretCommandResult): string | null {
  if (res.code === 0) return null;
  if (res.code === 127) return "Linux Secret Service CLI (`secret-tool`) is not installed.";
  const message = `${res.stderr}\n${res.stdout}`.trim();
  if (!message) return null;
  return `Linux Secret Service is not reachable: ${message}`;
}

function missingLoginCollectionDetail(): string {
  return "Linux Secret Service is running, but the persistent login collection is missing or locked. Create/unlock a durable login keyring for this user, then run `omnesis keyring init` again; do not use the transient session collection for Omnesis root keys.";
}

function parseSecretServiceCollectionPaths(value: string): string[] {
  return [...value.matchAll(/\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_-]+/g)].map(
    (match) => match[0],
  );
}

function parseSecretServiceBoolean(value: string): boolean | null {
  if (/\btrue\b/.test(value)) return true;
  if (/\bfalse\b/.test(value)) return false;
  return null;
}

function stripFinalNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

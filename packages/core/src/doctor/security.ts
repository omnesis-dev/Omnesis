// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Local security posture collection for the Omnesis doctor.
 *
 * This module intentionally performs local OS/filesystem inspection only.
 * It never reads Omnesis database contents or provider tokens; permission
 * checks use stat metadata, and service hardening checks read generated unit
 * files. The evaluator in `checks.ts` owns pass/warn/fail semantics.
 *
 * Everything here describes *the host it runs on*. The gateway and collector
 * use the worker-backed launcher; a local CLI may call the collector directly
 * when it intentionally offers permission repair. The component, config
 * location, and testable host inputs flow through options, so every caller
 * applies the same classification — see `collectGatewayIsolation` for the
 * case where that distinction has teeth.
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";

import {
  CODEX_HOME_DIR,
  CODEX_POOL_HOME_DIR,
  CODEX_RUNTIME_STORE_DIR,
  codexPaths,
} from "../codex-paths.js";
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  SecretPathUnreadableError,
} from "../security-files.js";
import {
  inspectStorageKey,
  storageEncryptionRequired,
  storageKeyNamesForHost,
  type StorageKeyName,
} from "../storage-keys.js";
import { detectStorageKeyHosts, storageKeyNamesForHosts } from "../storage-readiness.js";
import {
  OMNESIS_INSTALL_ROOT_KEY,
  PASSPHRASE_CREDENTIAL_NAME,
  PASSPHRASE_ENV,
  PASSPHRASE_FILE_ENV,
  inspectInstallRootKey,
  parseSecretStoreBackend,
} from "../secret-store.js";
import { parseRecoveryEnvelope, recoveryEnvelopePath } from "../recovery-envelope.js";
import {
  HARDENED_UNIT_PATH,
  launchdPlistPath,
  systemdEscapeArg,
  systemdUnitPath,
} from "../service-paths.js";
import type {
  SecurityData,
  SecurityDiskEncryptionStatus,
  SecurityGatewayIsolation,
  SecurityKeyringAccess,
  SecurityKeyringData,
  SecurityKeyringWiring,
  SecurityPermissionEntry,
  SecurityRecoveryEscrowStatus,
  SecurityServiceUnit,
} from "./types.js";

const MAX_PERMISSION_REPORT_ENTRIES = 5_000;
const CODEX_ARG0_HELPER_LINKS = new Set([
  "apply_patch",
  "applypatch",
  "codex-execve-wrapper",
  "codex-linux-sandbox",
]);

/** Linux account database used to classify a unit's `User=` value. */
const DEFAULT_PASSWD_PATH = "/etc/passwd";

/**
 * Conventional first uid handed to human accounts on Linux (`UID_MIN` in
 * /etc/login.defs). Everything below it is a system account.
 */
const LOGIN_UID_MIN = 1000;

/** `nobody` sits above UID_MIN on many distros but is never a login account. */
const NOBODY_UID = 65534;

/** Shells that mean "this account cannot be logged into interactively". */
const NON_LOGIN_SHELLS = new Set([
  "",
  "/bin/false",
  "/usr/bin/false",
  "/bin/nologin",
  "/sbin/nologin",
  "/usr/sbin/nologin",
  "/usr/bin/nologin",
  "/dev/null",
]);

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SecurityCommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;

export interface CollectSecurityOptions {
  configDir: string;
  fixPermissions: boolean;
  /**
   * Component whose host posture is being collected. Gateway retains the
   * legacy whole-host service audit; collector excludes gateway unit wiring
   * and gateway-only storage/isolation probes.
   */
  component?: "gateway" | "collector";
  platform?: NodeJS.Platform;
  homeDir?: string;
  runCommand?: SecurityCommandRunner;
  /** Test seam: hardened system-unit path (default /etc/systemd/system/…). */
  hardenedUnitPath?: string;
  /** Test seam: account database consulted to classify a unit's `User=`. */
  passwdPath?: string;
}

const defaultRunCommand: SecurityCommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const rawCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      const syntheticDetail = typeof rawCode === "string" ? err.message : "";
      resolve({
        code: typeof rawCode === "number" ? rawCode : 127,
        stdout: stdout ?? "",
        stderr: stderr || syntheticDetail,
      });
    });
  });

export async function collectSecurityData(opts: CollectSecurityOptions): Promise<SecurityData> {
  const platform = opts.platform ?? process.platform;
  const runCommand = opts.runCommand ?? defaultRunCommand;
  const component = opts.component ?? "gateway";
  const homeDir = opts.homeDir ?? homedir();
  // Unreadable key material must not abort the report: this is the condition an
  // operator runs the doctor to diagnose, so each keyring reading degrades and
  // records why instead of throwing the collection away.
  let keyringAccess: SecurityKeyringAccess = { readable: true };
  const noteUnreadable = (err: unknown): void => {
    if (!(err instanceof SecretPathUnreadableError)) throw err;
    if (keyringAccess.readable) {
      keyringAccess = { readable: false, path: err.path, detail: err.message };
    }
  };

  let keyring: SecurityKeyringData;
  try {
    keyring = await inspectInstallRootKey({
      configDir: opts.configDir,
      platform,
      runCommand,
    });
  } catch (err) {
    noteUnreadable(err);
    keyring = unreadableKeyringData(err);
  }
  // Evaluated before the literal below: `noteUnreadable` rebinds
  // `keyringAccess`, and a property already read cannot see that. The backends
  // whose store lives outside the config dir reach the unreadable directory
  // only here, so reading the field first would drop exactly those installs.
  // Each process reports the keys it is responsible for: a collector host
  // its provider stores', a gateway host its databases' plus, when a
  // collector has paired in the same directory, that collector's.
  const storageKeyNames =
    component === "collector"
      ? storageKeyNamesForHost("collector")
      : storageKeyNamesForHosts(detectStorageKeyHosts(opts.configDir));
  const databaseEncryption = await collectDatabaseEncryptionStatus(
    opts.configDir,
    keyring.valid,
    noteUnreadable,
    storageKeyNames,
  );
  return {
    configDir: opts.configDir,
    fixPermissions: opts.fixPermissions,
    ...collectPermissionData(opts.configDir, opts.fixPermissions),
    diskEncryption: await collectDiskEncryptionStatus(platform, opts.configDir, runCommand),
    serviceUnits: collectServiceUnits(platform, homeDir, opts.configDir, component),
    gatewayIsolation:
      component === "gateway"
        ? collectGatewayIsolation(
            platform,
            homeDir,
            opts.hardenedUnitPath ?? HARDENED_UNIT_PATH,
            opts.passwdPath ?? DEFAULT_PASSWD_PATH,
          )
        : collectorGatewayIsolation(),
    keyring,
    keyringAccess,
    keyringWiring: collectKeyringWiring(
      platform,
      homeDir,
      opts.hardenedUnitPath ?? HARDENED_UNIT_PATH,
      component,
    ),
    recoveryEscrow: collectRecoveryEscrowStatus(opts.configDir),
    databaseEncryption,
  };
}

function collectorGatewayIsolation(): SecurityGatewayIsolation {
  return {
    status: "not-applicable",
    detail: "Gateway process isolation is outside a collector host audit.",
    systemUnitPath: null,
  };
}

/**
 * What to report about the root key when its own store could not be read.
 * `available: false` is what carries the meaning — it steers the keyring check
 * into its store-unavailable branch instead of the "no key was ever created"
 * one, and the report-level access finding says why.
 */
function unreadableKeyringData(err: unknown): SecurityKeyringData {
  const requestedBackend = parseSecretStoreBackend(process.env.OMNESIS_SECRET_STORE);
  return {
    keyName: OMNESIS_INSTALL_ROOT_KEY,
    store: {
      requestedBackend,
      backend: "unavailable",
      available: false,
      secure: false,
      detail: err instanceof Error ? err.message : String(err),
      writeExposure: "none",
    },
    present: false,
    valid: false,
  };
}

/**
 * Classify the root-key recovery escrow: whether `omnesis keyring
 * export-recovery` has produced a well-formed envelope. The check is
 * shape-only — it never opens the envelope (that needs the user-held recovery
 * code) — and reads the config directory, not any store contents.
 */
function collectRecoveryEscrowStatus(configDir: string): SecurityRecoveryEscrowStatus {
  const path = recoveryEnvelopePath(configDir);
  if (!existsSync(path)) {
    return { status: "missing", detail: "No recovery escrow has been exported.", path };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { status: "corrupt", detail: "The recovery envelope is not valid JSON.", path };
  }
  if (!parseRecoveryEnvelope(raw)) {
    return {
      status: "corrupt",
      detail: "The recovery envelope is not a well-formed v1 escrow.",
      path,
    };
  }
  return { status: "exported", detail: "A recovery escrow is present and well-formed.", path };
}

async function collectDatabaseEncryptionStatus(
  configDir: string,
  rootKeyValid: boolean,
  noteUnreadable: (err: unknown) => void,
  keyNames: readonly StorageKeyName[],
): Promise<SecurityData["databaseEncryption"]> {
  let required: boolean;
  let stores: SecurityData["databaseEncryption"]["stores"];
  try {
    required = storageEncryptionRequired(configDir);
    stores = await Promise.all(
      keyNames.map(async (keyName) => {
        const state = await inspectStorageKey(keyName, { configDir });
        return {
          keyName,
          present: state.present,
          valid: state.valid,
          encrypted: state.encrypted,
        };
      }),
    );
  } catch (err) {
    noteUnreadable(err);
    // Nothing here can be answered. Answering "off" would report an armed
    // install as a plaintext one; `blocked` is the existing "armed but out of
    // reach" state, which is what an unreadable keyring amounts to.
    return {
      status: "blocked",
      detail: err instanceof Error ? err.message : String(err),
      required: false,
      stores: [],
    };
  }
  const valid = stores.filter((store) => store.present && store.valid && store.encrypted).length;
  if (required && !rootKeyValid) {
    return {
      status: "blocked",
      detail: "Live storage encryption is required, but the install root key is unavailable.",
      required,
      stores,
    };
  }
  if (valid === stores.length && rootKeyValid) {
    return {
      status: "on",
      detail: `Wrapped storage keys exist for every store this host opens (${stores.map((store) => store.keyName).join(", ")}).`,
      required,
      stores,
    };
  }
  if (valid > 0 || required) {
    return {
      status: "partial",
      detail: `${valid}/${stores.length} wrapped live-storage keys are present and valid.`,
      required,
      stores,
    };
  }
  return {
    status: "off",
    detail: "No wrapped live-storage keys are present.",
    required,
    stores,
  };
}

function collectPermissionData(
  configDir: string,
  fixPermissions: boolean,
): Pick<SecurityData, "permissionEntries" | "permissionScanTruncated"> {
  const permissionEntries: SecurityPermissionEntry[] = [];
  let permissionScanTruncated = false;

  const pushFinding = (entry: SecurityPermissionEntry) => {
    if (entry.ok && !entry.fixed) return;
    if (permissionEntries.length >= MAX_PERMISSION_REPORT_ENTRIES) {
      permissionScanTruncated = true;
      return;
    }
    permissionEntries.push(entry);
  };

  if (!existsSync(configDir)) {
    pushFinding({
      path: configDir,
      relativePath: ".",
      kind: "missing",
      expectedMode: PRIVATE_DIR_MODE,
      actualMode: null,
      ok: false,
      fixed: false,
    });
    return { permissionEntries, permissionScanTruncated };
  }

  const visit = (path: string) => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch (err) {
      pushFinding({
        path,
        relativePath: displayRelative(configDir, path),
        kind: "missing",
        expectedMode: null,
        actualMode: null,
        ok: false,
        fixed: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const relativePath = displayRelative(configDir, path);
    const kind = st.isDirectory()
      ? "directory"
      : st.isFile()
        ? "file"
        : st.isSymbolicLink()
          ? "symlink"
          : "other";
    const allowedRuntimeSymlink =
      kind === "symlink" && isAllowedRuntimeSymlink(configDir, path, relativePath);
    const expectedMode =
      kind === "directory"
        ? PRIVATE_DIR_MODE
        : kind === "file"
          ? isManagedCodexExecutable(relativePath) ||
            ((st.mode & 0o100) !== 0 && isManagedCodexPluginAsset(relativePath))
            ? PRIVATE_DIR_MODE
            : PRIVATE_FILE_MODE
          : null;
    let actualMode = st.mode & 0o7777;
    let ok = allowedRuntimeSymlink || (expectedMode == null ? false : actualMode === expectedMode);
    let fixed = false;
    let error: string | undefined;

    if (fixPermissions && expectedMode != null && !ok) {
      try {
        chmodNoFollow(path, kind, expectedMode);
        actualMode = expectedMode;
        ok = true;
        fixed = true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    pushFinding({
      path,
      relativePath,
      kind,
      expectedMode,
      actualMode,
      ok,
      fixed,
      ...(error ? { error } : {}),
    });

    if (kind !== "directory") return;
    let children: string[];
    try {
      children = readdirSync(path).sort();
    } catch {
      return;
    }
    for (const child of children) {
      visit(`${path}/${child}`);
    }
  };

  visit(configDir);
  return { permissionEntries, permissionScanTruncated };
}

function chmodNoFollow(
  path: string,
  kind: "directory" | "file" | "symlink" | "other" | "missing",
  mode: number,
): void {
  if (kind !== "directory" && kind !== "file") {
    chmodSync(path, mode);
    return;
  }
  const flags =
    fsConstants.O_RDONLY |
    (fsConstants.O_NOFOLLOW ?? 0) |
    (kind === "directory" ? (fsConstants.O_DIRECTORY ?? 0) : 0);
  const fd = openSync(path, flags);
  try {
    const st = fstatSync(fd);
    if (kind === "directory" && !st.isDirectory()) {
      throw new Error("path changed while repairing permissions");
    }
    if (kind === "file" && !st.isFile()) {
      throw new Error("path changed while repairing permissions");
    }
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

async function collectDiskEncryptionStatus(
  platform: NodeJS.Platform,
  configDir: string,
  runCommand: SecurityCommandRunner,
): Promise<SecurityDiskEncryptionStatus> {
  if (platform === "darwin") {
    const res = await runCommand("fdesetup", ["status"]);
    const output = `${res.stdout}\n${res.stderr}`.trim();
    if (/FileVault is On\./i.test(output)) {
      return { platform, status: "on", detail: "FileVault is on." };
    }
    if (/FileVault is Off\./i.test(output)) {
      return { platform, status: "off", detail: "FileVault is off." };
    }
    return {
      platform,
      status: "unknown",
      detail: output || "Could not determine FileVault status.",
    };
  }

  if (platform === "linux") {
    const res = await runCommand("findmnt", [
      "--noheadings",
      "--output",
      "SOURCE,FSTYPE,OPTIONS",
      "--target",
      configDir,
    ]);
    if (res.code !== 0) {
      return {
        platform,
        status: "unknown",
        detail: res.stderr.trim() || "findmnt did not report the config directory mount.",
      };
    }
    const line = res.stdout.trim().split("\n")[0] ?? "";
    const lower = line.toLowerCase();
    if (
      lower.includes("crypt") ||
      lower.includes("/dev/mapper/") ||
      lower.includes("dm-crypt") ||
      lower.includes("luks")
    ) {
      return { platform, status: "on", detail: `Encrypted-looking mount: ${line}` };
    }
    return { platform, status: "unknown", detail: `Mount is not obviously LUKS-backed: ${line}` };
  }

  return {
    platform,
    status: "unsupported",
    detail: `Full-disk-encryption checks are not implemented for ${platform}.`,
  };
}

function collectServiceUnits(
  platform: NodeJS.Platform,
  homeDir: string,
  configDir: string,
  component: "gateway" | "collector",
): SecurityServiceUnit[] {
  const components =
    component === "collector" ? (["collector"] as const) : (["gateway", "collector"] as const);
  if (platform === "linux") {
    return components.map((unitComponent) =>
      collectSystemdUnit(
        unitComponent,
        systemdUnitPath(homeDir, unitComponent),
        configDir,
        homeDir,
      ),
    );
  }
  if (platform === "darwin") {
    return components.map((unitComponent) =>
      collectLaunchdUnit(unitComponent, launchdPlistPath(homeDir, unitComponent)),
    );
  }
  return [];
}

/**
 * Whether `name` is a human login account on this host — an account a
 * person signs into, and therefore runs other programs under.
 *
 * This is deliberately a property of the host's account database rather
 * than of whichever process happens to ask. Comparing against the caller's
 * own username would answer a different question depending on who ran the
 * check: from the CLI it means "the operator", but from inside a gateway
 * that already runs as a dedicated service account it means that service
 * account — which would classify a correctly hardened install as
 * unhardened. Reading /etc/passwd gives both callers the same answer, and
 * additionally catches a `User=` naming *some other* human on a
 * multi-account machine, which is no isolation either.
 *
 * Returns `null` when the question cannot be answered — the file is
 * unreadable, or the account simply is not in it. Absence is genuinely
 * inconclusive rather than a "no": hosts that source accounts from LDAP,
 * SSSD, or NIS keep human logins out of /etc/passwd entirely, so treating
 * a miss as "not a human account" would report those installs as isolated
 * when they are not. A security check must not answer "you are secure"
 * when what it means is "I could not tell".
 *
 * Linux only — macOS keeps login accounts in Directory Services rather
 * than /etc/passwd, and the caller returns before reaching here on darwin.
 */
function isHumanLoginAccount(name: string, passwdPath: string): boolean | null {
  let body: string;
  try {
    body = readFileSync(passwdPath, "utf8");
  } catch {
    return null;
  }
  for (const line of body.split("\n")) {
    // A passwd line is exactly seven colon-separated fields. Anything else
    // is a comment, a blank, or an NIS compat entry (`+user::::::`) that
    // resolves elsewhere — none of which describe this account.
    const fields = line.split(":");
    if (fields.length !== 7 || fields[0] !== name) continue;
    const uid = Number.parseInt(fields[2], 10);
    if (!Number.isInteger(uid)) return null;
    if (uid < LOGIN_UID_MIN || uid === NOBODY_UID) return false;
    return !NON_LOGIN_SHELLS.has(fields[6].trim());
  }
  return null;
}

/**
 * Classify gateway process isolation from unit files alone. A live-process
 * uid comparison would only cover the moment doctor runs (and the gateway
 * may be down); the unit file is the durable statement of which user the
 * gateway starts as, so the check inspects that. Only the gateway is
 * classified — the collector is correct as the login user, since it reads
 * the user's own data.
 */
function collectGatewayIsolation(
  platform: NodeJS.Platform,
  homeDir: string,
  hardenedUnitPath: string,
  passwdPath: string,
): SecurityGatewayIsolation {
  if (platform === "darwin") {
    const installed = existsSync(launchdPlistPath(homeDir, "gateway"));
    return {
      status: installed ? "login-user" : "not-installed",
      detail: installed
        ? "The gateway LaunchAgent runs as the login user (dedicated-user mode is Linux-only)."
        : "No gateway service unit was found.",
      systemUnitPath: null,
    };
  }
  if (platform !== "linux") {
    return {
      status: "not-installed",
      detail: `Gateway isolation checks are not implemented for ${platform}.`,
      systemUnitPath: null,
    };
  }

  if (existsSync(hardenedUnitPath)) {
    let body: string;
    try {
      body = readFileSync(hardenedUnitPath, "utf8");
    } catch {
      // The generated hardened unit is root-owned 0600; existing but
      // unreadable is the expected shape when doctor runs unprivileged.
      return {
        status: "dedicated-user",
        detail: `A system-level gateway unit exists at ${hardenedUnitPath} (not readable without root; assuming the generated hardened unit).`,
        systemUnitPath: hardenedUnitPath,
      };
    }
    const values = parseSystemdAssignments(body);
    const dynamicUser = values.get("DynamicUser")?.toLowerCase();
    if (dynamicUser === "yes" || dynamicUser === "true" || dynamicUser === "1") {
      return {
        status: "dedicated-user",
        detail: `The system-level gateway unit uses DynamicUser= (${hardenedUnitPath}).`,
        systemUnitPath: hardenedUnitPath,
      };
    }
    const user = values.get("User") ?? "";
    if (user !== "" && user !== "root") {
      const human = isHumanLoginAccount(user, passwdPath);
      if (human === null) {
        return {
          status: "unknown",
          detail: `The system-level gateway unit runs as "${user}" (${hardenedUnitPath}), but that account is not in ${passwdPath} — it may be a service account or a directory-managed login.`,
          systemUnitPath: hardenedUnitPath,
        };
      }
      if (!human) {
        return {
          status: "dedicated-user",
          detail: `The system-level gateway unit runs as "${user}" (${hardenedUnitPath}).`,
          systemUnitPath: hardenedUnitPath,
        };
      }
    }
    return {
      status: "login-user",
      detail: `A system-level gateway unit exists at ${hardenedUnitPath} but does not run as a dedicated user.`,
      systemUnitPath: hardenedUnitPath,
    };
  }

  if (existsSync(systemdUnitPath(homeDir, "gateway"))) {
    return {
      status: "login-user",
      detail: "The gateway runs from a user-level systemd unit, i.e. as the login user.",
      systemUnitPath: hardenedUnitPath,
    };
  }
  return {
    status: "not-installed",
    detail: "No gateway service unit was found.",
    systemUnitPath: hardenedUnitPath,
  };
}

function collectSystemdUnit(
  component: "gateway" | "collector",
  path: string,
  configDir: string,
  homeDir: string,
): SecurityServiceUnit {
  const required = [
    ["UMask", "0077"],
    ["NoNewPrivileges", "true"],
    ["PrivateTmp", "true"],
    ["ProtectSystem", "strict"],
    ["ProtectHome", "read-only"],
    [
      "ReadWritePaths",
      [configDir, `${homeDir}/.local/state/omnesis/logs`].map(systemdEscapeArg).join(" "),
    ],
    ["RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6 AF_NETLINK"],
    // No CapabilityBoundingSet= is expected: a `systemd --user` unit cannot clear
    // the bounding set (that needs CAP_SETPCAP), so generateSystemdUnit omits it.
    // The hardened system unit, which can, is checked separately.
  ] as const;

  if (!existsSync(path)) {
    return {
      component,
      platform: "linux",
      path,
      installed: false,
      directives: required.map(([key, expected]) => ({
        key,
        expected,
        actual: null,
        ok: false,
      })),
    };
  }

  const values = parseSystemdAssignments(readFileSync(path, "utf8"));
  return {
    component,
    platform: "linux",
    path,
    installed: true,
    directives: required.map(([key, expected]) => {
      const actual = values.get(key) ?? null;
      const ok =
        key === "ReadWritePaths"
          ? actual === expected || actual?.startsWith(`${expected} `) === true
          : actual === expected;
      return { key, expected, actual, ok };
    }),
  };
}

/**
 * Read the keyring wiring back out of every installed unit file.
 *
 * Units that cannot be read are skipped rather than reported as unwired: the
 * hardened system unit is root-owned 0600, so an unprivileged `omnesis doctor`
 * sees nothing there, and inventing a finding from a failed read would tell an
 * operator their install is broken because they did not use sudo.
 */
function collectKeyringWiring(
  platform: NodeJS.Platform,
  homeDir: string,
  hardenedUnitPath: string,
  component: "gateway" | "collector",
): SecurityKeyringWiring[] {
  const paths: Array<Pick<SecurityKeyringWiring, "component" | "scope" | "path">> = [];
  if (platform === "linux") {
    const components =
      component === "collector" ? (["collector"] as const) : (["gateway", "collector"] as const);
    for (const unitComponent of components) {
      paths.push({
        component: unitComponent,
        scope: "user",
        path: systemdUnitPath(homeDir, unitComponent),
      });
    }
    if (component === "gateway") {
      paths.push({ component: "gateway", scope: "system", path: hardenedUnitPath });
    }
  } else if (platform === "darwin") {
    const components =
      component === "collector" ? (["collector"] as const) : (["gateway", "collector"] as const);
    for (const unitComponent of components) {
      paths.push({
        component: unitComponent,
        scope: "user",
        path: launchdPlistPath(homeDir, unitComponent),
      });
    }
  }

  const out: SecurityKeyringWiring[] = [];
  for (const unit of paths) {
    if (!existsSync(unit.path)) continue;
    let body: string;
    try {
      body = readFileSync(unit.path, "utf8");
    } catch {
      continue;
    }
    out.push({
      ...unit,
      ...(platform === "darwin" ? readPlistWiring(body) : readSystemdWiring(body)),
    });
  }
  return out;
}

/**
 * Keyring wiring from a systemd unit body.
 *
 * `Environment=` is read line by line rather than through
 * {@link parseSystemdAssignments}: a unit carries one line per variable, and a
 * map keyed on the directive name would keep only the last of them.
 */
function readSystemdWiring(
  body: string,
): Pick<SecurityKeyringWiring, "backend" | "passphraseSource"> {
  const env = new Map<string, string>();
  let credential = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    // Both spellings land the credential in $CREDENTIALS_DIRECTORY under the
    // same name; the encrypted form only changes how it is stored at rest.
    for (const directive of ["LoadCredential=", "LoadCredentialEncrypted="]) {
      if (!line.startsWith(directive)) continue;
      // The value is `<name>:<path>`; only the keyring's own credential counts.
      const value = unquoteUnitValue(line.slice(directive.length));
      if (value.split(":")[0] === PASSPHRASE_CREDENTIAL_NAME) credential = true;
    }
    if (line.startsWith("LoadCredential")) continue;
    if (!line.startsWith("Environment=")) continue;
    const assignment = unquoteUnitValue(line.slice("Environment=".length));
    const eq = assignment.indexOf("=");
    if (eq > 0) env.set(assignment.slice(0, eq), assignment.slice(eq + 1));
  }
  return {
    backend: env.get("OMNESIS_SECRET_STORE") ?? null,
    passphraseSource: credential
      ? "credential"
      : env.get(PASSPHRASE_FILE_ENV)
        ? "file"
        : env.get(PASSPHRASE_ENV)
          ? "inline"
          : null,
  };
}

/** Keyring wiring from a launchd plist body — no credential concept there. */
function readPlistWiring(
  body: string,
): Pick<SecurityKeyringWiring, "backend" | "passphraseSource"> {
  const read = (key: string): string | null =>
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "m").exec(body)?.[1] ?? null;
  return {
    backend: read("OMNESIS_SECRET_STORE"),
    passphraseSource: read(PASSPHRASE_FILE_ENV) ? "file" : read(PASSPHRASE_ENV) ? "inline" : null,
  };
}

/** Strip the optional surrounding quotes systemd allows around a directive value. */
function unquoteUnitValue(raw: string): string {
  const value = raw.trim();
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function collectLaunchdUnit(component: "gateway" | "collector", path: string): SecurityServiceUnit {
  const expected = "63";
  if (!existsSync(path)) {
    return {
      component,
      platform: "darwin",
      path,
      installed: false,
      directives: [{ key: "Umask", expected, actual: null, ok: false }],
    };
  }
  const body = readFileSync(path, "utf8");
  const actual = /<key>Umask<\/key>\s*<integer>(\d+)<\/integer>/m.exec(body)?.[1] ?? null;
  return {
    component,
    platform: "darwin",
    path,
    installed: true,
    directives: [{ key: "Umask", expected, actual, ok: actual === expected }],
  };
}

/**
 * Read a unit file's `Key=Value` directives into a map.
 *
 * systemd tolerates whitespace around both sides of the `=`, so both are
 * trimmed: an untrimmed value would silently fail every later comparison
 * (`User=omnesis-svc ` never matching the account it names), and an
 * untrimmed key would make the directive invisible.
 */
function parseSystemdAssignments(unit: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of unit.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

function displayRelative(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" ? "." : rel;
}

/**
 * The two symlinks a Codex runtime makes inside its own state, and no others.
 *
 * Both are made by the runtime rather than by an operator: the argv0 helpers it
 * materializes in a temp directory before each exec, and — for a pooled runtime,
 * whose members each get an isolated home — an `auth.json` pointing every member
 * at the one shared login, so a token one member refreshes is the token the next
 * one uses.
 *
 * Each is named exactly rather than allowed by subtree, because an allowance
 * wide enough to say "codex writes here" would cover anything it wrote. What
 * can be said about where they lead differs between them, and the difference is
 * worth stating: the shared-login link has one legitimate destination and is
 * checked against it, while a helper points at whatever binary the runtime was
 * launched from — a path outside the config directory with no fixed spelling —
 * so that one is allowed by name. Pooled homes use the same shapes beneath
 * their member index, including the inference and nested lane directories.
 *
 * The destination check compares resolved paths, so a correct link spelled
 * relatively is recognised and an incorrect one spelled to look right is not.
 * It stops at the link itself: a directory *along* the way that is a symlink
 * makes the destination something else again, and that directory is an entry
 * this same scan reports on its own account.
 */
function isAllowedRuntimeSymlink(configDir: string, path: string, relativePath: string): boolean {
  // This platform's separator, and only it. The path came from `relative()`, so
  // it is spelled the way this platform spells one — and a backslash is a legal
  // character in a POSIX filename, so splitting on both would let a single flat
  // entry spell an entire allowed path in its own name and be read as the
  // directories it never had.
  const managed = managedCodexHomePath(relativePath);
  if (managed === null) return false;
  const { pooled, home } = managed;

  // Only the pooled homes share a login, and only with the one file every member
  // is meant to track. The runtime writes an absolute target; a relative one
  // that resolves to the same file is accepted too, since what matters is where
  // it leads and not how it was spelled.
  if (home.length === 1 && home[0] === "auth.json") {
    if (!pooled) return false;
    const target = safeReadlink(path);
    return (
      target !== null &&
      resolve(dirname(path), target) === resolve(codexPaths(configDir).sharedAuth)
    );
  }

  if (home.length !== 4 || home[0] !== "tmp" || home[1] !== "arg0" || !home[2].startsWith("codex-"))
    return false;
  return CODEX_ARG0_HELPER_LINKS.has(home[3]);
}

/** Parse only the owner and the interactive, inference, or nested pool layouts. */
function managedCodexHomePath(relativePath: string): { pooled: boolean; home: string[] } | null {
  const parts = relativePath.split(sep);
  if (parts[0] === CODEX_HOME_DIR) return { pooled: false, home: parts.slice(1) };
  if (parts[0] !== CODEX_POOL_HOME_DIR) return null;
  const lane = parts[1] ?? "";
  const memberAt = lane === "inference" || /^nested-\d+$/.test(lane) ? 2 : 1;
  if (!/^\d+$/.test(parts[memberAt] ?? "")) return null;
  return { pooled: true, home: parts.slice(memberAt + 1) };
}

/** Plugin checkouts and installed assets retain their existing owner execute
 * bit. The surrounding home holds credentials and configuration, so neither
 * it nor the entire temporary directory is an executable-asset allowance. */
function isManagedCodexPluginAsset(relativePath: string): boolean {
  const managed = managedCodexHomePath(relativePath);
  if (managed === null) return false;
  const { home } = managed;
  if (home[0] === "plugins" && home[1] === "cache") {
    // marketplace / plugin / version / asset
    return home.length >= 6;
  }
  if (home[0] !== ".tmp" || home[1] !== "plugins") return false;
  if (home[2] === "plugins") return home.length >= 5;
  if (home[2] === ".agents" && home[3] === "skills") return home.length >= 6;
  return home[2] === ".git" && home[3] === "hooks" && home.length === 5;
}

/**
 * Executables in a gateway-owned Codex install remain owner-executable. Every
 * other regular file in the runtime store is held to the normal 0600 rule.
 * The spelling is intentionally anchored to the package layouts shipped by
 * the pinned Codex npm package; an executable bit elsewhere is still a doctor
 * finding and `--fix-permissions` removes it.
 */
function isManagedCodexExecutable(relativePath: string): boolean {
  const parts = relativePath.split(sep);
  const runtimeDirectory = parts[2] ?? "";
  if (
    parts[0] !== CODEX_RUNTIME_STORE_DIR ||
    (parts[1] !== "versions" && parts[1] !== "staging") ||
    (parts[1] === "versions"
      ? !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:--[A-Za-z0-9._-]+)?$/.test(runtimeDirectory)
      : !/^[A-Za-z0-9._-]+$/.test(runtimeDirectory)) ||
    parts[3] !== "node_modules" ||
    parts[4] !== "@openai"
  ) {
    return false;
  }

  const packageName = parts[5];
  const tail = parts.slice(6);
  if (packageName === "codex") {
    return tail.length === 2 && tail[0] === "bin" && tail[1] === "codex.js";
  }
  if (!/^codex-(?:linux|darwin|win32)-(?:x64|arm64)$/.test(packageName ?? "")) return false;
  if (tail[0] !== "vendor" || !tail[1]) return false;

  const payload = tail.slice(2).join("/");
  return (
    /^bin\/(?:codex|codex-code-mode-host)(?:\.exe)?$/.test(payload) ||
    /^codex-path\/rg(?:\.exe)?$/.test(payload) ||
    payload === "codex-resources/bwrap" ||
    payload === "codex-resources/zsh/bin/zsh"
  );
}

/** What a symlink points at, or null where it cannot be read. */
function safeReadlink(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

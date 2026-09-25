// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Hardened gateway install — a Linux system-level systemd unit that runs the
 * gateway under a dedicated dynamic OS user (`DynamicUser=yes`).
 *
 * The default install runs both daemons as the login user; owner-only file
 * modes keep other OS accounts out but do nothing against other programs
 * running under the same account. Running only the gateway as a dedicated
 * user closes that gap: the gateway needs nothing from the home directory
 * (documents arrive over the token-authenticated HTTP socket, and it
 * downloads models itself), yet it holds the aggregated corpus. The
 * collector deliberately stays as the login user — it reads user data.
 *
 * `StateDirectory=` makes systemd create `/var/lib/omnesis-gateway` owned by
 * the dynamic user, and the unit points `OMNESIS_CONFIG_DIR` at it, so the
 * whole gateway state (DBs, index, TLS cert, tokens, models) lives there.
 *
 * Split mirrors the rest of `service/`: pure spec/unit-body generation
 * (unit-testable string math) plus IO orchestration behind injected deps.
 * Writing the unit needs root, and root writes it from the release it runs:
 * `scripts/hardened-gateway.sh` fetches a release, makes it root-owned, and
 * calls this module through that release's own CLI. A normal account only
 * prints the command that does so (`hardened-bootstrap.ts`).
 */

import { writeFileSync, existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CliError, EXIT_FAILURE, EXIT_USER_ERROR } from "@omnesis/cli-shared";
import {
  HARDENED_ADMIN_COMMAND,
  HARDENED_CONFIG_DIR,
  HARDENED_STATE_DIR,
  HARDENED_UNIT_NAME,
  HARDENED_UNIT_PATH,
  type SecretStoreBackend,
} from "@omnesis/core";
import {
  SERVICE_BASE_PATH,
  SYSTEMD_WRITABLE_FILE_ENV_KEYS,
  keyringCredentials,
  loadCredentialLines,
  systemdEnvLine,
  systemdEscapeArg,
} from "./units.js";
import { COMPONENT_ARGV, type SystemdCredential } from "./types.js";
import type { ExecResult, ExecRunner } from "./supervisor.js";

// ── Constants ──────────────────────────────────────────────────────────

// The unit name (deliberately the same as the user-level gateway unit), its
// system-level path and the state directory it runs against are shared with
// `@omnesis/core`: this module writes the unit, the doctor's security
// collector reads it back to classify gateway process isolation, and the
// updater reads it to tell that this host runs a gateway it may not restart.
export {
  HARDENED_CONFIG_DIR,
  HARDENED_STATE_DIR,
  HARDENED_UNIT_NAME,
  HARDENED_UNIT_PATH,
} from "@omnesis/core";

// ── Spec construction ──────────────────────────────────────────────────

export interface BuildHardenedSpecInput {
  /** Full command line: absolute executable path followed by its argv. */
  exec: string[];
  /** User-supplied `--env KEY=VAL` extras. */
  extraEnv: Record<string, string>;
  /** Directory containing the node binary; prepended to the unit's PATH. */
  nodeBinDir: string;
  /** Secret-store backend the daemon reads its keys from (OMNESIS_SECRET_STORE). */
  secretStore?: SecretStoreBackend;
  /**
   * Absolute path to a file holding the keyring passphrase, handed to the unit
   * via `LoadCredential=`. See the render in `generateHardenedSystemdUnit` for
   * why a credential is the only safe passphrase source here.
   */
  passphraseCredentialPath?: string;
}

/** Everything the hardened unit generator needs. */
export interface HardenedGatewaySpec {
  exec: string[];
  env: Record<string, string>;
  /** systemd credentials rendered as `LoadCredential=<name>:<path>`. */
  credentials?: SystemdCredential[];
}

/**
 * Compose the env for the hardened unit. `OMNESIS_CONFIG_DIR` is pinned to
 * the state directory — an override would break the `StateDirectory=`
 * ownership linkage, so it is rejected rather than silently producing a
 * unit whose config dir the dynamic user cannot write. The same applies to
 * DB/log file redirections outside the state directory: those paths would
 * not be owned by the dynamic user, so the gateway would fail at runtime.
 */
export function buildHardenedGatewaySpec(input: BuildHardenedSpecInput): HardenedGatewaySpec {
  if ("OMNESIS_CONFIG_DIR" in input.extraEnv) {
    throw new CliError(
      "--hardened pins OMNESIS_CONFIG_DIR to the systemd state directory " +
        `(${HARDENED_CONFIG_DIR}) — it cannot be overridden with --env.`,
      EXIT_USER_ERROR,
    );
  }
  for (const key of SYSTEMD_WRITABLE_FILE_ENV_KEYS) {
    const value = input.extraEnv[key];
    if (value !== undefined && !value.startsWith(`${HARDENED_CONFIG_DIR}/`)) {
      throw new CliError(
        `--env ${key}=${value} points outside ${HARDENED_CONFIG_DIR} — the dedicated ` +
          "gateway user can only write inside its state directory.",
        EXIT_USER_ERROR,
      );
    }
  }
  const env: Record<string, string> = {
    OMNESIS_CONFIG_DIR: HARDENED_CONFIG_DIR,
    // A dynamic user has no home directory. Tools that keep per-user files
    // under $HOME (DuckDB installs the extension encrypted analytics needs
    // there) are pointed at the state directory, the one place it can write.
    HOME: HARDENED_CONFIG_DIR,
    PATH: `${input.nodeBinDir}:${SERVICE_BASE_PATH}`,
  };
  // Keyring wiring goes in BEFORE the user's --env extras, so an explicit
  // `--env OMNESIS_SECRET_STORE=…` still wins over `--secret-store`.
  if (input.secretStore) env.OMNESIS_SECRET_STORE = input.secretStore;
  Object.assign(env, input.extraEnv);

  const spec: HardenedGatewaySpec = { exec: [...input.exec], env };
  const credentials = keyringCredentials(input.passphraseCredentialPath);
  if (credentials) spec.credentials = credentials;
  return spec;
}

// ── Unit generation ────────────────────────────────────────────────────

const HOME_PATH_PREFIXES = ["/home/", "/root/"];

export type RealpathFn = (path: string) => string;

/** Best-effort realpath: a path that cannot resolve classifies literally. */
const defaultRealpath: RealpathFn = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Paths the unit depends on that live under a home directory: the
 * executable command line and every PATH entry (the gateway spawns node
 * subprocesses through PATH). The hardened gateway needs nothing from the
 * home tree and runs with home directories hidden, so a home-installed node
 * or omnesis binary (nvm, npm prefix in $HOME) could never start there.
 *
 * Both the literal and the resolved form of each path are classified:
 * ExecStart uses the literal path, but execution follows symlinks — a
 * `/usr/local/bin/omnesis` symlink pointing into `~/.npm-global` still
 * needs the home tree readable, and would crash-loop under
 * `ProtectHome=yes` if only the literal prefix were checked.
 */
export function homeDependentPaths(
  spec: HardenedGatewaySpec,
  realpath: RealpathFn = defaultRealpath,
): string[] {
  const candidates = new Set<string>();
  for (const entry of [...spec.exec, ...(spec.env.PATH ?? "").split(":")]) {
    if (!entry.startsWith("/")) continue; // argv words like "gateway"
    candidates.add(entry);
    candidates.add(realpath(entry));
  }
  return [...candidates].filter((path) =>
    HOME_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
}

/** Owner and permission bits of a path, or null when it cannot be read. */
export type StatFn = (path: string) => { uid: number; mode: number } | null;

const defaultStat: StatFn = (path) => {
  try {
    const st = statSync(path);
    return { uid: st.uid, mode: st.mode };
  } catch {
    return null;
  }
};

/**
 * Paths the dedicated account would run, or reach what it runs through, that an
 * account other than root can change: owned by another user, or writable by
 * group or others. The unit separates the gateway's state from the login
 * account, but that separation holds only while its code is out of that
 * account's reach — a program able to rewrite the executable or a directory on
 * the way to it decides what the gateway runs at its next start. Each
 * executable and PATH entry is checked in its literal and resolved form, up to
 * the filesystem root; the nearest offending path is reported once.
 */
export function codeWritableByNonRoot(
  spec: HardenedGatewaySpec,
  realpath: RealpathFn = defaultRealpath,
  stat: StatFn = defaultStat,
): string[] {
  const candidates = new Set<string>();
  for (const entry of [...spec.exec, ...(spec.env.PATH ?? "").split(":")]) {
    if (!entry.startsWith("/")) continue;
    candidates.add(entry);
    candidates.add(realpath(entry));
  }
  const flagged = new Set<string>();
  for (const candidate of candidates) {
    for (let current = candidate; ; current = dirname(current)) {
      const st = stat(current);
      if (st && (st.uid !== 0 || (st.mode & 0o022) !== 0)) {
        flagged.add(current);
        break;
      }
      if (dirname(current) === current) break;
    }
  }
  return [...flagged];
}

/**
 * Refuse code the dedicated account could not run safely: code under a home
 * directory, which it cannot enter, and code an account other than root can
 * change, which would decide what the gateway runs at its next start and,
 * through it, read the corpus.
 */
export function assertRootControlledCode(
  spec: HardenedGatewaySpec,
  realpath: RealpathFn = defaultRealpath,
  stat: StatFn = defaultStat,
): void {
  const homePaths = homeDependentPaths(spec, realpath);
  if (homePaths.length > 0) {
    throw new CliError(
      `The dedicated account would run code from a home directory (${homePaths.join(", ")}), which it cannot enter. Run 'omnesis service install gateway --hardened' as a normal account: it prints the command that installs a release under /opt/omnesis-gateway.`,
      EXIT_USER_ERROR,
    );
  }
  const writable = codeWritableByNonRoot(spec, realpath, stat);
  if (writable.length > 0) {
    throw new CliError(
      `An account other than root can change code the dedicated account would run (${writable.join(", ")}), so nothing was installed. Remove group and other write access from those paths, or run 'omnesis service install gateway --hardened' as a normal account for the command that installs a release only root can change.`,
      EXIT_USER_ERROR,
    );
  }
}

/**
 * The pre-start step that creates the gateway's install root key in its own
 * state, with the backend the unit hands the gateway. A dedicated account
 * starts from an empty state directory, and a gateway never creates a root key
 * itself, so without this step the keyring wiring would seal nothing and the
 * gateway would open plaintext stores. `keyring init` finds an existing key and
 * changes nothing, so it runs before every start; a key the credential cannot
 * open fails the start instead of letting the gateway run beside it. Null when
 * the unit names no backend that can hold a key here.
 */
export function hardenedKeyringInitCommand(spec: HardenedGatewaySpec): string[] | null {
  const backend = spec.env.OMNESIS_SECRET_STORE;
  if (backend !== "passphrase" && backend !== "file") return null;
  const suffix = COMPONENT_ARGV.gateway;
  const tail = spec.exec.slice(-suffix.length);
  if (spec.exec.length <= suffix.length || tail.some((arg, i) => arg !== suffix[i])) {
    throw new Error(`hardened gateway exec must end with "${suffix.join(" ")}"`);
  }
  return [...spec.exec.slice(0, -suffix.length), "keyring", "init", "--backend", backend];
}

/**
 * Render the hardened system unit. Carries every hardening directive the
 * user-level unit has, plus `DynamicUser=`/`StateDirectory=`. There is no
 * `ReadWritePaths=` — the state directory is the only writable location and
 * `StateDirectory=` grants it implicitly under `ProtectSystem=strict`.
 * `StateDirectoryMode=0700` keeps the corpus unreadable by other users
 * (systemd's default state-directory mode is world-readable 0755).
 */
export function generateHardenedSystemdUnit(spec: HardenedGatewaySpec): string {
  const lines: string[] = [
    "[Unit]",
    "Description=Omnesis gateway (hardened, dedicated user)",
    "Documentation=https://github.com/omnesis-dev/Omnesis",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
  ];
  const keyringInit = hardenedKeyringInitCommand(spec);
  if (keyringInit) lines.push(`ExecStartPre=${keyringInit.map(systemdEscapeArg).join(" ")}`);
  lines.push(`ExecStart=${spec.exec.map(systemdEscapeArg).join(" ")}`);
  // The service manager reads the source file as root and copies it to
  // $CREDENTIALS_DIRECTORY/<name>, readable by this service alone. That is what
  // makes a credential the only safe passphrase source under `DynamicUser=`:
  // the uid is allocated at each start, so a passphrase file anywhere outside
  // the state directory is reachable only by being world-readable — which
  // hands it to every local account this unit exists to be isolated from.
  lines.push(...loadCredentialLines(spec.credentials));
  for (const [key, value] of Object.entries(spec.env)) {
    lines.push(systemdEnvLine(key, value));
  }
  lines.push(
    "DynamicUser=yes",
    `StateDirectory=${HARDENED_STATE_DIR}`,
    "StateDirectoryMode=0700",
    "UMask=0077",
    "Restart=on-failure",
    "RestartSec=2",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    // AF_NETLINK lets os.networkInterfaces() list the interfaces (glibc's
    // getifaddrs asks the kernel over netlink); without it the call throws and
    // the gateway turns LAN discovery off. Reading interfaces needs no capability.
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
    "CapabilityBoundingSet=",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  );
  return lines.join("\n");
}

// ── Install / uninstall orchestration ──────────────────────────────────

/** Attempts × interval of the post-`enable --now` liveness poll (~5s). */
const ACTIVE_POLL_ATTEMPTS = 5;
const ACTIVE_POLL_INTERVAL_MS = 1_000;

export interface HardenedDeps {
  exec: ExecRunner;
  /** Overridable for tests; defaults to /etc/systemd/system/…. */
  unitPath?: string;
}

export interface HardenedInstallDeps extends HardenedDeps {
  /** Test seam for the liveness-poll delay; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface HardenedUninstallDeps extends HardenedDeps {
  /** Whether the CLI runs as root (may apply directly). */
  isRoot: boolean;
  /** The admin command is installed, and owns the releases this unit runs. */
  adminInstalled: boolean;
}

export type HardenedUninstallResult =
  | { applied: true; existed: boolean; unitPath: string }
  | { applied: false; existed: boolean; unitPath: string; commands: string[] };

/**
 * Install the hardened gateway unit, as root: write the unit (0600 — the env
 * may carry secrets), reload, enable --now, then poll the unit to active.
 */
export async function installHardenedGateway(
  spec: HardenedGatewaySpec,
  deps: HardenedInstallDeps,
): Promise<{ unitPath: string }> {
  const unitPath = deps.unitPath ?? HARDENED_UNIT_PATH;
  writeFileSync(unitPath, generateHardenedSystemdUnit(spec), { mode: 0o600 });
  await systemctl(deps.exec, ["daemon-reload"]);
  await systemctl(deps.exec, ["enable", "--now", HARDENED_UNIT_NAME]);
  await waitForActive(deps);
  return { unitPath };
}

/**
 * Poll the unit to `active`. `systemctl enable --now` exits 0 for a
 * Type=simple unit whose exec then dies immediately (bad path, a binary
 * the dynamic user cannot read, …), so "installed" must not be
 * reported as "started" without observing the unit actually running. The
 * first check is delayed one interval to give an instant crash time to
 * surface instead of racing it.
 */
async function waitForActive(deps: HardenedInstallDeps): Promise<void> {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolveDone) => setTimeout(resolveDone, ms)));
  let lastState = "";
  for (let attempt = 0; attempt < ACTIVE_POLL_ATTEMPTS; attempt += 1) {
    await sleep(ACTIVE_POLL_INTERVAL_MS);
    const res = await deps.exec("systemctl", ["is-active", HARDENED_UNIT_NAME]);
    lastState = res.stdout.trim();
    if (lastState === "active") return;
  }
  const waitedSeconds = (ACTIVE_POLL_ATTEMPTS * ACTIVE_POLL_INTERVAL_MS) / 1_000;
  throw new CliError(
    `${HARDENED_UNIT_NAME} was installed but did not become active within ${waitedSeconds}s` +
      ` (last state: ${lastState || "unknown"}). Inspect it with` +
      ` 'journalctl -u ${HARDENED_UNIT_NAME} -n 50'.`,
    EXIT_FAILURE,
  );
}

/**
 * Uninstall the hardened gateway unit. A gateway the admin command installed
 * is removed by that command, which takes its releases away too, so either
 * account is pointed at it rather than leaving releases behind a removed unit.
 * Otherwise root applies directly (idempotent — `disable` failing on a missing
 * unit is harmless) and a normal account gets the sudo commands. The state
 * directory under /var/lib is deliberately left in place — it holds the corpus.
 */
export async function uninstallHardenedGateway(
  deps: HardenedUninstallDeps,
): Promise<HardenedUninstallResult> {
  const unitPath = deps.unitPath ?? HARDENED_UNIT_PATH;
  // Existence is visible without read permission on the (root-owned) file.
  const existed = existsSync(unitPath);

  if (deps.adminInstalled) {
    return {
      applied: false,
      existed,
      unitPath,
      commands: [`sudo ${HARDENED_ADMIN_COMMAND} uninstall`],
    };
  }

  if (!deps.isRoot) {
    return {
      applied: false,
      existed,
      unitPath,
      commands: [
        `sudo systemctl disable --now ${HARDENED_UNIT_NAME}`,
        `sudo rm -f ${unitPath}`,
        "sudo systemctl daemon-reload",
      ],
    };
  }

  await deps.exec("systemctl", ["disable", "--now", HARDENED_UNIT_NAME]);
  rmSync(unitPath, { force: true });
  await systemctl(deps.exec, ["daemon-reload"]);
  return { applied: true, existed, unitPath };
}

/** Run `systemctl …` (system manager), surfacing non-zero exit as a CLI error. */
async function systemctl(exec: ExecRunner, args: string[]): Promise<ExecResult> {
  const res = await exec("systemctl", args);
  if (res.code !== 0) {
    throw new CliError(
      `systemctl ${args.join(" ")} failed (${res.code}): ${res.stderr.trim()}`,
      EXIT_FAILURE,
    );
  }
  return res;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis service` — install and manage the Omnesis daemons as
 * platform-native services (launchd LaunchAgents on macOS, systemd user
 * units on Linux). The heavy lifting lives in `../service/`: pure unit-file
 * generation in `units.ts`, executable resolution in `exec-resolver.ts`,
 * and the service-manager process calls in `supervisor.ts`.
 */

import { homedir } from "node:os";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { defineCommand } from "citty";
import { parseDotEnv } from "@omnesis/config";
import {
  fullDiskAccessRemediation,
  DEFAULT_CONFIG_DIR,
  HARDENED_RELEASE_ROOT,
  HARDENED_REPO_URL,
  SECRET_STORE_BACKENDS,
  inspectInstallRootKey,
  parseSecretStoreBackend,
  readCollectorPairingState,
  readPackageVersion,
  type CollectorPairingState,
  type SecretStoreBackend,
  servedCertificateCoversLocalhost,
} from "@omnesis/core";
import { c, isJSON, CliError, EXIT_USER_ERROR } from "../utils.js";
import {
  SERVICE_COMPONENTS,
  isServiceComponent,
  type ServiceComponent,
  type ServiceStatus,
} from "../service/types.js";
import {
  buildServiceSpec,
  loadCredentialSupportWarning,
  systemdUnitPath,
} from "../service/units.js";
import { stableNodeBinDir } from "../service/node-bin-dir.js";
import { createSupervisor, defaultExecRunner, type ExecRunner } from "../service/supervisor.js";
import { defaultExecResolveDeps, resolveServiceExec } from "../service/exec-resolver.js";
import {
  assertRootControlledCode,
  hardenedKeyringInitCommand,
  HARDENED_CONFIG_DIR,
  HARDENED_UNIT_NAME,
  buildHardenedGatewaySpec,
  installHardenedGateway,
  uninstallHardenedGateway,
} from "../service/hardened.js";
import {
  commitOnRemote,
  hardenedAdminInstalled,
  hardenedBootstrapCommand,
  hardenedBootstrapFlags,
  repositoryNeedsCredential,
  resolveBootstrapTarget,
} from "../service/hardened-bootstrap.js";

const COMPONENT_CHOICES = `${SERVICE_COMPONENTS.join(" | ")} | all`;

// ── Flag parsing (exported for tests) ──────────────────────────────────

/**
 * Resolve the positional component selector. `all` expands to every
 * component; absent falls back to the per-verb default set.
 */
export function parseComponentSelection(
  raw: unknown,
  defaults: ServiceComponent[],
): ServiceComponent[] {
  if (typeof raw !== "string" || raw === "") return defaults;
  if (raw === "all") return [...SERVICE_COMPONENTS];
  if (!isServiceComponent(raw)) {
    throw new CliError(
      `${c.red}Unknown component '${raw}'. Expected one of: ${COMPONENT_CHOICES}.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return [raw];
}

/**
 * Collect every `--env KEY=VAL` occurrence from the raw argv. citty's
 * `type: "string"` args are last-wins on repetition, so repeatable flags
 * have to be read from rawArgs.
 */
export function collectEnvFlags(rawArgs: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--env" && i + 1 < rawArgs.length) {
      out.push(rawArgs[i + 1]);
      i += 1;
    } else if (arg.startsWith("--env=")) {
      out.push(arg.slice("--env=".length));
    }
  }
  return out;
}

/** Parse repeatable `--env KEY=VAL` flags into an env record. */
export function parseEnvFlags(raw: unknown): Record<string, string> {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const out: Record<string, string> = {};
  for (const item of list) {
    const text = String(item);
    const eq = text.indexOf("=");
    const key = eq > 0 ? text.slice(0, eq) : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new CliError(
        `${c.red}Invalid --env '${text}' — expected KEY=VALUE with an identifier key.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    const value = text.slice(eq + 1);
    // The value is rendered into one `Environment=` line. A newline in it would
    // end that line and let the remainder be read as further unit directives —
    // in a hardened install, into a unit file owned by root.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(value) || value.endsWith("\\")) {
      throw new CliError(
        `${c.red}Invalid --env '${key}' — the value must not contain control characters or end in a backslash.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    out[key] = value;
  }
  return out;
}

/** Validate `--instance` — it becomes part of a unit name, so keep it tame. */
export function parseInstanceFlag(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(raw)) {
    throw new CliError(
      `${c.red}Invalid --instance '${raw}' — use letters, digits, and dashes only.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return raw;
}

/** Parse `-n/--lines` for `service logs`. */
export function parseLinesFlag(raw: unknown): number {
  if (raw === undefined || raw === "" || raw === false) return 100;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== String(raw).trim()) {
    throw new CliError(
      `${c.red}Invalid --lines '${raw}' — expected a positive integer.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return parsed;
}

function parseConfigDirFlag(raw: unknown): string {
  const dir = typeof raw === "string" && raw !== "" ? raw : DEFAULT_CONFIG_DIR;
  return resolve(dir);
}

// ── Keyring wiring ─────────────────────────────────────────────────────

/** How the installed daemon reads its keyring, resolved from flags + the config dir. */
export interface KeyringWiring {
  secretStore?: SecretStoreBackend;
  passphraseCredentialPath?: string;
  passphraseFilePath?: string;
}

/**
 * A passphrase source must be an absolute, non-empty file, named by a path the
 * unit file can carry. Two shapes it cannot: a control character ends the
 * `LoadCredential=` / `Environment=` line it is rendered into and lets the rest
 * be read as further directives, and a trailing backslash makes the unit-file
 * reader splice the following line onto the value. Neither survives any
 * escaping, so they are refused at the door.
 *
 * `readableByCaller: false` (a credential for a unit the service manager
 * starts as root) keeps the existence check but tolerates a permission error:
 * the point of a credential is that root reads a file the caller cannot. The
 * emptiness check goes with it — an unreadable file cannot be inspected — so
 * an empty credential surfaces at boot rather than here.
 */
function validatePassphraseSource(
  raw: string,
  kind: "credential" | "file",
  readableByCaller = true,
): string {
  if (!isAbsolute(raw)) {
    throw new CliError(
      `${c.red}--keyring-passphrase-${kind} must be an absolute path (got '${raw}').${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(raw) || raw.endsWith("\\")) {
    throw new CliError(
      `${c.red}--keyring-passphrase-${kind} must not contain control characters or end in a backslash — a unit file cannot carry such a path.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  let contents: string;
  try {
    contents = readFileSync(raw, "utf8");
  } catch (err) {
    const permissionDenied =
      !readableByCaller && (err as NodeJS.ErrnoException)?.code === "EACCES" && existsSync(raw);
    if (permissionDenied) return raw;
    throw new CliError(
      `${c.red}Keyring passphrase ${kind} file is not readable: ${raw}${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (contents.replace(/\n$/, "").length === 0) {
    throw new CliError(
      `${c.red}Keyring passphrase ${kind} file is empty: ${raw}${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return raw;
}

/**
 * Resolve how the daemon should reach its keyring. An explicit `--secret-store`
 * wins; otherwise an already-armed OS keyring is auto-detected so `service
 * install collector` on a Mac just works. The passphrase backend (headless
 * Linux) additionally needs a source — a systemd credential or an env file.
 *
 * `unitRunsAs` says whose keys the unit will open. `"caller"` (the default,
 * and what a user-level unit does) means the CLI and the daemon share an
 * identity, so probing the caller's OS keyring answers for the daemon and a
 * credential file the caller cannot read is a genuine error. `"system"` — a
 * unit the service manager starts under another identity — makes both
 * inferences false: nothing is auto-detected, and a credential the caller
 * cannot read is expected, because root is the one that will read it.
 */
export async function resolveKeyringWiring(
  args: { secretStore?: unknown; credential?: unknown; file?: unknown },
  configDir: string,
  platform: "darwin" | "linux",
  opts: {
    unitRunsAs?: "caller" | "system";
    /** Keyring probe; injected in tests, which have no OS keyring to arm. */
    inspectRootKey?: typeof inspectInstallRootKey;
  } = {},
): Promise<KeyringWiring> {
  const unitRunsAs = opts.unitRunsAs ?? "caller";
  const inspectRootKey = opts.inspectRootKey ?? inspectInstallRootKey;
  const rawStore =
    typeof args.secretStore === "string" && args.secretStore ? args.secretStore : undefined;
  let secretStore: SecretStoreBackend | undefined;
  if (rawStore) {
    try {
      secretStore = parseSecretStoreBackend(rawStore);
    } catch (err) {
      throw new CliError(
        `${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
  } else if (unitRunsAs === "caller") {
    // Auto-detect an armed OS keyring (macOS Keychain / Secret Service). The
    // passphrase backend is never auto-selected — it must be requested. Picking
    // it up here would demand a source flag below that this run was never
    // given, so a re-install over a passphrase-sealed machine — every headless
    // box, and the rescue path after a failed update — refuses to register its
    // services while reporting the install a success.
    const state = await inspectRootKey({ configDir }).catch(() => null);
    const detected = state?.valid ? state.store.backend : undefined;
    if (
      detected &&
      detected !== "file" &&
      detected !== "unavailable" &&
      detected !== "passphrase"
    ) {
      secretStore = detected;
    }
  }

  const credRaw =
    typeof args.credential === "string" && args.credential ? args.credential : undefined;
  const fileRaw = typeof args.file === "string" && args.file ? args.file : undefined;
  if (credRaw && fileRaw) {
    throw new CliError(
      `${c.red}Pass only one of --keyring-passphrase-credential / --keyring-passphrase-file.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (credRaw && platform !== "linux") {
    throw new CliError(
      `${c.red}--keyring-passphrase-credential is systemd-only; on macOS use --keyring-passphrase-file.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }

  const wiring: KeyringWiring = {};
  if (secretStore) wiring.secretStore = secretStore;
  if (credRaw) {
    wiring.passphraseCredentialPath = validatePassphraseSource(
      credRaw,
      "credential",
      unitRunsAs === "caller",
    );
  }
  if (fileRaw) wiring.passphraseFilePath = validatePassphraseSource(fileRaw, "file");

  if (secretStore === "passphrase" && !credRaw && !fileRaw) {
    throw new CliError(
      `${c.red}The passphrase keyring needs a source: pass --keyring-passphrase-credential <abs-path> ` +
        `(Linux/systemd) or --keyring-passphrase-file <abs-path>.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  // The mirror image, and just as silent: only the passphrase backend reads a
  // passphrase, so a source handed to any other backend is wired into the unit
  // and never consulted. Refuse it rather than install a unit whose keyring
  // flags did nothing.
  if (secretStore !== "passphrase" && (credRaw || fileRaw)) {
    throw new CliError(
      `${c.red}--keyring-passphrase-${credRaw ? "credential" : "file"} only applies to the passphrase keyring; ` +
        `pass --secret-store passphrase with it${secretStore ? ` (this install names --secret-store ${secretStore})` : ""}.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  return wiring;
}

// ── Hardened mode (dedicated-user gateway) ─────────────────────────────

/**
 * `--hardened` is Linux-only: it relies on systemd's `DynamicUser=` and a
 * system-level unit. macOS has no counterpart the command could install, so
 * the refusal names what is available there without equating it: a gateway
 * in a container is separated from the login account by the container, which
 * is a different boundary from a dedicated account on the same kernel.
 */
export function requireHardenedPlatform(platform: NodeJS.Platform): void {
  if (platform === "linux") return;
  if (platform === "darwin") {
    throw new CliError(
      `${c.red}--hardened needs Linux with systemd; macOS has no dedicated-account gateway service. Run the gateway as your user (the default), or in Docker, where the container rather than a separate account separates it from your other programs — a different boundary, not the same protection. See https://omnesis.dev/docs/security#hardened-gateway.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  throw new CliError(
    `${c.red}--hardened requires Linux with systemd (not supported on ${platform}).${c.reset}`,
    EXIT_USER_ERROR,
  );
}

/**
 * Hardened mode applies to the gateway alone, and only when named
 * explicitly — the collector must keep running as the login user because
 * it reads the user's data (Full Disk Access, local app databases).
 */
export function requireHardenedGatewaySelection(raw: unknown, verb: "install" | "uninstall"): void {
  if (raw === "gateway") return;
  throw new CliError(
    `${c.red}--hardened applies to the gateway only (the collector must stay as your login user — it reads your data). Run 'omnesis service ${verb} gateway --hardened'.${c.reset}`,
    EXIT_USER_ERROR,
  );
}

/**
 * Post-install guidance for a macOS collector. The launchd agent runs Node
 * (via the omnesis wrapper) to read Apple data behind Full Disk Access, which
 * macOS never prompts for and no installer can grant. The steps are the same
 * ones a refused source later reports as its remedy, from the same author,
 * so the operator reads one procedure wherever they meet it. The binary named
 * is the node the unit will run: its directory heads the unit's PATH.
 */
export function collectorFdaNote(
  component: ServiceComponent,
  platform: "darwin" | "linux",
  nodePath: string,
): string | null {
  if (component !== "collector" || platform !== "darwin") return null;
  const remediation = fullDiskAccessRemediation(nodePath);
  const steps = [...remediation.steps, "Restart the collector: omnesis service restart collector"];
  return [
    `${remediation.summary} for the collector to read the databases macOS protects.`,
    "macOS never prompts for it; grant it by hand:",
    ...steps.map((step, i) => `  ${i + 1}. ${step}`),
    `  executable: ${remediation.executable}`,
    "A source still refused afterwards reports these steps on the portal's Sources",
    "page and in `omnesis status`. Re-grant after a Node upgrade — the path changes.",
  ].join("\n");
}

/**
 * The two `open` invocations that put the grant within a drag: reveal the
 * executable in Finder, then open System Settings at the Full Disk Access
 * pane. Pure, so the install can decide when to run them.
 */
export function fdaOpenCommands(nodePath: string): Array<[string, string[]]> {
  return [
    ["open", ["-R", nodePath]],
    ["open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]],
  ];
}

/**
 * Put the grant within a drag, when someone is there to drag. Only an
 * operator at a terminal can act on windows opening — a scripted or headless
 * install, or one that asked not to, gets the printed procedure alone. Best
 * effort: a failed `open` changes nothing about the install. Returns whether
 * both windows opened.
 */
export async function openFdaGrant(
  nodePath: string,
  gate: { isTTY: boolean; noOpen: boolean },
  run: ExecRunner = defaultExecRunner,
): Promise<boolean> {
  if (!gate.isTTY || gate.noOpen) return false;
  let opened = true;
  for (const [cmd, args] of fdaOpenCommands(nodePath)) {
    const res = await run(cmd, args);
    if (res.code !== 0) opened = false;
  }
  return opened;
}

/**
 * Why each keyring backend is out of reach of a hardened unit, or `null` when
 * it is serviceable. The gateway runs as a dynamic user in a system service:
 * there is no session bus and no login keyring to unlock a Secret Service
 * collection, and the Keychain belongs to a platform where `--hardened` does
 * not exist at all. Exhaustive by type, so a new backend has to be classified
 * here rather than silently defaulting to reachable.
 */
const HARDENED_BACKEND_OBSTACLE: Record<SecretStoreBackend, string | null> = {
  "secret-service": "a dynamic user has no session bus or login keyring to unlock",
  "macos-keychain": "hardened mode is Linux-only",
  passphrase: null,
  file: null,
  // Accepted for outcome parity: it asks the daemon to choose at boot, which
  // is what a unit carrying no backend at all already does. Refusing the
  // spelling while allowing the silence would be a distinction without one.
  auto: null,
};

/** Reject flags that make no sense combined with `--hardened`. */
export function rejectHardenedIncompatibleFlags(args: {
  instance?: unknown;
  "config-dir"?: unknown;
}): void {
  if (typeof args.instance === "string" && args.instance !== "") {
    throw new CliError(
      `${c.red}--hardened does not support --instance — one hardened gateway per host.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (typeof args["config-dir"] === "string" && args["config-dir"] !== "") {
    throw new CliError(
      `${c.red}--hardened stores gateway state in ${HARDENED_CONFIG_DIR} (systemd StateDirectory) — --config-dir cannot be combined with it.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
}

/**
 * Reject keyring wirings a hardened unit cannot honour. Install-only: these
 * flags describe how the daemon reaches its keys, which an uninstall neither
 * reads nor needs.
 */
export function rejectHardenedKeyringFlags(args: {
  "secret-store"?: unknown;
  "keyring-passphrase-file"?: unknown;
}): void {
  const unreachable = Object.entries(HARDENED_BACKEND_OBSTACLE).find(
    ([backend, obstacle]) => backend === args["secret-store"] && obstacle !== null,
  );
  if (unreachable) {
    const [backend, obstacle] = unreachable;
    throw new CliError(
      `${c.red}--secret-store ${backend} cannot be reached by a hardened gateway (${obstacle}). Use --secret-store passphrase with --keyring-passphrase-credential, or --secret-store file to seal the keys in the state directory.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  if (
    typeof args["keyring-passphrase-file"] === "string" &&
    args["keyring-passphrase-file"] !== ""
  ) {
    throw new CliError(
      `${c.red}--keyring-passphrase-file cannot be used by a hardened gateway: its uid is allocated at each start, so a file outside the state directory is reachable only by being world-readable — which hands the passphrase to every local account. Use --keyring-passphrase-credential <abs-path> — systemd reads the file as root and exposes it to this service alone.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
}

/**
 * Print a warning when this host's systemd is too old to read the credential
 * the install just wired in. Best-effort: a `systemctl` that cannot be run or
 * whose output does not parse says nothing, since the check exists to catch a
 * version known to be too old rather than to nag about an unreadable one.
 */
export async function warnOnUnsupportedCredential(
  wiring: KeyringWiring,
  platform: "darwin" | "linux",
  exec: ExecRunner = defaultExecRunner,
): Promise<string | null> {
  if (!wiring.passphraseCredentialPath || platform !== "linux") return null;
  // The runner reports a missing binary as a non-zero exit with empty stdout
  // rather than rejecting, and an unreadable version says nothing.
  const result = await exec("systemctl", ["--version"]);
  const warning = loadCredentialSupportWarning(result.stdout);
  if (warning) console.log(`${c.yellow}${warning}${c.reset}`);
  return warning;
}

/**
 * Home directory of the user who invoked sudo, resolved from /etc/passwd
 * contents (field 6); falls back to the conventional /home/<user> when the
 * passwd entry is missing or unreadable.
 */
export function resolveSudoUserHome(sudoUser: string, passwdContents: string | null): string {
  for (const line of (passwdContents ?? "").split("\n")) {
    const fields = line.split(":");
    if (fields[0] === sudoUser && fields[5]) return fields[5];
  }
  return `/home/${sudoUser}`;
}

/**
 * Homes to probe for a leftover user-level gateway unit. Under sudo,
 * `homedir()` is root's home, so the invoking user's home (where the
 * default install put its units) is probed as well.
 */
function userUnitCandidateHomes(): Set<string> {
  const homes = new Set([homedir()]);
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser) {
    homes.add(resolveSudoUserHome(sudoUser, readPasswdBestEffort()));
  }
  return homes;
}

function readPasswdBestEffort(): string | null {
  try {
    return readFileSync("/etc/passwd", "utf8");
  } catch {
    return null;
  }
}

function isRootUser(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function printSudoCommands(commands: string[]): void {
  for (const command of commands) {
    console.log(`  ${c.bold}${command}${c.reset}`);
  }
}

/**
 * Print the one root command that installs, or moves, the dedicated gateway.
 * A normal account writes no unit: the gateway runs from a release root fetches
 * and owns, so this account's part is the command for this CLI's own release,
 * port and keyring choice.
 */
function printHardenedBootstrap(
  args: Record<string, unknown>,
  extraEnv: Record<string, string>,
): void {
  const installed = hardenedAdminInstalled();
  const { port, keyring } = hardenedBootstrapFlags(args, extraEnv, installed);
  const target = resolveBootstrapTarget(readPackageVersion(import.meta.url));
  if (target.kind === "ref" && /^[0-9a-f]{40}$/.test(target.ref) && !commitOnRemote(target.ref)) {
    console.log(
      `${c.yellow}This checkout sits on commit ${target.ref.slice(0, 12)}, which no branch on its remote contains. Root fetches from ${HARDENED_REPO_URL}, never from this checkout, so push the commit first or install a release.${c.reset}`,
    );
  }
  const command = hardenedBootstrapCommand({
    target,
    port,
    keyring,
    needsCredential: repositoryNeedsCredential(),
    installed,
  });
  console.log(
    installed
      ? "A dedicated gateway is installed here. Moving it to this release takes one command as root:"
      : "The dedicated gateway runs from a copy of Omnesis that root fetches and owns, so installing it takes one command as root:",
  );
  console.log();
  printSudoCommands([command]);
  console.log();
  console.log(
    `${c.dim}It fetches the release from ${HARDENED_REPO_URL}, builds it as a throwaway account, installs it under ${HARDENED_RELEASE_ROOT} where only root can change it, and ${installed ? "restarts" : "starts"} ${HARDENED_UNIT_NAME}. Nothing the gateway runs comes from this account's files.${c.reset}`,
  );
}

async function runHardenedInstall(ctx: {
  args: Record<string, unknown>;
  rawArgs: string[];
}): Promise<void> {
  requireHardenedPlatform(process.platform);
  requireHardenedGatewaySelection(ctx.args.component, "install");
  rejectHardenedIncompatibleFlags(ctx.args);

  const extraEnv = parseEnvFlags(collectEnvFlags(ctx.rawArgs));
  if (!isRootUser()) {
    printHardenedBootstrap(ctx.args, extraEnv);
    return;
  }
  // `--no-keyring` reaches citty as `keyring: false` (a negation of a flag
  // named `keyring`), never as `args["no-keyring"]`.
  if (ctx.args["no-keyring"] === true || ctx.args.keyring === false) {
    throw new CliError(
      `${c.red}--no-keyring applies to the install command a normal account prints. As root, leave --secret-store out to install a gateway without encryption at rest.${c.reset}`,
      EXIT_USER_ERROR,
    );
  }
  rejectHardenedKeyringFlags(ctx.args);

  const execFlag = typeof ctx.args.exec === "string" && ctx.args.exec ? ctx.args.exec : undefined;
  const exec = await resolveServiceExec("gateway", execFlag, defaultExecResolveDeps());
  // The passphrase file is rejected above, so only the credential is read here.
  const wiring = await resolveKeyringWiring(
    {
      secretStore: ctx.args["secret-store"],
      credential: ctx.args["keyring-passphrase-credential"],
    },
    HARDENED_CONFIG_DIR,
    "linux",
    { unitRunsAs: "system" },
  );
  const spec = buildHardenedGatewaySpec({
    exec,
    extraEnv,
    nodeBinDir: stableNodeBinDir(process.execPath),
    // Spelled out rather than spread: `KeyringWiring` also carries the
    // passphrase *file* path, which the flag gate above has already rejected
    // for this unit. A spread would silently drop it instead.
    ...(wiring.secretStore ? { secretStore: wiring.secretStore } : {}),
    ...(wiring.passphraseCredentialPath
      ? { passphraseCredentialPath: wiring.passphraseCredentialPath }
      : {}),
  });

  await warnOnUnsupportedCredential(wiring, "linux");

  // The unit is written only for code root alone controls.
  assertRootControlledCode(spec);

  const result = await installHardenedGateway(spec, { exec: defaultExecRunner });

  if (hardenedKeyringInitCommand(spec)) {
    console.log(
      `${c.dim}The unit creates the gateway's keyring root key in ${HARDENED_CONFIG_DIR} before its first start (omnesis keyring init), so its stores are encrypted from the start.${c.reset}`,
    );
  }
  console.log(
    `Installed and started ${c.bold}${HARDENED_UNIT_NAME}${c.reset} ${c.dim}(${result.unitPath})${c.reset}`,
  );
  console.log(`  ${c.dim}exec: ${exec.join(" ")}${c.reset}`);
  console.log(`  ${c.dim}state: ${HARDENED_CONFIG_DIR} (owned by the dynamic user)${c.reset}`);

  // Both a user-level and the hardened system-level gateway unit can run at
  // once (same unit name, different systemd managers) — flag the overlap.
  for (const home of userUnitCandidateHomes()) {
    const userUnitPath = systemdUnitPath(home, "gateway");
    if (existsSync(userUnitPath)) {
      console.log(
        `${c.yellow}A user-level gateway unit is also installed (${userUnitPath}) — remove it with 'omnesis service uninstall gateway' (as that user) so only the hardened gateway runs.${c.reset}`,
      );
    }
  }
}

async function runHardenedUninstall(ctx: { args: Record<string, unknown> }): Promise<void> {
  requireHardenedPlatform(process.platform);
  requireHardenedGatewaySelection(ctx.args.component, "uninstall");
  rejectHardenedIncompatibleFlags(ctx.args);

  const adminInstalled = hardenedAdminInstalled();
  const result = await uninstallHardenedGateway({
    exec: defaultExecRunner,
    isRoot: isRootUser(),
    adminInstalled,
  });

  if (adminInstalled && !result.applied) {
    console.log(
      "This dedicated gateway was installed by its admin command, which removes the service and its releases together — run:",
    );
    console.log();
    printSudoCommands(result.commands);
    console.log();
    console.log(
      `${c.dim}Gateway state in ${HARDENED_CONFIG_DIR} is kept — remove it manually if you no longer need the corpus.${c.reset}`,
    );
    return;
  }
  if (!result.existed) {
    console.log(
      `${c.dim}No hardened gateway unit at ${result.unitPath} — nothing to uninstall.${c.reset}`,
    );
    return;
  }
  if (result.applied) {
    console.log(`Uninstalled ${HARDENED_UNIT_NAME} ${c.dim}(${result.unitPath})${c.reset}`);
    console.log(
      `${c.dim}Gateway state in ${HARDENED_CONFIG_DIR} was kept — remove it manually if you no longer need the corpus.${c.reset}`,
    );
  } else {
    console.log("Removing a system unit needs root — run:");
    console.log();
    printSudoCommands(result.commands);
    console.log();
    console.log(
      `${c.dim}Gateway state in ${HARDENED_CONFIG_DIR} is kept — remove it manually if you no longer need the corpus.${c.reset}`,
    );
  }
}

// ── Shared arg defs ────────────────────────────────────────────────────

const componentArg = {
  component: {
    type: "positional" as const,
    description: `Component to act on (${COMPONENT_CHOICES})`,
    required: false,
  },
};

const commonFlags = {
  "config-dir": {
    type: "string" as const,
    description:
      "Config directory the unit points at (default: $OMNESIS_CONFIG_DIR or ~/.config/omnesis)",
  },
  instance: {
    type: "string" as const,
    description: "Named parallel instance — unit names get this suffix",
  },
};

// ── install ────────────────────────────────────────────────────────────

const serviceInstallCommand = defineCommand({
  meta: {
    name: "install",
    description: "Install and start service units (default: gateway + collector)",
  },
  args: {
    ...componentArg,
    ...commonFlags,
    env: {
      type: "string",
      description: "Extra KEY=VALUE env baked into the unit (repeatable)",
    },
    exec: {
      type: "string",
      description: "Override the resolved daemon executable",
    },
    "secret-store": {
      type: "string",
      description: `Keyring backend the daemon reads keys from (${SECRET_STORE_BACKENDS.join(", ")}); omit to auto-detect an armed OS keyring`,
    },
    "keyring-passphrase-credential": {
      type: "string",
      description:
        "Linux/systemd only: absolute path to the keyring passphrase file, wired into the unit via LoadCredential",
    },
    "keyring-passphrase-file": {
      type: "string",
      description:
        "Absolute path to the keyring passphrase file, exposed to the daemon via OMNESIS_KEYRING_PASSPHRASE_FILE",
    },
    hardened: {
      type: "boolean",
      description:
        "Linux only: print the root command that installs the gateway as a dedicated account, running from a release only root can change",
    },
    "no-keyring": {
      type: "boolean",
      description: "--hardened: install the dedicated gateway without encryption at rest",
    },
    "no-open": {
      type: "boolean",
      description:
        "macOS collector: do not open System Settings and Finder for the Full Disk Access grant",
    },
  },
  async run(ctx) {
    if (ctx.args.hardened) {
      await runHardenedInstall(ctx);
      return;
    }
    const components = parseComponentSelection(ctx.args.component, ["gateway", "collector"]);
    const instance = parseInstanceFlag(ctx.args.instance);
    const configDir = parseConfigDirFlag(ctx.args["config-dir"]);
    const extraEnv = parseEnvFlags(collectEnvFlags(ctx.rawArgs));
    const execFlag = typeof ctx.args.exec === "string" && ctx.args.exec ? ctx.args.exec : undefined;
    const supervisor = createSupervisor();
    const resolveDeps = defaultExecResolveDeps();
    const wiring = await resolveKeyringWiring(
      {
        secretStore: ctx.args["secret-store"],
        credential: ctx.args["keyring-passphrase-credential"],
        file: ctx.args["keyring-passphrase-file"],
      },
      configDir,
      supervisor.platform,
    );

    await warnOnUnsupportedCredential(wiring, supervisor.platform);

    const configEnvPath = join(configDir, ".env");
    const configEnvContent = existsSync(configEnvPath)
      ? readFileSync(configEnvPath, "utf8")
      : undefined;
    for (const component of components) {
      const exec = await resolveServiceExec(component, execFlag, resolveDeps);
      const loopbackGatewayUrl = collectorGatewayUrl({
        component,
        installingAlongsideGateway: components.includes("gateway"),
        gatewayAlreadyInstalled: supervisor.isInstalled("gateway", instance),
        extraEnv,
        configEnvContent,
        configDir,
      });
      const spec = buildServiceSpec({
        component,
        ...(instance !== undefined ? { instance } : {}),
        configDir,
        exec,
        extraEnv:
          loopbackGatewayUrl === undefined
            ? extraEnv
            : { ...extraEnv, OMNESIS_GATEWAY_URL: loopbackGatewayUrl },
        platform: supervisor.platform,
        homeDir: homedir(),
        nodeBinDir: stableNodeBinDir(process.execPath),
        ...wiring,
      });
      const afterUnit = collectorAfterUnit({
        platform: supervisor.platform,
        component,
        installingAlongsideGateway: components.includes("gateway"),
        gatewayAlreadyInstalled: supervisor.isInstalled("gateway", instance),
        gatewayUnitName: supervisor.unitName("gateway", instance),
      });
      await supervisor.install(spec, afterUnit !== undefined ? { afterUnit } : {});
      console.log(
        `Installed and started ${c.bold}${supervisor.unitName(component, instance)}${c.reset} ${c.dim}(${supervisor.unitPath(component, instance)})${c.reset}`,
      );
      console.log(`  ${c.dim}exec: ${exec.join(" ")}${c.reset}`);
      const fdaNote = collectorFdaNote(component, supervisor.platform, process.execPath);
      if (fdaNote) {
        console.log(`  ${c.yellow}${fdaNote}${c.reset}`);
        const opened = await openFdaGrant(process.execPath, {
          isTTY: process.stdout.isTTY === true,
          noOpen: ctx.args["no-open"] === true || ctx.args.open === false,
        });
        if (opened) {
          console.log(
            `  ${c.dim}Opened System Settings at Full Disk Access and revealed the executable in Finder — drag it into the list.${c.reset}`,
          );
        }
      }
    }

    const hint = await supervisor.postInstallHint();
    if (hint) console.log(`${c.yellow}${hint}${c.reset}`);
  },
});

// ── uninstall / start / stop / restart ─────────────────────────────────

const LIFECYCLE_PAST_TENSE = {
  uninstall: "Uninstalled",
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
} as const;

type LifecycleVerb = keyof typeof LIFECYCLE_PAST_TENSE;

/**
 * One-release removal shim for machines that still have the retired runner
 * unit installed. The runner is intentionally absent from every other service
 * command and from the advertised component choices.
 */
export async function uninstallLegacyRunnerService(
  opts: {
    platform?: NodeJS.Platform;
    home?: string;
    uid?: number;
    instance?: string;
    exec?: typeof defaultExecRunner;
  } = {},
): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const instance = opts.instance;
  const suffix = instance ? `-${instance}` : "";
  const dottedSuffix = instance ? `.${instance}` : "";
  const exec = opts.exec ?? defaultExecRunner;
  if (platform === "linux") {
    const unit = `omnesis-runner${suffix}.service`;
    const path = join(home, ".config", "systemd", "user", unit);
    const installed = existsSync(path);
    const disabled = await exec("systemctl", ["--user", "disable", "--now", unit]);
    const active = await exec("systemctl", ["--user", "is-active", unit]);
    const state = active.stdout.trim().toLowerCase();
    const verifiedInactive =
      active.code !== 127 &&
      active.code !== 0 &&
      (state === "inactive" || state === "failed" || state === "unknown");
    if (!verifiedInactive) {
      const detail = [disabled.stderr, active.stderr].find((value) => value.trim())?.trim();
      throw new CliError(
        `${c.red}Could not verify that retired runner unit ${unit} is stopped` +
          (detail ? `: ${detail}` : ".") +
          `${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    rmSync(path, { force: true });
    const reloaded = await exec("systemctl", ["--user", "daemon-reload"]);
    if (reloaded.code !== 0) {
      throw new CliError(
        `${c.red}Removed retired runner unit ${unit}, but systemd daemon-reload failed: ` +
          `${reloaded.stderr.trim() || `exit ${reloaded.code}`}${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    return installed;
  }
  if (platform === "darwin") {
    const label = `dev.omnesis.runner${dottedSuffix}`;
    const path = join(home, "Library", "LaunchAgents", `${label}.plist`);
    const installed = existsSync(path);
    const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    const target = `gui/${uid}/${label}`;
    const bootout = await exec("launchctl", ["bootout", target]);
    const active = await exec("launchctl", ["print", target]);
    const verifiedInactive =
      active.code !== 0 &&
      active.code !== 127 &&
      (active.code === 113 ||
        /could not find service|service .* not found/i.test(`${active.stdout}\n${active.stderr}`));
    if (!verifiedInactive) {
      const detail = [bootout.stderr, active.stderr].find((value) => value.trim())?.trim();
      throw new CliError(
        `${c.red}Could not verify that retired runner service ${label} is stopped` +
          (detail ? `: ${detail}` : ".") +
          `${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    rmSync(path, { force: true });
    return installed;
  }
  throw new CliError(
    `${c.red}Legacy runner service cleanup is not supported on ${platform}.${c.reset}`,
    EXIT_USER_ERROR,
  );
}

function lifecycleCommand(verb: LifecycleVerb, description: string) {
  return defineCommand({
    meta: { name: verb, description },
    args: {
      ...componentArg,
      ...commonFlags,
      ...(verb === "uninstall"
        ? {
            hardened: {
              type: "boolean" as const,
              description: "Remove the hardened system-level gateway unit (Linux)",
            },
          }
        : {}),
    },
    async run(ctx) {
      if (verb === "uninstall" && ctx.args.hardened) {
        await runHardenedUninstall(ctx);
        return;
      }
      if (verb === "uninstall" && ctx.args.component === "runner") {
        const installed = await uninstallLegacyRunnerService({
          instance: parseInstanceFlag(ctx.args.instance),
        });
        console.log(
          installed
            ? "Uninstalled retired Omnesis runner service"
            : `${c.dim}No retired Omnesis runner service installed.${c.reset}`,
        );
        return;
      }
      const components = parseComponentSelection(ctx.args.component, [...SERVICE_COMPONENTS]);
      const instance = parseInstanceFlag(ctx.args.instance);
      const supervisor = createSupervisor();
      // Explicit single-component invocations error on a missing unit; the
      // default/`all` sweep just skips components that aren't installed.
      const explicit =
        typeof ctx.args.component === "string" &&
        ctx.args.component !== "" &&
        ctx.args.component !== "all";
      let acted = 0;
      for (const component of components) {
        if (!supervisor.isInstalled(component, instance)) {
          if (explicit) {
            throw new CliError(
              `${c.red}${supervisor.unitName(component, instance)} is not installed.${c.reset}`,
              EXIT_USER_ERROR,
            );
          }
          continue;
        }
        await supervisor[verb](component, instance);
        acted += 1;
        console.log(`${LIFECYCLE_PAST_TENSE[verb]} ${supervisor.unitName(component, instance)}`);
      }
      if (acted === 0) {
        console.log(`${c.dim}No Omnesis services installed — nothing to ${verb}.${c.reset}`);
      }
    },
  });
}

/**
 * The gateway URL a collector's unit should carry, or undefined to leave it to
 * the config `.env`.
 *
 * A collector on the gateway's own machine dials that gateway over loopback.
 * The config `.env` holds the address the install recorded for other machines
 * (OMNESIS_GATEWAY_URL), which may not resolve here — a Linux server without
 * nss-mdns, or macOS denying node local network access — and a value in the
 * unit wins over the `.env` one. The port is the gateway's: `--env`, then the
 * config `.env`, then 7600. An operator's own `--env OMNESIS_GATEWAY_URL` is
 * kept as given. Loopback is only written when the certificate the gateway
 * serves names localhost: a tailnet or operator certificate naming only its
 * own host is reached through the recorded address, which names that host.
 */
export function collectorGatewayUrl(input: {
  component: ServiceComponent;
  installingAlongsideGateway: boolean;
  gatewayAlreadyInstalled: boolean;
  extraEnv: Record<string, string>;
  configEnvContent: string | undefined;
  configDir: string;
  coversLocalhost?: typeof servedCertificateCoversLocalhost;
}): string | undefined {
  if (input.component !== "collector") return undefined;
  if (!input.installingAlongsideGateway && !input.gatewayAlreadyInstalled) return undefined;
  if (input.extraEnv.OMNESIS_GATEWAY_URL !== undefined) return undefined;
  const env = {
    ...(input.configEnvContent === undefined ? {} : parseDotEnv(input.configEnvContent)),
    ...input.extraEnv,
  };
  const coversLocalhost = input.coversLocalhost ?? servedCertificateCoversLocalhost;
  if (!coversLocalhost(input.configDir, env)) return undefined;
  return `https://localhost:${env.OMNESIS_GATEWAY_PORT ?? "7600"}`;
}

/**
 * The unit a collector should be ordered after, or undefined for none.
 *
 * The collector dials the gateway on boot, so when both live on this host
 * the collector unit orders after the gateway's. What decides that is the
 * gateway unit being PRESENT on the host — one installed by an earlier
 * invocation counts exactly as much as one named in the same command.
 * systemd only; launchd has no unit ordering.
 */
export function collectorAfterUnit(input: {
  platform: "darwin" | "linux";
  component: ServiceComponent;
  installingAlongsideGateway: boolean;
  gatewayAlreadyInstalled: boolean;
  gatewayUnitName: string;
}): string | undefined {
  if (input.platform !== "linux" || input.component !== "collector") return undefined;
  if (!input.installingAlongsideGateway && !input.gatewayAlreadyInstalled) return undefined;
  return input.gatewayUnitName;
}

// ── status ─────────────────────────────────────────────────────────────

function colorState(status: ServiceStatus): string {
  switch (status.state) {
    case "running":
      return `${c.green}${status.state}${c.reset}`;
    case "failed":
      return `${c.red}${status.state}${c.reset}`;
    case "not-installed":
      return `${c.gray}${status.state}${c.reset}`;
    default:
      return `${c.yellow}${status.state}${c.reset}`;
  }
}

/**
 * The lines that explain a collector parked because its device was revoked.
 * A supervisor only knows the process stopped; the reason and the recovery
 * live in the state file the collector wrote on its way out, and this is the
 * command an operator runs when a collector "just stopped syncing".
 */
export function needsPairingNotice(
  state: Pick<CollectorPairingState, "state" | "deviceName" | "gatewayUrl" | "repairCommand">,
): string[] {
  if (state.state !== "needs-pairing") return [];
  return [
    `${c.red}collector "${state.deviceName}" is no longer paired with ${state.gatewayUrl}.${c.reset}`,
    `${c.dim}On the gateway host: ${c.reset}${state.repairCommand ?? `omnesis devices repair ${state.deviceName}`}`,
    `${c.dim}Then here: ${c.reset}omnesis pair <code> --gateway-url ${state.gatewayUrl} --save <config-dir>/collector-token`,
    `${c.dim}Then: ${c.reset}omnesis service start collector`,
  ];
}

const serviceStatusCommand = defineCommand({
  meta: { name: "status", description: "Show service state and PIDs" },
  args: {
    ...componentArg,
    ...commonFlags,
    json: { type: "boolean", description: "Machine-readable JSON output" },
  },
  async run(ctx) {
    const components = parseComponentSelection(ctx.args.component, [...SERVICE_COMPONENTS]);
    const instance = parseInstanceFlag(ctx.args.instance);
    const configDir = parseConfigDirFlag(ctx.args["config-dir"]);
    const supervisor = createSupervisor();
    const statuses: ServiceStatus[] = [];
    for (const component of components) {
      statuses.push(await supervisor.status(component, instance));
    }
    // The pairing verdict is the collector's own, so it is reported only when
    // the collector is in scope — and regardless of whether the unit is
    // running, because being parked is exactly the symptom. A named instance
    // was installed against its own config dir, which this command cannot
    // recover, so it is reported only when the operator names one.
    const pairingDir =
      instance !== undefined && typeof ctx.args["config-dir"] !== "string" ? null : configDir;
    const pairing =
      pairingDir && components.includes("collector") ? readCollectorPairingState(pairingDir) : null;
    if (isJSON) {
      console.log(JSON.stringify({ items: statuses, ...(pairing ? { pairing } : {}) }));
      return;
    }
    console.log();
    console.log(
      `${c.bold}${"COMPONENT".padEnd(12)} ${"UNIT".padEnd(40)} ${"STATE".padEnd(14)} PID${c.reset}`,
    );
    for (const s of statuses) {
      const state = colorState(s) + " ".repeat(Math.max(0, 14 - s.state.length));
      console.log(`${s.component.padEnd(12)} ${s.unit.padEnd(40)} ${state} ${s.pid ?? "—"}`);
    }
    console.log();
    const notice = pairing ? needsPairingNotice(pairing) : [];
    if (notice.length > 0) {
      for (const line of notice) console.log(line);
      console.log();
    }
  },
});

// ── logs ───────────────────────────────────────────────────────────────

const serviceLogsCommand = defineCommand({
  meta: { name: "logs", description: "Show service logs (journalctl / log files)" },
  args: {
    ...componentArg,
    ...commonFlags,
    follow: { type: "boolean", alias: "f", description: "Follow log output" },
    lines: { type: "string", alias: "n", description: "Number of lines to show (default: 100)" },
  },
  async run(ctx) {
    const components = parseComponentSelection(ctx.args.component, [...SERVICE_COMPONENTS]);
    const instance = parseInstanceFlag(ctx.args.instance);
    const lines = parseLinesFlag(ctx.args.lines);
    const supervisor = createSupervisor();
    const installed = components.filter((component) => supervisor.isInstalled(component, instance));
    if (installed.length === 0) {
      throw new CliError(
        `${c.red}No matching Omnesis services installed.${c.reset}`,
        EXIT_USER_ERROR,
      );
    }
    // The exit code of the pager (tail/journalctl) is intentionally ignored:
    // Ctrl-C out of --follow is the normal way to leave it.
    await supervisor.logs(installed, instance, { follow: Boolean(ctx.args.follow), lines });
  },
});

// ── group ──────────────────────────────────────────────────────────────

export const serviceCommand = defineCommand({
  meta: {
    name: "service",
    description: "Install and manage Omnesis as a background service (launchd / systemd)",
  },
  subCommands: {
    install: serviceInstallCommand,
    uninstall: lifecycleCommand("uninstall", "Stop and remove service units"),
    start: lifecycleCommand("start", "Start installed services"),
    stop: lifecycleCommand("stop", "Stop running services"),
    restart: lifecycleCommand("restart", "Restart running services"),
    status: serviceStatusCommand,
    logs: serviceLogsCommand,
  },
  // Default to `status` when no subcommand is given.
  async run(ctx) {
    if (ctx.rawArgs.filter((a) => !a.startsWith("-")).length === 0) {
      const { runCommand } = await import("citty");
      await runCommand(serviceStatusCommand, { rawArgs: [] });
    }
  },
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure unit-file generation for `omnesis service`. Everything in this module
 * is deterministic string/path math — no filesystem or process access — so
 * the exact bytes written to LaunchAgents plists and systemd user units are
 * unit-testable.
 */

import { dirname, join } from "node:path";
import {
  PASSPHRASE_CREDENTIAL_NAME,
  PASSPHRASE_FILE_ENV,
  GATEWAY_EXIT_TIMEOUT_SECONDS,
  launchdLabel,
  systemdEscapeArg,
  type SecretStoreBackend,
} from "@omnesis/core";
import type { ServiceComponent, ServiceSpec, SystemdCredential } from "./types.js";

// ── Unit naming ────────────────────────────────────────────────────────

// Unit names and paths are the contract between the writer here and the
// doctor's security collector, which reads the same files back, so they
// live in `@omnesis/core`.
export {
  launchdLabel,
  launchdPlistPath,
  systemdUnitName,
  systemdUnitPath,
  systemdEscapeArg,
} from "@omnesis/core";

/** Directory launchd units write their stdout/stderr log files into. */
export function darwinLogsDir(home: string): string {
  return join(home, "Library", "Logs", "Omnesis");
}

/** Stdout/stderr log file paths for a launchd unit. */
export function launchdLogPaths(
  logsDir: string,
  component: ServiceComponent,
  instance?: string,
): { out: string; err: string } {
  const label = launchdLabel(component, instance);
  return { out: join(logsDir, `${label}.log`), err: join(logsDir, `${label}.err.log`) };
}

// ── Spec construction ──────────────────────────────────────────────────

export interface BuildServiceSpecInput {
  component: ServiceComponent;
  instance?: string;
  configDir: string;
  /** Full command line: absolute executable path followed by its argv. */
  exec: string[];
  /** User-supplied `--env KEY=VAL` extras; override the defaults below. */
  extraEnv: Record<string, string>;
  platform: "darwin" | "linux";
  homeDir: string;
  /** Directory containing the node binary; prepended to the unit's PATH. */
  nodeBinDir: string;
  /** Secret-store backend the daemon reads its keys from (OMNESIS_SECRET_STORE). */
  secretStore?: SecretStoreBackend;
  /**
   * Absolute path to a file holding the keyring passphrase, handed to a systemd
   * daemon via `LoadCredential=omnesis-keyring-passphrase:<path>`. Linux only.
   */
  passphraseCredentialPath?: string;
  /**
   * Path to a file holding the keyring passphrase, exposed to the daemon via
   * `OMNESIS_KEYRING_PASSPHRASE_FILE`. The portable path (launchd has no
   * credential concept), also usable on systemd when a credential isn't wanted.
   */
  passphraseFilePath?: string;
}

/**
 * The keyring passphrase as a systemd credential list, or nothing when no
 * credential path was given. The name is the contract with the keyring
 * backend, which reads `$CREDENTIALS_DIRECTORY/<name>` at runtime — both unit
 * generators go through here so the two ends cannot drift apart.
 */
export function keyringCredentials(
  passphraseCredentialPath?: string,
): SystemdCredential[] | undefined {
  return passphraseCredentialPath
    ? [{ name: PASSPHRASE_CREDENTIAL_NAME, path: passphraseCredentialPath }]
    : undefined;
}

/**
 * Render the `LoadCredential=` lines for a spec.
 *
 * `%` is doubled — unescaped, systemd expands it as a specifier and the unit
 * loads a different file than the operator named. Nothing else is escaped, and
 * deliberately so: unlike `ExecStart=`, this setting splits on the first `:`
 * and takes the rest of the line verbatim, with no unquoting. Quoting a path
 * that contains a space would therefore embed the quote characters in the
 * credential name and path rather than removing them. The two inputs no
 * rendering can survive — a control character, and a trailing backslash, which
 * the unit-file reader treats as a line continuation — are refused where the
 * path is validated instead.
 */
export function loadCredentialLines(credentials: readonly SystemdCredential[] = []): string[] {
  return credentials.map(
    (cred) => `LoadCredential=${`${cred.name}:${cred.path}`.replace(/%/g, "%%")}`,
  );
}

/** First systemd release that understands `LoadCredential=`. */
export const MIN_LOAD_CREDENTIAL_SYSTEMD = 247;

/** Major version from `systemctl --version` output, or null if unrecognised. */
export function parseSystemdVersion(output: string): number | null {
  const major = /^systemd (\d+)/m.exec(output)?.[1];
  return major ? Number.parseInt(major, 10) : null;
}

/**
 * Warning for an install that wires a keyring credential into a systemd too
 * old to read it, or null when there is nothing to say.
 *
 * An unknown directive is not an error to systemd: it logs the line and starts
 * the unit anyway, so the daemon comes up looking healthy and cannot open a
 * single encrypted store. An unparseable version says nothing — this exists to
 * catch a version known to be too old, not to nag about one it cannot read.
 */
export function loadCredentialSupportWarning(versionOutput: string): string | null {
  const version = parseSystemdVersion(versionOutput);
  if (version === null || version >= MIN_LOAD_CREDENTIAL_SYSTEMD) return null;
  return (
    `systemd ${version} ignores LoadCredential=, which needs ${MIN_LOAD_CREDENTIAL_SYSTEMD} or newer: ` +
    "the unit will start without its keyring passphrase and fail to open encrypted stores. " +
    "Use --keyring-passphrase-file <abs-path> on this host instead."
  );
}

/** Baseline PATH baked into every unit; the node bin dir is prepended. */
export const SERVICE_BASE_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
/** Env keys whose (absolute) parent directories become extra write paths. */
export const SYSTEMD_WRITABLE_FILE_ENV_KEYS = [
  "OMNESIS_DB_PATH",
  "OMNESIS_INDEX_DB_PATH",
  "OMNESIS_ANALYTICS_DB_PATH",
  "OMNESIS_LOG_FILE",
] as const;

/**
 * Compose the env + log destination for a unit. Service managers start the
 * daemon with a minimal environment, so the unit bakes in everything the
 * daemon needs: the config dir, a PATH that can find the node binary (the
 * collector spawns node subprocesses), and any user-supplied extras —
 * extras win over the defaults so e.g. `--env PATH=…` is an override.
 */
export function buildServiceSpec(input: BuildServiceSpecInput): ServiceSpec {
  const env: Record<string, string> = {
    OMNESIS_CONFIG_DIR: input.configDir,
    PATH: `${input.nodeBinDir}:${SERVICE_BASE_PATH}`,
  };
  // Keyring wiring goes in BEFORE the user's --env extras, so an explicit
  // `--env OMNESIS_SECRET_STORE=…` still wins over `--secret-store`.
  if (input.secretStore) env.OMNESIS_SECRET_STORE = input.secretStore;
  if (input.passphraseFilePath) env[PASSPHRASE_FILE_ENV] = input.passphraseFilePath;
  Object.assign(env, input.extraEnv);
  // Product-owned provenance for privileged lifecycle actions. The gateway's
  // portal updater must distinguish a generated, unnamed user service from a
  // hand-started process, a named instance, or a hardened system unit before
  // it asks the service manager to launch work outside the gateway sandbox.
  // These are written after operator extras so `--env` cannot forge them.
  env.OMNESIS_SERVICE_MANAGER = input.platform === "linux" ? "systemd-user" : "launchd-user";
  if (input.instance) env.OMNESIS_SERVICE_INSTANCE = input.instance;
  else delete env.OMNESIS_SERVICE_INSTANCE;

  const configDir = env.OMNESIS_CONFIG_DIR || input.configDir;
  const logsDir =
    input.platform === "darwin"
      ? darwinLogsDir(input.homeDir)
      : join(input.homeDir, ".local", "state", "omnesis", "logs");
  const spec: ServiceSpec = {
    component: input.component,
    configDir,
    exec: [...input.exec],
    env,
    logsDir,
  };
  if (input.instance) spec.instance = input.instance;
  const credentials = keyringCredentials(input.passphraseCredentialPath);
  if (credentials) spec.credentials = credentials;
  return spec;
}

// ── launchd plist generation ───────────────────────────────────────────

/** Escape a string for use as XML element text in a plist. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a LaunchAgent plist for the spec.
 *
 * `KeepAlive { SuccessfulExit: false }` restarts the daemon after a crash or
 * any non-zero exit, and leaves it stopped after a clean one — the same
 * contract as the systemd unit's `Restart=on-failure`, so a daemon that stops
 * deliberately (a collector whose device was revoked writes down why and
 * exits 0) stays stopped on both platforms instead of relooping every
 * ThrottleInterval. ThrottleInterval stops a crash-looping daemon from
 * spinning the CPU. ExitTimeOut is how long launchd lets a stopping daemon
 * drain before SIGKILL; it exceeds the gateway's own shutdown budget
 * (`GATEWAY_SHUTDOWN_BUDGET_MS`) so a large index flush or analytics close
 * completes instead of being cut off with the stores half-written.
 */
export function generateLaunchdPlist(spec: ServiceSpec): string {
  const label = launchdLabel(spec.component, spec.instance);
  const { out, err } = launchdLogPaths(spec.logsDir, spec.component, spec.instance);
  const args = spec.exec.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n");
  const envEntries = Object.entries(spec.env)
    .map(([k, v]) => `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ExitTimeOut</key>
    <integer>${GATEWAY_EXIT_TIMEOUT_SECONDS}</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>Umask</key>
    <integer>63</integer>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(out)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(err)}</string>
  </dict>
</plist>
`;
}

// ── systemd unit generation ────────────────────────────────────────────

export interface SystemdUnitOptions {
  /**
   * Unit name this one should start after — set on the collector unit when
   * the gateway unit of the same instance is installed alongside it.
   */
  afterUnit?: string;
}

/** Render one `Environment=` line, quoting the whole assignment if needed. */
export function systemdEnvLine(key: string, value: string): string {
  const assignment = `${key}=${value.replace(/%/g, "%%")}`;
  if (/[\s"'\\]/.test(assignment)) {
    return `Environment="${assignment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `Environment=${assignment}`;
}

/**
 * Every path the unit will name in `ReadWritePaths`. systemd refuses to set up
 * the service's mount namespace when one of them does not exist — the unit dies
 * with 226/NAMESPACE before its command ever runs — so the installer creates
 * exactly this list. Exported so the two cannot drift apart.
 */
export function systemdWritablePaths(spec: ServiceSpec): string[] {
  const paths = new Set<string>([spec.configDir, spec.logsDir]);
  for (const key of SYSTEMD_WRITABLE_FILE_ENV_KEYS) {
    const value = spec.env[key];
    if (value?.startsWith("/")) paths.add(dirname(value));
  }
  return [...paths];
}

/** Render a systemd user unit for the spec. */
export function generateSystemdUnit(spec: ServiceSpec, opts: SystemdUnitOptions = {}): string {
  const description = spec.instance
    ? `Omnesis ${spec.component} (${spec.instance})`
    : `Omnesis ${spec.component}`;
  const lines: string[] = [
    "[Unit]",
    `Description=${description}`,
    "Documentation=https://github.com/omnesis-dev/Omnesis",
    "After=network-online.target",
    "Wants=network-online.target",
  ];
  if (opts.afterUnit) {
    lines.push(`After=${opts.afterUnit}`, `Wants=${opts.afterUnit}`);
  }
  lines.push("", "[Service]", `ExecStart=${spec.exec.map(systemdEscapeArg).join(" ")}`);
  // systemd copies each credential into $CREDENTIALS_DIRECTORY/<name> for the
  // service only; the keyring backend reads the passphrase from there.
  lines.push(...loadCredentialLines(spec.credentials));
  for (const [key, value] of Object.entries(spec.env)) {
    lines.push(systemdEnvLine(key, value));
  }
  lines.push(
    "UMask=0077",
    "Restart=on-failure",
    "RestartSec=2",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    `ReadWritePaths=${systemdWritablePaths(spec).map(systemdEscapeArg).join(" ")}`,
    // AF_NETLINK lets os.networkInterfaces() list the interfaces (glibc's
    // getifaddrs asks the kernel over netlink); without it the call throws and
    // the gateway turns LAN discovery off. Reading interfaces needs no capability.
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
    // NB: no CapabilityBoundingSet= here. Clearing the bounding set needs
    // CAP_SETPCAP, which a `systemd --user` service does not have — it fails
    // the unit with 218/CAPABILITIES on boot. A user service already runs with
    // no privileged capabilities, so the directive is redundant here; the
    // hardened system unit (which runs privileged via DynamicUser) sets it.
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}

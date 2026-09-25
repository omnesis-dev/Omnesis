// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Naming and path contracts for the platform-native service units that
 * supervise the Omnesis daemons — launchd LaunchAgents on macOS, systemd
 * user units on Linux, plus the hardened system-level gateway unit.
 *
 * These are on-disk contracts rather than install machinery: the CLI writes
 * unit files at these paths, and the doctor's security collector reads them
 * back to classify the install's hardening posture. Both sides resolve the
 * paths through here so there is a single definition. Unit *rendering*
 * (plist/unit bodies, ExecStart construction, install/uninstall) lives in
 * the CLI, which is the only thing that writes them.
 */

import { join } from "node:path";

export const SERVICE_COMPONENTS = ["gateway", "collector"] as const;

export type ServiceComponent = (typeof SERVICE_COMPONENTS)[number];

export function isServiceComponent(value: string): value is ServiceComponent {
  return (SERVICE_COMPONENTS as readonly string[]).includes(value);
}

/** launchd label, e.g. `dev.omnesis.gateway` / `dev.omnesis.gateway.staging`. */
export function launchdLabel(component: ServiceComponent, instance?: string): string {
  return instance ? `dev.omnesis.${component}.${instance}` : `dev.omnesis.${component}`;
}

/** Absolute path of the LaunchAgent plist under the user's home. */
export function launchdPlistPath(
  home: string,
  component: ServiceComponent,
  instance?: string,
): string {
  return join(home, "Library", "LaunchAgents", `${launchdLabel(component, instance)}.plist`);
}

/** systemd unit name, e.g. `omnesis-gateway.service` / `omnesis-gateway-staging.service`. */
export function systemdUnitName(component: ServiceComponent, instance?: string): string {
  return instance ? `omnesis-${component}-${instance}.service` : `omnesis-${component}.service`;
}

/** Letters, digits and dashes, starting with a letter or digit: what an instance may be named. */
const SERVICE_INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * Which instance of `component` a launchd label names: `{}` for the default
 * unit, `{ instance }` for a named one, and null when the label belongs to
 * something else.
 */
export function launchdLabelInstance(
  component: ServiceComponent,
  label: string,
): { instance?: string } | null {
  const base = launchdLabel(component);
  if (label === base) return {};
  const instance = label.startsWith(`${base}.`) ? label.slice(base.length + 1) : "";
  return SERVICE_INSTANCE_NAME.test(instance) ? { instance } : null;
}

/**
 * Which instance of `component` a systemd unit name names: `{}` for the
 * default unit, `{ instance }` for a named one, and null when the unit belongs
 * to something else.
 */
export function systemdUnitInstance(
  component: ServiceComponent,
  unit: string,
): { instance?: string } | null {
  if (unit === systemdUnitName(component)) return {};
  const prefix = `omnesis-${component}-`;
  const suffix = ".service";
  if (!unit.startsWith(prefix) || !unit.endsWith(suffix)) return null;
  const instance = unit.slice(prefix.length, -suffix.length);
  return SERVICE_INSTANCE_NAME.test(instance) ? { instance } : null;
}

/** Absolute path of the systemd user unit under the user's home. */
export function systemdUnitPath(
  home: string,
  component: ServiceComponent,
  instance?: string,
): string {
  return join(home, ".config", "systemd", "user", systemdUnitName(component, instance));
}

/**
 * Quote a single ExecStart argument. systemd treats `%` as a specifier
 * escape everywhere in a unit file, so literal percents double; args with
 * whitespace or quote characters get double-quoted with `\`-escaping.
 */
export function systemdEscapeArg(arg: string): string {
  const escaped = arg.replace(/%/g, "%%");
  if (/[\s"'\\]/.test(escaped)) {
    return `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return escaped;
}

/** Unit name of the hardened, system-level gateway service (Linux only). */
export const HARDENED_UNIT_NAME = "omnesis-gateway.service";

/** Absolute path of the hardened system-level gateway unit (Linux only). */
export const HARDENED_UNIT_PATH = `/etc/systemd/system/${HARDENED_UNIT_NAME}`;

/** `StateDirectory=` name; systemd materializes it under /var/lib. */
export const HARDENED_STATE_DIR = "omnesis-gateway";

/**
 * Config directory a hardened gateway runs against. systemd materializes it
 * for a `DynamicUser` at mode 0700, so only root can look inside; a login
 * account tells a hardened install apart by its unit at `HARDENED_UNIT_PATH`
 * instead.
 */
export const HARDENED_CONFIG_DIR = `/var/lib/${HARDENED_STATE_DIR}`;

/**
 * The root-owned command that installs, updates and administers a hardened
 * gateway (`scripts/hardened-gateway.sh`, linked from the running release).
 * Its presence is how a login account tells that the dedicated gateway runs
 * from a release root owns.
 */
export const HARDENED_ADMIN_COMMAND = "omnesis-gateway-admin";

/** Where the install links the admin command. */
export const HARDENED_ADMIN_PATH = `/usr/local/sbin/${HARDENED_ADMIN_COMMAND}`;

/** The published copy of `scripts/hardened-gateway.sh` that root pipes into sh. */
export const HARDENED_BOOTSTRAP_URL = "https://omnesis.dev/hardened-gateway.sh";

/** The repository root fetches a dedicated gateway's releases from by default. */
export const HARDENED_REPO_URL = "https://github.com/omnesis-dev/Omnesis";

/** The root-owned directory holding the dedicated gateway's releases. */
export const HARDENED_RELEASE_ROOT = "/opt/omnesis-gateway";

/** The root-only passphrase file that seals the dedicated gateway's keys. */
export const HARDENED_PASSPHRASE_PATH = "/etc/omnesis-gateway/keyring.pass";

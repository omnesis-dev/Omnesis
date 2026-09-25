// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared types for `omnesis service` — platform-native supervision of the
 * Omnesis daemons (launchd LaunchAgents on macOS, systemd user units on
 * Linux).
 */

// The component set is shared with `@omnesis/core`, whose doctor security
// collector resolves unit paths per component when auditing an install.
export { SERVICE_COMPONENTS, isServiceComponent, type ServiceComponent } from "@omnesis/core";

import type { ServiceComponent } from "@omnesis/core";

/**
 * Subcommand argv appended to the resolved executable for each component.
 */
export const COMPONENT_ARGV: Record<ServiceComponent, readonly string[]> = {
  gateway: ["gateway", "serve"],
  collector: ["collector", "run"],
};

/**
 * A systemd credential: the service manager reads `path` as root at start and
 * exposes a copy to that unit alone, under `$CREDENTIALS_DIRECTORY/<name>`.
 */
export interface SystemdCredential {
  name: string;
  path: string;
}

/** Everything a unit generator needs to render a service definition. */
export interface ServiceSpec {
  component: ServiceComponent;
  /** Named parallel instance — unit names get this suffix. */
  instance?: string;
  /** Config directory baked into the unit as OMNESIS_CONFIG_DIR. */
  configDir: string;
  /** Full command line: absolute executable path followed by its argv. */
  exec: string[];
  /** Environment baked into the unit (OMNESIS_CONFIG_DIR, PATH, extras). */
  env: Record<string, string>;
  /** Directory for stdout/stderr log files (used by the launchd backend; systemd logs to the journal). */
  logsDir: string;
  /**
   * systemd credentials exposed to the daemon via `LoadCredential=<name>:<path>`.
   * Used to hand the keyring passphrase to a headless gateway. Ignored on
   * launchd, which has no credential concept — there the passphrase travels as
   * an env file instead.
   */
  credentials?: SystemdCredential[];
}

export type ServiceState =
  | "running"
  | "starting"
  | "stopped"
  | "failed"
  | "not-installed"
  | "unknown";

export interface ServiceStatus {
  component: ServiceComponent;
  /** Platform unit identifier (launchd label or systemd unit name). */
  unit: string;
  installed: boolean;
  state: ServiceState;
  pid: number | null;
}

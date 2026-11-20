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

/** A launchd job's `ProcessType`: the resource class macOS runs it in. */
type LaunchdProcessType = "Background" | "Standard" | "Adaptive" | "Interactive";

/**
 * The class each component's LaunchAgent runs in.
 *
 * The gateway is `Standard`, the class of an ordinary program: it answers the
 * apps, the portal, search and agents while someone waits, and every write
 * passes through its one writer thread. As a `Background` job it waits behind
 * every program the user runs, and so does every request: its CPU drops to the
 * lowest priority and its disk I/O is throttled while anything else uses the
 * disk. The price is that its own background work, such as embedding a newly
 * synced backlog, competes with the user's programs as an equal.
 *
 * The collector is `Background`. Its work is bulk sync that nobody waits on
 * from moment to moment, so it yields CPU and disk to the user's programs and
 * to the gateway. `Adaptive` would behave the same: launchd raises an Adaptive
 * job only while an XPC client holds it busy, and the collector serves none.
 */
export const LAUNCHD_PROCESS_TYPE: Record<ServiceComponent, LaunchdProcessType> = {
  gateway: "Standard",
  collector: "Background",
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
  "running" | "starting" | "stopped" | "failed" | "not-installed" | "unknown";

export interface ServiceStatus {
  component: ServiceComponent;
  /** Platform unit identifier (launchd label or systemd unit name). */
  unit: string;
  installed: boolean;
  state: ServiceState;
  pid: number | null;
}

/**
 * What the service manager says about a daemon's process right now, read so an
 * update can tell a gateway that is still booting from one that has exited.
 */
export interface ServiceLiveness {
  /** False when no unit is installed, so nothing can be judged. */
  installed: boolean;
  /** The manager has a live process for the unit. */
  running: boolean;
  /**
   * The manager holds no process and is not starting one: the unit failed or
   * is inactive, or is waiting out a restart delay after the process exited.
   */
  down: boolean;
  /**
   * How many times the manager has launched or automatically restarted the
   * unit, counted from an origin the manager chooses; only differences
   * between two readings mean anything. Null where the manager does not say.
   */
  starts: number | null;
  /** The manager's own words for the state, for an error message. */
  detail: string;
}

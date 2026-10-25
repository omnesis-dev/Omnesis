// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared shapes for `omnesis uninstall`: what can be removed, what was found
 * on this machine, and the steps a removal is made of. A plan is data — every
 * step names one action and what it touches — so a dry run, the JSON report
 * and the real run all describe the same thing.
 */

import type { ServiceComponent } from "@omnesis/core";
import type { Harness } from "../harness-skills.js";
import type { Launcher } from "./launcher.js";

/**
 * What an operator can ask to remove, in the order a full removal runs them:
 * the agent integrations first (they only read this machine's Omnesis), then
 * the collector before the gateway it reports to, then the CLI last, because
 * it is the program doing the removing.
 */
export const UNINSTALL_COMPONENTS = [
  "openclaw",
  "hermes",
  "claude-code",
  "codex",
  "collector",
  "gateway",
  "cli",
] as const;

export type UninstallComponent = (typeof UNINSTALL_COMPONENTS)[number];

export function isUninstallComponent(value: string): value is UninstallComponent {
  return (UNINSTALL_COMPONENTS as readonly string[]).includes(value);
}

export const COMPONENT_LABELS: Record<UninstallComponent, string> = {
  openclaw: "OpenClaw integration",
  hermes: "Hermes integration",
  "claude-code": "Claude Code plugin and MCP server",
  codex: "Codex plugin and MCP server",
  collector: "Collector service",
  gateway: "Gateway service",
  cli: "The omnesis command",
};

/** A service unit of this account, found on disk. */
export interface FoundUnit {
  component: ServiceComponent;
  instance?: string;
  unitName: string;
  unitPath: string;
  /** The config directory the unit runs against, when it names one. */
  configDir: string | null;
  /** The unit file's text, to tell what it runs. */
  definition: string;
  /** systemd drop-in directory of the operator's own overrides, when there is one. */
  dropIns?: string;
}

export interface FoundCheckout {
  root: string;
  /** `git config omnesis.install` is `managed`: the installer cloned it. */
  managed: boolean;
  /** Uncommitted or untracked changes that removing it would lose. */
  dirty: boolean;
  /** `.git` is a file: a worktree of another clone, which `git worktree remove` owns. */
  worktree: boolean;
}

export interface FoundPackage {
  prefix: string;
  packageDir: string;
}

export interface FoundHarness {
  harness: Harness;
  home: string;
  /** OpenClaw only: the config file `connect` edited. */
  configPath: string | null;
  /** The harness's own executable, to unregister the plugin through. */
  binary: string | null;
  /** The environment that points `binary` at `home`. */
  env: Record<string, string>;
  /** What of the integration is there, as paths, for the plan to show. */
  artifacts: string[];
  /** The device name the gateway knows this integration by, when recorded. */
  deviceName: string | null;
}

/** One configuration a client tool (Claude Code, Codex) holds for Omnesis. */
export interface ClientEntry {
  kind: "plugin" | "marketplace" | "mcp";
  name: string;
  /** Claude Code scope (user, project, local), when the tool reports one. */
  scope?: string;
  /** The directory a project- or local-scoped entry belongs to. */
  cwd?: string;
}

export interface FoundClient {
  binary: string;
  entries: ClientEntry[];
}

export interface FoundDocker {
  composeFile: string;
  projectDir: string;
}

export interface FoundHardened {
  unitInstalled: boolean;
  adminInstalled: boolean;
  /** `/etc/omnesis-gateway/install.env`, the admin command's receipt. */
  receipt: boolean;
}

export interface FoundProfile {
  path: string;
  blocks: number;
}

/** Everything of Omnesis this machine holds, for the account running the CLI. */
export interface Inventory {
  platform: NodeJS.Platform;
  home: string;
  /** The config directory this uninstall acts on. */
  configDir: string;
  /** The named service instance this uninstall acts on, if any. */
  instance?: string;
  binDir: string;
  /** What else is in `binDir`: a PATH line stays while anything there may need it. */
  binDirOthers: string[];
  /** Launchers an interrupted install or migration left beside the real one. */
  binDirLeftovers: string[];
  launcher: Launcher;
  checkout: FoundCheckout | null;
  packages: FoundPackage[];
  libDir: string | null;
  /** Every Omnesis unit of this account, of any instance. */
  units: FoundUnit[];
  legacyRunner: boolean;
  hardened: FoundHardened | null;
  docker: FoundDocker | null;
  /** The CLI is running inside one of the Docker install's containers. */
  inContainer: boolean;
  harnesses: FoundHarness[];
  clients: Partial<Record<"claude-code" | "codex", FoundClient>>;
  profiles: FoundProfile[];
  /** The target config dir and any other a removed unit runs against, that exist. */
  configDirs: string[];
  /** Other Omnesis config directories of this account, which share its keyring root key. */
  otherConfigDirs: string[];
  logDirs: string[];
  /** The installer trusted a mkcert CA for the gateway's certificate. */
  mkcert: boolean;
  /** Things the discovery could not look at, said plainly. */
  warnings: string[];
}

// ── Steps ──────────────────────────────────────────────────────────────

export type Action =
  | { type: "harness-unregister"; harness: Harness; binary: string; env: Record<string, string> }
  | {
      type: "edit";
      path: string;
      edit: "openclaw-config" | "hermes-config" | "harness-env" | "profile";
      binDir?: string;
    }
  | { type: "remove"; path: string }
  | {
      type: "exec";
      command: string;
      args: string[];
      cwd?: string;
      /** Output that means the thing was already gone. */
      absent?: RegExp;
      /** A failure is not worth reporting (signing out of a server that holds no session). */
      bestEffort?: boolean;
    }
  | { type: "service"; component: ServiceComponent; instance?: string }
  | { type: "legacy-runner"; instance?: string }
  | { type: "privileged"; commands: PrivilegedCommand[] }
  | { type: "docker-down"; composeFile: string }
  | { type: "npm-uninstall"; prefix: string; packageDir: string }
  | { type: "remove-checkout"; root: string; configDir: string }
  | { type: "purge-config"; dir: string }
  | { type: "keyring"; configDirs: string[]; rootKey: boolean };

export interface PrivilegedCommand {
  argv: string[];
  /** A failure means the thing was already gone (`systemctl disable` of a missing unit). */
  tolerateFailure?: boolean;
}

export interface Step {
  component: UninstallComponent | "data";
  title: string;
  action: Action;
  /** Run only once every earlier step of these kinds finished. */
  requires?: Action["type"][];
}

export type StepStatus = "done" | "failed" | "needs-action";

export interface StepResult {
  step: Step;
  status: StepStatus;
  detail?: string;
}

export interface Plan {
  /** The components this run removes, in order. */
  components: UninstallComponent[];
  purge: boolean;
  steps: Step[];
  /** What stays, and why — said so nobody is surprised by a leftover. */
  kept: string[];
  /** What only the operator can do afterwards (another machine, a system dialog). */
  followUps: string[];
}

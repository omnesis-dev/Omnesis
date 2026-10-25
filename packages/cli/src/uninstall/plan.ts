// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Turn what was found and what was asked for into the ordered steps of one
 * removal. Pure: no step runs here, so a dry run, the JSON report and the run
 * itself all work from exactly this plan.
 */

import { dirname, join, resolve } from "node:path";
import { CliError, EXIT_USER_ERROR } from "@omnesis/cli-shared";
import {
  HARDENED_ADMIN_PATH,
  HARDENED_CONFIG_DIR,
  HARDENED_PASSPHRASE_PATH,
  HARDENED_UNIT_NAME,
  HARDENED_UNIT_PATH,
} from "@omnesis/core";
import { skillFilePath } from "../commands/connect.js";
import { INTEGRATION_PLUGIN_ID, LEGACY_PLUGIN_ID } from "./harness-config.js";
import { COMPONENT_LABELS, UNINSTALL_COMPONENTS } from "./types.js";
import type {
  FoundClient,
  FoundHarness,
  Inventory,
  Plan,
  PrivilegedCommand,
  Step,
  UninstallComponent,
} from "./types.js";

export interface UninstallRequest {
  /** Components named on the command line; empty means everything found. */
  components: UninstallComponent[];
  purge: boolean;
  /** Remove an installer checkout even with local changes in it. */
  discardLocalChanges: boolean;
}

/** How each harness is restarted so it lets go of a removed plugin. */
const HARNESS_RESTART: Record<"openclaw" | "hermes", string> = {
  openclaw: "openclaw gateway restart",
  hermes: "hermes gateway restart",
};

/** Everything the hardened gateway keeps on an uninstall, which a purge removes. */
export const HARDENED_DATA_PATHS = [
  HARDENED_CONFIG_DIR,
  "/var/lib/private/omnesis-gateway",
  "/etc/omnesis-gateway",
  "/var/cache/private/omnesis-gateway-build",
] as const;

/** The components this machine has something of. */
export function presentComponents(inv: Inventory): UninstallComponent[] {
  const targetUnits = inv.units.filter((unit) => unit.instance === inv.instance);
  // A named instance is a pair of services and their config directory; the
  // command, the integrations and the clients belong to the machine.
  const machineWide = !inv.instance;
  const has: Record<UninstallComponent, boolean> = {
    openclaw: machineWide && inv.harnesses.some((h) => h.harness === "openclaw"),
    hermes: machineWide && inv.harnesses.some((h) => h.harness === "hermes"),
    "claude-code": machineWide && inv.clients["claude-code"] !== undefined,
    codex: machineWide && inv.clients.codex !== undefined,
    collector:
      targetUnits.some((u) => u.component === "collector") ||
      inv.legacyRunner ||
      (machineWide && !!inv.docker),
    gateway:
      targetUnits.some((u) => u.component === "gateway") ||
      (machineWide && (inv.hardened !== null || !!inv.docker)),
    cli:
      machineWide &&
      (inv.launcher.kind === "source" ||
        inv.launcher.kind === "package" ||
        inv.launcher.kind === "docker" ||
        inv.checkout !== null ||
        inv.packages.length > 0 ||
        inv.libDir !== null ||
        inv.profiles.length > 0 ||
        inv.binDirLeftovers.length > 0),
  };
  return UNINSTALL_COMPONENTS.filter((component) => has[component]);
}

function refuse(message: string): never {
  throw new CliError(message, EXIT_USER_ERROR);
}

/** The commands the Docker install is removed with on its host, for an operator inside a container. */
function dockerHostCommands(inv: Inventory): string {
  const compose = inv.docker?.composeFile ?? join(inv.configDir, "docker-compose.yml");
  return [
    `  docker compose -f ${compose} --profile update down --rmi all --remove-orphans`,
    "  rm -f ~/.local/bin/omnesis",
  ].join("\n");
}

function harnessSteps(found: FoundHarness): Step[] {
  const component = found.harness;
  const steps: Step[] = [];
  if (component === "openclaw" && found.binary) {
    steps.push({
      component,
      title: `Unregister the ${INTEGRATION_PLUGIN_ID} plugin from OpenClaw`,
      action: {
        type: "harness-unregister",
        harness: component,
        binary: found.binary,
        env: found.env,
      },
    });
  }
  if (component === "hermes") {
    for (const id of [INTEGRATION_PLUGIN_ID, LEGACY_PLUGIN_ID]) {
      const plugin = join(found.home, "plugins", id);
      if (found.artifacts.includes(plugin)) {
        steps.push({
          component,
          title: `Remove ${plugin}`,
          action: { type: "remove", path: plugin },
        });
      }
    }
    const config = join(found.home, "config.yaml");
    if (found.artifacts.includes(config)) {
      steps.push({
        component,
        title: `Remove the integration from ${config}`,
        action: { type: "edit", path: config, edit: "hermes-config" },
      });
    }
  }
  if (found.configPath && found.artifacts.includes(found.configPath)) {
    steps.push({
      component,
      title: `Remove the Omnesis skill and plugin entries from ${found.configPath}`,
      action: { type: "edit", path: found.configPath, edit: "openclaw-config" },
    });
  }
  const env = join(found.home, ".env");
  if (found.artifacts.includes(env)) {
    steps.push({
      component,
      title: `Remove the Omnesis settings from ${env}`,
      action: { type: "edit", path: env, edit: "harness-env" },
    });
  }
  const skill = dirname(skillFilePath(component, found.home));
  if (found.artifacts.includes(skill)) {
    steps.push({
      component,
      title: `Remove the skill ${skill}`,
      action: { type: "remove", path: skill },
    });
  }
  for (const path of found.artifacts) {
    if (path.endsWith(".bak-omnesis") || path === join(found.home, "omnesis")) {
      steps.push({ component, title: `Remove ${path}`, action: { type: "remove", path } });
    }
  }
  return steps;
}

function clientSteps(component: "claude-code" | "codex", client: FoundClient): Step[] {
  const steps: Step[] = [];
  const order = { plugin: 0, mcp: 1, marketplace: 2 } as const;
  const entries = [...client.entries].sort((a, b) => order[a.kind] - order[b.kind]);
  const absent =
    /not (?:found|installed|configured)|no (?:such|mcp server|plugin|marketplace)|does not exist|unknown/i;
  for (const entry of entries) {
    const cwd = entry.cwd ? { cwd: entry.cwd } : {};
    if (component === "claude-code") {
      if (entry.kind === "plugin") {
        steps.push({
          component,
          title: `Uninstall the Claude Code plugin ${entry.name} (${entry.scope ?? "user"} scope)`,
          action: {
            type: "exec",
            command: "claude",
            args: ["plugin", "uninstall", entry.name, "--scope", entry.scope ?? "user"],
            absent,
            ...cwd,
          },
        });
      } else if (entry.kind === "mcp") {
        steps.push({
          component,
          title: `Remove the Claude Code MCP server ${entry.name} (${entry.scope ?? "user"} scope)`,
          action: {
            type: "exec",
            command: "claude",
            args: ["mcp", "remove", entry.name, "--scope", entry.scope ?? "user"],
            absent,
            ...cwd,
          },
        });
      } else {
        steps.push({
          component,
          title: `Remove the Claude Code plugin marketplace ${entry.name}`,
          action: {
            type: "exec",
            command: "claude",
            args: ["plugin", "marketplace", "remove", entry.name],
            absent,
          },
        });
      }
      continue;
    }
    if (entry.kind === "plugin") {
      steps.push({
        component,
        title: `Remove the Codex plugin ${entry.name}`,
        action: { type: "exec", command: "codex", args: ["plugin", "remove", entry.name], absent },
      });
    } else if (entry.kind === "mcp") {
      steps.push(
        {
          component,
          title: `Sign Codex out of the MCP server ${entry.name}`,
          action: {
            type: "exec",
            command: "codex",
            args: ["mcp", "logout", entry.name],
            bestEffort: true,
          },
        },
        {
          component,
          title: `Remove the Codex MCP server ${entry.name}`,
          action: { type: "exec", command: "codex", args: ["mcp", "remove", entry.name], absent },
        },
      );
    } else {
      steps.push({
        component,
        title: `Remove the Codex plugin marketplace ${entry.name}`,
        action: {
          type: "exec",
          command: "codex",
          args: ["plugin", "marketplace", "remove", entry.name],
          absent,
        },
      });
    }
  }
  return steps;
}

function hardenedSteps(inv: Inventory, purge: boolean): Step[] {
  const hardened = inv.hardened;
  if (!hardened) return [];
  const commands: PrivilegedCommand[] = hardened.adminInstalled
    ? [{ argv: [HARDENED_ADMIN_PATH, "uninstall"] }]
    : [
        { argv: ["systemctl", "disable", "--now", HARDENED_UNIT_NAME], tolerateFailure: true },
        { argv: ["rm", "-f", HARDENED_UNIT_PATH] },
        { argv: ["systemctl", "daemon-reload"] },
      ];
  const steps: Step[] = [
    {
      component: "gateway",
      title: hardened.adminInstalled
        ? `Remove the dedicated gateway, its service and releases (${HARDENED_ADMIN_PATH} uninstall, as root)`
        : `Remove the dedicated gateway service ${HARDENED_UNIT_PATH} (as root)`,
      action: { type: "privileged", commands },
    },
  ];
  if (purge) {
    steps.push({
      component: "data",
      title: `Delete the dedicated gateway's data and passphrase (${HARDENED_DATA_PATHS.join(", ")}, as root)`,
      action: { type: "privileged", commands: [{ argv: ["rm", "-rf", ...HARDENED_DATA_PATHS] }] },
    });
  }
  return steps;
}

/** Build the removal of `request` from what `inv` found. Throws on a request that cannot be honored. */
export function planUninstall(inv: Inventory, request: UninstallRequest): Plan {
  if (inv.inContainer) {
    refuse(
      "This omnesis runs inside a container of the Docker install, which cannot remove the install it runs in. " +
        "Run `omnesis uninstall` on the host itself — with a current launcher it removes the containers, the images and the launcher. " +
        `With an older launcher, run on the host:\n${dockerHostCommands(inv)}`,
    );
  }
  if (inv.platform !== "linux" && inv.platform !== "darwin") {
    refuse(`omnesis uninstall supports macOS and Linux, not ${inv.platform}.`);
  }

  const present = presentComponents(inv);
  const named = request.components.length > 0;
  let components = named
    ? UNINSTALL_COMPONENTS.filter((c) => request.components.includes(c) && present.includes(c))
    : present;
  const selected = (component: UninstallComponent) => components.includes(component);
  const kept: string[] = [];
  const followUps: string[] = [];

  for (const component of request.components) {
    if (!present.includes(component)) {
      kept.push(`Nothing of the ${COMPONENT_LABELS[component].toLowerCase()} was found here.`);
    }
  }

  // A Docker install is one compose project: its containers share the
  // launcher and the config directory, so it is removed whole or not at all.
  if (inv.docker) {
    const dockerParts = (["gateway", "collector", "cli"] as const).filter((c) =>
      present.includes(c),
    );
    const chosen = dockerParts.filter(selected);
    if (chosen.length > 0 && chosen.length < dockerParts.length) {
      refuse(
        `This host runs Omnesis in Docker (${inv.docker.composeFile}), which is removed as a whole. ` +
          "Name gateway, collector and cli together, or run `omnesis uninstall` with no component.",
      );
    }
  }

  // ── Who still needs the config directory afterwards ──
  const targetUnits = inv.units.filter((unit) => unit.instance === inv.instance);
  const removedUnits = targetUnits.filter((unit) => selected(unit.component));
  const remainingUnits = inv.units.filter((unit) => !removedUnits.includes(unit));

  // The command stays while a service that stays runs it: removing it would
  // leave that service running deleted files, failing at its next start.
  if (selected("cli")) {
    const cliPaths = [
      ...(inv.launcher.kind === "source" ||
      inv.launcher.kind === "package" ||
      inv.launcher.kind === "docker"
        ? [inv.launcher.path]
        : []),
      ...(inv.checkout ? [inv.checkout.root] : []),
      ...inv.packages.flatMap((pkg) => [pkg.prefix, pkg.packageDir]),
    ];
    const dependents = remainingUnits.filter((unit) =>
      cliPaths.some((path) => unit.definition.includes(path)),
    );
    if (dependents.length > 0) {
      const names = dependents.map((unit) => unit.unitName).join(", ");
      if (named) {
        refuse(
          `The omnesis command cannot be removed while ${names} still run it. Remove those services first (omnesis uninstall --instance <name>), or leave out cli.`,
        );
      }
      components = components.filter((c) => c !== "cli");
      kept.push(`The omnesis command stays: ${names} still run it.`);
    }
  }

  const cliRemains = present.includes("cli") && !selected("cli");
  // Whether the user config directories go too. A hardened gateway's data
  // lives under /var/lib and /etc, so its purge stands on its own.
  let purgeUserData = request.purge && inv.configDirs.length > 0;
  if (request.purge) {
    const users = [
      ...targetUnits.filter((unit) => !selected(unit.component)).map((unit) => unit.unitName),
      ...(cliRemains ? ["the omnesis command"] : []),
      ...(inv.docker && !selected("gateway") ? ["the Docker install"] : []),
    ];
    const hardenedPurge = !inv.instance && selected("gateway") && inv.hardened !== null;
    if (users.length > 0 && purgeUserData) {
      if (!hardenedPurge) {
        refuse(
          `--purge deletes ${inv.configDirs.join(", ")}, which ${users.join(", ")} would still use. ` +
            "Remove those too, or leave out --purge.",
        );
      }
      purgeUserData = false;
      kept.push(`${inv.configDirs.join(", ")} stays: ${users.join(", ")} still use it.`);
    }
    for (const unit of remainingUnits) {
      if (purgeUserData && unit.configDir && inv.configDirs.includes(resolve(unit.configDir))) {
        refuse(
          `--purge would delete ${unit.configDir}, which ${unit.unitName} (another instance) still runs against.`,
        );
      }
    }
  }

  const steps: Step[] = [];
  for (const component of components) {
    switch (component) {
      case "openclaw":
      case "hermes": {
        const found = inv.harnesses.find((h) => h.harness === component)!;
        steps.push(...harnessSteps(found));
        if (component === "openclaw" && !found.binary) {
          const copies = found.artifacts.filter((path) => path.includes("node_modules"));
          if (copies.length > 0) {
            kept.push(
              `OpenClaw's own copy of the plugin (${copies.join(", ")}) stays: no openclaw command was found to unregister it. ` +
                `Run \`openclaw plugins uninstall ${INTEGRATION_PLUGIN_ID}\` where OpenClaw is installed.`,
            );
          }
        }
        followUps.push(
          `Restart ${component === "openclaw" ? "OpenClaw" : "Hermes"} so it stops loading the plugin: ${HARNESS_RESTART[component]}`,
        );
        if (!selected("gateway") || !present.includes("gateway")) {
          followUps.push(
            `On the gateway host, remove the integration's device: omnesis devices revoke ${found.deviceName ?? "<device>"} --forget`,
          );
        }
        break;
      }
      case "claude-code":
      case "codex":
        steps.push(...clientSteps(component, inv.clients[component]!));
        break;
      case "collector": {
        if (inv.docker) break;
        for (const unit of removedUnits.filter((u) => u.component === "collector")) {
          steps.push({
            component,
            title: `Stop and remove the collector service ${unit.unitName}`,
            action: {
              type: "service",
              component: "collector",
              ...(unit.instance ? { instance: unit.instance } : {}),
            },
          });
        }
        if (inv.legacyRunner) {
          steps.push({
            component,
            title: "Stop and remove the retired runner service",
            action: { type: "legacy-runner", ...(inv.instance ? { instance: inv.instance } : {}) },
          });
        }
        if (!present.includes("gateway") || !selected("gateway")) {
          followUps.push(
            "On the gateway host, move or detach this collector's sources, then remove its device: omnesis devices revoke <device> --forget",
          );
        }
        if (inv.platform === "darwin") {
          followUps.push(
            "Remove the collector from Full Disk Access in System Settings → Privacy & Security, if you granted it.",
          );
        }
        break;
      }
      case "gateway": {
        if (inv.docker) {
          steps.push({
            component,
            title: `Stop and remove the Docker containers and images of ${inv.docker.composeFile}`,
            action: { type: "docker-down", composeFile: inv.docker.composeFile },
          });
          if (!request.purge) {
            for (const name of ["docker-compose.yml", "install-method"]) {
              steps.push({
                component,
                title: `Remove ${join(inv.docker.projectDir, name)}`,
                action: { type: "remove", path: join(inv.docker.projectDir, name) },
                requires: ["docker-down"],
              });
            }
          }
          break;
        }
        for (const unit of removedUnits.filter((u) => u.component === "gateway")) {
          steps.push({
            component,
            title: `Stop and remove the gateway service ${unit.unitName}`,
            action: {
              type: "service",
              component: "gateway",
              ...(unit.instance ? { instance: unit.instance } : {}),
            },
          });
        }
        if (!inv.instance) {
          steps.push(...hardenedSteps(inv, request.purge));
          if (inv.hardened && !request.purge) {
            kept.push(
              `The dedicated gateway's corpus in ${HARDENED_CONFIG_DIR} and its passphrase ${HARDENED_PASSPHRASE_PATH} stay; --purge deletes them.`,
            );
          }
        }
        const collector = targetUnits.find(
          (u) => u.component === "collector" && !removedUnits.includes(u),
        );
        if (collector) {
          kept.push(
            `${collector.unitName} stays registered; it will keep trying to reach the removed gateway.`,
          );
        }
        break;
      }
      case "cli":
        // After the data: it is the program doing the removing.
        break;
    }
  }

  for (const unit of removedUnits) {
    if (unit.dropIns) {
      kept.push(`${unit.dropIns} stays: your own overrides for ${unit.unitName}.`);
    }
  }

  // ── Data ──
  // Nothing of the data goes unless every service using it was stopped first.
  const dataRequires: Step["requires"] = ["service", "legacy-runner", "docker-down"];
  if (purgeUserData) {
    const configDirs = inv.configDirs;
    // The OS keyring's root key is shared by every config directory of this
    // account; it goes only with the last of them.
    const rootKey =
      remainingUnits.length === 0 && !inv.instance && inv.otherConfigDirs.length === 0;
    if (!rootKey && inv.otherConfigDirs.length > 0) {
      kept.push(
        `The keyring's root key stays: ${inv.otherConfigDirs.join(", ")} still ${inv.otherConfigDirs.length === 1 ? "uses" : "use"} it.`,
      );
    }
    steps.push({
      component: "data",
      title: rootKey
        ? "Delete the Omnesis keys from the OS keyring"
        : "Delete this config directory's entries from the OS keyring",
      action: { type: "keyring", configDirs, rootKey },
      requires: dataRequires,
    });
    for (const dir of configDirs) {
      steps.push({
        component: "data",
        title: `Delete the data, tokens and keys in ${dir}`,
        action: { type: "purge-config", dir },
        requires: dataRequires,
      });
    }
    if (remainingUnits.length === 0) {
      for (const dir of inv.logDirs) {
        steps.push({
          component: "data",
          title: `Delete the service logs in ${dir}`,
          action: { type: "remove", path: dir },
          requires: dataRequires,
        });
      }
    }
    if (inv.mkcert) {
      followUps.push(
        "The mkcert certificate authority the installer trusted stays in your trust stores; `mkcert -uninstall` removes it if nothing else uses it.",
      );
    }
  } else if (
    !request.purge &&
    inv.configDirs.length > 0 &&
    components.some((c) => c === "gateway" || c === "collector" || c === "cli")
  ) {
    const defaultDir = resolve(join(inv.home, ".config", "omnesis"));
    const env = inv.configDir !== defaultDir ? `OMNESIS_CONFIG_DIR=${inv.configDir} ` : "";
    const instance = inv.instance ? ` --instance ${inv.instance}` : "";
    kept.push(
      `Your data stays in ${inv.configDirs.join(", ")}. To delete it and its keys later, run: ${env}npx omnesis uninstall${instance} --purge`,
    );
  }
  // A hardened purge refused nothing above, but its data steps still wait for the service.
  for (const step of steps) {
    if (step.component === "data" && step.action.type === "privileged")
      step.requires = ["privileged"];
  }

  // ── The CLI, last ──
  if (selected("cli")) {
    const cli = cliSteps(inv, request, kept);
    // A Docker launcher is the only way left to reach containers a failed
    // `compose down` left running.
    if (inv.docker) for (const step of cli) step.requires = ["docker-down"];
    steps.push(...cli);
  }

  return { components, purge: request.purge, steps, kept, followUps: [...new Set(followUps)] };
}

function cliSteps(inv: Inventory, request: UninstallRequest, kept: string[]): Step[] {
  const component = "cli" as const;
  const steps: Step[] = [];
  for (const pkg of inv.packages) {
    steps.push({
      component,
      title: `Uninstall the omnesis package from ${pkg.prefix}`,
      action: { type: "npm-uninstall", prefix: pkg.prefix, packageDir: pkg.packageDir },
    });
  }
  const checkout = inv.checkout;
  if (checkout) {
    if (!checkout.managed) {
      kept.push(`${checkout.root} stays: it is not a checkout the installer made.`);
    } else if (checkout.worktree) {
      kept.push(
        `${checkout.root} stays: it is a git worktree; remove it with git worktree remove.`,
      );
    } else if (checkout.dirty && !request.discardLocalChanges) {
      kept.push(
        `${checkout.root} stays: it has local changes. Re-run with --discard-local-changes to remove it anyway.`,
      );
    } else {
      steps.push({
        component,
        title: `Remove the source checkout ${checkout.root}`,
        action: { type: "remove-checkout", root: checkout.root, configDir: inv.configDir },
      });
    }
  }
  if (inv.libDir) {
    steps.push({
      component,
      title: `Remove ${inv.libDir}`,
      action: { type: "remove", path: inv.libDir },
    });
  }
  for (const leftover of inv.binDirLeftovers) {
    steps.push({
      component,
      title: `Remove ${leftover}`,
      action: { type: "remove", path: leftover },
    });
  }
  const launcher = inv.launcher;
  if (launcher.kind === "source" || launcher.kind === "package" || launcher.kind === "docker") {
    steps.push({
      component,
      title: `Remove the launcher ${launcher.path}`,
      action: { type: "remove", path: launcher.path },
    });
  } else if (launcher.kind === "foreign") {
    kept.push(`${launcher.path} stays: ${launcher.reason}.`);
  }
  if (inv.profiles.length > 0) {
    if (inv.binDirOthers.length > 0 || launcher.kind === "foreign") {
      kept.push(
        `The installer's PATH line for ${inv.binDir} stays in ${inv.profiles.map((p) => p.path).join(", ")}: other programs live there.`,
      );
    } else {
      for (const profile of inv.profiles) {
        steps.push({
          component,
          title: `Remove the installer's PATH line from ${profile.path}`,
          action: { type: "edit", path: profile.path, edit: "profile", binDir: inv.binDir },
        });
      }
    }
  }
  return steps;
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `omnesis uninstall [component…]` — remove Omnesis from this machine, all of
 * it or the parts named: the gateway and collector services (user units, the
 * hardened system gateway, or the Docker install), the OpenClaw and Hermes
 * integrations, the Claude Code and Codex plugin and MCP wiring, and the
 * omnesis command itself. Data stays unless `--purge`.
 *
 * Discovery reads the disk rather than how this CLI was started, so the same
 * command works from the installed CLI, from a checkout, or as
 * `npx omnesis uninstall` on a host whose install no longer runs.
 */

import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import {
  acquireUpdateLock,
  UpdateLockBusyError,
  updateLockHolderLabel,
  type UpdateLock,
} from "@omnesis/core";
import { c as colors, CliError, EXIT_CANCELLED, EXIT_FAILURE, EXIT_USER_ERROR } from "../utils.js";
import { defaultUninstallContext, type UninstallContext } from "../uninstall/context.js";
import { executeStep } from "../uninstall/execute.js";
import { discoverInventory } from "../uninstall/inventory.js";
import { planUninstall, presentComponents, type UninstallRequest } from "../uninstall/plan.js";
import {
  COMPONENT_LABELS,
  isUninstallComponent,
  UNINSTALL_COMPONENTS,
  type Inventory,
  type Plan,
  type StepResult,
  type UninstallComponent,
} from "../uninstall/types.js";
import { parseInstanceFlag } from "./service.js";
import type { Harness } from "../harness-skills.js";

export interface UninstallOptions {
  components: UninstallComponent[];
  purge: boolean;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  instance?: string;
  /** A harness home, for a run that names exactly one harness. */
  dir?: string;
  discardLocalChanges: boolean;
  configDir?: string;
}

/** How a run talks to the operator; tests substitute a recorder. */
export interface UninstallIo {
  out(line: string): void;
  /** Ask which of the found components to remove; null when cancelled. */
  choose(present: UninstallComponent[]): Promise<UninstallComponent[] | null>;
  confirm(message: string): Promise<boolean>;
  colors: Record<string, string>;
}

export interface UninstallReport {
  dryRun: boolean;
  components: UninstallComponent[];
  purge: boolean;
  steps: { component: string; title: string; status?: string; detail?: string }[];
  kept: string[];
  followUps: string[];
  warnings: string[];
}

/** Parse the positional components: names, comma lists and `all`. */
export function parseComponents(raw: readonly string[]): UninstallComponent[] {
  const names = raw
    .flatMap((arg) => arg.split(","))
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.includes("all")) return [];
  const unknown = names.filter((name) => !isUninstallComponent(name));
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown component${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
        `Choose from ${UNINSTALL_COMPONENTS.join(", ")}, or all.`,
      EXIT_USER_ERROR,
    );
  }
  return UNINSTALL_COMPONENTS.filter((component) => names.includes(component));
}

const STATUS_MARK: Record<string, string> = { done: "✓", failed: "✗", "needs-action": "!" };

function printPlan(io: UninstallIo, plan: Plan, inv: Inventory): void {
  const { c } = { c: io.colors };
  io.out(
    `${c.bold}Omnesis uninstall${c.reset} — ${plan.purge ? "removing the software and your data" : "removing the software; your data stays"}`,
  );
  let current = "";
  for (const step of plan.steps) {
    if (step.component !== current) {
      current = step.component;
      io.out("");
      io.out(
        `${c.bold}${step.component === "data" ? "Your data" : COMPONENT_LABELS[step.component]}${c.reset}`,
      );
    }
    io.out(`  - ${step.title}`);
  }
  printNotes(io, "Stays", plan.kept);
  printNotes(io, "Warnings", inv.warnings);
}

function printNotes(io: UninstallIo, heading: string, notes: readonly string[]): void {
  if (notes.length === 0) return;
  io.out("");
  io.out(`${io.colors.bold}${heading}${io.colors.reset}`);
  for (const note of notes) io.out(`  ${note}`);
}

function report(
  plan: Plan,
  inv: Inventory,
  dryRun: boolean,
  results?: StepResult[],
): UninstallReport {
  return {
    dryRun,
    components: plan.components,
    purge: plan.purge,
    steps: plan.steps.map((step, index) => {
      const result = results?.[index];
      return {
        component: step.component,
        title: step.title,
        ...(result ? { status: result.status } : {}),
        ...(result?.detail ? { detail: result.detail } : {}),
      };
    }),
    kept: plan.kept,
    followUps: plan.followUps,
    warnings: inv.warnings,
  };
}

function takeUpdateLock(configDir: string): UpdateLock | null {
  if (!existsSync(configDir)) return null;
  try {
    return acquireUpdateLock(configDir, {
      owner: "omnesis uninstall",
      currentStep: "uninstalling",
    });
  } catch (err) {
    if (err instanceof UpdateLockBusyError) {
      throw new CliError(
        `${err.holder ? updateLockHolderLabel(err.holder) : "An Omnesis update"} is running on this host. ` +
          "Let it finish, then run omnesis uninstall again.",
        EXIT_USER_ERROR,
      );
    }
    throw err;
  }
}

/** Discover, plan, confirm and carry out one uninstall. Returns the process exit code. */
export async function runUninstall(
  options: UninstallOptions,
  ctx: UninstallContext,
  io: UninstallIo,
): Promise<number> {
  const harnesses = options.components.filter(
    (c): c is Harness => c === "openclaw" || c === "hermes",
  );
  if (options.dir && harnesses.length !== 1) {
    throw new CliError(
      "--dir names one harness home: name exactly one of openclaw or hermes with it.",
      EXIT_USER_ERROR,
    );
  }
  const probeClients =
    options.components.length === 0 ||
    options.components.includes("claude-code") ||
    options.components.includes("codex");
  const inventory = await discoverInventory(ctx, {
    ...(options.configDir ? { configDir: options.configDir } : {}),
    ...(options.instance ? { instance: options.instance } : {}),
    ...(options.dir ? { harnessDirs: { [harnesses[0]!]: options.dir } } : {}),
    probeClients,
  });

  let request: UninstallRequest = {
    components: options.components,
    purge: options.purge,
    discardLocalChanges: options.discardLocalChanges,
  };
  let plan = planUninstall(inventory, request);
  const { c } = { c: io.colors };

  if (plan.steps.length === 0) {
    if (options.json) io.out(JSON.stringify(report(plan, inventory, options.dryRun), null, 2));
    else {
      io.out("Nothing of Omnesis to remove on this machine.");
      printNotes(io, "Stays", plan.kept);
      printNotes(io, "Warnings", inventory.warnings);
    }
    return 0;
  }

  if (options.dryRun) {
    if (options.json) io.out(JSON.stringify(report(plan, inventory, true), null, 2));
    else {
      printPlan(io, plan, inventory);
      printNotes(io, "Afterwards", plan.followUps);
      io.out("");
      io.out(`${c.dim}Dry run: nothing was changed.${c.reset}`);
    }
    return 0;
  }

  if (!options.yes) {
    if (options.json || !ctx.interactive) {
      throw new CliError(
        "Refusing to uninstall without confirmation. Re-run with --yes, or --dry-run to see the plan.",
        EXIT_USER_ERROR,
      );
    }
    const present = presentComponents(inventory);
    if (options.components.length === 0 && present.length > 1) {
      const chosen = await io.choose(present);
      if (!chosen || chosen.length === 0) throw new CliError("Cancelled.", EXIT_CANCELLED);
      if (chosen.length !== present.length) {
        request = { ...request, components: chosen };
        plan = planUninstall(inventory, request);
      }
    }
    printPlan(io, plan, inventory);
    io.out("");
    if (
      !(await io.confirm(
        plan.purge ? "Remove these and delete your data for good?" : "Remove these?",
      ))
    ) {
      throw new CliError("Cancelled.", EXIT_CANCELLED);
    }
  }

  let lock = takeUpdateLock(inventory.configDir);
  const results: StepResult[] = [];
  try {
    for (const step of plan.steps) {
      // The lock lives in the config directory a purge is about to delete.
      if (lock && step.action.type === "purge-config") {
        lock.release();
        lock = null;
      }
      const blocker = step.requires
        ? results.find((r) => r.status !== "done" && step.requires!.includes(r.step.action.type))
        : undefined;
      const result: StepResult = blocker
        ? {
            step,
            status: "needs-action",
            detail: `not attempted: "${blocker.step.title}" did not finish`,
          }
        : await executeStep(ctx, step);
      results.push(result);
      if (!options.json) {
        const color =
          result.status === "done" ? c.green : result.status === "failed" ? c.red : c.yellow;
        io.out(
          `${color}${STATUS_MARK[result.status]}${c.reset} ${step.title}${result.detail ? `${c.dim} — ${result.detail}${c.reset}` : ""}`,
        );
      }
    }
  } finally {
    lock?.release();
  }

  const unfinished = results.filter((result) => result.status !== "done");
  if (options.json) {
    io.out(JSON.stringify(report(plan, inventory, false, results), null, 2));
  } else {
    // An interactive run showed these with the plan it confirmed.
    if (options.yes) printNotes(io, "Stays", plan.kept);
    printNotes(io, "Afterwards", plan.followUps);
    if (options.yes) printNotes(io, "Warnings", inventory.warnings);
    io.out("");
    io.out(
      unfinished.length === 0
        ? `${c.green}Omnesis ${plan.components.map((cmp) => cmp).join(", ")} removed.${c.reset}`
        : `${c.yellow}${unfinished.length} step${unfinished.length === 1 ? "" : "s"} did not finish; see above. Re-running omnesis uninstall picks up where this left off.${c.reset}`,
    );
  }
  return unfinished.length === 0 ? 0 : EXIT_FAILURE;
}

function terminalIo(): UninstallIo {
  return {
    out: (line) => console.log(line),
    colors,
    async choose(present) {
      const prompts = await import("@clack/prompts");
      const answer = await prompts.multiselect({
        message: "What should be removed?",
        options: present.map((component) => ({
          value: component,
          label: COMPONENT_LABELS[component],
        })),
        initialValues: present,
        required: false,
      });
      return prompts.isCancel(answer) ? null : (answer as UninstallComponent[]);
    },
    async confirm(message) {
      const prompts = await import("@clack/prompts");
      const answer = await prompts.confirm({ message, initialValue: false });
      return !prompts.isCancel(answer) && answer === true;
    },
  };
}

export const uninstallCommand = defineCommand({
  meta: {
    name: "uninstall",
    description:
      "Remove Omnesis from this machine: services, agent integrations and the CLI (data stays unless --purge)",
  },
  args: {
    component: {
      type: "positional",
      required: false,
      description: `What to remove: ${UNINSTALL_COMPONENTS.join(", ")}, or all (default: everything found)`,
    },
    purge: {
      type: "boolean",
      description:
        "Also delete the data, tokens and keys (the config directory and the OS keyring entries)",
    },
    yes: { type: "boolean", alias: "y", description: "Skip the confirmation prompt" },
    "dry-run": { type: "boolean", description: "Show what would be removed and change nothing" },
    json: { type: "boolean", description: "Machine-readable JSON output" },
    instance: {
      type: "string",
      description: "Remove a named parallel service instance instead of the default one",
    },
    dir: {
      type: "string",
      description: "The harness home, with exactly one of openclaw or hermes",
    },
    "discard-local-changes": {
      type: "boolean",
      description: "Remove the installer's source checkout even when it has local changes",
    },
  },
  async run(ctx) {
    const positionals = (ctx.args._ as string[]).filter((arg) => !arg.startsWith("-"));
    const options: UninstallOptions = {
      components: parseComponents(positionals),
      purge: ctx.args.purge === true,
      yes: ctx.args.yes === true,
      dryRun: ctx.args["dry-run"] === true,
      json: ctx.args.json === true,
      discardLocalChanges: ctx.args["discard-local-changes"] === true,
      ...(parseInstanceFlag(ctx.args.instance)
        ? { instance: parseInstanceFlag(ctx.args.instance)! }
        : {}),
      ...(typeof ctx.args.dir === "string" && ctx.args.dir ? { dir: ctx.args.dir } : {}),
      ...(process.env.OMNESIS_CONFIG_DIR ? { configDir: process.env.OMNESIS_CONFIG_DIR } : {}),
    };
    // Load the prompt library before anything is removed: the CLI may be
    // deleting the very files it would import it from.
    const io = terminalIo();
    if (!options.yes && !options.dryRun) await import("@clack/prompts");
    const code = await runUninstall(options, defaultUninstallContext(), io);
    if (code !== 0) throw new CliError("", code);
  },
});

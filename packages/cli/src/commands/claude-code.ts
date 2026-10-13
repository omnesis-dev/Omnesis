// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import { c, gatewayJson, isJSON, withSpinner, CliError, EXIT_USER_ERROR } from "../utils.js";
import type { ClaudeCodeBackendStatus, ModelsOverview } from "@omnesis/core";

/** Where an operator installs Claude Code; Omnesis never installs it. */
export const CLAUDE_CODE_INSTALL_URL = "https://claude.com/claude-code";

type GatewayRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

async function getClaudeCodeStatus(): Promise<ClaudeCodeBackendStatus | undefined> {
  const overview = await gatewayJson<ModelsOverview>("/admin/models");
  return overview.inference.claudeCode;
}

async function refreshClaudeCodeStatus(): Promise<ClaudeCodeBackendStatus> {
  return gatewayJson<ClaudeCodeBackendStatus>("/admin/inference/claude-code/refresh", {
    method: "POST",
  });
}

/**
 * The one action the operator has to take on the gateway host before the
 * backend can serve, or `undefined` when nothing is needed from them. Omnesis
 * never installs Claude Code or signs it in, so each step names the operator's
 * own command.
 */
export function claudeCodeNextStep(status: ClaudeCodeBackendStatus): string | undefined {
  if (!status.installed) {
    return `Install Claude Code on the gateway host: ${CLAUDE_CODE_INSTALL_URL}`;
  }
  if (status.runtime && !status.runtime.supported) {
    return "Update Claude Code on the gateway host: claude update";
  }
  if (!status.loggedIn) return "On the gateway host, run: claude auth login";
  if (status.status === "ok" && status.models.length > 0) return undefined;
  return "Run `omnesis claude-code refresh` once the problem above is resolved.";
}

function printStatus(status: ClaudeCodeBackendStatus | undefined): void {
  if (isJSON) {
    console.log(JSON.stringify(status ?? null, null, 2));
    return;
  }
  if (!status) {
    console.log("The Claude Code backend is not available on this gateway.");
    return;
  }

  const statusColor =
    status.status === "ok" ? c.green : status.status === "probing" ? c.yellow : c.red;
  const yesNo = (value: boolean): string =>
    value ? `${c.green}yes${c.reset}` : `${c.red}no${c.reset}`;
  console.log();
  console.log(`${c.bold}Claude Code${c.reset}`);
  console.log(`  Status:      ${statusColor}${status.status}${c.reset}`);
  console.log(`  Installed:   ${yesNo(status.installed)}`);
  console.log(`  Signed in:   ${yesNo(status.loggedIn)}`);
  if (status.account?.subscriptionType) {
    console.log(`  Plan:        ${status.account.subscriptionType}`);
  }
  if (status.account?.authMethod) console.log(`  Sign-in:     ${status.account.authMethod}`);
  if (status.runtime) {
    console.log(`  Command:     ${status.runtime.command || "unknown"}`);
    console.log(
      `  CLI version: ${status.runtime.version ?? "unknown"}${status.runtime.supported ? "" : ` (${c.red}unsupported${c.reset})`}`,
    );
    if (status.runtime.reason) console.log(`  Runtime:     ${status.runtime.reason}`);
  }
  if (status.reason) console.log(`  Reason:      ${status.reason}`);
  if (status.refreshedAt) console.log(`  Refreshed:   ${status.refreshedAt}`);
  if (status.modelDetails?.length) {
    console.log();
    console.log(`${c.bold}Models${c.reset}`);
    for (const model of status.modelDetails) {
      const label = model.name && model.name !== model.id ? ` — ${model.name}` : "";
      const resolved =
        model.resolvedModel && model.resolvedModel !== model.id
          ? ` ${c.dim}(${model.resolvedModel})${c.reset}`
          : "";
      console.log(`  ${model.id}${label}${resolved}`);
    }
  } else if (status.models.length) {
    console.log(`  Models:      ${status.models.join(", ")}`);
  }
  const next = claudeCodeNextStep(status);
  if (next) {
    console.log();
    console.log(`  Next:        ${c.cyan}${next}${c.reset}`);
  }
  console.log();
}

/** Enable remote inference and assign a Claude Code model to Agent when it is unassigned. */
export function runClaudeCodeAgentSetup(
  model: string,
  request: GatewayRequest,
): Promise<{ assignment: string }> {
  return request<{ assignment: string }>("/admin/inference/claude-code/agent", {
    method: "POST",
    body: JSON.stringify({ model }),
  });
}

/** Unassign every Claude Code role. The CLI's own login is left untouched. */
export function runClaudeCodeRemove(
  request: GatewayRequest,
): Promise<{ clearedAssignments?: string[] }> {
  return request<{ clearedAssignments?: string[] }>("/admin/inference/claude-code", {
    method: "DELETE",
  });
}

const statusCommand = defineCommand({
  meta: { name: "status", description: "Show Claude Code install, sign-in, and model status" },
  async run() {
    printStatus(await withSpinner("Loading Claude Code status", () => getClaudeCodeStatus()));
  },
});

const refreshCommand = defineCommand({
  meta: { name: "refresh", description: "Re-check the Claude Code CLI, sign-in, and models" },
  async run() {
    printStatus(
      await withSpinner("Refreshing Claude Code status", () => refreshClaudeCodeStatus()),
    );
  },
});

const setupAgentCommand = defineCommand({
  meta: {
    name: "setup-agent",
    description: "Enable remote inference and assign a Claude Code model if Agent is unassigned",
  },
  args: {
    model: {
      type: "positional",
      description: "Model from `omnesis claude-code status` (e.g. sonnet, opus)",
      required: true,
    },
  },
  async run(ctx) {
    const model = ctx.args.model;
    if (!model) {
      throw new CliError("Usage: omnesis claude-code setup-agent <model>", EXIT_USER_ERROR);
    }
    const result = await runClaudeCodeAgentSetup(model, gatewayJson);
    if (isJSON) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`${c.green}✔${c.reset} Assigned agent = ${result.assignment}`);
  },
});

const removeCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Clear every Claude Code assignment (Claude Code stays signed in)",
  },
  async run() {
    const result = await runClaudeCodeRemove(gatewayJson);
    if (isJSON) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const cleared = result.clearedAssignments ?? [];
    console.log(
      cleared.length
        ? `${c.green}✔${c.reset} Cleared assignments: ${cleared.join(", ")}`
        : `${c.green}✔${c.reset} No roles were assigned to Claude Code.`,
    );
    console.log(
      `${c.dim}Claude Code itself stays signed in; run \`claude auth logout\` on the gateway host to sign it out.${c.reset}`,
    );
  },
});

export const claudeCodeCommand = defineCommand({
  meta: {
    name: "claude-code",
    description: "Manage the Claude Code agent backend (Claude subscription)",
  },
  subCommands: {
    status: statusCommand,
    refresh: refreshCommand,
    "setup-agent": setupAgentCommand,
    remove: removeCommand,
  },
});

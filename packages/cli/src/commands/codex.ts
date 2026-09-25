// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { defineCommand } from "citty";
import {
  c,
  gatewayFetch,
  gatewayJson,
  isJSON,
  withSpinner,
  CliError,
  EXIT_CANCELLED,
  EXIT_FAILURE,
  EXIT_USER_ERROR,
  pickGatewayExitCode,
} from "../utils.js";
import type {
  CodexBackendStatus,
  CodexLoginFlow,
  CodexRuntimeUpdateOperation,
  CodexRuntimeUpdateSnapshot,
  ModelsOverview,
} from "@omnesis/core";

interface OverviewResponse extends ModelsOverview {
  activeDownloads: unknown[];
}

async function getCodexStatus(): Promise<CodexBackendStatus | undefined> {
  const overview = await gatewayJson<OverviewResponse>("/admin/models");
  return overview.inference.codex;
}

async function refreshCodexStatus(): Promise<CodexBackendStatus> {
  return gatewayJson<CodexBackendStatus>("/admin/inference/codex/refresh", { method: "POST" });
}

function printStatus(status: CodexBackendStatus | undefined): void {
  if (isJSON) {
    console.log(JSON.stringify(status ?? null, null, 2));
    return;
  }
  if (!status) {
    console.log("Codex backend is not available on this gateway.");
    return;
  }

  const statusColor =
    status.status === "ok" ? c.green : status.status === "probing" ? c.yellow : c.red;
  console.log();
  console.log(`${c.bold}Codex${c.reset}`);
  console.log(`  Status:     ${statusColor}${status.status}${c.reset}`);
  console.log(
    `  Logged in:   ${status.loggedIn ? `${c.green}yes${c.reset}` : `${c.red}no${c.reset}`}`,
  );
  console.log(`  Configured:  ${status.configured ? "yes" : "no"}`);
  if (status.runtime) {
    const source =
      status.runtime.source === "managed"
        ? `managed ${status.runtime.packageName ?? "@openai/codex"}@${status.runtime.packageVersion ?? "unknown"}`
        : "override";
    console.log(`  Runtime:     ${source}`);
    console.log(`  Command:     ${status.runtime.command || "unknown"}`);
    console.log(
      `  CLI version: ${status.runtime.version ?? "unknown"}${status.runtime.supported ? "" : ` (${c.red}unsupported${c.reset})`}`,
    );
  }
  if (status.discovery) console.log(`  Discovery:   ${status.discovery}`);
  if (status.reason) console.log(`  Reason:      ${status.reason}`);
  if (status.refreshedAt) console.log(`  Refreshed:   ${status.refreshedAt}`);
  if (status.modelDetails?.length) {
    console.log();
    console.log(`${c.bold}Models${c.reset}`);
    for (const model of status.modelDetails) {
      const marker = model.recommended ? `${c.green}★${c.reset} ` : "  ";
      console.log(
        `  ${marker}${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}`,
      );
    }
  } else if (status.models.length) {
    console.log(`  Models:      ${status.models.join(", ")}`);
  }
  console.log();
}

function printLoginFlow(flow: CodexLoginFlow, waiting = false): void {
  if (isJSON) {
    console.log(JSON.stringify(flow, null, 2));
    return;
  }
  if (flow.status !== "pending") {
    console.log(`Codex login ${flow.status}${flow.reason ? `: ${flow.reason}` : ""}`);
    return;
  }
  if (!flow.verificationUri || !flow.userCode) {
    console.log(
      "Codex login started, but no device code is available yet. Run `omnesis codex login` again in a moment.",
    );
    return;
  }
  console.log();
  console.log(`${c.bold}Codex Login${c.reset}`);
  console.log(
    `  1. Open this link to log in to OpenAI: ${c.cyan}${flow.verificationUri}${c.reset}`,
  );
  console.log(`  2. Paste this code on the OpenAI page: ${c.bold}${flow.userCode}${c.reset}`);
  console.log(
    waiting
      ? "  3. Return here after the browser confirms login; this command will verify it."
      : "  3. Return here and run `omnesis codex status` after the browser confirms login.",
  );
  if (flow.expiresAt) console.log(`  Expires: ${flow.expiresAt}`);
  console.log();
}

const CODEX_UPDATE_PATH = "/admin/inference/codex/runtime/update";
const CODEX_LOGIN_PATH = "/admin/inference/codex/login";
const CODEX_LOGIN_POLL_MS = 1_000;
const CODEX_LOGIN_FALLBACK_TTL_MS = 15 * 60_000;
const CODEX_LOGIN_EXPIRY_GRACE_MS = 5_000;
const CODEX_LOGIN_MAX_CONSECUTIVE_POLL_ERRORS = 5;
const TERMINAL_UPDATE_STATES = new Set<CodexRuntimeUpdateOperation["state"]>([
  "complete",
  "failed",
  "rolled-back",
  "canceled",
]);

export interface CodexUpdateFlowDeps {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  confirm(message: string): Promise<void>;
  wait(ms: number): Promise<void>;
  write(
    snapshot: CodexRuntimeUpdateSnapshot,
    mode: "check" | "dry-run" | "progress" | "result",
  ): void;
}

export interface CodexLoginWaitDeps {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  wait(ms: number): Promise<void>;
  now(): number;
}

function usableCodexStatus(status: CodexBackendStatus): boolean {
  return status.status === "ok" && status.loggedIn && status.models.length > 0;
}

/** Wait for one exact gateway-owned device flow, then prove the resulting
 * login by refreshing its live model catalog. A gateway restart can erase the
 * in-memory flow after credentials were written, so a missing flow gets the
 * same authoritative refresh before it is treated as a failure. */
export async function waitForCodexLogin(
  initial: CodexLoginFlow,
  deps: CodexLoginWaitDeps,
): Promise<CodexBackendStatus> {
  const parsedExpiry = initial.expiresAt ? Date.parse(initial.expiresAt) : Number.NaN;
  const deadline =
    (Number.isFinite(parsedExpiry) ? parsedExpiry : deps.now() + CODEX_LOGIN_FALLBACK_TTL_MS) +
    CODEX_LOGIN_EXPIRY_GRACE_MS;
  let flow = initial;
  let consecutivePollErrors = 0;

  while (true) {
    if (flow.id !== initial.id) {
      throw new CliError(
        "The active Codex login changed while this command was waiting. Check `omnesis codex status` before retrying.",
        EXIT_FAILURE,
      );
    }
    if (flow.status === "complete") {
      const status = await deps.request<CodexBackendStatus>("/admin/inference/codex/refresh", {
        method: "POST",
      });
      if (usableCodexStatus(status)) return status;
      throw new CliError(
        status.reason ?? "Codex login completed, but its model catalog is not ready.",
        EXIT_FAILURE,
      );
    }
    if (flow.status === "failed") {
      throw new CliError(flow.reason ?? "Codex login failed.", EXIT_FAILURE);
    }
    if (flow.status === "canceled") {
      throw new CliError(flow.reason ?? "Codex login was canceled.", EXIT_CANCELLED);
    }
    if (deps.now() >= deadline) {
      throw new CliError("Codex login expired before it completed.", EXIT_FAILURE);
    }

    await deps.wait(Math.min(CODEX_LOGIN_POLL_MS, Math.max(0, deadline - deps.now())));
    try {
      const response = await deps.request<{ flow: CodexLoginFlow | null }>(CODEX_LOGIN_PATH);
      if (response.flow === null) {
        const status = await deps.request<CodexBackendStatus>("/admin/inference/codex/refresh", {
          method: "POST",
        });
        if (usableCodexStatus(status)) return status;
        throw new CliError(
          status.reason ?? "The gateway lost the active Codex login before it completed.",
          EXIT_FAILURE,
        );
      }
      flow = response.flow;
      consecutivePollErrors = 0;
    } catch (error) {
      // The gateway can be briefly unreachable while the browser flow is in
      // progress. Authentication and other HTTP errors are authoritative;
      // transport failures get a short retry window inside the flow deadline.
      if (error instanceof CliError) throw error;
      consecutivePollErrors += 1;
      if (consecutivePollErrors >= CODEX_LOGIN_MAX_CONSECUTIVE_POLL_ERRORS) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(
          `Lost contact with the gateway during Codex login: ${detail}`,
          EXIT_FAILURE,
        );
      }
      continue;
    }
  }
}

function printRuntimeUpdate(
  snapshot: CodexRuntimeUpdateSnapshot,
  mode: "check" | "dry-run" | "progress" | "result",
): void {
  if (mode === "progress" && isJSON) return;
  if (isJSON) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const { plan, operation } = snapshot;
  if (mode === "progress") {
    if (operation) {
      const draining =
        operation.state === "waiting-for-turns" && operation.activeTurns > 0
          ? ` (${operation.activeTurns} active turn${operation.activeTurns === 1 ? "" : "s"})`
          : "";
      console.log(`Codex runtime: ${operation.state}${draining}`);
    }
    return;
  }
  console.log();
  console.log(`${c.bold}Codex runtime${c.reset}`);
  console.log(`  State:       ${plan.state}`);
  console.log(`  Installed:   ${plan.currentVersion ?? "unknown"}`);
  console.log(`  Compatible:  ${plan.targetVersion ?? "not available"}`);
  if (plan.reason) console.log(`  Reason:      ${plan.reason}`);
  if (mode === "dry-run") {
    console.log(`  Action:      ${plan.action}`);
    console.log("  Preserves:   ChatGPT login and model assignments");
    console.log("  Restart:     gateway restart not required");
    console.log(`${c.dim}Dry run — nothing changed.${c.reset}`);
  }
  if (operation) {
    const color =
      operation.state === "complete"
        ? c.green
        : TERMINAL_UPDATE_STATES.has(operation.state)
          ? c.red
          : c.yellow;
    console.log(`  Operation:   ${color}${operation.state}${c.reset}`);
    if (operation.reason) console.log(`  Detail:      ${operation.reason}`);
    if (operation.newModels?.length) {
      console.log(`  New models:  ${operation.newModels.join(", ")}`);
    }
  } else if (mode === "check" && plan.canUpdate) {
    console.log(`  Next:        run ${c.cyan}omnesis codex update${c.reset}`);
  }
  console.log();
}

async function confirmRuntimeUpdate(message: string): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new CliError("Not a TTY — pass --yes to update without confirmation.", EXIT_USER_ERROR);
  }
  const prompts = await import("@clack/prompts");
  const confirmed = await prompts.confirm({ message });
  if (prompts.isCancel(confirmed) || !confirmed) {
    prompts.cancel("Cancelled.");
    throw new CliError("", EXIT_CANCELLED);
  }
}

/** Gateway-only update flow. The CLI never inspects or changes its own Codex installation. */
export async function runCodexUpdate(
  opts: { check: boolean; dryRun: boolean; yes: boolean },
  deps: CodexUpdateFlowDeps,
): Promise<void> {
  if (opts.check && opts.dryRun) {
    throw new CliError("--check and --dry-run cannot be used together.", EXIT_USER_ERROR);
  }

  if (opts.check) {
    deps.write(await deps.request<CodexRuntimeUpdateSnapshot>(CODEX_UPDATE_PATH), "check");
    return;
  }

  if (opts.dryRun) {
    const snapshot = await deps.request<CodexRuntimeUpdateSnapshot>(CODEX_UPDATE_PATH, {
      method: "POST",
      body: JSON.stringify({ dryRun: true }),
    });
    deps.write(snapshot, "dry-run");
    return;
  }

  const planned = await deps.request<CodexRuntimeUpdateSnapshot>(CODEX_UPDATE_PATH);
  if (!planned.plan.canUpdate) {
    deps.write(planned, "check");
    return;
  }
  if (!opts.yes) {
    const current = planned.plan.currentVersion ?? "the current runtime";
    const target = planned.plan.targetVersion ?? "the compatible runtime";
    const verb = planned.plan.action === "repair" ? "Repair" : "Update";
    await deps.confirm(`${verb} the gateway's Codex runtime ${current} → ${target}?`);
  }

  let snapshot = await deps.request<CodexRuntimeUpdateSnapshot>(CODEX_UPDATE_PATH, {
    method: "POST",
    body: JSON.stringify({}),
  });
  let lastProgressState: string | undefined;
  while (snapshot.operation && !TERMINAL_UPDATE_STATES.has(snapshot.operation.state)) {
    const progressState = `${snapshot.operation.state}:${snapshot.operation.activeTurns}`;
    if (progressState !== lastProgressState) {
      deps.write(snapshot, "progress");
      lastProgressState = progressState;
    }
    await deps.wait(500);
    snapshot = await deps.request<CodexRuntimeUpdateSnapshot>(CODEX_UPDATE_PATH);
  }
  deps.write(snapshot, "result");

  const state = snapshot.operation?.state;
  if (state === "canceled") throw new CliError("", EXIT_CANCELLED);
  if (state === "failed" || state === "rolled-back") {
    throw new CliError("", EXIT_FAILURE);
  }
  if (state !== "complete") {
    throw new CliError("Gateway did not return a completed Codex runtime update.", EXIT_FAILURE);
  }
}

const statusCommand = defineCommand({
  meta: { name: "status", description: "Show Codex runtime, login, and model status" },
  async run() {
    printStatus(await withSpinner("Loading Codex status", () => getCodexStatus()));
  },
});

const refreshCommand = defineCommand({
  meta: { name: "refresh", description: "Refresh Codex login and model status" },
  async run() {
    printStatus(await withSpinner("Refreshing Codex status", () => refreshCodexStatus()));
  },
});

const updateCommand = defineCommand({
  meta: { name: "update", description: "Update the gateway's managed Codex runtime" },
  args: {
    check: { type: "boolean", description: "Check whether a compatible update is available" },
    "dry-run": { type: "boolean", description: "Show the update plan without changing anything" },
    yes: { type: "boolean", description: "Skip the confirmation prompt" },
  },
  async run(ctx) {
    await runCodexUpdate(
      {
        check: ctx.args.check === true,
        dryRun: ctx.args["dry-run"] === true,
        yes: ctx.args.yes === true,
      },
      {
        request: gatewayJson,
        confirm: confirmRuntimeUpdate,
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        write: printRuntimeUpdate,
      },
    );
  },
});

const loginCommand = defineCommand({
  meta: { name: "login", description: "Start Codex ChatGPT device login" },
  args: {
    wait: {
      type: "boolean",
      description: "Wait for device login and verify the live model catalog",
    },
  },
  async run(ctx) {
    const shouldWait = ctx.args.wait === true;
    if (shouldWait && isJSON) {
      throw new CliError("Codex login --wait requires an interactive terminal.", EXIT_USER_ERROR);
    }
    const flow = await withSpinner("Starting Codex device login", () =>
      gatewayJson<CodexLoginFlow>(CODEX_LOGIN_PATH, { method: "POST" }),
    );
    printLoginFlow(flow, shouldWait);
    if (!shouldWait) return;
    if (flow.status === "pending") console.log("Waiting for the browser login to complete…");
    const status = await waitForCodexLogin(flow, {
      request: gatewayJson,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
    });
    printStatus(status);
  },
});

const setupAgentCommand = defineCommand({
  meta: {
    name: "setup-agent",
    description:
      "Enable remote inference and assign an available Codex model if Agent is unassigned",
  },
  args: {
    model: {
      type: "positional",
      description: "Model id from `omnesis codex status`",
      required: true,
    },
  },
  async run(ctx) {
    const model = ctx.args.model;
    if (!model) {
      throw new CliError("Usage: omnesis codex setup-agent <model>", EXIT_USER_ERROR);
    }
    const result = await runCodexAgentSetup(model, gatewayJson);
    if (isJSON) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`${c.green}✔${c.reset} Assigned agent = ${result.assignment}`);
  },
});

export function runCodexAgentSetup(
  model: string,
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<{ assignment: string }> {
  return request<{ assignment: string }>("/admin/inference/codex/agent", {
    method: "POST",
    body: JSON.stringify({ model }),
  });
}

const logoutCommand = defineCommand({
  meta: { name: "logout", description: "Log out Codex and clear Codex assignments" },
  async run() {
    const res = await gatewayFetch("/admin/inference/codex", { method: "DELETE" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new CliError(
        `${c.red}Failed to log out Codex: ${res.status} ${txt}${c.reset}`,
        pickGatewayExitCode(res.status),
      );
    }
    const json = (await res.json()) as {
      status: CodexBackendStatus;
      clearedAssignments?: string[];
    };
    if (isJSON) {
      console.log(JSON.stringify(json, null, 2));
      return;
    }
    console.log(`${c.green}✔${c.reset} Codex login removed.`);
    if (json.clearedAssignments?.length) {
      console.log(`Cleared assignments: ${json.clearedAssignments.join(", ")}`);
    }
  },
});

export const codexCommand = defineCommand({
  meta: { name: "codex", description: "Manage the Codex agent backend (ChatGPT subscription)" },
  subCommands: {
    status: statusCommand,
    refresh: refreshCommand,
    update: updateCommand,
    login: loginCommand,
    "setup-agent": setupAgentCommand,
    logout: logoutCommand,
  },
});
